import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { buildAgentContext, matchBudgetOrder, serviceNames, serviceNoteFirstEnabled, replyTokens, type AgentContextMemory } from '../../src/mvp/agentMemory';
import { engineSearchMemory, type Engine } from '../../src/mvp/engine';

/**
 * get_context's token budget used to keep the longest prefix of the laid-out list. The list is laid out newest first
 * (rankedBy "session_date"), so a tight budget cut the OLDEST matches first, however close they were: the note that
 * answered the question was dropped for newer notes that barely matched it (retrieval ablations, 2026-10-06, section 14:
 * score order for the reader loses 7 to 23 against date order, so the layout stays and the cut is what changes).
 *
 * The contract pinned here: the budget keeps the matches that score best, the longest run of them that fits, and lists
 * what it kept in the order the list has, newest first. When everything fits the reply is the whole list, as it was.
 * The workspace is five dated notes and one question: the note that answers it is the oldest, and the newest note is a
 * weak match. Eval-hash embeddings (lexical, deterministic): no model, no network.
 */

const cleanups: Array<() => void> = [];
const saved = ['RENOR_SESSION_EXPAND', 'RENOR_NEWEST_FIRST', 'RENOR_READ_HONESTY'].map(name => [name, process.env[name]] as const);
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const QUERY = 'Who owns the Kestrel billing export and where does it run?';
// The same sentence over and over keeps the direction of its embedding, so this note scores second and costs the most.
const BILLING = 'Billing notes: invoices are exported every night and the finance team reads the export in the morning.';
const NOTES: Array<[file: string, date: string, text: string]> = [
  ['kestrel-export', '2026-03-02', 'The Kestrel billing export runs nightly on the Kestrel worker. Ravi owns the Kestrel billing export and its failures.'],
  ['billing-notes', '2026-05-18', Array.from({ length: 8 }, () => BILLING).join(' ')],
  ['worker-pool', '2026-07-09', 'The worker pool was resized last week to eight workers. Nothing else changed about the pool or the queues.'],
  ['office', '2026-08-21', 'The office plants are watered on Fridays, and the kitchen rota changes on the first Monday of the month.'],
  ['offsite', '2026-09-30', 'The team offsite is in October. Flights are booked and the venue sent the final agenda for the export of travel receipts.'],
];
const BUDGETS = Array.from({ length: 73 }, (_, i) => 128 + i * 8); // 128 .. 704 tokens: from nothing fitting to everything

type Memory = AgentContextMemory & { score: number };
type Context = { memories: Memory[]; truncated: boolean };
const file = (m: { notePath: string }) => path.basename(m.notePath, '.md');

async function workspace(env: Record<string, string> = {}) {
  process.env.RENOR_SESSION_EXPAND = '0'; // nothing to add in a window that holds every note; the cut is what is under test
  Object.assign(process.env, env);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-cut-by-score-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  for (const [name, date, text] of NOTES) fs.writeFileSync(path.join(memoryDir, `${name}.md`), `---\ndate: ${date}\n---\n# ${name}\n\n${text}\n`);
  const db = openDb(path.join(root, 'index.db'));
  cleanups.push(() => { db.close(); });
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 2);
  const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'test:hash:256' };
  return {
    /** What retrieval hands get_context: the window of its eight best chunks, in the layout order. */
    window: async () => (await engineSearchMemory(db, engine, memoryDir, QUERY, 8)).hits as Memory[],
    ask: (maxTokens: number) => buildAgentContext(db, engine, memoryDir, { query: QUERY, maxTokens }) as Promise<Context>,
  };
}

/**
 * What get_context charges a match (applyBudget's cost): its JSON in o200k and its comma, or its JSON alone under the
 * read-honesty lane. The room a reply leaves for its matches is the budget less the reply without them. Both are read
 * back from the reply, so a margin of a few tokens separates a match that fits from one that does not.
 */
const MARGIN = 3;
const charge = (memory: object, honest: boolean): number => replyTokens(JSON.stringify(memory)) + (honest ? 0 : 1);
const roomFor = (reply: { memories: object[] }, max: number): number =>
  max - replyTokens(JSON.stringify({ ...reply, memories: [], truncated: false }));

/**
 * The contract at every budget: the matches kept are the best ones, listed in the order of the whole list, when the best
 * match fits the budget. When it cannot fit, the budget passes it over and keeps the matches that do fit, in score order
 * (applyBudget); so the best match is then not kept.
 */
