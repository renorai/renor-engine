import { describe, it, expect, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import type Database from '../../src/db/sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember } from '../../src/memory/lifecycle';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { createReadScope } from '../../src/mvp/readScope';
import { normalizeScope } from '../../src/mvp/scope';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Two rules met when scope-isolation merged with the scoped read (memory scout, finding 7):
 *
 *  - a named scope is its slug: `scope:kestrel`, `project:kestrel` and `kestrel` are one scope, for a note's path and
 *    for the fact or ledger event saved in it (mvp/scope.ts scopeSpellings; dogfood D6);
 *  - a scoped read judges every candidate before it cuts its window, and reads the scope's own chunks when other
 *    scopes' chunks are nearer (ReadScope.chunkIds, ChunkScope; the facts lane judges before its limit of three).
 *
 * Each alone leaves a hole the other covers: a window that is judged by the exact spelling hides a fact saved under
 * the other spelling, and a slug rule that is applied only after the cut never sees the fact that the nearer chunks of
 * other scopes pushed out. So what a scope returns must be the same for every spelling of its slug, and must not
 * depend on what other scopes hold.
 *
 * The first block asks the scope for its chunks, with no service. The rest goes through the real MCP tools over the
 * authenticated Streamable HTTP endpoint, with the deterministic eval-hash embeddings (lexical: the other scopes'
 * memories share more of the question's words, so they are nearer) and synthetic data only. MCP calls are sequential:
 * the default stateless JSON mode shares one McpServer.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('ReadScope.chunkIds answers the same for every spelling of a scope', () => {
  /** One event per scope (the work scope in both its spellings), and the chunks that hold them, as the indexer cuts them. */
  async function fixture() {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-spellings-'));
    tmpDirs.push(vault);
    const db: Database.Database = openDb(path.join(vault, 'index.db'));
    runMigrations(db);
    const save = async (predicate: string, object: string, scope?: string) =>
      (await remember(db, vault, LEDGER, { subject: 'meeting', predicate, object, ...(scope ? { scope } : {}) })).eventId;
    const events = {
      workTime: { id: await save('time', 'WORKTIME', 'scope:work'), predicate: 'time', object: 'WORKTIME' },
      workPlace: { id: await save('place', 'WORKPLACE', 'project:work'), predicate: 'place', object: 'WORKPLACE' },
      launchTime: { id: await save('time', 'LAUNCHTIME', 'project:launch'), predicate: 'time', object: 'LAUNCHTIME' },
      globalTime: { id: await save('time', 'GLOBALTIME'), predicate: 'time', object: 'GLOBALTIME' },
    };
    const insertNote = db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, null, 'h', '2026-10-02T00:00:00.000Z', '{}')");
    const insertChunk = db.prepare(
      'INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, ?, 0, 1, 5, ?)',
    );
    let n = 0;
    const addChunk = (rel: string, text: string): number => {
      insertNote.run(`/vault/${rel}`, rel);
      return Number(insertChunk.run(`/vault/${rel}`, '', text, `chunk-${++n}`).lastInsertRowid);
    };
    const eventText = (e: { id: string; predicate: string; object: string }) =>
      `## ${e.id} · 2026-10-02T00:00:00.000Z\n- kind: store\n- subject: meeting\n- predicate: ${e.predicate}\n- object: ${e.object}\n- source: test\n`;
    const chunk = {
      workTime: addChunk(LEDGER, eventText(events.workTime)),
      workPlace: addChunk(LEDGER, eventText(events.workPlace)),
      launchTime: addChunk(LEDGER, eventText(events.launchTime)),
      globalTime: addChunk(LEDGER, eventText(events.globalTime)),
      workNote: addChunk('Memory/Scopes/work/Daily/2026-10-02.md', 'a note of work'),
      launchNote: addChunk('Memory/Scopes/launch/Daily/2026-10-02.md', 'a note of the launch'),
      plainNote: addChunk('People/Ada.md', 'Ada likes mango'),
    };
    const ids = (scope: string) => createReadScope(db, normalizeScope(scope))
      .chunkIds(stored => stored.slice('/vault/'.length)).sort((a, b) => a - b);
    return { chunk, ids };
  }
  const sorted = (...n: number[]) => [...n].sort((a, b) => a - b);

  it('holds the events saved in either spelling of the slug, and the notes under its folder', async () => {
    const { chunk, ids } = await fixture();
    const work = sorted(chunk.workTime, chunk.workPlace, chunk.workNote);
    expect(ids('scope:work')).toEqual(work);
    expect(ids('project:work')).toEqual(work); // the event saved as scope:work, and the one saved as project:work
    expect(ids('work')).toEqual(work); // a bare slug is scope:<slug>
    const launch = sorted(chunk.launchTime, chunk.launchNote);
    expect(ids('project:launch')).toEqual(launch);
    expect(ids('scope:launch')).toEqual(launch);
  });

  it('holds nothing of another slug, a prefix of it included, and the global scope holds none of the named ones', async () => {
    const { chunk, ids } = await fixture();
    expect(ids('scope:wor')).toEqual([]);
    expect(ids('project:work-2')).toEqual([]);
    expect(ids('global')).toEqual(sorted(chunk.globalTime, chunk.plainNote));
  });
});

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_READ_HONESTY',
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
  for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'RENOR_READ_HONESTY']) delete process.env[key];
  process.env.RENOR_SEARCH_EVIDENCE = '0';
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'scoped-spellings', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A fresh authenticated workspace. */
async function boot() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-scoped-spellings-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  const config = makeConfig(memoryDir, authRoot, await freePort());
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'scoped-spellings', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  cleanups.push(async () => {
    await client.close();
    service.httpServer.closeAllConnections?.();
    await new Promise<void>(resolve => service.httpServer.close(() => resolve()));
    await service.close();
    for (const dir of [memoryDir, authRoot]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as any)[0].text as string;
    if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  return {
    call,
    async note(statement: string, scope?: string) {
      const saved = await call('remember', { statement, source: 'claude', ...(scope ? { scope } : {}) });
      expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, mode: 'note', indexed: true });
    },
    async fact(fact: { statement: string; subject: string; predicate: string; object: string }, scope?: string) {
      const saved = await call('remember', { ...fact, source: 'claude', ...(scope ? { scope } : {}) });
      expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, mode: 'fact', action: 'store' });
    },
  };
}
type Workspace = Awaited<ReturnType<typeof boot>>;

