import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile } from '../../src/indexer/pipeline';
import type { ExtractedPreference } from '../../src/extraction/preferenceExtractor';
import type { RetrievalHit } from '../../src/retrieval/orchestrator';
import type { StoredStructuredRow } from '../../src/context/rowStore';
import type Database from '../../src/db/sqlite';

/**
 * C4 fixtures (HYP-20260921-prefs-extraction fixture list — binding):
 * "I always run Tuesdays" → preference row (standing); "I ran 5km yesterday" →
 * NOT a preference (standing-vs-one-off must not rely on the prompt alone —
 * the structural guard `looksLikeOneOff` rejects it at code level, tested both
 * ways: a stub emitting the one-off statement still yields no pref row);
 * duplicate restatement with a different `kind` → single row (kind NOT in the
 * dedupe key — norm(statement) is); contradiction on edit → old row superseded
 * (valid_to set), not co-current (identity-keyed supersession only, N18
 * blanket newest-wins rejected); unchanged content → zero model calls
 * ((source_hash, extraction_version)-keyed skip); RENOR_PREFS default off.
 * Composer prefs section: 40-row relevance cap, retrieval-scoped ranking, the
 * apply-contract instruction, kind as render-only, whole-section drop first
 * on overflow; a cap increase cannot silently flood context (token budget).
 */

const tmpDirs: string[] = [];
function mkvault(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-prefs-'));
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
 * The lane flag is read from the REAL process environment (RENOR_PREFS):
 * indexFile has no env-injection parameter, so this file arms the variable
 * `renor index` reads and restores it after every test, exactly as the CLI
 * and a developer shell would. Flag-off cases delete it explicitly.
 */
const FLAG = 'RENOR_PREFS';
const ORIGINAL_FLAG = process.env[FLAG];
beforeEach(() => { process.env[FLAG] = '1'; });

function stubExtractor(prefs: ExtractedPreference[] | Error, calls: { n: number }) {
  return async (): Promise<ExtractedPreference[]> => {
    calls.n++;
    if (prefs instanceof Error) throw prefs;
    return prefs;
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

const PREF_NOTE = `---
kind: session
session_date: 2026-03-10
---
# Training habits

I always run Tuesdays.
`;

describe('C4 fixture: "I always run Tuesdays" → preference row (standing)', () => {
  it('extracts standing preferences into structured_rows with row_kind=preference', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'habits.md', PREF_NOTE);
    const calls = { n: 0 };
    await indexFile(db, note, {
      preferenceExtractor: stubExtractor(
        [{ statement: 'I always run Tuesdays', kind: 'policy' }],
        calls,
      ),
    });

    expect(calls.n).toBe(1);
    const rows = db.prepare(
      `SELECT r.*, c.id AS chunk_exists FROM structured_rows r
       LEFT JOIN chunks c ON c.id = r.source_chunk_id
       WHERE r.source_path = ? AND r.row_kind = 'preference'`,
    ).all(note) as any[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.extraction_version).toContain('prefs-v1');
    expect(row.source_hash).toBe(
      (db.prepare('SELECT note_hash FROM notes WHERE path = ?').get(note) as any).note_hash,
    );
    expect(row.chunk_exists).toBeTruthy(); // source_chunk_id resolves to a real chunk
    expect(row.valid_from).toBe('2026-03-10'); // content date, not now()
    expect(row.valid_to).toBeNull();
    const payload = JSON.parse(row.payload_json);
    expect(payload.statement).toBe('I always run Tuesdays');
    expect(payload.kind).toBe('policy'); // render-only enum, stored unvalidated
    expect(row.dedupe_key).toBe('pref|i always run tuesdays'); // norm(statement)
    db.close();
  });

  it('is a no-op when RENOR_PREFS is off (default — no extraction, no rows)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'habits.md', PREF_NOTE);
    const calls = { n: 0 };
    delete process.env[FLAG]; // the kill-switch case, explicitly
    await indexFile(db, note, {
      preferenceExtractor: stubExtractor([], calls),
    });
    expect(calls.n).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM structured_rows').get() as any).c).toBe(0);
    db.close();
  });
});

