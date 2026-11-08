import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { indexVault } from '../../src/indexer/pipeline';
import { replayLedger } from '../../src/memory/lifecycle';
import { closedLedgerEvents } from '../../src/retrieval/ledgerLiveness';
import {
  retrieveContext,
  orderHits,
  resolveSessionExpand,
  SESSION_EXPAND_DEFAULT_NOTES,
  SESSION_EXPAND_DEFAULT_TOKENS,
  SESSION_EXPAND_DOCUMENT_MAX_CHUNK_TOKENS,
  SESSION_EXPAND_MAX_CHUNK_TOKENS,
  type RetrievalHit,
} from '../../src/retrieval/orchestrator';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { removeTestDir } from '../helpers/removeDb';

/**
 * RENOR_SESSION_EXPAND: the deterministic expansion of what retrieval already found (the PageIndex scout's R2,
 * 2026-10-03). Retrieval finds the right session but not the short statement in it that carries the answer; the
 * expansion adds the statements (whole sections of at most 200 tokens) of the best notes in the window, under a token
 * budget, and leaves the window as it was. Built through the real indexer from notes shaped like the benchmark's chat
 * sessions, with the deterministic eval-hash embeddings: nothing here depends on a model.
 *
 *   S1 "dive sites"   2023/05/10  the best match; its turn 3 is the short statement the window misses
 *   S2 "packing"      2023/05/20  the second match (and the newer session)
 *   S3 "sourdough"    2023/05/25  unrelated
 */

const tmpDirs: string[] = [];
const ENV_KEYS = ['RENOR_SESSION_EXPAND', 'RENOR_SESSION_EXPAND_TOKENS', 'RENOR_SESSION_EXPAND_STATEMENT_TOKENS', 'RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS', 'RENOR_NEWEST_FIRST', 'RENOR_TEMPORAL_RANKING', 'RENOR_TEMPORAL_ASOF', 'RENOR_SESSION_DIVERSITY'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

const openDbs: Array<ReturnType<typeof openDb>> = [];
afterEach(() => {
  try {
    for (const db of openDbs.splice(0)) db.close();
    for (const d of tmpDirs.splice(0)) removeTestDir(d);
  } finally {
    // The environment is restored even when a removal throws, so the next test does not inherit this one's flags.
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
}

/** The expansion is on at five notes unless this says otherwise: 0 is how an operator turns it off. */
const OFF = { RENOR_SESSION_EXPAND: '0' };

/** The benchmark harness's session rendering (scripts/eval/run-longmemeval-product.ts renderSession). */
function session(id: string, date: string, turns: Array<['User' | 'Assistant', string]>): string {
  const body = turns.map(([role, content], i) => `### Turn ${i + 1} — ${role}\n\n${content}`).join('\n\n');
  return `---\nkind: longmemeval-session\nsession_id: ${JSON.stringify(id)}\nsession_date: ${JSON.stringify(date)}\n---\n# Session ${id}\n\nTimestamp: ${date}\n\n${body}\n`;
}

/**
 * An assistant answer of `n` paragraphs of ~35 tokens. Nine make 200-400 tokens: one chunk (the chunker keeps a section
 * of <= 400 tokens whole), never a short one. Twelve go over 400, so the chunker cuts the section into pieces.
 */
function longAnswer(topic: string, n = 9): string {
  return Array.from({ length: n }, (_, i) =>
    `Option ${i + 1} for the ${topic}: plan a full morning there, check the current and the visibility report, book a local guide, and bring a spare mask and fins.`,
  ).join('\n\n');
}

const S1_DATE = '2023/05/10 (Wed) 09:00';
const S2_DATE = '2023/05/20 (Sat) 09:00';
const S3_DATE = '2023/05/25 (Thu) 09:00';
const EVIDENCE = 'By the way, I finished my rescue certification with Marta in April.';
/** The last paragraph of a section the chunker has to cut: a short chunk, but a fragment of a long answer. */
const TAIL = 'Last of all, rinse every piece of gear in fresh water after the trip.';
const QUERY = 'Which Caribbean reef dive sites should I visit?';

async function fixture(extra: (vault: string) => void = () => {}) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'session-expand-'));
  tmpDirs.push(vault);
  fs.mkdirSync(path.join(vault, 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Sessions', 's1.md'), session('s1', S1_DATE, [
    ['User', 'Which Caribbean reef dive sites should I visit on my trip?'],
    ['Assistant', longAnswer('Caribbean reef dive sites')],
    ['User', EVIDENCE],
    ['Assistant', 'Congratulations, that will help on the deeper wall dives.'],
    ['User', ''],
    ['Assistant', `${longAnswer('wall dives', 12)}\n\n${TAIL}`],
  ]));
  fs.writeFileSync(path.join(vault, 'Sessions', 's2.md'), session('s2', S2_DATE, [
    ['User', 'What should I pack for a Caribbean reef diving trip?'],
    ['Assistant', longAnswer('packing list for a reef trip')],
    ['User', 'My sister Ana is coming with us.'],
  ]));
  fs.writeFileSync(path.join(vault, 'Sessions', 's3.md'), session('s3', S3_DATE, [
    ['User', 'How long should sourdough bread proof overnight?'],
    ['Assistant', 'About twelve hours in the fridge works well for most sourdough.'],
    ['User', 'Thanks, the loaf came out great.'],
  ]));
  extra(vault);
  const db = openDb(path.join(vault, 'index.db'));
  openDbs.push(db);
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  return { db, vault, provider, vectorIndex };
}