/** The spellings of one scope, which a read may use whatever spelling the scope was saved with. */
const SPELLINGS = ['project:kestrel', 'scope:kestrel', 'kestrel'];

const QUESTION = 'how do we roll back a bad release on kestrel?';
/** What the scope holds: a note and a fact, both about Kestrel, neither with roll, back, bad or release in it. */
const SCOPE_NOTE = 'Kestrel: to undo a deploy, redeploy the previous image tag from the registry.';
const SCOPE_FACT = {
  statement: 'Kestrel deploys are undone by redeploying the previous image tag.',
  subject: 'kestrel', predicate: 'undo_method', object: 'redeploy the previous image tag',
};
const MINE = [SCOPE_NOTE, SCOPE_FACT.statement];
type ListedFact = { subject: string; predicate: string; object: string };
const isScopeFact = (f: ListedFact) =>
  f.subject === SCOPE_FACT.subject && f.predicate === SCOPE_FACT.predicate && f.object === SCOPE_FACT.object;
/**
 * Twelve notes of other services, and three facts of the project next door (`kestrel-ops`, a slug that only starts like
 * the scope's): each nearer the question than anything the scope holds.
 */
const NEARER_NOTES = Array.from({ length: 12 }, (_, i) =>
  `Roll back a bad release of service ${i + 1} with scripts/rollback-${i + 1}.sh and tell the on-call channel.`);
const NEARER_FACTS = Array.from({ length: 3 }, (_, i) => ({
  statement: `Roll back a bad release of kestrel ops ${i + 1} with scripts/ops-rollback-${i + 1}.sh and tell the on-call channel.`,
  subject: `kestrel-ops-${i + 1}`, predicate: 'rollback_script', object: `scripts/ops-rollback-${i + 1}.sh`,
}));
const NEARER = [...NEARER_NOTES, ...NEARER_FACTS.map(f => f.statement)];

