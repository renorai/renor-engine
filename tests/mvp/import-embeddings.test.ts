import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import type Database from '../../src/db/sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { chunksWithoutVectors } from '../../src/embeddings/rebuild';
import { run as importCommand } from '../../src/importing/cli';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { engineRebuildEmbeddings, runningEmbeddingRebuild } from '../../src/mvp/engine';
import type { Express } from 'express';

/**
 * Notes imported into a workspace that searches by meaning get their vectors (first-week scout F3/F8 residual; findings
 * inventory, item 3). The importer copies a note's chunks into the index without vectors, under a note row whose hash an
 * index pass skips as unchanged, and nothing embedded them: search_memory never found an imported note, not after a later
 * save or index_memory either, memory_status counted its chunks without vectors for good, and get_context found it by
 * keyword only. Now the import marks the index unfinished in the commit that writes those chunks, and the background job
 * that completes an index embeds exactly the chunks that have no vector, once, resumably, keeping every vector the
 * workspace had; semantic search is off, and says so, until that is done. Driven through the real MCP tools and the
 * renor-import command, with the deterministic eval-hash stub (no model, no network) and synthetic notes.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const OUTAGE = 'embedding provider unavailable (synthetic outage)';
const tmpDirs: string[] = [];
type Service = MvpApp & { httpServer: import('http').Server };
const services: Service[] = [];
const providers: CountingHash[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const provider of providers.splice(0)) provider.release(); // a failed test must not leave a request waiting
  while (services.length) await stop(services.pop()!);
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function stop(service: Service): Promise<void> {
  service.httpServer.closeAllConnections?.();
  service.httpServer.close();
  await service.close();
}

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * The eval-hash stub, which declares its model as every product provider does. `calls` counts requests when they are
 * made; `texts` gets a request's texts when it is answered. The first `hold` requests wait for `release()`, and every
 * request fails while `down`.
 */