async function indexed(extra?: (vault: string) => void) {
  const f = await fixture(extra);
  await indexVault(f.db, f.vault, { embeddingProvider: f.provider, vectorIndex: f.vectorIndex }, 2);
  // One clock for every call: the recency boost reads it, so two calls a millisecond apart score differently.
  const nowMs = Date.now();
  const retrieve = (query = QUERY, topK = 3, opts: Parameters<typeof retrieveContext>[7] = {}) =>
    retrieveContext(f.db, f.vectorIndex, f.provider, query, topK, [], { nowMs }, opts);
  return { ...f, retrieve };
}

const note = (name: string) => (h: { notePath: string }) => h.notePath.endsWith(`/Sessions/${name}.md`);
const expanded = (hits: RetrievalHit[]) => hits.filter(h => h.reason === 'session-expand');
const tokensOf = (db: Database.Database, chunkId: number) =>
  (db.prepare('SELECT token_count AS n FROM chunks WHERE id = ?').get(chunkId) as { n: number }).n;
const chunkWith = (db: Database.Database, text: string) =>
  db.prepare('SELECT id, token_count AS n FROM chunks WHERE text LIKE ?').get(`%${text}%`) as { id: number; n: number };

/** What resolveSessionExpand answers: the statement limit is the shipped one unless the test names it. */
const expansion = (notes: number, tokenBudget: number, statementTokens = SESSION_EXPAND_MAX_CHUNK_TOKENS, documentStatementTokens = SESSION_EXPAND_DOCUMENT_MAX_CHUNK_TOKENS) =>
  ({ notes, tokenBudget, statementTokens, documentStatementTokens });

describe('resolveSessionExpand', () => {
  it('is ON at five notes with the default budget and statement limit when RENOR_SESSION_EXPAND is unset or empty', () => {
    expect(SESSION_EXPAND_DEFAULT_NOTES).toBe(5);
    expect(SESSION_EXPAND_DEFAULT_TOKENS).toBe(2000);
    expect(SESSION_EXPAND_MAX_CHUNK_TOKENS).toBe(120);
    expect(SESSION_EXPAND_DOCUMENT_MAX_CHUNK_TOKENS).toBe(200);
    const on = { notes: 5, tokenBudget: 2000, statementTokens: 120, documentStatementTokens: 200 };
    expect(resolveSessionExpand({})).toEqual(on);
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: '' })).toEqual(on);
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: '  ' })).toEqual(on);
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_TOKENS: '800' })).toEqual(expansion(5, 800));
  });

  it('is OFF when RENOR_SESSION_EXPAND is 0, or names no note', () => {
    for (const raw of ['0', ' 0 ', '0.5', '-1', 'junk', 'off', 'false', 'Infinity']) {
      expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: raw }), raw).toBeNull();
    }
  });

  it('reads the number of notes and the token budget, with a default budget', () => {
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: '5' })).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS));
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_TOKENS: '' })).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS));
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: '3.9', RENOR_SESSION_EXPAND_TOKENS: '800' })).toEqual(expansion(3, 800));
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: '1' })).toEqual(expansion(1, SESSION_EXPAND_DEFAULT_TOKENS));
  });

  it('a budget that allows nothing turns the expansion off rather than guessing one', () => {
    for (const raw of ['0', '-5', 'junk', 'Infinity']) {
      expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_TOKENS: raw }), raw).toBeNull();
      expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_TOKENS: raw }), `unset notes, budget ${raw}`).toBeNull();
    }
  });

  it('reads the longest statement, and an unset, empty or blank value is the shipped limit', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: raw }), String(raw)).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS));
    }
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '100' })).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS, 100));
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: ' 80 ' })).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS, 80));
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '99.9' })).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS, 99));
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '1000' })).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS, 1000));
    // Independent of the other two settings.
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: '3', RENOR_SESSION_EXPAND_TOKENS: '800', RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '120' }))
      .toEqual(expansion(3, 800, 120));
  });

  it('reads the longest statement of a document apart from a conversation\'s: unset, empty or blank is the former limit of 200', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: raw }), String(raw)).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS));
    }
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: '100' })).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS, SESSION_EXPAND_MAX_CHUNK_TOKENS, 100));
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: ' 150.9 ', RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '80' }))
      .toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS, 80, 150));
  });

  it('a statement limit that admits nothing admits no statement of its class; both of them admitting nothing turn the expansion off', () => {
    for (const raw of ['0', '0.5', '-5', 'junk', 'Infinity', 'NaN']) {
      // Conversations admit nothing, documents keep their limit; and the other way round.
      expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: raw }), raw).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS, 0));
      expect(resolveSessionExpand({ RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: raw }), raw).toEqual(expansion(5, SESSION_EXPAND_DEFAULT_TOKENS, SESSION_EXPAND_MAX_CHUNK_TOKENS, 0));
      expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_STATEMENT_TOKENS: raw, RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: raw }), `both ${raw}`).toBeNull();
    }
  });

  it('a statement limit never turns the expansion on: 0 notes stays off', () => {
    expect(resolveSessionExpand({ RENOR_SESSION_EXPAND: '0', RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '100' })).toBeNull();
  });
});

