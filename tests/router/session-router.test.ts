import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { encode } from 'gpt-tokenizer';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { indexVault } from '../../src/indexer/pipeline';
import { chunkNote } from '../../src/indexer/chunker';
import { parseNote } from '../../src/indexer/parser';
import { retrieveContext, type RetrievalResult } from '../../src/retrieval/orchestrator';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import type { EvidenceChat, EvidenceChatRequest } from '../../src/evidence/secondPass';
import { RouterCache } from '../../src/router/routerCache';
import {
  ROUTER_MAX_DELIVERED_TOKENS,
  ROUTER_MAX_NODES,
  ROUTER_MAX_OUTPUT_TOKENS,
  ROUTER_MAX_SESSIONS,
  ROUTE_ATTEMPTS,
  STATEMENT_MAX_CHARS,
  SUMMARY_BATCH_MAX_NOTES,
  SUMMARY_MAX_OUTPUT_TOKENS,
  applySessionRouter,
  billedOutputTokens,
  buildSessionSummaries,
  noteStatements,
  parseRouterAnswer,
  parseSummaryNodes,
  resolveRouterProvider,
  resolveSessionRouterMode,
  resolveSessionRouterOptions,
  splitQuestionDate,
  type SessionRouterOptions,
} from '../../src/router/sessionRouter';
import { renderSession } from '../../scripts/eval/run-longmemeval-product';
import { kindOf, stubReply, type StubBehaviour } from './stubRouterModel';
import { LEDGER, QUESTION, SESSIONS } from './fixtureSessions';
import { removeTestDir } from '../helpers/removeDb';

/**
 * The session router (RENOR_SESSION_ROUTER) against a real index of benchmark-shaped notes (rendered by the product
 * benchmark's own renderer), with a deterministic stub standing in for the summary and routing models. No provider
 * call is made anywhere in this file.
 */

