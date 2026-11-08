import { describe, it, expect, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { SUPERSEDED_LABEL } from '../../src/retrieval/ledgerLiveness';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * A belief the user has moved on from must close, and must stop answering questions.
 *
 * The PrecisionMemBench run (data/renor-precisionmembench/report.md, §8) found no leakage of a superseded belief
 * through the product path, and named the durable half of that finding as a test rather than the adapter that measured
 * it: a synthetic workspace, one note per belief plus a `remember` chain, asserting that every chain closes as a real
 * ledger lifecycle and that a superseded belief is never returned for a query still using its old terminology. The
 * adapter needed a second git repository, a paid API and Node 22; this needs a temporary directory.
 *
 * What is under test is the lifecycle, not the ranking, so it is asserted where it is decided and where it is read:
 *   - the ledger lifecycle, through `retrieve_memory`: with include_history every value ever held is there, one of
 *     them current and the rest closed and dated; without it only the live value is;
 *   - the reads, through all three tools a caller has: no fact, no memory and no keyword result may carry a
 *     superseded value for a query in the old terminology, while the value that replaced it does answer;
 *   - history is asked for, never inferred: without it nothing closed is shown, and with it what is shown says on
 *     its face that it is historical.
 *
 * The embeddings are the deterministic eval-hash stub, so this says nothing about how a real embedding model ranks
 * these queries; it pins the lifecycle and the liveness filter, which hold for every provider. Where the lexical stub
 * cannot express a property, the test says so rather than asserting something weaker than it looks.
 */

interface Chain {
  /** Each chain is its own subject+predicate stream, so a chain never closes another chain's values. */
  subject: string;
  predicate: string;
  /** The values in the order they were believed, oldest first. The last one is current. */
  values: string[];
  /** The question a caller would still ask while speaking the old terminology, and the words to look for. */
  staleQuery: string;
  staleKeywords: string;
  /** The question asked in the current terminology, and the words to look for. */
  currentQuery: string;
  currentKeywords: string;
  /** Names the chain, so every value and every question is about something of its own. */
  topic: string;
}

/** Three supersession chains; the longest is three hops, as in the benchmark fixtures. */
const CHAINS: Chain[] = [
  {
    subject: 'renor-lint',
    predicate: 'linter',
    values: ['TSLint', 'ESLint', 'Biome'],
    topic: 'the renor-lint project',
    staleQuery: 'Which linter does the renor-lint project use? I thought it was TSLint.',
    staleKeywords: 'TSLint',
    currentQuery: 'Which linter does the renor-lint project use?',
    currentKeywords: 'Biome',
  },
  {
    subject: 'renor-api',
    predicate: 'framework',
    values: ['Express', 'Hono'],
    topic: 'the renor-api service',
    staleQuery: 'Which framework does the renor-api service run on? Express, I believe.',
    staleKeywords: 'Express',
    currentQuery: 'Which framework does the renor-api service run on?',
    currentKeywords: 'Hono',
  },
  {
    subject: 'renor-store',
    predicate: 'engine',
    values: ['Redis', 'Valkey'],
    topic: 'the renor-store cache',
    staleQuery: 'Which engine is the renor-store cache on? Redis, I thought.',
    staleKeywords: 'Redis',
    currentQuery: 'Which engine is the renor-store cache on?',
    currentKeywords: 'Valkey',
  },
];

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
  'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_READ_HONESTY', 'RENOR_NEWEST_FIRST', 'RENOR_CONTEXT_RELEVANCE',
  'RENOR_CONTEXT_RELEVANCE_MIN',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const cleanups: Array<() => Promise<void>> = [];
const dirs: string[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

type Fact = { predicate: string; object: string; current: boolean; scope: string; validFrom: string; validTo: string | null; eventId: string | null };
type Hit = { text: string; notePath?: string };

/** The real MCP surface in memory, with the deterministic eval-hash embeddings. Calls are sequential. */
async function serve() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supersession-chains-'));
  dirs.push(root);
  const memoryDir = path.join(root, 'memory');
  const authRoot = path.join(root, 'auth');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    // No configured provider: the injected stub is what this workspace runs on.
    MVP_EMBEDDING_PROVIDER: 'none',
    RENOR_SEARCH_EVIDENCE: '0',
  });
  const app = createMvpApp(loadMvpConfig(), new EvalHashEmbeddingProvider());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'supersession-chains', version: '0.1.0' });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await app.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0].text;
    if (res.isError) throw new Error(`${name} ${JSON.stringify(args)}: ${text}`);
    return JSON.parse(text);
  };
  return { call, memoryDir };
}

