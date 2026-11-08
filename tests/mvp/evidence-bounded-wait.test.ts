import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import http from 'http';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { OLLAMA_KEY_ENV_NAMES } from '../../src/evidence/keyPool';
import { EVIDENCE_BACKGROUND_CONCURRENCY, EVIDENCE_BACKGROUND_QUEUE, sharedEvidenceFlights } from '../../src/evidence/background';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { EvidenceCache } from '../../src/evidence/evidenceCache';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Bounded-wait evidence over the REAL remote MCP surface: the MVP service, its OAuth, an MCP client, and an
 * OpenAI-compatible extractor on loopback that holds every request until the test releases it, so "the search
 * answered before the model did" is a fact of the test rather than of this machine's speed.
 *
 * With RENOR_EVIDENCE_ASYNC unset, search_memory waits for the model and returns its table, get_context carries no new
 * field, and the description is unchanged. With it on, both tools answer within RENOR_EVIDENCE_WAIT_MS with
 * `state: "pending"`, the extraction finishes in the background, and the same request then returns the cached table;
 * identical requests share one extraction across SSE sessions; past the queue bound a search says "busy"; and an
 * on-demand engine (RENOR_ON_DEMAND) stays awake until a background extraction has ended. A reply the parser rejects is
 * remembered across SSE sessions too (EVIDENCE_FAILURE_TTL_MS), so a later search says it without asking the model.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const CLEARED_ENV = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_EMBEDDING_PROVIDER', 'MVP_EMBEDDING_DIMS', 'MVP_MCP_JSON', 'EMBEDDING_PROVIDER',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_EVIDENCE_MODE', 'RENOR_EVIDENCE_MODEL', 'RENOR_EVIDENCE_CACHE', 'RENOR_EVIDENCE_BASE_URL',
  'RENOR_EVIDENCE_SESSIONS', 'RENOR_EVIDENCE_ASYNC', 'RENOR_EVIDENCE_WAIT_MS', 'RENOR_EVIDENCE_API_KEY',
  'RENOR_EVIDENCE_API_KEYS', ...OLLAMA_KEY_ENV_NAMES,
];
const ITEMS = JSON.stringify({ items: [{ item: 'camping trip', action: 'went on', amount: '3 days', date: '2023/05/29' }] });

const savedEnv: Record<string, string | undefined> = {};
const tmpDirs: string[] = [];
const services: Array<MvpApp & { httpServer: import('http').Server }> = [];
const clients: Client[] = [];
const extractors: FakeExtractor[] = [];

