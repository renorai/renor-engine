import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import {
  COMPLETE_POSTINGS,
  MAX_COMMON_WORDS,
  RECENT_WINDOW,
  ensureFactTerms,
  factVocabulary,
  findCurrentFacts,
  newestFactEvent,
  recentCurrentFacts,
} from '../../src/memory/factTerms';
import { currentLifecycleFacts } from '../../src/mvp/agentMemory';
import { factHits } from '../../src/mvp/factsLane';
import { seedFacts, seedNewerFacts } from '../helpers/seedFacts';
import { fullScans, traceStatements } from '../helpers/traceStatements';

/**
 * The term index (`fact_terms`): lifecycle facts are found by the words in them through an index, so
 * every matching current fact is found however many newer facts there are, and a search costs what
 * its matches cost, not what the table costs.
 */

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-terms-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'index.db'));
  runMigrations(db);
  dbs.push(db);
  const put = (subject: string, predicate: string, object: string, scope?: string) =>
    remember(db, dir, DEFAULT_LEDGER_REL, { subject, predicate, object, ...(scope === undefined ? {} : { scope }) });
  return { dir, db, ledger: { memoryDir: dir, ledgerRelPath: DEFAULT_LEDGER_REL }, put };
}

const objects = (facts: Array<{ object: string }>) => facts.map(f => f.object);
const terms = (db: Database.Database, factId: number) =>
  (db.prepare('SELECT term FROM fact_terms WHERE fact_id = ? ORDER BY term').all(factId) as Array<{ term: string }>).map(r => r.term);

describe('writing the index', () => {
  it('indexes a fact in the transaction that saves it, by its subject, object and predicate words', async () => {
    const { db, put } = store();
    const saved = await put('Billing Service', 'prefers_retry_policy', 'exponential backoff', 'project:alpha');
    const factId = saved.created!.factId!;

    // The predicate also by its base form (prefers → prefer); `` is the marker, never a word.
    expect(terms(db, factId)).toEqual(['', ...[...factVocabulary({ subject: 'Billing Service', predicate: 'prefers_retry_policy', object: 'exponential backoff' })].sort()]);
    expect(terms(db, factId)).toContain('prefer');
    expect((db.prepare('SELECT DISTINCT scope FROM fact_terms WHERE fact_id = ?').all(factId) as Array<{ scope: string }>).map(r => r.scope)).toEqual(['project:alpha']);
  });

  it('indexes under the subject the entity carries, which may be another name of the same person', async () => {
    const { db, put } = store();
    await put('Rowan', 'lives_in', 'Rio');
    const second = await put('Rowan Vale', 'works_at', 'Acme'); // the same identity: the entity keeps `Rowan`

    // A read shows the entity's name, so that is what the index carries, not the event's.
    expect(terms(db, second.created!.factId!)).toContain('rowan');
    expect(terms(db, second.created!.factId!)).not.toContain('vale');
    expect(findCurrentFacts(db, { terms: ['rowan', 'acme'], match: 'all', limit: 5 }).map(f => f.subject)).toEqual(['Rowan']);
  });

  it('keeps a superseded fact\'s rows and decides currency by the fact, so closing and reopening need no index work', async () => {
    const { db, put } = store();
    const first = await put('database', 'engine', 'MySQL');
    await put('database', 'engine', 'Postgres');
    const find = (term: string) => objects(findCurrentFacts(db, { terms: [term], match: 'all', limit: 5 }));

    expect(find('mysql')).toEqual([]); // closed by the correction, rows still there
    expect(terms(db, first.created!.factId!)).toContain('mysql');
    expect(find('postgres')).toEqual(['Postgres']);

    // Reconciliation can reopen a closed fact (and close the one that replaced it): rows stay as they are.
    db.prepare('UPDATE facts SET valid_to = ? WHERE object_text = ?').run('2026-10-02T00:00:00.000Z', 'Postgres');
    db.prepare('UPDATE facts SET valid_to = NULL WHERE id = ?').run(first.created!.factId);
    expect(find('mysql')).toEqual(['MySQL']);
    expect(find('postgres')).toEqual([]);
  });
});

