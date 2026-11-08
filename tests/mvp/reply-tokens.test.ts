import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { encode } from 'gpt-tokenizer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Express } from 'express';
import { loadMvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { identityLine } from '../../src/mvp/identity';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Cheaper replies and direct forgetting: the token-cost and forgetting findings of the live dogfood of 2026-10-03
 * (report `renor-live-dogfood-1003`, section 4), each over the real MCP surface:
 *
 *   D7  the facts lane matched facts on "you", "can", "not", "all", "now": every word outside its 46 stop words;
 *   D8  a hit of the ledger carried the ledger's path and the record's heading (`MEM_… · time`), and get_context
 *       returned one event twice, as a fact and as a memory;
 *   D9  get_context counted only its items against max_tokens: the echoed query, relevance and conflicts were outside;
 *   D11 retiring the last entry of a day left the day's file, its header alone, which no id could retire;
 *   D12 a note save's receipt carried no memory id, and memory_map took no scope, so forgetting meant a lookup of the
 *       whole workspace;
 *   D14 search_memory and search_text added up to top_k fact hits beyond the top_k hits of the index.
 *
 * Synthetic data only: a keyword-only workspace (no embedding provider, what a self-serve workspace runs) or the
 * deterministic eval-hash embeddings. No model, no network.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function token(app: Express): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'reply-tokens', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorize.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({
    ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
  }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  return tokens.body.access_token as string;
}

interface Reply {
  /** The text an agent reads (and pays for). */
  text: string;
  /** The text parsed; null for an error text. */
  body: any;
  isError: boolean;
}

interface Workspace {
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  reply(name: string, args?: Record<string, unknown>): Promise<Reply>;
  memoryDir: string;
}

/** The service behind the real MCP tools on a fresh workspace; calls run one at a time (one shared McpServer). */
async function workspace(provider: EmbeddingProvider | null, env: Record<string, string> = {}): Promise<Workspace> {
  const memoryDir = tmp('reply-tokens-');
  const port = await freePort();
  const saved = { ...process.env };
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(tmp('reply-tokens-auth-'), 'clients.json'),
    MVP_BASE_URL: `http://127.0.0.1:${port}`,
    MVP_OWNER_EMAIL: OWNER_EMAIL,
    MVP_OWNER_PASSWORD: OWNER_PASSWORD,
    MVP_PORT: String(port),
    MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
    RENOR_SEARCH_EVIDENCE: '0',
  });
  for (const key of ['MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'RENOR_READ_HONESTY', 'RENOR_CONTEXT_RELEVANCE_MIN', 'MVP_DB_PATH', 'MVP_LEDGER_REL']) delete process.env[key];
  Object.assign(process.env, env);
  const config = loadMvpConfig();
  const service = await startMvpService(config, provider);
  const client = new Client({ name: 'reply-tokens', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${await token(service.app)}` } } },
  ));
  cleanups.push(async () => {
    await client.close();
    service.httpServer.closeAllConnections?.();
    service.httpServer.close();
    await service.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const reply = async (name: string, args: Record<string, unknown> = {}): Promise<Reply> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* an error text */ }
    return { text, body, isError: result.isError === true };
  };
  return { call: async (name, args) => (await reply(name, args)).body, reply, memoryDir };
}

/** Tokens as the engine counts them: o200k (gpt-tokenizer), special-token syntax read as text. */
const tokens = (text: string) => encode(text, { disallowedSpecial: new Set() }).length;
// Every get_context reply names the Renor that answered (`renor`, B1), inside max_tokens. A test whose budgets were
// chosen for the room the items get adds what that line costs, so the items get the same room they got before it.
const IDENTITY = tokens(`{"maxTokens":0,"renor":${JSON.stringify(identityLine(undefined))}}`) - tokens('{"maxTokens":0}');
const factLine = (f: { subject: string; predicate: string }) => `${f.subject} / ${f.predicate}`;
const today = () => new Date().toISOString().slice(0, 10);

// --- D7 -------------------------------------------------------------------------------------------------------------

// The secret guard is on by default. These tests store fixture text that the guard refuses (a credential-shaped or an
// identifier-shaped sentence that is incidental to what each test checks), so they run with it explicitly off.
const SAVED_GUARD = process.env.RENOR_SECRET_GUARD;
beforeAll(() => { process.env.RENOR_SECRET_GUARD = '0'; });
afterAll(() => { if (SAVED_GUARD === undefined) delete process.env.RENOR_SECRET_GUARD; else process.env.RENOR_SECRET_GUARD = SAVED_GUARD; });

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('D7: the facts lane looks a fact up by the words that say what it is about', () => {
  it('a pronoun, an auxiliary, a quantifier or a negation finds no fact', async () => {
    const s = await workspace(null);
    await s.call('remember', { statement: 'The README still says you can not run all the tests offline now, the same as last week.', subject: 'readme task', predicate: 'found_not_fixed', object: 'you can not run all the tests offline now, the same as last week' });
    await s.call('remember', { statement: 'The billing service deploys to Fly.io in gru.', subject: 'billing service', predicate: 'deploy_target', object: 'Fly.io in the gru region' });

    // The live workspace's greetings (dogfood D7): each found the finding by "you" or "can".
    for (const query of ['Hi, how are you?', 'Can you tell me what has been going on?']) {
      expect((await s.call('get_context', { query })).facts, query).toEqual([]);
    }
    // Five such words outranked the one word the question is about, so the fact it asked for was cut (half of the best).
    expect((await s.call('get_context', { query: 'Is the deploy not all the same to you now?' })).facts.map(factLine))
      .toEqual(['billing service / deploy_target']);
    // The finding is still found by what it says.
    expect((await s.call('get_context', { query: 'Which tests do not run offline?' })).facts.map(factLine))
      .toEqual(['readme task / found_not_fixed']);
  });

  it("memory_map's lookup reads a request the same way: a memory that only says \"you\" is not what was asked for", async () => {
    const s = await workspace(null);
    await s.call('remember', { statement: 'Ottoline has a hazelnut allergy.' });
    await s.call('remember', { statement: 'Thank you for the flowers, you are kind.' });
    const found = await s.call('memory_map', { query: 'what did you say about the hazelnut allergy' });
    expect(found.memories.map((m: { title: string }) => m.title)).toEqual(['Ottoline has a hazelnut allergy.']);
  });
});

// --- D8 -------------------------------------------------------------------------------------------------------------

const BILLING = {
  statement: 'The billing review is done: we ship the new invoices on Friday.',
  subject: 'billing review', predicate: 'outcome', object: 'ship the new invoices on Friday',
};
/** The ledger's bookkeeping as a hit used to carry it: the ledger's path, its heading, a record's `MEM_… · time`. */
const LEDGER_INTERNALS = /Memory Events Ledger|MEM_[A-Za-z0-9]+/;

describe.skipIf(HTTP_SERVER_UNSUPPORTED)("D8: a hit shows what was said and when, never the ledger's path or record heading", () => {
  it('get_context, search_memory and search_text return an event without the ledger path and heading, and with its time', async () => {
    const s = await workspace(new EvalHashEmbeddingProvider());
    const saved = await s.call('remember', BILLING);
    await s.call('remember', { statement: 'Lunch with the design team moved to Thursday.' });

    const context = await s.reply('get_context', { query: 'billing review invoices' });
    const memory = await s.reply('search_memory', { query: 'billing review invoices', top_k: 5 });
    const text = await s.reply('search_text', { query: 'invoices' });
    for (const [tool, r] of [['get_context', context], ['search_memory', memory], ['search_text', text]] as const) {
      expect(r.text, tool).not.toMatch(LEDGER_INTERNALS);
    }
    // The event is still returned, as the user said it, and dated by when it was saved.
    const event = (hits: Array<{ text: string }>) => hits.find(h => h.text === BILLING.statement) as Record<string, unknown> | undefined;
    expect(event(memory.body.hits)).toMatchObject({ notePath: '', headingPath: '', session_date: saved.created.validFrom });
    expect(event(text.body.results)).toMatchObject({ notePath: '', headingPath: '', session_date: saved.created.validFrom });
    // A note keeps its path and heading.
    const lunch = memory.body.hits.find((h: { text: string }) => h.text.includes('Lunch with the design team'));
    expect(lunch.notePath).toBe(`Memory/Daily/${today()}.md`);
  });

  it('a fact hit of search_* names neither the ledger nor the event', async () => {
    const s = await workspace(new EvalHashEmbeddingProvider());
    const saved = await s.call('save_memory', { subject: 'production database', predicate: 'engine', object: 'Postgres 16 with pgvector' });
    const text = await s.reply('search_text', { query: 'pgvector' });
    expect(text.body.results).toEqual([{
      notePath: '', headingPath: '', text: 'production database — engine: Postgres 16 with pgvector', score: 1, reason: 'fact',
      session_date: saved.created.validFrom,
    }]);
    const memory = await s.reply('search_memory', { query: 'which database engine runs in production?' });
    expect(memory.text).not.toMatch(LEDGER_INTERNALS);
    expect(memory.body.hits.filter((h: { reason: string }) => h.reason === 'fact')).toHaveLength(1);
  });

  it('get_context returns an event once: a memory that is the event of a fact it lists is not repeated', async () => {
    const s = await workspace(new EvalHashEmbeddingProvider());
    await s.call('remember', BILLING);
    await s.call('remember', { statement: 'Lunch with the design team moved to Thursday.' });

    const body = await s.call('get_context', { query: 'What was the outcome of the billing review?' });
    expect(body.facts.map(factLine)).toEqual(['billing review / outcome']);
    expect(body.memories.map((m: { text: string }) => m.text)).not.toContain(BILLING.statement);
    expect(body.memories.length).toBeGreaterThan(0); // the other memories are still there
    expect(body.truncated).toBe(false); // the event is in the reply: nothing was cut

    // Asked by a word only the statement has, the facts lane finds no fact, and the event is a memory, as before.
    const done = await s.call('get_context', { query: 'Is it done?' });
    expect(done.facts).toEqual([]);
    expect(done.memories.map((m: { text: string }) => m.text)).toContain(BILLING.statement);
  });

  it("a person's words that copy a listed fact's record heading do not make their own event a repeat", async () => {
    const s = await workspace(new EvalHashEmbeddingProvider());
    const billing = await s.call('remember', BILLING);
    const pasted = `Pasted from the old zebracorn log:\n## ${billing.eventId} · ${billing.created.validFrom}\nend of paste`;
    await s.call('remember', { statement: pasted, subject: 'log paste', predicate: 'kind', object: 'pasted' });

    const body = await s.call('get_context', { query: 'billing review outcome zebracorn' });
    expect(body.facts.map(factLine)).toEqual(['billing review / outcome']);
    expect(body.memories.map((m: { text: string }) => m.text)).toContain(pasted);
    expect(body.memories.map((m: { text: string }) => m.text)).not.toContain(BILLING.statement);
    const text = await s.call('search_text', { query: 'zebracorn' });
    expect(text.results.find((h: { text: string }) => h.text === pasted)).toMatchObject({ notePath: '', headingPath: '' });
    expect(text.results.find((h: { text: string }) => h.text === pasted).session_date).not.toBe(billing.created.validFrom);
  });
});

