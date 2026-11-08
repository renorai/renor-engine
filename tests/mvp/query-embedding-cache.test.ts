import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from '../../src/db/sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { createEmbeddingProvider, queryEmbeddingCachePath, QUERY_CACHE_MAX_ENTRIES } from '../../src/mvp/engine';
import { CachingEmbeddingProvider } from '../../src/embeddings/caching';
import { CallPhases } from '../../src/callPhases';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * The hosted read path embeds a query once. Driven through the real Vertex provider with `fetch` replaced by a
 * counting fake, so nothing leaves the process: no Google endpoint, no credential, no model. The key file is a
 * throwaway key generated here.
 */

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_HISTORY_DIR',
  'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_VERTEX_KEY_FILE', 'MVP_VERTEX_PROJECT',
  'MVP_VERTEX_LOCATION', 'MVP_EMBEDDING_MODEL', 'EMBEDDING_MODEL', 'MVP_EMBEDDING_DIMS', 'EMBEDDING_DIMS',
  'GOOGLE_APPLICATION_CREDENTIALS', 'RENOR_EVAL_VERTEX_KEY_FILE', 'RENOR_EVAL_VERTEX_PROJECT', 'RENOR_EVAL_MODEL',
  'RENOR_EVAL_EMBEDDING_DIMS', 'RENOR_SEARCH_EVIDENCE', 'MVP_DB_PATH',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  while (cleanups.length) await cleanups.pop()!();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

interface FakeVertex {
  /** Predict requests, by the task type they asked for. */
  predicts: { query: number; document: number };
  /** Every URL fetch was called with: all of them must be the fake endpoints below. */
  urls: string[];
  /** Locations besides europe-west4 the fake endpoint answers for. */
  regions: string[];
}

/** Replaces `fetch`: a token endpoint and a predict endpoint, both in this process. Any other URL fails the test. */
function fakeVertex(): FakeVertex {
  const seen: FakeVertex = { predicts: { query: 0, document: 0 }, urls: [], regions: [] };
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    seen.urls.push(String(url));
    if (String(url) === 'https://oauth.fake.test/token') {
      return new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }), { status: 200 });
    }
    const region = /^https:\/\/([a-z0-9-]+)-aiplatform\.googleapis\.com\/.*:predict$/.exec(String(url))?.[1];
    if (region && ['europe-west4', ...seen.regions].includes(region) && process.env.FAKE_VERTEX_OK === '1') {
      const body = JSON.parse(init.body) as { instances: Array<{ content: string; task_type: string }>; parameters: { outputDimensionality: number } };
      const dims = body.parameters.outputDimensionality;
      const predictions = body.instances.map(instance => {
        if (instance.task_type === 'RETRIEVAL_QUERY') seen.predicts.query += 1; else seen.predicts.document += 1;
        let seed = 0;
        for (const ch of instance.content) seed = (seed * 31 + ch.charCodeAt(0)) % 10007;
        return { embeddings: { values: Array.from({ length: dims }, (_, i) => Math.sin(seed + i) / 3), statistics: { token_count: 3 } } };
      });
      return new Response(JSON.stringify({ predictions }), { status: 200 });
    }
    throw new Error(`the test reached an unexpected URL: ${url}`);
  });
  process.env.FAKE_VERTEX_OK = '1';
  cleanups.push(() => { delete process.env.FAKE_VERTEX_OK; });
  return seen;
}

function workspace(options: { dims?: number; model?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-embed-cache-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryDir = path.join(root, 'memory');
  const authRoot = path.join(root, 'auth');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = path.join(authRoot, 'fake-sa.json');
  fs.writeFileSync(keyFile, JSON.stringify({
    client_email: 'fake@fake.test',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth.fake.test/token',
  }));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    MVP_EMBEDDING_PROVIDER: 'vertex',
    MVP_VERTEX_KEY_FILE: keyFile,
    MVP_VERTEX_PROJECT: 'fake-project',
    MVP_VERTEX_LOCATION: 'europe-west4',
    RENOR_SEARCH_EVIDENCE: '0',
    ...(options.dims ? { MVP_EMBEDDING_DIMS: String(options.dims) } : {}),
    ...(options.model ? { MVP_EMBEDDING_MODEL: options.model } : {}),
  });
  const config = loadMvpConfig();
  return { root, memoryDir, authRoot, config };
}

const rowCount = (file: string) => {
  const db = new Database(file, { readonly: true });
  try { return db.prepare('SELECT COUNT(*) AS n FROM embeddings').pluck().get() as number; } finally { db.close(); }
};

