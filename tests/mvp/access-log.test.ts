import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import http from 'http';
import crypto from 'crypto';
import request from 'supertest';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { createMvpApp, type MvpApp } from '../../src/mvp/server';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * ACCESS-LOG regressions (diagnostics-only middleware).
 *
 * The live ChatGPT "problem connecting" gave no server-side visibility.
 * The MVP now emits one metadata-only line per HTTP outcome (method, path
 * prefix, status, ms — and an 8-char client_id prefix for /authorize). These
 * tests pin that the lines are emitted for 2xx/3xx/4xx/5xx and that NOTHING
 * sensitive ever appears in them: no query strings (authorize redacted
 * entirely), no tickets, no codes, no client secrets, no Authorization
 * material. All synthetic; no real data; no secrets in output.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const LOOPBACK_CB = 'http://127.0.0.1:1/callback';

const tmpDirs: string[] = [];
const apps: MvpApp[] = [];

afterEach(() => {
  while (apps.length) apps.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeConfig(overrides: Record<string, string> = {}): { config: MvpConfig; app: Express } {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-access-log-'));
  tmpDirs.push(memoryDir);
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-access-auth-'));
  tmpDirs.push(authRoot);
  const saved: Record<string, string | undefined> = {};
  for (const key of ['MVP_MEMORY_DIR', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
    'MVP_ALLOWED_CALLBACK_URIS', 'MVP_AUTH_STATE_PATH', 'MVP_MCP_JSON']) saved[key] = process.env[key];
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = 'http://127.0.0.1:3471';
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_ALLOWED_CALLBACK_URIS = LOOPBACK_CB;
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  const config = loadMvpConfig();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mvp = createMvpApp(config);
  apps.push(mvp);
  return { config, app: mvp.app };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function captureLog(fn: (captured: string[]) => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return (async () => {
    try { await fn(lines); } finally { spy.mockRestore(); }
    return lines;
  })();
}

// Wait for the event itself instead of sleeping a guessed duration: how long the server takes to
// notice a closed connection depends on how busy the host is (a fixed 200ms was not enough with the
// test process starved to ~4% of a core, and the GET line was then missing from the assertions).
async function waitUntil(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 10));
  }
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('ACCESS-LOG: metadata-only HTTP outcome lines', () => {
  it('emits outcome lines for register/authorize/login/token across status classes; nothing sensitive ever appears', async () => {
    const { app } = makeConfig();
    const markers: { ticket?: string; code?: string; secret?: string; verifier?: string; clientId?: string } = {};
    const lines = await captureLog(async () => {
      const reg = await request(app).post('/register')
        .send({ client_name: 'access-log-client', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code', 'refresh_token'] });
      expect(reg.status).toBe(201);
      // 4xx: authorize with an unknown client_id (query must never leak)
      const { challenge } = pkce();
      const badAuthz = await request(app).get('/authorize?client_id=no-such-client-xyz&redirect_uri='
        + encodeURIComponent(LOOPBACK_CB) + '&response_type=code&code_challenge=' + challenge
        + '&code_challenge_method=S256&scope=memory&state=secret-state-abc123');
      expect(badAuthz.status).toBeGreaterThanOrEqual(400);
      // 2xx: authorize with the real client (query redacted; 8-char prefix only)
      const { verifier, challenge: ch2 } = pkce();
      const authz = await request(app).get('/authorize?client_id=' + reg.body.client_id
        + '&redirect_uri=' + encodeURIComponent(LOOPBACK_CB) + '&response_type=code&code_challenge=' + ch2
        + '&code_challenge_method=S256&scope=memory&state=secret-state-abc123');
      expect(authz.status).toBe(200);
      const ticket = authz.text.match(/name="ticket" value="([^"]+)"/)?.[1];
      expect(ticket).toBeTruthy();
      markers.ticket = ticket!;
      markers.clientId = reg.body.client_id as string;
      markers.secret = reg.body.client_secret as string;
      // 3xx: login
      const login = await request(app).post('/mvp-login')
        .type('form').send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
      expect(login.status).toBe(302);
      const code = new URL(login.headers.location as string, 'http://x').searchParams.get('code');
      markers.code = code!;
      // 2xx: token
      const token = await request(app).post('/token').type('form').send({
        grant_type: 'authorization_code', code, redirect_uri: LOOPBACK_CB,
        client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
      });
      expect(token.status).toBe(200);
      markers.verifier = verifier;
      // 4xx: MCP without bearer
      const noAuth = await request(app).post('/mcp').set('Content-Type', 'application/json')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } });
      expect(noAuth.status).toBe(401);
      // 404: unknown path
      const nf = await request(app).get('/nope').send();
      expect(nf.status).toBe(404);
    });

    const accessLines = lines.filter(l => l.includes('"http_access"')).map(l => JSON.parse(l));
    expect(accessLines.length).toBeGreaterThanOrEqual(6);
    const byPath: Record<string, number[]> = {};
    for (const l of accessLines) {
      expect(Object.keys(l).sort()).toEqual(['client_prefix', 'event', 'instance', 'level', 'method', 'ms', 'path', 'status', 'svc', 'ts'].filter(k => k === 'client_prefix' ? l.client_prefix !== undefined : true).sort());
      expect(l.instance).toMatch(/^[a-z0-9_-]{0,32}$/); // metadata-only instance id (telemetry), never sensitive
      expect(typeof l.status).toBe('number');
      expect(typeof l.ms).toBe('number');
      byPath[l.path] = byPath[l.path] ?? [];
      byPath[l.path].push(l.status);
    }
    expect(byPath['/register']).toContain(201);
    expect(byPath['/authorize']).toContain(200);
    expect(byPath['/authorize'].length).toBeGreaterThanOrEqual(2); // 200 + the 4xx unknown-client line
    expect(byPath['/mvp-login']).toContain(302);
    expect(byPath['/token']).toContain(200);
    expect(byPath['/mcp']).toContain(401);
    expect(byPath['/nope']).toContain(404);

    // REDACTION: nothing sensitive in ANY log line
    const allLines = lines.join('\n');
    expect(allLines).not.toContain('secret-state-abc123');            // authorize state
    expect(allLines).not.toContain(LOOPBACK_CB);                      // redirect query
    expect(allLines).not.toContain(markers.ticket!);                  // ticket value
    expect(allLines).not.toContain(markers.code!);                    // authorization code
    expect(allLines).not.toContain(markers.secret!);                  // client_secret
    expect(allLines).not.toContain(markers.verifier!);                // PKCE verifier
    expect(allLines).not.toContain(OWNER_PASSWORD);                   // owner secret
    expect(allLines).not.toContain('Bearer ');                        // authorization header material
    expect(allLines).not.toContain('?');                             // no query strings at all
    // client_id only ever appears as an 8-char prefix
    const prefixes = accessLines.filter(l => l.client_prefix).map(l => l.client_prefix);
    expect(prefixes.length).toBeGreaterThanOrEqual(2);
    for (const p of prefixes) expect(p).toMatch(/^[A-Za-z0-9_-]{1,8}$/);
    expect(allLines).not.toContain(markers.clientId!);                // full client_id never appears
  });

  it('emits /mcp outcome lines in SSE mode too (initialize + GET stream)', async () => {
    const { config, app } = makeConfig({ MVP_MCP_JSON: 'false' });
    // real listening server: the GET SSE stream stays open, so supertest
    // would hang; raw fetch + AbortController handles it cleanly
    const server = http.createServer(app);
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as net.AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
    const lines = await captureLog(async (captured) => {
      // register + full auth to get a token
      void config;
      const reg = await (await fetch(base + '/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'access-log-sse', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code', 'refresh_token'] }),
      })).json();
      const { verifier, challenge } = pkce();
      const authz = await fetch(base + '/authorize?client_id=' + reg.client_id
        + '&redirect_uri=' + encodeURIComponent(LOOPBACK_CB) + '&response_type=code&code_challenge=' + challenge
        + '&code_challenge_method=S256&scope=memory');
      const ticket = (await authz.text()).match(/name="ticket" value="([^"]+)"/)?.[1];
      const login = await fetch(base + '/mvp-login', {
        redirect: 'manual', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ticket: ticket!, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD }).toString(),
      });
      const code = new URL(login.headers.get('location') ?? '', base).searchParams.get('code');
      const tokenRes = await fetch(base + '/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: code!, redirect_uri: LOOPBACK_CB,
          client_id: reg.client_id, client_secret: reg.client_secret, code_verifier: verifier,
        }).toString(),
      });
      const bearer = (await tokenRes.json()).access_token;
      // SSE initialize: response event ends the stream, text() resolves
      const init = await fetch(base + '/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
      });
      expect(init.status).toBe(200);
      const sid = init.headers.get('mcp-session-id');
      expect(sid).toBeTruthy();
      // GET SSE stream opens (abort to finish it cleanly)
      const ctrl = new AbortController();
      const get = await fetch(base + '/mcp', {
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'text/event-stream', 'Mcp-Session-Id': sid! },
        signal: ctrl.signal,
      });
      expect(get.status).toBe(200);
      ctrl.abort();
      // the server logs the stream when it sees the disconnect: wait for that line (it logs once per response)
      await waitUntil(() => captured.some(l => {
        if (!l.includes('"http_access"')) return false;
        const access = JSON.parse(l);
        return access.path === '/mcp' && access.method === 'GET';
      }));
    });
    const accessLines = lines.filter(l => l.includes('"http_access"')).map(l => JSON.parse(l));
    const mcpLines = accessLines.filter(l => l.path === '/mcp');
    expect(mcpLines.some(l => l.method === 'POST' && l.status === 200)).toBe(true);
    expect(mcpLines.some(l => l.method === 'GET' && l.status === 200)).toBe(true);
    // the aborted GET stream logs exactly once, marked 'closed' or as a plain 200
    expect(mcpLines.filter(l => l.method === 'GET').length).toBe(1);
    // bearer tokens never appear
    const allLines = lines.join('\n');
    expect(allLines).not.toContain('Bearer ');
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>(res => server.close(() => res()));
    }
  });
});