describe('RENOR_SESSION_EXPAND unset: the expansion is on, at five notes', () => {
  it('adds the same statements as an explicit 5, byte for byte, with no variable set', async () => {
    const { retrieve } = await indexed();
    setEnv({ RENOR_SESSION_EXPAND: '5' });
    const explicit = await retrieve();
    setEnv({});
    const byDefault = await retrieve();
    expect(expanded(byDefault.hits).length).toBeGreaterThan(0);
    expect(JSON.stringify(byDefault)).toBe(JSON.stringify(explicit));
    // An empty value is no value: the default, not off.
    setEnv({ RENOR_SESSION_EXPAND: '' });
    expect(JSON.stringify(await retrieve())).toBe(JSON.stringify(explicit));
    // And 0 is the way out: nothing is added, and the window is what it is with the expansion unbuilt.
    setEnv(OFF);
    const off = await retrieve();
    expect(expanded(off.hits)).toEqual([]);
    expect(off.hits.length).toBeLessThan(byDefault.hits.length);
    for (const hit of off.hits) expect(byDefault.hits).toContainEqual(hit);
  });
});

describe('RENOR_SESSION_EXPAND off: retrieval is exactly what it was', () => {
  it('0, junk, negative, a zero budget or a limit that admits nothing all return the same window, byte for byte', async () => {
    const { retrieve } = await indexed();
    setEnv(OFF);
    const base = await retrieve();
    expect(base.hits).toHaveLength(3);
    expect(expanded(base.hits)).toEqual([]);
    const variants: Array<Record<string, string>> = [
      { RENOR_SESSION_EXPAND: ' 0 ' },
      { RENOR_SESSION_EXPAND: 'junk' },
      { RENOR_SESSION_EXPAND: '-2' },
      { RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_TOKENS: '0' },
      { RENOR_SESSION_EXPAND_TOKENS: '0' },
      { RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '0', RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: '0' },
      { RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_STATEMENT_TOKENS: 'junk', RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: 'junk' },
    ];
    for (const env of variants) {
      setEnv(env);
      expect(JSON.stringify(await retrieve()), JSON.stringify(env)).toBe(JSON.stringify(base));
    }
  });

  it('costs nothing when off: no statement over chunk sizes is prepared (and one is when it is on, unset included)', async () => {
    const { db, retrieve } = await indexed();
    const prepare = vi.spyOn(db, 'prepare');
    const sizeQueries = () => prepare.mock.calls.filter(([sql]) => /PARTITION BY note_path, heading_path/.test(String(sql))).length;
    setEnv(OFF);
    await retrieve();
    expect(sizeQueries()).toBe(0);
    setEnv({ RENOR_SESSION_EXPAND: '2' });
    await retrieve();
    expect(sizeQueries()).toBe(1);
    setEnv({});
    await retrieve();
    expect(sizeQueries()).toBe(2);
    prepare.mockRestore();
  });
});

