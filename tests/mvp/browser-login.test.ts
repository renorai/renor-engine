import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import request from 'supertest';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { createMvpApp, type MvpApp } from '../../src/mvp/server';
import type { Express } from 'express';

/**
 * BROWSER-LOGIN regression: a REAL headless Chromium must complete the whole
 * owner consent flow — navigate to the consent page, submit the login form
 * (a same-origin POST navigation), follow the OAuth 302 to the exact
 * allowlisted callback, and end up with a code that completes PKCE exchange.
 *
 * Durable regressions for two live-flow bugs, both reproduced empirically
 * with a real headless Chromium and both documented browser-semantics issues:
 *
 * 1. With `Referrer-Policy: no-referrer` on the consent page, a real browser
 *    serializes the same-origin form-POST `Origin` header as the literal
 *    "null" (also hit by better-auth #10959, Keycloak/Quarkus #31631, Okta
 *    OIDC callbacks). The cross-origin guard correctly rejected it — every
 *    legitimate browser login failed with "Cross-origin login requests are
 *    not accepted." Fixed by `Referrer-Policy: same-origin`.
 * 2. Chromium enforces CSP `form-action` across the redirect chain of a form
 *    submission (w3c/webappsec-csp#8; Nextcloud #29317, dotnet/aspnetcore
 *    #55491). A static `form-action 'self'` blocked the OAuth 302 from
 *    /mvp-login to the client's callback. Fixed by allowing exactly the
 *    allowlisted callback URIs in the consent page CSP.
 *
 * Fully synthetic and loopback-only: mkdtemp dirs, a fresh throwaway browser
 * profile (NEVER the owner's browser/profile), synthetic owner credentials,
 * an exact synthetic loopback callback allowlist. No real data, no network
 * beyond loopback, no vault/Downloads access. Skips when no Chromium/Chrome
 * binary is present.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';

const BROWSER_CANDIDATES = [
  process.env.MVP_TEST_BROWSER,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/brave-browser',
].filter(Boolean) as string[];
const BROWSER = BROWSER_CANDIDATES.find(p => fs.existsSync(p)) ?? null;

// MVP_REQUIRE_BROWSER=1 means "a browser is required" — CI sets it from
// scripts/ci/prepare-browser.sh. Without this guard the security-critical
// browser-login regression below would silently SKIP on any runner that lacks
// Chromium, and ci-ok would go green having proven nothing. Fail closed instead.
if (process.env.MVP_REQUIRE_BROWSER === '1' && !BROWSER) {
  throw new Error(
    'MVP_REQUIRE_BROWSER=1 but no Chromium/Chrome binary was found. Checked: ' +
      BROWSER_CANDIDATES.join(', ') +
      '. Install a browser, fix MVP_TEST_BROWSER, or unset MVP_REQUIRE_BROWSER to allow the skip.',
  );
}

const tmpDirs: string[] = [];
const apps: MvpApp[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  while (children.length) {
    const c = children.pop()!;
    try { c.kill('SIGKILL'); } catch { /* already dead */ }
  }
  while (apps.length) apps.pop()!.close();
  // Chromium can still be flushing profile files after SIGKILL; retry so
  // ENOTEMPTY on Default/ does not fail an otherwise-green OAuth test.
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best-effort cleanup of throwaway browser profiles */
    }
  }
});

function makeConfig(port: number, allowlist: string, authStatePath?: string, memoryDir?: string): MvpConfig {
  const dir = memoryDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-browser-login-'));
  if (!memoryDir) tmpDirs.push(dir);
  const saved: Record<string, string | undefined> = {};
  for (const key of ['MVP_MEMORY_DIR', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
    'MVP_ALLOWED_CALLBACK_URIS', 'MVP_AUTH_STATE_PATH']) saved[key] = process.env[key];
  if (!authStatePath) {
    const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
    tmpDirs.push(authRoot);
    authStatePath = path.join(authRoot, 'clients.json');
  }
  process.env.MVP_MEMORY_DIR = dir;
  process.env.MVP_AUTH_STATE_PATH = authStatePath;
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_ALLOWED_CALLBACK_URIS = allowlist;
  const config = loadMvpConfig();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return config;
}