const tmpDirs: string[] = [];
const ENV_KEYS = [
  'RENOR_SESSION_ROUTER', 'RENOR_ROUTER_MODEL', 'RENOR_ROUTER_SUMMARY_MODEL', 'RENOR_ROUTER_CACHE',
  'RENOR_ROUTER_TIMEOUT_MS', 'RENOR_ROUTER_RETRIES', 'RENOR_EVIDENCE_MODEL', 'RENOR_EVIDENCE_API_KEY',
  'RENOR_EVIDENCE_API_KEYS', 'RENOR_EVIDENCE_BASE_URL', 'RENOR_NEWEST_FIRST',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const openHandles: Array<{ close(): void }> = [];
afterEach(() => {
  try {
    for (const handle of openHandles.splice(0)) handle.close();
    for (const dir of tmpDirs.splice(0)) removeTestDir(dir);
  } finally {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

/** A stub transport that records every request and answers like the stub model. */
function stubChat(behaviour: { summary?: StubBehaviour; route?: StubBehaviour } = {}): EvidenceChat & { requests: EvidenceChatRequest[] } {
  const requests: EvidenceChatRequest[] = [];
  const chat = (async (request: EvidenceChatRequest) => {
    requests.push(request);
    const content = stubReply(request.messages[request.messages.length - 1].content, behaviour);
    if (content === null) throw new Error('extractor provider returned 500');
    return { content, promptTokens: 100, completionTokens: 20, latencyMs: 5 };
  }) as EvidenceChat & { requests: EvidenceChatRequest[] };
  chat.requests = requests;
  return chat;
}

function routerOptions(chat: EvidenceChat | undefined, mode: 'replace' | 'union' = 'replace'): SessionRouterOptions {
  return {
    mode, routerModel: 'stub-router', summaryModel: 'stub-summary', cachePath: '', timeoutMs: 10_000, retries: 0, summaryRetries: 0,
    ...(chat ? { routeChat: chat, summaryChat: chat } : {}),
  };
}

async function fixture(sessions = SESSIONS, extra: (vault: string) => void = () => {}) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'session-router-'));
  tmpDirs.push(vault);
  fs.mkdirSync(path.join(vault, 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'System'), { recursive: true });
  for (const session of sessions) {
    const file = path.join(vault, 'Sessions', `${session.id}.md`);
    fs.writeFileSync(file, renderSession(session.id, session.date, session.turns));
    // An imported transcript is written after its May session dates; future claims are now capped at mtime.
    const when = new Date(Date.UTC(2023, 5, 1));
    fs.utimesSync(file, when, when);
  }
  // A memory ledger mentioning a cat: it is a note of the index, and the router must never be shown it.
  fs.writeFileSync(path.join(vault, LEDGER),
    '---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n## MEM_CAT1 · 2023-05-02T00:00:00.000Z\n- kind: store\n- subject: cat\n- predicate: adopted\n- object: Miso\n');
  extra(vault);
  const db = openDb(path.join(vault, 'index.db'));
  openHandles.push(db);
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await indexVault(db, vault, { embeddingProvider: provider, vectorIndex }, 2);
  const cache = new RouterCache(path.join(vault, 'router-cache.db'));
  openHandles.push(cache);
  const retrieve = (query: string, topK = 20): Promise<RetrievalResult> =>
    retrieveContext(db, vectorIndex, provider, query, topK, [], {}, {});
  return { vault, db, cache, retrieve };
}

async function routed(
  fx: { vault: string; db: Database.Database; cache: RouterCache; retrieve: (q: string, k?: number) => Promise<RetrievalResult> },
  options: SessionRouterOptions,
  query = QUESTION,
  topK = 20,
) {
  const retrieved = await fx.retrieve(query, topK);
  const out = await applySessionRouter({
    db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, query, retrieved, options, cache: fx.cache,
  });
  return { retrieved, ...out };
}

const sessionFile = (vault: string, id: string) => path.join(vault, 'Sessions', `${id}.md`);

describe('RENOR_SESSION_ROUTER: mode and options', () => {
  it('is off unless armed, and refuses a value it does not know', () => {
    for (const raw of [undefined, '', '0', 'off', 'false', 'no', ' OFF ']) {
      expect(resolveSessionRouterMode(raw === undefined ? {} : { RENOR_SESSION_ROUTER: raw })).toBe('off');
    }
    for (const raw of ['1', 'on', 'true', 'yes', 'replace', 'REPLACE']) {
      expect(resolveSessionRouterMode({ RENOR_SESSION_ROUTER: raw })).toBe('replace');
    }
    expect(resolveSessionRouterMode({ RENOR_SESSION_ROUTER: 'union' })).toBe('union');
    expect(() => resolveSessionRouterMode({ RENOR_SESSION_ROUTER: 'unoin' })).toThrow(/Invalid RENOR_SESSION_ROUTER "unoin"/);
  });

  it('is null when off, and otherwise names its models, cache and bounds from the evidence provider settings', () => {
    const config = { dbPath: '/data/vault/.semantic-memory/index.db' };
    expect(resolveSessionRouterOptions(config, {})).toBeNull();
    const bare = resolveSessionRouterOptions(config, { RENOR_SESSION_ROUTER: '1' })!;
    expect(bare.mode).toBe('replace');
    expect(bare.routerModel).toBe('gemma4:31b'); // the evidence default
    expect(bare.summaryModel).toBe('gemma4:31b');
    expect(bare.cachePath).toBe('/data/vault/.semantic-memory/router-cache.db');
    expect(bare.timeoutMs).toBe(10_000);
    expect(bare.retries).toBe(1);
    expect(bare.summaryRetries).toBe(3); // index time is not latency-bound
    expect(bare.routeChat).toBeUndefined(); // no key, no transport
    expect(bare.summaryChat).toBeUndefined();

    const viaEvidence = resolveSessionRouterOptions(config, {
      RENOR_SESSION_ROUTER: 'union', RENOR_EVIDENCE_MODEL: 'evidence-model', RENOR_EVIDENCE_API_KEY: 'k',
    })!;
    expect(viaEvidence.mode).toBe('union');
    expect(viaEvidence.routerModel).toBe('evidence-model');
    expect(typeof viaEvidence.routeChat).toBe('function');
    expect(typeof viaEvidence.summaryChat).toBe('function');

    const explicit = resolveSessionRouterOptions(config, {
      RENOR_SESSION_ROUTER: 'on', RENOR_ROUTER_MODEL: 'router-x', RENOR_ROUTER_SUMMARY_MODEL: 'summary-y',
      RENOR_ROUTER_CACHE: '/tmp/r.db', RENOR_ROUTER_TIMEOUT_MS: '999999', RENOR_ROUTER_RETRIES: '-3',
      RENOR_EVIDENCE_API_KEYS: 'a,b',
    })!;
    expect(explicit.routerModel).toBe('router-x');
    expect(explicit.summaryModel).toBe('summary-y');
    expect(explicit.cachePath).toBe('/tmp/r.db');
    expect(explicit.timeoutMs).toBe(120_000); // clamped: the latency bound cannot be configured away
    expect(explicit.retries).toBe(0);
    expect(explicit.summaryRetries).toBe(0); // an explicit value is the value for both kinds of call
    const junk = resolveSessionRouterOptions(config, { RENOR_SESSION_ROUTER: 'on', RENOR_ROUTER_TIMEOUT_MS: 'soon', RENOR_ROUTER_RETRIES: 'many' })!;
    expect(junk.timeoutMs).toBe(10_000);
    expect(junk.retries).toBe(1);
    expect(junk.summaryRetries).toBe(3);
  });
});

describe('the router\'s provider', () => {
  it('uses its own slot when RENOR_ROUTER_API_KEY(S) is set, else the evidence provider as a unit (keys never cross endpoints)', () => {
    expect(resolveRouterProvider({
      RENOR_ROUTER_API_KEY: 'r1', RENOR_ROUTER_API_KEYS: 'r2, r3', RENOR_ROUTER_BASE_URL: 'https://router.example/v1',
      RENOR_EVIDENCE_API_KEY: 'e1', RENOR_EVIDENCE_BASE_URL: 'https://evidence.example/v1', OLLAMA_API_KEY: 'o1',
    })).toEqual({ baseUrl: 'https://router.example/v1', keys: ['r2', 'r3', 'r1'], slot: 'router' });
    expect(resolveRouterProvider({ RENOR_ROUTER_API_KEY: 'r1', RENOR_EVIDENCE_BASE_URL: 'https://evidence.example/v1' }))
      .toEqual({ baseUrl: 'https://evidence.example/v1', keys: ['r1'], slot: 'router' });
    // A router base URL with no router key is not paired with the evidence keys.
    expect(resolveRouterProvider({ RENOR_ROUTER_BASE_URL: 'https://router.example/v1', RENOR_EVIDENCE_API_KEY: 'e1', OLLAMA_API_KEY: 'o1' }))
      .toEqual({ baseUrl: undefined, keys: ['e1', 'o1'], slot: 'evidence' });
    expect(resolveRouterProvider({})).toEqual({ baseUrl: undefined, keys: [], slot: 'evidence' });
  });
});

describe('billed output tokens', () => {
  it('counts hidden thinking when the provider reports a total (Gemini), else the completion', () => {
    expect(billedOutputTokens({ promptTokens: 5_700, completionTokens: 40, totalTokens: 5_940 })).toBe(240);
    expect(billedOutputTokens({ promptTokens: 100, completionTokens: 20 })).toBe(20);
    expect(billedOutputTokens({ promptTokens: 100, completionTokens: 20, totalTokens: 110 })).toBe(20); // never below the completion
    expect(billedOutputTokens({})).toBe(0);
  });
});

describe('statements: the short heading sections of a note', () => {
  it('keeps short sections with their heading (the header, user turns, a short assistant turn) and drops long ones', () => {
    const note = parseNote('/v/s.md', renderSession('sess-cats-1', '2023/05/01 (Mon) 10:00', SESSIONS[0].turns));
    expect(noteStatements(note)).toEqual([
      '# Session sess-cats-1\n\nTimestamp: 2023/05/01 (Mon) 10:00',
      "### Turn 1 — User\n\nI'm thinking about pet insurance. By the way, I adopted a rescue cat named Miso last week.",
      '### Turn 3 — User\n\nThanks! Miso is three years old.',
      "### Turn 4 — Assistant\n\nYou're welcome! Enjoy Miso.",
    ]);
  });

  it('cuts the note where the chunker cuts it, so a statement is byte-identical to its chunk', () => {
    const note = parseNote('/v/s.md', renderSession('sess-cats-1', '2023/05/01 (Mon) 10:00', SESSIONS[0].turns));
    const chunkTexts = new Set(chunkNote(note).map(chunk => chunk.text));
    for (const statement of noteStatements(note)) expect(chunkTexts.has(statement)).toBe(true);
  });

  it('takes a daily note\'s entries as its statements, each one whole, as the chunker cuts them', () => {
    const day = parseNote('/v/Memory/Daily/2026-10-01.md', '---\nkind: note\nupdated: 2026-10-01\nrenor: daily-v1\n---\n# 2026-10-01\n\n'
      + '- [08:30:00] (claude) I adopted a cat named Miso.\n- [09:10:00] (mcp) Plan:\n## not a heading here\nfeed Miso twice a day\n'
      + `- [10:00:00] (claude) ${'A long entry about the weekend. '.repeat(30)}\n`);
    expect(noteStatements(day)).toEqual([
      '- [08:30:00] (claude) I adopted a cat named Miso.',
      '- [09:10:00] (mcp) Plan:\n## not a heading here\nfeed Miso twice a day',
    ]);
    const chunkTexts = new Set(chunkNote(day).map(chunk => chunk.text));
    for (const statement of noteStatements(day)) expect(chunkTexts.has(statement)).toBe(true);
  });

  it('draws the line at STATEMENT_MAX_CHARS of content, skips empty sections, and keeps a short preamble', () => {
    const at = (n: number) => 'x'.repeat(n);
    const body = `Short preamble.\n\n## Empty\n\n## Just under\n\n${at(STATEMENT_MAX_CHARS - 1)}\n\n## At the limit\n\n${at(STATEMENT_MAX_CHARS)}`;
    expect(noteStatements(parseNote('/v/n.md', body))).toEqual(['Short preamble.', `## Just under\n\n${at(STATEMENT_MAX_CHARS - 1)}`]);
  });
});

describe('parsing model answers', () => {
  it('reads a routing answer as JSON, fenced JSON, prose around JSON, or after a leaked thought', () => {
    expect(parseRouterAnswer('{"thinking": "t", "node_list": ["0001", 3]}')).toEqual({ nodeIds: ['0001', '3'], thinking: 't' });
    expect(parseRouterAnswer('```json\n{"node_list": ["0002"]}\n```').nodeIds).toEqual(['0002']);
    expect(parseRouterAnswer('Sure. {"a": {"b": 1}} then {"thinking": "x", "node_list": ["0004"]} done').nodeIds).toEqual(['0004']);
    expect(parseRouterAnswer('<thought>pick {"node_list": ["9999"]}</thought>{"node_list": ["0005"]}').nodeIds).toEqual(['0005']);
    expect(parseRouterAnswer('<thought>unterminated thinking... {"thinking": "y", "node_list": ["0006"]}').nodeIds).toEqual(['0006']);
  });

  it('refuses an answer with no node list, so it is never cached and never routed on', () => {
    expect(() => parseRouterAnswer('I would rather not answer in JSON.')).toThrow(/node_list/);
    expect(() => parseRouterAnswer('{"thinking": "no list here"}')).toThrow(/node_list/);
    expect(() => parseRouterAnswer('{"node_list": "0001"}')).toThrow(/not a list/);
  });

  it('reads summary nodes by id and drops entries without an id or any text', () => {
    const nodes = parseSummaryNodes('{"nodes": [{"id": "c01", "title": "A", "summary": "s"}, {"id": "c02", "title": "", "summary": ""}, {"title": "no id"}, {"id": "C3", "summary": "only a summary"}]}');
    expect([...nodes.keys()]).toEqual(['c1', 'c3']); // case and leading zeros do not matter
    expect(nodes.get('c3')).toEqual({ title: 'Untitled conversation', summary: 'only a summary' });
    expect(parseSummaryNodes('not json').size).toBe(0);
  });

  it('splits a date-stamped question, and dates any other question today', () => {
    expect(splitQuestionDate(QUESTION, 0)).toEqual({ questionDate: '2023/05/30 (Tue) 12:00', question: 'What are the names of the cats I adopted?' });
    expect(splitQuestionDate('Where did I go last week?', Date.UTC(2026, 9, 3, 12))).toEqual({ questionDate: '2026-10-03', question: 'Where did I go last week?' });
  });
});

describe('index time: one title + summary per note, paid once', () => {
  it('summarises every note but the ledger in one batched call, and an unchanged note is never summarised again', async () => {
    const fx = await fixture();
    const chat = stubChat();
    const first = await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fx.cache });
    expect(first).toMatchObject({ model: 'stub-summary', notes: 4, cached: 0, summarized: 4, failed: 0, calls: 1 });
    expect(chat.requests).toHaveLength(1);
    const request = chat.requests[0];
    expect(request.model).toBe('stub-summary');
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(request.max_tokens).toBe(SUMMARY_MAX_OUTPUT_TOKENS);
    const prompt = request.messages[0].content;
    expect(prompt).toContain('=== CONVERSATION id=c01 date=2023/05/01 (Mon) 10:00 ===\n# Session sess-cats-1');
    expect(prompt).not.toContain('Memory Events Ledger');
    expect(prompt.indexOf('sess-cats-1')).toBeLessThan(prompt.indexOf('sess-trip-4')); // oldest first

    const again = await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fx.cache });
    expect(again).toMatchObject({ notes: 4, cached: 4, summarized: 0, failed: 0, calls: 0 });
    expect(chat.requests).toHaveLength(1);
  });

  it('summarises a daily note (its index hash also names its chunk layout) and routes to its entries', async () => {
    const fx = await fixture(SESSIONS, vault => {
      fs.mkdirSync(path.join(vault, 'Memory', 'Daily'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'Memory', 'Daily', '2023-05-28.md'),
        '---\nkind: note\nupdated: 2023-05-28\nrenor: daily-v1\n---\n# 2023-05-28\n\n- [08:30:00] (claude) I adopted a third cat, Mochi, at the market.\n- [09:00:00] (claude) Bought cat food.\n');
    });
    const chat = stubChat();
    const stats = await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fx.cache });
    expect(stats).toMatchObject({ notes: 5, summarized: 5, failed: 0 });
    const { hits, report } = await routed(fx, routerOptions(chat));
    expect(report.status).toBe('ok');
    const daily = hits.find(hit => hit.notePath.endsWith('2023-05-28.md'))!;
    expect(daily.text).toBe('- [08:30:00] (claude) I adopted a third cat, Mochi, at the market.\n\n- [09:00:00] (claude) Bought cat food.');
  });

  it('batches at most SUMMARY_BATCH_MAX_NOTES notes per call and summarises a very long note from its head and tail', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `sess-${i}`, date: `2023/04/${String(i + 10).padStart(2, '0')} (Mon) 10:00`,
      turns: [{ role: 'user' as const, content: i === 0 ? `Start. ${'long text '.repeat(3_000)} END-OF-NOTE` : `Note number ${i}.` }],
    }));
    const fx = await fixture(many);
    const chat = stubChat();
    const stats = await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fx.cache });
    expect(stats).toMatchObject({ notes: 10, summarized: 10, failed: 0, calls: 2 });
    expect(chat.requests.map(r => (r.messages[0].content.match(/=== CONVERSATION id=/g) ?? []).length)).toEqual([SUMMARY_BATCH_MAX_NOTES, 2]);
    const first = chat.requests[0].messages[0].content;
    expect(first).toContain('[... middle of conversation omitted ...]');
    expect(first).toContain('END-OF-NOTE');
  });

  it('counts the notes a failed or incomplete answer left without a summary, and keeps nothing it could not parse', async () => {
    const failing = await fixture();
    const down = await buildSessionSummaries({ db: failing.db, vaultPath: failing.vault, ledgerRelPath: LEDGER, options: routerOptions(stubChat({ summary: 'http-500' })), cache: failing.cache });
    expect(down).toMatchObject({ notes: 4, summarized: 0, failed: 4 });
    expect(down.error).toMatch(/summary call failed/);

    // A failed transport stops the run: the later batches are not sent against the same wall.
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `sess-${i}`, date: `2023/04/${String(i + 1).padStart(2, '0')} (Mon) 10:00`, turns: [{ role: 'user' as const, content: `Note ${i}.` }] }));
    const wall = await fixture(many);
    const blocked = stubChat({ summary: 'http-500' });
    const stopped = await buildSessionSummaries({ db: wall.db, vaultPath: wall.vault, ledgerRelPath: LEDGER, options: routerOptions(blocked), cache: wall.cache });
    expect(stopped).toMatchObject({ notes: 20, summarized: 0, failed: 20, calls: 1 });
    expect(blocked.requests).toHaveLength(1); // 3 batches of up to 8, only the first one sent

    const partial = await fixture();
    const chat = stubChat({ summary: 'unknown-ids' });
    const stats = await buildSessionSummaries({ db: partial.db, vaultPath: partial.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: partial.cache });
    expect(stats).toMatchObject({ notes: 4, summarized: 0, failed: 4, calls: 2 }); // asked once more, then given up
    expect(chat.requests[1].messages[0].content).toBe(`${chat.requests[0].messages[0].content}\n`);

    const none = await fixture();
    const noModel = await buildSessionSummaries({ db: none.db, vaultPath: none.vault, ledgerRelPath: LEDGER, options: routerOptions(undefined), cache: none.cache });
    expect(noModel).toMatchObject({ notes: 4, failed: 4, calls: 0, error: 'no summary model configured' });
  });
});

