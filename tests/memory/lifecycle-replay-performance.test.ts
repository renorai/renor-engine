import { afterEach, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { replayLedger } from '../../src/memory/lifecycle';
import type Database from '../../src/db/sqlite';
import { removeTestDir } from '../helpers/removeDb';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTestDir(dir);
});

function fixture(count: number) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-capacity-'));
  dirs.push(vault);
  // Distinct subjects expose quadratic entity scans; no live writes/embeddings
  // are included in the timed region. File-backed DB matches startup replay.
  fs.writeFileSync(path.join(vault, 'ledger.md'), Array.from({ length: count }, (_, i) =>
    `## mem_${i} · 2026-01-01T00:00:00.000Z\n- kind: store\n- subject: Synthetic subject ${i}\n- predicate: value\n- object: Synthetic value ${i}\n\n`,
  ).join(''));
  const db = openDb(path.join(vault, 'index.db'));
  runMigrations(db);
  return { vault, db };
}

// The bounds below guard against a quadratic replay (the measured ~83s startup), so they bound CPU
// time: wall-clock time also counts every moment the OS spends running someone else's process on a
// shared host. The same 10k cold replay needed 5.6-7.5s of CPU at every load level measured (idle
// to 12% of a core), while its wall time was 22-26s at 25% of a core and 60s at 12%. The 15s bound
// itself is unchanged, and a quadratic replay still exceeds it by the same factor.
async function cpuMsOf(run: () => Promise<number>): Promise<{ result: number; cpuMs: number }> {
  const before = process.cpuUsage();
  const result = await run();
  const used = process.cpuUsage(before);
  return { result, cpuMs: (used.user + used.system) / 1000 };
}

// The golden digest below pins the columns replay wrote before the author (migration 18) and write-event scope
// (migration 19) columns existed; those two are projected separately (`added`) so the golden keeps its meaning.
function without<T extends Record<string, unknown>>(rows: T[], keys: string[]): T[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key))) as T);
}

function projection(db: Database.Database) {
  return {
    entities: db.prepare("SELECT * FROM entities WHERE source_note = '_mcp_' ORDER BY id").all(),
    // statement_words is the facts lane's word index for a saved statement (migration 25), pinned on its own below; every
    // other column is pinned here as before, and the digest value is unchanged.
    facts: without(db.prepare('SELECT * FROM facts ORDER BY id').all() as Record<string, unknown>[], ['author', 'statement_words']),
    receipts: db.prepare('SELECT * FROM applied_ledger_events ORDER BY event_id').all(),
    writes: without(db.prepare('SELECT * FROM write_events ORDER BY id').all() as Record<string, unknown>[], ['author', 'scope']),
  };
}

function added(db: Database.Database) {
  return {
    facts: db.prepare('SELECT author FROM facts ORDER BY id').all(),
    writes: db.prepare('SELECT author, scope FROM write_events ORDER BY id').all(),
  };
}

for (const count of [1_000, 10_000]) {
  it(`replays ${count} distinct subjects within the startup budget, including warm restart`, async () => {
    const { db, vault } = fixture(count);
    try {
      const cold = await cpuMsOf(() => replayLedger(db, vault, 'ledger.md'));
      expect(cold.result).toBe(count);
      const coldMs = cold.cpuMs;
      process.stdout.write(`replay ${count}: cpu cold=${coldMs.toFixed(2)}ms\n`);
      expect(coldMs).toBeLessThan(15_000);
      const before = projection(db);
      const warm = await cpuMsOf(() => replayLedger(db, vault, 'ledger.md'));
      expect(warm.result).toBe(0);
      const warmMs = warm.cpuMs;
      process.stdout.write(`replay ${count}: cpu cold=${coldMs.toFixed(2)}ms warm=${warmMs.toFixed(2)}ms\n`);
      expect(projection(db)).toEqual(before);
      expect(before.entities).toHaveLength(count);
      expect(before.facts).toHaveLength(count);
      const rows = db.prepare('SELECT e.canonical_name, f.object_text, f.event_id, f.valid_to FROM facts f JOIN entities e ON e.id = f.subject_entity_id ORDER BY f.id').all();
      expect(rows).toEqual(Array.from({ length: count }, (_, i) => ({
        canonical_name: `Synthetic subject ${i}`, object_text: `Synthetic value ${i}`, event_id: `MEM_${i}`, valid_to: null,
      })));
      // 15s of CPU tolerates slower CI hardware while catching the
      // measured ~83s startup. Both fresh imports and deployed restarts matter.
      expect(warmMs).toBeLessThan(15_000);
    } finally { db.close(); }
  }, 240_000);
}

// Golden projection captured from the unoptimized origin/main replay. Covers
// aliases, Unicode normalization, distinct accents, scope and tied timestamps.
it('preserves the complete pre-index replay projection for identity/history events', async () => {
  const { db, vault } = fixture(0);
  const subjects = ['Rowan Vale', 'ROWAN', 'José', 'JOSE\u0301', 'Jose', 'Пётр', 'ПЁТР'];
  fs.writeFileSync(path.join(vault, 'ledger.md'), subjects.map((subject, i) =>
    `## MEM_EQ${i} · 2026-01-01T00:00:00.000Z\n- kind: store\n- subject: ${subject}\n- predicate: value\n- object: Value ${i}\n- scope: ${i === 1 ? 'project:test' : 'global'}\n\n`,
  ).join(''));
  try {
    expect(await replayLedger(db, vault, 'ledger.md')).toBe(subjects.length);
    const state = projection(db);
    const digest = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
    console.log(`identity projection sha256=${digest}`);
    expect(digest).toBe('0a78a9bd54ced49b04746e1b36d758b27fd78a468b68b82c93531962f85711b4');
    // An event with no source line replays under the ledger's own default source, "ledger"; scope is the event's.
    expect(added(db)).toEqual({
      facts: subjects.map(() => ({ author: 'ledger' })),
      writes: subjects.map((_, i) => ({ author: 'ledger', scope: i === 1 ? 'project:test' : 'global' })),
    });
    expect(await replayLedger(db, vault, 'ledger.md')).toBe(0);
    expect(projection(db)).toEqual(state);
  } finally { db.close(); }
});

// statement_words (migration 25) is derived from the saved statement and is pinned on its own: the golden digest above
// leaves it out, so this is where a wrong derivation on replay would fail.
it('derives statement_words from the saved statement on replay, and leaves a statement-less fact null', async () => {
  const { db, vault } = fixture(0);
  fs.writeFileSync(path.join(vault, 'ledger.md'), [
    '## MEM_SW1 · 2026-01-01T00:00:00.000Z',
    '- kind: store',
    '- subject: Atlas',
    '- predicate: deploy_target',
    '- object: Fly.io',
    '- scope: project:atlas',
    '- statement: "Refinement A of the get_context reservation fails."',
    '',
    '',
    '## MEM_SW2 · 2026-01-01T00:00:01.000Z',
    '- kind: store',
    '- subject: Atlas',
    '- predicate: region',
    '- object: São Paulo',
    '- scope: project:atlas',
    '',
    '',
  ].join('\n'));
  try {
    expect(await replayLedger(db, vault, 'ledger.md')).toBe(2);
    const words = (predicate: string) => (db.prepare('SELECT statement_words AS w FROM facts WHERE predicate = ?').get(predicate) as { w: string | null }).w;
    // Lowercased words of two letters or more, `_` split into words, each word once, in order of first appearance.
    expect(words('deploy_target')).toBe('refinement of the get context reservation fails');
    expect(words('region')).toBeNull();
  } finally { db.close(); }
});
