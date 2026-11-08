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
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * lookup_entity in a scope, for the subjects of remembered facts (dogfood 2026-10-03, finding D5). Such a subject is a
 * lifecycle entity whose source note is the reserved name `_mcp_`, not a path; judged as a path it read as global, so a
 * global lookup confirmed a subject saved only in a named scope, and that scope's own lookup could not find it. It is
 * judged by the scopes its facts were saved in, as retrieve_memory judges it. Both ways a lookup discloses what a scope
 * holds are pinned: whether an entity is returned (existence), and how many entities the miss says the scope has
 * (count). Driven through the real MCP tools; synthetic data only (mkdtemp memory dirs, loopback, eval-hash embeddings).
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
    .send({ client_name: 'lookup-entity-scope', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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
async function startWorkspace() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-lookup-scope-'));
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
  // One entity a note owns, in each kind of place: a named scope's folder and the global vault.
  fs.mkdirSync(path.join(memoryDir, 'Memory', 'Scopes', 'atlas', 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'Memory', 'Scopes', 'atlas', 'Notes', 'Acme.md'), '# Acme\n\nAcme is the atlas vendor.\n');
  fs.mkdirSync(path.join(memoryDir, 'People'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'People', 'Ada.md'), '# Ada\n\nAda runs the nightly backups.\n');
  const config = loadMvpConfig();
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'lookup-entity-scope', version: '0.1.0' });
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
    /** One fact in one scope, through the agent's write tool; `scope` omitted means global. */
    async remember(scope: string | undefined, subject: string, predicate: string, object: string) {
      const receipt = await call('remember', { statement: `${subject} ${predicate} is ${object}`, subject, predicate, object, ...(scope ? { scope } : {}) });
      expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
    },
    lookup: (name: string, scope?: string) => call('lookup_entity', { name, ...(scope === undefined ? {} : { scope }) }),
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

const ATLAS_ONLY = 'zephyr-migration task';
const GLOBAL_ONLY = 'nightly backup job';
const BOTH = 'release train';
const UNKNOWN = 'nothing-is-called-this';
/** Scopes that hold none of the atlas-only subject's facts. */
const ELSEWHERE = ['global', 'project:kestrel', 'scope:kestrel'];

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('lookup_entity judges the subject of remembered facts by the scope its facts were saved in (D5)', () => {
  let ws: Workspace;
  /** entitiesIndexed per scope before any fact was saved: the note entities only. */
  const before = new Map<string, number>();

  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.call('index_memory');
    for (const scope of ['project:atlas', ...ELSEWHERE]) before.set(scope, (await ws.lookup(UNKNOWN, scope)).entitiesIndexed);
    await ws.remember('project:atlas', ATLAS_ONLY, 'outcome', 'shipped');
    await ws.remember('project:atlas', ATLAS_ONLY, 'outcome', 'rolled back'); // a correction: the subject still has one entity
    await ws.remember(undefined, GLOBAL_ONLY, 'schedule', 'every night at 02:00');
    await ws.remember('project:atlas', BOTH, 'cadence', 'weekly');
    await ws.remember(undefined, BOTH, 'cadence', 'monthly');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('existence: no scope that holds none of a subject\'s facts can tell it from a name that exists nowhere', async () => {
    // retrieve_memory's view of the same subject, which lookup_entity must agree with.
    expect((await ws.call('retrieve_memory', { subject: ATLAS_ONLY, scope: 'global' })).known).toBe(false);
    for (const scope of ELSEWHERE) {
      const unknown = await ws.lookup(UNKNOWN, scope);
      // The whole name, another case of it, and a substring of it (the third of the lookup's four mechanisms).
      for (const name of [ATLAS_ONLY, 'ZEPHYR-MIGRATION TASK', 'zephyr']) {
        const miss = await ws.lookup(name, scope);
        expect(miss.entity, `${name} in ${scope}`).toBeNull();
        // Byte for byte the answer for a name that exists nowhere, apart from the name the caller supplied.
        expect(JSON.stringify(miss).split(name).join(UNKNOWN), `${name} in ${scope}`).toBe(JSON.stringify(unknown));
      }
    }
    expect((await ws.lookup(GLOBAL_ONLY, 'project:atlas')).entity).toBeNull();
    expect((await ws.lookup(BOTH, 'project:kestrel')).entity).toBeNull();
  });

  it('existence: the scope a subject\'s facts were saved in finds it', async () => {
    expect((await ws.call('retrieve_memory', { subject: ATLAS_ONLY, scope: 'project:atlas' })).facts.length).toBe(1);
    expect(await ws.lookup(ATLAS_ONLY, 'project:atlas')).toEqual({
      ok: true,
      entity: { canonicalName: ATLAS_ONLY, type: 'concept', aliases: [], sourceNote: '_mcp_' },
      scope: 'project:atlas',
    });
    expect((await ws.lookup('zephyr', 'project:atlas')).entity?.canonicalName).toBe(ATLAS_ONLY);
    // A subject saved in global is found there, and one saved in two scopes in both.
    expect((await ws.lookup(GLOBAL_ONLY, 'global')).entity?.canonicalName).toBe(GLOBAL_ONLY);
    for (const scope of ['global', 'project:atlas']) expect((await ws.lookup(BOTH, scope)).entity?.canonicalName, scope).toBe(BOTH);
    // Without a scope every scope is read, as before.
    expect((await ws.lookup(ATLAS_ONLY)).entity?.canonicalName).toBe(ATLAS_ONLY);
  });

  it('existence: a note\'s entity is still judged by its note\'s path', async () => {
    expect((await ws.lookup('Acme', 'project:atlas')).entity?.sourceNote).toBe('Memory/Scopes/atlas/Notes/Acme.md');
    expect((await ws.lookup('Acme', 'global')).entity).toBeNull();
    expect((await ws.lookup('Ada', 'global')).entity?.sourceNote).toBe('People/Ada.md');
    expect((await ws.lookup('Ada', 'project:atlas')).entity).toBeNull();
  });

  it('count: a scope counts the subjects saved in it, and a scope that holds none of them counts what it counted before', async () => {
    const after = async (scope: string) => (await ws.lookup(UNKNOWN, scope)).entitiesIndexed;
    // global gains the global subject and the two-scope one, never the atlas-only one.
    expect(await after('global')).toBe(before.get('global')! + 2);
    for (const scope of ['project:kestrel', 'scope:kestrel']) expect(await after(scope), scope).toBe(before.get(scope));
    // atlas-only and the two-scope subject join the atlas note's entity.
    expect(await after('project:atlas')).toBe(before.get('project:atlas')! + 2);
    // The same count memory_status reports when no scope is named: every entity.
    expect((await ws.lookup(UNKNOWN)).entitiesIndexed).toBe((await ws.call('memory_status')).entities);
  });
});