type Workspace = Awaited<ReturnType<typeof serve>>;

/** The whole chain, one `remember` per value, in the order it was believed. Every write is a fact with the user's words. */
async function writeChain(ws: Workspace, chain: Chain): Promise<string[]> {
  const eventIds: string[] = [];
  for (const [i, value] of chain.values.entries()) {
    const saved = await ws.call('remember', {
      statement: `The ${chain.predicate} of ${chain.topic} is ${value}.`,
      subject: chain.subject,
      predicate: chain.predicate,
      object: value,
      source: 'claude',
    });
    expect(saved, `${chain.topic}: ${value}`).toMatchObject({ ok: true, mode: 'fact' });
    // The first value is stored; every one after it supersedes the value before, which is what closes it.
    expect(saved.action, `${chain.topic}: ${value}`).toBe(i === 0 ? 'store' : 'supersede');
    expect(saved.created.object, `${chain.topic}: ${value}`).toBe(value);
    if (i > 0) expect(saved.closed.object, `${chain.topic}: ${value} closes`).toBe(chain.values[i - 1]);
    eventIds.push(saved.eventId as string);
  }
  await ws.call('index_memory', {});
  return eventIds;
}

/** What each read tool answers for one question. The keyword tool is given the words to look for, not a sentence. */
async function ask(ws: Workspace, query: string, keywords: string, extra: Record<string, unknown> = {}) {
  const context = await ws.call('get_context', { query, max_tokens: 4000, ...extra });
  const search = await ws.call('search_memory', { query, ...extra });
  const text = await ws.call('search_text', { query: keywords });
  return {
    contextFacts: (context.facts ?? []) as Fact[],
    contextHits: (context.memories ?? []) as Hit[],
    searchHits: (search.hits ?? []) as Hit[],
    textHits: (text.results ?? []) as Hit[],
  };
}

type Reads = Awaited<ReturnType<typeof ask>>;

/** Each read surface as the strings a caller would read: the fact values, and the memory texts. */
const surfaces = (reads: Reads): Array<[string, string[]]> => [
  ['get_context facts', reads.contextFacts.map(f => f.object)],
  ['get_context memories', reads.contextHits.map(h => h.text)],
  ['search_memory hits', reads.searchHits.map(h => h.text)],
  ['search_text results', reads.textHits.map(h => h.text)],
];