/** What a scoped get_context and search_memory return of `mine`, and every memory they return. */
async function scopedReads(ws: Workspace, scope: string, question: string, mine: string[], topK = 5) {
  const context = await ws.call('get_context', { query: question, scope });
  const search = await ws.call('search_memory', { query: question, scope, top_k: topK });
  const holds = (list: Array<{ text: string }>, text: string) => list.some(m => m.text.includes(text));
  // get_context lists a fact in `facts` and does not repeat it among its memories (#340), so it finds the scope's fact
  // there, and the listed fact stands for its statement. search_memory has no such list: it returns the statement.
  const listsFact = (context.facts as ListedFact[]).some(isScopeFact);
  return {
    context: mine.filter(text => holds(context.memories, text) || (listsFact && text === SCOPE_FACT.statement)),
    search: mine.filter(text => holds(search.hits, text)),
    all: [...context.memories, ...search.hits] as Array<{ text: string }>,
    facts: context.facts as ListedFact[],
    raw: { context, search },
  };
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a scoped read finds the scope\'s memories under every spelling of its slug, whatever other scopes hold', () => {
  it.each(['project:kestrel', 'scope:kestrel'])('saved as %s: both spellings, and the bare slug, return the note and the fact', async saved => {
    const ws = await boot();
    await ws.note(SCOPE_NOTE, saved);
    await ws.fact(SCOPE_FACT, saved);
    for (const text of NEARER_NOTES) await ws.note(text);
    for (const fact of NEARER_FACTS) await ws.fact(fact, 'project:kestrel-ops');

    // The precondition: the other scopes' memories are the nearer ones, so a read of every scope does not reach the
    // scope's two, and only the scope's own read of the index (the window judged before it is cut) can find them.
    const everywhere = await ws.call('get_context', { query: QUESTION });
    expect(everywhere.memories.filter((m: { text: string }) => MINE.some(text => m.text.includes(text)))).toEqual([]);

    for (const spelling of SPELLINGS) {
      const scoped = await scopedReads(ws, spelling, QUESTION, MINE);
      expect(scoped.context, `${spelling}: ${JSON.stringify(scoped.raw.context)}`).toEqual(MINE);
      expect(scoped.search, `${spelling}: ${JSON.stringify(scoped.raw.search)}`).toEqual(MINE);
      // And nothing of another scope comes back in their place: the project next door is another slug.
      for (const memory of scoped.all) {
        expect(NEARER.some(text => memory.text.includes(text)), `${spelling}: ${memory.text}`).toBe(false);
      }
      expect(scoped.facts.filter(f => NEARER_FACTS.some(n => n.subject === f.subject)), `${spelling}: ${JSON.stringify(scoped.facts)}`).toEqual([]);
    }
  }, 120_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the facts lane keeps the scope\'s fact under another spelling when other scopes hold more than a page of it', () => {
  const DOG = (name: string) => ({ statement: `Rowan's dog is ${name}.`, subject: 'Rowan', predicate: 'dog_name', object: name });

  it.each(['project:kestrel', 'scope:kestrel'])('saved as %s, read as every spelling', async saved => {
    const ws = await boot();
    // The facts lane takes the three newest current facts that answer the question, so the scope's, the oldest, is cut
    // unless the lane judges the scope first; and the others are facts of other scopes, never the scope's.
    await ws.fact(DOG('Nova'), saved);
    for (const [i, name] of ['Rex', 'Ziggy', 'Biscuit'].entries()) await ws.fact(DOG(name), `project:other-${i + 1}`);
    const question = 'what is my dog name?';
    const lane = (hits: Array<{ reason: string; text: string }>) => hits.filter(h => h.reason === 'fact').map(h => h.text);

    const everywhere = await ws.call('search_memory', { query: question });
    expect(lane(everywhere.hits), JSON.stringify(everywhere.hits)).toHaveLength(3);
    expect(lane(everywhere.hits).some(text => text.includes('Nova'))).toBe(false);

    for (const spelling of SPELLINGS) {
      const scoped = await ws.call('search_memory', { query: question, scope: spelling });
      expect(lane(scoped.hits), `${spelling}: ${JSON.stringify(scoped.hits)}`).toEqual(["Rowan's dog_name is Nova."]);
    }
  }, 120_000);
});