class CountingHash extends EvalHashEmbeddingProvider {
  calls = 0;
  texts: string[] = [];
  hold = 0;
  down = false;
  private waiting: Array<() => void> = [];
  constructor() {
    super();
    providers.push(this);
  }
  release(): void {
    this.hold = 0;
    this.waiting.splice(0).forEach((resume) => resume());
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (this.calls++ < this.hold) await new Promise<void>((resume) => this.waiting.push(resume));
    if (this.down) throw new Error(OUTAGE);
    this.texts.push(...texts);
    return super.embed(texts);
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

function mcpConfig(memoryDir: string, port: number): MvpConfig {
  const authRoot = tmp('import-embeddings-auth-');
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.MVP_DB_PATH;
  return loadMvpConfig();
}

async function registerAndToken(app: Express): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'import-embeddings-test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

/** A started service and an MCP client on it; calls go one at a time (the stateless JSON mode shares one server). */
async function start(memoryDir: string, provider: EvalHashEmbeddingProvider | null) {
  const config = mcpConfig(memoryDir, await freePort());
  const service = await startMvpService(config, provider);
  services.push(service);
  const client = new Client({ name: 'import-embeddings-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${await registerAndToken(service.app)}` } } },
  ));
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
  const close = async () => {
    await client.close();
    services.splice(services.indexOf(service), 1);
    await stop(service);
  };
  return { service, call, close };
}

interface Row { id: number; text: string; note_path: string }
const chunkRows = (db: Database.Database) => db.prepare('SELECT id, text, note_path FROM chunks ORDER BY id').all() as Row[];
const importedChunks = (db: Database.Database) => chunkRows(db).filter((r) => r.note_path.includes(`${path.sep}Imported${path.sep}`));
const sorted = (texts: string[]) => [...texts].sort();
const semanticHit = (hits: Array<{ notePath: string; reason: string }>, notePath: string) =>
  hits.some((h) => h.notePath === notePath && h.reason.split('+').includes('semantic'));
const textsWithoutVectors = (db: Database.Database) => db.prepare(
  'SELECT c.text FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings_rowids r WHERE r.rowid = c.id)',
).pluck().all() as string[];

/** Every chunk holds exactly the vector the stub makes of its own text, and no other vector is stored. */
async function everyChunkHasItsVector(service: Service): Promise<void> {
  const rows = chunkRows(service.db);
  expect(chunksWithoutVectors(service.db)).toBe(0);
  expect(service.db.prepare('SELECT rowid FROM chunk_embeddings_rowids ORDER BY rowid').pluck().all()).toEqual(rows.map((r) => r.id));
  const wanted = await new EvalHashEmbeddingProvider().embed(rows.map((r) => r.text));
  const wrong = rows.filter((r, i) => {
    const stored = service.engine.vectorIndex!.get(r.id);
    return !stored || stored.some((x, j) => Math.abs(x - wanted[i][j]) > 1e-5);
  });
  expect(wrong.map((r) => r.id)).toEqual([]);
}

const SAID = 'Kestrel uses Expo Router for navigation.';
const IMPORTED = 'Quillmoor billing runs on the ninth of each month through Paddle.';
const QUESTION = 'When does Quillmoor billing run?';
const FILES = [
  { relativePath: 'Billing.md', markdown: `# Billing\n\n${IMPORTED}\n` },
  {
    relativePath: 'Runbooks/Deploy.md',
    markdown: '# Deploy\n\n## Staging\nThe Fernhollow staging deploy waits for the smoke suite to pass.\n\n'
      + '## Production\nFernhollow production deploys go out on Tuesdays after the change review.\n',
  },
];

/** A workspace with the provider that has saved one note, so its index is named and holds vectors. */
async function workspaceWithVectors(memoryDir: string, provider: CountingHash) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const ws = await start(memoryDir, provider);
  expect((await ws.call('remember', { statement: SAID, source: 'test' })).mode).toBe('note');
  expect(chunkRows(ws.service.db).length).toBeGreaterThan(0);
  expect(chunksWithoutVectors(ws.service.db)).toBe(0);
  return ws;
}

describe('notes imported with apply_import into a workspace that searches by meaning', () => {
  it('are embedded once, in the background, and then search_memory and get_context find a note by its own sentence', async () => {
    const memoryDir = tmp('import-embeddings-');
    const provider = new CountingHash();
    const ws = await workspaceWithVectors(memoryDir, provider);
    const db = ws.service.db;
    const embeddedBefore = provider.texts.length;
    const callsBefore = provider.calls;

    const preview = await ws.call('preview_import', { label: 'scout', files: FILES });
    expect(preview.toWrite).toBe(2);
    provider.hold = Number.POSITIVE_INFINITY; // the import's embedding waits, so what happens meanwhile can be watched
    const applied = await ws.call('apply_import', { batchId: preview.batchId });
    expect(applied).toMatchObject({ ok: true, notesWritten: 2, conflicts: [] });
    const imported = importedChunks(db);
    expect(imported.length).toBeGreaterThanOrEqual(3); // the billing note, and both sections of the runbook
    expect(imported.some((r) => r.text.includes(IMPORTED))).toBe(true);

    // Started at once, in the background: the import has returned, and its chunks are on their way to the provider.
    expect(provider.calls).toBeGreaterThan(callsBefore);
    // Until they have their vectors, semantic search is off and says how much is left; keyword search finds the note.
    const status = await ws.call('memory_status');
    expect(status).toMatchObject({ semantic: false, chunksWithoutVectors: imported.length });
    expect(status.embeddingRebuild).toEqual({ chunks: status.chunks, chunksLeft: imported.length });
    const held = await ws.call('search_memory', { query: IMPORTED });
    expect(held).toMatchObject({ ok: true, fallback: 'keyword' });
    expect((held.hits as unknown[]).length).toBeGreaterThan(0);
    expect(held.notice).toContain(`(${imported.length} of ${status.chunks} chunks left)`);
    const keyword = await ws.call('get_context', { query: QUESTION });
    expect(keyword.retrieval).toBe('keyword');
    expect(keyword.notice).toMatch(/Semantic search is off/);
    expect(keyword.memories).toEqual(expect.arrayContaining([expect.objectContaining({ notePath: 'Imported/scout/Billing.md', reason: 'fts' })]));
    // And the receipt says so.
    expect(applied.recall).toMatch(/embedded in the background/);
    // A save meanwhile writes its entry and leaves its embedding to the same job: the provider is asked nothing more.
    const callsWhileHeld = provider.calls;
    expect((await ws.call('remember', { statement: 'Kestrel ships to TestFlight on Fridays.', source: 'test' })).mode).toBe('note');
    expect(provider.calls).toBe(callsWhileHeld);
    const pending = textsWithoutVectors(db);
    expect(pending.some((t) => t.includes('TestFlight'))).toBe(true);

    provider.release();
    await engineRebuildEmbeddings(db, ws.service.engine)?.done; // the job the import started (nothing is left to start)

    // Exactly the chunks without a vector were embedded, each once: the imported ones and the entry saved meanwhile. No
    // chunk that had its vector was embedded again, and every vector is the one its own text makes.
    expect(sorted(provider.texts.slice(embeddedBefore))).toEqual(sorted(pending));
    expect(sorted(pending.filter((t) => imported.some((r) => r.text === t)))).toEqual(sorted(imported.map((r) => r.text)));
    await everyChunkHasItsVector(ws.service);
    const ready = await ws.call('memory_status');
    expect(ready).toMatchObject({ semantic: true, chunksWithoutVectors: 0 });
    expect(ready).not.toHaveProperty('embeddingRebuild');

    // Found by its own sentence, by meaning, through search_memory and get_context.
    const found = await ws.call('search_memory', { query: IMPORTED });
    expect(found.ok).toBe(true);
    expect(semanticHit(found.hits, 'Imported/scout/Billing.md')).toBe(true);
    const context = await ws.call('get_context', { query: QUESTION });
    expect(context.retrieval).toBe('hybrid');
    expect(context).not.toHaveProperty('notice');
    expect(semanticHit(context.memories, 'Imported/scout/Billing.md')).toBe(true);

    // Nothing is embedded again: a later save embeds its own entry, index_memory nothing, and neither the imported chunks.
    const afterImport = provider.texts.length;
    expect((await ws.call('remember', { statement: 'Kestrel beta builds go out on Mondays.', source: 'test' })).mode).toBe('note');
    const savedTexts = provider.texts.slice(afterImport);
    expect(savedTexts.length).toBeGreaterThan(0);
    expect(savedTexts.filter((t) => imported.some((r) => r.text === t))).toEqual([]);
    const afterSave = provider.texts.length;
    expect((await ws.call('index_memory')).ok).toBe(true);
    expect(provider.texts.length).toBe(afterSave);
    expect((await ws.call('memory_status')).chunksWithoutVectors).toBe(0);
  });

  it('a provider that is down leaves the import saved and reported, and after a restart its chunks are embedded once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const memoryDir = tmp('import-embeddings-');
    const first = new CountingHash();
    const ws = await workspaceWithVectors(memoryDir, first);
    const embeddedBefore = first.texts.length;
    const callsBefore = first.calls;

    first.down = true;
    const preview = await ws.call('preview_import', { label: 'scout', files: FILES });
    const applied = await ws.call('apply_import', { batchId: preview.batchId });
    // Saved: the import does not wait on the provider, and its failure loses nothing.
    expect(applied).toMatchObject({ ok: true, notesWritten: 2, conflicts: [] });
    expect(fs.readFileSync(path.join(memoryDir, 'Imported', 'scout', 'Billing.md'), 'utf8')).toContain(IMPORTED);
    const journal = JSON.parse(fs.readFileSync(path.join(memoryDir, '.renor-imports', `${preview.batchId}.json`), 'utf8'));
    expect(journal.state).toBe('applied');
    const text = await ws.call('search_text', { query: 'Quillmoor' });
    expect(text.results.map((r: { notePath: string }) => r.notePath)).toEqual(['Imported/scout/Billing.md']);
    // Reported: the chunks search by meaning cannot find yet are counted, and semantic search says it is off.
    const imported = importedChunks(ws.service.db);
    const status = await ws.call('memory_status');
    expect(status).toMatchObject({ semantic: false, chunksWithoutVectors: imported.length });
    expect(status.embeddingRebuild).toEqual({ chunks: status.chunks, chunksLeft: imported.length });
    expect(await ws.call('search_memory', { query: IMPORTED })).toMatchObject({ ok: true, fallback: 'keyword' }); // semantic is rebuilding: keyword hits, marked
    expect(first.calls).toBeGreaterThan(callsBefore); // the background job asked, and the provider failed
    expect(first.texts.length).toBe(embeddedBefore); // so nothing of the import was embedded
    await ws.close();
    expect(runningEmbeddingRebuild(ws.service.engine)).toBeNull(); // the job waiting to try again was stopped first

    // Restarted with the provider back: the job resumes and embeds exactly the imported chunks, once.
    const second = new CountingHash();
    const again = await start(memoryDir, second);
    await again.service.embeddingRebuild;
    expect(sorted(second.texts)).toEqual(sorted(imported.map((r) => r.text)));
    expect(chunksWithoutVectors(again.service.db)).toBe(0);
    expect(await again.call('memory_status')).toMatchObject({ semantic: true, chunksWithoutVectors: 0 });
    expect(semanticHit((await again.call('search_memory', { query: IMPORTED })).hits, 'Imported/scout/Billing.md')).toBe(true);
  });
});

