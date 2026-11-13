import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../src/db/sqlite';
import { CachingEmbeddingProvider } from '../../src/embeddings/caching';
import type { EmbeddingIdentity, EmbeddingProvider } from '../../src/embeddings/types';
import { removeTempDirsAfterAll } from '../helpers/tmpCleanup';

removeTempDirsAfterAll();

/**
 * The bounded, serving-mode query cache. Synthetic fake providers only: nothing here reaches an embedding
 * service or a model.
 */

function tmpCache(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'renor-query-cache-')), 'q.db');
}

/** Counts its calls. Its numbers are doubles that a float32 cannot hold, as a real provider's JSON numbers are. */
function counting(dimensions = 8, identity: EmbeddingIdentity = { kind: 'vertex', model: 'test-model' }) {
  const provider = {
    dimensions,
    identity,
    queryCalls: 0,
    docCalls: 0,
    async embed(texts: string[]): Promise<number[][]> {
      provider.docCalls += 1;
      return texts.map(t => vector(t, dimensions));
    },
    async embedQuery(text: string): Promise<number[]> {
      provider.queryCalls += 1;
      return vector(text, dimensions);
    },
  };
  return provider;
}

function vector(text: string, dimensions: number): number[] {
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) % 10007;
  return Array.from({ length: dimensions }, (_, i) => Math.sin(seed + i) / 3);
}

const rows = (file: string) => {
  const db = new Database(file, { readonly: true });
  try { return db.prepare('SELECT COUNT(*) AS n FROM embeddings').pluck().get() as number; } finally { db.close(); }
};

const serving = (inner: EmbeddingProvider, cachePath: string, extra: Record<string, unknown> = {}) =>
  new CachingEmbeddingProvider(inner, { cachePath, serving: true, ...extra });

describe('query cache: a repeated query costs no provider call', () => {
  it('makes one provider call for N repeats and returns exactly the first vector every time', async () => {
    const inner = counting();
    const cache = serving(inner, tmpCache());
    const first = await cache.embedQuery('where do I keep the spare key');
    expect(first).toEqual(vector('where do I keep the spare key', 8)); // the provider's own numbers, not rounded
    for (let i = 0; i < 5; i++) expect(await cache.embedQuery('where do I keep the spare key')).toEqual(first);
    expect(inner.queryCalls).toBe(1);
    expect(cache.stats).toEqual({ hits: 5, misses: 1 });
    cache.close();
  });

  it('also serves the repeat after a restart of the process (a new instance on the same file)', async () => {
    const file = tmpCache();
    const inner = counting();
    const a = serving(inner, file);
    const first = await a.embedQuery('restart me');
    a.close();
    const b = serving(inner, file);
    expect(await b.embedQuery('restart me')).toEqual(first);
    expect(inner.queryCalls).toBe(1);
    b.close();
  });

  it('does not cache documents on the serving path: embed() reaches the provider every time and writes nothing', async () => {
    const inner = counting();
    const file = tmpCache();
    const cache = serving(inner, file);
    await cache.embed(['a note']);
    await cache.embed(['a note']);
    expect(inner.docCalls).toBe(2);
    expect(rows(file)).toBe(0);
    cache.close();
  });

  it('keeps today\'s behaviour when no option is passed: unbounded, documents cached, float32 storage', async () => {
    const inner = counting();
    const file = tmpCache();
    const cache = new CachingEmbeddingProvider(inner, { cachePath: file });
    await cache.embed(['a note']);
    await cache.embed(['a note']);
    expect(inner.docCalls).toBe(1);
    for (let i = 0; i < 40; i++) await cache.embedQuery(`q${i}`);
    expect(rows(file)).toBe(41);
    expect(await cache.embedQuery('fresh')).toEqual(vector('fresh', 8)); // a miss still returns the provider's own numbers
    const db = new Database(file, { readonly: true });
    expect(db.prepare('SELECT LENGTH(vec) FROM embeddings LIMIT 1').pluck().get()).toBe(32); // float32, as the benchmark cache has always stored
    db.close();
    cache.close();
  });
});