describe('RENOR_SESSION_EXPAND on: the short statements of the best notes join the window', () => {
  it('adds the short turn of the best session that the window missed, and keeps every window hit as it was', async () => {
    const { db, retrieve } = await indexed();
    setEnv(OFF);
    const off = await retrieve();
    // Precondition: the window found the session (its best chunk leads) but not the statement that answers.
    expect(off.hits.some(note('s1'))).toBe(true);
    expect(off.hits.some(h => h.text.includes(EVIDENCE))).toBe(false);

    setEnv({ RENOR_SESSION_EXPAND: '1' });
    const on = await retrieve();
    const added = expanded(on.hits);
    const evidence = added.find(h => h.text.includes(EVIDENCE));
    expect(evidence).toBeDefined();
    expect(evidence).toMatchObject({ score: 0, reason: 'session-expand', session_date: S1_DATE });
    expect(evidence!.chunkId).toBe(chunkWith(db, EVIDENCE).id);
    expect(evidence!.headingPath).toMatch(/Turn 3 — User$/);
    // A union: every window hit is still there, unchanged, and nothing is there twice.
    for (const hit of off.hits) expect(on.hits).toContainEqual(hit);
    expect(on.hits.length).toBe(off.hits.length + added.length);
    expect(new Set(on.hits.map(h => h.chunkId)).size).toBe(on.hits.length);
    // The empty turn is a speaker stub, not a statement.
    expect(added.some(h => h.text.trim() === '### Turn 5 — User')).toBe(false);
  });

  it('expands only the best N notes of the window, and never adds a note the window did not hold', async () => {
    const { retrieve } = await indexed();
    setEnv(OFF);
    const off = await retrieve();
    const windowNotes = new Set(off.hits.map(h => h.notePath));
    setEnv({ RENOR_SESSION_EXPAND: '1' });
    const one = expanded((await retrieve()).hits);
    expect(one.length).toBeGreaterThan(0);
    expect(one.every(note('s1'))).toBe(true);
    setEnv({ RENOR_SESSION_EXPAND: '2' });
    const two = expanded((await retrieve()).hits);
    expect(two.some(h => h.text.includes('My sister Ana is coming with us.'))).toBe(true);
    expect(two.some(note('s3'))).toBe(false);
    setEnv({ RENOR_SESSION_EXPAND: '50' });
    const all = expanded((await retrieve()).hits);
    for (const hit of all) expect(windowNotes.has(hit.notePath)).toBe(true);
  });

  it('adds only short chunks: a chunk over the size limit stays out even when its note is expanded', async () => {
    const { db, retrieve } = await indexed();
    const long = chunkWith(db, 'Option 1 for the packing list for a reef trip');
    expect(long.n).toBeGreaterThan(SESSION_EXPAND_MAX_CHUNK_TOKENS); // precondition: the fixture's long answer is long
    setEnv(OFF);
    expect((await retrieve()).hits.some(h => h.chunkId === long.id)).toBe(false); // and the window misses it
    setEnv({ RENOR_SESSION_EXPAND: '2', RENOR_SESSION_EXPAND_TOKENS: '100000' });
    const added = expanded((await retrieve()).hits);
    expect(added.some(note('s2'))).toBe(true);
    expect(added.some(h => h.chunkId === long.id)).toBe(false);
    for (const hit of added) expect(tokensOf(db, hit.chunkId)).toBeLessThanOrEqual(SESSION_EXPAND_MAX_CHUNK_TOKENS);
  });

  it('adds whole sections only: a short paragraph cut from a long answer is a fragment and stays out', async () => {
    const { db, retrieve } = await indexed();
    const tail = chunkWith(db, TAIL);
    expect(tail.n).toBeLessThanOrEqual(SESSION_EXPAND_MAX_CHUNK_TOKENS); // precondition: short...
    const pieces = (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE heading_path = (SELECT heading_path FROM chunks WHERE id = ?)')
      .get(tail.id) as { n: number }).n;
    expect(pieces).toBeGreaterThan(1); // ...and one of several pieces of one section
    setEnv({ RENOR_SESSION_EXPAND: '1', RENOR_SESSION_EXPAND_TOKENS: '100000' });
    const added = expanded((await retrieve()).hits);
    expect(added.some(h => h.text.includes(EVIDENCE))).toBe(true);
    expect(added.some(h => h.chunkId === tail.id)).toBe(false);
    for (const hit of added) {
      const sharing = (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE note_path = ? AND heading_path = ?').get(hit.notePath, hit.headingPath) as { n: number }).n;
      expect(sharing).toBe(1);
    }
  });

  it('spends the budget on the best note first and never past it (the newer session waits its turn)', async () => {
    const { db, retrieve } = await indexed();
    setEnv({ RENOR_SESSION_EXPAND: '1', RENOR_SESSION_EXPAND_TOKENS: '100000' });
    const s1Only = expanded((await retrieve()).hits);
    const s1Tokens = s1Only.reduce((sum, h) => sum + tokensOf(db, h.chunkId), 0);
    expect(s1Only.length).toBeGreaterThan(1);

    // Two notes, a budget that holds exactly the best note's statements: the second note gets none of it,
    // although its session is newer and is laid out first.
    setEnv({ RENOR_SESSION_EXPAND: '2', RENOR_SESSION_EXPAND_TOKENS: String(s1Tokens) });
    const exact = expanded((await retrieve()).hits);
    expect(exact.map(h => h.chunkId).sort()).toEqual(s1Only.map(h => h.chunkId).sort());

    // One token less: the expansion is the longest run of the best note's statements, in note order, that fits.
    setEnv({ RENOR_SESSION_EXPAND: '2', RENOR_SESSION_EXPAND_TOKENS: String(s1Tokens - 1) });
    const short = expanded((await retrieve()).hits);
    const inNoteOrder = [...s1Only].sort((a, b) => a.chunkId - b.chunkId);
    expect(short.map(h => h.chunkId).sort((a, b) => a - b)).toEqual(inNoteOrder.slice(0, -1).map(h => h.chunkId));

    for (const budget of [1, 20, 60, 150, 400]) {
      setEnv({ RENOR_SESSION_EXPAND: '3', RENOR_SESSION_EXPAND_TOKENS: String(budget) });
      const added = expanded((await retrieve()).hits);
      expect(added.reduce((sum, h) => sum + tokensOf(db, h.chunkId), 0)).toBeLessThanOrEqual(budget);
    }
  });

  it('leaves get_context\'s relevance signal to the window: an added hit carries no similarity', async () => {
    const { retrieve } = await indexed();
    setEnv(OFF);
    const off = await retrieve(QUERY, 3, { probe: {} });
    // Precondition: with a probe, the window's semantic hits carry their raw cosine (what the signal reads).
    expect(off.hits.length).toBeGreaterThan(0);
    expect(off.hits.every(h => typeof h.similarity === 'number')).toBe(true);
    setEnv({ RENOR_SESSION_EXPAND: '2' });
    const on = await retrieve(QUERY, 3, { probe: {} });
    for (const hit of off.hits) expect(on.hits).toContainEqual(hit);
    expect(expanded(on.hits).length).toBeGreaterThan(0);
    expect(expanded(on.hits).every(h => h.similarity === undefined)).toBe(true);
  });

  it('keeps the layout claim true: hits are in order of rankedBy, and by score the window comes first', async () => {
    const { retrieve } = await indexed();
    setEnv({ RENOR_SESSION_EXPAND: '2' });
    const newest = await retrieve();
    expect(newest.rankedBy).toBe('session_date');
    expect(newest.hits).toEqual(orderHits(newest.hits, 'session_date'));
    // The newer session (S2) leads; inside one session, the matched chunks come before the added ones.
    expect(note('s2')(newest.hits[0])).toBe(true);

    setEnv({ RENOR_SESSION_EXPAND: '2', RENOR_NEWEST_FIRST: '0' });
    const byScore = await retrieve();
    expect(byScore.rankedBy).toBe('score');
    expect(byScore.hits).toEqual(orderHits(byScore.hits, 'score'));
    const firstAdded = byScore.hits.findIndex(h => h.reason === 'session-expand');
    expect(firstAdded).toBeGreaterThan(0);
    expect(byScore.hits.slice(firstAdded).every(h => h.reason === 'session-expand')).toBe(true);
  });
});

/**
 * RENOR_SESSION_EXPAND_STATEMENT_TOKENS: the longest statement the expansion adds (unset is SESSION_EXPAND_MAX_CHUNK_TOKENS).
 * A section over it is skipped whole, never cut, and what comes after it still counts; nothing else about retrieval moves.
 */
describe('RENOR_SESSION_EXPAND_STATEMENT_TOKENS: the longest statement the expansion adds', () => {
  /** A statement of `n` log sentences (about 17 tokens each); the tag keeps the statements' first 80 characters apart. */
  const log = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => `The ${tag} dive log, entry ${i + 1}, notes the reef current and the visibility.`).join(' ');
  const TAGS = { long: 'amber', short: 'basalt', medium: 'cobalt', longer: 'dune', shorter: 'ember' } as const;

  /**
   * One session and nothing else: the question the query repeats (the only chunk the window holds at top_k 1), then five
   * statements of different sizes in document order long, short, medium, longer, shorter: a long one before the short ones,
   * and a longer one between them. Their sizes are read back from the index, never assumed.
   */
  async function sized() {
    const f = await indexed(vault => {
      for (const name of ['s1', 's2', 's3']) fs.rmSync(path.join(vault, 'Sessions', `${name}.md`));
      fs.writeFileSync(path.join(vault, 'Sessions', 's4.md'), session('s4', S1_DATE, [
        ['User', QUERY],
        ['Assistant', log(TAGS.long, 8)],
        ['User', log(TAGS.short, 1)],
        ['Assistant', log(TAGS.medium, 5)],
        ['User', log(TAGS.longer, 10)],
        ['Assistant', log(TAGS.shorter, 2)],
      ]));
    });
    const own = Object.fromEntries(Object.entries(TAGS).map(([name, tag]) => [name, chunkWith(f.db, `The ${tag} dive log, entry 1,`)])) as
      Record<keyof typeof TAGS, { id: number; n: number }>;
    const ownIds = new Set(Object.values(own).map(c => c.id));
    /** The question's retrieval with the expansion on at the best note, the budget out of the way unless one is named. */
    const run = (limit?: number, budget = 100000) => {
      setEnv({
        RENOR_SESSION_EXPAND: '1',
        RENOR_SESSION_EXPAND_TOKENS: String(budget),
        ...(limit === undefined ? {} : { RENOR_SESSION_EXPAND_STATEMENT_TOKENS: String(limit) }),
      });
      return f.retrieve(QUERY, 1);
    };
    const added = async (limit?: number, budget?: number) => expanded((await run(limit, budget)).hits);
    const ids = (hits: RetrievalHit[]) => hits.map(h => h.chunkId).sort((a, b) => a - b);
    const mine = (hits: RetrievalHit[]) => ids(hits).filter(id => ownIds.has(id));
    const asc = (...chunks: Array<{ id: number }>) => chunks.map(c => c.id).sort((a, b) => a - b);
    return { ...f, own, run, added, ids, mine, asc };
  }

  it('adds the statements at or under the limit and skips the longer ones, wherever they sit in the note', async () => {
    const { db, retrieve, own, added, mine, asc } = await sized();
    const { long, short, medium, longer, shorter } = own;
    // Preconditions: the sizes the claims below reason about, and a window that holds only the question.
    const sizes = [short.n, shorter.n, medium.n, long.n, longer.n];
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(5);
    expect(medium.n).toBeLessThan(100);
    expect(long.n).toBeGreaterThan(100);
    expect(longer.n).toBeLessThan(200); // so that 200, the former default, still adds all five
    setEnv(OFF);
    expect((await retrieve(QUERY, 1)).hits.map(h => h.chunkId)).toEqual([chunkWith(db, QUERY).id]);

    // The shipped limit adds the statements within it, and 200, the limit it replaced, adds all five.
    expect(mine(await added())).toEqual(asc(...[long, short, medium, longer, shorter].filter(c => c.n <= SESSION_EXPAND_MAX_CHUNK_TOKENS)));
    expect(mine(await added(200))).toEqual(asc(long, short, medium, longer, shorter));
    // A limit of 100: the two over it are skipped, and the short ones after the long one, and after the longer one, still come.
    expect(mine(await added(100))).toEqual(asc(short, medium, shorter));
    // At the limit: a statement of exactly that many tokens is in, one token less and it is out.
    expect(mine(await added(medium.n))).toContain(medium.id);
    expect(mine(await added(medium.n - 1))).toEqual(asc(short, shorter));
    expect(mine(await added(long.n))).toEqual(asc(long, short, medium, shorter));
    expect(mine(await added(short.n - 1))).toEqual([]);

    // Whatever is added is a whole statement within the limit: the chunk's own text, never a cut of it.
    for (const limit of [30, 50, 100, 150, 200, undefined]) {
      for (const hit of await added(limit)) {
        expect(tokensOf(db, hit.chunkId), `limit ${limit}`).toBeLessThanOrEqual(limit ?? SESSION_EXPAND_MAX_CHUNK_TOKENS);
        expect(hit.text, `limit ${limit}`).toBe((db.prepare('SELECT text FROM chunks WHERE id = ?').get(hit.chunkId) as { text: string }).text);
      }
    }
  });

  it('changes only what is added: the window, its order and its scores are what they were', async () => {
    const { retrieve, run } = await sized();
    setEnv(OFF);
    const off = await retrieve(QUERY, 1);
    expect(off.hits).toHaveLength(1);
    for (const limit of [undefined, 150, 100, 60]) {
      const on = await run(limit);
      expect(on.hits.some(h => h.reason === 'session-expand'), `limit ${limit}`).toBe(true);
      expect(JSON.stringify(on.hits.filter(h => h.reason !== 'session-expand')), `limit ${limit}`).toBe(JSON.stringify(off.hits));
      expect(on.rankedBy).toBe(off.rankedBy);
    }
  });

  it('is the shipped limit when unset or empty, byte for byte', async () => {
    const { retrieve } = await indexed();
    setEnv({ RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_STATEMENT_TOKENS: String(SESSION_EXPAND_MAX_CHUNK_TOKENS) });
    const explicit = await retrieve();
    expect(expanded(explicit.hits).length).toBeGreaterThan(0);
    setEnv({});
    expect(JSON.stringify(await retrieve())).toBe(JSON.stringify(explicit));
    setEnv({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '' });
    expect(JSON.stringify(await retrieve())).toBe(JSON.stringify(explicit));
  });

  it('does not charge a skipped statement to the budget: the expansion is the longest run of the statements within the limit', async () => {
    const { db, own, added, ids, asc } = await sized();
    const within = ids(await added(100)); // the note's preamble chunk, then the three statements within 100, in document order
    expect(within.slice(1)).toEqual(asc(own.short, own.medium, own.shorter));
    expect(within).toHaveLength(4);
    expect(within[0]).toBeLessThan(own.long.id); // the preamble comes first in the note, before the skipped long statement
    const [preamble, short] = within;
    const budget = tokensOf(db, preamble) + tokensOf(db, short);
    // A budget for the preamble and `short` only: `long` sits between them in the note and is not paid for.
    expect(ids(await added(100, budget))).toEqual([preamble, short]);
    expect(ids(await added(100, budget - 1))).toEqual([preamble]);
    // A limit that admits `long` (200) has it between them: it is paid for first, and `short` no longer fits.
    expect(ids(await added(200, budget))).toEqual([preamble]);
  });

  it('a higher limit adds the sections the shipped limit leaves out: a whole section of up to 400 tokens is one chunk', async () => {
    const { db, retrieve } = await indexed();
    const long = chunkWith(db, 'Option 1 for the packing list for a reef trip');
    expect(long.n).toBeGreaterThan(SESSION_EXPAND_MAX_CHUNK_TOKENS); // precondition
    expect(long.n).toBeLessThanOrEqual(400);
    setEnv({ RENOR_SESSION_EXPAND: '2', RENOR_SESSION_EXPAND_TOKENS: '100000' });
    expect(expanded((await retrieve()).hits).some(h => h.chunkId === long.id)).toBe(false);
    // s2 has three turns, so it is a document under the shape rule (conversationShape.ts): its limit is the document one.
    setEnv({ RENOR_SESSION_EXPAND: '2', RENOR_SESSION_EXPAND_TOKENS: '100000', RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: '400' });
    expect(expanded((await retrieve()).hits).some(h => h.chunkId === long.id)).toBe(true);
  });
});