describe('ensureFactTerms', () => {
  it('indexes the facts that have no rows (a database from before the index, or from an older release), once', async () => {
    const { db, put } = store();
    const saved = await put('billing', 'owner', 'Marta');
    db.prepare('DELETE FROM fact_terms').run(); // what an older release leaves: facts without rows
    expect(findCurrentFacts(db, { terms: ['marta'], match: 'all', limit: 5 })).toEqual([]);

    expect(ensureFactTerms(db)).toBe(1);
    expect(objects(findCurrentFacts(db, { terms: ['marta'], match: 'all', limit: 5 }))).toEqual(['Marta']);
    expect(terms(db, saved.created!.factId!)).toContain('billing');
    expect(ensureFactTerms(db)).toBe(0);
  });

  it('marks a fact whose text has no words as indexed, so it is not indexed again and again', async () => {
    const { db, put } = store();
    const saved = await put('…', '…', '…');

    expect(terms(db, saved.created!.factId!)).toEqual(['']);
    expect(ensureFactTerms(db)).toBe(0);
  });
});

describe('findCurrentFacts and recentCurrentFacts', () => {
  it('any ranks by shared words then newest; all needs every word, and a word no fact has answers at once', async () => {
    const { db, put } = store();
    await put('billing', 'webhook_endpoint', '/hooks/stripe');
    await put('billing', 'invoice_day', 'first of the month');
    await put('shipping', 'carrier', 'DHL');

    const any = (words: string[]) => objects(findCurrentFacts(db, { terms: words, match: 'any', limit: 20 }));
    const all = (words: string[]) => objects(findCurrentFacts(db, { terms: words, match: 'all', limit: 20 }));
    expect(any(['billing', 'webhook', 'endpoint'])).toEqual(['/hooks/stripe', 'first of the month']);
    expect(any(['billing'])).toEqual(['first of the month', '/hooks/stripe']);
    expect(all(['billing', 'webhook'])).toEqual(['/hooks/stripe']);
    expect(all(['billing', 'kubernetes'])).toEqual([]);

    const unknown = traceStatements(db, () => all(['billing', 'kubernetes']));
    expect(unknown.plans.every(({ sql }) => !/\bfacts f\b|JOIN facts/.test(sql))).toBe(true); // answered without reading any fact
  });

  it('never reads the marker row as a word', async () => {
    const { db, put } = store();
    await put('billing', 'owner', 'Marta');
    for (const match of ['any', 'all'] as const) expect(findCurrentFacts(db, { terms: [''], match, limit: 5 }), match).toEqual([]);
  });

  it('scope is exact when given and every scope when omitted, in the match and in the profile read', async () => {
    const { db, put } = store();
    await put('vault', 'door_code', 'GLOBALCODE');
    await put('vault', 'door_code', 'ALPHACODE', 'scope:alpha');
    await put('vault', 'door_code', 'BETACODE', 'project:beta');
    const find = (match: 'all' | 'any', scope?: string) => objects(findCurrentFacts(db, { terms: ['vault', 'door'], scope, match, limit: 20 })).sort();

    for (const match of ['all', 'any'] as const) {
      expect(find(match)).toEqual(['ALPHACODE', 'BETACODE', 'GLOBALCODE']);
      expect(find(match, 'global')).toEqual(['GLOBALCODE']);
      expect(find(match, 'scope:alpha')).toEqual(['ALPHACODE']);
      expect(find(match, 'project:nobody')).toEqual([]);
    }
    expect(objects(recentCurrentFacts(db, undefined, 20)).sort()).toEqual(['ALPHACODE', 'BETACODE', 'GLOBALCODE']);
    expect(objects(recentCurrentFacts(db, 'project:beta', 20))).toEqual(['BETACODE']);
    expect(objects(recentCurrentFacts(db, undefined, 2))).toEqual(['BETACODE', 'ALPHACODE']); // newest first
  });
});