describe('query cache: identity and dimensions', () => {
  it('misses for a different provider identity or model, then serves each from its own entry', async () => {
    const file = tmpCache();
    const a = counting(8, { kind: 'vertex', model: 'model-a' });
    const b = counting(8, { kind: 'vertex', model: 'model-b' });
    const c = counting(8, { kind: 'openai', model: 'model-a' });
    for (const inner of [a, b, c]) {
      const cache = serving(inner, file);
      await cache.embedQuery('same words');
      await cache.embedQuery('same words');
      cache.close();
      expect(inner.queryCalls).toBe(1); // missed on first sight even though the file holds the same text under another identity
    }
    expect(rows(file)).toBe(3);
  });

  it('misses for a different dimension and never serves a vector of the wrong length', async () => {
    const file = tmpCache();
    const small = counting(8);
    const big = counting(16);
    const s = serving(small, file);
    await s.embedQuery('same words');
    s.close();
    const b = serving(big, file);
    const got = await b.embedQuery('same words');
    expect(big.queryCalls).toBe(1);
    expect(got).toHaveLength(16);
    expect(await b.embedQuery('same words')).toEqual(got);
    expect(big.queryCalls).toBe(1);
    b.close();
  });
});

describe('query cache: scope', () => {
  it('misses under another scope, hits under the same one, and leaves the namespace alone when none is given', async () => {
    const file = tmpCache();
    const inner = counting();
    for (const scope of ['p-aaa', 'p-bbb', 'p-aaa']) {
      const cache = serving(inner, file, { scope });
      await cache.embedQuery('same words');
      cache.close();
    }
    expect(inner.queryCalls).toBe(2); // aaa, bbb: the second aaa hit
    const db = new Database(file, { readonly: true });
    const namespaces = db.prepare('SELECT DISTINCT namespace FROM embeddings ORDER BY namespace').pluck().all();
    db.close();
    expect(namespaces).toEqual(['vertex/test-model/8/p-aaa', 'vertex/test-model/8/p-bbb']);
    const plain = tmpCache();
    new CachingEmbeddingProvider(inner, { cachePath: plain }).close();
    await new CachingEmbeddingProvider(inner, { cachePath: plain }).embedQuery('x');
    const db2 = new Database(plain, { readonly: true });
    expect(db2.prepare('SELECT namespace FROM embeddings').pluck().get()).toBe('vertex/test-model/8');
    db2.close();
  });

  it('rejects a scope that is not a short plain token', () => {
    expect(() => serving(counting(), tmpCache(), { scope: 'a b' })).toThrow(/scope/);
  });
});

