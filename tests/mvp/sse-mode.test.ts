import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * SSE-CHATGPT transport regressions.
 *
 * ChatGPT's connector rejected JSON-only MCP responses (its UI even hints an
 * SSE path); Cloudflare quick tunnels additionally block SSE. The fix adds an
 * env-gated transport mode: MVP_MCP_JSON=false makes the Streamable HTTP
 * endpoint answer POSTs with text/event-stream and supports GET /mcp as the
 * standalone SSE stream, via an in-process BOUNDED session registry.
 *
 * These tests pin BOTH modes:
 *  - default (JSON, unchanged): stateless JSON POST responses, GET -> 404;
 *  - SSE mode: full OAuth + MCP roundtrip through the SDK client, raw-fetch
 *    probes proving the response wire format is SSE + session header,
 *    session semantics (400; an id the engine does not know is served
 *    statelessly, while a stream or a DELETE on it is 404), GET stream open,
 *    DELETE termination, and the bounded/TTL session registry (a session
 *    with a response still open is not swept, and goes last at the cap).
 *
 * All synthetic, loopback only, no vault/Downloads access, provider env
 * vars unset, no secrets in output.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const LOOPBACK_CB = 'http://127.0.0.1:1/callback';

const tmpDirs: string[] = [];
const services: { httpServer: import('http').Server }[] = [];
const apps: MvpApp[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
  }
  while (apps.length) apps.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function bootService(overrides: Record<string, string> = {}, provider?: EmbeddingProvider): Promise<{ config: MvpConfig; app: Express; url: (p?: string) => string }> {
  const port = await freePort();
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-sse-mem-'));
  tmpDirs.push(memoryDir);
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-sse-auth-'));
  tmpDirs.push(authRoot);
  const saved: Record<string, string | undefined> = {};
  for (const key of ['MVP_MEMORY_DIR', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
    'MVP_ALLOWED_CALLBACK_URIS', 'MVP_AUTH_STATE_PATH', 'MVP_MCP_JSON', 'MVP_MCP_MAX_SESSIONS', 'MVP_MCP_SESSION_TTL_MS', 'MVP_PORT']) {
    saved[key] = process.env[key];
  }
  process.env.MVP_PORT = String(port);
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_ALLOWED_CALLBACK_URIS = LOOPBACK_CB;
  delete process.env.MVP_HISTORY_DIR;
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  const config = loadMvpConfig();
  const started = await startMvpService(config, provider);
  services.push(started);
  apps.push(started);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const base = `http://127.0.0.1:${port}`;
  return { config, app: started.app, url: (p = '') => `${base}${p}` };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function obtainToken(app: Express): Promise<string> {
  const reg = await request(app).post('/register')
    .send({ client_name: 'synthetic-sse-client', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code', 'refresh_token'] });
  expect(reg.status).toBe(201);
  const { verifier, challenge } = pkce();
  const consent = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: LOOPBACK_CB, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  });
  expect(consent.status).toBe(200);
  const ticket = consent.text.match(/name="ticket" value="([^"]+)"/)?.[1];
  expect(ticket).toBeTruthy();
  const login = await request(app).post('/mvp-login')
    .type('form').send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
  expect(login.status).toBe(302);
  const code = new URL(login.headers.location as string, 'http://x').searchParams.get('code');
  const token = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: LOOPBACK_CB,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  });
  expect(token.status).toBe(200);
  return token.body.access_token as string;
}

/** Raw initialize over the wire; returns SSE text + session id header. */
async function rawInitialize(url: (p?: string) => string, token: string, accept = 'application/json, text/event-stream') {
  const res = await fetch(url(MVP_MCP_PATH), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: accept,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-sse-probe', version: '0' } },
    }),
  });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    sessionId: res.headers.get('mcp-session-id'),
    protocolVersion: res.headers.get('mcp-protocol-version'),
    text,
  };
}

/** SDK client over the given base; default Accept (both types). */
async function sdkClient(config: MvpConfig, token: string, acceptOverride?: string): Promise<Client> {
  const client = new Client({ name: 'sse-test-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    acceptOverride
      ? { requestInit: { headers: { Authorization: `Bearer ${token}`, Accept: acceptOverride } } }
      : { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

/** The eval-hash stub, held inside embed() until released: an index job in flight. */
class GatedHashProvider extends EvalHashEmbeddingProvider {
  private markEntered!: () => void;
  readonly entered = new Promise<void>(resolve => { this.markEntered = resolve; });
  release!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });

  async embed(texts: string[]): Promise<number[][]> {
    this.markEntered();
    await this.gate;
    return super.embed(texts);
  }
}

let nextPingId = 1000;
/** A ping on `sid`: is it answered, and does the engine still hold the session? A held session names itself in its answer; one the engine lost is answered without. */
async function ping(url: (p?: string) => string, token: string, sid: string) {
  const res = await fetch(url(MVP_MCP_PATH), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sid,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextPingId++, method: 'ping' }),
  });
  await res.text();
  return { status: res.status, registered: res.headers.get('mcp-session-id') === sid };
}

