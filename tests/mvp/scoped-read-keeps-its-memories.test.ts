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
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Memory scout, finding 7: passing `scope` emptied the memories lane. A scoped get_context answered `memories: []`
 * although the scope held the memory that answers the question, and answered with it when the other scopes held
 * less: search by meaning cut its window to the best chunks of every scope, and only then dropped the ones of other
 * scopes. What a scope returns must not depend on what other scopes hold.
 *
 * Through the real MCP tools over the authenticated Streamable HTTP endpoint, with the deterministic eval-hash
 * embeddings (lexical: the other scopes' notes share more of the question's words, so they are nearer) and synthetic
 * data only. The scope's memories share no word that keyword search looks up (its first four content words), so only
 * search by meaning can find them. MCP calls are sequential: the default stateless JSON mode shares one McpServer.
 */

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
    .send({ client_name: 'scoped-read', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-scoped-read-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  const config = makeConfig(memoryDir, authRoot, await freePort());
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'scoped-read', version: '0.1.0' });
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
    /** A note written by hand into the memory directory, as a user's own markdown would be. */
    write(rel: string, content: string) {
      fs.mkdirSync(path.dirname(path.join(memoryDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(memoryDir, rel), content);
    },
    async note(statement: string, scope?: string) {
      const saved = await call('remember', { statement, source: 'claude', ...(scope ? { scope } : {}) });
      expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, mode: 'note', indexed: true });
    },
  };
}
type Workspace = Awaited<ReturnType<typeof boot>>;

const QUESTION = 'how do we roll back a bad release on kestrel?';
/** What the scope holds: a note and a fact, both about Kestrel, neither with roll, back, bad or release in it. */
const SCOPE = 'project:kestrel';
const SCOPE_NOTE = 'Kestrel: to undo a deploy, redeploy the previous image tag from the registry.';
const SCOPE_FACT = {
  statement: 'Kestrel deploys are undone by redeploying the previous image tag.',
  subject: 'kestrel', predicate: 'undo_method', object: 'redeploy the previous image tag',
};
/** Twelve notes of other services, each nearer the question than anything the scope holds. */
const NEARER = Array.from({ length: 12 }, (_, i) =>
  `Roll back a bad release of service ${i + 1} with scripts/rollback-${i + 1}.sh and tell the on-call channel.`);

async function saveScope(ws: Workspace) {
  await ws.note(SCOPE_NOTE, SCOPE);
  const saved = await ws.call('remember', { ...SCOPE_FACT, scope: SCOPE, source: 'claude' });
  expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, mode: 'fact', action: 'store' });
}