describe('C4 fixture: "I ran 5km yesterday" → NOT a preference (structural guard, not prompt alone)', () => {
  it('looksLikeOneOff rejects one-off statements even when the model emits them', async () => {
    const { looksLikeOneOff } = await import('../../src/extraction/preferenceExtractor.js');
    expect(looksLikeOneOff('I ran 5km yesterday')).toBe(true);
    expect(looksLikeOneOff('Ran the marathon last Sunday')).toBe(true);
    expect(looksLikeOneOff('Met Ana at the café this morning')).toBe(true);
    // The standing rule survives — the guard anchors on temporal markers, not topic words.
    expect(looksLikeOneOff('I always run Tuesdays')).toBe(false);
    expect(looksLikeOneOff('I prefer vegetarian food')).toBe(false);
    expect(looksLikeOneOff('I never eat meat')).toBe(false);
  });

  it('drops the one-off row at the code level even when the model emits it (extractPreferences path)', async () => {
    // RED-then-GREEN: this test exercises extractPreferences with a stubbed
    // LLM client — on a tree without the structural guard, the misbehaving
    // model's one-off row would be stored and this test would fail.
    const { extractPreferences } = await import('../../src/extraction/preferenceExtractor.js');
    const fakeClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  prefs: [
                    { statement: 'I ran 5km yesterday', kind: 'policy' },
                    { statement: 'I always run Tuesdays', kind: 'policy' },
                  ],
                }),
              },
            }],
            usage: {},
          }),
        },
      },
    };
    const prefs = await extractPreferences(fakeClient, 'Run log', 'I ran 5km yesterday. I always run Tuesdays.');
    expect(prefs.map((p) => p.statement)).toEqual(['I always run Tuesdays']); // one-off dropped at code level
  });
});

describe('C4 fixture: duplicate restatement with different kind → single row (norm(statement) dedupe)', () => {
  it('kind is NOT in the dedupe key — same statement, different kind, single identity', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const older = await writeNote(v, '2026-03-10.md', PREF_NOTE);
    const calls = { n: 0 };
    await indexFile(db, older, {
      preferenceExtractor: stubExtractor([{ statement: 'I always run Tuesdays', kind: 'policy' }], calls),
    });
    expect((db.prepare("SELECT count(*) c FROM structured_rows WHERE row_kind='preference'").get() as any).c).toBe(1);

    // A newer note restates the SAME statement with a DIFFERENT kind — kind is
    // not in the dedupe key, so the identity collides and supersedes.
    const newer = await writeNote(v, '2026-06-01.md', `---
kind: session
session_date: 2026-06-01
---
# Training habits again

As I said: I always run Tuesdays.
`);
    await indexFile(db, newer, {
      preferenceExtractor: stubExtractor([{ statement: 'I always run Tuesdays', kind: 'attribute' }], calls),
    });

    const rows = db.prepare(
      "SELECT valid_from, valid_to, source_path, dedupe_key, payload_json FROM structured_rows WHERE row_kind='preference' ORDER BY valid_from",
    ).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].dedupe_key).toBe('pref|i always run tuesdays'); // identical key, kind absent
    expect(rows[1].dedupe_key).toBe('pref|i always run tuesdays');
    expect(rows[0].valid_to).toBe('2026-06-01'); // superseded, not co-current
    expect(rows[1].source_path).toBe(newer);
    expect(rows[1].valid_to).toBeNull(); // single current row
    expect(JSON.parse(rows[1].payload_json).kind).toBe('attribute');
    db.close();
  });
});

