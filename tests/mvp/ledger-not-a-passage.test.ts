import { describe, it, expect, afterAll, beforeAll } from 'vitest';
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
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { DEFAULT_LEDGER_REL, remember } from '../../src/memory/lifecycle';
import { READING, MARKUP_WORDS, RECORDS, SOURCE_FACT, SOURCE_STATEMENT, chores, readingNotes, sayings, supersessions, type LedgerRecord } from '../helpers/longLedger';

/**
 * The ledger is the engine's own record, not a memory (new-user re-check, finding N6).
 *
 * Driven through the real MCP tools over the authenticated Streamable HTTP endpoint, with the deterministic eval-hash
 * embeddings and synthetic data only. A tiny workspace answers every question with every chunk it has, which is how
 * the ledger's header came back for a question nothing had answered; a bigger one answered with raw ledger records.
 *
 * What a person is shown of their memory is what they said. The header of the ledger and the markup of its records
 * ("## MEM_… · time", "- kind: store", "- subject: …") are bookkeeping, and no search_memory, search_text or
 * get_context result carries them. What the user said still comes back, word for word.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const HOOK_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_READ_HONESTY', 'RENOR_NEWEST_FIRST',
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

function makeConfig(memoryDir: string, authRoot: string, port: number, ledgerRel?: string): MvpConfig {
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  delete process.env.MVP_HISTORY_DIR;
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.RENOR_READ_HONESTY;
  delete process.env.RENOR_NEWEST_FIRST;
  process.env.RENOR_SEARCH_EVIDENCE = '0';
  if (ledgerRel) process.env.MVP_LEDGER_REL = ledgerRel;
  else delete process.env.MVP_LEDGER_REL;
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'ledger-not-a-passage', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

type Hit = { notePath: string; headingPath?: string; text: string; score: number; reason: string; session_date?: string };

/** A fresh authenticated service on its own memory dir. Calls are sequential: one shared stateless MCP server. */
async function startWorkspace(opts: { ledgerRel?: string; files?: Record<string, string>; records?: LedgerRecord[] } = {}) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-ledger-passage-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(memoryDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, rel), content);
  }
  if (opts.records?.length) {
    // Many events, by the real writer and a scratch database that is thrown away: the service replays the ledger it
    // finds when it starts, and a test that wants them in the chunk index calls index_memory.
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-scratch-'));
    const scratch = openDb(path.join(scratchDir, 'scratch.db'));
    runMigrations(scratch);
    for (const record of opts.records) await remember(scratch, memoryDir, opts.ledgerRel ?? DEFAULT_LEDGER_REL, record);
    scratch.close();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  const config = makeConfig(memoryDir, authRoot, await freePort(), opts.ledgerRel);
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'ledger-not-a-passage', version: '0.1.0' });
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
    memoryDir, call,
    /** A fact with the user's words: the ledger event, the lifecycle row and the chunk index all move. Returns the event id. */
    async fact(statement: string, subject: string, predicate: string, object: string, scope?: string): Promise<string> {
      const receipt = await call('remember', { statement, subject, predicate, object, source: 'claude', ...(scope ? { scope } : {}) });
      expect(receipt.mode, JSON.stringify(receipt)).toBe('fact');
      return receipt.eventId as string;
    },
    /** A fact nobody put into words (an agent's save_memory): the lower-level write indexes nothing, so index after it. */
    async bareFact(subject: string, predicate: string, object: string): Promise<string> {
      const receipt = await call('save_memory', { subject, predicate, object });
      expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
      await call('index_memory');
      return receipt.eventId as string;
    },
    async note(statement: string) {
      const receipt = await call('remember', { statement });
      expect(receipt.mode, JSON.stringify(receipt)).toBe('note');
    },
    /** The exported ledger: the portable source of truth (the first block of the answer only describes it). */
    async exported(): Promise<string> {
      const res = await client.callTool({ name: 'export_memory', arguments: {} });
      return (res.content as any)[1].text as string;
    },
    /** When each ledger event was saved, as the exported ledger says. */
    async savedAt(): Promise<Map<string, string>> {
      const ledger = await this.exported();
      return new Map([...ledger.matchAll(/^## (MEM_[A-Za-z0-9]+) · (\S+)$/gm)].map(m => [m[1].toUpperCase(), m[2]]));
    },
    /**
     * What an agent can read for one question, by each of the three tools. search_text takes its query as one phrase
     * that must appear as written, so a question for the other two is given to it as the words to look for.
     */
    async ask(query: string, extra: Record<string, unknown> = {}, keywords: string = query) {
      const context = await call('get_context', { query, max_tokens: 4000, ...extra });
      const search = await call('search_memory', { query, ...extra });
      const text = await call('search_text', { query: keywords, ...(extra.scope ? { scope: extra.scope } : {}) });
      return {
        context: context.memories as Hit[],
        search: search.hits as Hit[],
        text: text.results as Hit[],
        facts: context.facts as Array<{ subject: string; predicate: string; object: string }>,
      };
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

/** The ledger's own words: its header, and the markup of a record (its header line and field lines). Nobody said these. */
const INTERNALS = /Append-only durable record|# Memory Events Ledger|^## MEM_|^- (?:kind|subject|predicate|object|closed_event|scope|statement|source): /m;
const internals = (hits: Hit[]) => hits.filter(h => INTERNALS.test(h.text));
/** The default ledger's path: a person's own note may be there when the workspace keeps its ledger elsewhere. */
const LEDGER = 'System/Memory Events Ledger.md';
/** The hits of the ledger: a hit of an event names no note (its path and heading are bookkeeping too, D8). */
const onLedger = (hits: Hit[]) => hits.filter(h => h.notePath === '');
const texts = (hits: Hit[]) => hits.map(h => h.text);

const BUN = 'Remember that I prefer Bun for TypeScript projects.';
const CODENAME = 'My project codename is Zanzibar.';

describe('the ledger is not a memory', () => {
  let ws: Workspace;
  beforeAll(async () => {
    // "memory" is in the header, in the heading of every record, and in these two notes (a day's entries are ONE chunk,
    // so they are two files).
    ws = await startWorkspace({
      files: {
        'Notes/palace.md': '# Palace\n\nA memory palace helps me remember lists.\n',
        'Notes/zoo.md': '# Zoo\n\nAnother memory: the quokka at the zoo.\n',
      },
    });
    await ws.note(CODENAME);
    await ws.fact(BUN, 'user', 'prefers_runtime', 'Bun');
    await ws.bareFact('Dana', 'works_at', 'Initech');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  // The re-check's reproduction: a question that was never saved, and the header came back with a score of 0.11.
  it('a question nothing answers gets no text of the ledger from any tool', async () => {
    for (const query of ['who is my dentist', 'what is the weather in Lisbon', 'quantum chromodynamics']) {
      const r = await ws.ask(query);
      for (const [tool, hits] of [['get_context', r.context], ['search_memory', r.search], ['search_text', r.text]] as const) {
        expect(internals(hits), `${tool}: ${query}`).toEqual([]);
        expect(hits.filter(h => h.headingPath === 'Memory Events Ledger'), `${tool}: ${query}`).toEqual([]);
      }
    }
  });

  it('the words of the header find nothing, by keyword, by meaning or in context', async () => {
    for (const query of ['durable record', 'Append-only', 'Replayed on rebuild', 'Memory Events Ledger', 'ledger', 'memory events']) {
      const r = await ws.ask(query);
      for (const [tool, hits] of [['get_context', r.context], ['search_memory', r.search], ['search_text', r.text]] as const) {
        expect(internals(hits), `${tool}: ${query}`).toEqual([]);
      }
    }
  });

  it('a question made of the words of the record markup finds none of the records', async () => {
    for (const query of ['kind', 'store', 'source', 'subject', 'predicate', 'object', 'scope', 'statement', 'ledger', 'events', '2026']) {
      const found = (await ws.call('search_text', { query })).results as Hit[];
      expect(onLedger(found), query).toEqual([]);
    }
    const r = await ws.ask('what kind of source of events is a store of memory?');
    // The broad keyword lane may list user notes now that OR fallback is the default; it must never expose the ledger.
    expect(onLedger(r.context).filter(m => /\bfts\b/.test(m.reason))).toEqual([]);
    // Exactly the two user notes the any-word fallback reaches through "memory", and not one chunk of the ledger.
    expect(r.text.map(h => h.notePath).sort()).toEqual(['Notes/palace.md', 'Notes/zoo.md']);
    expect(onLedger(r.text)).toEqual([]);
    // Pre-flip this was `[]`; with any-word fallback it may list user notes, and only user notes.
    expect(r.text.filter(h => !String(h.notePath).startsWith('Notes/'))).toEqual([]);
  });

  it('the file name of the ledger does not make its opening chunk a hit', async () => {
    const found = (await ws.call('search_text', { query: 'ledger.md' })).results as Hit[];
    expect(onLedger(found)).toEqual([]);
    const context = await ws.call('get_context', { query: 'ledger.md', max_tokens: 4000 });
    expect(internals(context.memories)).toEqual([]);
  });

  it('the page is not shortened by what is taken off it: it is filled by memories', async () => {
    // The question is the header's own sentence, so by meaning the header outranks everything.
    const sentence = 'Memory Events Ledger Append-only durable record of memory events Replayed on rebuild';
    const search = (await ws.call('search_memory', { query: sentence, top_k: 3 })).hits as Hit[];
    expect(search).toHaveLength(3);
    expect(internals(search)).toEqual([]);

    // By keyword: the two notes fill the page of two, though the header and every record's heading hold the word too.
    const keyword = (await ws.call('search_text', { query: 'memory', top_k: 2 })).results as Hit[];
    expect(keyword).toHaveLength(2);
    expect(keyword.map(h => h.notePath).sort()).toEqual(['Notes/palace.md', 'Notes/zoo.md']);
  });

  it('export_memory is still the whole ledger: the portable record is not a search result', async () => {
    const exported = await ws.exported();
    expect(exported).toContain('Append-only durable record of memory events.');
    expect(exported).toContain(`- statement: ${JSON.stringify(BUN)}`);
    expect(exported).toContain('- kind: store');
  });
});

describe('a long ledger does not push a person\'s own words off a keyword page', () => {
  let ws: Workspace;
  beforeAll(async () => {
    // More records than any window the keyword lanes read (search_text read 200 rows, get_context 60), none of which says
    // a markup word, and after them a note and a fact that do. Every record is shorter, so every record ranks above both.
    ws = await startWorkspace({ files: { 'Notes/reading.md': READING }, records: [...chores(RECORDS), SOURCE_FACT] });
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('search_text: a word every record carries as markup finds the note and the fact that say it', async () => {
    const found = (await ws.call('search_text', { query: 'source' })).results as Hit[];
    expect(texts(found).sort()).toEqual([READING.trim(), SOURCE_STATEMENT].sort());
    expect(internals(found)).toEqual([]);
    for (const query of MARKUP_WORDS) {
      const hits = (await ws.call('search_text', { query })).results as Hit[];
      expect(hits.map(h => h.notePath).filter(p => p !== ''), query).toEqual(['Notes/reading.md']);
      expect(internals(hits), query).toEqual([]);
    }
  });

  it('search_text: whatever the size of the page asked for', async () => {
    for (const top_k of [1, 2, 50]) {
      const hits = (await ws.call('search_text', { query: 'source', top_k })).results as Hit[];
      expect(hits.length, String(top_k)).toBe(Math.min(top_k, 2));
      expect(internals(hits), String(top_k)).toEqual([]);
      expect(texts(hits).every(t => t === READING.trim() || t === SOURCE_STATEMENT), String(top_k)).toBe(true);
    }
  });

  it('search_text: a scope still sees what is in it and nothing else, however long the ledger', async () => {
    const global = (await ws.call('search_text', { query: 'source', scope: 'global' })).results as Hit[];
    expect(texts(global).sort()).toEqual([READING.trim(), SOURCE_STATEMENT].sort());
    expect(internals(global)).toEqual([]);
    expect((await ws.call('search_text', { query: 'source', scope: 'project:elsewhere' })).results).toEqual([]);
  });

  it('get_context: the keyword lane finds them too, and says it was the words that did', async () => {
    const context = await ws.call('get_context', { query: 'source', max_tokens: 4000 });
    const memories = context.memories as Hit[];
    for (const wanted of [READING.trim(), SOURCE_STATEMENT]) {
      const memory = memories.find(m => m.text === wanted);
      expect(memory, wanted.slice(0, 40)).toBeDefined();
      expect(memory!.reason, wanted.slice(0, 40)).toMatch(/fts/);
    }
    expect(internals(memories)).toEqual([]);
  });
});

describe('a page is as long as it was asked to be when enough notes say the word, whatever ranks above them', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace({ files: readingNotes(30), records: chores(RECORDS) });
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('search_text: top_k notes, none of them a record, and each note once', async () => {
    for (const [top_k, length] of [[1, 1], [7, 7], [20, 20], [30, 30], [50, 30]]) {
      const found = (await ws.call('search_text', { query: 'source', top_k })).results as Hit[];
      expect(found.length, String(top_k)).toBe(length);
      expect(found.every(h => /^Notes\/reading-\d+\.md$/.test(h.notePath)), String(top_k)).toBe(true);
      expect(new Set(found.map(h => h.notePath)).size, String(top_k)).toBe(length);
    }
  });
});

describe('an event that was corrected does not take a place from a person\'s own words either', () => {
  let ws: Workspace;
  beforeAll(async () => {
    // One thing said 260 times, each time superseding the last: 259 closed events and one live, every one of them short
    // and saying "source" twice over, so every one of them ranks above the note.
    ws = await startWorkspace({ files: { 'Notes/reading.md': READING }, records: supersessions(RECORDS) });
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('search_text: the live event and the note are the page; the corrected ones are not, and do not crowd them out', async () => {
    const found = (await ws.call('search_text', { query: 'source' })).results as Hit[];
    expect(texts(found).sort()).toEqual([`My news source is site ${RECORDS - 1}.`, READING.trim()].sort());
    expect(internals(found)).toEqual([]);
  });
});

describe('a scope\'s own words are found behind any number of another scope\'s events that say the word', () => {
  let ws: Workspace;
  beforeAll(async () => {
    // More events than any window the keyword lanes read, all global and each saying "source" in the user's own words
    // (so each is shown for the word), and every one shorter than the note and the fact of the scope that is read.
    ws = await startWorkspace({
      files: { 'Memory/Scopes/work/reading.md': READING },
      records: [...sayings(RECORDS), { ...SOURCE_FACT, scope: 'scope:work' }],
    });
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('search_text: a scoped read finds the scope\'s note and fact, and nothing of another scope', async () => {
    for (const top_k of [1, 2, 20, 50]) {
      const found = (await ws.call('search_text', { query: 'source', scope: 'scope:work', top_k })).results as Hit[];
      expect(found.length, String(top_k)).toBe(Math.min(top_k, 2));
      expect(texts(found).every(t => t === READING.trim() || t === SOURCE_STATEMENT), String(top_k)).toBe(true);
    }
    const found = (await ws.call('search_text', { query: 'source', scope: 'scope:work' })).results as Hit[];
    expect(texts(found).sort()).toEqual([READING.trim(), SOURCE_STATEMENT].sort());
    expect(internals(found)).toEqual([]);
  });

  it('get_context: the keyword lane of a scoped read finds them too, and says it was the words that did', async () => {
    const context = await ws.call('get_context', { query: 'source', scope: 'scope:work', max_tokens: 4000 });
    const memories = context.memories as Hit[];
    for (const wanted of [READING.trim(), SOURCE_STATEMENT]) {
      const memory = memories.find(m => m.text === wanted);
      expect(memory, wanted.slice(0, 40)).toBeDefined();
      expect(memory!.reason, wanted.slice(0, 40)).toMatch(/fts/);
    }
    expect(memories.filter(m => /^Site \d+ is a news source\.$/.test(m.text))).toEqual([]);
    expect(internals(memories)).toEqual([]);
  });
});

describe('a fact the index does not hold yet is shown as the fact, never as a ledger record', () => {
  let ws: Workspace;
  beforeAll(async () => { ws = await startWorkspace(); }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  // The facts lane answers for a saved fact before index_memory (save_memory indexes nothing). It wrote the fact as a
  // ledger record (`## MEM_… · time`, `- subject: …`), the markup this file keeps out of every read; it is the same fact
  // the index shows once it catches up, so it reads as that: the fact, with the event in its heading path.
  it('search_text and search_memory: before index_memory and after it, the same words and no markup', async () => {
    const receipt = await ws.call('save_memory', { subject: 'production database', predicate: 'engine_is', object: 'Postgres 16' });
    expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
    const FACT = 'production database — engine_is: Postgres 16';

    const before = (await ws.call('search_text', { query: 'Postgres' })).results as Hit[];
    expect(before.map(h => h.reason)).toEqual(['fact']); // the index does not hold it yet: only the facts lane answers
    expect(texts(before)).toEqual([FACT]);
    expect(before[0]).toMatchObject({ notePath: '', headingPath: '', session_date: receipt.created.validFrom });
    const memory = (await ws.call('search_memory', { query: 'which database engine runs in production?' })).hits as Hit[];
    expect(memory.filter(h => h.reason === 'fact').map(h => h.text)).toEqual([FACT]);
    expect(internals([...before, ...memory])).toEqual([]);

    await ws.call('index_memory');
    const after = (await ws.call('search_text', { query: 'Postgres' })).results as Hit[];
    expect(after.map(h => h.reason)).toEqual(['fts']); // now the index holds it, and the facts lane does not repeat it
    expect(texts(after)).toEqual([FACT]);
    expect(internals(after)).toEqual([]);
  });
});

describe('what the user said comes back as what they said', () => {
  let ws: Workspace;
  let bun: string;
  let dana: string;
  let nine: string;
  let ten: string;
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.note(CODENAME);
    bun = await ws.fact(BUN, 'user', 'prefers_runtime', 'Bun');
    dana = await ws.bareFact('Dana', 'works_at', 'Initech');
    nine = await ws.fact('The standup is at nine.', 'standup', 'time', 'nine');
    ten = await ws.fact('The standup moved to ten.', 'standup', 'time', 'ten');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  /** The hit of one event: a hit of the ledger names no note or event (D8), so it is told by the moment it was saved. */
  const eventHit = async (hits: Hit[], id: string) => {
    const at = (await ws.savedAt()).get(id.toUpperCase());
    expect(at, id).toBeDefined();
    return onLedger(hits).find(h => h.session_date === at);
  };

  it('a fact saved with the user\'s words is returned as exactly those words, by all three tools', async () => {
    const r = await ws.ask('which runtime do I prefer for TypeScript', {}, 'Bun');
    for (const [tool, hits] of [['search_memory', r.search], ['search_text', r.text]] as const) {
      const hit = await eventHit(hits, bun);
      expect(hit, tool).toBeDefined();
      expect(hit!.text, tool).toBe(BUN);
      expect(hit!.headingPath, tool).toBe('');
    }
    // get_context lists the fact, and the event it was saved by once: as the fact (D8).
    expect(r.facts).toContainEqual(expect.objectContaining({ subject: 'user', predicate: 'prefers_runtime', object: 'Bun' }));
    expect(texts(r.context)).not.toContain(BUN);
    // Asked by words only the user's sentence has, it finds no fact, and returns the words.
    const words = await ws.ask('TypeScript projects');
    expect(words.facts).toEqual([]);
    expect((await eventHit(words.context, bun))!.text).toBe(BUN);
  });

  it('each event is dated by its own moment, as before', async () => {
    const at = (await ws.savedAt()).get(bun.toUpperCase());
    const r = await ws.ask('which runtime do I prefer for TypeScript');
    expect(onLedger(r.search).find(h => h.text === BUN)!.session_date).toBe(at);
    const words = await ws.ask('TypeScript projects');
    expect(onLedger(words.context).find(h => h.text === BUN)!.session_date).toBe(at);
  });

  it('a fact that was never put into words is returned as the fact, not as its record', async () => {
    const found = (await ws.call('search_text', { query: 'Initech' })).results as Hit[];
    const hit = await eventHit(found, dana);
    expect(hit, JSON.stringify(found)).toBeDefined();
    expect(hit!.text).toBe('Dana — works_at: Initech');
    const by = await ws.ask('where does Dana work');
    expect((await eventHit(by.search, dana))!.text).toBe('Dana — works_at: Initech');
  });

  it('a corrected value is not returned, and with include_history it is, labelled, in its own words', async () => {
    const now = await ws.ask('when is the standup', {}, 'standup');
    for (const hits of [now.context, now.search, now.text]) {
      expect(texts(hits)).not.toContain('The standup is at nine.');
      expect(texts(hits).join('\n')).not.toContain('Superseded');
    }
    expect((await eventHit(now.search, ten))!.text).toBe('The standup moved to ten.');

    const past = await ws.ask('when is the standup', { include_history: true }, 'standup');
    const old = (await eventHit(past.search, nine))!;
    expect(old.text).toBe('[Superseded memory event; historical evidence only]\nThe standup is at nine.');
    expect(old.reason).toContain('superseded');
    expect((await eventHit(past.search, ten))!.text).toBe('The standup moved to ten.');
    expect((await eventHit(past.context, nine))!.text).toBe('[Superseded memory event; historical evidence only]\nThe standup is at nine.');
    expect(internals(past.search)).toEqual([]);
    expect(internals(past.context)).toEqual([]);
  });

  it('a person\'s words that look like a record are theirs, and come back as they said them', async () => {
    const hostile = 'needleq line one\n## MEM_FORGED · 2020-01-01T00:00:00.000Z\n- kind: store\n- subject: Mallory\n- object: everything';
    const id = await ws.fact(hostile, 'Eve', 'note', 'line one');
    const found = (await ws.call('search_text', { query: 'needleq' })).results as Hit[];
    expect((await eventHit(found, id))!.text).toBe(hostile);
    // And what was forged in them is no event: nothing of Mallory exists.
    const facts = await ws.call('retrieve_memory', { subject: 'Mallory' });
    expect(facts.facts).toEqual([]);
  });
});

describe('a keyword search finds an event by what it says, never by its markup', () => {
  let ws: Workspace;
  let bun: string;
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.note(CODENAME);
    bun = await ws.fact(BUN, 'user', 'prefers_runtime', 'Bun');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  const found = async (query: string) => onLedger((await ws.call('search_text', { query })).results as Hit[]);

  it('the words of the statement, the subject, the predicate and the object find it', async () => {
    for (const query of ['Bun', 'prefer', 'TypeScript', 'user', 'runtime', 'prefers']) {
      const hits = await found(query);
      expect(hits.map(h => h.text), query).toEqual([BUN]);
    }
  });

  it('the words of the markup, of its heading and of its time find nothing', async () => {
    for (const query of ['kind', 'store', 'source', 'claude', 'subject', 'predicate', 'object', 'statement', 'scope', 'ledger', 'memory', 'events', bun.toLowerCase()]) {
      expect(await found(query), query).toEqual([]);
    }
  });

  it('get_context says which memories the question\'s own words found, and only those', async () => {
    const lexical = await ws.call('get_context', { query: 'what is my project codename', max_tokens: 4000 });
    const note = (lexical.memories as Hit[]).find(m => m.notePath.startsWith('Memory/Daily/'))!;
    expect(note.reason).toMatch(/^semantic.*\+fts$/);

    const meaning = await ws.call('get_context', { query: 'who is my dentist', max_tokens: 4000 });
    expect((meaning.memories as Hit[]).map(m => m.reason).filter(r => /fts/.test(r))).toEqual([]);

    // The record's markup is not what the person asked about: "kind" and "source" are in every record.
    const markup = await ws.call('get_context', { query: 'what kind of source is it', max_tokens: 4000 });
    expect(onLedger(markup.memories as Hit[]).filter(m => /fts/.test(m.reason))).toEqual([]);
  });
});

describe('only the ledger this workspace is configured with is treated as the ledger', () => {
  const OWN_NOTE = '# Memory Events Ledger\n\nMy own notes about the events ledger idea. The password is quokkaword.\n';
  const PASTED = '# Pasted\n\nA record copied from somewhere:\n\n## MEM_NOSUCHEVENT · 2001-01-01T00:00:00.000Z\n- kind: store\n- subject: pasted\n- predicate: text\n- object: not an event\n';

  describe('a ledger at a path of the owner\'s choosing', () => {
    let ws: Workspace;
    beforeAll(async () => {
      ws = await startWorkspace({ ledgerRel: 'Records/My Ledger.md' });
      await ws.note(CODENAME);
      await ws.fact(BUN, 'user', 'prefers_runtime', 'Bun');
    }, HOOK_TIMEOUT_MS);
    afterAll(async () => { await ws?.close(); });

    it('its header is no memory either, and its events come back as words', async () => {
      expect(fs.existsSync(path.join(ws.memoryDir, 'Records', 'My Ledger.md'))).toBe(true);
      // One question by meaning alone, one that the keyword lane answers with the header, one made of the records' markup.
      for (const query of ['who is my dentist', 'durable record', 'kind']) {
        const r = await ws.ask(query);
        for (const hits of [r.context, r.search, r.text]) expect(internals(hits), query).toEqual([]);
      }
      const bunQuestion = await ws.ask('which runtime do I prefer for TypeScript', {}, 'Bun');
      expect(bunQuestion.search.map(h => h.text)).toContain(BUN);
      expect(bunQuestion.text.map(h => h.text)).toContain(BUN);
      expect((await ws.call('search_text', { query: 'durable record' })).results).toEqual([]);
    });
  });

  describe('a note at the default ledger path, when the ledger is somewhere else, is a note', () => {
    let ws: Workspace;
    beforeAll(async () => {
      ws = await startWorkspace({ ledgerRel: 'Records/My Ledger.md', files: { [LEDGER]: OWN_NOTE } });
      await ws.fact(BUN, 'user', 'prefers_runtime', 'Bun');
      await ws.call('index_memory');
    }, HOOK_TIMEOUT_MS);
    afterAll(async () => { await ws?.close(); });

    it('is returned as written, header and all', async () => {
      const found = (await ws.call('search_text', { query: 'quokkaword' })).results as Hit[];
      expect(found.map(h => [h.notePath, h.text])).toEqual([[LEDGER, OWN_NOTE.trim()]]);
      const context = await ws.call('get_context', { query: 'quokkaword', max_tokens: 4000 });
      expect((context.memories as Hit[]).map(m => m.text)).toContain(OWN_NOTE.trim());
    });
  });

  describe('a note that holds a record, anywhere else, is a note', () => {
    let ws: Workspace;
    beforeAll(async () => {
      ws = await startWorkspace({ files: { 'Notes/pasted.md': PASTED } });
      await ws.fact(BUN, 'user', 'prefers_runtime', 'Bun');
      await ws.call('index_memory');
    }, HOOK_TIMEOUT_MS);
    afterAll(async () => { await ws?.close(); });

    it('is returned as written, markup and all', async () => {
      const found = (await ws.call('search_text', { query: 'copied from somewhere' })).results as Hit[];
      expect(found.map(h => h.notePath)).toEqual(['Notes/pasted.md']);
      const record = (await ws.call('search_text', { query: 'NOSUCHEVENT' })).results as Hit[];
      expect(record.map(h => h.text)).toEqual([PASTED.slice(PASTED.indexOf('## MEM_')).trim()]);
      const semantic = (await ws.call('search_memory', { query: 'a record copied from somewhere' })).hits as Hit[];
      expect(semantic.find(h => h.notePath === 'Notes/pasted.md' && h.text.includes('MEM_NOSUCHEVENT'))!.text).toContain('- kind: store');
    });
  });
});

describe('a read in a scope still sees that scope\'s events and no other\'s', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.fact('The meeting time is WORKNEW.', 'meeting', 'time', 'WORKNEW', 'scope:work');
    await ws.fact('The meeting time is LAUNCHNEW.', 'meeting', 'time', 'LAUNCHNEW', 'project:launch');
    await ws.fact('The meeting time is GLOBALNEW.', 'meeting', 'time', 'GLOBALNEW');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  const sentinels = (hits: Hit[]) => [...new Set(JSON.stringify(hits).match(/\b(?:WORK|LAUNCH|GLOBAL)NEW\b/g) ?? [])].sort();

  it('a scope sees its own, as words; global sees only global; no scope sees all', async () => {
    // get_context lists each event once: as the fact its facts lane found (D8), so its facts and memories are read together.
    const answers = (r: Awaited<ReturnType<Workspace['ask']>>) => [[...r.context, ...r.facts], r.search, r.text] as Hit[][];
    const work = await ws.ask('meeting time', { scope: 'scope:work' });
    for (const hits of answers(work)) {
      expect(sentinels(hits)).toEqual(['WORKNEW']);
      expect(internals(hits)).toEqual([]);
    }
    for (const hits of [work.search, work.text]) expect(texts(hits)).toContain('The meeting time is WORKNEW.');
    const global = await ws.ask('meeting time', { scope: 'global' });
    for (const hits of answers(global)) {
      expect(sentinels(hits)).toEqual(['GLOBALNEW']);
      expect(internals(hits)).toEqual([]);
    }
    const all = await ws.ask('meeting time');
    for (const hits of answers(all)) {
      expect(sentinels(hits)).toEqual(['GLOBALNEW', 'LAUNCHNEW', 'WORKNEW']);
      expect(internals(hits)).toEqual([]);
    }
  });
});
