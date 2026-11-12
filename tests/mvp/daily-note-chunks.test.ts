import { describe, it, expect, afterAll, afterEach } from 'vitest';
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
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { isDailyNotePath } from '../../src/memory/dailyNote';
import { replyTokens } from '../../src/mvp/agentMemory';
import { makeLegacyDailyNote } from '../helpers/legacyDailyIndex';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';
import { defaultContextMaxTokens } from '../../src/retrieval/orchestrator';

/**
 * A daily note holds one entry per `remember`. Recalling one memory must return that memory, not the day.
 * Every test goes through the real MCP tools over the authenticated Streamable HTTP endpoint, with the
 * deterministic eval-hash embeddings and synthetic data only. MCP calls are sequential: the default stateless
 * JSON mode shares one McpServer, so overlapping calls to async tools answer 500.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const BS = '\\';

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
  process.env.RENOR_SEARCH_EVIDENCE = '0';
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  // Self-hosted writes use the registered OAuth identity, matching this fixture's asserted author.
  const reg = await request(app).post('/register')
    .send({ client_name: 'claude', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

type Hit = { text: string; notePath?: string };

/** An authenticated service on a memory directory (a fresh one unless one is given). */
async function boot(existingDir?: string) {
  const memoryDir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-daily-chunks-'));
  if (!existingDir) dirs.push(memoryDir);
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  dirs.push(authRoot);
  const config = makeConfig(memoryDir, authRoot, await freePort());
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'daily-note-chunks', version: '0.1.0' });
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
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await client.close();
    service.httpServer.closeAllConnections?.();
    await new Promise<void>(resolve => service.httpServer.close(() => resolve()));
    await service.close();
  };
  cleanups.push(stop);
  return {
    memoryDir, service, call, stop,
    raw: (file: string) => fs.readFileSync(path.join(memoryDir, file), 'utf8'),
    /** One note-mode memory. Returns the daily file it went into. */
    async note(statement: string, extra: Record<string, unknown> = {}): Promise<string> {
      const saved = await call('remember', { statement, source: 'claude', ...extra });
      expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, mode: 'note', indexed: true });
      return saved.file as string;
    },
    /** The three read tools, by the token a memory carries: the memories (not the day) that hold it. */
    async recall(token: string, extra: Record<string, unknown> = {}) {
      const keyword = ((await call('search_text', { query: token, ...extra })).results as Hit[]).filter(h => h.text.includes(token));
      const semantic = ((await call('search_memory', { query: token, ...extra })).hits as Hit[]).filter(h => h.text.includes(token));
      const context = ((await call('get_context', { query: token, max_tokens: 4000, ...extra })).memories as Hit[]).filter(h => h.text.includes(token));
      return { keyword, semantic, context };
    },
  };
}
type Workspace = Awaited<ReturnType<typeof boot>>;

/** Stop the service and start a fresh one on the same memory directory, as a deploy or a crash would. */
async function restart(ws: Workspace, opts: { coldIndex?: boolean } = {}): Promise<Workspace> {
  await ws.stop();
  if (opts.coldIndex) fs.rmSync(path.join(ws.memoryDir, '.memory-index'), { recursive: true, force: true });
  return boot(ws.memoryDir);
}

const ENTRY_HEAD = /^- \[\d{2}:\d{2}:\d{2}\] \(claude\) /;
const asSaid = (text: string) => text.replace(ENTRY_HEAD, '');

/**
 * Seven things said on one day; the third answers the question below, the rest are about other things. The
 * eval-hash embeddings are lexical, so the others avoid the question's function words: the order under test is
 * then the chunking's, not a quirk of the stub.
 */
const DAY: Array<[token: string, statement: string]> = [
  ['nchunkstaging', 'Staging database rebuilds every Monday morning (nchunkstaging).'],
  ['nchunkoncall', 'On-call rotation hands over on Fridays at 17:00 (nchunkoncall).'],
  ['nchunkretry', 'Job alpha has a retry budget of 5 attempts with exponential backoff (nchunkretry).'],
  ['nchunkinvoice', 'Invoices export to a finance bucket on day 1 of every month (nchunkinvoice).'],
  ['nchunkdesign', 'Billing page design review moved to Thursday (nchunkdesign).'],
  ['nchunkrelease', 'Release branches get cut from main every second Wednesday (nchunkrelease).'],
  ['nchunksupport', 'Customer support escalations go to a dedicated channel (nchunksupport).'],
];
const QUESTION = 'what is the retry budget for job alpha?';