describe('read time: route, then deliver the routed notes\' statements', () => {
  it('replace: delivers only the routed sessions\' statements, newest first, and reports what it spent', async () => {
    const fx = await fixture();
    const chat = stubChat();
    await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fx.cache });
    const { hits, report, retrieved } = await routed(fx, routerOptions(chat));

    expect(report).toMatchObject({ status: 'ok', mode: 'replace', model: 'stub-router', summaryModel: 'stub-summary', nodes: 4, fromCache: false });
    expect(report.routed!.map(r => path.basename(r.notePath))).toEqual(['sess-cats-1.md', 'sess-cats-3.md']); // routing order
    expect(hits.map(h => path.basename(h.notePath))).toEqual(['sess-cats-3.md', 'sess-cats-1.md']); // newest first
    expect(hits.every(h => h.reason === 'router' && h.chunkId === -1)).toBe(true);
    expect(hits[0].session_date).toBe('2023/05/20 (Sat) 09:15');
    expect(hits[1].text).toBe([
      '# Session sess-cats-1\n\nTimestamp: 2023/05/01 (Mon) 10:00',
      "### Turn 1 — User\n\nI'm thinking about pet insurance. By the way, I adopted a rescue cat named Miso last week.",
      '### Turn 3 — User\n\nThanks! Miso is three years old.',
      "### Turn 4 — Assistant\n\nYou're welcome! Enjoy Miso.",
    ].join('\n\n'));
    expect(hits.some(h => h.text.includes('Here is a detailed answer'))).toBe(false); // long answers are not statements
    expect(retrieved.hits.some(h => h.text.includes('Here is a detailed answer'))).toBe(true); // ...though retrieval had them
    expect(report.deliveredTokens).toBe(hits.reduce((sum, h) => sum + encode(h.text).length, 0));
    expect(report.usage).toEqual({ promptTokens: 100, completionTokens: 20 });

    const route = chat.requests.find(r => kindOf(r.messages[0].content) === 'route')!;
    expect(route.model).toBe('stub-router');
    expect(route.max_tokens).toBe(ROUTER_MAX_OUTPUT_TOKENS);
    expect(route.response_format).toEqual({ type: 'json_object' });
    const prompt = route.messages[0].content;
    expect(prompt).toContain('Question date: 2023/05/30 (Tue) 12:00\nQuestion: What are the names of the cats I adopted?');
    expect(prompt.match(/^\{"node_id": /gm)).toHaveLength(4); // the ledger is never a node
    expect(prompt).toContain('{"node_id": "0001", "date": "2023/05/01 (Mon) 10:00", "title": ');
  });

  it('replays a routing answer from the cache: same hits, no second call', async () => {
    const fx = await fixture();
    const chat = stubChat();
    await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fx.cache });
    const first = await routed(fx, routerOptions(chat));
    const calls = chat.requests.length;
    const second = await routed(fx, routerOptions(chat));
    expect(chat.requests).toHaveLength(calls);
    expect(second.report).toMatchObject({ status: 'ok', fromCache: true, usage: first.report.usage, latencyMs: first.report.latencyMs });
    expect(second.hits).toEqual(first.hits);
  });

  it('union: keeps the retrieved window and adds only the routed statements it does not already hold', async () => {
    const fx = await fixture();
    const chat = stubChat();
    await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fx.cache });
    const { hits, report, retrieved } = await routed(fx, routerOptions(chat, 'union'), QUESTION, 3);
    expect(report).toMatchObject({ status: 'ok', mode: 'union' });
    const texts = hits.map(h => h.text);
    for (const hit of retrieved.hits) expect(texts).toContain(hit.text); // nothing retrieved is lost
    const added = hits.filter(h => h.reason === 'router');
    expect(added.length).toBeGreaterThan(0);
    const addedStatements = added.flatMap(h => h.text.split(/\n\n(?=#)/));
    for (const statement of addedStatements) expect(retrieved.hits.map(h => h.text)).not.toContain(statement);
    expect(hits).toHaveLength(retrieved.hits.length + added.length);
    expect(report.routed!.reduce((sum, r) => sum + (r.alreadyRetrieved ?? 0), 0)).toBeGreaterThan(0); // the window's own share
  });

  it('union: when the window already holds every routed statement, the union is the window and the router agreed (ok)', async () => {
    const fx = await fixture();
    const chat = stubChat();
    await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fx.cache });
    const { hits, report, retrieved } = await routed(fx, routerOptions(chat, 'union')); // top-20 holds every chunk here
    expect(report).toMatchObject({ status: 'ok', mode: 'union', deliveredTokens: 0 });
    expect(report.truncated).toBeUndefined();
    expect(report.routed!.map(r => [path.basename(r.notePath), r.statements, r.alreadyRetrieved])).toEqual([
      ['sess-cats-1.md', 0, 4],
      ['sess-cats-3.md', 0, 2],
    ]);
    expect(hits).toEqual(retrieved.hits);
  });

  it('keeps the routing order when retrieval answers in score order (an explicit past-intent query)', async () => {
    process.env.RENOR_NEWEST_FIRST = '0';
    const fx = await fixture();
    const chat = stubChat();
    await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fx.cache });
    const { hits, retrieved } = await routed(fx, routerOptions(chat));
    expect(retrieved.rankedBy).toBe('score');
    expect(hits.map(h => path.basename(h.notePath))).toEqual(['sess-cats-1.md', 'sess-cats-3.md']);
  });
});

