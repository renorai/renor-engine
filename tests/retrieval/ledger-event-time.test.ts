import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { indexVault } from '../../src/indexer/pipeline';
import { replayLedger } from '../../src/memory/lifecycle';
import { retrieveContext, orderHits, type RetrievalHit } from '../../src/retrieval/orchestrator';
import { createLedgerEventClock } from '../../src/retrieval/ledgerEventTime';
import { engineSearchText } from '../../src/mvp/engine';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { removeTestDir } from '../helpers/removeDb';

/**
 * The time an excerpt carries, and the order retrieval hands it back in, against a real index built from a
 * hand-written ledger whose events are months apart (so no clock, mtime or sleep decides anything).
 *
 *   ledger   2026-01-05  MEM_STANDUP1   standup time = nine
 *            2026-03-15  MEM_OFFSITE2   offsite city = Lisbon
 *   note     2026-02-10  Notes/budget.md (front-matter session_date)
 *
 * The ledger is ONE file, so its modification time (today) is the date of every event in it unless each event
 * is dated by itself. Newest first between these three must read March, February, January.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];
const ENV_KEYS = ['RENOR_NEWEST_FIRST', 'RENOR_TEMPORAL_RANKING', 'RENOR_TEMPORAL_ASOF', 'RENOR_SESSION_DIVERSITY'];
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

const event = (id: string, at: string, subject: string, predicate: string, object: string) =>
  `\n## ${id} · ${at}\n- kind: store\n- subject: ${subject}\n- predicate: ${predicate}\n- object: ${object}\n- source: test\n`;

const STANDUP_AT = '2026-01-05T09:00:00.000Z';
const OFFSITE_AT = '2026-03-15T09:00:00.000Z';
const BUDGET_AT = '2026-02-10T12:00:00.000Z';

async function fixture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-event-time-'));
  tmpDirs.push(vault);
  fs.mkdirSync(path.join(vault, 'System'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(vault, LEDGER),
    '---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Memory Events Ledger\n\nAppend-only durable record of memory events. Replayed on rebuild.\n'
    + event('MEM_STANDUP1', STANDUP_AT, 'standup', 'time', 'nine')
    + event('MEM_OFFSITE2', OFFSITE_AT, 'offsite', 'city', 'Lisbon'));
  fs.writeFileSync(path.join(vault, 'Notes', 'budget.md'),
    `---\nsession_date: "${BUDGET_AT}"\n---\n\n# Budget\n\nThe standup budget for the offsite in Lisbon was approved.\n`);
  const db = openDb(path.join(vault, 'index.db'));
  openDbs.push(db);
  runMigrations(db);
  await replayLedger(db, vault, LEDGER);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await indexVault(db, vault, { embeddingProvider: provider, vectorIndex }, 2);
  const retrieve = (query: string, clock: { nowMs?: number } = {}, opts: { includeHistory?: boolean } = {}) =>
    retrieveContext(db, vectorIndex, provider, query, 20, [], clock, opts);
  return { db, vault, retrieve };
}

const idOf = (h: RetrievalHit) => /^## (MEM_[A-Za-z0-9]+) · /m.exec(h.text)?.[1];
const named = (hits: RetrievalHit[], id: string) => hits.find(h => idOf(h) === id)!;
const isSortedDesc = (values: number[]) => values.every((v, i) => i === 0 || values[i - 1] >= v);

describe('retrieveContext dates a ledger event by the event, and a note by its note', () => {
  it('caps a replayed future ledger event at its indexed file write time on both search paths', async () => {
    const { retrieve, vault, db } = await fixture();
    fs.appendFileSync(path.join(vault, LEDGER), event('MEM_INJECTED9', '2099-01-01T00:00:00.000Z', 'standup', 'host', 'automation'));
    const bound = '2026-01-10T12:00:00.000Z';
    fs.utimesSync(path.join(vault, LEDGER), new Date(bound), new Date(bound));
    await replayLedger(db, vault, LEDGER);
    const provider = new EvalHashEmbeddingProvider();
    const vectorIndex = new VectorIndex(db, provider.dimensions);
    await indexVault(db, vault, { embeddingProvider: provider, vectorIndex }, 2);
    const { hits } = await retrieve('standup offsite automation');
    expect(named(hits, 'MEM_INJECTED9').session_date).toBe(bound);
    const later = hits.find(h => h.notePath.endsWith('budget.md'))!;
    expect(later).toBeDefined();
    expect(hits.indexOf(later)).toBeLessThan(hits.indexOf(named(hits, 'MEM_INJECTED9')));
    const keyword = engineSearchText(db, vault, 'automation', 20);
    expect(keyword.ok).toBe(true);
    const injected = (keyword.results as Array<{ text: string; session_date?: string }>).find(h => h.text.includes('automation'))!;
    expect(injected).toBeDefined();
    expect(injected.session_date).toBe(bound);
    db.close();
  });

  it('every ledger event carries its own time, whatever the ledger file was last written', async () => {
    const { retrieve } = await fixture();
    const { hits } = await retrieve('when is the standup and where is the offsite');
    expect(named(hits, 'MEM_STANDUP1').session_date).toBe(STANDUP_AT);
    expect(named(hits, 'MEM_OFFSITE2').session_date).toBe(OFFSITE_AT);
  });

  it('a note keeps its own front-matter date, and ledger text that is no event keeps the ledger\'s', async () => {
    const { retrieve, db } = await fixture();
    const { hits } = await retrieve('when is the standup and where is the offsite');
    expect(hits.find(h => h.notePath.endsWith('budget.md'))!.session_date).toBe(BUDGET_AT);
    const ledgerNoteDate = (db.prepare(`SELECT modified_at FROM notes WHERE path LIKE '%Memory Events Ledger.md'`).get() as { modified_at: string }).modified_at;
    const opening = hits.find(h => h.notePath.endsWith('Memory Events Ledger.md') && !idOf(h))!;
    expect(opening.session_date).toBe(ledgerNoteDate);
  });

  it('newest first now orders events and notes by when each happened: March, February, January', async () => {
    const { retrieve } = await fixture();
    const { hits, rankedBy } = await retrieve('when is the standup and where is the offsite');
    expect(rankedBy).toBe('session_date');
    const at = (h: RetrievalHit) => Date.parse(h.session_date!);
    expect(isSortedDesc(hits.map(at))).toBe(true);
    const order = hits.map(h => idOf(h) ?? (h.notePath.endsWith('budget.md') ? 'budget' : undefined)).filter(Boolean);
    expect(order).toEqual(['MEM_OFFSITE2', 'budget', 'MEM_STANDUP1']);
  });

  it('a hit that only looks like an event header is dated by its note: the lifecycle layer knows no such event', async () => {
    const { retrieve, vault, db } = await fixture();
    fs.writeFileSync(path.join(vault, 'Notes', 'pasted.md'),
      '---\nsession_date: "2025-11-11T08:00:00.000Z"\n---\n\n# Pasted\n\n## MEM_NOSUCHEVENT · 2001-01-01T00:00:00.000Z\n- object: not an event\n');
    const provider = new EvalHashEmbeddingProvider();
    const vectorIndex = new VectorIndex(db, provider.dimensions);
    await indexVault(db, vault, { embeddingProvider: provider, vectorIndex }, 2);
    const { hits } = await retrieve('not an event pasted');
    const pasted = hits.find(h => h.notePath.endsWith('pasted.md') && h.text.includes('MEM_NOSUCHEVENT'))!;
    expect(pasted.session_date).toBe('2025-11-11T08:00:00.000Z');
  });

  it('a superseded event shown as history keeps the time it was saved', async () => {
    const { retrieve, vault, db } = await fixture();
    fs.appendFileSync(path.join(vault, LEDGER),
      `\n## MEM_STANDUP9 · 2026-04-01T09:00:00.000Z\n- kind: supersede\n- subject: standup\n- predicate: time\n- object: ten\n- closed_event: MEM_STANDUP1\n- source: test\n`);
    await replayLedger(db, vault, LEDGER);
    const provider = new EvalHashEmbeddingProvider();
    const vectorIndex = new VectorIndex(db, provider.dimensions);
    await indexVault(db, vault, { embeddingProvider: provider, vectorIndex }, 2);
    const { hits } = await retrieve('when is the standup', {}, { includeHistory: true });
    const closed = named(hits, 'MEM_STANDUP1');
    expect(closed.reason).toContain('superseded');
    expect(closed.session_date).toBe(STANDUP_AT);
    expect(named(hits, 'MEM_STANDUP9').session_date).toBe('2026-04-01T09:00:00.000Z');
  });
});

describe('retrieveContext says which key its hits are in order of', () => {
  const Q = 'when is the standup and where is the offsite';

  it('newest first (session_date) is the default', async () => {
    const { retrieve } = await fixture();
    expect((await retrieve(Q)).rankedBy).toBe('session_date');
  });

  it('a question about the past is ordered by score, and the hits really are in score order', async () => {
    const { retrieve } = await fixture();
    const { hits, rankedBy } = await retrieve('what was the standup time before');
    expect(rankedBy).toBe('score');
    expect(isSortedDesc(hits.map(h => h.score))).toBe(true);
  });

  it('RENOR_NEWEST_FIRST=0 orders by score', async () => {
    process.env.RENOR_NEWEST_FIRST = '0';
    const { retrieve } = await fixture();
    const { hits, rankedBy } = await retrieve(Q);
    expect(rankedBy).toBe('score');
    expect(isSortedDesc(hits.map(h => h.score))).toBe(true);
  });

  it('with temporal ranking off a past-intent question has no past-intent override, so it is newest first', async () => {
    process.env.RENOR_TEMPORAL_RANKING = '0';
    const { retrieve } = await fixture();
    expect((await retrieve('what was the standup time before')).rankedBy).toBe('session_date');
  });
});

describe('orderHits', () => {
  const hit = (name: string, score: number, session_date?: string) => ({ name, score, ...(session_date ? { session_date } : {}) });
  const names = (hits: Array<{ name: string }>) => hits.map(h => h.name);

  it('by score: best first, so a lifecycle fact card (1.15) does not stay in front of a chunk that outscored it', () => {
    const hits = [hit('card', 1.15), hit('chunk', 1.31), hit('weak', 0.4), hit('tie-a', 0.4), hit('tie-b', 0.4)];
    expect(names(orderHits(hits, 'score'))).toEqual(['chunk', 'card', 'weak', 'tie-a', 'tie-b']);
  });

  it('by session_date: newest first, ties by score, hits without a date last (also by score)', () => {
    const hits = [
      hit('undated-low', 0.2), hit('jan', 0.9, '2026-01-05T09:00:00.000Z'), hit('undated-high', 1.15),
      hit('mar-low', 0.3, '2026-03-15T09:00:00.000Z'), hit('mar-high', 0.8, '2026-03-15T09:00:00.000Z'), hit('feb', 0.1, '2026-02-10'),
    ];
    expect(names(orderHits(hits, 'session_date'))).toEqual(['mar-high', 'mar-low', 'feb', 'jan', 'undated-high', 'undated-low']);
  });

  it('does not reorder its input', () => {
    const hits = [hit('a', 0.1), hit('b', 0.9)];
    orderHits(hits, 'score');
    expect(names(hits)).toEqual(['a', 'b']);
  });
});

describe('createLedgerEventClock', () => {
  async function clockFixture() {
    const f = await fixture();
    return { ...f, clock: createLedgerEventClock(f.db) };
  }
  const block = (id: string, at = '2000-01-01T00:00:00.000Z') => `## ${id} · ${at}\n- kind: store\n- object: x\n`;

  it('answers with the lifecycle row\'s time for an event the lifecycle layer knows, however the id is cased', async () => {
    const { clock } = await clockFixture();
    // The header text says 2000: the projection, not the text, is the authority.
    expect(clock({ text: block('MEM_STANDUP1') })).toBe(STANDUP_AT);
    expect(clock({ text: block('mem_standup1') })).toBe(STANDUP_AT);
    expect(clock({ text: block('MEM_OFFSITE2') })).toBe(OFFSITE_AT);
  });

  it('reads a chunk cut below its header by the id in its heading path', async () => {
    const { clock } = await clockFixture();
    expect(clock({ text: '- object: tail of a long value', headingPath: 'Memory Events Ledger > MEM_OFFSITE2 · 2026-03-15T09:00:00.000Z' })).toBe(OFFSITE_AT);
  });

  it('is silent about what is no known event: prose, an unknown id, a heading that only resembles a header', async () => {
    const { clock } = await clockFixture();
    expect(clock({ text: 'An ordinary note mentions MEM_STANDUP1 in prose.' })).toBeUndefined();
    expect(clock({ text: block('MEM_NOSUCHEVENT') })).toBeUndefined();
    expect(clock({ text: '## MEM_STANDUP1 rollout notes\n\nbody' })).toBeUndefined();
    expect(clock({ text: '# Plan', headingPath: 'Plan' })).toBeUndefined();
  });

  it('dates a chunk that carries several events by the newest of them', async () => {
    const { clock } = await clockFixture();
    expect(clock({ text: `${block('MEM_STANDUP1')}\n${block('MEM_OFFSITE2')}` })).toBe(OFFSITE_AT);
    expect(clock({ text: `${block('MEM_OFFSITE2')}\n${block('MEM_STANDUP1')}` })).toBe(OFFSITE_AT);
    // One unknown among known events does not hide the known ones.
    expect(clock({ text: `${block('MEM_NOSUCHEVENT')}\n${block('MEM_STANDUP1')}` })).toBe(STANDUP_AT);
  });

  it('asks the database nothing for text that holds no event id, and prepares its one statement once', async () => {
    const { clock, db } = await clockFixture();
    const prepared: string[] = [];
    const real = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { prepared.push(sql); return real(sql); };
    for (let i = 0; i < 25; i++) expect(clock({ text: `prose ${i}` })).toBeUndefined();
    expect(prepared).toEqual([]);
    for (let i = 0; i < 25; i++) expect(clock({ text: block('MEM_STANDUP1') })).toBe(STANDUP_AT);
    expect(clock({ text: block('MEM_OFFSITE2') })).toBe(OFFSITE_AT);
    expect(prepared.filter(sql => /FROM facts/.test(sql))).toHaveLength(1);
  });

  it('is silent, not broken, over a database that has no lifecycle projection', () => {
    const bare = new Database(':memory:');
    bare.exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, predicate TEXT)');
    expect(createLedgerEventClock(bare)({ text: block('MEM_STANDUP1') })).toBeUndefined();
    bare.close();
  });
});
