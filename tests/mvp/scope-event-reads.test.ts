import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
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
 * Scope of the memory a read returns, driven through the real MCP tools over the authenticated Streamable HTTP
 * endpoint. Synthetic data only (mkdtemp memory dirs, loopback, the deterministic eval-hash embeddings).
 *
 * The ledger is ONE global file, but each event in it was saved in a scope. A read in a scope must return that
 * scope's events and no other scope's, whatever the ledger's path says; a note is still judged by its path.
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
  process.env.RENOR_SEARCH_EVIDENCE = '0'; // the evidence second pass has its own test below
  if (ledgerRel) process.env.MVP_LEDGER_REL = ledgerRel;
  else delete process.env.MVP_LEDGER_REL;
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'scope-event-reads', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

/** A fresh authenticated service on its own memory dir. Calls are sequential: one shared stateless MCP server. */
async function startWorkspace(ledgerRel?: string) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-scope-reads-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  const config = makeConfig(memoryDir, authRoot, await freePort(), ledgerRel);
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'scope-event-reads', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as any)[0].text as string;
    return res.isError ? { isError: true, text } : JSON.parse(text);
  };
  return {
    service, memoryDir, call,
    /** One fact in one scope; `scope` omitted means global. */
    async save(scope: string | undefined, subject: string, predicate: string, object: string) {
      const receipt = await call('remember', { statement: `${subject} ${predicate} is ${object}`, subject, predicate, object, ...(scope ? { scope } : {}) });
      expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
    },
    /** The lower-level write: the ledger and its projection move, the chunk index does not (`remember` re-indexes after every save). */
    async saveWithoutIndexing(scope: string | undefined, subject: string, predicate: string, object: string) {
      const receipt = await call('save_memory', { subject, predicate, object, ...(scope ? { scope } : {}) });
      expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
    },
    async note(scope: string | undefined, statement: string) {
      const receipt = await call('remember', { statement, ...(scope ? { scope } : {}) });
      expect(receipt.mode, JSON.stringify(receipt)).toBe('note');
    },
    index: () => call('index_memory'),
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
const SENTINEL = /\b(?:WORK|LAUNCH|GLOBAL)(?:OLD|NEW|NOTE|PROJ|LOC)\b/g;
const tokens = (value: unknown): string[] => [...new Set(JSON.stringify(value).match(SENTINEL) ?? [])].sort();

/** The four reads an agent can make for a query, for one scope and history setting. */
async function reads(ws: Workspace, scope: string | undefined, includeHistory = false) {
  const withScope = scope === undefined ? {} : { scope };
  const context = await ws.call('get_context', { query: 'meeting time', max_tokens: 4000, include_history: includeHistory, ...withScope });
  const search = await ws.call('search_memory', { query: 'meeting time', include_history: includeHistory, ...withScope });
  const text = await ws.call('search_text', { query: 'meeting', ...withScope });
  return {
    contextFacts: tokens(context.facts),
    // get_context lists an event once: as the fact its facts lane found, else as a memory (live dogfood D8).
    context: tokens([context.facts, context.memories]),
    search: tokens(search.hits),
    text: tokens(text.results),
    raw: { context, search, text },
  };
}

// One subject, `meeting`/`time`, saved and then corrected in three scopes, plus one plain note per scope:
//   scope:work       WORKOLD    -> WORKNEW
//   project:launch   LAUNCHOLD  -> LAUNCHNEW
//   global           GLOBALOLD  -> GLOBALNEW
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('reads of ledger events are judged by the scope each event was saved in', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    for (const [scope, prefix] of [['scope:work', 'WORK'], ['project:launch', 'LAUNCH'], [undefined, 'GLOBAL']] as const) {
      await ws.save(scope, 'meeting', 'time', `${prefix}OLD`);
      await ws.index();
      await ws.save(scope, 'meeting', 'time', `${prefix}NEW`);
      await ws.index();
    }
    await ws.note('scope:work', 'meeting note for the work scope: WORKNOTE');
    await ws.note(undefined, 'meeting note for everyone: GLOBALNOTE');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  describe('a global read returns global memory only', () => {
    it('get_context, search_memory and search_text return no value that was saved in a named scope', async () => {
      const r = await reads(ws, 'global');
      expect(r.contextFacts).toEqual(['GLOBALNEW']);
      for (const [tool, found] of [['get_context', r.context], ['search_memory', r.search], ['search_text', r.text]] as const) {
        expect(found, tool).toEqual(['GLOBALNEW', 'GLOBALNOTE']);
      }
    });

    it('an empty scope is the global scope, exactly as for facts', async () => {
      const r = await reads(ws, '');
      expect(r.context).toEqual(['GLOBALNEW', 'GLOBALNOTE']);
      expect(r.search).toEqual(['GLOBALNEW', 'GLOBALNOTE']);
      expect(r.text).toEqual(['GLOBALNEW', 'GLOBALNOTE']);
    });

    it('include_history adds the superseded GLOBAL event, labelled, and still no other scope\'s history', async () => {
      const r = await reads(ws, 'global', true);
      expect(r.context).toEqual(['GLOBALNEW', 'GLOBALNOTE', 'GLOBALOLD']);
      expect(r.search).toEqual(['GLOBALNEW', 'GLOBALNOTE', 'GLOBALOLD']);
      const old = r.raw.search.hits.find((h: any) => h.text.includes('GLOBALOLD'));
      expect(old.text).toContain('[Superseded memory event; historical evidence only]');
      expect(old.reason).toContain('+superseded');
      const current = r.raw.search.hits.find((h: any) => h.text.includes('GLOBALNEW'));
      expect(current.text).not.toContain('Superseded');
    });
  });

  describe.each([
    ['scope:work', 'WORK'],
    ['project:launch', 'LAUNCH'],
  ])('a read in %s finds that scope\'s memory and no other', (scope, prefix) => {
    const note = prefix === 'WORK' ? ['WORKNOTE'] : [];

    it('get_context, search_memory and search_text return the scope\'s current event', async () => {
      const r = await reads(ws, scope);
      expect(r.contextFacts).toEqual([`${prefix}NEW`]);
      for (const [tool, found] of [['get_context', r.context], ['search_memory', r.search], ['search_text', r.text]] as const) {
        expect(found, tool).toEqual([`${prefix}NEW`, ...note].sort());
      }
    });

    it('include_history returns the scope\'s superseded event too, labelled, and nothing from another scope', async () => {
      const r = await reads(ws, scope, true);
      const expected = [`${prefix}NEW`, `${prefix}OLD`, ...note].sort();
      expect(r.context).toEqual(expected);
      expect(r.search).toEqual(expected);
      const old = r.raw.context.memories.find((m: any) => m.text.includes(`${prefix}OLD`));
      expect(old.text).toContain('[Superseded memory event; historical evidence only]');
      expect(old.reason).toContain('+superseded');
    });

    it('does not return the ledger\'s own header: that is global text, not this scope\'s memory', async () => {
      const r = await reads(ws, scope, true);
      for (const found of [r.raw.context.memories, r.raw.search.hits, r.raw.text.results]) {
        expect(JSON.stringify(found)).not.toContain('Append-only durable record');
      }
    });
  });

  it('a scope is normalized the way retrieve_memory normalizes it', async () => {
    const canonical = await reads(ws, 'scope:work');
    for (const scope of ['work', ' Scope:Work ', 'SCOPE:WORK']) {
      const r = await reads(ws, scope);
      expect([r.context, r.search, r.text], scope).toEqual([canonical.context, canonical.search, canonical.text]);
    }
    // A named scope is its slug: project:work reads what scope:work reads, events included, as it reads its notes.
    const other = await reads(ws, 'project:work');
    expect([other.context, other.search, other.text]).toEqual([canonical.context, canonical.search, canonical.text]);
    expect(other.context).toContain('WORKNEW');
  });

  it('without a scope every scope is read, as before, with closed events still hidden', async () => {
    const r = await reads(ws, undefined);
    const everyone = ['GLOBALNEW', 'GLOBALNOTE', 'LAUNCHNEW', 'WORKNEW', 'WORKNOTE'];
    expect(r.context).toEqual(everyone);
    expect(r.search).toEqual(everyone);
    expect(r.text).toEqual(everyone);
    const history = await reads(ws, undefined, true);
    expect(history.context).toEqual([...everyone, 'GLOBALOLD', 'LAUNCHOLD', 'WORKOLD'].sort());
  });

  it('retrieve_memory and the read tools agree about what a scope holds', async () => {
    for (const [scope, prefix] of [['scope:work', 'WORK'], ['project:launch', 'LAUNCH'], ['global', 'GLOBAL']] as const) {
      const structured = await ws.call('retrieve_memory', { subject: 'meeting', scope, include_history: true });
      expect(structured.facts.map((f: any) => f.object).sort(), scope).toEqual([`${prefix}NEW`, `${prefix}OLD`]);
      const r = await reads(ws, scope, true);
      expect(r.search.filter(t => /OLD|NEW/.test(t)), scope).toEqual([`${prefix}NEW`, `${prefix}OLD`]);
    }
  });

  // A heading that merely looks like an event id is not an event: the note keeps being judged by its path.
  it('a note in the scope is still found when a heading in it looks like an event id', async () => {
    const dir = path.join(ws.memoryDir, 'Memory', 'Scopes', 'work', 'Notes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\n\n## MEM_PLAN rollout\n\nmeeting rollout PLANTOKEN for the work scope.\n');
    await ws.index();
    const inScope = await ws.call('search_text', { query: 'PLANTOKEN', scope: 'scope:work' });
    expect(JSON.stringify(inScope.results)).toContain('PLANTOKEN');
    const semantic = await ws.call('search_memory', { query: 'meeting rollout PLANTOKEN', scope: 'scope:work' });
    expect(JSON.stringify(semantic.hits)).toContain('PLANTOKEN');
    const elsewhere = await ws.call('search_text', { query: 'PLANTOKEN', scope: 'global' });
    expect(JSON.stringify(elsewhere.results)).not.toContain('PLANTOKEN');
  });

  describe('evidence hydration reads the whole ledger note, so it is scoped too', () => {
    const extract = async (scope: string | undefined) => {
      const chat = vi.fn(async () => ({ content: '{"items":[{"item":"ok"}]}', latencyMs: 1 })) as any;
      const result = await engineSearchMemory(ws.service.db, ws.service.engine, ws.memoryDir, 'meeting time', 20, scope, {
        options: { mode: 'always', model: 'test', maxSessions: 12, charCap: 6000, chat },
        extractor: new EvidenceExtractor({ chat }),
      });
      expect(result.ok).toBe(true);
      expect(chat).toHaveBeenCalledTimes(1);
      return (chat.mock.calls[0] as any)[0].messages[0].content as string;
    };

    it('the extraction prompt of a global read holds no value saved in a named scope', async () => {
      const prompt = await extract('global');
      expect(tokens(prompt)).toEqual(['GLOBALNEW', 'GLOBALNOTE']);
    });

    it('the extraction prompt of a scoped read holds that scope\'s events and no other', async () => {
      expect(tokens(await extract('scope:work'))).toEqual(['WORKNEW', 'WORKNOTE']);
      expect(tokens(await extract('project:launch'))).toEqual(['LAUNCHNEW']);
    });

    it('without a scope the prompt covers every scope, with closed events removed as before', async () => {
      expect(tokens(await extract(undefined))).toEqual(['GLOBALNEW', 'GLOBALNOTE', 'LAUNCHNEW', 'WORKNEW', 'WORKNOTE']);
    });
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a correction made after the last index stays hidden as current, in every scope', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.save('scope:work', 'meeting', 'time', 'WORKOLD');
    await ws.save(undefined, 'meeting', 'time', 'GLOBALOLD');
    await ws.index();
    // Corrected after the index: the chunks still say OLD, only the lifecycle projection knows it is closed.
    await ws.saveWithoutIndexing('scope:work', 'meeting', 'time', 'WORKNEW');
    await ws.saveWithoutIndexing(undefined, 'meeting', 'time', 'GLOBALNEW');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  // Without this the cases below could pass for the wrong reason: if a write ever re-indexes, nothing is stale.
  it('the precondition holds: the chunk index is behind the ledger', async () => {
    // What the chunk index alone holds: search_text also returns the current facts it lacks (reason 'fact').
    const indexed = async (query: string) => (await ws.call('search_text', { query })).results.filter((r: any) => r.reason !== 'fact');
    expect(await indexed('WORKNEW')).toEqual([]);
    expect(await indexed('GLOBALNEW')).toEqual([]);
    expect((await ws.call('retrieve_memory', { subject: 'meeting', scope: 'scope:work' })).facts.map((f: any) => f.object)).toEqual(['WORKNEW']);
  });

  it('no scope returns a closed event as current; the other scope\'s old value never appears either', async () => {
    for (const scope of ['global', 'scope:work', undefined]) {
      const r = await reads(ws, scope);
      for (const found of [r.context, r.search, r.text]) {
        expect(found, String(scope)).not.toContain('WORKOLD');
        expect(found, String(scope)).not.toContain('GLOBALOLD');
      }
    }
    expect((await reads(ws, 'scope:work')).contextFacts).toEqual(['WORKNEW']);
    expect((await reads(ws, 'global')).contextFacts).toEqual(['GLOBALNEW']);
  });

  it('with include_history the old value shows only in its own scope, labelled', async () => {
    // The index still says only OLD, labelled as history; the current value is the fact the index lacks.
    const work = await reads(ws, 'scope:work', true);
    expect(work.search).toEqual(['WORKNEW', 'WORKOLD']);
    expect(JSON.stringify(work.raw.search.hits)).toContain('[Superseded memory event; historical evidence only]');
    const global = await reads(ws, 'global', true);
    expect(global.search).toEqual(['GLOBALNEW', 'GLOBALOLD']);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a ledger that lives somewhere else is judged by its events all the same', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace('Archive/ops/events.md');
    await ws.save('scope:work', 'meeting', 'time', 'WORKNEW');
    await ws.save(undefined, 'meeting', 'time', 'GLOBALNEW');
    await ws.index();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('reads find their own scope\'s event and no other', async () => {
    expect(fs.existsSync(path.join(ws.memoryDir, 'Archive', 'ops', 'events.md'))).toBe(true);
    const work = await reads(ws, 'scope:work');
    expect([work.context, work.search, work.text]).toEqual([['WORKNEW'], ['WORKNEW'], ['WORKNEW']]);
    const global = await reads(ws, 'global');
    expect([global.context, global.search, global.text]).toEqual([['GLOBALNEW'], ['GLOBALNEW'], ['GLOBALNEW']]);
  });
});

// `ledger.md` names the ledger note, so keyword search adds its opening chunk beside the prose hits. A ledger that
// starts at its first event (hand-edited or restored) opens with an event, and the ledger's path says nothing about
// which scope that event belongs to: the hit is judged by the event, in every direction, exactly as the same event is
// when it is found by its text.
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the opening chunk of a headerless ledger, added by note identity, is judged by its event\'s scope', () => {
  /** A workspace whose ledger starts at its first event: the header is cut off, as in a hand-edited or restored ledger. */
  async function headerlessLedger(events: Array<[scope: string | undefined, object: string]>) {
    const ws = await startWorkspace();
    for (const [scope, object] of events) await ws.save(scope, 'meeting', 'time', object);
    await ws.index();
    const ledger = path.join(ws.memoryDir, 'System', 'Memory Events Ledger.md');
    const raw = fs.readFileSync(ledger, 'utf8');
    fs.writeFileSync(ledger, raw.slice(raw.indexOf('## MEM_')));
    await ws.index();
    return ws;
  }
  const byIdentity = async (ws: Workspace, scope?: string) =>
    tokens((await ws.call('search_text', { query: 'ledger.md', ...(scope === undefined ? {} : { scope }) })).results);

  it('a ledger that opens with a scope:work event is found in that scope and without a scope, and hidden from every other', async () => {
    const ws = await headerlessLedger([['scope:work', 'WORKNEW'], [undefined, 'GLOBALNEW']]);
    try {
      expect(await byIdentity(ws)).toEqual(['WORKNEW']);
      expect(await byIdentity(ws, 'scope:work')).toEqual(['WORKNEW']);
      expect(await byIdentity(ws, ' Scope:Work ')).toEqual(['WORKNEW']); // normalized like every other scope
      expect(await byIdentity(ws, 'global')).toEqual([]);
      expect(await byIdentity(ws, 'project:launch')).toEqual([]);
    } finally { await ws.close(); }
  }, HOOK_TIMEOUT_MS);

  it('a ledger that opens with a global event is found in the global scope and without a scope, and hidden from a named one', async () => {
    const ws = await headerlessLedger([[undefined, 'GLOBALNEW'], ['scope:work', 'WORKNEW']]);
    try {
      expect(await byIdentity(ws)).toEqual(['GLOBALNEW']);
      expect(await byIdentity(ws, 'global')).toEqual(['GLOBALNEW']);
      expect(await byIdentity(ws, 'scope:work')).toEqual([]);
    } finally { await ws.close(); }
  }, HOOK_TIMEOUT_MS);

  it('an opening event that was corrected is live in no scope, found by identity or not', async () => {
    const ws = await headerlessLedger([['scope:work', 'WORKOLD'], ['scope:work', 'WORKNEW']]);
    try {
      for (const scope of [undefined, 'scope:work', 'global']) expect(await byIdentity(ws, scope), String(scope)).toEqual([]);
    } finally { await ws.close(); }
  }, HOOK_TIMEOUT_MS);
});

// `Rowan` and first-person queries add the subject's current facts as hits, from the lifecycle store rather than
// from a note. The store has no path to judge them by, so each fact is judged by the scope it was saved in.
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('facts returned as hits for a first-person query are judged by their own scope', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.save('scope:work', 'Rowan', 'current_project', 'WORKPROJ');
    await ws.save('scope:work', 'Rowan', 'location', 'WORKLOC');
    await ws.save(undefined, 'Rowan', 'current_project', 'GLOBALPROJ');
    await ws.index();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  const ask = async (scope: string | undefined) => {
    const args = { query: 'what is my current project and location?', ...(scope === undefined ? {} : { scope }) };
    const context = await ws.call('get_context', { ...args, max_tokens: 4000 });
    const search = await ws.call('search_memory', args);
    return { context: tokens(context.memories), search: tokens(search.hits), facts: tokens(context.facts) };
  };

  it('a global read does not present a named scope\'s fact as global', async () => {
    expect(await ask('global')).toEqual({ context: ['GLOBALPROJ'], search: ['GLOBALPROJ'], facts: ['GLOBALPROJ'] });
  });

  it('a scoped read finds its own facts', async () => {
    expect(await ask('scope:work')).toEqual({ context: ['WORKLOC', 'WORKPROJ'], search: ['WORKLOC', 'WORKPROJ'], facts: ['WORKLOC', 'WORKPROJ'] });
  });

  it('a read without a scope sees every scope\'s facts', async () => {
    const all = ['GLOBALPROJ', 'WORKLOC', 'WORKPROJ'];
    expect(await ask(undefined)).toEqual({ context: all, search: all, facts: all });
  });
});