describe('the statement limit follows the shape of the note: a conversation is limited to 120 tokens, a document keeps 200', () => {
  /** A statement of `n` log sentences (about 17 tokens each), the tag keeping the statements apart. */
  const log = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => `The ${tag} dive log, entry ${i + 1}, notes the reef current and the visibility.`).join(' ');
  const TAGS = { short: 'basalt', mid: 'cobalt', long: 'dune' } as const;
  const TEXT = { short: log(TAGS.short, 1), mid: log(TAGS.mid, 8), long: log(TAGS.long, 14) };

  /** The same three statements in a note of turn headings (a conversation) and in one of topic headings (a document). */
  const chat = () => session('s4', S1_DATE, [['User', QUERY], ['Assistant', TEXT.short], ['User', TEXT.mid], ['Assistant', TEXT.long]]);
  const doc = (front = '') =>
    `${front}# Dive log\n\n${QUERY}\n\n## Basalt notes\n\n${TEXT.short}\n\n## Cobalt notes\n\n${TEXT.mid}\n\n## Dune notes\n\n${TEXT.long}\n`;

  async function shaped(content: string) {
    const f = await indexed(vault => {
      for (const name of ['s1', 's2', 's3']) fs.rmSync(path.join(vault, 'Sessions', `${name}.md`));
      fs.writeFileSync(path.join(vault, 'Sessions', 's4.md'), content);
    });
    // The statements this note holds (a shorter note lacks the last one), read back from the index.
    const own = Object.fromEntries(Object.entries(TAGS).flatMap(([name, tag]) => {
      const chunk = chunkWith(f.db, `The ${tag} dive log, entry 1,`);
      return chunk ? [[name, chunk]] : [];
    })) as Record<keyof typeof TAGS, { id: number; n: number }>;
    /** Which of the three statements the expansion adds to the question's one-chunk window, with the budget out of the way. */
    const added = async (env: Record<string, string> = {}) => {
      setEnv({ RENOR_SESSION_EXPAND: '1', RENOR_SESSION_EXPAND_TOKENS: '100000', ...env });
      const ids = new Set(expanded((await f.retrieve(QUERY, 1)).hits).map(h => h.chunkId));
      return (Object.keys(own) as Array<keyof typeof TAGS>).filter(name => ids.has(own[name].id));
    };
    return { ...f, own, added };
  }

  it('limits the conversation to 120 tokens and lets the document keep up to 200, from the same three statements', async () => {
    for (const [kind, content] of [['conversation', chat()], ['document', doc()]] as const) {
      const { own, added } = await shaped(content);
      // Preconditions: a statement within 100, one between 120 and 200, one over 200 (and in one chunk, so within 400):
      // mid is over the conversation's 120 and inside the document's 200, which is the difference this test reads.
      expect(own.short.n, kind).toBeLessThanOrEqual(100);
      expect(own.mid.n, kind).toBeGreaterThan(120);
      expect(own.mid.n, kind).toBeLessThanOrEqual(200);
      expect(own.long.n, kind).toBeGreaterThan(200);
      expect(own.long.n, kind).toBeLessThanOrEqual(400);
      expect(await added(), kind).toEqual(kind === 'conversation' ? ['short'] : ['short', 'mid']);
    }
  });

  it('each limit moves only its class: the document limit does not touch a conversation, and the conversation limit not a document', async () => {
    const c = await shaped(chat());
    // The conversation keeps its own 120-token limit whatever the document's is: mid, over 120, stays out.
    expect(await c.added({ RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: '100' })).toEqual(['short']);
    expect(await c.added({ RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: '400' })).toEqual(['short']);
    expect(await c.added({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '200' })).toEqual(['short', 'mid']);
    expect(await c.added({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '400' })).toEqual(['short', 'mid', 'long']);
    expect(await c.added({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '0' })).toEqual([]);
    const d = await shaped(doc());
    // A document is limited to 200, so its mid is in; the conversation limit does not reach a document at all.
    expect(await d.added({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '60' })).toEqual(['short', 'mid']);
    expect(await d.added({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '400' })).toEqual(['short', 'mid']);
    expect(await d.added({ RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: '100' })).toEqual(['short']);
    expect(await d.added({ RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: '400' })).toEqual(['short', 'mid', 'long']);
    expect(await d.added({ RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: '0' })).toEqual([]);
  });

  it('with both limits at 200 it is the former behaviour, and with both at 100 it caps every note (the pull request as first written)', async () => {
    for (const content of [chat(), doc()]) {
      const f = await shaped(content);
      expect(await f.added({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '200', RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: '200' })).toEqual(['short', 'mid']);
      expect(await f.added({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '100', RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS: '100' })).toEqual(['short']);
    }
  });

  it('tells the shape from the headings, not from front matter: a document marked as a chat keeps 200, a chat without front matter is capped', async () => {
    const marked = await shaped(doc('---\nkind: chat-session\nsource: chatgpt\n---\n'));
    expect(await marked.added()).toEqual(['short', 'mid']);
    const bare = await shaped(chat().replace(/^---[\s\S]*?---\n/, ''));
    expect(await bare.added()).toEqual(['short']);
  });

  it('a conversation of fewer turns than the minimum is a document: the limit is only for notes it was measured on', async () => {
    const three = session('s4', S1_DATE, [['User', QUERY], ['Assistant', TEXT.short], ['User', TEXT.mid]]);
    const { added, own } = await shaped(three);
    expect(own.mid.n).toBeGreaterThan(100);
    expect(await added()).toEqual(['short', 'mid']);
  });
});