const mentioning = (reads: Reads, value: string): string[] =>
  surfaces(reads).filter(([, items]) => items.some(t => t.includes(value))).map(([name]) => name);

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a chain of beliefs about one thing', () => {
  it('closes every hop as a ledger lifecycle: all values on request, one current, each closed one dated', async () => {
    const ws = await serve();
    for (const chain of CHAINS) {
      const eventIds = await writeChain(ws, chain);
      const live = await ws.call('retrieve_memory', { subject: chain.subject }) as { facts: Fact[] };
      const history = await ws.call('retrieve_memory', { subject: chain.subject, include_history: true }) as { facts: Fact[] };
      const final = chain.values[chain.values.length - 1];

      // Without history the read answers with the live value alone.
      expect(live.facts.map(f => f.object), chain.topic).toEqual([final]);
      expect(live.facts[0].current, chain.topic).toBe(true);
      expect(live.facts[0].validTo, chain.topic).toBeNull();

      // With history the whole chain is there, each value saying whether it is still the one held. The read is
      // newest-first, so the chain is judged by its own timestamps rather than by the order it came back in.
      const byTime = [...history.facts].sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom));
      expect(byTime.map(f => f.object), chain.topic).toEqual(chain.values);
      expect(byTime.map(f => f.current), chain.topic).toEqual(chain.values.map((_, i) => i === chain.values.length - 1));
      expect(byTime.map(f => f.scope), chain.topic).toEqual(chain.values.map(() => 'global'));
      // Every hop has its own event, and every superseded value is closed at the moment its successor was written.
      expect(byTime.map(f => f.eventId), chain.topic).toEqual(eventIds);
      // Every value but the last is closed at the moment the one that replaced it was written.
      for (let i = 0; i < byTime.length - 1; i++) {
        expect(byTime[i].validTo, `${chain.topic}[${i}] closed by the value after it`).toBe(byTime[i + 1].validFrom);
      }
      expect(byTime[byTime.length - 1].validTo, `${chain.topic}: the live value is open`).toBeNull();
    }
  }, 180_000);

  it('never answers a question in the old terminology with the belief it has moved on from', async () => {
    const ws = await serve();
    for (const chain of CHAINS) await writeChain(ws, chain);
    for (const chain of CHAINS) {
      const stale = chain.values.slice(0, -1);
      const final = chain.values[chain.values.length - 1];
      for (const value of stale) {
        expect(mentioning(await ask(ws, chain.staleQuery, chain.staleKeywords), value), `${chain.topic}: "${value}"`).toEqual([]);
        // The keyword tool is asked for the old value as written, which is the sharpest form of the question.
        expect(mentioning(await ask(ws, chain.staleQuery, value), value), `${chain.topic}: "${value}" by keyword`).toEqual([]);
      }
      // Not answered by silence: the value that replaced each stale one is there, and it answers the question.
      const asked = await ask(ws, chain.currentQuery, chain.currentKeywords);
      expect(asked.contextFacts.map(f => f.object), `${chain.topic}: the live value answers`).toEqual([final]);
      expect(mentioning(asked, final), `${chain.topic}: the live value is found by every read`).not.toEqual([]);
      for (const value of stale) expect(mentioning(asked, value), `${chain.topic}: "${value}" on a current query`).toEqual([]);
    }
  }, 180_000);

  it('shows a closed belief only when history is asked for, and then labels it as historical', async () => {
    const ws = await serve();
    for (const chain of CHAINS) await writeChain(ws, chain);
    for (const chain of CHAINS) {
      // The eval-hash stub is lexical, so which of a closed event's words reaches a read is a property of the stub
      // and not of the engine. What is decided by the engine, and what this asserts, is the liveness filter: a closed
      // event is not shown unless history was asked for, and whatever is shown under include_history carries the
      // label that says it is historical evidence.
      // Distinct texts: the same event comes back from more than one tool, and one hit may hold several events.
      const labelled = (reads: Reads) => [...new Set([...reads.contextHits, ...reads.searchHits, ...reads.textHits]
        .map(h => h.text).filter(t => t.includes(SUPERSEDED_LABEL)))];

      // Nothing closed is shown, and nothing claims to be historical, when history was not asked for.
      expect(labelled(await ask(ws, chain.staleQuery, chain.staleKeywords)), `${chain.topic}: no history asked for`).toEqual([]);

      const history = await ask(ws, chain.staleQuery, chain.staleKeywords, { include_history: true });
      // The workspace holds all three chains, and the lexical stub matches across them, so only this chain's own
      // closed values are judged here: the rest are other subjects' history.
      const stale = chain.values.slice(0, -1);
      const own = labelled(history).filter(text => stale.some(value => text.includes(value)));
      // Asking for it is what brings the closed events back, so this is not vacuous: every hop but the last is here,
      // and each is labelled on its face rather than passed off as a memory of what is true.
      expect(own.length, `${chain.topic}: every closed hop comes back on request`).toBe(stale.length);
      for (const value of stale) {
        const text = own.find(t => t.includes(value))!;
        expect(text, `${chain.topic}: "${value}" is labelled, and labelled first`).toMatch(
          new RegExp(`^${SUPERSEDED_LABEL.replace(/[[\]]/g, '\\$&')}\\n`));
        // One event per hit, and it is this value's: the statement the user said, not the record's markup.
        expect(stale.filter(v => text.includes(v)).length, `${chain.topic}: "${value}" alone in its hit`).toBe(1);
      }
      // A labelled hit is historical evidence, never a current fact: the current value is still the one that replaced it.
      expect(history.contextFacts.map(f => f.object), `${chain.topic}: the live value is still the current one`)
        .toEqual([chain.values[chain.values.length - 1]]);
    }
  }, 180_000);
});
