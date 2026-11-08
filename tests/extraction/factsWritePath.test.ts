import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import {
  captureNoteFacts,
  contentValidFrom,
  extractFactCandidates,
  factsWritePathEnabled,
  FACTS_EXTRACTION_VERSION,
} from '../../src/extraction/factsWritePath';
import { readCurrentRowsForNotes, type StoredStructuredRow } from '../../src/context/rowStore';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { defaultDecisionModel, type DecisionModel, type DecisionRequest, type DecisionResult } from '../../src/extraction/decision-model';
import { tmpPath } from '../helpers/tmpPath';
import { factValue } from '../helpers/factValue';
import { removeDb } from '../helpers/removeDb';

const DB_PATH = tmpPath('test-c2-facts-writepath.db');
const openDbs: ReturnType<typeof openDb>[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  removeDb(DB_PATH);
});

function freshDb(): ReturnType<typeof openDb> {
  removeDb(DB_PATH);
  const db = openDb(DB_PATH);
  openDbs.push(db);
  runMigrations(db);
  db.prepare(
    `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
     VALUES ('notes/run.md', 'Marathon Prep', 'note', 'hash1', '2024-03-01', '{}')`
  ).run();
  db.prepare(
    `INSERT INTO chunks (id, note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
     VALUES (11, 'notes/run.md', '', 'chunk one', 1, 1, 2, 'ch1'),
            (12, 'notes/run.md', '', 'chunk two', 2, 2, 2, 'ch2')`
  ).run();
  return db;
}

/** Stub DecisionModel: records calls, forces configured decisions. */
function stubModel(overrides: Partial<Record<'capture_gate' | 'dedupe_adjudication', string>> = {}): { model: DecisionModel; calls: DecisionRequest[] } {
  const calls: DecisionRequest[] = [];
  const model: DecisionModel = {
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      calls.push(request);
      if (request.task === 'capture_gate') {
        const decision = overrides.capture_gate ?? 'fact';
        return { task: 'capture_gate', decision: decision as any, confidence: 1, latencyMs: 0, costUSDCents: 0 };
      }
      const decision = overrides.dedupe_adjudication ?? 'distinct';
      return { task: 'dedupe_adjudication', decision: decision as any, confidence: 1, latencyMs: 0, costUSDCents: 0 };
    },
  };
  return { model, calls };
}

const args = {
  notePath: 'notes/run.md',
  noteTitle: 'Marathon Prep',
  frontmatter: { date: '2024-03-01' },
  sourceHash: 'hash1',
  chunks: [
    { id: 11, text: 'Ran the marathon in 3:45. Felt strong.' },
    { id: 12, text: 'Weekly mileage was 80 km.' },
  ],
};