describe('a table of ten thousand newer facts', () => {
  it('still finds a current fact that is older than all of them, through an index', async () => {
    const { db, ledger, put } = store();
    // The one fact that matters, saved first and so the oldest; its words are not ASCII only.
    const needle = await put('Zürich-stripe-spec', 'owner', '東京 Marta Quasar');
    seedNewerFacts(db, 10_050);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM facts WHERE valid_to IS NULL AND source_path = '_mcp_'`).get() as { c: number }).c).toBe(10_051);

    const { result, plans } = traceStatements(db, () => ({
      any: findCurrentFacts(db, { terms: ['quasar'], match: 'any', limit: 5 }),
      all: findCurrentFacts(db, { terms: ['東京', 'quasar', 'stripe'], match: 'all', limit: 5 }),
      getContext: currentLifecycleFacts(db, 'who owns the stripe spec in 東京?'),
      searchText: factHits(db, ledger, { query: '東京 Quasar', match: 'all', limit: 5 }),
      searchMemory: factHits(db, ledger, { query: 'which person is the owner, Marta Quasar?', match: 'any', limit: 5 }),
      newest: recentCurrentFacts(db, undefined, 20),
    }));

    expect(result.any.map(f => f.eventId)).toEqual([needle.eventId]);
    expect(result.all.map(f => f.eventId)).toEqual([needle.eventId]);
    expect(result.getContext.map(f => f.object)).toEqual(['東京 Marta Quasar']);
    expect(result.searchText.map(h => h.headingPath.split(' ')[0])).toEqual([needle.eventId]);
    expect(result.searchMemory.map(h => h.headingPath.split(' ')[0])[0]).toBe(needle.eventId);
    expect(result.newest).toHaveLength(20); // the newest twenty are seeded facts: the needle is found by its words, not by being recent
    expect(result.newest.some(f => f.eventId === needle.eventId)).toBe(false);

    // Every statement was served by an index. The only scans allowed are the newest-first walk of the
    // partial index, which stops after `limit` rows, and the walks of the candidate list the read built
    // itself (`c`), its scores (`scored`) and the best of them (`b`); a match never scans or sorts the
    // table, and no statement reads more rows than a selective word's rows plus one.
    expect(plans.length).toBeGreaterThan(6);
    for (const { sql, plan, rows } of plans) {
      expect(rows, sql).toBeLessThanOrEqual(COMPLETE_POSTINGS + 1);
      expect(plan.join('\n'), sql).not.toContain('GROUP BY');
      const scans = fullScans(plan).filter(line => !line.startsWith('SCAN c VIRTUAL TABLE') && line !== 'SCAN scored' && line !== 'SCAN b');
      if (sql.includes('INDEXED BY')) expect(scans, sql).toEqual(['SCAN f USING INDEX idx_facts_lifecycle_recent']);
      else expect(scans, sql).toEqual([]);
    }
  }, 120_000);

  it('reads the newest facts of one scope in index order, without sorting', async () => {
    const { db } = store();
    seedNewerFacts(db, 300);
    db.prepare(`UPDATE facts SET scope = 'project:alpha' WHERE id % 3 = 0`).run();
    db.prepare('DELETE FROM fact_terms').run();
    ensureFactTerms(db);

    const { result, plans } = traceStatements(db, () => recentCurrentFacts(db, 'project:alpha', 5));
    expect(result).toHaveLength(5);
    expect(result.every(f => f.scope === 'project:alpha')).toBe(true);
    expect(result.map(f => f.validFrom)).toEqual([...result.map(f => f.validFrom)].sort().reverse());
    expect(plans[0].plan.join('\n')).toContain('USING INDEX idx_facts_lifecycle_scope_recent (scope=?)');
    expect(plans[0].plan.join('\n')).not.toContain('TEMP B-TREE');
  });
});

describe('a word that every one of ten thousand facts has', () => {
  const COMMON = 10_050;
  const candidateIds = (args: unknown[]) => {
    const list = args.find((a): a is string => typeof a === 'string' && a.startsWith('['));
    return list === undefined ? [] : (JSON.parse(list) as number[]);
  };
  /** Median CPU time of one call, in ms, after a warm-up. */
  const cpuMs = (fn: () => unknown, rounds = 15) => {
    for (let i = 0; i < 3; i++) fn();
    const samples: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const before = process.cpuUsage();
      fn();
      const used = process.cpuUsage(before);
      samples.push((used.user + used.system) / 1000);
    }
    return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  };

  it('is not read down to its last row: no statement reads or sorts the whole population', () => {
    const { db } = store();
    seedNewerFacts(db, COMMON);
    const newest = recentCurrentFacts(db, undefined, 5);

    for (const match of ['any', 'all'] as const) {
      const { result, plans } = traceStatements(db, () => findCurrentFacts(db, { terms: ['seeded'], match, limit: 5 }));
      // Every fact has the word, so the best five are the newest five.
      expect(result.map(f => f.eventId ?? f.object), match).toEqual(newest.map(f => f.eventId ?? f.object));

      expect(plans.length).toBeGreaterThanOrEqual(2);
      for (const { sql, plan, rows, args } of plans) {
        // How far the word's rows were read: one row past the threshold, enough to know the word is common.
        expect(rows, `${match}: ${sql}`).toBeLessThanOrEqual(Math.max(COMPLETE_POSTINGS + 1, RECENT_WINDOW));
        expect(candidateIds(args).length, `${match}: ${sql}`).toBeLessThanOrEqual(RECENT_WINDOW);
        expect(plan.join('\n'), `${match}: ${sql}`).not.toContain('GROUP BY');
        // The word's own rows are only ever opened by a statement that stops after a fixed number of them.
        if (plan.some(line => /^SEARCH \w+ USING (COVERING )?INDEX .*\(term=\?\)$|^SEARCH \w+ USING PRIMARY KEY \(term=\?\)$/.test(line))) {
          expect(sql, `${match}: ${sql}`).toMatch(/LIMIT \?$/);
        }
      }
      const read = plans.find(({ sql }) => sql.startsWith('SELECT fact_id FROM fact_terms'));
      expect(read?.rows, match).toBe(COMPLETE_POSTINGS + 1);
      expect(read?.plan, match).toEqual(['SEARCH fact_terms USING PRIMARY KEY (term=?)']);
      // Whatever sorts, sorts the candidates (at most RECENT_WINDOW), never the 10,050 facts.
      const scoring = plans.find(({ sql }) => sql.includes('json_each'));
      expect(scoring, match).toBeDefined();
      expect(candidateIds(scoring!.args).length, match).toBe(RECENT_WINDOW);
    }
  }, 60_000);

  it('costs the same CPU time at 10,050 facts as at 1,100 (it would grow nine-fold if it read every row)', () => {
    const small = store();
    seedNewerFacts(small.db, COMPLETE_POSTINGS + 100);
    const large = store();
    seedNewerFacts(large.db, COMMON);

    for (const match of ['any', 'all'] as const) {
      const run = (db: Database.Database) => () => findCurrentFacts(db, { terms: ['seeded', 'value'], match, limit: 5 });
      // A loaded box can make one measurement of a sub-millisecond baseline read 8x. A real nine-fold growth
      // shows in every attempt, so take the best of three measurements, each taken small-then-large.
      let best = { ratio: Infinity, smallMs: 0, largeMs: 0 };
      for (let attempt = 0; attempt < 3 && best.ratio >= 3; attempt++) {
        const smallMs = cpuMs(run(small.db), 31);
        const largeMs = cpuMs(run(large.db), 31);
        const ratio = largeMs / Math.max(smallMs, 1);
        if (ratio < best.ratio) best = { ratio, smallMs, largeMs };
      }
      // Both tables are past the threshold, so both read the same bounded number of rows.
      expect(best.ratio, `${match}: ${best.largeMs.toFixed(2)} ms vs ${best.smallMs.toFixed(2)} ms`).toBeLessThan(3);
      expect(best.largeMs, match).toBeLessThan(30);
    }
  }, 120_000);

  it('does not hide a fact that has a selective word, however old, and ranks it by every word it has', async () => {
    const { db, put } = store();
    const needle = await put('Zürich-stripe-spec', 'owner', 'Marta Quasar seeded');
    seedNewerFacts(db, COMMON);
    const find = (words: string[], match: 'any' | 'all', limit = 5) => findCurrentFacts(db, { terms: words, match, limit });

    // 'seeded' is common, 'quasar' and 'marta' are not: the needle is a candidate through them.
    expect(find(['seeded', 'quasar', 'marta'], 'any')[0]).toMatchObject({ eventId: needle.eventId, shared: 3 });
    expect(find(['seeded', 'quasar'], 'all').map(f => f.eventId)).toEqual([needle.eventId]);
    expect(find(['quasar', 'zürich'], 'any').map(f => f.eventId)).toEqual([needle.eventId]);
    // A word nobody has ends an all-words read; any-word reads just do not count it.
    expect(find(['seeded', 'nobody'], 'all')).toEqual([]);
    expect(find(['nobody', 'quasar'], 'any').map(f => f.eventId)).toEqual([needle.eventId]);
  });

  it('is exact in a scope where the word is selective, and reads the newest facts only where it is common', async () => {
    const { db, put } = store();
    for (const n of [1, 2, 3]) await put(`seeded alpha ${n}`, 'owner', `Team ${n}`, 'scope:alpha');
    seedNewerFacts(db, COMMON);
    const find = (scope: string | undefined, match: 'any' | 'all') => findCurrentFacts(db, { terms: ['seeded'], scope, match, limit: 10 });

    // In scope:alpha three facts have the word: read completely, however much newer global memory there is.
    for (const match of ['any', 'all'] as const) {
      expect(find('scope:alpha', match).map(f => f.object).sort(), match).toEqual(['Team 1', 'Team 2', 'Team 3']);
      expect(find('scope:alpha', match).every(f => f.scope === 'scope:alpha')).toBe(true);
    }
    // Across scopes, and in global, the word is common: the newest facts answer, and they are global ones.
    for (const scope of [undefined, 'global']) for (const match of ['any', 'all'] as const) {
      const found = find(scope, match);
      expect(found, `${scope} ${match}`).toHaveLength(10);
      expect(found.every(f => f.scope === 'global'), `${scope} ${match}`).toBe(true);
    }
  });

  it('reads a word completely up to COMPLETE_POSTINGS rows, and through the newest RECENT_WINDOW facts beyond', () => {
    const { db } = store();
    const edge = (db2: Database.Database, from: number, count: number) =>
      seedFacts(db2, count, i => ({ subject: `Edge ${from + i}`, predicate: 'has', object: `edgeword ${from + i}` }));
    const found = () => findCurrentFacts(db, { terms: ['edgeword'], match: 'any', limit: COMPLETE_POSTINGS + 10 });

    edge(db, 0, COMPLETE_POSTINGS); // exactly as many rows as are read completely: every one of them comes back
    expect(found()).toHaveLength(COMPLETE_POSTINGS);
    edge(db, COMPLETE_POSTINGS, 1); // one row more: the word is common, and the newest facts answer
    expect(found()).toHaveLength(RECENT_WINDOW);
  });

  it('gives up exactly one thing, and says so: an old fact that only common words find', async () => {
    const { db, put } = store();
    await put('old-pair', 'links', 'alpha beta'); // the only fact with both words, older than the newest RECENT_WINDOW
    seedFacts(db, COMPLETE_POSTINGS + 200, i => ({ subject: `Alpha holder ${i}`, predicate: 'has', object: `alpha filler ${i}` }));
    seedFacts(db, COMPLETE_POSTINGS + 200, i => ({ subject: `Beta holder ${i}`, predicate: 'has', object: `beta filler ${i}` }));
    const find = (words: string[], match: 'any' | 'all') => findCurrentFacts(db, { terms: words, match, limit: 5 }).map(f => f.subject);

    // Both words are common (each is in more than COMPLETE_POSTINGS facts) and no recent fact has both.
    expect(find(['alpha', 'beta'], 'all')).toEqual([]);
    // With a selective word the same fact is found, and first: it is exact whenever the query has one.
    expect(find(['alpha', 'beta', 'old'], 'all')).toEqual(['old-pair']);
    expect(find(['alpha', 'beta', 'old'], 'any')[0]).toBe('old-pair');
  });

  it('drops a window fact that has none of the words, and counts the words each candidate really has', () => {
    const { db } = store();
    // Half of the facts have the word (more than COMPLETE_POSTINGS of them, so it is common), the other half none of the query's words.
    seedFacts(db, 2 * (COMPLETE_POSTINGS + 200), i => ({ subject: `Mix ${i}`, predicate: 'has', object: i % 2 === 0 ? `shared word ${i}` : `plain text ${i}` }));
    // Asked for more than the window holds of them, the read returns those that have the word, and no other.
    const found = findCurrentFacts(db, { terms: ['shared'], match: 'any', limit: RECENT_WINDOW });
    expect(found).toHaveLength(RECENT_WINDOW / 2);
    expect(found.every(f => f.object.startsWith('shared word') && f.shared === 1)).toBe(true);
  });

  it('matches a common word among the newest facts of the scope read, not of the table', () => {
    const { db } = store();
    // In scope:alpha 'zzword' and 'yyword' are common; the global facts after them are newer and have neither.
    seedFacts(db, COMPLETE_POSTINGS + 200, i => ({ subject: `Alpha ${i}`, predicate: 'has', object: `zzword yyword ${i}`, scope: 'scope:alpha' }));
    seedFacts(db, 2 * RECENT_WINDOW, i => ({ subject: `Global ${i}`, predicate: 'has', object: `plain text ${i}` }));
    for (const match of ['any', 'all'] as const) {
      const found = findCurrentFacts(db, { terms: ['zzword', 'yyword'], scope: 'scope:alpha', match, limit: 5 });
      expect(found, match).toHaveLength(5);
      expect(found.every(f => f.scope === 'scope:alpha'), match).toBe(true);
    }
    // Across scopes the newest facts are the global ones, which have neither word: nothing is found there.
    expect(findCurrentFacts(db, { terms: ['zzword', 'yyword'], match: 'all', limit: 5 })).toEqual([]);
  });

  it('counts every selective word of a query, however many, and at most MAX_COMMON_WORDS common ones', async () => {
    const { db, put } = store();
    // 45 words, each in one fact, except the last, which a second fact has too (so it is the least rare).
    const selective = Array.from({ length: 45 }, (_, i) => `selword${String(i).padStart(2, '0')}`);
    await put('long-query', 'has', selective.join(' '));
    await put('other-fact', 'has', selective[44]);
    const found = findCurrentFacts(db, { terms: selective, match: 'any', limit: 5 });
    expect(found.map(f => f.subject)).toEqual(['long-query', 'other-fact']); // every word is read, the last one too
    expect(found[0].shared).toBe(selective.length); // and counted: no cap on selective words

    // Twelve words that each of 1,100 facts has: all common; only the first MAX_COMMON_WORDS rank.
    const common = Array.from({ length: 12 }, (_, i) => `commword${String(i).padStart(2, '0')}`);
    seedFacts(db, COMPLETE_POSTINGS + 100, i => ({ subject: `Common holder ${i}`, predicate: 'has', object: common.join(' ') }));
    const [ranked] = findCurrentFacts(db, { terms: common, match: 'any', limit: 5 });
    expect(ranked.shared).toBe(MAX_COMMON_WORDS);
  });

  it('drives an all-words read from the rarest of its selective words', () => {
    const { db } = store();
    // 'rareword' is in 5 facts and 'midword' in 500, five of which are the same facts: the five are the answer.
    seedFacts(db, 500, i => ({ subject: `Mid ${i}`, predicate: 'has', object: i < 5 ? `midword rareword ${i}` : `midword filler ${i}` }));
    const { result, plans } = traceStatements(db, () => findCurrentFacts(db, { terms: ['midword', 'rareword'], match: 'all', limit: 20 }));

    expect(result).toHaveLength(5);
    const ranking = plans.find(({ sql }) => sql.includes('json_each'));
    expect(candidateIds(ranking!.args)).toHaveLength(5); // the rare word's rows, not the 500 of the other
  });

  it('reads every selective word completely, however many other selective words the query has', () => {
    const { db } = store();
    // One rare word in 50 old facts, then thirteen words in 900 newer facts each: every word is selective,
    // and together they have 11,750 facts, more than any bound on what a read collects could hold.
    seedFacts(db, 50, i => ({ subject: `Rare ${i}`, predicate: 'has', object: `rarity item ${i}` }));
    const words = Array.from({ length: 13 }, (_, i) => `grpword${String(i).padStart(2, '0')}`);
    seedFacts(db, words.length * 900, i => ({ subject: `Group ${i}`, predicate: 'has', object: `${words[i % words.length]} item ${i}` }));
    const total = 50 + words.length * 900;
    const { result, plans } = traceStatements(db, () => findCurrentFacts(db, { terms: ['rarity', ...words], match: 'any', limit: total }));

    // No fact is missed: each has a selective word, and a fact that has one is always found, whichever
    // of the words it is and however old it is. The last word read is the least rare, the case a
    // collection bound would cut.
    expect(result).toHaveLength(total);
    for (const word of ['rarity', ...words]) {
      expect(result.filter(f => f.object.startsWith(`${word} `)), word).toHaveLength(word === 'rarity' ? 50 : 900);
    }
    // Each word's rows were read by a statement that stops one row past the threshold.
    const reads = plans.filter(({ sql }) => sql.startsWith('SELECT fact_id FROM fact_terms'));
    expect(reads).toHaveLength(words.length + 1);
    expect(Math.max(...reads.map(({ rows }) => rows))).toBeLessThanOrEqual(COMPLETE_POSTINGS + 1);
  }, 60_000);

  it('finds a fact that has only the least rare of many selective words, even when it is the oldest', () => {
    const { db } = store();
    const words = Array.from({ length: 13 }, (_, i) => `lateword${String(i).padStart(2, '0')}`);
    // The oldest fact of the least rare word (900 rows, the same as the others, last in the query) comes first.
    seedFacts(db, words.length * 900, i => ({ subject: `Late ${i}`, predicate: 'has', object: `${words[i % words.length]} item ${i}` }));
    const found = findCurrentFacts(db, { terms: words, match: 'any', limit: 10 });
    expect(found).toHaveLength(10);
    const oldest = findCurrentFacts(db, { terms: [words[12]], match: 'all', limit: 900 }).at(-1);
    expect(oldest?.subject).toBe('Late 12');
    // Ask for everything and it is there, with its one selective word counted.
    const all = findCurrentFacts(db, { terms: words, match: 'any', limit: 20_000 });
    expect(all.find(f => f.subject === 'Late 12')).toMatchObject({ shared: 1 });
  }, 60_000);
});

// A named scope is its slug (mvp/scope.ts, scopeSpellings): a fact saved as scope:alpha and one saved as project:alpha
// are in one scope, and every read of it reads both, each spelling through its own walk of the index.
describe('a scope whose facts were saved under both of its spellings', () => {
  it('reads the newest facts of both spellings, merged in order, each spelling by its own index walk without sorting', () => {
    const { db } = store();
    seedNewerFacts(db, 300);
    db.prepare(`UPDATE facts SET scope = CASE id % 3 WHEN 0 THEN 'project:alpha' WHEN 1 THEN 'scope:alpha' ELSE 'global' END`).run();
    // The newest twenty share one instant, so the merge must order them by row id, as one SQL read would.
    db.prepare(`UPDATE facts SET valid_from = '2099-06-01T00:00:00.000Z' WHERE id > (SELECT MAX(id) - 20 FROM facts)`).run();
    db.prepare('DELETE FROM fact_terms').run();
    ensureFactTerms(db);
    const expected = (db.prepare(
      `SELECT object_text AS object FROM facts WHERE valid_to IS NULL AND scope IN ('scope:alpha', 'project:alpha')
       ORDER BY valid_from DESC, id DESC LIMIT 9`,
    ).all() as Array<{ object: string }>).map(r => r.object);

    for (const scope of ['scope:alpha', 'project:alpha']) {
      const { result, plans } = traceStatements(db, () => recentCurrentFacts(db, scope, 9));
      expect(objects(result), scope).toEqual(expected);
      expect(new Set(result.map(f => f.scope)), scope).toEqual(new Set(['scope:alpha', 'project:alpha']));
      expect(plans.map(p => p.args[0]), scope).toEqual(['scope:alpha', 'project:alpha']);
      for (const { plan } of plans) {
        expect(plan.join('\n')).toContain('USING INDEX idx_facts_lifecycle_scope_recent (scope=?)');
        expect(plan.join('\n')).not.toContain('TEMP B-TREE');
      }
    }
    expect(objects(recentCurrentFacts(db, 'global', 9)).every(o => !expected.includes(o))).toBe(true);
  });

  it('matches a common word among the newest facts of both spellings', () => {
    const { db } = store();
    // The word is in more facts than COMPLETE_POSTINGS across the two spellings, though in fewer in each of them,
    // and the global facts saved after them do not have it.
    seedFacts(db, COMPLETE_POSTINGS + 200, i => ({
      subject: `Alpha ${i}`, predicate: 'has', object: `zzword ${i}`, scope: i % 2 === 0 ? 'scope:alpha' : 'project:alpha',
    }));
    seedFacts(db, 2 * RECENT_WINDOW, i => ({ subject: `Global ${i}`, predicate: 'has', object: `plain text ${i}` }));
    const newest = Array.from({ length: 6 }, (_, i) => `Alpha ${COMPLETE_POSTINGS + 199 - i}`);
    for (const scope of ['scope:alpha', 'project:alpha']) for (const match of ['any', 'all'] as const) {
      const found = findCurrentFacts(db, { terms: ['zzword'], scope, match, limit: 6 });
      expect(found.map(f => f.subject), `${scope} ${match}`).toEqual(newest);
    }
  });

  it('names the newest event of either spelling as the newest of the scope', async () => {
    const { db, put } = store();
    await put('first', 'p', 'x', 'project:alpha');
    const second = await put('second', 'p', 'y', 'scope:alpha');
    for (const scope of ['scope:alpha', 'project:alpha']) expect(newestFactEvent(db, scope), scope).toBe(second.eventId);
    const third = await put('third', 'p', 'z', 'project:alpha');
    for (const scope of ['scope:alpha', 'project:alpha']) expect(newestFactEvent(db, scope), scope).toBe(third.eventId);
    expect(newestFactEvent(db, 'global')).toBeUndefined();
    expect(newestFactEvent(db, 'scope:beta')).toBeUndefined();
  });
});
