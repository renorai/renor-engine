import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CachingEmbeddingProvider, resolveEmbeddingCachePath } from '../../src/embeddings/caching';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { removeTempDirsAfterAll } from '../helpers/tmpCleanup';

removeTempDirsAfterAll();

function tmpPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'renor-cache-test-')), name);
}

function fakeProvider(
  dimensions = 4,
  seed = 0,
  identity = { kind: 'vertex', model: 'test-model' },
): EmbeddingProvider & { calls: number; queryCalls: number } {
  let counter = 0;
  return {
    dimensions,
    identity,
    calls: 0,
    queryCalls: 0,
    async embed(texts: string[]): Promise<number[][]> {
      this.calls += 1;
      return texts.map(text => Array.from({ length: dimensions }, (_, i) => (text.length + counter++ + i + seed) % 97));
    },
    async embedQuery(text: string): Promise<number[]> {
      this.queryCalls += 1;
      return Array.from({ length: dimensions }, (_, i) => (text.length + i + seed) % 89);
    },
  };
}

describe('CachingEmbeddingProvider', () => {
  it('caches document and query embeddings separately; identical inputs never re-call the provider', async () => {
    const inner = fakeProvider();
    const cachePath = tmpPath('cache.db');
    const cached = new CachingEmbeddingProvider(inner, { cachePath });

    const a1 = await cached.embed(['hello', 'world']);
    const a2 = await cached.embed(['hello', 'world']);
    expect(inner.calls).toBe(1); // second embed fully served from cache
    expect(a1).toEqual(a2);

    const q1 = await cached.embedQuery('hello');
    await cached.embedQuery('hello');
    expect(inner.queryCalls).toBe(1);
    expect(q1).toHaveLength(4);
    // documents and queries are different tasks: a cached query does not serve a document
    const docs = await cached.embed(['fresh-document-text']);
    expect(inner.calls).toBe(2);
    expect(docs[0]).not.toEqual(q1);
    expect(cached.stats).toEqual({ hits: 3, misses: 4 });
    cached.close();
  });

  it('embeds duplicate cache misses only once within a batch', async () => {
    const inner = fakeProvider();
    const seenBatches: string[][] = [];
    const originalEmbed = inner.embed.bind(inner);
    inner.embed = async (texts: string[]) => {
      seenBatches.push([...texts]);
      return originalEmbed(texts);
    };
    const cached = new CachingEmbeddingProvider(inner, { cachePath: tmpPath('duplicates.db') });

    const vectors = await cached.embed(['repeat', 'unique', 'repeat', 'repeat']);

    expect(seenBatches).toEqual([['repeat', 'unique']]);
    expect(vectors[0]).toEqual(vectors[2]);
    expect(vectors[0]).toEqual(vectors[3]);
    expect(cached.stats).toEqual({ hits: 0, misses: 4 });
    cached.close();
  });

  it('never shares entries across models even with identical dimensions', async () => {
    const innerA = fakeProvider(4, 0, { kind: 'vertex', model: 'model-a' });
    const innerB = fakeProvider(4, 50, { kind: 'vertex', model: 'model-b' });
    const cachePath = tmpPath('shared.db');
    const a = new CachingEmbeddingProvider(innerA, { cachePath });
    const b = new CachingEmbeddingProvider(innerB, { cachePath });
    const va = await a.embed(['same text']);
    const vb = await b.embed(['same text']);
    expect(innerA.calls).toBe(1);
    expect(innerB.calls).toBe(1); // model-b is a different namespace: must miss
    expect(va).not.toEqual(vb);
    a.close();
    b.close();
  });

  it('preserves vector values exactly and rejects wrong-dimensionality writes', async () => {
    const inner = fakeProvider(4, 0, { kind: 'local', model: 'model' });
    const cachePath = tmpPath('exact.db');
    const cached = new CachingEmbeddingProvider(inner, { cachePath });
    const first = await cached.embed(['precision matters']);
    const second = await cached.embed(['precision matters']);
    expect(second).toEqual(first); // bit-exact Float32 roundtrip
    expect(() => cached['write']('x', 'RETRIEVAL_DOCUMENT', [1, 2, 3])).toThrow(/dimensionality/i);
    cached.close();
  });

  it('resolves the cache path from the environment and can be disabled', () => {
    expect(resolveEmbeddingCachePath({ RENOR_EVAL_EMBED_CACHE: 'off' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveEmbeddingCachePath({} as NodeJS.ProcessEnv)).toMatch(/embed-cache\.db$/);
    expect(resolveEmbeddingCachePath({ RENOR_EVAL_EMBED_CACHE: '/tmp/custom.db' } as NodeJS.ProcessEnv)).toBe('/tmp/custom.db');
  });
});