/** Reserve an ephemeral port so MVP_BASE_URL can equal the real origin. */
function reservePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Minimal CDP driver over the built-in WebSocket: navigate + evaluate. */
async function connectCdp(profileDir: string) {
  // chromium writes <port>\n<path> to DevToolsActivePort when the port is 0
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let devPort = '';
  for (let i = 0; i < 100; i++) {
    try { devPort = fs.readFileSync(portFile, 'utf-8').split('\n')[0]; break; } catch { await sleep(150); }
  }
  if (!devPort) throw new Error('headless browser did not open a DevTools port');
  const targets = (await (await fetch(`http://127.0.0.1:${devPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target in headless browser');
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new Error('global WebSocket unavailable');
  const ws = new WS(page.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('CDP websocket failed'));
  });
  let msgId = 0;
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  ws.onmessage = (ev: MessageEvent) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>(resolve => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable', {});
  const evalJs = async (expression: string) =>
    ((await send('Runtime.evaluate', { expression, returnByValue: true })) as {
      result?: { value?: unknown };
    }).result?.value;
  return {
    evalJs,
    navigate: (url: string) => send('Page.navigate', { url }),
    close: () => ws.close(),
  };
}

describe('BROWSER-LOGIN: real headless browser completes the owner login flow', { skip: !BROWSER }, () => {
  it('real Chromium submits the consent form, follows the OAuth 302 to the allowlisted callback, and the code completes PKCE exchange', async () => {
    const port = await reservePort();
    const cbPort = await reservePort();
    const LOOPBACK_CB = `http://127.0.0.1:${cbPort}/callback`;
    const config = makeConfig(port, LOOPBACK_CB);
    const mvp = createMvpApp(config);
    apps.push(mvp);
    const server = http.createServer(mvp.app);
    await new Promise<void>(res => server.listen(port, '127.0.0.1', res));
    const base = `http://127.0.0.1:${port}`;

    // a REAL loopback callback listener: proves the browser actually landed
    // on the exact allowlisted redirect with the authorization code
    let callbackUrl = '';
    const cbServer = http.createServer((req, res) => {
      // record only the actual OAuth callback request, not favicon probes
      if (!callbackUrl && (req.url ?? '').startsWith('/callback?')) {
        callbackUrl = `http://127.0.0.1:${cbPort}${req.url}`;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('synthetic callback reached');
    });
    await new Promise<void>(res => cbServer.listen(cbPort, '127.0.0.1', res));

    // synthetic DCR client + authorize URL
    const reg = await request(mvp.app).post('/register')
      .send({ client_name: 'synthetic-browser', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    expect(reg.status).toBe(201);
    const { challenge, verifier } = pkce();
    const authz = `${base}/authorize?${new URLSearchParams({
      client_id: reg.body.client_id, redirect_uri: LOOPBACK_CB, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    })}`;

    // fresh, isolated, throwaway browser profile (never the owner's)
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-browser-profile-'));
    tmpDirs.push(profileDir);
    const chrome = spawn(BROWSER!, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    children.push(chrome);
    const cdp = await connectCdp(profileDir);

    // navigate to the real consent page and submit the real form
    await cdp.navigate(authz);
    for (let i = 0; i < 50; i++) {
      if (await cdp.evalJs('document.forms.length') === 1) break;
      await sleep(150);
    }
    expect(await cdp.evalJs('document.forms.length')).toBe(1);
    const submitted = await cdp.evalJs(`(() => {
      document.querySelector('[name=email]').value = ${JSON.stringify(OWNER_EMAIL)};
      document.querySelector('[name=password]').value = ${JSON.stringify(OWNER_PASSWORD)};
      document.querySelector('[name=approve]').checked = true;
      document.forms[0].submit();
      return 'submitted';
    })()`);
    expect(submitted).toBe('submitted');

    // success = the browser truly landed on the allowlisted callback with a code;
    // failure modes (blocked POST, blocked redirect) leave it stuck on the consent page
    let pageText = '';
    for (let i = 0; i < 60 && !callbackUrl; i++) {
      pageText = ((await cdp.evalJs('document.body ? document.body.innerText.slice(0,120) : ""')) as string) || '';
      if (/cross-origin|invalid authorization|locked|too many/i.test(pageText)) break;
      await sleep(250);
    }
    expect(callbackUrl.startsWith(`${LOOPBACK_CB}?`)).toBe(true);
    const code = new URL(callbackUrl).searchParams.get('code');
    expect(code).toBeTruthy();

    // the code must complete the PKCE S256 exchange — proves a real minted grant
    const tokenRes = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code!, redirect_uri: LOOPBACK_CB,
        client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeTruthy();

    cdp.close();
    for (const s of [server, cbServer]) {
      s.closeAllConnections();
      await new Promise<void>(res => { s.close(() => res()); });
    }
  }, 90_000);

  it('CLIENT-PERSISTENCE + real browser: after a service restart from the SAME client store, the SAME registered client (no re-registration) completes the browser login and PKCE exchange', async () => {
    const port = await reservePort();
    const cbPort = await reservePort();
    const LOOPBACK_CB = `http://127.0.0.1:${cbPort}/callback`;
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-browser-cp-mem-'));
    tmpDirs.push(memoryDir);
    const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-browser-cp-auth-'));
    tmpDirs.push(authRoot);
    const authStatePath = path.join(authRoot, 'clients.json');

    const bootApp = async () => {
      const config = makeConfig(port, LOOPBACK_CB, authStatePath, memoryDir);
      const mvp = createMvpApp(config);
      apps.push(mvp);
      const server = http.createServer(mvp.app);
      await new Promise<void>(res => server.listen(port, '127.0.0.1', res));
      return { config, mvp, server };
    };
    const stopApp = async (boot: { mvp: MvpApp; server: http.Server }) => {
      boot.server.closeAllConnections();
      await new Promise<void>(res => boot.server.close(() => res()));
      const idx = apps.indexOf(boot.mvp);
      if (idx >= 0) apps.splice(idx, 1);
      try { await boot.mvp.close(); } catch { /* already closed */ }
    };

    // run 1: register ONCE
    const run1 = await bootApp();
    const reg = await request(run1.mvp.app).post('/register')
      .send({ client_name: 'synthetic-browser-persisted', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    expect(reg.status).toBe(201);
    const client = { clientId: reg.body.client_id, clientSecret: reg.body.client_secret };
    // restart: STOP, boot again from the SAME store, DO NOT re-register
    await stopApp(run1);
    const run2 = await bootApp();

    // a REAL loopback callback listener
    let callbackUrl = '';
    const cbServer = http.createServer((req, res) => {
      if (!callbackUrl && (req.url ?? '').startsWith('/callback?')) {
        callbackUrl = `http://127.0.0.1:${cbPort}${req.url}`;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('synthetic callback reached');
    });
    await new Promise<void>(res => cbServer.listen(cbPort, '127.0.0.1', res));

    // authorize with the PERSISTED client id (fresh ticket + PKCE)
    const { challenge, verifier } = pkce();
    const authz = `http://127.0.0.1:${port}/authorize?${new URLSearchParams({
      client_id: client.clientId, redirect_uri: LOOPBACK_CB, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    })}`;

    // fresh, isolated, throwaway browser profile
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-browser-cp-profile-'));
    tmpDirs.push(profileDir);
    const chrome = spawn(BROWSER!, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    children.push(chrome);
    const cdp = await connectCdp(profileDir);

    await cdp.navigate(authz);
    for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
      if (await cdp.evalJs('document.forms.length') === 1) break;
      await sleep(150);
    }
    expect(await cdp.evalJs('document.forms.length')).toBe(1);
    const submitted = await cdp.evalJs(`(() => {
      document.querySelector('[name=email]').value = ${JSON.stringify(OWNER_EMAIL)};
      document.querySelector('[name=password]').value = ${JSON.stringify(OWNER_PASSWORD)};
      document.querySelector('[name=approve]').checked = true;
      document.forms[0].submit();
      return 'submitted';
    })()`);
    expect(submitted).toBe('submitted');

    for (const deadline = Date.now() + 45_000; !callbackUrl && Date.now() < deadline;) {
      const pageText = ((await cdp.evalJs('document.body ? document.body.innerText.slice(0,120) : ""')) as string) || '';
      if (/cross-origin|invalid authorization|locked|too many/i.test(pageText)) break;
      await sleep(250);
    }
    expect(callbackUrl.startsWith(`${LOOPBACK_CB}?`)).toBe(true);
    const code = new URL(callbackUrl).searchParams.get('code');
    expect(code).toBeTruthy();

    // the SAME persisted client_secret completes the PKCE S256 exchange
    const tokenRes = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code!, redirect_uri: LOOPBACK_CB,
        client_id: client.clientId, client_secret: client.clientSecret, code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeTruthy();

    cdp.close();
    cbServer.closeAllConnections();
    await new Promise<void>(res => cbServer.close(() => res()));
    await stopApp(run2);
  }, 150_000);
});