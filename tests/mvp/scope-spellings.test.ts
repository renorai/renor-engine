import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * One scope rule for notes and facts (dogfood 2026-10-03, finding D6). `scope:<slug>`, `project:<slug>` and the bare
 * `<slug>` were one scope for notes (all three file into Memory/Scopes/<slug>/) and two for facts (each stored its
 * own spelling, and a read matched it exactly): reading with the bare slug saw the folder's notes and none of the
 * facts saved as `project:<slug>`. A named scope is now its slug for both. Every memory stays readable under the
 * spelling it was saved with, and is read under the other spellings of its slug too; another slug and global stay
 * apart. Driven through the real MCP tools; synthetic data only (mkdtemp memory dirs, loopback, eval-hash embeddings).
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const HOOK_TIMEOUT_MS = 60_000;

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

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'scope-spellings', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

/**
 * A fresh authenticated service on its own memory dir. Calls are sequential: one shared stateless MCP server.
 * `seed` writes into the memory dir before the service starts (and replays the ledger).
 */
async function startWorkspace(seed?: (memoryDir: string) => void) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-scope-spellings-'));
  seed?.(memoryDir);
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  const port = await freePort();
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'RENOR_READ_HONESTY']) delete process.env[key];
  process.env.RENOR_SEARCH_EVIDENCE = '0';
  const config = loadMvpConfig();
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'scope-spellings', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as any)[0].text as string;
    if (res.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text);
  };
  return {
    call,
    /** One fact through the agent's write tool; `scope` omitted means global. Returns the receipt. */
    async fact(scope: string | undefined, subject: string, predicate: string, object: string) {
      const receipt = await call('remember', { statement: `The ${subject} ${predicate} is ${object}.`, subject, predicate, object, ...(scope ? { scope } : {}) });
      expect(receipt.mode, JSON.stringify(receipt)).toBe('fact');
      return receipt;
    },
    /** One note through the agent's write tool; `scope` omitted means global. */
    async note(scope: string | undefined, statement: string) {
      const receipt = await call('remember', { statement, ...(scope ? { scope } : {}) });
      expect(receipt.mode, JSON.stringify(receipt)).toBe('note');
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

/** Every sentinel the fixtures write, found anywhere in a tool result. */
const SENTINEL = /\b(?:PRICE|HOST|NOTE)(?:PROJ|SCOPE|BARE|KESTREL|GLOBAL)\b/g;
const tokens = (value: unknown): string[] => [...new Set(JSON.stringify(value).match(SENTINEL) ?? [])].sort();

/** Every spelling an agent may use for the scope of the slug `atlas`. */
const ATLAS = ['project:atlas', 'scope:atlas', 'atlas', ' Project:Atlas '];

/** What each read tool returns for one scope. */
async function reads(ws: Workspace, scope: string) {
  const context = await ws.call('get_context', { query: 'zephyr pricing and hosting plan', scope, max_tokens: 4000 });
  const search = await ws.call('search_memory', { query: 'zephyr pricing and hosting plan', scope });
  const text = await ws.call('search_text', { query: 'zephyr', scope });
  return {
    contextFacts: tokens(context.facts),
    // The whole reply: get_context lists a fact in `facts` and does not repeat it among its memories (#340), so the
    // memories alone no longer hold the facts.
    context: tokens(context),
    search: tokens(search.hits),
    text: tokens(text.results),
  };
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a named scope is its slug, for facts as for notes (D6)', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    // The slug atlas, written in three spellings: a fact as project:, a fact as scope:, a note as each of project: and bare.
    await ws.fact('project:atlas', 'zephyr pricing', 'price', 'PRICEPROJ');
    await ws.fact('scope:atlas', 'zephyr hosting', 'host', 'HOSTSCOPE');
    await ws.note('project:atlas', 'zephyr plan note for atlas: NOTEPROJ');
    await ws.note('atlas', 'zephyr plan note for atlas: NOTEBARE');
    // Another slug and global, which no spelling of atlas may read.
    await ws.fact('project:kestrel', 'zephyr kestrel pricing', 'price', 'PRICEKESTREL');
    await ws.note('scope:kestrel', 'zephyr plan note for kestrel: NOTEKESTREL');
    await ws.fact(undefined, 'zephyr global pricing', 'price', 'PRICEGLOBAL');
    await ws.note(undefined, 'zephyr plan note for everyone: NOTEGLOBAL');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('retrieve_memory finds a fact under every spelling of the slug it was saved in, and shows the spelling it was saved with', async () => {
    for (const scope of ATLAS) {
      const pricing = await ws.call('retrieve_memory', { subject: 'zephyr pricing', scope });
      expect(pricing.facts.map((f: any) => [f.object, f.scope]), scope).toEqual([['PRICEPROJ', 'project:atlas']]);
      const hosting = await ws.call('retrieve_memory', { subject: 'zephyr hosting', scope });
      expect(hosting.facts.map((f: any) => [f.object, f.scope]), scope).toEqual([['HOSTSCOPE', 'scope:atlas']]);
      // Another slug's subject stays unknown here.
      expect((await ws.call('retrieve_memory', { subject: 'zephyr kestrel pricing', scope })).known, scope).toBe(false);
      // The history read and the existence check judge it the same way.
      const history = await ws.call('retrieve_memory', { subject: 'zephyr pricing', scope, include_history: true });
      expect(history.facts.map((f: any) => f.object), scope).toEqual(['PRICEPROJ']);
      const otherPredicate = await ws.call('retrieve_memory', { subject: 'zephyr pricing', predicate: 'owner', scope });
      expect([otherPredicate.facts, otherPredicate.known], scope).toEqual([[], true]);
    }
  });

  it('get_context without a query lists the newest facts of every spelling of the slug', async () => {
    for (const scope of ATLAS) {
      const profile = await ws.call('get_context', { scope });
      expect(profile.facts.map((f: any) => f.object), scope).toEqual(['HOSTSCOPE', 'PRICEPROJ']); // newest first
    }
  });

  it('get_context, search_memory and search_text return the slug\'s facts and notes under every spelling, and nothing else', async () => {
    for (const scope of ATLAS) {
      const r = await reads(ws, scope);
      expect(r.contextFacts, scope).toEqual(['HOSTSCOPE', 'PRICEPROJ']);
      for (const [tool, found] of [['get_context', r.context], ['search_memory', r.search], ['search_text', r.text]] as const) {
        expect(found, `${tool} in ${scope}`).toEqual(['HOSTSCOPE', 'NOTEBARE', 'NOTEPROJ', 'PRICEPROJ']);
      }
    }
    // The other slug and global read what they read before: their own memory only.
    const kestrel = await reads(ws, 'project:kestrel');
    expect(kestrel.contextFacts).toEqual(['PRICEKESTREL']);
    expect(kestrel.text).toEqual(['NOTEKESTREL', 'PRICEKESTREL']);
    const global = await reads(ws, 'global');
    expect(global.contextFacts).toEqual(['PRICEGLOBAL']);
    expect(global.text).toEqual(['NOTEGLOBAL', 'PRICEGLOBAL']);
  });

  it('lookup_entity and the subject list judge a fact\'s subject by its slug too', async () => {
    for (const scope of ATLAS) {
      expect((await ws.call('lookup_entity', { name: 'zephyr pricing', scope })).entity?.canonicalName, scope).toBe('zephyr pricing');
      expect((await ws.call('lookup_entity', { name: 'zephyr hosting', scope })).entity?.canonicalName, scope).toBe('zephyr hosting');
      expect((await ws.call('lookup_entity', { name: 'zephyr kestrel pricing', scope })).entity, scope).toBeNull();
      // A misspelt subject is unknown, and the near matches offered are the subjects of this slug, under either spelling.
      const near = await ws.call('retrieve_memory', { subject: 'zephyr pricinq', scope });
      expect(near.known, scope).toBe(false);
      expect([...near.closestSubjects].sort(), scope).toEqual(['zephyr hosting', 'zephyr pricing']);
    }
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a save under another spelling of the slug corrects the value saved under the first; another slug keeps its own', () => {
  let ws: Workspace;
  let first: any;
  let second: any;
  beforeAll(async () => {
    ws = await startWorkspace();
    first = await ws.fact('project:atlas', 'zephyr launch', 'date', 'March 3');
    await ws.fact('project:kestrel', 'zephyr launch', 'date', 'May 1'); // another slug: another scope
    // The same subject and predicate saved again under the other spelling of atlas: one scope, so a correction.
    second = await ws.fact('scope:atlas', 'zephyr launch', 'date', 'April 9');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('the receipt says the save superseded the value saved under the other spelling, and lists no duplicate', async () => {
    expect([second.action, second.closed?.object, second.closed?.factId]).toEqual(['supersede', 'March 3', first.created.factId]);
    expect(second.alsoClosed).toBeUndefined();
    expect(second.possibleDuplicates).toBeUndefined();
  });

  it('retrieve_memory and get_context under any spelling return the one current value and no conflict', async () => {
    for (const scope of ATLAS) {
      const facts = await ws.call('retrieve_memory', { subject: 'zephyr launch', scope });
      expect(facts.facts.map((f: any) => [f.object, f.scope]), scope).toEqual([['April 9', 'scope:atlas']]);
      expect(facts.conflicts, scope).toBeUndefined();
      // The corrected value is history, under the spelling it was saved with.
      const history = await ws.call('retrieve_memory', { subject: 'zephyr launch', scope, include_history: true });
      expect(history.facts.map((f: any) => [f.object, f.scope, f.current]), scope)
        .toEqual([['April 9', 'scope:atlas', true], ['March 3', 'project:atlas', false]]);
      const context = await ws.call('get_context', { query: 'When is the zephyr launch date?', scope, max_tokens: 4000 });
      expect(context.facts.map((f: any) => f.object), scope).toEqual(['April 9']);
      expect(context.conflicts, scope).toBeUndefined();
    }
  });

  it('a read of every scope still names the conflict with the other slug, and never the corrected value', async () => {
    const facts = await ws.call('retrieve_memory', { subject: 'zephyr launch' });
    expect(facts.facts.map((f: any) => [f.object, f.scope])).toEqual([['April 9', 'scope:atlas'], ['May 1', 'project:kestrel']]);
    expect(facts.conflicts?.map((c: any) => c.values.map((v: any) => [v.object, v.scope])))
      .toEqual([[['April 9', 'scope:atlas'], ['May 1', 'project:kestrel']]]);
    const kestrel = await ws.call('retrieve_memory', { subject: 'zephyr launch', scope: 'project:kestrel' });
    expect(kestrel.facts.map((f: any) => [f.object, f.scope])).toEqual([['May 1', 'project:kestrel']]);
  });

  it('the same statement re-sent under the other spelling changes nothing', async () => {
    const again = await ws.fact(' Project:Atlas ', 'zephyr launch', 'date', 'April 9');
    expect([again.action, again.created?.factId]).toEqual(['nochange', second.created.factId]);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('values saved under two spellings before a save closed across them: both current, named as a conflict, until a save corrects both', () => {
  let ws: Workspace;
  beforeAll(async () => {
    // A ledger written before: each spelling of atlas got its own value, and nothing named the other.
    ws = await startWorkspace(memoryDir => {
      const ledger = path.join(memoryDir, ...DEFAULT_LEDGER_REL.split('/'));
      fs.mkdirSync(path.dirname(ledger), { recursive: true });
      fs.writeFileSync(ledger, [
        '---', 'type: memory-ledger', '---', '', '# Memory Events Ledger', '',
        '## MEM_LEGACYPROJ1 · 2026-09-01T00:00:00.000Z', '- kind: store', '- subject: zephyr launch', '- predicate: date',
        '- object: March 3', '- scope: project:atlas', '- source: legacy', '',
        '## MEM_LEGACYSCOPE1 · 2026-09-02T00:00:00.000Z', '- kind: store', '- subject: zephyr launch', '- predicate: date',
        '- object: April 9', '- scope: scope:atlas', '- source: legacy', '',
        '## MEM_LEGACYPROJ2 · 2026-09-03T00:00:00.000Z', '- kind: store', '- subject: zephyr venue', '- predicate: city',
        '- object: Lisbon', '- scope: project:atlas', '- source: legacy', '',
        '## MEM_LEGACYSCOPE2 · 2026-09-04T00:00:00.000Z', '- kind: store', '- subject: zephyr venue', '- predicate: city',
        '- object: Porto', '- scope: scope:atlas', '- source: legacy', '',
      ].join('\n'));
    });
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('retrieve_memory and get_context under any spelling return both values and name the conflict', async () => {
    for (const scope of ATLAS) {
      const facts = await ws.call('retrieve_memory', { subject: 'zephyr launch', scope });
      expect(facts.facts.map((f: any) => [f.object, f.scope]), scope).toEqual([['April 9', 'scope:atlas'], ['March 3', 'project:atlas']]);
      expect(facts.conflicts?.[0]?.values.map((v: any) => v.object), scope).toEqual(['April 9', 'March 3']);
      const context = await ws.call('get_context', { query: 'When is the zephyr launch date?', scope, max_tokens: 4000 });
      expect(context.facts.map((f: any) => f.object).sort(), scope).toEqual(['April 9', 'March 3']);
      expect(context.conflicts?.[0]?.values.map((v: any) => v.object), scope).toEqual(['April 9', 'March 3']);
    }
  });

  it('a save under one spelling closes both values, its receipt names both, and the conflict is gone', async () => {
    const saved = await ws.fact('project:atlas', 'zephyr launch', 'date', 'April 20');
    expect(saved.action).toBe('supersede');
    // closed is the value its ledger event names (saved under the other spelling); alsoClosed is the one under its own.
    expect([saved.closed?.object, saved.alsoClosed?.object]).toEqual(['April 9', 'March 3']);
    expect(saved.possibleDuplicates).toBeUndefined();
    for (const scope of ATLAS) {
      const facts = await ws.call('retrieve_memory', { subject: 'zephyr launch', scope });
      expect(facts.facts.map((f: any) => [f.object, f.scope]), scope).toEqual([['April 20', 'project:atlas']]);
      expect(facts.conflicts, scope).toBeUndefined();
      const history = await ws.call('retrieve_memory', { subject: 'zephyr launch', scope, include_history: true });
      expect(history.facts.map((f: any) => [f.object, f.current]), scope).toEqual([['April 20', true], ['April 9', false], ['March 3', false]]);
    }
  });

  it('save_memory closes both values too, and its receipt names both', async () => {
    const saved = await ws.call('save_memory', { subject: 'zephyr venue', predicate: 'city', object: 'Faro', scope: 'scope:atlas' });
    expect([saved.action, saved.closed?.object, saved.alsoClosed?.object]).toEqual(['supersede', 'Lisbon', 'Porto']);
    const facts = await ws.call('retrieve_memory', { subject: 'zephyr venue', scope: 'atlas' });
    expect(facts.facts.map((f: any) => [f.object, f.scope])).toEqual([['Faro', 'scope:atlas']]);
    expect(facts.conflicts).toBeUndefined();
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a fact saved under one spelling and not indexed yet is found under every spelling', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.fact('scope:atlas', 'zephyr hosting', 'host', 'HOSTSCOPE');
    // save_memory moves the ledger and its projection, not the chunk index (remember re-indexes after every save).
    const saved = await ws.call('save_memory', { subject: 'zephyr pricing', predicate: 'price', object: 'PRICEPROJ', scope: 'project:atlas' });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('search_text and search_memory return it as a fact hit, and say the index is behind', async () => {
    for (const scope of ATLAS) {
      const text = await ws.call('search_text', { query: 'PRICEPROJ', scope });
      expect(text.results.filter((h: any) => h.reason === 'fact').map((h: any) => tokens(h)), scope).toEqual([['PRICEPROJ']]);
      const search = await ws.call('search_memory', { query: 'zephyr pricing', scope });
      expect(search.hits.filter((h: any) => h.reason === 'fact').flatMap((h: any) => tokens(h)), scope).toContain('PRICEPROJ');
      // The newest fact of the scope is the one saved as project:atlas, and the index has not caught up with it.
      expect(search.index?.stale, scope).toBe(true);
    }
  });
});