async function keepsTheBestMatchesInListOrder(env: Record<string, string> = {}) {
  const w = await workspace(env);
  const honest = env.RENOR_READ_HONESTY === '1';
  const layout = (await w.window()).map(file);
  const best = [...(await w.window())].sort((a, b) => b.score - a.score).map(file);
  const roomy = await w.ask(4000);
  const whole = roomy.memories.map(file);
  expect(whole, 'the whole list is the layout').toEqual(layout);
  const charges = new Map(roomy.memories.map(m => [file(m), charge(m, honest)]));
  const topCost = charges.get(best[0])!;
  const seen = { cut: 0, oldestKeptNewestCut: 0, passedOver: 0 };
  for (const max of BUDGETS) {
    const reply = await w.ask(max);
    const kept = reply.memories.map(file);
    const room = roomFor(reply, max);
    if (topCost <= room - MARGIN) {
      expect(kept.slice().sort(), `the matches kept at ${max} tokens are the best ${kept.length}`).toEqual(best.slice(0, kept.length).sort());
    } else if (topCost > room + MARGIN) {
      expect(kept, `the best match, too big for ${max} tokens, is passed over`).not.toContain(best[0]);
      // Then the matches that fit are taken: the first later one in score order that fits is kept (an empty reply holds none).
      const first = best.slice(1).find(name => charges.get(name)! <= room + MARGIN);
      if (first !== undefined && charges.get(first)! <= room - MARGIN) expect(kept, `the first later match that fits, at ${max} tokens`).toContain(first);
      seen.passedOver++;
    }
    expect(kept, `listed in the order of the whole list at ${max} tokens`).toEqual(whole.filter(name => kept.includes(name)));
    expect(reply.truncated, `truncated at ${max} tokens`).toBe(kept.length < whole.length);
    if (kept.length > 0 && kept.length < whole.length) seen.cut++;
    if (kept.includes('kestrel-export') && !kept.includes('offsite')) seen.oldestKeptNewestCut++;
  }
  // Not vacuous: the budgets cut the list somewhere, somewhere they kept the oldest note and cut the newest, and somewhere
  // the best match was too big to keep.
  expect(seen.cut).toBeGreaterThan(0);
  expect(seen.oldestKeptNewestCut).toBeGreaterThan(0);
  expect(seen.passedOver).toBeGreaterThan(0);
  return { w, layout, best };
}

describe('get_context cuts its matches by score and lists what it kept newest first', () => {
  it('keeps the best-scoring matches under a tight budget, not the newest ones', async () => {
    const { layout, best } = await keepsTheBestMatchesInListOrder();
    // The fixture means what it says: the answer is the oldest note, and the newest is not among the two best.
    expect(layout).toEqual(['offsite', 'office', 'worker-pool', 'billing-notes', 'kestrel-export']);
    expect(best.slice(0, 2)).toEqual(['kestrel-export', 'billing-notes']);
  });

  it('keeps them the same way with the read-honesty lane armed', async () => {
    await keepsTheBestMatchesInListOrder({ RENOR_READ_HONESTY: '1' });
  });

  it('answers a budget that fits only one match with the best of those that fit', async () => {
    const w = await workspace();
    const roomy = await w.ask(4000);
    const charges = new Map(roomy.memories.map(m => [file(m), charge(m, false)]));
    const best = [...(await w.window())].sort((a, b) => b.score - a.score).map(file);
    let single = 0;
    for (const max of BUDGETS) {
      const reply = await w.ask(max);
      const kept = reply.memories.map(file);
      const room = roomFor(reply, max);
      // The best-scoring match that fits the room is the one kept: the closest one when it fits, the next one when it does not.
      // A match inside the margin of the room is undecided here, so a budget where the first candidate is one is not judged.
      const first = best.find(name => charges.get(name)! <= room + MARGIN);
      if (first === undefined || charges.get(first)! > room - MARGIN) continue;
      expect(kept, `${max} tokens`).toContain(first);
      if (kept.length === 1) single++;
      expect(kept.length, `${max} tokens: one match fits, so the reply is not empty`).toBeGreaterThan(0);
    }
    expect(single).toBeGreaterThan(0);
  });

  it('keeps the longest run of the best matches: a smaller match takes the place of a bigger one only when the bigger one is the best and cannot fit', async () => {
    const w = await workspace();
    const roomy = await w.ask(4000);
    const kestrelCost = charge(roomy.memories.find(m => file(m) === 'kestrel-export')!, false);
    const officeCost = charge(roomy.memories.find(m => file(m) === 'office')!, false);
    let skippable = 0;
    for (const max of BUDGETS) {
      const reply = await w.ask(max);
      const kept = reply.memories.map(file);
      const room = roomFor(reply, max);
      // The closest match is kept and the second does not fit; the third would, in the room the reply has left.
      if (kept.length === 1 && room >= charge(roomy.memories.find(m => file(m) === 'office')!, false) + MARGIN) skippable++;
      // The closest fits and the second does not: the run stops there, so nothing after the second is taken.
      if (kestrelCost <= room - MARGIN && !kept.includes('billing-notes')) expect(kept.includes('office'), `office after the closest, at ${max} tokens`).toBe(false);
      // The closest cannot fit: the next match that fits (office) is kept, and the reply is not empty.
      if (kestrelCost > room + MARGIN && officeCost <= room - MARGIN) expect(kept, `office, the next that fits, at ${max} tokens`).toContain('office');
    }
    expect(skippable).toBeGreaterThan(0);
  });

  it('is the whole list, newest first, when everything fits', async () => {
    const w = await workspace();
    const whole = (await w.window()).map(file);
    for (const max of [704, 1000, 4000]) {
      const reply = await w.ask(max);
      expect(reply.memories.map(file), `${max} tokens`).toEqual(whole);
      expect(reply.truncated, `${max} tokens`).toBe(false);
    }
  });

  it('keeps the first of a list laid out by score, as the prefix always was, where the first fits', async () => {
    const w = await workspace({ RENOR_NEWEST_FIRST: '0' }); // the layout by score: the list is already in the order of the cut
    const roomy = await w.ask(4000);
    const whole = roomy.memories.map(file);
    expect(whole).toEqual((await w.window()).slice().sort((a, b) => b.score - a.score).map(file));
    const topCost = charge(roomy.memories[0], false);
    for (const max of BUDGETS) {
      const reply = await w.ask(max);
      const kept = reply.memories.map(file);
      const room = roomFor(reply, max);
      if (topCost <= room - MARGIN) expect(kept, `${max} tokens`).toEqual(whole.slice(0, kept.length));
      else if (topCost > room + MARGIN) {
        expect(kept, `${max} tokens`).not.toContain(whole[0]);
        const first = whole.slice(1).find(name => (roomy.memories.find(m => file(m) === name) ? charge(roomy.memories.find(m => file(m) === name)!, false) : Infinity) <= room - MARGIN);
        if (first !== undefined) expect(kept, `${max} tokens: the first later match that fits`).toContain(first);
      }
    }
  });
});

