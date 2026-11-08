import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { indexVault } from '../../src/indexer/pipeline';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { tmpPath } from '../helpers/tmpPath';
import { removeDb } from '../helpers/removeDb';

const DB = tmpPath('test-pipeline-error.db');
const VAULT = path.resolve('fixtures/vault');

const openDbs: Array<ReturnType<typeof openDb>> = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  removeDb(DB);
});

describe('indexVault error handling', () => {
  it('continues indexing and counts errors when embedding throws for one file', async () => {
    const db = openDb(DB);
    openDbs.push(db);
    runMigrations(db);

    let calls = 0;
    // The mock embedding provider throws on the first embed() call, passes on the rest
    const mockProvider = {
      dimensions: 4,
      embed: async (texts: string[]) => {
        if (calls++ === 0) throw new Error('simulated embed failure');
        return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
      },
    };
    const mockIndex = { upsert: () => {}, delete: () => {} };

    const stats = await indexVault(
      db,
      VAULT,
      { embeddingProvider: mockProvider, vectorIndex: mockIndex },
    );

    expect(stats.errors).toBe(1);
    expect(stats.indexed).toBe(stats.total - 1);
    expect(stats.total).toBeGreaterThanOrEqual(4);

    db.close();
  });

  it('retries failed fact extraction on the next unchanged-file index and persists recovered facts (Fix #5)', async () => {
    const db = openDb(DB);
    openDbs.push(db);
    runMigrations(db);

    const DB_TARGET = 'OpenClaw Memory/User.md';
    // Fails exactly once for the target note (first call for that title),
    // then succeeds on the retry triggered by the hash reset. Title-keyed so
    // it is deterministic under concurrent indexing.
    const failedOnce = new Set<string>();
    const flakyExtractor = async (title: string, _body: string) => {
      if (title === 'User Preferences' && !failedOnce.has(title)) {
        failedOnce.add(title);
        throw new Error('simulated transient extractor failure');
      }
      return [{ subject: 'Alice', predicate: 'works_at', object: 'Acme', confidence: 0.9 }];
    };

    const stats = await indexVault(db, VAULT, { factExtractor: flakyExtractor });
    // RE-TARGETED (#188): this used to assert 0. A failure in this lane is an
    // index error — the note resolved with its facts missing, and counting it as
    // "indexed" is what let `index` exit 0 on an incomplete vault. The Fix #5
    // behaviour this case exists for is untouched: the hash is still reset, and
    // the pass below still recovers the facts.
    expect(stats.errors).toBe(1);
    expect(stats.indexed).toBe(stats.total - 1);

    // First pass: extraction failed for exactly one note → its hash reset to ''.
    const target = db
      .prepare("SELECT path, note_hash FROM notes WHERE path LIKE '%openclaw%'")
      .get() as { path: string; note_hash: string } | undefined;
    expect(target).toBeDefined();
    expect(target!.path).toContain(DB_TARGET);
    expect(target!.note_hash).toBe('');
    // LLM fact was not persisted after the failed extraction.
    const factsAfterFirst = db
      .prepare('SELECT COUNT(*) AS c FROM facts WHERE predicate = ? AND source_path = ?')
      .get('works_at', target!.path) as { c: number };
    expect(factsAfterFirst.c).toBe(0);
    expect(failedOnce.size).toBe(1);

    // Second pass on unchanged files: the '' hash forces re-processing, extraction retries.
    await indexVault(db, VAULT, { factExtractor: flakyExtractor });

    const factsAfterRetry = db
      .prepare('SELECT COUNT(*) AS c FROM facts WHERE predicate = ? AND source_path = ?')
      .get('works_at', target!.path) as { c: number };
    expect(factsAfterRetry.c).toBe(1);
    const hashAfterRetry = db
      .prepare('SELECT note_hash FROM notes WHERE path = ?').get(target!.path) as { note_hash: string };
    expect(hashAfterRetry.note_hash).not.toBe('');

    db.close();
  });
});