describe('C4 fixture: contradiction on edit → old row superseded (valid_to set), not co-current', () => {
  it('restating a standing rule with a contradiction on a newer note supersedes the old row via identity; different identities coexist', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const older = await writeNote(v, '2026-03-10.md', PREF_NOTE);
    const calls = { n: 0 };
    await indexFile(db, older, {
      preferenceExtractor: stubExtractor(
        [
          { statement: 'I always run Tuesdays', kind: 'policy' },
          { statement: 'I only run in the morning', kind: 'policy' },
        ],
        calls,
      ),
    });
    expect(
      (db.prepare("SELECT count(*) c FROM structured_rows WHERE row_kind='preference' AND valid_to IS NULL").get() as any).c,
    ).toBe(2);

    // A newer note restates the SAME identity ("I always run Tuesdays", same
    // norm(statement)) with a contradiction — only that identity is
    // superseded; the different-identity row on the older note is untouched
    // (blanket newest-wins is REJECTED; supersession is identity-keyed).
    const newer = await writeNote(v, '2026-06-01.md', `---
kind: session
session_date: 2026-06-01
---
# Training habits revised

Actually, I never run on Tuesdays anymore. And I always run Tuesdays is wrong now.
`);
    await indexFile(db, newer, {
      preferenceExtractor: stubExtractor(
        [{ statement: 'I always run Tuesdays', kind: 'policy' }],
        calls,
      ),
    });

    const rows = db.prepare(
      "SELECT payload_json, valid_from, valid_to, source_path FROM structured_rows WHERE row_kind='preference' ORDER BY valid_from",
    ).all() as any[];
    expect(rows).toHaveLength(3);
    // The contradicted identity is superseded; the untouched identity keeps
    // its old row current.
    const superseded = rows.filter((r) => r.valid_to !== null);
    expect(superseded).toHaveLength(1);
    expect(JSON.parse(superseded[0].payload_json).statement).toBe('I always run Tuesdays');
    expect(superseded[0].source_path).toBe(older);
    const current = rows.filter((r) => r.valid_to === null);
    expect(current).toHaveLength(2);
    expect(current.map((r) => JSON.parse(r.payload_json).statement).sort())
      .toEqual(['I always run Tuesdays', 'I only run in the morning']);
    expect(current.find((r) => r.source_path === newer)).toBeTruthy(); // the newer source is the current one
    db.close();
  });
});

describe('C4 fixture: YAML extractor response → explicit parse error, never cached', () => {
  it('throws extractor-parse-error; note hash reset so retry is possible; no rows cached', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'habits.md', PREF_NOTE);
    let calls = 0;
    const { ExtractorParseError } = await import('../../src/extraction/preferenceExtractor.js');
    await expect(indexFile(db, note, {
      preferenceExtractor: async () => {
        calls++;
        throw new ExtractorParseError('extractor-parse-error: non-JSON response');
      },
    })).rejects.toThrow(/extractor-parse-error/);
    expect(calls).toBe(1); // the extractor stub is called once; retry policy (≤3) lives in extractPreferencesWithRetry
    expect((db.prepare("SELECT count(*) c FROM structured_rows WHERE row_kind='preference'").get() as any).c).toBe(0);
    // Note hash reset: the next pass re-processes (never cached as current).
    const hash = (db.prepare('SELECT note_hash FROM notes WHERE path = ?').get(note) as any).note_hash;
    expect(hash).toBe('');
    db.close();
  });

});