beforeEach(() => {
  for (const name of CLEARED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  // Let every background extraction finish before its workspace goes away.
  for (const fake of extractors) fake.release();
  await sharedEvidenceFlights().idle();
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
    await s.close();
  }
  for (const fake of extractors.splice(0)) await fake.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface FakeExtractor {
  url: string;
  /** Chat requests received so far. */
  requests(): number;
  /** Answer every request at once from now on, including the ones held so far. */
  release(): void;
  close(): Promise<void>;
}

/** An OpenAI-compatible extractor that holds each request until release(), then answers `reply` (by default, a table). */
async function fakeExtractor(
  reply: unknown = { choices: [{ message: { content: ITEMS } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
): Promise<FakeExtractor> {
  let held = true;
  let received = 0;
  const parked: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received += 1;
      const answer = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      };
      if (held) parked.push(answer);
      else answer();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const fake: FakeExtractor = {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`,
    requests: () => received,
    release() {
      held = false;
      for (const answer of parked.splice(0)) answer();
    },
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  extractors.push(fake);
  return fake;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function makeConfig(memoryDir: string, port: number): MvpConfig {
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  tmpDirs.push(authRoot);
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  return loadMvpConfig();
}

async function registerAndToken(app: Express): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'bounded-wait-test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorizeRes = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorizeRes.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({
    ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
  }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  return tokens.body.access_token as string;
}

async function connect(config: MvpConfig, token: string): Promise<Client> {
  const client = new Client({ name: 'bounded-wait-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ body: any; ms: number }> {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args } as any, undefined, { timeout: 120_000 });
  return { body: JSON.parse((res.content as { text: string }[])[0].text), ms: Date.now() - started };
}

/** A workspace with three dated session notes, served with `fake` as its evidence model. */
async function workspace(fake: FakeExtractor, env: Record<string, string> = {}, idleExitMs?: number) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-bounded-wait-'));
  tmpDirs.push(memoryDir);
  fs.mkdirSync(path.join(memoryDir, 'Sessions'), { recursive: true });
  for (const [day, text] of [['01', 'We went camping for 3 days near the lake.'], ['02', 'Bought a tent and two sleeping bags.'], ['03', 'Planned a second camping trip for June.']]) {
    fs.writeFileSync(path.join(memoryDir, 'Sessions', `2023-05-${day}.md`), `---\ndate: 2023-05-${day}\n---\n# Session ${day}\n\n${text}\n`);
  }
  process.env.RENOR_EVIDENCE_BASE_URL = fake.url;
  process.env.RENOR_EVIDENCE_API_KEY = 'synthetic-local-key';
  // The engine's unset evidence mode is off (src/evidence/gate.ts): the pass is turned on, as hosted Renor does.
  process.env.RENOR_EVIDENCE_MODE = 'always';
  Object.assign(process.env, env);
  const config = makeConfig(memoryDir, await freePort());
  if (idleExitMs !== undefined) config.idleExitMs = idleExitMs;
  const started = await startMvpService(config, new EvalHashEmbeddingProvider());
  services.push(started);
  const token = await registerAndToken(started.app);
  const client = await connect(config, token);
  await call(client, 'index_memory');
  return { config, token, client, started, memoryDir };
}

/** 'exited' once an on-demand engine has drained and stopped listening, else 'running' after `ms`. */
function settle(started: { idleExit: Promise<void> | null }, ms: number): Promise<'exited' | 'running'> {
  return Promise.race([
    started.idleExit!.then(() => 'exited' as const),
    new Promise<'running'>(resolve => setTimeout(() => resolve('running'), ms)),
  ]);
}

async function described(client: Client, tool: string): Promise<string> {
  return (await client.listTools()).tools.find(t => t.name === tool)?.description ?? '';
}

/** Resolves when `promise` has not settled within `ms` (true) or has (false). */
async function stillWaiting(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const marker = Symbol('waiting');
  return (await Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(marker), ms))])) === marker;
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('bounded-wait evidence, flag off (the default)', () => {
  it('search_memory waits for a slow model and returns its table; get_context and the description are unchanged', async () => {
    const fake = await fakeExtractor();
    const { client } = await workspace(fake);
    expect(await described(client, 'search_memory')).not.toMatch(/"pending"|"busy"/);

    const search = call(client, 'search_memory', { query: 'How many days was the camping trip?' });
    expect(await stillWaiting(search, 400)).toBe(true); // held by the model, as it always was
    fake.release();
    const { body } = await search;
    expect(body.evidence).toMatchObject({ status: 'ok', state: 'ok', fromCache: false });
    expect(body.hits[0].reason).toBe('evidence');

    const context = await call(client, 'get_context', { query: 'What did I buy for camping?' });
    expect(context.body).not.toHaveProperty('evidence');
    expect(context.body.memories[0].reason).toBe('evidence');
    expect(fake.requests()).toBe(2);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('bounded-wait evidence, flag on', () => {
  it('answers within the wait with "pending", and the same request returns the cached table once the model finished', async () => {
    const fake = await fakeExtractor();
    const { client } = await workspace(fake, { RENOR_EVIDENCE_ASYNC: '1', RENOR_EVIDENCE_WAIT_MS: '150' });
    const description = await described(client, 'search_memory');
    expect(description).toContain('"pending"');
    expect(description).toContain('"busy"');

    // The model holds every request: these answers can only come from the bound.
    const search = await call(client, 'search_memory', { query: 'How many days was the camping trip?' });
    expect(search.body.ok).toBe(true);
    expect(search.body.evidence).toMatchObject({ status: 'skipped', reason: 'pending', state: 'pending' });
    expect(search.body.evidence.note).toMatch(/did not finish within the time this deployment waits/);
    expect(search.body.hits.length).toBeGreaterThan(0);
    expect(search.body.hits.some((h: any) => h.reason === 'evidence')).toBe(false);
    expect(search.ms).toBeLessThan(30_000);

    const context = await call(client, 'get_context', { query: 'What did I buy for camping?' });
    expect(context.body.evidence).toEqual({
      state: 'pending',
      note: expect.stringMatching(/same request over the same notes returns it/),
    });
    expect(context.body.memories.some((m: any) => m.reason === 'evidence')).toBe(false);
    expect(fake.requests()).toBe(2);

    fake.release();
    await sharedEvidenceFlights().idle();

    const again = await call(client, 'search_memory', { query: 'How many days was the camping trip?' });
    expect(again.body.evidence).toMatchObject({ status: 'ok', state: 'ok', fromCache: true });
    expect(again.body.hits[0].reason).toBe('evidence');
    expect(again.body.hits[0].text).toContain('camping trip');
    const contextAgain = await call(client, 'get_context', { query: 'What did I buy for camping?' });
    expect(contextAgain.body).not.toHaveProperty('evidence');
    expect(contextAgain.body.memories[0].reason).toBe('evidence');
    expect(fake.requests()).toBe(2); // both repeats were cache hits
  });

  it('gives identical requests from different SSE sessions one extraction', async () => {
    const fake = await fakeExtractor();
    const { config, token, client } = await workspace(fake, { RENOR_EVIDENCE_ASYNC: '1', RENOR_EVIDENCE_WAIT_MS: '150', MVP_MCP_JSON: 'false' });
    const second = await connect(config, token);
    const query = { query: 'How many days was the camping trip?' };
    const [a, b] = await Promise.all([call(client, 'search_memory', query), call(second, 'search_memory', query)]);
    expect(a.body.evidence.state).toBe('pending');
    expect(b.body.evidence.state).toBe('pending');
    expect(fake.requests()).toBe(1);

    fake.release();
    await sharedEvidenceFlights().idle();
    const third = await connect(config, token);
    const cached = await call(third, 'search_memory', query);
    expect(cached.body.evidence).toMatchObject({ state: 'ok', fromCache: true });
    expect(fake.requests()).toBe(1);
  });

  it('keeps an on-demand engine awake until the extraction it answered "pending" for has ended', async () => {
    const fake = await fakeExtractor();
    const { client, started, memoryDir } = await workspace(fake, { RENOR_EVIDENCE_ASYNC: '1', RENOR_EVIDENCE_WAIT_MS: '50', RENOR_ON_DEMAND: '1' }, 500);
    const search = await call(client, 'search_memory', { query: 'How many days was the camping trip?' });
    expect(search.body.evidence.state).toBe('pending');

    // Five idle periods with no request in flight: only the extraction holds the engine awake.
    expect(await settle(started, 2_500)).toBe('running');
    expect(started.idle!.isDraining).toBe(false);

    const releasedAt = Date.now();
    fake.release();
    expect(await settle(started, 20_000)).toBe('exited');
    expect(Date.now() - releasedAt).toBeGreaterThanOrEqual(490);
    // It drained only after the table was in the cache, so the next start answers the same request from there.
    const cache = new EvidenceCache(path.join(memoryDir, '.memory-index', 'evidence-cache.db'));
    try {
      expect(cache.stats().entries).toBe(1);
    } finally {
      cache.close();
    }
  }, 40_000);

  it('says "busy" and starts nothing once the running and waiting extractions reach the bound', async () => {
    const fake = await fakeExtractor();
    const { client } = await workspace(fake, { RENOR_EVIDENCE_ASYNC: '1', RENOR_EVIDENCE_WAIT_MS: '20' });
    const bound = EVIDENCE_BACKGROUND_CONCURRENCY + EVIDENCE_BACKGROUND_QUEUE;
    for (let i = 0; i < bound; i++) {
      const { body } = await call(client, 'search_memory', { query: `What happened on camping day ${i}?` });
      expect(body.evidence.state, `search ${i}`).toBe('pending');
    }
    const past = await call(client, 'search_memory', { query: 'What happened on the last camping day?' });
    expect(past.body.evidence).toMatchObject({ status: 'skipped', reason: 'queue-full', state: 'busy' });
    expect(past.body.evidence.note).toMatch(/none was started/);
    const contextPast = await call(client, 'get_context', { query: 'Anything else about camping gear?' });
    expect(contextPast.body.evidence.state).toBe('busy');
    expect(fake.requests()).toBe(EVIDENCE_BACKGROUND_CONCURRENCY);

    fake.release();
    await sharedEvidenceFlights().idle();
    expect(fake.requests()).toBe(bound);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a failed extraction over the real MCP surface', () => {
  it('is said again to the same request from another SSE session, which does not ask the model', async () => {
    // Empty at the token cap, as GLM-5.3-Flash on Nebius answered 36% of its dev100 extraction calls (2026-10-03).
    const fake = await fakeExtractor({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 8192 } });
    fake.release();
    // SSE sessions each build their own McpServer and extractor: only the evidence cache file is shared.
    const { config, token, client } = await workspace(fake, { MVP_MCP_JSON: 'false' });
    const query = { query: 'How many days was the camping trip?' };
    const first = await call(client, 'search_memory', query);
    expect(first.body.evidence).toMatchObject({ status: 'skipped', state: 'failed', reason: 'extractor-parse-error' });
    expect(first.body.evidence.error).toMatch(/finish_reason=length/);
    expect(first.body.evidence).not.toHaveProperty('fromCache');
    expect(fake.requests()).toBe(3);

    const second = await connect(config, token);
    const again = await call(second, 'search_memory', query);
    expect(again.body.evidence).toEqual({ ...first.body.evidence, fromCache: true });
    // The same notes, with no table before them (a score moves with the clock: its recency part).
    const shown = (body: any) => body.hits.map((hit: any) => [hit.notePath, hit.text]);
    expect(shown(again.body)).toEqual(shown(first.body));
    expect(again.body.hits.some((hit: any) => hit.reason === 'evidence')).toBe(false);
    expect(fake.requests()).toBe(3);
  });
});