describe('notes imported with apply_import into a workspace that searches by keyword only', () => {
  it('are found by keyword as before: nothing is marked or embedded, and the receipt says so', async () => {
    const ws = await start(tmp('import-embeddings-'), null);
    const preview = await ws.call('preview_import', { label: 'scout', files: FILES });
    const applied = await ws.call('apply_import', { batchId: preview.batchId });
    expect(applied).toMatchObject({ ok: true, notesWritten: 2 });
    expect(applied.recall).toBe('Keyword recall is ready through search_text; no embeddings or structured facts were generated.');
    expect(engineRebuildEmbeddings(ws.service.db, ws.service.engine)).toBeNull(); // no provider: nothing to embed
    const status = await ws.call('memory_status');
    expect(status.semantic).toBe(false);
    expect(status).not.toHaveProperty('embeddingRebuild');
    expect(status).not.toHaveProperty('chunksWithoutVectors');
    const text = await ws.call('search_text', { query: 'Quillmoor' });
    expect(text.results.map((r: { notePath: string }) => r.notePath)).toEqual(['Imported/scout/Billing.md']);
  });
});

describe('notes imported with the renor-import command into a workspace that searches by meaning', () => {
  it('are embedded once by the workspace service when it next starts', async () => {
    const memoryDir = tmp('import-embeddings-');
    const ws = await workspaceWithVectors(memoryDir, new CountingHash());
    const kept = chunkRows(ws.service.db).map((r) => r.text);
    await ws.close(); // the operator stops the service for the import window (docs/MEMORY-IMPORT.md)

    const source = tmp('import-embeddings-source-');
    for (const file of FILES) {
      fs.mkdirSync(path.dirname(path.join(source, file.relativePath)), { recursive: true });
      fs.writeFileSync(path.join(source, file.relativePath), file.markdown);
    }
    expect(await importCommand(['--from', `markdown:${source}`, '--to', memoryDir, '--namespace', 'Imported/cli', '--apply', '--json'])).toBe(0);

    const provider = new CountingHash();
    const after = await start(memoryDir, provider);
    await after.service.embeddingRebuild;
    const imported = importedChunks(after.service.db);
    expect(imported.length).toBeGreaterThanOrEqual(3);
    // Only the imported chunks are embedded, each once: the chunks the workspace had keep their vectors.
    expect(sorted(provider.texts)).toEqual(sorted(imported.map((r) => r.text)));
    expect(provider.texts.filter((t) => kept.includes(t))).toEqual([]);
    expect(chunksWithoutVectors(after.service.db)).toBe(0);
    expect(await after.call('memory_status')).toMatchObject({ semantic: true, chunksWithoutVectors: 0 });
    expect(semanticHit((await after.call('search_memory', { query: IMPORTED })).hits, 'Imported/cli/Billing.md')).toBe(true);
  });
});
