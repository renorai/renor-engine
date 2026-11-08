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
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * retrieve_memory contract, driven through the real MCP tool over the authenticated
 * Streamable HTTP endpoint. Synthetic data only (mkdtemp memory dirs, loopback, no embedding provider).
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const HOOK_TIMEOUT_MS = 30_000;

// Everything the workspaces below set or clear, restored afterwards so no embedding provider (or
// anything else from the developer's shell) leaks in and no setting leaks out.
const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
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
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'retrieve-contract', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

/** A fresh authenticated service on its own memory dir, with the helpers the tests below need. */
async function startWorkspace() {
  const dirs = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-retrieve-contract-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-')),
  ];
  const port = await freePort();
  const config = makeConfig(dirs[0], dirs[1], port);
  const started = await startMvpService(config);
  const token = await authorize(started.app);
  const client = new Client({ name: 'retrieve-contract', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  return {
    client,
    async save(subject: string, predicate: string, object: string, scope?: string) {
      const res = await client.callTool({ name: 'save_memory', arguments: { subject, predicate, object, ...(scope ? { scope } : {}) } });
      expect(res.isError).not.toBe(true);
    },
    /** The tool result as an agent sees it. A protocol-level rejection is not a result: it throws, failing the test. */
    async retrieve(args: Record<string, unknown>) {
      const res = await client.callTool({ name: 'retrieve_memory', arguments: args });
      const text = (res.content as any)[0].text as string;
      return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
    },
    async close() {
      await client.close();
      await new Promise<void>(resolve => started.httpServer.close(() => resolve()));
      started.db?.close?.();
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Workspace = Awaited<ReturnType<typeof startWorkspace>>;

// The secret guard is on by default. These tests store fixture text that the guard refuses (a credential-shaped or an
// identifier-shaped sentence that is incidental to what each test checks), so they run with it explicitly off.
const SAVED_GUARD = process.env.RENOR_SECRET_GUARD;
beforeAll(() => { process.env.RENOR_SECRET_GUARD = '0'; });
afterAll(() => { if (SAVED_GUARD === undefined) delete process.env.RENOR_SECRET_GUARD; else process.env.RENOR_SECRET_GUARD = SAVED_GUARD; });

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('retrieve_memory contract: a new user with nothing saved yet', () => {
  let ws: Workspace;
  beforeAll(async () => { ws = await startWorkspace(); }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a missing subject says so and that nothing is stored', async () => {
    const res = await ws.retrieve({});
    expect(res.isError).toBe(true);
    expect(res.text).toContain('"subject"');
    expect(res.text).toContain('No subjects are stored yet');
  });

  it('an unknown subject is unknown, with nothing to suggest', async () => {
    const res = await ws.retrieve({ subject: 'anything' });
    expect(res.body).toEqual({ subject: 'anything', facts: [], known: false, closestSubjects: [] });
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('retrieve_memory contract', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.save('Quartz Project', 'status', 'draft');
    await ws.save('Quartz Project', 'status', 'shipped'); // supersedes draft
    await ws.save('Quartz Project', 'owner', 'Ana');
    await ws.save('Aurora Project', 'status', 'active');
    await ws.save('Borealis Project', 'status', 'paused', 'project:borealis'); // exists only in its own scope
    await ws.save('Silo Secret Project', 'status', 'beta-only-value', 'scope:beta'); // exists only in scope:beta
    await ws.save('Alpha Project', 'status', 'active', 'scope:alpha'); // exists only in scope:alpha
    await ws.save('me', 'drinks', 'tea'); // a very short, very common subject
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  describe('a missing subject (finding 10)', () => {
    it.each([
      ['no arguments', {}],
      ['a predicate only', { predicate: 'status' }],
      ['an empty subject', { subject: '' }],
      ['a blank subject', { subject: '   ' }],
      ['a null subject', { subject: null }],
      ['every argument null, as a client sends the ones it leaves out', { subject: null, predicate: null, include_history: null, as_of: null, scope: null }],
    ])('%s: an actionable tool error that names the argument and lists the known subjects, not a protocol error', async (_label, args) => {
      const res = await ws.retrieve(args);
      expect(res.isError).toBe(true);
      expect(res.text).toContain('"subject"');
      expect(res.text).not.toMatch(/Invalid arguments|-32602|invalid_type/i);
      for (const known of ['Quartz Project', 'Aurora Project', 'Borealis Project', 'me']) expect(res.text).toContain(JSON.stringify(known));
    });

    it('a null argument is a left-out one: the answer is the one an agent gets by omitting it', async () => {
      const omitted = await ws.retrieve({ subject: 'Quartz Project' });
      expect(omitted.body.facts.length).toBe(2);
      const nulls = { predicate: null, include_history: null, as_of: null, scope: null };
      const all = await ws.retrieve({ subject: 'Quartz Project', ...nulls });
      expect(all.text).not.toMatch(/Invalid arguments|-32602|invalid_type/i);
      expect(all.body).toEqual(omitted.body);
      for (const key of Object.keys(nulls)) {
        const one = await ws.retrieve({ subject: 'Quartz Project', [key]: null });
        expect(one.body, key).toEqual(omitted.body);
      }
    });

    it('only null is let through: the listed schema still says string or boolean, and a wrong type is still refused', async () => {
      const tool = (await ws.client.listTools()).tools.find(t => t.name === 'retrieve_memory')!;
      const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, schema.type]))).toEqual({
        subject: 'string', predicate: 'string', include_history: 'boolean', as_of: 'string', scope: 'string',
      });
      // subject alone is bounded (200 characters, the same bound a name gets), so its schema also names a maxLength.
      for (const [name, schema] of Object.entries(properties)) {
        expect(Object.keys(schema).sort()).toEqual(name === 'subject' ? ['description', 'maxLength', 'type'] : ['description', 'type']);
      }
      expect(tool.inputSchema.required).toBeUndefined();
      for (const args of [{ subject: 42 }, { subject: 'Quartz Project', include_history: 'yes' }]) {
        const res = await ws.retrieve(args);
        expect(res.isError, JSON.stringify(args)).toBe(true);
        expect(res.text, JSON.stringify(args)).toMatch(/-32602/);
      }
    });

    it('the tool description tells an agent that subject is required, and what the empty result and each fact mean', async () => {
      const tool = (await ws.client.listTools()).tools.find(t => t.name === 'retrieve_memory')!;
      expect((tool.inputSchema.properties as any).subject.description).toMatch(/^Required/);
      for (const term of ['current', 'known', 'closestSubjects']) expect(tool.description).toContain(term);
    });
  });

  describe('unknown subject versus a known subject with no facts (finding 9)', () => {
    it('a typo is unknown and offers the subject it was close to', async () => {
      const res = await ws.retrieve({ subject: 'Quartz Projct' });
      expect(res.body.facts).toEqual([]);
      expect(res.body.known).toBe(false);
      expect(res.body.closestSubjects[0]).toBe('Quartz Project');
    });

    it('a subject that exists but whose predicate or as_of filter matches nothing is known, with nothing to suggest', async () => {
      for (const args of [
        { subject: 'Quartz Project', predicate: 'no_such_predicate' },
        { subject: 'Borealis Project', scope: 'project:borealis', predicate: 'no_such_predicate' },
        { subject: 'Aurora Project', as_of: '2000-01-01T00:00:00Z' },
      ]) {
        const res = await ws.retrieve(args);
        expect(res.body, JSON.stringify(args)).toEqual({ subject: args.subject, facts: [], known: true });
      }
    });

    it('a paraphrase that shares nothing with any subject is unknown with no suggestions', async () => {
      for (const subject of ['my package manager choice', 'zzzzzzzz']) {
        const res = await ws.retrieve({ subject });
        expect(res.body).toEqual({ subject, facts: [], known: false, closestSubjects: [] });
      }
    });

    it('a sentence that names a subject suggests that subject first, then subjects that only share a word with it', async () => {
      const res = await ws.retrieve({ subject: 'what is the Quartz Project status?' });
      expect(res.body.known).toBe(false);
      expect(res.body.closestSubjects[0]).toBe('Quartz Project');
      expect(res.body.closestSubjects.length).toBeGreaterThan(1);
      for (const other of res.body.closestSubjects.slice(1)) expect(other).toMatch(/ Project$/); // they share a word, nothing else
    });

    it('a very short subject is not suggested just because its letters occur in the query', async () => {
      const res = await ws.retrieve({ subject: 'zzz team memory' }); // contains "me"
      expect(res.body.closestSubjects).toEqual([]);
    });

    it('an oversized subject is refused with what to pass instead, not echoed back or looked up', async () => {
      const res = await ws.retrieve({ subject: 'x'.repeat(200_000) });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('subject is longer than 512 characters');
      expect(res.text.length).toBeLessThan(4096);
    });

    it.each([300, 512])('a fact saved under a %i-character subject reads back by that exact subject', async (length) => {
      const subject = `Subject ${'s'.repeat(length - 8)}`;
      expect(subject.length).toBe(length);
      await ws.save(subject, 'status', 'active');
      const res = await ws.retrieve({ subject });
      expect(res.isError).toBe(false);
      expect(res.body.facts.map((f: { object: string }) => f.object)).toEqual(['active']);
    });

    it('a result that has facts is the facts alone: nothing about known or closest subjects', async () => {
      const res = await ws.retrieve({ subject: 'Quartz Project' });
      expect(Object.keys(res.body).sort()).toEqual(['facts', 'subject']);
      expect(res.body.facts.map((f: any) => `${f.predicate}=${f.object}`).sort()).toEqual(['owner=Ana', 'status=shipped']);
    });
  });

  // A scoped call is judged entirely within its scope: it must not learn that a subject exists, or what it is
  // called, from a scope it did not ask about. Silo Secret Project lives only in scope:beta; Alpha Project only in
  // scope:alpha. Without a scope every scope is in play, as before.
  describe('scope isolation', () => {
    const SECRET = 'Silo Secret Project';
    const outsideAlpha = ['Silo Secret Project', 'Quartz Project', 'Aurora Project', 'Borealis Project', 'me'];

    it('suggestions for a scoped typo come only from that scope', async () => {
      const res = await ws.retrieve({ subject: 'Silo Secre Project', scope: 'scope:alpha' });
      expect(res.body).toEqual({ subject: 'Silo Secre Project', facts: [], known: false, closestSubjects: ['Alpha Project'] });
    });

    it('the subject list of a scoped missing-subject error holds only that scope\'s subjects', async () => {
      const res = await ws.retrieve({ scope: 'scope:alpha' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('"subject"');
      expect(res.text).toContain('Known subjects in scope "scope:alpha": "Alpha Project".');
      for (const name of outsideAlpha) expect(res.text).not.toContain(JSON.stringify(name));
    });

    it('asking for a subject by its exact name from another scope does not reveal that it exists', async () => {
      const res = await ws.retrieve({ subject: SECRET, scope: 'scope:alpha' });
      expect(res.body.facts).toEqual([]);
      expect(res.body.known).toBe(false);
      expect(res.body.closestSubjects).not.toContain(SECRET);
      // The same holds for the global scope (an empty scope means global, as it does for facts).
      for (const scope of ['global', '']) {
        const inGlobal = await ws.retrieve({ subject: SECRET, scope });
        expect(inGlobal.body.known, JSON.stringify(scope)).toBe(false);
        expect(inGlobal.body.closestSubjects, JSON.stringify(scope)).not.toContain(SECRET);
      }
    });

    it('a scope with no subjects says so, and says nothing about the others', async () => {
      const list = await ws.retrieve({ scope: 'scope:nothing-here' });
      expect(list.isError).toBe(true);
      expect(list.text).toContain('No subjects are stored in scope "scope:nothing-here" yet.');
      for (const name of outsideAlpha) expect(list.text).not.toContain(JSON.stringify(name));
      const one = await ws.retrieve({ subject: 'Quartz Project', scope: 'scope:nothing-here' });
      expect(one.body).toEqual({ subject: 'Quartz Project', facts: [], known: false, closestSubjects: [] });
    });

    it('inside the right scope everything still works, and the scope is normalized like it is for facts', async () => {
      for (const scope of ['scope:beta', 'BETA', ' Scope:Beta ']) {
        const hit = await ws.retrieve({ subject: SECRET, scope });
        expect(hit.body.facts.map((f: any) => f.object), scope).toEqual(['beta-only-value']);
        const empty = await ws.retrieve({ subject: SECRET, scope, predicate: 'no_such_predicate' });
        expect(empty.body, scope).toEqual({ subject: SECRET, facts: [], known: true });
        const typo = await ws.retrieve({ subject: 'Silo Secre Project', scope });
        expect(typo.body.closestSubjects, scope).toEqual([SECRET]);
        const list = await ws.retrieve({ scope });
        expect(list.text, scope).toContain('Known subjects in scope "scope:beta": "Silo Secret Project".');
      }
    });

    it('without a scope every scope is still searched, listed and suggested from', async () => {
      const exact = await ws.retrieve({ subject: SECRET, predicate: 'no_such_predicate' });
      expect(exact.body).toEqual({ subject: SECRET, facts: [], known: true });
      const typo = await ws.retrieve({ subject: 'Silo Secre Project' });
      expect(typo.body.closestSubjects[0]).toBe(SECRET);
      const list = await ws.retrieve({});
      expect(list.text).toContain('Known subjects: ');
      for (const name of [...outsideAlpha, 'Alpha Project']) expect(list.text).toContain(JSON.stringify(name));
    });

    it('an invalid scope is reported as such, not as a missing or unknown subject', async () => {
      const res = await ws.retrieve({ subject: SECRET, scope: '!!!' }); // normalizes to an empty slug
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/invalid scope/i);
    });
  });

  describe('current (finding 11)', () => {
    it('include_history keeps current:true on the live value and marks only superseded values current:false', async () => {
      const res = await ws.retrieve({ subject: 'Quartz Project', predicate: 'status', include_history: true });
      const byObject = Object.fromEntries(res.body.facts.map((f: any) => [f.object, f]));
      expect(byObject.shipped.current).toBe(true);
      expect(byObject.shipped.validTo).toBeNull();
      expect(byObject.draft.current).toBe(false);
      expect(byObject.draft.validTo).not.toBeNull();
    });

    it('the default view says current:true on every fact, and no view carries a whole-payload current flag', async () => {
      const now = await ws.retrieve({ subject: 'Quartz Project' });
      expect(now.body.facts.every((f: any) => f.current === true)).toBe(true);
      for (const args of [{ subject: 'Quartz Project' }, { subject: 'Quartz Project', include_history: true }, { subject: 'Quartz Project', as_of: '2000-01-01T00:00:00Z' }]) {
        expect((await ws.retrieve(args)).body, JSON.stringify(args)).not.toHaveProperty('current');
      }
    });
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('retrieve_memory contract: more subjects than fit in one error', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    for (let i = 1; i <= 22; i++) await ws.save(`Crowd ${String(i).padStart(2, '0')}`, 'status', 'active');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a missing subject lists the first 20 alphabetically and says how many more there are and where to find them', async () => {
    const res = await ws.retrieve({});
    expect(res.isError).toBe(true);
    expect(res.text).toContain('"Crowd 01"');
    expect(res.text).toContain('"Crowd 20"');
    expect(res.text).not.toContain('"Crowd 21"');
    expect(res.text).toContain('+2 more');
    expect(res.text).toContain('memory_map');
  });
});