/** The scope's memories each read returns: get_context at its default budget, and search_memory with a short page. */
async function scopedReads(ws: Workspace, scope: string, question: string, mine: string[], topK = 5) {
  const context = await ws.call('get_context', { query: question, scope });
  const search = await ws.call('search_memory', { query: question, scope, top_k: topK });
  const found = (list: Array<{ text: string }>) => mine.filter(text => list.some(m => m.text.includes(text)));
  // get_context lists a fact once: as the fact, without the memory that is the event that saved it (the user's words).
  const listed = (facts: Array<{ subject: string; predicate: string; object: string }>) =>
    facts.some(f => f.subject === SCOPE_FACT.subject && f.predicate === SCOPE_FACT.predicate && f.object === SCOPE_FACT.object);
  const inContext = mine.filter(text => found(context.memories).includes(text) || (text === SCOPE_FACT.statement && listed(context.facts)));
  return { context: inContext, search: found(search.hits), raw: { context, search } };
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a scoped read keeps the memories of its scope, whatever other scopes hold (memory scout, finding 7)', () => {
  it('get_context and search_memory return the scope\'s note and fact when other scopes hold nearer matches', async () => {
    const mine = [SCOPE_NOTE, SCOPE_FACT.statement];

    const alone = await boot();
    await saveScope(alone);
    // The precondition: with nothing else on file, search by meaning finds both.
    expect((await scopedReads(alone, SCOPE, QUESTION, mine)).context).toEqual(mine);

    const crowded = await boot();
    await saveScope(crowded);
    for (const text of NEARER) await crowded.note(text);
    // The other notes are the nearer ones: a read of every scope does not reach the scope's two.
    const everywhere = await crowded.call('get_context', { query: QUESTION });
    expect(everywhere.memories.filter((m: { text: string }) => mine.some(text => m.text.includes(text)))).toEqual([]);

    const scoped = await scopedReads(crowded, SCOPE, QUESTION, mine);
    expect(scoped.context, JSON.stringify(scoped.raw.context)).toEqual(mine);
    expect(scoped.search, JSON.stringify(scoped.raw.search)).toEqual(mine);
    // And nothing of another scope comes back in their place.
    for (const memory of [...scoped.raw.context.memories, ...scoped.raw.search.hits]) {
      expect(NEARER.some(text => memory.text.includes(text)), memory.text).toBe(false);
    }
  }, 120_000);

  it('a small scope inside a large workspace answers a paraphrase on the workspace\'s main topic', async () => {
    const mine = [SCOPE_NOTE, SCOPE_FACT.statement];
    const ws = await boot();
    // The workspace is about rolling back releases: 150 notes of other services, every one nearer the question than
    // anything the scope holds, so the scope's memories are past the first reads of the nearest chunks.
    for (let i = 0; i < 150; i++) {
      ws.write(`Notes/services/service-${i}.md`, `# Service ${i}\n\nRoll back a bad release of service ${i} with scripts/rollback-${i}.sh, then tell the on-call channel how the release went.\n`);
    }
    await ws.call('index_memory');
    await saveScope(ws);

    const scoped = await scopedReads(ws, SCOPE, QUESTION, mine, 20);
    expect(scoped.context, JSON.stringify(scoped.raw.context)).toEqual(mine);
    expect(scoped.search, JSON.stringify(scoped.raw.search)).toEqual(mine);
  }, 120_000);

  it('scopes read one after the other, with nothing written between, each get their own memories and none of the others\'', async () => {
    // What a scope holds is read from the whole index once and kept until something is written, so the scopes of the reads
    // that follow one another must not share it: a read of one scope must never be answered with another's chunks.
    const HERON = 'project:heron';
    const HERON_NOTE = 'Heron: to undo a deploy, redeploy the previous image tag from the registry.';
    const ws = await boot();
    for (let i = 0; i < 150; i++) {
      ws.write(`Notes/services/service-${i}.md`, `# Service ${i}\n\nRoll back a bad release of service ${i} with scripts/rollback-${i}.sh, then tell the on-call channel how the release went.\n`);
    }
    await ws.call('index_memory');
    await ws.note(SCOPE_NOTE, SCOPE);
    await ws.note(HERON_NOTE, HERON);

    const holds = (reply: { memories?: Array<{ text: string }>; hits?: Array<{ text: string }> }, text: string) =>
      [...(reply.memories ?? []), ...(reply.hits ?? [])].some(m => m.text.includes(text));
    const reads = async (scope: string, question: string) => [
      await ws.call('get_context', { query: question, scope }),
      await ws.call('search_memory', { query: question, scope, top_k: 20 }),
    ];
    const kestrel = 'how do we roll back a bad release on kestrel?';
    const heron = 'how do we roll back a bad release on heron?';
    for (const [scope, question, mine, other] of [
      [SCOPE, kestrel, SCOPE_NOTE, HERON_NOTE],
      [HERON, heron, HERON_NOTE, SCOPE_NOTE],
      [SCOPE, kestrel, SCOPE_NOTE, HERON_NOTE],
      [HERON, heron, HERON_NOTE, SCOPE_NOTE],
    ] as const) {
      for (const reply of await reads(scope, question)) {
        expect(holds(reply, mine), `${scope} holds its own note: ${JSON.stringify(reply).slice(0, 400)}`).toBe(true);
        expect(holds(reply, other), `${scope} never holds the other scope's note`).toBe(false);
      }
    }
  }, 120_000);

  it('the global scope keeps its memories when a named scope holds nearer matches', async () => {
    const question = 'how do we roll back a bad release on atlas?';
    const globalNote = 'Atlas: to undo a deploy, redeploy the previous image tag from the registry.';
    const ws = await boot();
    await ws.note(globalNote);
    for (const text of NEARER) await ws.note(text, 'project:services');

    const scoped = await scopedReads(ws, 'global', question, [globalNote]);
    expect(scoped.context, JSON.stringify(scoped.raw.context)).toEqual([globalNote]);
    expect(scoped.search, JSON.stringify(scoped.raw.search)).toEqual([globalNote]);
  }, 120_000);
});
