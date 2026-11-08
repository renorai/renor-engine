import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { createMvpApp, type MvpApp } from '../../src/mvp/server';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Auth hardening regressions (Kimi auth review AUTH-B1/B2/B3 + H1/H2/H4).
 *
 * All synthetic, loopback only: mkdtemp dirs, synthetic owner credentials,
 * an exact synthetic loopback callback URI allowlist. No real data, no
 * network beyond loopback, no vault/Downloads/staging access.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const LOOPBACK_CB = 'http://127.0.0.1:1/callback';
const ATTACKER_CB = 'http://attacker.invalid/cb';
const tmpDirs: string[] = [];
const apps: MvpApp[] = [];

afterEach(() => {
  while (apps.length) apps.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeConfig(overrides: Record<string, string> = {}, memoryDir?: string): MvpConfig {
  const dir = memoryDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-auth-'));
  tmpDirs.push(dir);
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  tmpDirs.push(authRoot);
  const env: Record<string, string> = {
    MVP_MEMORY_DIR: dir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: OWNER_EMAIL,
    MVP_OWNER_PASSWORD: OWNER_PASSWORD,
    ...overrides,
  };
  const saved: Record<string, string | undefined> = {};
  for (const key of ['MVP_MEMORY_DIR', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
    'MVP_ALLOWED_CALLBACK_URIS', 'MVP_LOGIN_MAX_FAILURES', 'MVP_LOGIN_LOCKOUT_MS',
    'MVP_HISTORY_DIR', 'MVP_PORT', 'MVP_AUTH_STATE_PATH']) {
    saved[key] = process.env[key];
  }
  process.env.MVP_BASE_URL = env.MVP_BASE_URL;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const config = loadMvpConfig();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return config;
}

function boot(overrides: Record<string, string> = {}): { app: Express; mvp: MvpApp; config: MvpConfig } {
  const config = makeConfig(overrides);
  const mvp = createMvpApp(config);
  apps.push(mvp);
  return { app: mvp.app, mvp, config };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(app: Express, redirectUri = LOOPBACK_CB, name = 'synthetic-client') {
  const res = await request(app).post('/register')
    .send({ client_name: name, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] });
  return res;
}

async function getTicket(app: Express, clientId: string, redirectUri: string, challenge: string) {
  const res = await request(app).get('/authorize').query({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  });
  if (res.status !== 200) return { status: res.status, text: res.text, ticket: null as string | null, html: '' };
  const ticket = res.text.match(/name="ticket" value="([^"]+)"/)?.[1] ?? null;
  return { status: res.status, text: res.text, ticket, html: res.text };
}

async function fullLogin(app: Express, clientId: string, redirectUri = LOOPBACK_CB,
                         email = OWNER_EMAIL, password = OWNER_PASSWORD) {
  const { verifier, challenge } = pkce();
  const { ticket } = await getTicket(app, clientId, redirectUri, challenge);
  if (!ticket) return { loginStatus: 400 as number, code: null, verifier };
  const login = await request(app).post('/mvp-login').type('form').send({
    ticket, approve: 'on', email, password,
  });
  if (login.status !== 302) return { loginStatus: login.status, code: null, verifier };
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code');
  return { loginStatus: login.status, code, verifier };
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('AUTH-B1: DCR deny-by-default, tickets, consent, cross-origin', () => {
  it('deny-by-default: with no allowlist configured, every DCR registration is rejected', async () => {
    const { app } = boot(); // MVP_ALLOWED_CALLBACK_URIS unset
    const res = await registerClient(app, LOOPBACK_CB);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(201);
    expect(res.body.client_id).toBeUndefined();
    // the attacker-origin registration from the Kimi repro is equally denied
    const attacker = await registerClient(app, ATTACKER_CB);
    expect(attacker.status).not.toBe(201);
  });

  it('allowlist gates exact callback URIs: attacker origins never register, exact loopback does', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const attacker = await registerClient(app, ATTACKER_CB);
    expect(attacker.status).not.toBe(201);
    const wrongLoopbackPort = await registerClient(app, 'http://127.0.0.1:2/callback');
    expect(wrongLoopbackPort.status).not.toBe(201);
    const legit = await registerClient(app, LOOPBACK_CB);
    expect(legit.status).toBe(201);
    // one non-allowlisted URI among several poisons the whole registration
    const mixed = await registerClient(app, ATTACKER_CB);
    expect(mixed.status).not.toBe(201);
  });

  it('end-to-end theft chain broken: unregistered client can never reach login or /mcp', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app, ATTACKER_CB);
    expect(reg.status).not.toBe(201);
    const { verifier, challenge } = pkce();
    const authz = await request(app).get('/authorize').query({
      client_id: 'no-such-client', redirect_uri: ATTACKER_CB, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    });
    expect(authz.status).toBeGreaterThanOrEqual(400); // never renders the login form
    // no ticket exists; a forged POST body cannot mint a code
    const login = await request(app).post('/mvp-login').type('form').send({
      redirect_uri: ATTACKER_CB, client_id: 'no-such-client', code_challenge: challenge,
      email: OWNER_EMAIL, password: OWNER_PASSWORD,
    });
    expect(login.status).not.toBe(302);
    expect(login.headers.location ?? '').not.toContain(ATTACKER_CB);
    expect(verifier).toBeTruthy();
  });

  it('login POST without a ticket is rejected — no pre-baked forms, no login CSRF', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const login = await request(app).post('/mvp-login').type('form').send({
      redirect_uri: LOOPBACK_CB, client_id: reg.body.client_id,
      email: OWNER_EMAIL, password: OWNER_PASSWORD, approve: 'on',
    });
    expect(login.status).toBe(400);
  });

  it('tickets are single-use: replaying a consumed ticket mints no second code', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const clientId = reg.body.client_id;
    const { challenge } = pkce();
    const { ticket } = await getTicket(app, clientId, LOOPBACK_CB, challenge);
    expect(ticket).toBeTruthy();
    const first = await request(app).post('/mvp-login').type('form').send({
      ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
    });
    expect(first.status).toBe(302);
    const replay = await request(app).post('/mvp-login').type('form').send({
      ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
    });
    expect(replay.status).toBe(403);
    expect(replay.headers.location).toBeUndefined();
  });

  it('form-body parameter substitution is inert: the code goes to the ticket-bound redirect only', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const { challenge } = pkce();
    const { ticket } = await getTicket(app, reg.body.client_id, LOOPBACK_CB, challenge);
    // attacker-controlled fields added to the POST body are ignored entirely
    const login = await request(app).post('/mvp-login').type('form').send({
      ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
      redirect_uri: ATTACKER_CB, client_id: 'someone-else', code_challenge: 'forged',
    });
    expect(login.status).toBe(302);
    const location = login.headers.location as string;
    expect(location.startsWith(LOOPBACK_CB)).toBe(true);
    expect(location).not.toContain(ATTACKER_CB);
    const code = new URL(location).searchParams.get('code')!;
    // the forged challenge was NOT stored: PKCE must bind the original ticket challenge
    const regFull = await request(app).post('/register').send({}); // noop guard
    expect(regFull.status).toBeGreaterThanOrEqual(400);
    const exchange = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: LOOPBACK_CB,
      client_id: reg.body.client_id, client_secret: reg.body.client_secret,
      code_verifier: 'forged-verifier-forged-verifier-forged-verifier',
    });
    expect(exchange.status).toBeGreaterThanOrEqual(400); // wrong verifier rejected
  });

  it('consent page truthfully shows redirect destination origin and unreviewed-client warning', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app, LOOPBACK_CB, 'trustworthy-looking client name');
    const { challenge } = pkce();
    const { html } = await getTicket(app, reg.body.client_id, LOOPBACK_CB, challenge);
    const visible = html.replace(/action="[^"]*"/g, 'action=""');
    expect(visible).toContain('127.0.0.1:1');                       // exact redirect origin, visible text
    expect(visible).toContain('http://127.0.0.1:1/callback');       // full callback URI
    expect(visible).toContain('trustworthy-looking client name');   // escaped client name
    expect(/unreviewed/i.test(visible)).toBe(true);                  // explicit warning
    expect(/name="approve"/.test(html)).toBe(true);                  // explicit approval required
  });

  it('cross-origin login POSTs are rejected (Origin/Referer checks)', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const { challenge } = pkce();
    const { ticket } = await getTicket(app, reg.body.client_id, LOOPBACK_CB, challenge);
    const bad = await request(app).post('/mvp-login')
      .set('Origin', 'https://attacker.example')
      .type('form').send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(bad.status).toBe(403);
    const badReferer = await request(app).post('/mvp-login')
      .set('Referer', 'https://attacker.example/phish')
      .type('form').send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(badReferer.status).toBe(403);
    const good = await request(app).post('/mvp-login')
      .set('Origin', 'http://127.0.0.1:3471')
      .type('form').send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(good.status).toBe(302);
  });

  it('BROWSER-LOGIN: opaque Origin "null" and no-referrer contexts stay rejected (real-Chromium null-origin semantics)', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const { challenge } = pkce();
    const { ticket } = await getTicket(app, reg.body.client_id, LOOPBACK_CB, challenge);
    // A real Chromium under Referrer-Policy: no-referrer serializes the
    // same-origin form-POST Origin as the literal "null". That must stay
    // rejected: opaque origins are never this service's own origin.
    const nullOrigin = await request(app).post('/mvp-login')
      .set('Origin', 'null')
      .type('form').send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(nullOrigin.status).toBe(403);
    // no headers at all is still acceptable (non-browser clients)
    const noHeaders = await request(app).post('/mvp-login')
      .type('form').send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(noHeaders.status).toBe(302);
  });

  it('BROWSER-LOGIN: consent and every login outcome carry Referrer-Policy: same-origin (never no-referrer)', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const { challenge } = pkce();
    const consent = await request(app).get('/authorize').query({
      client_id: reg.body.client_id, redirect_uri: LOOPBACK_CB, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    });
    expect(consent.status).toBe(200);
    expect(consent.headers['referrer-policy']).toBe('same-origin');
    expect(consent.headers['referrer-policy']).not.toBe('no-referrer');
    // BROWSER-LOGIN FIX #2: Chromium enforces form-action across the redirect
    // chain, so the consent CSP must allow the exact allowlisted callbacks or
    // the OAuth 302 to the client callback is blocked in real browsers.
    expect(consent.headers['content-security-policy']).toContain("form-action 'self'");
    expect(consent.headers['content-security-policy']).toContain(LOOPBACK_CB);
    // rejected cross-origin POST response must carry the same strict headers
    // (previously the 403 path skipped them entirely)
    const bad = await request(app).post('/mvp-login')
      .set('Origin', 'https://attacker.example')
      .type('form').send({ ticket: 'x', approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(bad.status).toBe(403);
    expect(bad.headers['referrer-policy']).toBe('same-origin');
    expect(bad.headers['content-security-policy']).toContain("form-action 'self'");
  });

  it('login without the explicit approval checkbox mints no code', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const { challenge } = pkce();
    const { ticket } = await getTicket(app, reg.body.client_id, LOOPBACK_CB, challenge);
    const login = await request(app).post('/mvp-login').type('form').send({
      ticket, email: OWNER_EMAIL, password: OWNER_PASSWORD, // approve omitted
    });
    expect(login.status).toBe(403);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('AUTH-B2: export never masks read errors as empty exports', () => {
  async function exportViaMcp(app: Express, accessToken: string) {
    const res = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'export_memory', arguments: {} } });
    return res.body?.result?.content ?? [];
  }

  it('EISDIR is a structured tool error, never a bytes:0 success', async () => {
    const { app, config } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const { code, verifier } = await fullLogin(app, reg.body.client_id);
    const tok = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: LOOPBACK_CB,
      client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
    }).expect(200);
    // save a fact so the ledger exists with content
    await request(app).post('/mcp')
      .set('Authorization', `Bearer ${tok.body.access_token}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_memory', arguments: { subject: 'S', predicate: 'p', object: 'v' } } });
    const good = await exportViaMcp(app, tok.body.access_token);
    expect(JSON.stringify(good)).toContain('v');
    // sabotage: the ledger becomes a directory (EISDIR) — the same state the
    // startup replay fails closed on. Export must fail loudly.
    fs.rmSync(path.join(config.memoryDir, 'System', 'Memory Events Ledger.md'));
    fs.mkdirSync(path.join(config.memoryDir, 'System', 'Memory Events Ledger.md'), { recursive: true });
    const content = await exportViaMcp(app, tok.body.access_token);
    const text = String((content as any)[0]?.text ?? '');
    expect(text.startsWith('Error:')).toBe(true);
    expect(text).toContain('EISDIR');
    expect(text).not.toContain('"bytes"');   // never a false empty export
    // cleanup the sabotage dir so afterEach rmSync succeeds
    fs.rmdirSync(path.join(config.memoryDir, 'System', 'Memory Events Ledger.md'));
  });

  it('ENOENT on a pristine store remains an honest empty export', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const { code, verifier } = await fullLogin(app, reg.body.client_id);
    const tok = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: LOOPBACK_CB,
      client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
    }).expect(200);
    const content = await exportViaMcp(app, tok.body.access_token);
    const meta = JSON.parse((content as any)[0].text);
    expect(meta.bytes).toBe(0); // genuinely nothing saved yet — honest, not masked
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('AUTH-B3: bounded failed-login limiter with recovery, metadata-only audit', () => {
  it('lockout after bounded failures; correct credentials also refused while locked; recovery works', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    // The limiter reads Date.now(). On a real clock the 150ms window could end between the third
    // failure and the "locked" check on a loaded host (`expected 302 to be 429`), and the 250ms sleep
    // below only hoped the window had passed. Freeze the clock (Date only; sockets and timers stay
    // real) and move it explicitly, so the window is exactly as long as this test says.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app } = boot({
      MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB,
      MVP_LOGIN_MAX_FAILURES: '3',
      MVP_LOGIN_LOCKOUT_MS: '150',
    });
    const reg = await registerClient(app);
    const clientId = reg.body.client_id;
    // three failed attempts (each with a fresh, legitimate ticket)
    for (let i = 0; i < 3; i++) {
      const { challenge } = pkce();
      const { ticket } = await getTicket(app, clientId, LOOPBACK_CB, challenge);
      const r = await request(app).post('/mvp-login').type('form').send({
        ticket, approve: 'on', email: OWNER_EMAIL, password: `wrong-${i}`,
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    // locked: even the CORRECT password is refused while the window holds
    const locked = await fullLogin(app, clientId);
    expect(locked.loginStatus).toBe(429);
    // recovery: after the (short, test-configured) window, login succeeds
    vi.setSystemTime(Date.now() + 250);
    const recovered = await fullLogin(app, clientId);
    expect(recovered.loginStatus).toBe(302);
    // audit is metadata-only: no passwords, tokens, or headers in any log line
    const auditLines = logs.filter(l => l.includes('"event"'));
    expect(auditLines.some(l => l.includes('login_failed') || l.includes('login_locked'))).toBe(true);
    for (const line of auditLines) {
      expect(line).not.toContain(OWNER_PASSWORD);
      expect(line).not.toContain('wrong-0');
      expect(line).not.toContain('ticket');
    }
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('AUTH-H1/H2: refresh expiry and bounded DCR store', () => {
  it('expired refresh tokens are refused and deleted (rotation still single-use)', async () => {
    const { app, mvp } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const { code, verifier } = await fullLogin(app, reg.body.client_id);
    const tok = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: LOOPBACK_CB,
      client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
    }).expect(200);
    // force the refresh token's bound lifetime into the past (AUTH-H1)
    const stored = (mvp.provider as any).refreshTokens.get(tok.body.refresh_token);
    expect(stored).toBeTruthy();
    stored.refreshExpiresAt = Date.now() - 1;
    const exchange = await request(app).post('/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: tok.body.refresh_token,
      client_id: reg.body.client_id, client_secret: reg.body.client_secret,
    });
    expect(exchange.status).toBeGreaterThanOrEqual(400);
    expect((mvp.provider as any).refreshTokens.has(tok.body.refresh_token)).toBe(false);
  });

  it('the DCR client store is bounded: registrations are refused at the cap', async () => {
    // NOTE: the SDK's own /register handler also rate-limits (20 per window
    // per IP), so the store bound is exercised directly here — the bound
    // still guards long-term store growth across rate-limit windows.
    const { mvp } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const store = mvp.provider.clientsStore;
    let registered = 0;
    let boundError = '';
    for (let i = 0; i < 102; i++) {
      try {
        store.registerClient!({
          client_name: `bulk-${i}`, redirect_uris: [LOOPBACK_CB],
          grant_types: ['authorization_code'],
        } as any);
        registered++;
      } catch (err) {
        boundError = String(err);
        break;
      }
    }
    expect(registered).toBe(100);                 // exactly the cap succeeded
    expect(boundError).toContain('client store bound'); // refused after the cap
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('existing tools keep working after a valid hardened OAuth flow', () => {
  it('full ticket/consent dance still yields working save/retrieve over MCP', async () => {
    const { app } = boot({ MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB });
    const reg = await registerClient(app);
    const { code, verifier } = await fullLogin(app, reg.body.client_id);
    const tok = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: LOOPBACK_CB,
      client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
    }).expect(200);
    expect(tok.body.access_token).toBeTruthy();
    const save = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${tok.body.access_token}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_memory', arguments: { subject: 'S', predicate: 'p', object: 'v' } } });
    expect(save.status).toBe(200);
    const retrieve = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${tok.body.access_token}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'retrieve_memory', arguments: { subject: 'S' } } });
    const body = JSON.parse((retrieve.body.result.content as any)[0].text);
    expect(body.facts).toHaveLength(1);
  });
});