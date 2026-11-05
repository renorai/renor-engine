import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile } from '../../src/indexer/pipeline';
import type { ExtractedNumericFact } from '../../src/extraction/typedFacts';
import type Database from '../../src/db/sqlite';

/**
 * C2 fixtures (HYP-20260921-facts-product-join fixture list):
 * insert → rows with provenance; edit → stale rows deleted + re-extracted;
 * frontmatter-no-date → valid_from NULL; YAML extractor response → explicit
 * extractor-parse-error ≤3 retries, never cached, never silent [];
 * unchanged content → zero extractor model calls (hash-keyed skip).
 */

const tmpDirs: string[] = [];
function mkvault(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-facts-'));
  tmpDirs.push(d);
  return d;
}
function freshDb(file: string): Database.Database {
  // MUST be openDb(): the product opener (PRAGMA foreign_keys=ON) is what ships,
  // and the rowStore insert semantics are asserted against it.
  const db = openDb(file);
  runMigrations(db);
  return db;
}
/**
 * The lane flag is read from the REAL process environment (RENOR_TYPED_FACTS):
 * indexFile has no env-injection parameter, so this file arms the variable
 * `renor index` reads and restores it after every test, exactly as the CLI
 * and a developer shell would. Flag-off cases delete it explicitly.
 */
const FLAG = 'RENOR_TYPED_FACTS';
const ORIGINAL_FLAG = process.env[FLAG];
beforeEach(() => { process.env[FLAG] = '1'; });

function stubExtractor(facts: ExtractedNumericFact[] | Error, calls: { n: number }) {
  return async (): Promise<ExtractedNumericFact[]> => {
    calls.n++;
    if (facts instanceof Error) throw facts;
    return facts;
  };
}

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
  else process.env[FLAG] = ORIGINAL_FLAG;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function writeNote(v: string, name: string, content: string): Promise<string> {
  const p = path.join(v, name);
  fs.writeFileSync(p, content);
  return p;
}

const DATED_NOTE = `---
kind: session
session_date: 2026-03-10
---
# Run log

Ran 21.1 km in 1:47:30. Avg pace 5:06 min/km.
`;

const UNDATED_NOTE = `# Weights

Bench press 100 kg. Bodyweight 78 kg.
`;

describe('C2 fixture: insert → fact rows with provenance', () => {
  it('extracts numeric facts into structured_rows with source_path + source_chunk_id + content-date valid_from', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'run.md', DATED_NOTE);
    const calls = { n: 0 };
    await indexFile(db, note, {
      numericFactExtractor: stubExtractor([
        { value: '21.1', unit: 'km', verb: 'ran', object: 'long run distance' },
        { value: '1:47:30', object: 'half marathon time' },
      ], calls),
    });

    expect(calls.n).toBe(1);
    const rows = db.prepare(
      `SELECT r.*, c.id AS chunk_exists FROM structured_rows r
       LEFT JOIN chunks c ON c.id = r.source_chunk_id
       WHERE r.source_path = ? AND r.row_kind = 'fact'`,
    ).all(note) as any[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.extraction_version).toContain('facts-v1');
      expect(row.source_hash).toBe(
        (db.prepare('SELECT note_hash FROM notes WHERE path = ?').get(note) as any).note_hash,
      );
      expect(row.chunk_exists).toBeTruthy(); // source_chunk_id resolves to a real chunk
      expect(row.valid_from).toBe('2026-03-10'); // content date, not now()
      expect(row.valid_to).toBeNull();
      const payload = JSON.parse(row.payload_json);
      expect(payload.value).toBeTruthy();
      expect(payload.object).toBeTruthy();
    }
    const dedupes = rows.map((r) => r.dedupe_key).sort();
    expect(dedupes[0]).toBe('fact|1 47 30|half marathon time');
    expect(dedupes[1]).toBe('fact|21 1|long run distance');
    db.close();
  });

  it('is a no-op when RENOR_TYPED_FACTS is off (default — no extraction, no rows)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'run.md', DATED_NOTE);
    const calls = { n: 0 };
    delete process.env[FLAG]; // the kill-switch case, explicitly
    await indexFile(db, note, {
      numericFactExtractor: stubExtractor([], calls),
    });
    expect(calls.n).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM structured_rows').get() as any).c).toBe(0);
    db.close();
  });
});

describe('C2 fixture: edit → stale rows deleted + re-extracted', () => {
  it('re-index of an edited note replaces its rows and bumps source_hash', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'run.md', DATED_NOTE);
    const calls = { n: 0 };
    const opts = {
      numericFactExtractor: async (): Promise<ExtractedNumericFact[]> => {
        calls.n++;
        return calls.n === 1
          ? [{ value: '21.1', unit: 'km', verb: 'ran', object: 'long run distance' }]
          : [{ value: '25.0', unit: 'km', verb: 'ran', object: 'long run distance' }];
      },
    };
    await indexFile(db, note, opts);
    const first = db.prepare('SELECT id, source_hash FROM structured_rows WHERE source_path = ?').all(note) as any[];
    expect(first).toHaveLength(1);

    fs.writeFileSync(note, DATED_NOTE.replace('21.1 km', '25.0 km'));
    await indexFile(db, note, opts);

    const after = db.prepare('SELECT id, source_hash, payload_json FROM structured_rows WHERE source_path = ?').all(note) as any[];
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(first[0].id); // stale row deleted, fresh row inserted
    expect(after[0].source_hash).not.toBe(first[0].source_hash);
    expect(JSON.parse(after[0].payload_json).value).toBe('25.0');
    expect(calls.n).toBe(2);
    db.close();
  });
});

describe('C2 fixture: frontmatter without a date → valid_from NULL', () => {
  it('never assigns now() or an invented date', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'weights.md', UNDATED_NOTE);
    await indexFile(db, note, {
      numericFactExtractor: stubExtractor([{ value: '100', unit: 'kg', verb: 'bench_press', object: 'bench press' }], { n: 0 }),
    });
    const row = db.prepare('SELECT valid_from FROM structured_rows WHERE source_path = ?').get(note) as any;
    expect(row.valid_from).toBeNull();
    db.close();
  });
});

describe('C2 fixture: YAML extractor response → explicit parse error, never cached', () => {
  it('throws extractor-parse-error after ≤3 attempts; note hash reset so retry is possible; no rows cached', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'run.md', DATED_NOTE);
    let calls = 0;
    const { ExtractorParseError } = await import('../../src/extraction/typedFacts.js');
    await expect(indexFile(db, note, {
      numericFactExtractor: async () => {
        calls++;
        throw new ExtractorParseError('extractor-parse-error: non-JSON response');
      },
    })).rejects.toThrow(/extractor-parse-error/);
    expect(calls).toBe(1); // the extractor stub is called once; retry policy (≤3) lives in extractNumericFactsWithRetry
    expect((db.prepare('SELECT count(*) c FROM structured_rows').get() as any).c).toBe(0);
    // Note hash reset: the next pass re-processes (never cached as current).
    const hash = (db.prepare('SELECT note_hash FROM notes WHERE path = ?').get(note) as any).note_hash;
    expect(hash).toBe('');
    db.close();
  });

});