describe('createEmbeddingProvider: the Vertex query cache', () => {
  it('a repeated query makes one Vertex request, not two, and returns the identical vector', async () => {
    const fake = fakeVertex();
    const { config } = workspace();
    const provider = createEmbeddingProvider(config)!;
    cleanups.push(() => (provider as CachingEmbeddingProvider).close());
    const first = await provider.embedQuery!('what did I decide about the migration');
    const second = await provider.embedQuery!('what did I decide about the migration');
    expect(fake.predicts.query).toBe(1);
    expect(second).toEqual(first);
    expect(first).toHaveLength(768);
    expect(fake.urls.every(u => u === 'https://oauth.fake.test/token' || /^https:\/\/[a-z0-9-]+-aiplatform\.googleapis\.com\//.test(u))).toBe(true);
  });

  it('notes on each call whether its query vector came from the cache, for the Server-Timing query_cache entry', async () => {
    fakeVertex();
    const { config } = workspace();
    const provider = createEmbeddingProvider(config)!;
    cleanups.push(() => (provider as CachingEmbeddingProvider).close());
    const asked = new CallPhases();
    await asked.run(() => provider.embedQuery!('a query the cache has not seen'));
    expect(asked.queryCacheStatus()).toBe('miss');
    const repeated = new CallPhases();
    await repeated.run(() => provider.embedQuery!('a query the cache has not seen'));
    expect(repeated.queryCacheStatus()).toBe('hit');
  });

  it('keeps the cache in the workspace\'s own private state directory, one file per workspace', async () => {
    fakeVertex();
    const a = workspace();
    const b = workspace();
    const pa = createEmbeddingProvider(a.config)!;
    const pb = createEmbeddingProvider(b.config)!;
    cleanups.push(() => { (pa as CachingEmbeddingProvider).close(); (pb as CachingEmbeddingProvider).close(); });
    await pa.embedQuery!('only in a');
    expect(queryEmbeddingCachePath(a.config)).toBe(path.join(a.authRoot, 'query-embeddings.db'));
    expect(fs.existsSync(queryEmbeddingCachePath(a.config))).toBe(true);
    expect(queryEmbeddingCachePath(a.config)).not.toBe(queryEmbeddingCachePath(b.config));
    expect(rowCount(queryEmbeddingCachePath(a.config))).toBe(1);
    expect(rowCount(queryEmbeddingCachePath(b.config))).toBe(0);
    expect(queryEmbeddingCachePath(a.config).startsWith(a.memoryDir + path.sep)).toBe(false);
  });

  it('misses after a model change and after a dimension change on the same workspace', async () => {
    const fake = fakeVertex();
    const base = workspace();
    const open = async () => {
      const provider = createEmbeddingProvider(loadMvpConfig())!;
      cleanups.push(() => (provider as CachingEmbeddingProvider).close());
      return provider;
    };
    await (await open()).embedQuery!('same words');
    await (await open()).embedQuery!('same words');
    expect(fake.predicts.query).toBe(1); // a restart of the same configuration hits
    process.env.MVP_EMBEDDING_MODEL = 'gemini-embedding-002';
    const other = await (await open()).embedQuery!('same words');
    expect(fake.predicts.query).toBe(2);
    process.env.MVP_EMBEDDING_MODEL = 'gemini-embedding-001';
    process.env.MVP_EMBEDDING_DIMS = '1536';
    const wide = await (await open()).embedQuery!('same words');
    expect(fake.predicts.query).toBe(3);
    expect(wide).toHaveLength(1536);
    expect(other).toHaveLength(768);
    expect(base.config.embeddingDims).toBe(768);
  });

  it('misses after a project change or a location change, and still hits on the same configuration', async () => {
    const fake = fakeVertex();
    workspace();
    const ask = async () => {
      const provider = createEmbeddingProvider(loadMvpConfig())!;
      cleanups.push(() => (provider as CachingEmbeddingProvider).close());
      return provider.embedQuery!('same words');
    };
    await ask();
    await ask();
    expect(fake.predicts.query).toBe(1); // the same configuration hits
    process.env.MVP_VERTEX_PROJECT = 'other-project';
    await ask();
    expect(fake.predicts.query).toBe(2); // another project misses
    await ask();
    expect(fake.predicts.query).toBe(2); // and is then served from its own entry
    process.env.MVP_VERTEX_PROJECT = 'fake-project';
    process.env.MVP_VERTEX_LOCATION = 'asia-northeast1';
    fake.regions.push('asia-northeast1');
    await ask();
    expect(fake.predicts.query).toBe(3); // another location misses
    process.env.MVP_VERTEX_LOCATION = 'europe-west4';
    process.env.MVP_VERTEX_LOCATION = 'europe-west4';
    await ask();
    expect(fake.predicts.query).toBe(3); // the original configuration still has its entry
  });

  it('does not cache document embeddings (ingest is unchanged)', async () => {
    const fake = fakeVertex();
    const { config } = workspace();
    const provider = createEmbeddingProvider(config)!;
    cleanups.push(() => (provider as CachingEmbeddingProvider).close());
    await provider.embed(['a note']);
    await provider.embed(['a note']);
    expect(fake.predicts.document).toBe(2);
    expect(rowCount(queryEmbeddingCachePath(config))).toBe(0);
  });

  it('is bounded by default: the file never holds more than its limits', async () => {
    fakeVertex();
    const { config } = workspace();
    const file = queryEmbeddingCachePath(config);
    (createEmbeddingProvider(config) as CachingEmbeddingProvider).close(); // creates the file
    // Fill it to its entry limit in one transaction (not through 4096 fake requests), as a long-running workspace would have.
    const db = new Database(file);
    const stored = db.prepare('INSERT INTO embeddings (key, dims, vec, namespace, created_at) VALUES (?, 768, zeroblob(3072), ?, ?)');
    db.transaction(() => { for (let i = 0; i < QUERY_CACHE_MAX_ENTRIES; i++) stored.run(`filler-${i}`, 'vertex/gemini-embedding-001/768', 'x'); })();
    db.close();
    const provider = createEmbeddingProvider(config)!;
    cleanups.push(() => (provider as CachingEmbeddingProvider).close());
    await provider.embedQuery!('one more');
    await provider.embedQuery!('and another');
    expect(rowCount(file)).toBe(QUERY_CACHE_MAX_ENTRIES); // two new rows in, the two oldest fillers out
  });
});

describe('createEmbeddingProvider: a cache fault never fails a read', () => {
  it('recovers from a corrupt cache file by starting it again', async () => {
    const fake = fakeVertex();
    const { config } = workspace();
    fs.writeFileSync(queryEmbeddingCachePath(config), 'this is not a sqlite database'.repeat(100));
    const provider = createEmbeddingProvider(config)!;
    cleanups.push(() => (provider as CachingEmbeddingProvider).close());
    await provider.embedQuery!('after corruption');
    await provider.embedQuery!('after corruption');
    expect(fake.predicts.query).toBe(1);
  });

  it('falls back to the bare provider when the cache file cannot be created', async () => {
    const fake = fakeVertex();
    const { config } = workspace();
    // A directory sits where the file should be, and has content, so it can be neither opened nor replaced.
    const blocker = queryEmbeddingCachePath(config);
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'x'), 'x');
    const provider = createEmbeddingProvider(config)!;
    expect(provider).not.toBeInstanceOf(CachingEmbeddingProvider);
    expect(await provider.embedQuery!('still works')).toHaveLength(768);
    expect(fake.predicts.query).toBe(1);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the cache is invisible to export, import and memory_status', () => {
  async function connect(config: MvpConfig) {
    const app = createMvpApp(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'query-embed-cache', version: '0.1.0' });
    await app.server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => { await client.close(); await app.close(); });
    return async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ text: string }>).map(c => c.text).join('\n');
      expect(res.isError, `${name}: ${text}`).not.toBe(true);
      return text;
    };
  }

  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

  it('keeps the file out of the memory tree and out of what the three surfaces return', async () => {
    const fake = fakeVertex();
    const { config, memoryDir } = workspace();
    const call = await connect(config);
    await call('remember', { statement: 'The mango juice stand closes at six.' });
    const file = queryEmbeddingCachePath(config);

    const status1 = await call('memory_status');
    await call('search_memory', { query: 'when does the juice stand close' });
    await call('search_memory', { query: 'when does the juice stand close' });
    expect(fake.predicts.query).toBe(1); // through the real read tool, the repeat made no second request
    expect(fs.existsSync(file)).toBe(true);
    expect(rowCount(file)).toBe(1);

    const exported = await call('export_memory');
    const status2 = await call('memory_status');
    const preview = await call('preview_import', { label: 'trial', files: [{ relativePath: 'Notes/a.md', markdown: '# A\n\nhello' }] });
    const batchId = JSON.parse(preview).batchId as string;
    const applied = await call('apply_import', { batchId });
    const surfaces = [exported, status1, status2, preview, applied].join('\n');
    expect(surfaces).not.toMatch(/query-embeddings/);
    expect(walk(memoryDir).some(f => f.includes(`${path.sep}Imported${path.sep}trial${path.sep}`))).toBe(true); // the import really wrote
    expect(walk(memoryDir).filter(f => /query-embeddings/.test(f))).toEqual([]);
    expect(Object.keys(JSON.parse(status2)).sort()).toEqual(Object.keys(JSON.parse(status1)).sort());
  });
});