describe('matchBudgetOrder', () => {
  const memory = (reason: string, score?: number): AgentContextMemory => ({ notePath: 'n.md', text: `${reason} ${score}`, reason, ...(score === undefined ? {} : { score }) });

  it('takes the summary tables that lead first, then the scored matches best first, then the keyword matches as listed', () => {
    const list = [
      memory('evidence', 0.05), // 0: scores below every match here, and still leads: it is listed first, outside any order
      memory('digest', 0.01), // 1: so does the digest table
      memory('semantic+content', 0.5), // 2
      memory('fts', 9.5), // 3: a keyword score is on another scale, so it never outranks a scored match
      memory('semantic', 0.9), // 4
      memory('note-identity', 0.1), // 5
      memory('graph', 0.3), // 6
    ];
    // the tables (0, 1); scored: 0.9 (4), 0.5 (2), 0.3 (6); keyword: as listed (3, 5)
    expect(matchBudgetOrder(list)).toEqual([0, 1, 4, 2, 6, 3, 5]);
  });

  it('keeps equal scores in their place in the list, so the newer first under "session_date"', () => {
    expect(matchBudgetOrder([memory('semantic', 0.4), memory('semantic', 0.7), memory('semantic', 0.4), memory('semantic', 0.7)])).toEqual([1, 3, 0, 2]);
  });

  it('ranks a score that is not a number last among the scored matches', () => {
    const list = [memory('semantic'), memory('semantic', Number.NaN), memory('semantic', -0.5), memory('semantic', 0.2)];
    expect(matchBudgetOrder(list)).toEqual([3, 2, 0, 1]);
  });

  it('counts a match that the words also found as scored, and leaves what the expansion added out', () => {
    const list = [memory('session-expand', 0), memory('semantic+content+fts', 0.4), memory('fts+note-identity', 3), memory('semantic', 0.6)];
    expect(matchBudgetOrder(list)).toEqual([3, 1, 2]);
  });

  it('takes the match that names the service in the question first, only when asked to', () => {
    const daily = (score: number): AgentContextMemory => ({ notePath: 'daily.md', text: 'Fixed a flaky test with fake timers', reason: 'semantic', score });
    const decision: AgentContextMemory = { notePath: 'notes.md', headingPath: 'Decision for invoice-service', text: 'Decision for invoice-service: tests run on vitest, not jest', reason: 'semantic', score: 0.3 };
    const list = [daily(0.9), daily(0.8), decision];
    expect(matchBudgetOrder(list)).toEqual([0, 1, 2]);
    expect(matchBudgetOrder(list, 'which test runner does invoice-service use?')).toEqual([2, 0, 1]);
    expect(matchBudgetOrder(list, 'which test runner do we use?')).toEqual([0, 1, 2]);
  });

  it('reads service names and the switch', () => {
    expect(serviceNames('Auth-Proxy and invoice_service, v1.2 no')).toEqual(['auth-proxy', 'invoice_service']);
    expect(serviceNoteFirstEnabled({})).toBe(false);
    expect(serviceNoteFirstEnabled({ RENOR_SERVICE_NOTE_FIRST: 'on' })).toBe(true);
  });
});
