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
import { embeddingSpace } from '../../src/embeddings/space';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { readEmbeddingTableDims, semanticReady } from '../../src/mvp/engine';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * A workspace that searched by keyword (no embedding provider, what the provisioner ships by default) and is started
 * with one must get a vector for everything it already holds: every chunk, embedded once, in the background, resumed
 * after a restart, with semantic search off and saying so until the index is whole. Before this, the index was named
 * after the provider as if it were new: memory_status said semantic: true, search_memory found none of the old notes,
 * and index_memory embedded nothing (the notes had not changed). The same holds for a workspace that had the provider,
 * ran without it for a while, and has it again. Synthetic notes, the eval-hash stub (no model, no network).
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
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
 * The eval-hash stub, which declares its model as every product provider does, counting what it is asked to embed.
 * `calls` counts requests when they are made; `texts` gets a request's texts when it is answered. The first `hold`
 * requests wait for `release()`.
 */
class CountingHash extends EvalHashEmbeddingProvider {
  calls = 0;
  texts: string[] = [];
  hold = 0;
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
  const authRoot = tmp('backfill-auth-');
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
    .send({ client_name: 'backfill-test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

/** A started service and an MCP client on it; reads go one at a time (the stateless JSON mode shares one server). */
async function start(memoryDir: string, provider: EvalHashEmbeddingProvider | null) {
  const config = mcpConfig(memoryDir, await freePort());
  const service = await startMvpService(config, provider);
  services.push(service);
  const client = new Client({ name: 'backfill-test', version: '0' });
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
const vectorIds = (db: Database.Database) => db.prepare('SELECT rowid FROM chunk_embeddings_rowids ORDER BY rowid').pluck().all() as number[];
const sorted = (texts: string[]) => [...texts].sort();

/** Every chunk holds exactly the vector the stub makes of its own text, and no other vector is stored. */
async function everyChunkHasItsVector(service: Service): Promise<void> {
  const rows = chunkRows(service.db);
  expect(chunksWithoutVectors(service.db)).toBe(0);
  expect(vectorIds(service.db)).toEqual(rows.map((r) => r.id));
  const wanted = await new EvalHashEmbeddingProvider().embed(rows.map((r) => r.text));
  const wrong = rows.filter((r, i) => {
    const stored = service.engine.vectorIndex!.get(r.id);
    return !stored || stored.some((x, j) => Math.abs(x - wanted[i][j]) > 1e-5);
  });
  expect(wrong.map((r) => r.id)).toEqual([]);
}

const NOTES: Record<string, string> = {
  'Projects/aquarium.md': '# Aquarium\n\nThe zebrafish aquarium in the lab needs its filter replaced every quartz moon.\n',
  'People/mandolin.md': '# Mandolin lessons\n\nOur mandolin teacher moved the lessons to the yellow warehouse downtown.\n',
  'Kitchen/kombucha.md': '# Kombucha\n\nThe kombucha batch number seven tasted like pineapple and cardamom.\n',
};
const SAID = [
  'Remember that the lighthouse keeper prefers marmalade over honey.',
  'The quarterly offsite moved to the glacier cabin near the fjord.',
];
const FACT = { statement: 'The billing service runs on Postgres 17 with a heliotrope replica.', subject: 'billing service', predicate: 'database', object: 'Postgres 17' };
const MORE_FACTS = [
  { statement: 'The design review happens on Thursdays.', subject: 'design review', predicate: 'day', object: 'Thursday' },
  { statement: 'Our on-call rotation is weekly.', subject: 'on-call rotation', predicate: 'cadence', object: 'weekly' },
];

function vaultWith(files: Record<string, string>): string {
  const memoryDir = tmp('backfill-vault-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(memoryDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, rel), text);
  }
  return memoryDir;
}

/** Whether search_memory returns `word` among its best three hits (what the study that found the gap measured). */
async function found(call: (name: string, args?: Record<string, unknown>) => Promise<any>, query: string, word: string): Promise<boolean> {
  const result = await call('search_memory', { query, top_k: 3 });
  return result.ok === true && JSON.stringify(result.hits).includes(word);
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a keyword-only workspace started with an embedding provider', () => {
  it('embeds every chunk it holds, once, in the background, with semantic search off and saying so until it is whole', async () => {
    // Born keyword-only, as the provisioner makes a workspace today: imported notes, notes and a fact.
    const memoryDir = vaultWith(NOTES);
    const before = await start(memoryDir, null);
    expect((await before.call('index_memory')).ok).toBe(true);
    for (const statement of SAID) expect((await before.call('remember', { statement, source: 'test' })).mode).toBe('note');
    for (const fact of [FACT, ...MORE_FACTS]) expect((await before.call('remember', fact)).mode).toBe('fact');
    const keywordOnly = await before.call('memory_status');
    expect(keywordOnly.semantic).toBe(false);
    expect(keywordOnly).not.toHaveProperty('embeddingRebuild');
    expect(await before.call('search_memory', { query: 'zebrafish aquarium' })).toMatchObject({ ok: true, fallback: 'keyword' });
    expect(readEmbeddingTableDims(before.service.db)).toBeNull(); // it never had a vector table
    await before.close();

    // Started again with the eval-hash provider. Its requests are held, so what happens meanwhile can be watched.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = new CountingHash();
    provider.hold = Number.POSITIVE_INFINITY;
    const after = await start(memoryDir, provider);
    const atSwitch = chunkRows(after.service.db);
    const n = atSwitch.length;
    expect(n).toBeGreaterThanOrEqual(8); // three imported notes, the daily note, the ledger's header and its three events
    expect(provider.calls).toBeGreaterThan(0); // started at boot, in the background: the service answers meanwhile
    expect(after.service.engine.vectorIndex!.space()).toBe(embeddingSpace(provider));
    expect(after.service.engine.vectorIndex!.rebuilding()).toBe(true);
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(`"event":"embeddings_backfill","chunks":${n},`);

    // Until every chunk has its vector, semantic search is off and says how much is left; keyword search answers.
    const status = await after.call('memory_status');
    expect(status.semantic).toBe(false);
    expect(status.embeddingRebuild).toEqual({ chunks: n, chunksLeft: n });
    const held = await after.call('search_memory', { query: 'zebrafish aquarium filter' });
    expect(held).toMatchObject({ ok: false, error: 'semantic-rebuilding', hits: [] });
    expect(held.notice).toContain(`(${n} of ${n} chunks left)`);
    expect(held.notice).toMatch(/Keyword search works meanwhile/);
    const context = await after.call('get_context', { query: 'zebrafish aquarium filter', max_tokens: 4000 });
    expect(context.retrieval).toBe('keyword');
    expect(context.notice).toMatch(/Semantic search is off/);
    expect(JSON.stringify(context.memories)).toContain('zebrafish');

    // Saves meanwhile write their chunks and leave the embedding to the backfill: the provider is asked nothing.
    const callsBeforeSaves = provider.calls;
    const saved = await after.call('remember', { statement: 'A note saved during the backfill, about narwhals and sextants.', source: 'test' });
    expect(saved).toMatchObject({ ok: true, mode: 'note', indexed: true });
    const fact = await after.call('remember', { statement: 'The deploy bot is called Pelican now.', subject: 'deploy bot', predicate: 'name', object: 'Pelican' });
    expect(fact).toMatchObject({ ok: true, mode: 'fact' });
    expect(fact).not.toHaveProperty('warning');
    expect(provider.calls).toBe(callsBeforeSaves);
    const meanwhile = await after.call('memory_status');
    expect(meanwhile.semantic).toBe(false);
    expect(meanwhile.chunks).toBeGreaterThan(n);
    expect(meanwhile.embeddingRebuild).toEqual({ chunks: meanwhile.chunks, chunksLeft: meanwhile.chunks });

    provider.release();
    await after.service.embeddingRebuild;
    log.mockRestore();
    await everyChunkHasItsVector(after.service);
    // Once each: the provider embedded the chunks the workspace held at the switch (a chunk a save replaced while its
    // request was on its way included) and the chunks the saves wrote meanwhile, and nothing else, nothing twice.
    const atEnd = chunkRows(after.service.db);
    const written = atEnd.filter((r) => !atSwitch.some((s) => s.id === r.id));
    expect(written.length).toBeGreaterThan(0);
    expect(sorted(provider.texts)).toEqual(sorted([...atSwitch, ...written].map((r) => r.text)));
    // And the saves replaced no chunk they did not change: of what the workspace held at the switch, only the last chunk
    // of the daily note and of the ledger (the files they appended to) can have been replaced. A save that rewrote a
    // whole file would make the backfill embed the same text twice.
    const lastChunkOf = (match: (notePath: string) => boolean) => atSwitch.filter((r) => match(r.note_path)).at(-1)?.id;
    const appendedTo = [
      lastChunkOf((p) => p.includes(`Memory${path.sep}Daily${path.sep}`)),
      lastChunkOf((p) => p.endsWith('Memory Events Ledger.md')),
    ];
    const replaced = atSwitch.filter((r) => !atEnd.some((e) => e.id === r.id));
    expect(replaced.filter((r) => !appendedTo.includes(r.id)).map((r) => r.note_path)).toEqual([]);
    expect(after.service.engine.vectorIndex!.rebuilding()).toBe(false);
    expect(semanticReady(after.service.engine)).toBe(true);

    // Whole: semantic search answers, for what was there before the switch and for what was saved during it.
    const ready = await after.call('memory_status');
    expect(ready.semantic).toBe(true);
    expect(ready).not.toHaveProperty('embeddingRebuild');
    expect(await found(after.call, 'The zebrafish aquarium in the lab needs its filter replaced every quartz moon.', 'zebrafish')).toBe(true);
    expect(await found(after.call, 'Our mandolin teacher moved the lessons to the yellow warehouse downtown.', 'mandolin')).toBe(true);
    expect(await found(after.call, 'The kombucha batch number seven tasted like pineapple and cardamom.', 'kombucha')).toBe(true);
    expect(await found(after.call, SAID[0], 'lighthouse')).toBe(true);
    expect(await found(after.call, FACT.statement, 'heliotrope')).toBe(true);
    expect(await found(after.call, 'narwhals and sextants', 'narwhals')).toBe(true);
    const contextAfter = await after.call('get_context', { query: 'zebrafish aquarium filter', max_tokens: 4000 });
    expect(contextAfter.retrieval).toBe('hybrid');
    expect(contextAfter).not.toHaveProperty('notice');

    // Nothing is embedded again: not by index_memory, and not by the next start.
    const callsWhenWhole = provider.calls;
    expect((await after.call('index_memory')).ok).toBe(true);
    expect(provider.calls).toBe(callsWhenWhole);
    await after.close();
    const again = new CountingHash();
    const third = await start(memoryDir, again);
    await third.service.embeddingRebuild;
    expect(again.calls).toBe(0);
    expect((await third.call('memory_status')).semantic).toBe(true);
    expect(await found(third.call, 'The kombucha batch number seven tasted like pineapple and cardamom.', 'kombucha')).toBe(true);
  });

  it('resumes after a restart with the chunks that have no vector yet, and embeds none of the others again', async () => {
    // 200 chunks: more than one pass of the backfill (4 requests of 32).
    const notes: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      notes[`Imported/topic-${i}.md`] = `# Topic${i}\n\n`
        + Array.from({ length: 4 }, (_, k) => `## Topic${i} part ${k}\nThe Topic${i} detail number ${k} is about item Topic${i}x${k}.\n`).join('\n');
    }
    const memoryDir = vaultWith(notes);
    const before = await start(memoryDir, null);
    expect((await before.call('index_memory')).ok).toBe(true);
    await before.close();

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = new CountingHash();
    first.hold = 2; // of the first pass's four requests, two are answered at once and two wait
    const interrupted = await start(memoryDir, first);
    const all = chunkRows(interrupted.service.db);
    expect(all.length).toBe(200);
    await vi.waitFor(() => expect(first.calls).toBe(4));
    const stopping = interrupted.close(); // stops between requests; the two on their way are finished and kept
    first.release();
    await stopping;
    expect(first.calls).toBe(4); // no request after the stop
    expect(first.texts.length).toBe(128);

    const second = new CountingHash();
    second.hold = Number.POSITIVE_INFINITY;
    const resumed = await start(memoryDir, second);
    const status = await resumed.call('memory_status');
    expect(status.semantic).toBe(false);
    expect(status.embeddingRebuild).toEqual({ chunks: 200, chunksLeft: 72 });
    expect((await resumed.call('search_memory', { query: 'Topic3 detail' })).notice).toContain('(72 of 200 chunks left)');
    second.release();
    await resumed.service.embeddingRebuild;
    expect(second.texts.length).toBe(72);
    // Across both starts, every chunk's text was embedded exactly once.
    expect(sorted([...first.texts, ...second.texts])).toEqual(sorted(all.map((r) => r.text)));
    await everyChunkHasItsVector(resumed.service);
    expect((await resumed.call('memory_status')).semantic).toBe(true);
    expect(await found(resumed.call, 'The Topic31 detail number 2 is about item Topic31x2.', 'Topic31x2')).toBe(true);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a workspace that had the provider, ran without it, and has it again', () => {
  it('embeds what was saved meanwhile, keeps the vectors it had, and drops the vectors of chunks that are gone', async () => {
    const memoryDir = vaultWith(NOTES);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const original = new CountingHash();
    const embedded = await start(memoryDir, original);
    await embedded.service.embeddingRebuild; // a new index: named at once, nothing to do
    expect((await embedded.call('index_memory')).ok).toBe(true);
    expect((await embedded.call('remember', FACT)).mode).toBe('fact');
    await everyChunkHasItsVector(embedded.service);
    await embedded.close();

    // Without the provider: the index is marked unfinished, and what is saved gets no vector.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const keywordOnly = await start(memoryDir, null);
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('"event":"embeddings_unconfigured","detail":"no embedding provider is configured');
    expect((await keywordOnly.call('remember', { statement: 'Saved without embeddings: the orchard ladder is in the blue shed.', source: 'test' })).mode).toBe('note');
    expect((await keywordOnly.call('remember', { statement: 'The staging database is Postgres 16.', subject: 'staging database', predicate: 'engine', object: 'Postgres 16' })).mode).toBe('fact');
    await keywordOnly.close();

    const provider = new CountingHash();
    provider.hold = Number.POSITIVE_INFINITY;
    const back = await start(memoryDir, provider);
    const db = back.service.db;
    const missing = db.prepare(
      'SELECT c.id, c.text FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings_rowids r WHERE r.rowid = c.id) ORDER BY c.id',
    ).all() as Row[];
    const total = chunkRows(db).length;
    const orphans = (db.prepare('SELECT COUNT(*) FROM chunk_embeddings_rowids r WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = r.rowid)').pluck().get() as number);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.length).toBeLessThan(total);
    expect(orphans).toBeGreaterThan(0); // the ledger's last event, replaced by the save made without the provider
    const status = await back.call('memory_status');
    expect(status.semantic).toBe(false);
    expect(status.embeddingRebuild).toEqual({ chunks: total, chunksLeft: missing.length });
    expect(await back.call('search_memory', { query: 'orchard ladder' })).toMatchObject({ ok: true, fallback: 'keyword' });

    provider.release();
    await back.service.embeddingRebuild;
    expect(sorted(provider.texts)).toEqual(sorted(missing.map((r) => r.text))); // only what had no vector, once
    await everyChunkHasItsVector(back.service); // and no vector without its chunk is left
    expect((await back.call('memory_status')).semantic).toBe(true);
    expect(await found(back.call, 'Saved without embeddings: the orchard ladder is in the blue shed.', 'orchard')).toBe(true);
    expect(await found(back.call, 'The zebrafish aquarium in the lab needs its filter replaced every quartz moon.', 'zebrafish')).toBe(true);
  });
});
