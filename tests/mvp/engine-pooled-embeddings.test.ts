import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { attachEngine, createEmbeddingProvider } from '../../src/mvp/engine';
import type { MvpConfig } from '../../src/mvp/config';
import { startVertexStub } from '../helpers/vertexStub';
import { CallPhases } from '../../src/callPhases';
import { removeTestDir } from '../helpers/removeDb';

/**
 * Which callers get a pooled connection to the embedding service: the service (attachEngine, with no provider of its own) does,
 * and a bench or a command that builds the stack with createEmbeddingProvider does not, because it makes its requests back to
 * back and gains nothing from a pool that would outlive it. poolFetch is replaced by a recorder that answers the token and predict requests
 * itself, so nothing leaves the machine and what is seen is which request function the provider was given and that it is the
 * one used.
 */

const seen = vi.hoisted(() => ({ made: [] as unknown[], requests: [] as string[] }));

vi.mock('../../src/net/poolFetch', () => ({
  DEFAULT_POOL_IDLE_MS: 180_000,
  poolFetch: (options?: unknown) => {
    seen.made.push(options);
    return async (input: unknown) => {
      const url = String(input);
      seen.requests.push(url);
      const body = url.endsWith('/token')
        ? { access_token: 'not-a-token', expires_in: 3600 }
        : { predictions: [{ embeddings: { values: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)), statistics: { token_count: 3 } } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  },
}));

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  seen.made.length = 0;
  seen.requests.length = 0;
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function vertexConfig(): Promise<MvpConfig> {
  const stub = await startVertexStub();
  cleanup.push(() => stub.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pooled-'));
  cleanup.push(() => removeTestDir(dir));
  return {
    embeddingProvider: 'vertex', embeddingModel: 'gemini-embedding-001', embeddingDims: 768,
    vertexKeyFile: stub.keyFile, vertexProject: 'stub-project', vertexLocation: 'europe-west4',
    authStatePath: path.join(dir, 'clients.json'),
  } as MvpConfig;
}

describe('the service\'s embedding stack', () => {
  it('gives the service a pooled request that retries a reset and reports the connections it opens, and sends every request of the provider through it', async () => {
    const config = await vertexConfig();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pooled-db-'));
    const db: Database.Database = openDb(path.join(dir, 'index.db'));
    cleanup.push(() => { db.close(); removeTestDir(dir); });
    runMigrations(db);
    const realFetch = vi.spyOn(globalThis, 'fetch');

    const engine = attachEngine(db, config);
    // The query-embedding cache it opens beside config.authStatePath is its owner's to close (the server does on shutdown).
    cleanup.push(() => (engine.provider as { close?: () => void } | null)?.close?.());

    expect(seen.made).toEqual([{ retryOnReset: true, onConnect: expect.any(Function) }]);
    // A connection the pool opens is told to the call that is being recorded, as its `connect` phase.
    const phases = new CallPhases();
    phases.run(() => (seen.made[0] as { onConnect: (ms: number) => void }).onConnect(12.5));
    expect(phases.report()).toEqual({ connect: 12.5 });
    expect(await engine.provider!.embedQuery!('a question')).toHaveLength(768);
    expect(seen.requests.some(url => url.endsWith('/token'))).toBe(true);
    expect(seen.requests.some(url => url.includes('europe-west4-aiplatform.googleapis.com') && url.endsWith(':predict'))).toBe(true);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it('leaves a stack built for one run on the plain fetch', async () => {
    const config = await vertexConfig();
    const realFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('stopped before it left the machine'));

    const provider = createEmbeddingProvider(config);
    cleanup.push(() => (provider as { close?: () => void } | null)?.close?.());

    expect(seen.made).toEqual([]);
    await expect(provider!.embedQuery!('a question')).rejects.toThrow();
    expect(realFetch).toHaveBeenCalled();
    expect(seen.requests).toEqual([]);
  });
});