// --- D9 -------------------------------------------------------------------------------------------------------------

const sentences = (topic: string, n: number) => Array.from({ length: n }, (_, i) =>
  `${topic} detail ${i + 1}: the rollout checklist item was verified against the staging database and signed off by the on-call engineer.`).join(' ');

async function atlasConflicts(s: Workspace): Promise<void> {
  // Two current values of one predicate under related names, and a third in another scope: get_context names them in
  // `conflicts`, which repeats each value whole.
  await s.call('remember', { statement: 'Atlas status update.', subject: 'Atlas', predicate: 'status', object: `paused: ${sentences('Atlas pause', 6)}` });
  await s.call('remember', { statement: 'Atlas project status update.', subject: 'Atlas project', predicate: 'status', object: `active: ${sentences('Atlas active', 6)}` });
  await s.call('remember', { statement: 'Atlas status in the atlas scope.', subject: 'Atlas', predicate: 'status', object: `blocked: ${sentences('Atlas blocked', 4)}`, scope: 'project:atlas' });
  for (let i = 1; i <= 6; i++) await s.call('remember', { statement: `Atlas status note ${i}: ${sentences(`Atlas note ${i}`, 3)}` });
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('D9: the whole get_context reply is bounded by max_tokens', () => {
  it('counts the echoed query, relevance, conflicts and the index notice, not the facts and memories alone', async () => {
    // An explicit bar arms the relevance signal for the eval-hash embeddings, so the reply carries `relevance` too.
    const s = await workspace(new EvalHashEmbeddingProvider(), { RENOR_CONTEXT_RELEVANCE_MIN: '0.1' });
    await atlasConflicts(s);
    await s.call('save_memory', { subject: 'Atlas', predicate: 'region', object: 'gru' }); // the index is now behind: index.stale

    for (const max of [200, 400, 800, 1500, 4000]) {
      const r = await s.reply('get_context', { query: 'What is the Atlas status?', max_tokens: max });
      expect(tokens(r.text), `max_tokens ${max}`).toBeLessThanOrEqual(max);
      expect(r.body.maxTokens).toBe(max);
      expect(r.body.index?.stale, `max_tokens ${max}`).toBe(true);
      expect(r.body.relevance, `max_tokens ${max}`).toBeDefined();
    }
    // A budget that holds the fact also holds the conflict it names, and both fit.
    const roomy = await s.reply('get_context', { query: 'What is the Atlas status?', max_tokens: 4000 });
    expect(roomy.body.facts.length).toBeGreaterThan(0);
    expect(roomy.body.conflicts?.length).toBeGreaterThan(0);
    expect(roomy.body.memories.length).toBeGreaterThan(0);
  });

  it('a bigger budget never holds less: a fact is charged the conflict it names, so cutting it never empties the reply', async () => {
    const s = await workspace(null);
    const long = (what: string) => `${what}, ${'with a long explanation of the decision '.repeat(6)}`.trim();
    await s.call('remember', { statement: 'The billing queue is RabbitMQ.', subject: 'billing queue', predicate: 'technology', object: long('RabbitMQ') });
    await s.call('remember', { statement: 'The billing queue service is SNS.', subject: 'billing queue service', predicate: 'technology', object: long('SNS') });
    await s.call('remember', { statement: 'The ingest queue is Kafka.', subject: 'ingest queue', predicate: 'technology', object: 'Kafka' });
    await s.call('remember', { statement: 'The ingest queue service is SQS.', subject: 'ingest queue service', predicate: 'technology', object: 'SQS' });
    let before = { facts: 0, items: 0 };
    for (const max of [160, 200, 250, 300, 350, 400, 500, 600].map(m => m + IDENTITY)) {
      const r = await s.reply('get_context', { query: 'ingest billing queue technology', max_tokens: max });
      expect(tokens(r.text), `max_tokens ${max}`).toBeLessThanOrEqual(max);
      const now = { facts: r.body.facts.length, items: r.body.facts.length + r.body.memories.length };
      expect(now.facts, `max_tokens ${max}`).toBeGreaterThanOrEqual(before.facts);
      expect(now.items, `max_tokens ${max}`).toBeGreaterThanOrEqual(before.items);
      before = now;
    }
    expect(before.facts).toBe(4); // and the largest holds every fact, with both conflicts
  });

  it('reads the opt-in read-honesty lane under the same bound: a listed fact comes with its contradiction', async () => {
    // The lane used to answer every budget by spending past it: its items counted in characters and its contradictions
    // cut to a budget of their own on top, so the description's bound was false whenever it was armed (339 of 485
    // reachable budgets over, by up to 7.11x — tests/mvp/honesty-lane-budget.test.ts). It reads like every other lane
    // now: a fact is charged the contradiction about what it says, so the two are in the reply together or neither is.
    const s = await workspace(new EvalHashEmbeddingProvider(), { RENOR_READ_HONESTY: '1' });
    await atlasConflicts(s);
    const namedAt: number[] = [];
    for (const max of [300, 600, 900, 1200, 2000, 4000]) {
      const r = await s.reply('get_context', { query: 'What is the Atlas status?', max_tokens: max });
      expect(tokens(r.text), `max_tokens ${max}`).toBeLessThanOrEqual(max);
      // What the lane is for is still there: where every item came from, and the contradiction with the fact it is about.
      expect(r.body.provenance, `max_tokens ${max}`).toBeDefined();
      for (const item of [...r.body.facts, ...r.body.memories]) expect(item.provenance, `max_tokens ${max}`).toBeDefined();
      const listed = r.body.facts.some((f: { subject: string; predicate: string }) => f.subject === 'Atlas' && f.predicate === 'status');
      const named = r.body.conflicts.some((c: { subject: string; predicate: string; statement: string }) =>
        c.subject === 'Atlas' && c.predicate === 'status' && /is newer than/.test(c.statement));
      expect(named, `max_tokens ${max}`).toBe(listed);
      if (named) namedAt.push(max);
      else expect(r.body.truncated, `max_tokens ${max}`).toBe(true);
    }
    // Atlas's status is current in two scopes with long values, so the contradiction repeats both whole (about 900
    // tokens, its statement included): it and the fact come in together from the first of these budgets that holds them.
    expect(namedAt).toEqual([1200, 2000, 4000]);
  });

  it('cuts the facts from their end and the memories by score, and says so', async () => {
    const s = await workspace(new EvalHashEmbeddingProvider());
    for (let i = 1; i <= 6; i++) await s.call('remember', { statement: `Atlas status note ${i}: ${sentences(`Atlas note ${i}`, 3)}` });
    // Saved after the notes, so no save indexes the ledger: no memory is the event of a fact.
    for (let i = 1; i <= 4; i++) await s.call('save_memory', { subject: `Atlas service s${i}`, predicate: 'status', object: `ok: ${sentences(`Atlas service ${i}`, 2)}` });
    const full = await s.call('get_context', { query: 'Atlas status note', max_tokens: 4000 });
    const cut = await s.reply('get_context', { query: 'Atlas status note', max_tokens: 400 });
    expect(tokens(cut.text)).toBeLessThanOrEqual(400);
    expect(cut.body.truncated).toBe(true);
    // Scores carry a clock-dependent recency boost, so a memory is compared by what it says.
    const said = (items: Array<{ text?: string; object?: string }>) => items.map(item => item.text ?? item.object);
    expect(cut.body.memories.length + cut.body.facts.length).toBeGreaterThan(0);
    // The memories kept are the best-scoring ones of the whole list, listed as it lists them (tests/mvp/budget-cut-by-score.test.ts).
    const best = [...full.memories].sort((a: { score: number }, b: { score: number }) => b.score - a.score).slice(0, cut.body.memories.length);
    expect(said(cut.body.memories)).toEqual(said(full.memories.filter((memory: unknown) => best.includes(memory))));
    expect(said(full.facts).slice(0, cut.body.facts.length)).toEqual(said(cut.body.facts));
  });
});

// --- D12 ------------------------------------------------------------------------------------------------------------

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('D12: a note save returns the id that forgets it, and memory_map looks within one scope', () => {
  it('the id in a remember (note) or remember_note receipt is the one memory_map lists, read_memory reads and retire_memory takes', async () => {
    const s = await workspace(null);
    const statement = 'Quillmoor kickoff: the bakery owner wants flour stock alerts.\n- [09:00:00] (alice) a line that looks like an entry\n\n';
    const note = await s.call('remember', { statement, scope: 'dogfood', timezone: 'America/Sao_Paulo' });
    const daily = await s.call('remember_note', { text: 'Quillmoor scanner test found 3 misreads.', scope: 'dogfood', date: '2026-09-28' });
    expect(note.id).toMatch(/^entry:Memory\/Scopes\/dogfood\/Daily\/\d{4}-\d{2}-\d{2}\.md#[0-9a-f]{16}$/);
    expect(daily.id).toMatch(/^entry:Memory\/Scopes\/dogfood\/Daily\/2026-09-28\.md#[0-9a-f]{16}$/);

    const listed = (await s.call('memory_map', { query: 'quillmoor' })).memories.map((m: { id: string }) => m.id).sort();
    expect(listed).toEqual([note.id, daily.id].sort());
    expect((await s.call('read_memory', { id: note.id })).text).toBe(statement.replace(/\n+$/, ''));
    expect((await s.call('read_memory', { id: daily.id })).text).toBe('Quillmoor scanner test found 3 misreads.');
    expect(await s.call('retire_memory', { id: daily.id })).toMatchObject({ ok: true, id: daily.id, action: 'retired' });
    expect(await s.call('retire_memory', { id: note.id })).toMatchObject({ ok: true, id: note.id, action: 'retired' });
    expect((await s.call('memory_map', { query: 'quillmoor' })).memories).toEqual([]);
  });

  it('memory_map with a scope finds the memories and retired memories of that scope only, and says which', async () => {
    const s = await workspace(null);
    const mine = await s.call('remember', { statement: 'Quillmoor pricing: 9 dollars a month per bakery.', scope: 'dogfood' });
    const gone = await s.call('remember', { statement: 'Quillmoor hosting moves to Railway.', scope: 'dogfood' });
    await s.call('remember', { statement: 'Quillmoor is also the name of a hiking trail I liked.', scope: 'other' });
    await s.call('remember', { statement: 'Quillmoor came up at the global standup.' });
    await s.call('retire_memory', { id: gone.id });

    const found = await s.call('memory_map', { query: 'quillmoor', scope: 'project:dogfood' });
    expect(found.scope).toBe('project:dogfood');
    expect(found.memories.map((m: { id: string }) => m.id)).toEqual([mine.id]);
    expect(found.retired.map((r: { memoryId: string }) => r.memoryId)).toEqual([gone.id]);
    const global = await s.call('memory_map', { query: 'quillmoor', scope: 'global' });
    expect(global.memories.map((m: { title: string }) => m.title)).toEqual(['Quillmoor came up at the global standup.']);
    expect(global.retired).toEqual([]);
    // Without a scope, every scope, as before.
    expect((await s.call('memory_map', { query: 'quillmoor' })).memories).toHaveLength(3);
    // The scope is applied before the cap: newer memories of other scopes never take its one place.
    for (let i = 1; i <= 3; i++) await s.call('remember', { statement: `Quillmoor pricing note ${i} for another bakery.`, scope: 'other' });
    expect((await s.call('memory_map', { query: 'quillmoor pricing', scope: 'dogfood', limit: 1 })).memories.map((m: { id: string }) => m.id)).toEqual([mine.id]);
    // A scope narrows a lookup: the whole map is not cut by scope, so it says so instead of ignoring it.
    const whole = await s.reply('memory_map', { scope: 'dogfood' });
    expect(whole.isError).toBe(true);
    expect(whole.text).toMatch(/query/);
  });
});

// --- D14 ------------------------------------------------------------------------------------------------------------

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('D14: search_memory and search_text return at most top_k hits, facts included', () => {
  it('the facts fill the places the index leaves, and never push the total past top_k', async () => {
    const s = await workspace(new EvalHashEmbeddingProvider());
    for (let i = 1; i <= 5; i++) await s.call('remember', { statement: `Deploy log ${i}: the deploy of build ${i} went fine.` });
    // Saved after the notes, so no save indexes their events: the facts lane is the only way a search finds them.
    for (let i = 1; i <= 5; i++) await s.call('save_memory', { subject: `service ${i}`, predicate: 'deploy_target', object: `region ${i} deploy` });
    const memory = await s.call('search_memory', { query: 'deploy', top_k: 3 });
    expect(memory.hits).toHaveLength(3);
    expect(memory.hits.every((h: { reason: string }) => h.reason !== 'fact')).toBe(true); // the index filled the page
    const text = await s.call('search_text', { query: 'deploy', top_k: 2 });
    expect(text.results).toHaveLength(2);
    expect(text.results.every((h: { reason: string }) => h.reason === 'fts')).toBe(true);

    // Where the index finds fewer than top_k, the facts take the rest, first, as before.
    const wide = await s.call('search_text', { query: 'deploy', top_k: 8 });
    expect(wide.results).toHaveLength(8);
    expect(wide.results.map((h: { reason: string }) => h.reason)).toEqual(['fact', 'fact', 'fact', 'fts', 'fts', 'fts', 'fts', 'fts']);
  });
});

// --- D11 ------------------------------------------------------------------------------------------------------------

/** The id of the one memory a lookup finds (how an agent forgets on a release whose receipts carry none). */
async function idOf(s: Workspace, words: string): Promise<string> {
  const { memories } = await s.call('memory_map', { query: words });
  expect(memories, words).toHaveLength(1);
  return memories[0].id;
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('D11: retiring the last entry of a day retires the day file with it', () => {
  it('leaves no header-only note, entity or chunk behind, and restore brings the day back', async () => {
    const s = await workspace(null);
    const before = await s.call('memory_status');
    await s.call('remember', { statement: 'Ottoline has a hazelnut allergy.', scope: 'residue' });
    const saved = { id: await idOf(s, 'hazelnut') };
    const file = path.join(s.memoryDir, 'Memory', 'Scopes', 'residue', 'Daily', `${today()}.md`);
    const header = fs.readFileSync(file, 'utf8').split('\n- [')[0];

    expect(await s.call('retire_memory', { id: saved.id })).toMatchObject({ ok: true, action: 'retired' });
    expect(fs.existsSync(file)).toBe(false);
    const after = await s.call('memory_status');
    expect([after.notes, after.chunks, after.entities]).toEqual([before.notes, before.chunks, before.entities]);
    expect((await s.call('search_text', { query: today().slice(0, 4), scope: 'residue' })).results).toEqual([]);
    expect((await s.call('lookup_entity', { name: 'residue' })).entity).toBeNull();

    const restored = await s.call('restore_memory', { id: saved.id });
    expect(restored).toMatchObject({ ok: true, id: saved.id, action: 'restored' });
    expect(fs.readFileSync(file, 'utf8').startsWith(header)).toBe(true);
    expect((await s.call('read_memory', { id: saved.id })).text).toBe('Ottoline has a hazelnut allergy.');
    expect((await s.call('search_text', { query: 'hazelnut', scope: 'residue' })).results).toHaveLength(1);
  });

  it('restores the exact header of a day written before the marker existed', async () => {
    const s = await workspace(null);
    const legacy = '---\nkind: note\nupdated: 2026-09-28\n---\n# 2026-09-28\n';
    const entry = '- [09:15:00] (claude) Quokka census moved to the spring.';
    const file = path.join(s.memoryDir, 'Memory', 'Daily', '2026-09-28.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${legacy}\n${entry}`);
    await s.call('index_memory');
    const id = await idOf(s, 'quokka');

    await s.call('retire_memory', { id });
    expect(fs.existsSync(file)).toBe(false);
    await s.call('restore_memory', { id });
    expect(fs.readFileSync(file, 'utf8')).toBe(`${legacy}${entry}`); // the header as it was, then the entry (restore's own layout)
  });

  it('keeps a day that still holds an entry, or a line the person wrote', async () => {
    const s = await workspace(null);
    await s.call('remember', { statement: 'Kestrel standup notes.', scope: 'busy' });
    await s.call('remember', { statement: 'Kestrel demo moved to Friday.', scope: 'busy' });
    const first = { id: await idOf(s, 'standup') };
    const second = { id: await idOf(s, 'demo') };
    const file = path.join(s.memoryDir, 'Memory', 'Scopes', 'busy', 'Daily', `${today()}.md`);
    await s.call('retire_memory', { id: first.id });
    expect(fs.existsSync(file)).toBe(true);
    expect((await s.call('search_text', { query: 'demo', scope: 'busy' })).results).toHaveLength(1);
    await s.call('retire_memory', { id: second.id });
    expect(fs.existsSync(file)).toBe(false);

    // A line typed above the entries is the person's, not an entry's: the day keeps it.
    await s.call('remember', { statement: 'Kestrel retro.', scope: 'own' });
    const own = { id: await idOf(s, 'retro') };
    const ownFile = path.join(s.memoryDir, 'Memory', 'Scopes', 'own', 'Daily', `${today()}.md`);
    fs.writeFileSync(ownFile, fs.readFileSync(ownFile, 'utf8').replace(`# ${today()}\n`, `# ${today()}\nMy own line, typed in the editor.\n`));
    expect(await s.call('retire_memory', { id: own.id })).toMatchObject({ ok: true, action: 'retired' });
    expect(fs.readFileSync(ownFile, 'utf8')).toContain('My own line, typed in the editor.');
  });
});