describe('RENOR_SESSION_EXPAND and the memory ledger', () => {
  const LEDGER = 'System/Memory Events Ledger.md';
  const event = (id: string, at: string, subject: string, predicate: string, object: string) =>
    `\n## ${id} · ${at}\n- kind: store\n- subject: ${subject}\n- predicate: ${predicate}\n- object: ${object}\n- source: test\n`;

  it('never adds a ledger event: a superseded one would come back as live, and no other event is a statement of a session', async () => {
    const f = await fixture(vault => {
      fs.mkdirSync(path.join(vault, 'System'), { recursive: true });
      // A header that the query matches, so the ledger is among the notes the window holds through a hit that is no
      // event: the one way the ledger can be among the notes expanded.
      fs.writeFileSync(path.join(vault, LEDGER),
        '---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Memory Events Ledger\n\nWhich Caribbean reef dive sites to visit, and what I should pack.\n'
        + event('MEM_CLUBOLD1', '2026-01-05T09:00:00.000Z', 'book club', 'meets_on', 'Tuesday')
        + event('MEM_CLUBNEW2', '2026-03-15T09:00:00.000Z', 'book club', 'meets_on', 'Thursday')
        + event('MEM_OTHER3', '2026-03-20T09:00:00.000Z', 'offsite', 'city', 'Lisbon'));
    });
    await replayLedger(f.db, f.vault, LEDGER);
    await indexVault(f.db, f.vault, { embeddingProvider: f.provider, vectorIndex: f.vectorIndex }, 2);
    expect(closedLedgerEvents(f.db).has('mem_clubold1')).toBe(true); // precondition: the old event is closed
    const clock = { nowMs: Date.now() };
    const fromLedger = (h: RetrievalHit) => h.notePath.endsWith(LEDGER);
    setEnv(OFF);
    const off = await retrieveContext(f.db, f.vectorIndex, f.provider, QUERY, 4, [], clock);
    // Precondition: the ledger is in the window through its header, and through no event.
    expect(off.hits.some(h => fromLedger(h) && !h.text.includes('## MEM_'))).toBe(true);
    expect(off.hits.some(h => h.text.includes('## MEM_'))).toBe(false);

    setEnv({ RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_TOKENS: '100000' });
    const on = await retrieveContext(f.db, f.vectorIndex, f.provider, QUERY, 4, [], clock);
    const added = expanded(on.hits);
    expect(added.some(note('s1'))).toBe(true); // the sessions are still expanded
    expect(on.hits.some(h => h.text.includes('## MEM_'))).toBe(false);
    expect(added.some(fromLedger)).toBe(false);
  });

  it('an event in the window does not make the ledger a session: its header is not added', async () => {
    const f = await fixture(vault => {
      fs.mkdirSync(path.join(vault, 'System'), { recursive: true });
      fs.writeFileSync(path.join(vault, LEDGER),
        '---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Memory Events Ledger\n\nAppend-only durable record of memory events. Replayed on rebuild.\n'
        + event('MEM_TRIP1', '2026-03-15T09:00:00.000Z', 'next trip', 'destination', 'Caribbean reef dive sites in Bonaire'));
    });
    await replayLedger(f.db, f.vault, LEDGER);
    await indexVault(f.db, f.vault, { embeddingProvider: f.provider, vectorIndex: f.vectorIndex }, 2);
    const clock = { nowMs: Date.now() };
    const fromLedger = (h: RetrievalHit) => h.notePath.endsWith(LEDGER);
    setEnv(OFF);
    const off = await retrieveContext(f.db, f.vectorIndex, f.provider, QUERY, 4, [], clock);
    // Precondition: the ledger is in the window through an event, and its header is not.
    expect(off.hits.some(h => fromLedger(h) && h.text.includes('## MEM_TRIP1'))).toBe(true);
    expect(off.hits.some(h => fromLedger(h) && !h.text.includes('## MEM_'))).toBe(false);

    setEnv({ RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_TOKENS: '100000' });
    const on = await retrieveContext(f.db, f.vectorIndex, f.provider, QUERY, 4, [], clock);
    expect(expanded(on.hits).some(note('s1'))).toBe(true);
    expect(expanded(on.hits).some(fromLedger)).toBe(false);
    expect(on.hits.some(h => h.text.includes('Append-only durable record'))).toBe(false);
  });
});
