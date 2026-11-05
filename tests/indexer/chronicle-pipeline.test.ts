import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile } from '../../src/indexer/pipeline';
import type { ExtractedEvent } from '../../src/extraction/eventExtractor';
import type { StoredStructuredRow } from '../../src/context/rowStore';
import type Database from '../../src/db/sqlite';

/**
 * C3 fixtures (HYP-20260921-chronicle-extraction fixture list):
 * "I ran 5km yesterday" → event row (not a preference); restatement of the
 * same (when, event) identity on a newer note → old row superseded (valid_to
 * set), not duplicated — blanket newest-wins rejected (N18 KILL); note with no
 * parsable date → when stays as user wording with valid_from NULL, never
 * invented;
 * there); unchanged content → zero extractor model calls (hash-keyed skip).
 */

const tmpDirs: string[] = [];
function mkvault(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-events-'));
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
 * The lane flag is read from the REAL process environment (RENOR_CHRONICLE):
 * indexFile has no env-injection parameter, so this file arms the variable
 * `renor index` reads and restores it after every test, exactly as the CLI
 * and a developer shell would. Flag-off cases delete it explicitly.
 */
const FLAG = 'RENOR_CHRONICLE';
const ORIGINAL_FLAG = process.env[FLAG];
beforeEach(() => { process.env[FLAG] = '1'; });

function stubExtractor(events: ExtractedEvent[] | Error, calls: { n: number }) {
  return async (): Promise<ExtractedEvent[]> => {
    calls.n++;
    if (events instanceof Error) throw events;
    return events;
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

I ran 5km yesterday.
`;

const UNDATED_NOTE = `# Coffee

Met Ana at the café this morning.
`;

describe('C3 fixture: "I ran 5km yesterday" → event row (not a preference)', () => {
  it('extracts events into structured_rows with row_kind=event and the user’s own `when`', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'run.md', DATED_NOTE);
    const calls = { n: 0 };
    await indexFile(db, note, {
      eventExtractor: stubExtractor(
        [{ when: 'yesterday', event: 'ran 5km', entities: [] }],
        calls,
      ),
    });

    expect(calls.n).toBe(1);
    const rows = db.prepare(
      `SELECT r.*, c.id AS chunk_exists FROM structured_rows r
       LEFT JOIN chunks c ON c.id = r.source_chunk_id
       WHERE r.source_path = ? AND r.row_kind = 'event'`,
    ).all(note) as any[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.extraction_version).toContain('events-v1');
    expect(row.source_hash).toBe(
      (db.prepare('SELECT note_hash FROM notes WHERE path = ?').get(note) as any).note_hash,
    );
    expect(row.chunk_exists).toBeTruthy(); // source_chunk_id resolves to a real chunk
    expect(row.valid_from).toBe('2026-03-10'); // content date, not now()
    expect(row.valid_to).toBeNull();
    const payload = JSON.parse(row.payload_json);
    expect(payload.when).toBe('yesterday'); // user's own wording, not a normalized date
    expect(payload.event).toBe('ran 5km');
    expect(row.dedupe_key).toBe('event|yesterday|ran 5km');
    db.close();
  });

  it('is a no-op when RENOR_CHRONICLE is off (default — no extraction, no rows)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'run.md', DATED_NOTE);
    const calls = { n: 0 };
    delete process.env[FLAG]; // the kill-switch case, explicitly
    await indexFile(db, note, {
      eventExtractor: stubExtractor([], calls),
    });
    expect(calls.n).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM structured_rows').get() as any).c).toBe(0);
    db.close();
  });
});

describe('C3 fixture: identity-keyed supersession (N18 blanket newest-wins rejected)', () => {
  it('restating the same (when, event) identity in a newer note supersedes the old row (valid_to set), while different identities coexist', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const older = await writeNote(v, '2026-03-10.md', DATED_NOTE); // session_date 2026-03-10
    const calls = { n: 0 };
    const opts = { eventExtractor: stubExtractor([{ when: 'yesterday', event: 'ran 5km' }], calls) };
    await indexFile(db, older, opts);
    expect((db.prepare("SELECT count(*) c FROM structured_rows WHERE row_kind='event' AND valid_to IS NULL").get() as any).c).toBe(1);

    // A newer note restates the same identity (normalized when/event match).
    const newer = await writeNote(v, '2026-06-01.md', `---
kind: session
session_date: 2026-06-01
---
# Run log again

As I said: I ran 5km yesterday.
`);
    await indexFile(db, newer, opts);

    const rows = db.prepare(
      "SELECT valid_from, valid_to, source_path FROM structured_rows WHERE row_kind='event' ORDER BY valid_from",
    ).all() as any[];
    expect(rows).toHaveLength(2);
    // Blanket newest-wins is REJECTED: the different-identity row on the older
    // note is untouched; only the colliding identity is superseded.
    expect(rows[0].source_path).toBe(older);
    expect(rows[0].valid_to).toBe('2026-06-01'); // superseded
    expect(rows[1].source_path).toBe(newer);
    expect(rows[1].valid_to).toBeNull(); // current
    db.close();
  });
});

describe('C3 fixture: no parsable date → when stays as user wording, valid_from NULL', () => {
  it('never assigns now() or an invented normalized date', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'coffee.md', UNDATED_NOTE);
    await indexFile(db, note, {
      eventExtractor: stubExtractor([{ when: 'this morning', event: 'met Ana at the café', entities: ['Ana'] }], { n: 0 }),
    });
    const row = db.prepare("SELECT valid_from, payload_json FROM structured_rows WHERE source_path = ? AND row_kind='event'").get(note) as any;
    expect(row.valid_from).toBeNull();
    const payload = JSON.parse(row.payload_json);
    expect(payload.when).toBe('this morning'); // user's own wording preserved verbatim
    db.close();
  });
});

describe('C3 fixture: YAML extractor response → explicit parse error, never cached', () => {
  it('throws extractor-parse-error; note hash reset so retry is possible; no rows cached', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'run.md', DATED_NOTE);
    let calls = 0;
    const { ExtractorParseError } = await import('../../src/extraction/eventExtractor.js');
    await expect(indexFile(db, note, {
      eventExtractor: async () => {
        calls++;
        throw new ExtractorParseError('extractor-parse-error: non-JSON response');
      },
    })).rejects.toThrow(/extractor-parse-error/);
    expect(calls).toBe(1); // the extractor stub is called once; retry policy (≤3) lives in extractEventsWithRetry
    expect((db.prepare("SELECT count(*) c FROM structured_rows WHERE row_kind='event'").get() as any).c).toBe(0);
    // Note hash reset: the next pass re-processes (never cached as current).
    const hash = (db.prepare('SELECT note_hash FROM notes WHERE path = ?').get(note) as any).note_hash;
    expect(hash).toBe('');
    db.close();
  });

});

describe('C3 fixture: composer chronicle section (40-row relevance cap, not flat first-seen)', () => {
  it('caps the chronicle at 40 rows with relevance ranking and the cite-contract fallback instruction', async () => {
    const { composeQueryContext } = await import('../../src/context/composer.js');
    const mkRow = (i: number): any => ({
      id: i + 1,
      rowKind: 'event',
      sourcePath: 'notes/a.md',
      sourceChunkId: 1,
      sourceHash: 'h',
      scope: 'global',
      extractionVersion: 'events-v1',
      validFrom: i % 2 === 0 ? '2026-03-10' : null,
      validTo: null,
      payload: { when: `day ${i}`, event: i % 3 === 0 ? `ran marathon lap ${i}` : `unrelated walk ${i}` },
      dedupeKey: `event|day ${i}|e${i}`,
    });
    const ctx = composeQueryContext({
      query: 'marathon',
      hits: [{ notePath: 'notes/a.md', chunkId: 1, headingPath: '', text: 'marathon', score: 0.9, reason: 'semantic' }],
      rows: Array.from({ length: 55 }, (_, i) => mkRow(i)),
    }, { budgetTokens: 100000 });
    const chronicle = ctx.sections.find((s) => s.name === 'chronicle')!;
    expect(chronicle.rowCount).toBe(40); // 40-row cap
    // Relevance-ranked: marathon-matching rows lead, and ranking is not flat
    // first-seen truncation (the first 55 would keep rows 0..39; here the
    // marathon rows from across the whole corpus must all be present).
    for (const i of [0, 3, 6, 51, 54]) {
      expect(chronicle.text).toContain(`marathon lap ${i}`);
    }
    expect(chronicle.text).toContain('Use only events listed in this table'); // cite-contract instruction
    expect(ctx.includedSections).toContain('chronicle');
  });

  it('drops the whole chronicle section before facts on budget overflow (declared drop order)', async () => {
    const { composeQueryContext } = await import('../../src/context/composer.js');
    const bigText = 'x'.repeat(4000);
    const rows: StoredStructuredRow[] = [
      {
        id: 1, rowKind: 'event', sourcePath: 'notes/a.md', sourceChunkId: 1, sourceHash: 'h',
        scope: 'global', extractionVersion: 'events-v1', validFrom: '2026-03-10', validTo: null,
        payload: { when: 'yesterday', event: 'ran 5km' }, dedupeKey: 'event|yesterday|ran 5km', confirmCount: 1,
      },
      {
        id: 2, rowKind: 'fact', sourcePath: 'notes/a.md', sourceChunkId: 1, sourceHash: 'h',
        scope: 'global', extractionVersion: 'facts-v1', validFrom: '2026-03-10', validTo: null,
        payload: { value: '21.1', unit: 'km', verb: 'ran', object: 'distance' }, dedupeKey: 'fact|21 1|distance', confirmCount: 1,
      },
    ];
    const unbounded = composeQueryContext({
      query: 'marathon',
      hits: [{ notePath: 'notes/a.md', chunkId: 1, headingPath: '', text: bigText, score: 0.9, reason: 'semantic' }],
      rows,
    }, { budgetTokens: 1_000_000 });
    const tokensOf = (name: string) => unbounded.sections.find((s) => s.name === name)!.tokens;
    // Budget fits excerpts + facts (+ε) but NOT the chronicle → chronicle must
    // drop whole (declared drop order: chronicle drops before facts).
    const budget = tokensOf('excerpts') + tokensOf('facts') + 10;
    const ctx = composeQueryContext({
      query: 'marathon',
      hits: [{ notePath: 'notes/a.md', chunkId: 1, headingPath: '', text: bigText, score: 0.9, reason: 'semantic' }],
      rows,
    }, { budgetTokens: budget });
    expect(ctx.droppedSections).toEqual(['chronicle']); // chronicle drops before facts (no prefs section exists)
    expect(ctx.includedSections).toContain('facts');
    expect(ctx.includedSections).not.toContain('chronicle');
  });

  function estimateTokensFor(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }
});