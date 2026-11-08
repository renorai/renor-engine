import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { engineSearchMemory } from '../../src/mvp/engine';
import { EvidenceExtractor } from '../../src/evidence/secondPass';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * What search_memory and get_context tell an agent about the order and the dates of what they return, driven
 * through the real MCP tools over the authenticated Streamable HTTP endpoint. Synthetic data only (mkdtemp
 * memory dirs, loopback, the deterministic eval-hash embeddings).
 *
 * Two things were wrong, both found by the memory scout (finding 6 and finding 8):
 *  - Every hit carries a `score` and the tool said "ranked", but the product default re-sorts the selected top-K
 *    newest first, so hits[0] was the most recent match and an agent that took it for the answer read the wrong
 *    chunk. The order was right for the benchmark and invisible to the agent. It stays; it is now named.
 *  - `session_date` was the date of the NOTE, so every event of the one ledger file reported the moment the file
 *    was last written, not the moment the event was saved.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const HOOK_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_READ_HONESTY', 'RENOR_NEWEST_FIRST', 'RENOR_TEMPORAL_RANKING', 'RENOR_TEMPORAL_ASOF',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

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

function makeConfig(memoryDir: string, authRoot: string, port: number): MvpConfig {
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  delete process.env.MVP_HISTORY_DIR;
  delete process.env.MVP_LEDGER_REL;
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.RENOR_READ_HONESTY;
  delete process.env.RENOR_NEWEST_FIRST; // the product default; the opt-out has its own test
  delete process.env.RENOR_TEMPORAL_RANKING;
  delete process.env.RENOR_TEMPORAL_ASOF;
  process.env.RENOR_SEARCH_EVIDENCE = '0'; // the evidence second pass has its own tests below
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'ranking-honesty', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorizeRes = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorizeRes.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({
    ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
  }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  return tokens.body.access_token;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A fresh authenticated service on its own memory dir. Calls are sequential: one shared stateless MCP server. */
async function startWorkspace() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-ranking-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  const config = makeConfig(memoryDir, authRoot, await freePort());
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'ranking-honesty', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as any)[0].text as string;
    if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  return {
    service, client, memoryDir, call,
    /** A fact: the ledger event, the lifecycle row and the chunk index all move. Returns the event's id. */
    async fact(statement: string, subject: string, predicate: string, object: string): Promise<string> {
      const receipt = await call('remember', { statement, subject, predicate, object });
      expect(receipt.mode, JSON.stringify(receipt)).toBe('fact');
      expect(receipt.eventId, JSON.stringify(receipt)).toMatch(/^MEM_/i);
      return receipt.eventId as string;
    },
    /** A note: the day's file, indexed at once. */
    async note(statement: string) {
      const receipt = await call('remember', { statement });
      expect(receipt.mode, JSON.stringify(receipt)).toBe('note');
    },
    /** A file written by hand into the memory directory, as a user's own markdown would be. */
    write(rel: string, content: string) {
      const file = path.join(memoryDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    },
    index: () => call('index_memory'),
    /** When each ledger event was saved, as the exported ledger (the portable source of truth) says. */
    async savedAt(): Promise<Map<string, string>> {
      const res = await client.callTool({ name: 'export_memory', arguments: {} });
      // The export now carries the notes too (one of them holds a look-alike header); the ledger is its first `bytes` characters.
      const { bytes } = JSON.parse((res.content as any)[0].text) as { bytes: number };
      const ledger = ((res.content as any)[1].text as string).slice(0, bytes);
      return new Map([...ledger.matchAll(/^## (MEM_[A-Za-z0-9]+) · (\S+)$/gm)].map(m => [m[1].toUpperCase(), m[2]]));
    },
    async close() {
      await client.close();
      service.httpServer.closeAllConnections?.();
      await new Promise<void>(resolve => service.httpServer.close(() => resolve()));
      await service.close();
      fs.rmSync(memoryDir, { recursive: true, force: true });
      fs.rmSync(authRoot, { recursive: true, force: true });
    },
  };
}

type Workspace = Awaited<ReturnType<typeof startWorkspace>>;

type Hit = { notePath: string; headingPath?: string; text: string; score: number; reason: string; session_date?: string };

/**
 * The ledger event a hit of the engine's own search function is an excerpt of, from its heading path (`Memory Events
 * Ledger > MEM_… · time`). A tool's hit names no event (its note path and heading are empty, live dogfood D8): it is told
 * by what the user said, and dated by the moment it was saved.
 */
const eventOf = (h: Hit): string | undefined => /\b(MEM_[A-Za-z0-9]+) · /.exec(h.headingPath ?? '')?.[1]?.toUpperCase();
/** The hits of ledger events in a tool's answer. */
const ledgerHits = (hits: Hit[]) => hits.filter(h => h.notePath === '');
const ms = (h: Hit) => Date.parse(h.session_date ?? '');
const scores = (hits: Hit[]) => hits.map(h => h.score);
const isSortedDesc = (values: number[]) => values.every((v, i) => i === 0 || values[i - 1] >= v);

// What an agent asks: the Bun fact is the best match by far; the staging note and the database fact are newer and
// unrelated. Newest first therefore puts the best match LAST of the three, which is the scout's finding 6.
const QUERY = 'what package manager do I want for TypeScript work?';
const BUN = 'Remember that I prefer Bun for TypeScript projects as my package manager.';
const DB = 'Production database is Postgres with pgvector.';
const PAST_QUERY = 'what package manager did I prefer before?';

// The memory the scenarios share, saved in this order with a pause between (so each has its own millisecond):
//   BUN      a fact       "I prefer Bun for TypeScript projects as my package manager"       (the best match)
//   STAGING  a daily note "The staging deploy runs on Friday at noon and the bot gets three retries."
//   DB       a fact       "Production database is Postgres with pgvector."
// and, written by hand into the memory directory and indexed:
//   offsite  a note with a front-matter session_date of 2025-12-01T09:30Z
//   pasted   a note whose body holds a line shaped like a ledger header for an event that does not exist
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('what an agent is told about the order and the dates of what it reads', () => {
  let ws: Workspace;
  let bun: string;
  let db: string;
  let stagingFile: string;

  beforeAll(async () => {
    ws = await startWorkspace();
    bun = await ws.fact(BUN, 'user', 'prefers_package_manager_for_typescript', 'Bun');
    await sleep(40);
    await ws.note('The staging deploy runs on Friday at noon and the bot gets three retries.');
    const daily = path.join(ws.memoryDir, 'Memory', 'Daily');
    stagingFile = path.join(daily, fs.readdirSync(daily)[0]);
    await sleep(40);
    db = await ws.fact(DB, 'production database', 'engine', 'Postgres');
    ws.write('Notes/offsite.md', '---\nsession_date: "2025-12-01T09:30:00.000Z"\n---\n\n# Offsite\n\nThe team offsite is in December and the venue is booked.\n');
    ws.write('Notes/pasted.md', '---\nsession_date: "2025-11-11T08:00:00.000Z"\n---\n\n# Pasted\n\nA copy of a log line:\n\n## MEM_NOSUCHEVENT · 2001-01-01T00:00:00.000Z\n- object: pasted text, not an event\n');
    await ws.index();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  describe('session_date is when the excerpt happened, not when the file that holds it was last written', () => {
    it('search_memory dates each ledger event by the moment it was saved', async () => {
      const at = await ws.savedAt();
      expect(at.size).toBe(2);
      expect(at.get(bun.toUpperCase())).not.toBe(at.get(db.toUpperCase()));
      const { hits } = await ws.call('search_memory', { query: QUERY });
      const events = ledgerHits(hits as Hit[]);
      expect(events.map(h => h.text).sort()).toEqual([BUN, DB].sort());
      expect(events.find(h => h.text === BUN)!.session_date).toBe(at.get(bun.toUpperCase()));
      expect(events.find(h => h.text === DB)!.session_date).toBe(at.get(db.toUpperCase()));
    });

    it('get_context dates its memories the same way', async () => {
      const at = await ws.savedAt();
      const { facts, memories } = await ws.call('get_context', { query: QUERY, max_tokens: 4000 });
      const events = ledgerHits(memories as Hit[]);
      // The Bun event is the fact the facts lane lists, so it is listed once, as that fact (D8); the database event is a memory.
      expect(facts.map((f: { object: string }) => f.object)).toContain('Bun');
      expect(events.map(h => h.text)).toEqual([DB]);
      expect(events[0].session_date).toBe(at.get(db.toUpperCase()));
    });

    it('a note keeps its note time (its front-matter date), and a daily-log entry is dated by its entry, not its file', async () => {
      const { hits } = await ws.call('search_memory', { query: 'team offsite venue December staging deploy Friday noon' });
      const byPath = (needle: string) => (hits as Hit[]).find(h => h.notePath.includes(needle))!;
      expect(byPath('offsite.md').session_date).toBe('2025-12-01T09:30:00.000Z');
      // The staging note is an entry of the day's file, `- [HH:MM:SS] (…)` under that day: the moment it was saved
      // (tests/mvp/daily-entry-session-date.test.ts has the rest).
      const time = /^- \[(\d{2}:\d{2}:\d{2})\]/m.exec(fs.readFileSync(stagingFile, 'utf8'))![1];
      expect(byPath('Daily').session_date).toBe(`${path.basename(stagingFile, '.md')}T${time}.000Z`);
    });

    it('text that only looks like a ledger header, in an ordinary note, does not date that note', async () => {
      const { hits } = await ws.call('search_memory', { query: 'pasted text not an event log line' });
      const pasted = (hits as Hit[]).find(h => h.notePath.includes('pasted.md'))!;
      expect(pasted.text).toContain('MEM_NOSUCHEVENT');
      expect(pasted.session_date).toBe('2025-11-11T08:00:00.000Z');
    });
  });

  describe('hits say which key they are in order of', () => {
    it('by default the order is newest first, named as such, and the best match is not necessarily first', async () => {
      const body = await ws.call('search_memory', { query: QUERY });
      const hits = body.hits as Hit[];
      expect(body.rankedBy).toBe('session_date');
      // The label is read before the list it describes.
      expect(Object.keys(body).indexOf('rankedBy')).toBeLessThan(Object.keys(body).indexOf('hits'));
      // The label is true: no hit is older than the one after it.
      const dates = hits.map(ms);
      expect(dates.every(Number.isFinite)).toBe(true);
      expect(isSortedDesc(dates)).toBe(true);
      // The scenario is the scout's: by score the Bun fact wins, yet newest first it is not hits[0].
      const best = hits.reduce((a, b) => (b.score > a.score ? b : a));
      expect(best.text).toBe(BUN);
      expect(hits[0]).not.toBe(best);
      // And the order between ledger events is the order they were saved in, not a tie on the file's time.
      const position = (said: string) => hits.findIndex(h => h.notePath === '' && h.text === said);
      expect(position(DB)).toBeGreaterThanOrEqual(0);
      expect(position(DB)).toBeLessThan(position(BUN));
    });

    it('a question about the past is ordered by score, and says so', async () => {
      const body = await ws.call('search_memory', { query: PAST_QUERY });
      expect(body.rankedBy).toBe('score');
      expect(isSortedDesc(scores(body.hits))).toBe(true);
    });

    it('with newest-first switched off the order is by score, and says so', async () => {
      process.env.RENOR_NEWEST_FIRST = '0';
      try {
        const body = await ws.call('search_memory', { query: QUERY });
        expect(body.rankedBy).toBe('score');
        expect(isSortedDesc(scores(body.hits))).toBe(true);
        expect(body.hits[0]).toMatchObject({ notePath: '', text: BUN });
      } finally {
        delete process.env.RENOR_NEWEST_FIRST;
      }
    });

    it('get_context names the order of its semantic memories, and they are in it', async () => {
      const body = await ws.call('get_context', { query: QUERY, max_tokens: 4000 });
      expect(body.rankedBy).toBe('session_date');
      // Named right above the memories it orders, after the facts it does not.
      const keys = Object.keys(body);
      expect(keys.indexOf('rankedBy')).toBe(keys.indexOf('memories') - 1);
      expect(keys.indexOf('facts')).toBeLessThan(keys.indexOf('rankedBy'));
      const semantic = (body.memories as Hit[]).filter(m => m.reason.startsWith('semantic'));
      expect(semantic.length).toBeGreaterThanOrEqual(3);
      expect(isSortedDesc(semantic.map(ms))).toBe(true);
      // The key moves with the question, exactly as it does for search_memory.
      expect((await ws.call('get_context', { query: PAST_QUERY, max_tokens: 4000 })).rankedBy).toBe('score');
    });

    it('get_context without a query has no semantic memories to order, and names no order', async () => {
      const body = await ws.call('get_context', {});
      expect(body.memories).toEqual([]);
      expect(body).not.toHaveProperty('rankedBy');
    });

    it('a leading evidence hit is outside the order: the hits after it are still in the named order', async () => {
      const chat = vi.fn(async () => ({ content: '{"items":[{"item":"Bun","date":"2026-10-03"}]}', latencyMs: 1 })) as any;
      const body = await engineSearchMemory(ws.service.db, ws.service.engine, ws.memoryDir, QUERY, 20, undefined, {
        options: { mode: 'always', model: 'test', maxSessions: 12, charCap: 6000, chat },
        extractor: new EvidenceExtractor({ chat }),
      });
      const hits = body.hits as Hit[];
      expect(hits[0].reason).toBe('evidence');
      expect(body.rankedBy).toBe('session_date');
      expect(isSortedDesc(hits.slice(1).map(ms))).toBe(true);
    });

    it('the tool descriptions state the order instead of calling the chunks ranked', async () => {
      const { tools } = await ws.client.listTools();
      const descriptionOf = (name: string) => tools.find(t => t.name === name)!.description!;
      const search = descriptionOf('search_memory');
      expect(search).not.toMatch(/Returns ranked chunks/i);
      expect(search).toContain('rankedBy');
      expect(search).toMatch(/newest first/i);
      expect(search).toMatch(/score/);
      const context = descriptionOf('get_context');
      expect(context).toContain('rankedBy');
      expect(context).toMatch(/newest first/i);
    });
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a superseded event keeps its own time under include_history', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('the corrected value and the value it closed are dated by their own events', async () => {
    const first = await ws.fact('The standup is at nine.', 'standup', 'time', 'nine');
    await sleep(40);
    const second = await ws.fact('The standup moved to ten.', 'standup', 'time', 'ten');
    const at = await ws.savedAt();
    expect(at.get(first.toUpperCase())).not.toBe(at.get(second.toUpperCase()));

    const { hits } = await ws.call('search_memory', { query: 'when is the standup', include_history: true });
    const closed = ledgerHits(hits as Hit[]).find(h => h.text.endsWith('The standup is at nine.'))!;
    const live = ledgerHits(hits as Hit[]).find(h => h.text === 'The standup moved to ten.')!;
    expect(closed.reason).toContain('superseded');
    expect(closed.session_date).toBe(at.get(first.toUpperCase()));
    expect(live.session_date).toBe(at.get(second.toUpperCase()));
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the evidence second pass still dates a whole note by the note', () => {
  let ws: Workspace;
  let standup: string;
  beforeAll(async () => {
    ws = await startWorkspace();
    standup = await ws.fact('The standup is at nine.', 'standup', 'time', 'nine');
    await sleep(40);
    await ws.fact('The offsite is in the spring.', 'offsite', 'season', 'spring');
    await sleep(40);
    await ws.fact('Lunch is at noon on Fridays.', 'lunch', 'time', 'noon');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  // Evidence hydrates the WHOLE ledger note and prints one "Session dated" line above it. That line has always been
  // the note's date; the date of the one event an excerpt came from would date every other event in the body too,
  // and would change the extraction prompt (and with it the content-addressed cache key) for no gain.
  it('prints the ledger\'s own date above the ledger, whichever event the best hit was', async () => {
    const noteDate = (ws.service.db.prepare(`SELECT modified_at FROM notes WHERE path LIKE '%Memory Events Ledger.md'`).get() as { modified_at: string }).modified_at;
    const at = await ws.savedAt();
    const chat = vi.fn(async () => ({ content: '{"items":[{"item":"ok"}]}', latencyMs: 1 })) as any;
    // One hit only: the best match, which is the oldest event, not the newest one.
    const result = await engineSearchMemory(ws.service.db, ws.service.engine, ws.memoryDir, 'when is the standup', 1, undefined, {
      options: { mode: 'always', model: 'test', maxSessions: 12, charCap: 6000, chat },
      extractor: new EvidenceExtractor({ chat }),
    });
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = (chat.mock.calls[0] as any)[0].messages[0].content as string;
    expect(prompt).toContain(`--- Session dated ${noteDate} ---`);
    const standupAt = at.get(standup.toUpperCase())!;
    expect(prompt).not.toContain(`--- Session dated ${standupAt} ---`);
    // The date the agent is shown is the event's, whatever evidence was told. The one hit is the standup event.
    const hit = (result.hits as Hit[]).find(h => h.reason !== 'evidence')!;
    expect(eventOf(hit)).toBe(standup.toUpperCase());
    expect(hit.session_date).toBe(standupAt);
  });
});