/** The standalone stream (GET /mcp) of `sid`; `close()` is the client going away. */
async function openStream(url: (p?: string) => string, token: string, sid: string) {
  const controller = new AbortController();
  const res = await fetch(url(MVP_MCP_PATH), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Mcp-Session-Id': sid },
    signal: controller.signal,
  });
  return { status: res.status, close: () => controller.abort() };
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('SSE-CHATGPT: default JSON mode is unchanged', () => {
  it('POST returns application/json; GET /mcp stays 404 (no behavior change without opt-in)', async () => {
    const { config, app, url } = await bootService(); // no MVP_MCP_JSON set -> default true
    const token = await obtainToken(app);
    const init = await rawInitialize(url, token);
    expect(init.status).toBe(200);
    expect(init.contentType).toContain('application/json');
    expect(init.sessionId).toBeNull();
    const get = await fetch(url(MVP_MCP_PATH), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    });
    expect(get.status).toBe(404);
    void config;
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('SSE-CHATGPT: SSE mode (MVP_MCP_JSON=false)', () => {
  it('full SDK-client roundtrip over SSE: initialize, tools/list, save, retrieve, export; wire format is SSE with session header', async () => {
    const { config, app, url } = await bootService({ MVP_MCP_JSON: 'false' });
    const token = await obtainToken(app);

    // wire-format proof: ChatGPT's exact Accept header gets an SSE response
    const init = await rawInitialize(url, token);
    expect(init.status).toBe(200);
    expect(init.contentType).toContain('text/event-stream');
    expect(init.sessionId).toBeTruthy();
    expect(init.text).toContain('result');

    // SSE-only Accept is 406: per the Streamable HTTP spec (and the SDK's
    // enforcement, matching the live observation), POST must accept BOTH
    // application/json and text/event-stream — ChatGPT sends both.
    const init2 = await rawInitialize(url, token, 'text/event-stream');
    expect(init2.status).toBe(406);

    // SDK client roundtrip (its default Accept includes both types)
    const client = await sdkClient(config, token);
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toEqual(expect.arrayContaining(['save_memory', 'retrieve_memory', 'export_memory', 'search_history']));
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    const saved = await call('save_memory', { subject: 'SseSubject', predicate: 'transport', object: 'sse', source: 'chatgpt' });
    expect(saved.ok).toBe(true);
    const got = await call('retrieve_memory', { subject: 'SseSubject' });
    expect(got.facts.length).toBe(1);
    const exportRes = await client.callTool({ name: 'export_memory', arguments: {} });
    const ledger = (exportRes.content as { text: string }[])[1].text;
    expect(ledger).toContain('SseSubject');
    await client.close();

    // SSE session semantics: a session id this process does not know is served, a missing one is 400.
    // An unknown id used to be a 404. The engine keeps nothing per session, and a restart, a sleep, the TTL
    // sweep or the cap each dropped a client's conversation that way; the call is now answered on a transport of
    // its own, and nothing is registered for the id (serveForgottenSession).
    const badSid = await fetch(url(MVP_MCP_PATH), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'no-such-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(badSid.status).toBe(202);
    const lost = await fetch(url(MVP_MCP_PATH), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'no-such-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(lost.status).toBe(200);
    expect(lost.headers.get('mcp-session-id')).toBeNull();
    expect(await lost.text()).toContain('save_memory');
    // ...but the standalone stream is the one thing that needs a session: GET stays a 404, which is how a client learns to open a new one
    const lostStream = await fetch(url(MVP_MCP_PATH), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Mcp-Session-Id': 'no-such-session' },
    });
    expect(lostStream.status).toBe(404);
    // a session id is not a credential: the bearer is still required
    const lostNoAuth = await fetch(url(MVP_MCP_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'no-such-session' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }),
    });
    expect(lostNoAuth.status).toBe(401);
    const noSid = await fetch(url(MVP_MCP_PATH), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'notifications/initialized' }),
    });
    expect(noSid.status).toBe(400);
    // unauthorized stays unauthorized in SSE mode
    const noAuth = await fetch(url(MVP_MCP_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    });
    expect(noAuth.status).toBe(401);
  });

  it('PROXY: X-Forwarded-* headers behind a funnel do not crash SDK rate-limited routes (token/register stay functional)', async () => {
    const { app, url } = await bootService({ MVP_MCP_JSON: 'false' });
    const token = await obtainToken(app);
    // a token exchange attempt carrying forwarding headers (as the tailscale
    // funnel sends) must not 500 via ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
    const res = await fetch(url('/token'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-For': '203.0.113.7',
        'X-Forwarded-Proto': 'https',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x', redirect_uri: LOOPBACK_CB, client_id: 'x', code_verifier: 'y' }).toString(),
    });
    expect(res.status).not.toBe(500); // rejected as invalid grant (400) — never a proxy crash
    expect([400, 401]).toContain(res.status);
    void token;
  });

  it('GET /mcp opens the standalone SSE stream on an existing session; wrong Accept -> 406; no session -> 400; DELETE terminates the session', async () => {
    const { config, app, url } = await bootService({ MVP_MCP_JSON: 'false' });
    void config;
    const token = await obtainToken(app);
    const init = await rawInitialize(url, token);
    expect(init.sessionId).toBeTruthy();
    const sid = init.sessionId!;

    // GET without a session id -> 400
    const getNoSid = await fetch(url(MVP_MCP_PATH), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    });
    expect(getNoSid.status).toBe(400);
    // GET without text/event-stream in Accept -> 406 (SDK enforces)
    const getBadAccept = await fetch(url(MVP_MCP_PATH), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Mcp-Session-Id': sid },
    });
    expect(getBadAccept.status).toBe(406);

    // GET with a valid session opens the standalone SSE stream (200 + SSE)
    const controller = new AbortController();
    const stream = await fetch(url(MVP_MCP_PATH), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Mcp-Session-Id': sid },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    controller.abort(); // client goes away; session must remain usable

    // session still usable after the GET stream dropped: DELETE terminates
    const del = await fetch(url(MVP_MCP_PATH), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sid },
    });
    expect(del.status === 200 || del.status === 405 || del.status === 204).toBe(true);
    // after termination a POST naming the id is 404: the spec says a terminated session answers 404. The refusal is
    // process-local (endedSessions, bounded); after a restart the id is forgotten and the stateless path serves it.
    const afterDelete = await fetch(url(MVP_MCP_PATH), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sid,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(afterDelete.status).toBe(404);
    // a stream or a second DELETE needs the session itself: still a 404
    const streamAfterDelete = await fetch(url(MVP_MCP_PATH), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Mcp-Session-Id': sid },
    });
    expect(streamAfterDelete.status).toBe(404);
    const deleteAgain = await fetch(url(MVP_MCP_PATH), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sid },
    });
    expect(deleteAgain.status).toBe(404);
  });

  it('bounded session registry: max sessions evict the oldest idle session; TTL evicts expired sessions; an evicted session is still answered', async () => {
    const { app, url } = await bootService({ MVP_MCP_JSON: 'false', MVP_MCP_MAX_SESSIONS: '2', MVP_MCP_SESSION_TTL_MS: '1500' });
    const token = await obtainToken(app);
    // The registry reads Date.now(). On a real clock the 1500ms TTL could pass between the sessions
    // being opened and the "recent session survived" probe on a loaded host, and the 1700ms sleep
    // below only hoped the TTL had passed. Freeze the clock (Date only; sockets and timers stay real)
    // and move it explicitly: a step between sessions keeps "oldest" unambiguous.
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = await rawInitialize(url, token);
    vi.setSystemTime(Date.now() + 10);
    const b = await rawInitialize(url, token);
    vi.setSystemTime(Date.now() + 10);
    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);

    // a third session exceeds the bound: the oldest (a) is evicted from the registry. A call on it used to be a 404,
    // which ended the client's conversation; it is answered now, and the session does not come back.
    const c = await rawInitialize(url, token);
    expect(c.sessionId).toBeTruthy();
    expect(await ping(url, token, a.sessionId!)).toEqual({ status: 200, registered: false });
    expect(await ping(url, token, b.sessionId!)).toEqual({ status: 200, registered: true }); // recent session survived

    // idle TTL: after expiry every session is gone from the registry, and every one is still answered
    vi.setSystemTime(Date.now() + 1700);
    expect(await ping(url, token, c.sessionId!)).toEqual({ status: 200, registered: false });
    expect(await ping(url, token, b.sessionId!)).toEqual({ status: 200, registered: false });
    expect(await ping(url, token, a.sessionId!)).toEqual({ status: 200, registered: false });
  }, 30_000);

  it('a session whose stream is open is not swept at the TTL; once the stream is gone it is swept like any other', async () => {
    const { app, url } = await bootService({ MVP_MCP_JSON: 'false', MVP_MCP_SESSION_TTL_MS: '1500' });
    const token = await obtainToken(app);
    vi.useFakeTimers({ toFake: ['Date'] });
    const live = await rawInitialize(url, token);
    const quiet = await rawInitialize(url, token);
    const stream = await openStream(url, token, live.sessionId!);
    expect(stream.status).toBe(200);

    // both are past the TTL; the sweep runs on the next MCP request
    vi.setSystemTime(Date.now() + 2000);
    expect(await ping(url, token, quiet.sessionId!)).toEqual({ status: 200, registered: false });
    expect(await ping(url, token, live.sessionId!)).toEqual({ status: 200, registered: true });

    // the stream is what keeps it: with the client gone the session is idle like any other (the engine hears the
    // close a moment after the client sends it, so move the clock again until it has)
    stream.close();
    let swept = false;
    for (let attempt = 0; attempt < 100 && !swept; attempt++) {
      vi.setSystemTime(Date.now() + 2000);
      swept = !(await ping(url, token, live.sessionId!)).registered;
      if (!swept) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(swept).toBe(true);
  }, 30_000);

  it('a session is not swept while a call on it is still being answered', async () => {
    const provider = new GatedHashProvider();
    const { app, url } = await bootService({ MVP_MCP_JSON: 'false', MVP_MCP_SESSION_TTL_MS: '1500' }, provider);
    const token = await obtainToken(app);
    vi.useFakeTimers({ toFake: ['Date'] });
    const slow = await rawInitialize(url, token);
    const call = fetch(url(MVP_MCP_PATH), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': slow.sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 20, method: 'tools/call',
        params: { name: 'remember', arguments: { statement: 'The sweep test keeps a pangolin ledger note.' } },
      }),
    });
    await provider.entered; // the note is written; its index job is waiting on embeddings, so the call is still open

    vi.setSystemTime(Date.now() + 2000);
    await rawInitialize(url, token); // any MCP request runs the sweep
    expect(await ping(url, token, slow.sessionId!)).toEqual({ status: 200, registered: true });

    provider.release();
    const answered = await call;
    expect(answered.status).toBe(200);
    expect(await answered.text()).toContain('pangolin');
  }, 30_000);

  it('at the cap a session without a stream goes before one with a stream, even an older one', async () => {
    const { app, url } = await bootService({ MVP_MCP_JSON: 'false', MVP_MCP_MAX_SESSIONS: '2' });
    const token = await obtainToken(app);
    vi.useFakeTimers({ toFake: ['Date'] });
    const live = await rawInitialize(url, token); // the oldest
    const stream = await openStream(url, token, live.sessionId!);
    expect(stream.status).toBe(200);
    vi.setSystemTime(Date.now() + 10);
    const idle = await rawInitialize(url, token);
    vi.setSystemTime(Date.now() + 10);

    const newcomer = await rawInitialize(url, token); // over the cap
    expect(await ping(url, token, idle.sessionId!)).toEqual({ status: 200, registered: false });
    expect(await ping(url, token, live.sessionId!)).toEqual({ status: 200, registered: true });
    expect(await ping(url, token, newcomer.sessionId!)).toEqual({ status: 200, registered: true });
    stream.close();
  }, 30_000);

  it('when every session has a stream the oldest goes: the cap still holds', async () => {
    const { app, url } = await bootService({ MVP_MCP_JSON: 'false', MVP_MCP_MAX_SESSIONS: '2' });
    const token = await obtainToken(app);
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await rawInitialize(url, token);
    const firstStream = await openStream(url, token, first.sessionId!);
    vi.setSystemTime(Date.now() + 10);
    const second = await rawInitialize(url, token);
    const secondStream = await openStream(url, token, second.sessionId!);
    vi.setSystemTime(Date.now() + 10);
    expect(firstStream.status).toBe(200);
    expect(secondStream.status).toBe(200);

    const newcomer = await rawInitialize(url, token);
    expect(await ping(url, token, first.sessionId!)).toEqual({ status: 200, registered: false });
    expect(await ping(url, token, second.sessionId!)).toEqual({ status: 200, registered: true });
    expect(await ping(url, token, newcomer.sessionId!)).toEqual({ status: 200, registered: true });
    firstStream.close();
    secondStream.close();
  }, 30_000);

  it('an initialize that still carries the id of a lost session starts a new session', async () => {
    const { app, url } = await bootService({ MVP_MCP_JSON: 'false' });
    const token = await obtainToken(app);
    const res = await fetch(url(MVP_MCP_PATH), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'a-session-this-engine-lost',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-sse-probe', version: '0' } },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const fresh = res.headers.get('mcp-session-id');
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe('a-session-this-engine-lost');
    expect(await ping(url, token, fresh!)).toEqual({ status: 200, registered: true });
  });
});