describe('C2 facts write-path (save-time capture)', () => {
  it('flag is OFF by default and honors explicit opt-in spellings', () => {
    expect(factsWritePathEnabled({})).toBe(false);
    for (const on of ['1', 'true', 'yes', 'on']) expect(factsWritePathEnabled({ RENOR_FACTS_WRITE_PATH: on })).toBe(true);
    for (const off of ['0', 'false', 'off', 'garbage']) expect(factsWritePathEnabled({ RENOR_FACTS_WRITE_PATH: off })).toBe(false);
  });

  it('extracts v1 numeric candidates deterministically (value, unit, verb, object, event)', () => {
    const cands = extractFactCandidates('Ran the marathon in 3:45. Felt strong.', 'Marathon Prep');
    expect(cands).toHaveLength(1);
    expect(cands[0].value).toBe('3:45');
    expect(cands[0].object).toBe('Marathon Prep');
    expect(cands[0].event).toContain('3:45');
    expect(extractFactCandidates('', 'x')).toEqual([]);
    expect(extractFactCandidates('No numbers here at all.', 'x')).toEqual([]);
  });

  it('valid_from comes from frontmatter date only — unknown stays NULL, never now, never invented', () => {
    expect(contentValidFrom({ date: '2024-03-01' })).toBe('2024-03-01');
    expect(contentValidFrom({ session_date: '2024-03-01' })).toBe('2024-03-01');
    // gray-matter parses unquoted YAML dates into Date objects
    expect(contentValidFrom({ date: new Date(Date.UTC(2024, 2, 1)) })).toBe('2024-03-01');
    expect(contentValidFrom({})).toBe(null);
    expect(contentValidFrom({ date: 'not-a-date' })).toBe(null);
  });

  it('capture writes provenance-complete rows through the stub model (source_chunk_id populated, valid_from from content date)', async () => {
    const db = freshDb();
    const { model, calls } = stubModel();
    const outcome = await captureNoteFacts(db, args, model);
    expect(outcome.rowsWritten).toBe(2);
    expect(outcome.decisions).toBe(4); // 2 gates + 2 adjudications
    const rows = readCurrentRowsForNotes(db, ['notes/run.md']);
    expect(rows).toHaveLength(2);
    const byChunk = new Map(rows.map((r) => [r.sourceChunkId, r]));
    expect(byChunk.get(11)!.validFrom).toBe('2024-03-01');
    expect(byChunk.get(11)!.extractionVersion).toBe(FACTS_EXTRACTION_VERSION);
    expect(byChunk.get(11)!.payload).toMatchObject({ value: '3:45', object: 'Marathon Prep' });
    expect(byChunk.get(12)!.payload).toMatchObject({ value: '80', unit: 'km' });
    // capture-gate + dedupe decisions both went through the DecisionModel seam
    expect(calls.filter((c) => c.task === 'capture_gate')).toHaveLength(2);
    expect(calls.filter((c) => c.task === 'dedupe_adjudication')).toHaveLength(2);
  });

  it('cross-note identical: confirming note gets its OWN row; deleting either note keeps the fact surfacing from the other', async () => {
    const db = freshDb();
    await captureNoteFacts(db, args, defaultDecisionModel()); // note A rows
    // Note B: same title/object, same fact value → identical vs A's row.
    db.prepare(
      `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
       VALUES ('notes/twin.md', 'Marathon Prep', 'note', 'hash-twin', '2024-03-02', '{"date": "2024-03-02"}')`
    ).run();
    db.prepare(
      `INSERT INTO chunks (id, note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
       VALUES (21, 'notes/twin.md', '', 'chunk twin', 1, 1, 2, 'ch-twin')`
    ).run();
    const bArgs = {
      notePath: 'notes/twin.md',
      noteTitle: 'Marathon Prep',
      frontmatter: { date: '2024-03-02' },
      sourceHash: 'hash-twin',
      chunks: [{ id: 21, text: 'Ran the marathon in 3:45.' }],
    };
    const outcome = await captureNoteFacts(db, bArgs, defaultDecisionModel());
    expect(outcome.rowsWritten).toBe(1); // B's own source-scoped row
    expect(outcome.confirmBumps).toBe(1); // confirm-count bump on A's original row
    let aRows = readCurrentRowsForNotes(db, ['notes/run.md']);
    let bRows = readCurrentRowsForNotes(db, ['notes/twin.md']);
    expect(aRows.find((r) => factValue(r) === '3:45')!.confirmCount).toBe(2); // bump attributed to A's row
    expect(bRows.map(factValue)).toContain('3:45');
    // Idempotent under hash-skip: a re-run of the same note is a no-op and
    // does not inflate the confirm_count attribution.
    const rerun = await captureNoteFacts(db, bArgs, defaultDecisionModel());
    expect(rerun).toEqual({ rowsWritten: 0, confirmBumps: 0, decisions: 0 });
    aRows = readCurrentRowsForNotes(db, ['notes/run.md']);
    expect(aRows.find((r) => factValue(r) === '3:45')!.confirmCount).toBe(2);
    // Deleting note A: its row FK-cascades away, but B's row still holds the
    // fact — it still surfaces through the retrieval-hit join.
    db.prepare('DELETE FROM notes WHERE path = ?').run('notes/run.md');
    bRows = readCurrentRowsForNotes(db, ['notes/twin.md']);
    expect(bRows.map(factValue)).toContain('3:45');
    expect(aRows = readCurrentRowsForNotes(db, ['notes/run.md'])).toEqual([]);
  });

  it('dedupe adjudication: identical bumps confirm count instead of duplicating the row', async () => {
    const db = freshDb();
    await captureNoteFacts(db, args, defaultDecisionModel());
    // Same identity re-extracted from a new chunk of the same note (simulating edit):
    const { model, calls } = stubModel({ dedupe_adjudication: 'identical' });
    const outcome = await captureNoteFacts(db, {
      ...args,
      sourceHash: 'hash2',
      chunks: [{ id: 13, text: 'Ran the marathon in 3:45 again, officially.' }],
    }, model);
    expect(outcome.rowsWritten).toBe(0);
    expect(outcome.confirmBumps).toBe(1);
    const rows = readCurrentRowsForNotes(db, ['notes/run.md']);
    expect(rows).toHaveLength(2); // still one row per identity, no duplicates
    expect(rows.find((r) => r.sourceChunkId === 13)).toBeUndefined();
    expect(rows.find((r) => factValue(r) === '3:45')!.confirmCount).toBe(2);
    expect(calls.some((c) => c.task === 'dedupe_adjudication')).toBe(true);
  });

  it('dedupe adjudication: updated writes the new value; both rows stay current (blanket newest-wins is REJECTED — N18)', async () => {
    const db = freshDb();
    await captureNoteFacts(db, args, defaultDecisionModel());
    db.prepare(
      `INSERT INTO chunks (id, note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
       VALUES (13, 'notes/run.md', '', 'chunk three', 3, 3, 2, 'ch3')`
    ).run();
    const outcome = await captureNoteFacts(db, {
      ...args,
      sourceHash: 'hash2',
      chunks: [{ id: 13, text: 'He completed the marathon in 3:30.' }],
    }, defaultDecisionModel());
    expect(outcome.rowsWritten).toBe(1);
    // ADR-0003 §4.1: supersession is identity-keyed only, and fact identity is
    // (value, object) — a changed value is a distinct identity, so 3:45 and
    // 3:30 coexist as current rows (reader-side conflict policy is a separate
    // card); 80 km is untouched. No row is silently dropped.
    const rows = readCurrentRowsForNotes(db, ['notes/run.md']);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => factValue(r) === '3:30')).toBeDefined();
    expect(rows.find((r) => factValue(r) === '3:45')).toBeDefined();
  });

  it('hash-keyed skip: same (source_path, source_hash, extraction_version) → zero decision calls', async () => {
    const db = freshDb();
    const { model, calls } = stubModel();
    await captureNoteFacts(db, args, model);
    const before = calls.length;
    const outcome = await captureNoteFacts(db, args, model);
    expect(outcome).toEqual({ rowsWritten: 0, confirmBumps: 0, decisions: 0 });
    expect(calls.length).toBe(before);
  });

  it('capture gate none (via stub) → zero rows even when rules would match', async () => {
    const db = freshDb();
    const { model } = stubModel({ capture_gate: 'none' });
    const outcome = await captureNoteFacts(db, args, model);
    expect(outcome.rowsWritten).toBe(0);
    expect(readCurrentRowsForNotes(db, ['notes/run.md'])).toEqual([]);
  });

  it('gate-approved chunk with no numeric match writes nothing (explicit, not silent-[])', async () => {
    const db = freshDb();
    const { model } = stubModel();
    const outcome = await captureNoteFacts(db, {
      ...args,
      chunks: [{ id: 11, text: 'The marathon was run. It happened outdoors in spring.' }],
    }, model);
    expect(outcome.rowsWritten).toBe(0);
    expect(readCurrentRowsForNotes(db, ['notes/run.md'])).toEqual([]);
  });
});