describe('query cache: bounded', () => {
  it('holds at most maxEntries rows and evicts the oldest-inserted first, deterministically', async () => {
    const survivors = async () => {
      const file = tmpCache();
      const inner = counting();
      const cache = serving(inner, file, { maxEntries: 5 });
      for (let i = 0; i < 12; i++) {
        await cache.embedQuery(`query ${i}`);
        expect(rows(file)).toBeLessThanOrEqual(5);
      }
      expect(rows(file)).toBe(5);
      inner.queryCalls = 0;
      for (let i = 7; i < 12; i++) await cache.embedQuery(`query ${i}`); // the five newest are all still held
      expect(inner.queryCalls).toBe(0);
      await cache.embedQuery('query 0'); // the oldest is gone
      expect(inner.queryCalls).toBe(1);
      cache.close();
      const db = new Database(file, { readonly: true });
      try { return (db.prepare('SELECT key FROM embeddings ORDER BY rowid').pluck().all() as string[]); } finally { db.close(); }
    };
    // The same sequence leaves the same rows, in the same order, in a second file.
    expect(await survivors()).toEqual(await survivors());
  });

  it('holds at most maxBytes of vectors', async () => {
    const file = tmpCache();
    const inner = counting(8); // 64 bytes a vector (float64)
    const cache = serving(inner, file, { maxBytes: 200 }); // three vectors
    for (let i = 0; i < 20; i++) await cache.embedQuery(`query ${i}`);
    const db = new Database(file, { readonly: true });
    const held = db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(vec)) AS bytes FROM embeddings').get() as { n: number; bytes: number };
    db.close();
    expect(held).toEqual({ n: 3, bytes: 192 });
    cache.close();
  });

  it('trims an existing file down to the bound when it is opened with one', async () => {
    const file = tmpCache();
    const inner = counting();
    const open = new CachingEmbeddingProvider(inner, { cachePath: file });
    for (let i = 0; i < 20; i++) await open.embedQuery(`query ${i}`);
    open.close();
    expect(rows(file)).toBe(20);
    serving(inner, file, { maxEntries: 4 }).close();
    expect(rows(file)).toBe(4);
  });

  it('rejects a bound that is not a positive integer', () => {
    expect(() => serving(counting(), tmpCache(), { maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => serving(counting(), tmpCache(), { maxBytes: 1.5 })).toThrow(/maxBytes/);
  });
});

describe('query cache: no clear text', () => {
  it('writes a hash and a vector, never the query', async () => {
    const file = tmpCache();
    const cache = serving(counting(), file);
    const secret = 'my-passport-number-is-ZX81-9921-private';
    await cache.embedQuery(secret);
    // Before close, so the write-ahead log is read as well.
    for (const suffix of ['', '-wal']) {
      const f = file + suffix;
      if (fs.existsSync(f)) expect(fs.readFileSync(f).includes(Buffer.from(secret))).toBe(false);
      if (fs.existsSync(f)) expect(fs.readFileSync(f).includes(Buffer.from('passport'))).toBe(false);
    }
    cache.close();
    const db = new Database(file, { readonly: true });
    const columns = (db.prepare('PRAGMA table_info(embeddings)').all() as Array<{ name: string }>).map(c => c.name);
    const key = db.prepare('SELECT key FROM embeddings').pluck().get() as string;
    db.close();
    expect(columns.sort()).toEqual(['created_at', 'dims', 'key', 'namespace', 'vec']);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(file).includes(Buffer.from(secret))).toBe(false);
  });
});

describe('query cache: a fault falls through to the provider', () => {
  it('serves from the provider, unchanged, when the cache fails mid-flight, and stops trying', async () => {
    const inner = counting();
    const cache = serving(inner, tmpCache());
    const before = await cache.embedQuery('before the fault');
    (cache as unknown as { db: Database.Database }).db.close(); // the file becomes unusable
    expect(await cache.embedQuery('before the fault')).toEqual(before); // a miss that reaches the provider
    expect(await cache.embedQuery('after the fault')).toHaveLength(8);
    expect(inner.queryCalls).toBe(3);
    expect(() => cache.close()).not.toThrow();
  });

  it('falls through when a write fails, and a read still hits', async () => {
    const file = tmpCache();
    const inner = counting();
    const seed = serving(inner, file);
    await seed.embedQuery('seeded');
    seed.close();
    const cache = serving(inner, file);
    (cache as unknown as { insert: { run: () => never } }).insert = { run: () => { throw new Error('attempt to write a readonly database'); } } as never;
    expect(await cache.embedQuery('seeded')).toHaveLength(8); // a read still hits
    expect(await cache.embedQuery('new text')).toHaveLength(8); // the write fails, the answer does not
    cache.close();
  });
});

/** The paths this process holds open (Linux: /proc/self/fd); null where there is no /proc to ask. */
function openPaths(): string[] | null {
  if (!fs.existsSync('/proc/self/fd')) return null;
  return fs.readdirSync('/proc/self/fd').flatMap(fd => { try { return [fs.readlinkSync(`/proc/self/fd/${fd}`)]; } catch { return []; } });
}

describe('a cache file the cache cannot use (#1563)', () => {
  it.skipIf(openPaths() === null)('is closed when the constructor fails, so the caller can remove it (Windows refuses an open file: EBUSY)', () => {
    const cachePath = tmpCache();
    // A database, but its `embeddings` table is not the cache's: the open succeeds and the first statement fails.
    const other = new Database(cachePath);
    other.exec('CREATE TABLE embeddings (unrelated TEXT)');
    other.close();
    expect(() => new CachingEmbeddingProvider(counting(), { cachePath, serving: true })).toThrow();
    const real = fs.realpathSync(cachePath);
    expect(openPaths()!.filter(p => p.startsWith(real))).toEqual([]);
  });
});