/**
 * The semantic memory that matches best. Newest first (the default order) puts the most recent match first, and each
 * entry is dated by its own moment, so an entry said after the answer comes before it; scores are compared only among
 * the semantic memories, as the get_context description says.
 */
const bestMatch = (memories: Array<{ text: string; score?: number; reason: string }>) =>
  memories.filter(m => m.reason.startsWith('semantic')).reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('recalling one daily-note memory returns that memory, not the whole day', () => {
  it('get_context returns the memory that answers the question as its best match, alone', async () => {
    const ws = await boot();
    for (const [, statement] of DAY) await ws.note(statement);

    const ctx = await ws.call('get_context', { query: QUESTION });
    const best = bestMatch(ctx.memories);
    expect(best.text).toContain('retry budget of 5 attempts');
    // The other six things said that day are other memories, not part of this one.
    for (const [token] of DAY) {
      if (token !== 'nchunkretry') expect(best.text, token).not.toContain(token);
    }
  }, 90_000);

  it('every remember is a memory of its own, with its own time, through search_text, search_memory and get_context', async () => {
    const ws = await boot();
    let file = '';
    for (const [, statement] of DAY) file = await ws.note(statement);
    const stored = ws.raw(file).split('\n').filter(line => line.startsWith('- ['));
    expect(stored).toHaveLength(DAY.length);
    expect((await ws.call('memory_status')).chunks).toBe(DAY.length);

    for (const [i, [token]] of DAY.entries()) {
      const { keyword, semantic, context } = await ws.recall(token);
      // The entry exactly as the file keeps it: its time, its source and the words, and nothing of the other six.
      expect(keyword.map(h => h.text), `search_text ${token}`).toEqual([stored[i]]);
      expect(semantic.map(h => h.text), `search_memory ${token}`).toEqual([stored[i]]);
      expect(context.map(h => h.text), `get_context ${token}`).toEqual([stored[i]]);
    }
  }, 90_000);

  it('a day with fifty entries still answers at the default budget (it used to come back with no memories at all)', async () => {
    const ws = await boot();
    for (let i = 0; i < 50; i++) {
      await ws.note(i === 17
        ? 'Job alpha has a retry budget of 5 attempts with exponential backoff (nchunkretry).'
        : `Fifty-day filler ${i}: planning sync agreed item number ${i} (nchunkfifty${i}).`);
    }
    // The whole reply fits its budget (live dogfood D9), and the entry that answers leads it: at the default (the deep
    // page, 8,000 tokens since 2026-11-09) and at 800, the former default (lean mode).
    for (const [args, budget] of [[{}, defaultContextMaxTokens()], [{ max_tokens: 800 }, 800]] as const) {
      const ctx = await ws.call('get_context', { query: QUESTION, ...args });
      expect(replyTokens(JSON.stringify(ctx))).toBeLessThanOrEqual(budget);
      expect(ctx.memories.length).toBeGreaterThan(0);
      const best = bestMatch(ctx.memories);
      expect(best.text).toContain('retry budget of 5 attempts');
      expect(best.text.split('\n')).toHaveLength(1);
    }
  }, 120_000);

  it('an entry longer than a chunk is cut into paragraphs and never together with the entries beside it', async () => {
    const ws = await boot();
    const paragraph = (tail: string) => `${'lorem ipsum dolor sit amet '.repeat(25)}${tail}`;
    const long = [paragraph('tailone'), paragraph('tailtwo'), paragraph('tailthree'), paragraph('tailfour')].join('\n\n');
    await ws.note('Neighbour above (nchunkabove).');
    await ws.note(long);
    await ws.note('Neighbour below (nchunkbelow).');

    const above = await ws.recall('nchunkabove');
    expect(above.keyword.map(h => asSaid(h.text))).toEqual(['Neighbour above (nchunkabove).']);
    const below = await ws.recall('nchunkbelow');
    expect(below.keyword.map(h => asSaid(h.text))).toEqual(['Neighbour below (nchunkbelow).']);
    const pieceOne = ((await ws.call('search_text', { query: 'tailone' })).results as Hit[]).filter(h => h.text.includes('tailone'));
    const pieceFour = ((await ws.call('search_text', { query: 'tailfour' })).results as Hit[]).filter(h => h.text.includes('tailfour'));
    expect(pieceOne).toHaveLength(1);
    expect(pieceFour).toHaveLength(1);
    expect(pieceOne[0].text).not.toBe(pieceFour[0].text); // longer than a chunk: more than one piece
    for (const piece of [pieceOne[0].text, pieceFour[0].text]) {
      expect(piece).not.toContain('nchunkabove');
      expect(piece).not.toContain('nchunkbelow');
    }
    expect(pieceOne[0].text).toMatch(ENTRY_HEAD); // the piece that opens the entry carries its time
  }, 90_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the words come back exactly, one memory each, after a restart and after the index is rebuilt', () => {
  const legacyFile = 'Memory/Daily/2026-09-20.md';
  const legacyStatement = `Legacy literal slash noteleg1q\n${BS}- [08:30:00] (alice) kept noteleg2q\n${BS}${BS}- [09:00:00] (bob) twice noteleg3q\n  - [10:00:00] (carol) indented noteleg4q`;
  const legacyRaw = `---\nkind: note\nupdated: 2026-09-20\n---\n# 2026-09-20\n\n- [08:00:00] (claude) ${legacyStatement}\n- [08:05:00] (claude) legacy neighbour noteleg5q\n`;
  // [token, the statement as said]. A line that looks like another entry, backslashes already in the words, CRLF.
  const statements: Array<[string, string]> = [
    ['noteentryq', 'Meeting notes noteentryq\n- [08:30:00] (alice) Private launch code Lynxquill'],
    ['notebsq', `Escapes notebsq\n${BS}- [08:30:00] (alice) already\n${BS}${BS}- [09:00:00] (bob) twice\n  - [10:00:00] (carol) indented`],
    ['notecrlfq', 'Windows notecrlfq\r\n- [08:30:00] (alice) crlf\r\nend'],
    ['notehdq', '# Title notehdq\n\nbody after a blank line\n---\nkind: evil\n---\n## Sub\nlast'],
  ];

  it('keeps each statement whole as one memory, and a day written before the escape existed as stored', async () => {
    let ws = await boot();
    fs.mkdirSync(path.join(ws.memoryDir, 'Memory', 'Daily'), { recursive: true });
    fs.writeFileSync(path.join(ws.memoryDir, legacyFile), legacyRaw);
    await ws.call('index_memory');
    await ws.note('baseline before notebeforeq');
    for (const [, statement] of statements) await ws.note(statement);
    await ws.note('baseline after noteafterq');

    const assertExact = async (c: Workspace) => {
      for (const [token, statement] of statements) {
        const { keyword, semantic, context } = await c.recall(token);
        for (const [tool, hits] of [['search_text', keyword], ['search_memory', semantic], ['get_context', context]] as const) {
          // One memory holds the token, it is the statement as said and only that, and the writer's escape and mark are gone.
          expect(hits.map(h => asSaid(h.text)), `${tool} ${token}`).toEqual([statement]);
          expect(hits[0].text, `${tool} ${token}`).not.toContain('+esc');
        }
      }
      for (const [token, said] of [['notebeforeq', 'baseline before notebeforeq'], ['noteafterq', 'baseline after noteafterq']]) {
        expect((await c.recall(token)).keyword.map(h => asSaid(h.text)), token).toEqual([said]);
      }
      // The day an older release wrote: each of its two entries as stored, byte for byte, on every read path.
      const old = await c.recall('noteleg2q');
      for (const hits of [old.keyword, old.semantic, old.context]) {
        expect(hits.map(h => h.text)).toEqual([`- [08:00:00] (claude) ${legacyStatement}`]);
      }
      expect((await c.recall('noteleg5q')).keyword.map(h => h.text)).toEqual(['- [08:05:00] (claude) legacy neighbour noteleg5q']);
      expect(c.raw(legacyFile)).toBe(legacyRaw);
    };
    await assertExact(ws);
    ws = await restart(ws);
    await assertExact(ws);
    // The derived index deleted: the files alone rebuild it, cut the same way.
    ws = await restart(ws, { coldIndex: true });
    await ws.call('index_memory');
    await assertExact(ws);
  }, 120_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a workspace indexed before this change', () => {
  /**
   * Build a workspace with the current code (earlier days, today, a fact), stop it, and put its index back the way
   * the release before this one left it: each daily note one chunk under the hash of its bytes alone.
   */
  async function legacyWorkspace() {
    process.env.RENOR_NEWEST_FIRST = '0'; // the days are written within a second of each other: order them by match, not by file time
    const first = await boot();
    const said: Array<[token: string, statement: string, file: string]> = [];
    for (const [date, entries] of [
      ['2026-09-20', DAY.slice(0, 3)],
      ['2026-09-21', DAY.slice(3, 5)],
    ] as const) {
      for (const [token, statement] of entries) {
        const saved = await first.call('remember_note', { text: statement, date, source: 'claude' });
        said.push([token, statement, saved.file]);
      }
    }
    for (const [token, statement] of DAY.slice(5)) said.push([token, statement, await first.note(statement)]);
    await first.call('remember', { statement: 'Alice works at Globex.', subject: 'Alice', predicate: 'works_at', object: 'Globex', scope: 'project:renor' });
    await first.call('index_memory');

    const chunksNow = (await first.call('memory_status')).chunks as number;
    const ledgerBefore = first.service.db.prepare(
      "SELECT id, note_path AS notePath, heading_path AS headingPath, text FROM chunks WHERE note_path LIKE '%Ledger%' ORDER BY id",
    ).all();
    expect(ledgerBefore.length).toBeGreaterThan(0);
    const { memoryDir } = first;
    const memoryMapBefore = (await first.call('memory_map')).memories.map((m: any) => m.id).sort();
    await first.stop();

    const db = openDb(path.join(memoryDir, '.memory-index', 'index.db'));
    runMigrations(db);
    const provider = new EvalHashEmbeddingProvider();
    const vectorIndex = new VectorIndex(db, provider.dimensions);
    vectorIndex.initTable();
    const dailyFiles = (fs.readdirSync(memoryDir, { recursive: true }) as string[])
      .filter(rel => rel.endsWith('.md') && isDailyNotePath(rel)).map(rel => path.join(memoryDir, rel));
    let legacyChunks = ledgerBefore.length; // every other note keeps the chunks it has
    for (const file of dailyFiles) legacyChunks += (await makeLegacyDailyNote(db, vectorIndex, provider, file)).length;
    db.close();

    const bytes = () => Object.fromEntries((fs.readdirSync(memoryDir, { recursive: true }) as string[])
      .filter(rel => rel.endsWith('.md')).map(rel => [rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(memoryDir, rel))).digest('hex')]));
    return { memoryDir, said, chunksNow, legacyChunks, ledgerBefore, memoryMapBefore, bytesBefore: bytes(), bytes };
  }

  async function assertUpgraded(ws: Workspace, w: Awaited<ReturnType<typeof legacyWorkspace>>, extraChunks: number) {
    expect((await ws.call('memory_status')).chunks).toBe(w.chunksNow + extraChunks);
    // Nothing that was said is gone, and each thing is now a memory of its own, in the index and to a semantic search.
    for (const [token, statement] of w.said) {
      const { keyword, semantic, context } = await ws.recall(token);
      for (const [tool, hits] of [['search_text', keyword], ['search_memory', semantic], ['get_context', context]] as const) {
        expect(hits.map(h => asSaid(h.text)), `${tool} ${token}`).toEqual([statement]);
      }
    }
    const answer = await ws.call('get_context', { query: QUESTION });
    expect(asSaid(answer.memories[0].text)).toBe(DAY[2][1]);
    // The fact is still current, the memory map lists the same memories, and what is not a daily note was not cut again.
    expect((await ws.call('retrieve_memory', { subject: 'Alice', scope: 'project:renor' })).facts[0].object).toBe('Globex');
    const mapNow = (await ws.call('memory_map')).memories.map((m: any) => m.id).sort();
    expect(mapNow.filter((id: string) => w.memoryMapBefore.includes(id))).toEqual(w.memoryMapBefore);
  }

  it('is cut by entry by the next ordinary save, with nothing lost and nothing else touched', async () => {
    const w = await legacyWorkspace();
    let ws = await boot(w.memoryDir);
    // The index is as the release before left it: a chunk for each day.
    expect((await ws.call('memory_status')).chunks).toBe(w.legacyChunks);
    expect(w.legacyChunks).toBeLessThan(w.chunksNow);
    // The ordinary path: a save indexes the vault.
    await ws.note('A note saved after the upgrade (nchunkafter).');
    await assertUpgraded(ws, w, 1);
    const idsAfterFirstPass = ws.service.db.prepare('SELECT id FROM chunks ORDER BY id').all();
    // Every other note is untouched, to the chunk id.
    const ledgerNow = ws.service.db.prepare(
      "SELECT id, note_path AS notePath, heading_path AS headingPath, text FROM chunks WHERE note_path LIKE '%Ledger%' ORDER BY id",
    ).all();
    expect(ledgerNow).toEqual(w.ledgerBefore);
    // The files are exactly as they were, except the day that was appended to.
    const bytesNow = w.bytes();
    const changed = Object.keys(bytesNow).filter(rel => bytesNow[rel] !== w.bytesBefore[rel]);
    expect(changed.every(rel => /Memory\/Daily\/\d{4}-\d{2}-\d{2}\.md$/.test(rel))).toBe(true);
    expect(changed.length).toBeLessThanOrEqual(1);

    // And it is done: another pass, here and after a restart, changes nothing.
    await ws.call('index_memory');
    expect(ws.service.db.prepare('SELECT id FROM chunks ORDER BY id').all()).toEqual(idsAfterFirstPass);
    ws = await restart(ws);
    await ws.call('index_memory');
    expect(ws.service.db.prepare('SELECT id FROM chunks ORDER BY id').all()).toEqual(idsAfterFirstPass);
  }, 180_000);

  it('is cut by entry by index_memory, the way an operator reindexes after a deploy', async () => {
    const w = await legacyWorkspace();
    const ws = await boot(w.memoryDir);
    await ws.call('index_memory');
    await assertUpgraded(ws, w, 0);
    expect(w.bytes()).toEqual(w.bytesBefore); // reindexing writes no note
  }, 180_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('scope still decides what a read can see, and a day is cut by entry inside each scope', () => {
  it('returns a scope\'s own entries one by one and no other scope\'s', async () => {
    const ws = await boot();
    await ws.note('Global plan ship the beta (nchunkgplana).');
    await ws.note('Global plan review pricing (nchunkgplanb).');
    await ws.note('Work plan ship the dashboard (nchunkwplana).', { scope: 'scope:work' });
    await ws.note('Work plan hire a designer (nchunkwplanb).', { scope: 'scope:work' });

    const memoriesOf = async (scope: string | undefined) => {
      const args = scope ? { scope } : {};
      const context = (await ws.call('get_context', { query: 'plan', max_tokens: 4000, ...args })).memories as Hit[];
      const semantic = (await ws.call('search_memory', { query: 'plan', ...args })).hits as Hit[];
      const keyword = (await ws.call('search_text', { query: 'plan', ...args })).results as Hit[];
      return { context, semantic, keyword };
    };
    const entryTokens = (hits: Hit[]) => hits.map(h => h.text.match(/nchunk[gw]plan[ab]/g) ?? []);
    const work = await memoriesOf('scope:work');
    const global = await memoriesOf('global');
    const everything = await memoriesOf(undefined);
    for (const [name, hits] of Object.entries(work)) {
      expect(hits.every(h => h.notePath!.startsWith('Memory/Scopes/work/')), `work ${name}`).toBe(true);
      expect(entryTokens(hits).every(t => t.length === 1), `work ${name} one entry per memory`).toBe(true);
      expect(entryTokens(hits).flat().sort(), `work ${name}`).toEqual(['nchunkwplana', 'nchunkwplanb']);
    }
    for (const [name, hits] of Object.entries(global)) {
      expect(hits.every(h => !h.notePath!.includes('Scopes/')), `global ${name}`).toBe(true);
      expect(entryTokens(hits).flat().sort(), `global ${name}`).toEqual(['nchunkgplana', 'nchunkgplanb']);
    }
    for (const [name, hits] of Object.entries(everything)) {
      expect(entryTokens(hits).every(t => t.length === 1), `all ${name} one entry per memory`).toBe(true);
      expect(entryTokens(hits).flat().sort(), `all ${name}`).toEqual(['nchunkgplana', 'nchunkgplanb', 'nchunkwplana', 'nchunkwplanb']);
    }
  }, 90_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('retiring and restoring one entry of a day', () => {
  it('takes only that memory out of recall and puts it back, its neighbours untouched', async () => {
    const ws = await boot();
    let file = '';
    for (const [, statement] of DAY.slice(0, 4)) file = await ws.note(statement);
    const entries = ((await ws.call('memory_map')).memories as any[]).filter(m => m.kind === 'entry' && m.path === file);
    expect(entries).toHaveLength(4);
    const target = entries.find(e => e.title.includes('nchunkretry'))!;
    expect((await ws.call('memory_status')).chunks).toBe(4);

    await ws.call('retire_memory', { id: target.id });
    expect((await ws.call('memory_status')).chunks).toBe(3);
    const gone = await ws.recall('nchunkretry');
    expect([gone.keyword, gone.semantic, gone.context].map(h => h.length)).toEqual([0, 0, 0]);
    for (const [token, statement] of [DAY[0], DAY[1], DAY[3]]) {
      expect((await ws.recall(token)).keyword.map(h => asSaid(h.text)), token).toEqual([statement]);
    }

    await ws.call('restore_memory', { id: target.id });
    expect((await ws.call('memory_status')).chunks).toBe(4);
    const back = await ws.recall('nchunkretry');
    expect(back.keyword.map(h => asSaid(h.text))).toEqual([DAY[2][1]]);
    expect(back.context.map(h => asSaid(h.text))).toEqual([DAY[2][1]]);
  }, 90_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('what is current stays current beside the entries of a day (a guard: this held before the day was cut by entry)', () => {
  it('a corrected fact never surfaces as current, and the entries around it are still recalled', async () => {
    const ws = await boot();
    await ws.call('remember', { statement: 'Alice works at Acme.', subject: 'Alice', predicate: 'works_at', object: 'Acme' });
    await ws.note('Alice mentioned a team offsite in Lisbon (nchunkoffsite).');
    await ws.call('remember', { statement: 'Correction: Alice works at Globex.', subject: 'Alice', predicate: 'works_at', object: 'Globex' });
    await ws.note('Alice shared the onboarding plan for her new team (nchunkonboard).');

    const context = await ws.call('get_context', { query: 'where does Alice work?', max_tokens: 4000 });
    expect(context.facts[0].object).toBe('Globex');
    expect(JSON.stringify(context.memories)).not.toContain('Acme');
    const texts = (context.memories as Hit[]).map(m => m.text);
    expect(texts.some(t => t.includes('Alice mentioned a team offsite in Lisbon (nchunkoffsite).'))).toBe(true);
    expect(texts.some(t => t.includes('Alice shared the onboarding plan for her new team (nchunkonboard).'))).toBe(true);
    for (const tool of [
      (await ws.call('search_memory', { query: 'Acme where Alice works' })).hits,
      (await ws.call('search_text', { query: 'Acme' })).results,
    ] as Hit[][]) expect(JSON.stringify(tool)).not.toContain('Acme.');

    // History is asked for, never inferred: with it the superseded event is back, labelled.
    const history = await ws.call('get_context', { query: 'where does Alice work?', max_tokens: 4000, include_history: true });
    expect(JSON.stringify(history.memories)).toContain('Acme');
    expect(JSON.stringify(history.memories)).toContain('Superseded');
  }, 90_000);
});