describe('bounds: what one search can cost and deliver', () => {
  it('delivers at most ROUTER_MAX_SESSIONS notes and ROUTER_MAX_DELIVERED_TOKENS tokens, however many it is routed', async () => {
    const wide = Array.from({ length: 20 }, (_, i) => ({
      id: `sess-cats-${String(i).padStart(2, '0')}`, date: `2023/03/${String(i + 1).padStart(2, '0')} (Mon) 10:00`,
      turns: [{ role: 'user' as const, content: `I adopted cat number ${i}.` }],
    }));
    const fx = await fixture(wide);
    const chat = stubChat();
    await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fx.cache });
    const { report } = await routed(fx, routerOptions(chat));
    expect(report.status).toBe('ok');
    expect(report.routed).toHaveLength(ROUTER_MAX_SESSIONS);
    expect(report.truncated).toBeUndefined(); // capped by count, not by the token budget

    const statement = (i: number) => `I adopted a cat; detail ${i}: ${'and then more about that day '.repeat(22)}`;
    const big = [{ id: 'sess-cats-big', date: '2023/03/01 (Mon) 10:00', turns: Array.from({ length: 60 }, (_, i) => ({ role: 'user' as const, content: statement(i) })) }];
    expect(statement(0).length).toBeLessThan(STATEMENT_MAX_CHARS);
    const fy = await fixture(big);
    await buildSessionSummaries({ db: fy.db, vaultPath: fy.vault, ledgerRelPath: LEDGER, options: routerOptions(chat), cache: fy.cache });
    const capped = await routed(fy, routerOptions(chat));
    expect(capped.report).toMatchObject({ status: 'ok', truncated: true });
    expect(capped.report.deliveredTokens!).toBeLessThanOrEqual(ROUTER_MAX_DELIVERED_TOKENS);
    expect(capped.report.deliveredTokens!).toBeGreaterThan(ROUTER_MAX_DELIVERED_TOKENS - 400);
    expect(capped.report.routed![0].statements).toBeLessThan(61);
  });

  it('never shows the router more than ROUTER_MAX_NODES notes: it steps aside instead', async () => {
    const fx = await fixture();
    const insert = fx.db.prepare('INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < ROUTER_MAX_NODES; i++) {
      insert.run(path.join(fx.vault, 'Bulk', `n${i}.md`), `n${i}`, 'note', `hash-${i}`, '2023-01-01T00:00:00.000Z', '{}');
    }
    const chat = stubChat();
    const { hits, report, retrieved } = await routed(fx, routerOptions(chat));
    expect(report).toMatchObject({ status: 'skipped', reason: 'too-many-notes', nodes: ROUTER_MAX_NODES + 4 });
    expect(hits).toBe(retrieved.hits);
    expect(chat.requests).toHaveLength(0);
  });
});