describe('C4 fixture: composer prefs section (40-row relevance cap, retrieval-scoped)', () => {
  function hit(notePath: string, text: string, score = 0.5): RetrievalHit {
    return { notePath, chunkId: 1, headingPath: '', text, score, reason: 'semantic' };
  }
  function mkPrefRow(i: number): any {
    return {
      id: i + 1,
      rowKind: 'preference',
      sourcePath: 'notes/a.md',
      sourceChunkId: 1,
      sourceHash: 'h',
      scope: 'global',
      extractionVersion: 'prefs-v1',
      validFrom: i % 2 === 0 ? '2026-03-10' : null,
      validTo: null,
      payload: { statement: i % 3 === 0 ? `always eat vegetarian on day ${i}` : `unrelated habit ${i}`, kind: 'like' },
      dedupeKey: `pref|habit ${i}`,
    };
  }

  it('caps prefs at 40 rows with retrieval-scoped relevance ranking (N15: not a bigger cap)', async () => {
    const { composeQueryContext } = await import('../../src/context/composer.js');
    const ctx = composeQueryContext({
      query: 'vegetarian',
      hits: [hit('notes/a.md', 'vegetarian food', 0.9)],
      rows: Array.from({ length: 55 }, (_, i) => mkPrefRow(i)),
    }, { budgetTokens: 100000 });
    const prefs = ctx.sections.find((s) => s.name === 'prefs')!;
    expect(prefs.rowCount).toBe(40); // 40-row cap stands
    // Relevance-ranked: vegetarian-matching rows lead, and ranking is not flat
    // first-seen truncation — vegetarian rows from across the corpus survive.
    for (const i of [0, 3, 6, 51, 54]) {
      expect(prefs.text).toContain(`vegetarian on day ${i}`);
    }
    // Apply-contract instruction (stronger than the chronicle cite-contract).
    expect(prefs.text).toContain('apply the matching entry to your answer as a standing rule');
    expect(prefs.text).toContain('use the excerpts instead');
    expect(ctx.includedSections).toContain('prefs');
  });

  it('kind is render-only: an unknown kind value renders verbatim and never gates composition', async () => {
    const { composeQueryContext } = await import('../../src/context/composer.js');
    const ctx = composeQueryContext({
      query: 'coffee',
      hits: [hit('notes/a.md', 'coffee', 0.9)],
      rows: [
        {
          id: 1, rowKind: 'preference', sourcePath: 'notes/a.md', sourceChunkId: 1, sourceHash: 'h',
          scope: 'global', extractionVersion: 'prefs-v1', validFrom: null, validTo: null,
          payload: { statement: 'prefers oat milk', kind: 'not-a-real-kind' },
          dedupeKey: 'pref|prefers oat milk', confirmCount: 1,
        },
      ],
    }, { budgetTokens: 100000 });
    expect(ctx.includedSections).toContain('prefs'); // unknown kind never gates behavior
  });

  it('drops the whole prefs section FIRST on budget overflow (declared drop order)', async () => {
    const { composeQueryContext } = await import('../../src/context/composer.js');
    const bigText = 'x'.repeat(4000);
    const rows: StoredStructuredRow[] = [
      {
        id: 1, rowKind: 'preference', sourcePath: 'notes/a.md', sourceChunkId: 1, sourceHash: 'h',
        scope: 'global', extractionVersion: 'prefs-v1', validFrom: '2026-03-10', validTo: null,
        payload: { statement: 'always eat vegetarian', kind: 'like' }, dedupeKey: 'pref|always eat vegetarian', confirmCount: 1,
      },
      {
        id: 2, rowKind: 'fact', sourcePath: 'notes/a.md', sourceChunkId: 1, sourceHash: 'h',
        scope: 'global', extractionVersion: 'facts-v1', validFrom: '2026-03-10', validTo: null,
        payload: { value: '21.1', unit: 'km', verb: 'ran', object: 'distance' }, dedupeKey: 'fact|21 1|distance', confirmCount: 1,
      },
    ];
    const unbounded = composeQueryContext({
      query: 'marathon',
      hits: [hit('notes/a.md', bigText, 0.9)],
      rows,
    }, { budgetTokens: 1_000_000 });
    const tokensOf = (name: string) => unbounded.sections.find((s) => s.name === name)!.tokens;
    // Budget fits excerpts + facts (+ε) but NOT prefs → prefs must drop whole,
    // before facts (declared drop order: prefs drops FIRST).
    const budget = tokensOf('excerpts') + tokensOf('facts') + 10;
    const ctx = composeQueryContext({
      query: 'marathon',
      hits: [hit('notes/a.md', bigText, 0.9)],
      rows,
    }, { budgetTokens: budget });
    expect(ctx.droppedSections).toEqual(['prefs']);
    expect(ctx.includedSections).toContain('facts');
    expect(ctx.includedSections).not.toContain('prefs');
  });

  it('a raised section cap cannot flood context: the token budget still bounds total output', async () => {
    const { composeQueryContext } = await import('../../src/context/composer.js');
    const manyRows = Array.from({ length: 120 }, (_, i) => ({
      ...mkPrefRow(i),
      payload: { statement: `long standing habit number ${i} with plenty of words to burn budget`, kind: 'like' },
      dedupeKey: `pref|habit ${i}`,
    }));
    const budget = 900;
    const ctx = composeQueryContext({
      query: 'habit',
      hits: [hit('notes/a.md', 'habit note', 0.9)],
      rows: manyRows,
    }, { budgetTokens: budget, sectionCap: 500 }); // cap raised far past 40
    expect(ctx.usedTokens).toBeLessThanOrEqual(budget); // token budget enforced
    expect(ctx.droppedSections).toContain('prefs'); // whole-section drop, never a flood
  });
});
