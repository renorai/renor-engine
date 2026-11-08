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
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile, indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { embeddingSpace } from '../../src/embeddings/space';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { attachEngine, engineRebuildEmbeddings, engineSearchMemory, engineStatus, semanticReady } from '../../src/mvp/engine';
import { chunksWithoutVectors } from '../../src/embeddings/rebuild';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * An index whose vectors are in another model's space, or in none anyone can vouch for, is never served: semantic
 * search is off (keyword search is not, and says why) while every chunk is embedded again with the configured
 * model, which the service starts at boot; then the index is named and semantic search is back. The index can
 * be mixed on disk for a moment (a save writes the new model's vectors beside the old ones), but never read.
 * Synthetic notes, hash embeddings (no model, no network).
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const tmpDirs: string[] = [];
const services: Array<MvpApp & { httpServer: import('http').Server }> = [];
const dbs: Database.Database[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
    await s.close();
  }
  while (dbs.length) dbs.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** The stub's model (named after itself) that counts what it embeds and can be held. */
class ModelA extends EvalHashEmbeddingProvider {
  texts: string[] = [];
  /** The first this many requests wait for `release()`. */
  hold = 0;
  /** Fail a request for which this returns true. */
  refuse: (texts: string[]) => boolean = () => false;
  private waiting: Array<() => void> = [];
  private answered = 0;
  release() { this.hold = 0; this.waiting.splice(0).forEach((resume) => resume()); }
  protected transform(v: number[]): number[] { return v; }
  async embed(texts: string[]): Promise<number[][]> {
    if (this.answered++ < this.hold) await new Promise<void>((resume) => this.waiting.push(resume));
    if (this.refuse(texts)) throw new Error('synthetic provider failure');
    this.texts.push(...texts);
    return (await super.embed(texts)).map((v) => this.transform(v));
  }
}

/** Another model of the same dimensions whose every vector points the opposite way. */
class ModelB extends ModelA {
  readonly identity = { kind: 'eval-hash', model: 'opposite-model' };
  protected transform(v: number[]): number[] { return v.map((x) => -x); }
}

const note = (title: string, sections: number) =>
  `# ${title}\n\n` + Array.from({ length: sections }, (_, k) => `## ${title} section ${k}\nbody ${title} ${k} codeword quokkaberry\n`).join('\n');

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
  const authRoot = tmp('rebuild-auth-');
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

async function registerAndToken(app: Express) {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'rebuild-test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

async function mcpClient(config: MvpConfig, token: string) {
  const client = new Client({ name: 'rebuild-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

const parse = (res: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((res.content as { text: string }[])[0].text);

interface Legacy { memoryDir: string; config: MvpConfig; chunks: number }

/**
 * A workspace of three notes whose index was built by model A, as the previous release leaves it: `named` keeps the
 * space A recorded (a later model change is then a switch), otherwise it is forgotten (an index of the previous
 * release records none). The database is closed again: a service opens it.
 */
async function workspaceBuiltByA(named: boolean, extra: Record<string, string> = {}): Promise<Legacy> {
  const memoryDir = tmp('rebuild-vault-');
  fs.writeFileSync(path.join(memoryDir, 'a.md'), note('Alpha', 4));
  fs.writeFileSync(path.join(memoryDir, 'b.md'), note('Bravo', 4));
  fs.writeFileSync(path.join(memoryDir, 'c.md'), note('Charlie', 3));
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(memoryDir, name), content);
  const config = mcpConfig(memoryDir, await freePort());
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = openDb(config.dbPath);
  runMigrations(db);
  const a = new ModelA();
  const engine = attachEngine(db, { embeddingProvider: 'none' } as MvpConfig, a);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await indexVault(db, memoryDir, { embeddingProvider: a, vectorIndex: engine.vectorIndex! }, 1);
  log.mockRestore();
  if (!named) db.prepare("DELETE FROM chunk_embedding_meta WHERE key = 'space'").run();
  const chunks = db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number;
  db.close();
  return { memoryDir, config, chunks };
}

/** Every chunk, of every file, has the vector `reference` makes of its text, and there is no other vector. */
async function everyVectorIs(db: Database.Database, vectors: VectorIndex, reference: ModelA) {
  const chunks = db.prepare('SELECT id, note_path, text FROM chunks ORDER BY id').all() as Array<{ id: number; note_path: string; text: string }>;
  const wanted = await reference.embed(chunks.map((c) => c.text));
  const wrong = chunks.filter((c, i) => {
    const stored = vectors.get(c.id);
    return !stored || stored.some((x, j) => Math.abs(x - wanted[i][j]) > 1e-5);
  }).map((c) => `${path.basename(c.note_path)}#${c.id}`);
  const stored = (db.prepare('SELECT COUNT(*) FROM chunk_embeddings_rowids').pluck().get() as number);
  const files = ['a.md', 'b.md', 'c.md'].filter((f) => chunks.some((c) => path.basename(c.note_path) === f));
  return { chunks: chunks.length, stored, wrong, files };
}

async function start(legacy: Legacy, provider: ModelA) {
  const service = await startMvpService(legacy.config, provider);
  services.push(service);
  const client = await mcpClient(legacy.config, await registerAndToken(service.app));
  return { service, client };
}

describe('semanticReady: whether an index may be searched with the configured model', () => {
  it('is true for a whole index in the model\'s space and for a provider that declares no identity, false for every other index', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = async (named: boolean) => {
      const { config } = await workspaceBuiltByA(named);
      const db = openDb(config.dbPath);
      dbs.push(db);
      return db;
    };
    const attach = (db: Database.Database, provider: ModelA | null) => attachEngine(db, { embeddingProvider: 'none' } as MvpConfig, provider);

    expect(semanticReady(attach(await open(true), new ModelA()))).toBe(true);                       // whole, same model
    expect(semanticReady(attach(await open(true), new ModelB()))).toBe(false);                      // another model's vectors
    expect(semanticReady(attach(await open(false), new ModelA()))).toBe(false);                     // vectors of no recorded model
    expect(semanticReady(attach(await open(false), new ModelB()))).toBe(false);
    expect(semanticReady(attach(await open(false), null))).toBe(false);                             // no provider at all
    const unnamed = { dimensions: 256, embed: async (texts: string[]) => texts.map(() => new Array(256).fill(0.1)) };
    expect(semanticReady(attachEngine(await open(false), { embeddingProvider: 'none' } as MvpConfig, unnamed))).toBe(true); // claims nothing

    const marked = await open(true);                                                                // a rebuild begun and not finished
    const engine = attach(marked, new ModelA());
    engine.vectorIndex!.beginRebuild(embeddingSpace(new ModelA())!);
    expect(semanticReady(engine)).toBe(false);
    engine.vectorIndex!.finishRebuild();
    expect(semanticReady(engine)).toBe(true);

    const fresh = openDb(path.join(tmp('rebuild-fresh-'), 'index.db'));                             // a new index is named at once
    dbs.push(fresh);
    runMigrations(fresh);
    expect(semanticReady(attach(fresh, new ModelA()))).toBe(true);
    expect(warn).toHaveBeenCalled(); // the cases above that hold vectors of no known model say so
  });
});

describe('engineRebuildEmbeddings', () => {
  for (const named of [false, true]) {
    it(`${named ? 'after a switch to another model' : 'for an index that records no model'}: every chunk of every file is embedded again, then the index is named and read`, async () => {
      const { memoryDir, config } = await workspaceBuiltByA(named);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const db = openDb(config.dbPath);
      dbs.push(db);
      const b = new ModelB();
      const engine = attachEngine(db, config, b);
      expect(semanticReady(engine)).toBe(false);
      expect(await engineSearchMemory(db, engine, memoryDir, 'quokkaberry', 5)).toMatchObject({ ok: false, error: 'semantic-rebuilding', hits: [] });

      // A note is edited and saved before the rebuild. An index that records another model refuses the write; one that
      // records none takes it, and then holds the new model's vectors beside the old ones, on disk and still not read.
      fs.writeFileSync(path.join(memoryDir, 'a.md'), note('Alpha', 4).replace('section 3', 'section THREE'));
      const save = indexFile(db, path.join(memoryDir, 'a.md'), { embeddingProvider: b, vectorIndex: engine.vectorIndex! });
      if (named) await expect(save).rejects.toThrow(/another embedding model/);
      else await save;
      expect(semanticReady(engine)).toBe(false);

      const rebuild = engineRebuildEmbeddings(db, engine);
      expect(rebuild).not.toBeNull();
      expect(engineRebuildEmbeddings(db, engine)).toBe(rebuild); // one rebuild at a time
      await rebuild!.done;
      log.mockRestore();

      const after = await everyVectorIs(db, engine.vectorIndex!, new ModelB());
      expect(after.wrong).toEqual([]); // not only the edited file: a.md, b.md and c.md
      expect(after.files).toEqual(['a.md', 'b.md', 'c.md']);
      expect(after.stored).toBe(after.chunks);
      expect(engine.vectorIndex!.space()).toBe(embeddingSpace(b));
      expect(engine.vectorIndex!.rebuilding()).toBe(false);
      expect(semanticReady(engine)).toBe(true);
      expect(engineRebuildEmbeddings(db, engine)).toBeNull(); // nothing left to do
      const found = await engineSearchMemory(db, engine, memoryDir, 'quokkaberry', 5);
      expect(found.ok).toBe(true);
      expect(found.hits.length).toBeGreaterThan(0);
    });
  }

  it('waits out a provider that is down, and goes on when it is back', async () => {
    const { config } = await workspaceBuiltByA(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = openDb(config.dbPath);
    dbs.push(db);
    const b = new ModelB();
    let down = 6; // the batch (3 tries) and the first chunk alone (3 tries): the run is interrupted, the other chunks are embedded
    const embed = b.embed.bind(b);
    b.embed = async (texts) => {
      if (down-- > 0) throw new Error('synthetic provider failure');
      return embed(texts);
    };
    const engine = attachEngine(db, config, b);
    const rebuild = engineRebuildEmbeddings(db, engine, { retryDelayMs: () => 0, outageDelayMs: () => 0 });
    await rebuild!.done;
    expect(down).toBeLessThan(0); // it was down, and the rebuild came back
    expect((await everyVectorIs(db, engine.vectorIndex!, new ModelB())).wrong).toEqual([]);
    expect(semanticReady(engine)).toBe(true);
  });

  it('keeps semantic search off while one chunk is refused, says so, goes on trying, and turns it on once the chunk embeds', async () => {
    const poisoned = `${note('Delta', 2)}\n## Poisoned\nthis section is POISONED text\n`;
    const { memoryDir, config } = await workspaceBuiltByA(false, { 'd.md': poisoned });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openDb(config.dbPath);
    dbs.push(db);
    const b = new ModelB();
    b.refuse = (texts) => texts.some((t) => t.includes('POISONED'));
    const engine = attachEngine(db, config, b);
    const chunks = db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number;

    let settled = false;
    const waits: number[] = [];
    const rebuild = engineRebuildEmbeddings(db, engine, { retryDelayMs: () => 0, outageDelayMs: (outage) => { waits.push(outage); return 20; } })!;
    void rebuild.done.then(() => { settled = true; });
    await vi.waitFor(() => expect(error).toHaveBeenCalled()); // interrupted by the refused chunk

    // Every chunk but that one is embedded, yet the index is not whole: search stays off, and the caller is told why.
    expect(chunksWithoutVectors(db)).toBe(1);
    expect(engine.vectorIndex!.rebuilding()).toBe(true);
    expect(semanticReady(engine)).toBe(false);
    const held = await engineSearchMemory(db, engine, memoryDir, 'quokkaberry', 5);
    expect(held).toMatchObject({ ok: false, error: 'semantic-rebuilding', hits: [] });
    expect(held.notice).toContain(`(1 of ${chunks} chunks left)`);
    expect(engineStatus(db, engine, config).embeddingRebuild).toEqual({ chunksLeft: 1, chunks });
    expect(error.mock.calls[0].join(' ')).toMatch(new RegExp(`"event":"embedding_rebuild_interrupted","unembedded":1,"chunks":${chunks},.*"detail":"semantic search stays off".*chunk \\d+ of \\[path\\] could not be embedded`, 's'));
    expect(settled).toBe(false); // it keeps trying: it did not give up, and did not finish
    await vi.waitFor(() => expect(waits.length).toBeGreaterThanOrEqual(3));
    expect(waits.slice(0, 3)).toEqual([0, 1, 2]); // and the wait between attempts grows

    b.refuse = () => false; // the provider takes the chunk now
    await rebuild.done;
    expect(semanticReady(engine)).toBe(true);
    expect(engine.vectorIndex!.rebuilding()).toBe(false);
    expect(chunksWithoutVectors(db)).toBe(0);
    expect((await everyVectorIs(db, engine.vectorIndex!, new ModelB())).wrong).toEqual([]);
    const found = await engineSearchMemory(db, engine, memoryDir, 'quokkaberry', 5);
    expect(found.ok).toBe(true);
  });

  it('can be aborted and resumed by a later call', async () => {
    const { config } = await workspaceBuiltByA(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = openDb(config.dbPath);
    dbs.push(db);
    const b = new ModelB();
    b.hold = 1;
    const engine = attachEngine(db, config, b);
    const first = engineRebuildEmbeddings(db, engine)!;
    first.abort(); // the one request is on its way; no more are made after it
    b.release();
    await first.done;
    expect(engine.vectorIndex!.rebuilding()).toBe(true);
    expect(semanticReady(engine)).toBe(false);
    const second = engineRebuildEmbeddings(db, engine)!;
    expect(second).not.toBe(first);
    await second.done;
    expect(semanticReady(engine)).toBe(true);
    expect((await everyVectorIs(db, engine.vectorIndex!, new ModelB())).wrong).toEqual([]);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the service rebuilds a mixed or unknown index in the background and says so until it is done', () => {
  it('serves keyword search with a notice while the embeddings are rebuilt, and semantic search once they are', async () => {
    const legacy = await workspaceBuiltByA(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = new ModelB();
    b.hold = 1; // the rebuild's first request waits; the saves below do not
    const { service, client } = await start(legacy, b);

    const n = legacy.chunks;
    const status = parse(await client.callTool({ name: 'memory_status', arguments: {} }));
    expect(status.embeddingRebuild).toEqual({ chunks: n, chunksLeft: n });

    const semantic = await client.callTool({ name: 'search_memory', arguments: { query: 'quokkaberry' } });
    expect(parse(semantic)).toMatchObject({ ok: true, fallback: 'keyword' });
    expect(parse(semantic).notice).toContain(`(${n} of ${n} chunks left)`);
    expect(parse(semantic).notice).toMatch(/Keyword search works meanwhile/);

    const context = parse(await client.callTool({ name: 'get_context', arguments: { query: 'quokkaberry' } }));
    expect(context.retrieval).toBe('keyword');
    expect(context.notice).toMatch(/Semantic search is off/);
    expect(context.memories.length).toBeGreaterThan(0); // keyword search still answers

    const keyword = parse(await client.callTool({ name: 'search_text', arguments: { query: 'quokkaberry' } }));
    expect(keyword.results.length).toBeGreaterThan(0);

    // A note saved meanwhile is embedded by the model that now searches, and is whole when the rebuild ends.
    const saved = parse(await client.callTool({ name: 'remember', arguments: { statement: 'A note saved during the rebuild, about narwhals.', source: 'test' } }));
    expect(saved).toMatchObject({ ok: true, mode: 'note', indexed: true });

    b.release();
    await service.embeddingRebuild;
    const after = await everyVectorIs(service.db, service.engine.vectorIndex!, new ModelB());
    expect(after.wrong).toEqual([]);
    expect(after.stored).toBe(after.chunks);
    expect(after.files).toEqual(['a.md', 'b.md', 'c.md']);

    const ready = parse(await client.callTool({ name: 'search_memory', arguments: { query: 'quokkaberry' } }));
    expect(ready.ok).toBe(true);
    expect(ready.hits.length).toBeGreaterThan(0);
    const contextAfter = parse(await client.callTool({ name: 'get_context', arguments: { query: 'quokkaberry' } }));
    expect(contextAfter.retrieval).toBe('hybrid');
    expect(contextAfter.notice).toBeUndefined();
    expect(parse(await client.callTool({ name: 'memory_status', arguments: {} })).embeddingRebuild).toBeUndefined();
    const narwhals = parse(await client.callTool({ name: 'search_memory', arguments: { query: 'narwhals' } }));
    expect(narwhals.hits.some((h: { text: string }) => h.text.includes('narwhals'))).toBe(true);
  });

  it('stops cleanly when the service closes during a rebuild, and the next start finishes it without embedding anything again', async () => {
    const legacy = await workspaceBuiltByA(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = new ModelB();
    b.hold = 1;
    const first = await startMvpService(legacy.config, b);
    expect(first.engine.vectorIndex!.rebuilding()).toBe(true);
    first.httpServer.closeAllConnections?.();
    first.httpServer.close();
    const closing = first.close(); // waits for the request that is on its way, makes no further one
    b.release();
    await closing;
    expect(b.texts.length).toBe(legacy.chunks); // the one request embedded every chunk

    const db = openDb(legacy.config.dbPath);
    dbs.push(db);
    const vectors = new VectorIndex(db, 256);
    expect(vectors.rebuilding()).toBe(true); // closed before it could mark the index whole
    expect(vectors.space()).toBe(embeddingSpace(b));
    db.close();
    dbs.pop();

    const b2 = new ModelB();
    const second = await startMvpService(mcpConfig(legacy.memoryDir, await freePort()), b2);
    services.push(second);
    await second.embeddingRebuild;
    expect(b2.texts).toEqual([]); // every chunk already had its vector: the rebuild only marked the index whole
    expect(second.engine.vectorIndex!.rebuilding()).toBe(false);
    expect(semanticReady(second.engine)).toBe(true);
    expect((await everyVectorIs(second.db, second.engine.vectorIndex!, new ModelB())).wrong).toEqual([]);
  });

  it('leaves an index that is whole in the configured model alone, and holds nothing back', async () => {
    const legacy = await workspaceBuiltByA(true);
    const before = (() => {
      const db = openDb(legacy.config.dbPath);
      const ids = (db.prepare('SELECT rowid FROM chunk_embeddings_rowids ORDER BY rowid').pluck().all() as number[]).join(',');
      const vector = new VectorIndex(db, 256).get(1);
      db.close();
      return { ids, vector };
    })();
    const a = new ModelA();
    const { service, client } = await start(legacy, a);
    await service.embeddingRebuild;
    expect(a.texts).toEqual([]);
    expect(semanticReady(service.engine)).toBe(true);
    expect(engineStatus(service.db, service.engine, legacy.config)).not.toHaveProperty('embeddingRebuild');
    const ids = (service.db.prepare('SELECT rowid FROM chunk_embeddings_rowids ORDER BY rowid').pluck().all() as number[]).join(',');
    expect({ ids, vector: service.engine.vectorIndex!.get(1) }).toEqual(before);
    const result = parse(await client.callTool({ name: 'search_memory', arguments: { query: 'quokkaberry' } }));
    expect(result.ok).toBe(true);
  });

  it('never holds back a provider that declares no identity: it claims no space, so there is nothing to rebuild', async () => {
    const legacy = await workspaceBuiltByA(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const texts: string[] = [];
    const unnamed = {
      dimensions: 256,
      embed: async (batch: string[]) => { texts.push(...batch); return new EvalHashEmbeddingProvider().embed(batch); },
    };
    const service = await startMvpService(legacy.config, unnamed as unknown as EvalHashEmbeddingProvider);
    services.push(service);
    await service.embeddingRebuild;
    expect(texts).toEqual([]);
    expect(semanticReady(service.engine)).toBe(true);
    expect(service.engine.vectorIndex!.space()).toBeNull();
  });
});