describe('fail-open: whenever it cannot route, search returns the retrieved hits and says why', () => {
  async function summarised(sessions = SESSIONS, extra?: (vault: string) => void) {
    const fx = await fixture(sessions, extra);
    await buildSessionSummaries({ db: fx.db, vaultPath: fx.vault, ledgerRelPath: LEDGER, options: routerOptions(stubChat()), cache: fx.cache });
    return fx;
  }

  it('no-model: no key, no call', async () => {
    const fx = await summarised();
    const { hits, report, retrieved } = await routed(fx, routerOptions(undefined));
    expect(report).toMatchObject({ status: 'skipped', reason: 'no-model' });
    expect(hits).toBe(retrieved.hits);
  });

  it('summaries-incomplete: a note indexed after the summaries were built', async () => {
    const fx = await summarised();
    fs.writeFileSync(sessionFile(fx.vault, 'sess-cats-1'), renderSession('sess-cats-1', '2023/05/01 (Mon) 10:00', [{ role: 'user', content: 'Edited: I adopted a cat named Miso.' }]));
    const provider = new EvalHashEmbeddingProvider();
    await indexVault(fx.db, fx.vault, { embeddingProvider: provider, vectorIndex: new VectorIndex(fx.db, provider.dimensions) }, 2);
    const chat = stubChat();
    const { hits, report, retrieved } = await routed(fx, routerOptions(chat));
    expect(report).toMatchObject({ status: 'skipped', reason: 'summaries-incomplete', nodes: 4, missingSummaries: 1 });
    expect(hits).toBe(retrieved.hits);
    expect(chat.requests).toHaveLength(0);
  });

  it('router-error: the call fails (after the transport\'s own retries)', async () => {
    const fx = await summarised();
    const { hits, report, retrieved } = await routed(fx, routerOptions(stubChat({ route: 'http-500' })));
    expect(report).toMatchObject({ status: 'skipped', reason: 'router-error', error: 'extractor provider returned 500' });
    expect(hits).toBe(retrieved.hits);
  });

  it('router-parse-error: asked ROUTE_ATTEMPTS times, never cached', async () => {
    const fx = await summarised();
    const chat = stubChat({ route: 'garbage' });
    const { report } = await routed(fx, routerOptions(chat));
    expect(report).toMatchObject({ status: 'skipped', reason: 'router-parse-error' });
    expect(chat.requests.filter(r => kindOf(r.messages[0].content) === 'route')).toHaveLength(ROUTE_ATTEMPTS);
    const healthy = stubChat();
    expect((await routed(fx, routerOptions(healthy))).report.status).toBe('ok'); // the bad answer was not cached
  });

  it('empty-route: the router names nothing, or nothing that exists', async () => {
    const fx = await summarised();
    expect((await routed(fx, routerOptions(stubChat({ route: 'empty' })))).report).toMatchObject({ status: 'skipped', reason: 'empty-route', nodes: 4 });
    const unknown = await routed(fx, routerOptions(stubChat({ route: 'unknown-ids' })));
    expect(unknown.report).toMatchObject({ status: 'skipped', reason: 'empty-route' });
    expect(unknown.hits).toBe(unknown.retrieved.hits);
  });

  it('no-statements: every routed note is one long section', async () => {
    const fx = await summarised([], vault => {
      fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'Notes', 'essay.md'), `---\nsession_date: "2023-05-02"\n---\n\nThe cats I adopted taught me patience. ${'Every morning starts the same way. '.repeat(40)}\n`);
    });
    const { hits, report, retrieved } = await routed(fx, routerOptions(stubChat()));
    expect(report).toMatchObject({ status: 'skipped', reason: 'no-statements', nodes: 1 });
    expect(hits).toBe(retrieved.hits);
  });

  it('no-notes: an empty vault (the ledger alone is not a note to route to)', async () => {
    const fx = await summarised([]);
    expect((await routed(fx, routerOptions(stubChat()))).report).toMatchObject({ status: 'skipped', reason: 'no-notes', nodes: 0 });
  });
});
