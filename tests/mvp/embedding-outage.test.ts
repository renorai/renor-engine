import { describe, it, expect, afterEach, afterAll, vi, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { chunksWithoutVectors } from '../../src/embeddings/rebuild';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import {
  attachEngine,
  engineIndexChanged,
  engineSearchMemory,
  UNFINISHED_FILES,
  UNFINISHED_RETRY_MS,
} from '../../src/mvp/engine';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * What an agent is told while the embedding provider is down, and after it is back (first-week scout, finding F3).
 * Driven through the real MCP tools over the authenticated Streamable HTTP endpoint, with the deterministic eval-hash
 * stub failing on demand: what a revoked key, a disabled API or an exhausted quota looks like to the engine. Synthetic
 * data only (mkdtemp memory dirs, loopback).
 *
 * The scout found, on a workspace with an embedding provider: get_context failed whole (a tool error, no facts and no
 * keyword results, although neither needs the provider); a note's receipt said "indexed": true beside errors 2 of 2,
 * and a fact's said nothing; memory_status said nothing of the chunks left without a vector; and what was saved
 * during the outage stayed invisible to search by meaning until some later save.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const TEST_TIMEOUT_MS = 60_000;
const OUTAGE = 'embedding provider unavailable (synthetic outage)';

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'MVP_DB_PATH', 'RENOR_SEARCH_EVIDENCE', 'RENOR_CONTEXT_RELEVANCE', 'RENOR_CONTEXT_RELEVANCE_MIN',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

const open: Array<{ close(): Promise<void> }> = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (open.length) await open.pop()!.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.RENOR_CONTEXT_RELEVANCE_MIN;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** The eval-hash stub, failing every request while `down`, and any request with a text it `refuses`; it counts them. */
class FlakyProvider extends EvalHashEmbeddingProvider {
  down = false;
  refuses: (text: string) => boolean = () => false;
  /** Requests to embed saved text (an index pass) and to embed a query (a search). */
  documentRequests = 0;
  queryRequests = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.documentRequests++;
    if (this.down || texts.some(this.refuses)) throw new Error(OUTAGE);
    return super.embed(texts);
  }
  async embedQuery(text: string): Promise<number[]> {
    this.queryRequests++;
    if (this.down) throw new Error(OUTAGE);
    return super.embedQuery(text);
  }
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
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(tmp('mvp-outage-auth-'), 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_DB_PATH']) delete process.env[key];
  process.env.RENOR_SEARCH_EVIDENCE = '0';
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'embedding-outage', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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
  return tokens.body.access_token;
}

/** An authenticated workspace. Calls are sequential: one shared stateless MCP server. */
async function startWorkspace(provider: FlakyProvider | null) {
  const memoryDir = tmp('mvp-outage-');
  const config = makeConfig(memoryDir, await freePort());
  const service = await startMvpService(config, provider);
  const token = await authorize(service.app);
  const client = new Client({ name: 'embedding-outage', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  const workspace = {
    service,
    /** The tool's answer, parsed, and whether it was an error. A raw tool error (not JSON) fails the parse. */
    async call(name: string, args: Record<string, unknown> = {}): Promise<{ body: any; isError: boolean }> {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      return { body: JSON.parse(text), isError: res.isError === true };
    },
    async close() {
      await client.close();
      service.httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => service.httpServer.close(() => resolve()));
      await service.close();
    },
  };
  open.push(workspace);
  return workspace;
}

/** A workspace that saved a fact and a note while the provider was up (so it holds vectors), then lost the provider. */
async function workspaceInOutage() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const provider = new FlakyProvider();
  const ws = await startWorkspace(provider);
  await ws.call('remember', { statement: 'The Atlas staging cluster runs on ECS.', subject: 'Atlas staging', predicate: 'runs_on', object: 'ECS' });
  await ws.call('remember', { statement: 'Kestrel uses Expo Router for navigation.' });
  expect(chunksWithoutVectors(ws.service.db)).toBe(0);
  provider.down = true;
  return { ws, provider };
}

const QUESTION = 'When is the quarterly access review due?';
const NOTE = 'The quarterly access review is due on November 15.';

// The secret guard is on by default. These tests store fixture text that the guard refuses (a credential-shaped or an
// identifier-shaped sentence that is incidental to what each test checks), so they run with it explicitly off.
const SAVED_GUARD = process.env.RENOR_SECRET_GUARD;
beforeAll(() => { process.env.RENOR_SECRET_GUARD = '0'; });
afterAll(() => { if (SAVED_GUARD === undefined) delete process.env.RENOR_SECRET_GUARD; else process.env.RENOR_SECRET_GUARD = SAVED_GUARD; });

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('while the embedding provider is down', () => {
  it('get_context answers with the saved facts and keyword search, says semantic search failed and why, and calls the provider once', async () => {
    process.env.RENOR_CONTEXT_RELEVANCE_MIN = '0.5'; // armed: an outage must not read as "nothing on file matches"
    const { ws, provider } = await workspaceInOutage();
    await ws.call('remember', { statement: 'The quarterly access review is owned by Priya.', subject: 'quarterly access review', predicate: 'owner', object: 'Priya' });
    await ws.call('remember', { statement: NOTE });

    const before = { documents: provider.documentRequests, queries: provider.queryRequests };
    const context = await ws.call('get_context', { query: QUESTION });
    expect(context.isError).toBe(false);
    expect(context.body).toMatchObject({ ok: true, query: QUESTION, retrieval: 'keyword' });
    expect(context.body.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'quarterly access review', predicate: 'owner', object: 'Priya' }),
    ]));
    expect(context.body.memories).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'fts', text: expect.stringContaining(NOTE) })]));
    expect(context.body.notice).toContain(OUTAGE);
    expect(context.body.notice).toMatch(/nothing here was found by meaning/);
    expect(context.body).not.toHaveProperty('relevance');
    // One query embedding, which failed; nothing saved earlier is retried against a provider that is down.
    expect({ documents: provider.documentRequests, queries: provider.queryRequests })
      .toEqual({ documents: before.documents, queries: before.queries + 1 });

    // A scoped read degrades the same way and still shows only its own scope.
    await ws.call('remember', { statement: 'Kestrel ships its quarterly access review build on Fridays.', scope: 'project:kestrel' });
    const scoped = await ws.call('get_context', { query: QUESTION, scope: 'project:kestrel' });
    expect(scoped.isError).toBe(false);
    expect(scoped.body).toMatchObject({ ok: true, scope: 'project:kestrel', retrieval: 'keyword', facts: [] });
    expect(scoped.body.memories.map((m: { text: string }) => m.text).join('\n')).toContain('Fridays');
    expect(scoped.body.memories.map((m: { text: string }) => m.text).join('\n')).not.toContain('November 15');
    expect(scoped.body.notice).toContain(OUTAGE);
  }, TEST_TIMEOUT_MS);

  it('search_memory answers semantic-unavailable and why, not a raw tool error', async () => {
    const { ws } = await workspaceInOutage();
    const search = await ws.call('search_memory', { query: QUESTION });
    expect(search.isError).toBe(true);
    expect(search.body).toMatchObject({ ok: false, error: 'semantic-unavailable', hits: [] });
    expect(search.body.notice).toContain(OUTAGE);
  }, TEST_TIMEOUT_MS);

  it('a save says the index refresh failed, and why; a save while the provider is up says nothing new', async () => {
    const { ws, provider } = await workspaceInOutage();

    const fact = await ws.call('remember', { statement: 'The carrier rates API key rotates every 90 days.', subject: 'carrier rates API key', predicate: 'rotation', object: 'every 90 days' });
    expect(fact.body).toMatchObject({ ok: true, mode: 'fact', action: 'store', warning: 'memory-saved-but-index-refresh-failed', detail: OUTAGE });
    expect(fact.body.index.errors).toBeGreaterThan(0);
    expect(fact.body.index).not.toHaveProperty('failure');

    const note = await ws.call('remember', { statement: NOTE });
    expect(note.body).toMatchObject({ ok: true, mode: 'note', indexed: false, warning: 'memory-saved-but-index-refresh-failed', detail: OUTAGE });
    expect(note.body.index).toEqual({ total: 2, indexed: 0, errors: 2 });

    provider.down = false;
    const healthyFact = await ws.call('remember', { statement: 'The Atlas staging cluster has 3 nodes.', subject: 'Atlas staging', predicate: 'node_count', object: '3' });
    expect(healthyFact.body.ok).toBe(true);
    for (const key of ['index', 'warning', 'detail']) expect(healthyFact.body).not.toHaveProperty(key);
    const healthyNote = await ws.call('remember', { statement: 'Kestrel targets iOS 17 and later.' });
    expect(healthyNote.body).toMatchObject({ ok: true, mode: 'note', indexed: true, index: { errors: 0 } });
    expect(Object.keys(healthyNote.body.index).sort()).toEqual(['errors', 'indexed', 'total']);
    for (const key of ['warning', 'detail']) expect(healthyNote.body).not.toHaveProperty(key);
  }, TEST_TIMEOUT_MS);

  it('a fact receipt keeps its possible-duplicate hint beside the index outcome', async () => {
    const { ws } = await workspaceInOutage();
    const fact = await ws.call('remember', { statement: 'The Atlas staging cluster runs on Fargate now.', subject: 'Atlas staging cluster', predicate: 'runs_on', object: 'Fargate' });
    expect(fact.body).toMatchObject({ ok: true, mode: 'fact', warning: 'memory-saved-but-index-refresh-failed', detail: OUTAGE });
    expect(fact.body.index.errors).toBeGreaterThan(0);
    expect(fact.body.possibleDuplicates).toEqual([expect.objectContaining({ subject: 'Atlas staging', object: 'ECS', scope: 'global' })]);
  }, TEST_TIMEOUT_MS);

  it('memory_status counts the chunks that have no vector, and a keyword-only workspace has no such count', async () => {
    const { ws, provider } = await workspaceInOutage();
    await ws.call('remember', { statement: 'The carrier rates API key rotates every 90 days.', subject: 'carrier rates API key', predicate: 'rotation', object: 'every 90 days' });
    await ws.call('remember', { statement: NOTE });
    // The fact's ledger event and the note: one chunk each, kept for keyword search, without a vector.
    expect((await ws.call('memory_status')).body).toMatchObject({ semantic: true, chunksWithoutVectors: 2 });

    provider.down = false;
    await ws.call('search_memory', { query: QUESTION });
    expect((await ws.call('memory_status')).body.chunksWithoutVectors).toBe(0);

    const keywordOnly = await startWorkspace(null);
    await keywordOnly.call('remember', { statement: NOTE });
    const status = (await keywordOnly.call('memory_status')).body;
    expect(status.semantic).toBe(false);
    expect(status).not.toHaveProperty('chunksWithoutVectors');
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('after the embedding provider is back', () => {
  it('the first search finds by meaning what was saved during the outage, before any other save', async () => {
    const { ws, provider } = await workspaceInOutage();
    await ws.call('remember', { statement: NOTE });
    expect(chunksWithoutVectors(ws.service.db)).toBe(1);

    provider.down = false;
    const search = await ws.call('search_memory', { query: QUESTION });
    expect(search.isError).toBe(false);
    const byMeaning = (search.body.hits as Array<{ reason: string; text: string }>).filter(h => h.reason.startsWith('semantic'));
    expect(byMeaning.map(h => h.text).join('\n')).toContain(NOTE);
    expect(chunksWithoutVectors(ws.service.db)).toBe(0);
    expect(ws.service.db.prepare(UNFINISHED_FILES).pluck().get()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('so does the first get_context', async () => {
    const { ws, provider } = await workspaceInOutage();
    await ws.call('remember', { statement: NOTE });

    provider.down = false;
    const context = await ws.call('get_context', { query: QUESTION });
    expect(context.body).toMatchObject({ ok: true, retrieval: 'hybrid' });
    expect(context.body).not.toHaveProperty('notice');
    const byMeaning = (context.body.memories as Array<{ reason: string; text: string }>).filter(m => m.reason.startsWith('semantic'));
    expect(byMeaning.map(m => m.text).join('\n')).toContain(NOTE);
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a workspace whose every save failed to embed (a provider down or misconfigured from the start)', () => {
  it('says semantic search failed rather than that nothing matched, and the first search after the provider is back finds them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = new FlakyProvider();
    provider.down = true;
    const ws = await startWorkspace(provider);
    await ws.call('remember', { statement: NOTE });
    expect(ws.service.db.prepare('SELECT COUNT(*) FROM chunk_embeddings_rowids').pluck().get()).toBe(0);

    // The index holds no vector, so the search itself would not ask the provider: it is asked, fails, and says so.
    const documents = provider.documentRequests;
    // The question is a sentence, not a phrase in the note: the keyword fallback searches its words (any-word), so the note is found and marked as a keyword match.
    const search = await ws.call('search_memory', { query: QUESTION });
    expect(search.isError).toBe(false);
    expect(search.body).toMatchObject({ ok: true, fallback: 'keyword' });
    expect(search.body.hits.map((h: { text: string }) => h.text).join('\n')).toContain(NOTE);
    expect(search.body.notice).toContain(OUTAGE);
    // A query no note shares a word with still answers semantic-unavailable and why.
    const none = await ws.call('search_memory', { query: 'zebra xylophone quartz' });
    expect(none.body).toMatchObject({ ok: false, error: 'semantic-unavailable', hits: [] });
    expect(none.body.notice).toContain(OUTAGE);
    const context = await ws.call('get_context', { query: QUESTION });
    expect(context.body).toMatchObject({ ok: true, retrieval: 'keyword' });
    expect(context.body.notice).toContain(OUTAGE);
    expect(context.body.memories).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'fts', text: expect.stringContaining(NOTE) })]));
    expect(provider.documentRequests).toBe(documents); // nothing saved earlier is retried against a provider that is down

    provider.down = false;
    const found = await ws.call('search_memory', { query: QUESTION });
    const byMeaning = (found.body.hits as Array<{ reason: string; text: string }>).filter(h => h.reason.startsWith('semantic'));
    expect(byMeaning.map(h => h.text).join('\n')).toContain(NOTE);
    expect(chunksWithoutVectors(ws.service.db)).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe('a search that cannot finish what a save left', () => {
  it('leaves it for a while, then tries again, and never fails the search', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const memoryDir = tmp('mvp-outage-engine-');
    fs.writeFileSync(path.join(memoryDir, 'mango.md'), '# Mango\n\nThe mango juice stand closes at six.\n');
    fs.writeFileSync(path.join(memoryDir, 'quokka.md'), '# Quokka\n\nThe quokkaberry orchard opens in spring.\n');
    const db = openDb(path.join(tmp('mvp-outage-db-'), 'index.db'));
    open.push({ close: async () => { db.close(); } });
    runMigrations(db);
    const provider = new FlakyProvider();
    provider.refuses = (text) => text.includes('quokkaberry'); // one chunk the provider will not embed, while it answers
    const engine = attachEngine(db, { embeddingProvider: 'none' } as MvpConfig, provider);
    expect(await engineIndexChanged(db, { memoryDir }, engine)).toMatchObject({ errors: 1, failure: OUTAGE });
    expect(db.prepare(UNFINISHED_FILES).pluck().get()).toBe(1);

    const search = () => engineSearchMemory(db, engine, memoryDir, 'mango juice stand', 5);
    const refusedRequests = () => provider.documentRequests;
    const start = refusedRequests();
    expect((await search()).ok).toBe(true); // tried once: the provider answered the query
    expect(refusedRequests()).toBe(start + 1);
    expect((await search()).ok).toBe(true); // left alone
    expect(refusedRequests()).toBe(start + 1);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + UNFINISHED_RETRY_MS + 1_000);
    expect((await search()).ok).toBe(true); // tried again
    expect(refusedRequests()).toBe(start + 2);

    provider.refuses = () => false;
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * (UNFINISHED_RETRY_MS + 1_000));
    const found = await engineSearchMemory(db, engine, memoryDir, 'quokkaberry orchard', 5);
    expect(found.ok).toBe(true);
    expect((found.hits as Array<{ notePath: string; reason: string }>)
      .some(h => h.notePath === 'quokka.md' && h.reason.startsWith('semantic'))).toBe(true);
    expect(db.prepare(UNFINISHED_FILES).pluck().get()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('asks a partial index which files are unfinished, not every note', () => {
    const db = openDb(path.join(tmp('mvp-outage-plan-'), 'index.db'));
    open.push({ close: async () => { db.close(); } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    runMigrations(db);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${UNFINISHED_FILES}`).all() as Array<{ detail: string }>;
    expect(plan.map(step => step.detail).join('\n')).toMatch(/USING (COVERING )?INDEX idx_notes_unfinished/);
  });
});
