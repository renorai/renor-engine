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
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { KEY_SHAPES, Rng, password } from '../../scripts/eval/secret-guard/plantedSet';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * RENOR_SECRET_GUARD through the real MCP tools (`remember` in both modes, `save_memory`, `remember_note`) over the
 * authenticated Streamable HTTP endpoint. One service, one memory directory, the guard switched by the process
 * environment between calls: with it on, a secret reaches nothing on disk and the caller is told why; with it off,
 * the same calls store it. Synthetic data only: planted secrets built from a seed, loopback, hash embeddings.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const HOOK_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_SECRET_GUARD',
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
  delete process.env.MVP_LEDGER_REL;
  process.env.RENOR_SEARCH_EVIDENCE = '0';
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'secret-guard', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

type Result = { isError: true; text: string } | { isError?: false; [k: string]: unknown };

async function startWorkspace() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-secret-guard-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  const config = makeConfig(memoryDir, authRoot, await freePort());
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'secret-guard', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  /** One tool call. Calls are sequential: the stateless MCP server is shared. */
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0].text;
    return res.isError ? { isError: true, text } : JSON.parse(text);
  };
  return {
    memoryDir, call,
    ledgerFile: path.join(memoryDir, DEFAULT_LEDGER_REL),
    /** Everything that is stored, as one string, to look for a secret in. */
    storedText(): string {
      const parts: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) { if (e.name !== '.memory-index') walk(full); }
          else parts.push(fs.readFileSync(full, 'utf8'));
        }
      };
      walk(memoryDir);
      return parts.join('\n');
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

const refusal = (res: Result): string => {
  expect(res.isError, JSON.stringify(res)).toBe(true);
  return (res as { text: string }).text;
};
/** Enough of a secret, from its random end, to find it in anything that was said back or stored. */
const tail = (secret: string) => secret.slice(-14);

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('RENOR_SECRET_GUARD through the MCP tools', () => {
  let ws: Awaited<ReturnType<typeof startWorkspace>>;
  const r = new Rng(20261003);
  const key = KEY_SHAPES.openai_proj(r);
  const token = KEY_SHAPES.github(r);
  const wifi = password(r);
  const stripe = KEY_SHAPES.stripe(r);

  beforeAll(async () => { ws = await startWorkspace(); }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws.close(); }, HOOK_TIMEOUT_MS);

  it('with the guard on: refuses a secret in every write tool, says why without saying it, and stores nothing', async () => {
    process.env.RENOR_SECRET_GUARD = '1';
    const refusals = [
      refusal(await ws.call('remember', { statement: `the staging key is ${key}, keep it somewhere safe` })), // note mode
      refusal(await ws.call('remember', { statement: `my live Stripe key is ${stripe}`, subject: 'Rowan', predicate: 'uses', object: 'Stripe' })), // fact mode, in the words
      refusal(await ws.call('save_memory', { subject: 'github', predicate: 'access', object: token })), // in the value
      refusal(await ws.call('save_memory', { subject: 'home wifi', predicate: 'password', object: wifi })), // cue in the predicate
      refusal(await ws.call('remember_note', { text: 'Charge the renewal to card 4242 4242 4242 4242, exp 08/29.' })), // personal identifier
      refusal(await ws.call('remember_note', { text: `deploy token ${token}`, scope: 'project:renor' })), // scoped note
    ];
    for (const text of refusals) {
      expect(text).toMatch(/^Error: Nothing was saved: the .+ appears to contain a (credential|personal identifier)/);
      expect(text).toContain('Save what it is for instead');
      expect(text.length).toBeLessThan(410); // "Error: " plus the 400 characters an MCP error reply keeps
      for (const secret of [key, token, wifi, stripe, '4242 4242 4242 4242']) expect(text).not.toContain(tail(secret));
    }
    // each refusal names the field the guard looked at: the note writer knows only "note text", the fact ledger knows more
    expect(refusals[0]).toContain('the note text');
    expect(refusals[1]).toContain('the statement');
    expect(refusals[2]).toContain('the subject, predicate and object');
    expect(refusals[3]).toContain('the subject, predicate and object');
    expect(refusals[4]).toContain('personal identifier');
    // nothing reached the disk: no daily note, no scoped note, no ledger
    expect(fs.existsSync(path.join(ws.memoryDir, 'Memory'))).toBe(false);
    expect(fs.existsSync(ws.ledgerFile)).toBe(false);
    expect(ws.storedText()).toBe('');
  }, HOOK_TIMEOUT_MS);

  it('with the guard on: an ordinary save still works in every tool and is stored as said', async () => {
    process.env.RENOR_SECRET_GUARD = '1';
    const note = await ws.call('remember', { statement: 'I moved to Lisbon in March and I work near the river.' });
    expect(note).toMatchObject({ ok: true, mode: 'note' });
    const fact = await ws.call('remember', { statement: 'I work at Memory Company now.', subject: 'Rowan', predicate: 'works_at', object: 'Memory Company' });
    expect(fact).toMatchObject({ ok: true, mode: 'fact', action: 'store' });
    expect(await ws.call('save_memory', { subject: 'Rowan', predicate: 'lives_in', object: 'Lisbon' })).toMatchObject({ ok: true, action: 'store' });
    expect(await ws.call('remember_note', { text: 'The team standup is at 9:30.' })).toMatchObject({ ok: true });
    const stored = ws.storedText();
    for (const said of ['I moved to Lisbon in March', 'I work at Memory Company now.', 'The team standup is at 9:30.']) expect(stored).toContain(said);
    const context = await ws.call('get_context', { query: 'where does Rowan live and work?' });
    expect(JSON.stringify(context)).toContain('Memory Company');
    // and still no secret anywhere
    for (const secret of [key, token, wifi, stripe]) expect(stored).not.toContain(tail(secret));
  }, HOOK_TIMEOUT_MS);

  it('with the guard on: a refused save leaves the memory as it was, and a fact it would have replaced stays', async () => {
    process.env.RENOR_SECRET_GUARD = '1';
    const before = ws.storedText();
    refusal(await ws.call('save_memory', { subject: 'Rowan', predicate: 'lives_in', object: `password: ${wifi}` }));
    expect(ws.storedText()).toBe(before);
    expect(await ws.call('retrieve_memory', { subject: 'Rowan', predicate: 'lives_in' })).toMatchObject({ facts: [{ object: 'Lisbon', current: true }] });
  }, HOOK_TIMEOUT_MS);

  it('with the guard off: the same calls succeed, and the secrets are stored, which is what the guard was stopping', async () => {
    process.env.RENOR_SECRET_GUARD = '0';
    expect(await ws.call('remember', { statement: `the staging key is ${key}, keep it somewhere safe` })).toMatchObject({ ok: true, mode: 'note' });
    expect(await ws.call('remember', { statement: `my live Stripe key is ${stripe}`, subject: 'Rowan', predicate: 'uses', object: 'Stripe' })).toMatchObject({ ok: true, mode: 'fact' });
    expect(await ws.call('save_memory', { subject: 'github', predicate: 'access', object: token })).toMatchObject({ ok: true, action: 'store' });
    expect(await ws.call('save_memory', { subject: 'home wifi', predicate: 'password', object: wifi })).toMatchObject({ ok: true, action: 'store' });
    expect(await ws.call('remember_note', { text: 'Charge the renewal to card 4242 4242 4242 4242, exp 08/29.' })).toMatchObject({ ok: true });
    expect(await ws.call('remember_note', { text: `deploy token ${token}`, scope: 'project:renor' })).toMatchObject({ ok: true });
    const stored = ws.storedText();
    for (const secret of [key, token, wifi, stripe]) expect(stored).toContain(tail(secret));
    expect(stored).toContain('4242 4242 4242 4242');
  }, HOOK_TIMEOUT_MS);

  it('with the guard on again: retire_memory and restore_memory refuse what was stored before it, and change nothing', async () => {
    process.env.RENOR_SECRET_GUARD = '0';
    const map = await ws.call('memory_map') as { memories: Array<{ id: string; kind: string; title: string; excerpt: string }> };
    const flagged = map.memories.find(m => m.kind === 'entry' && /staging key/.test(m.title + m.excerpt))!;
    expect(flagged, 'the entry saved while the guard was off').toBeDefined();

    process.env.RENOR_SECRET_GUARD = '1';
    const stored = ws.storedText();
    const noRetire = refusal(await ws.call('retire_memory', { id: flagged.id }));
    expect(noRetire).toMatch(/^Error: Nothing was changed: the memory appears to contain a credential .*was not retired/);
    expect(noRetire.length).toBeLessThan(410);
    expect(ws.storedText()).toBe(stored); // not journaled, not removed from its daily file

    process.env.RENOR_SECRET_GUARD = '0';
    expect(await ws.call('retire_memory', { id: flagged.id })).toMatchObject({ ok: true, action: 'retired' });
    process.env.RENOR_SECRET_GUARD = '1';
    const retired = ws.storedText();
    const noRestore = refusal(await ws.call('restore_memory', { id: flagged.id }));
    expect(noRestore).toMatch(/^Error: Nothing was changed: the memory appears to contain a credential .*was not restored/);
    expect(ws.storedText()).toBe(retired); // still in the retired store, still out of the live daily file

    process.env.RENOR_SECRET_GUARD = '0';
    expect(await ws.call('restore_memory', { id: flagged.id })).toMatchObject({ ok: true, action: 'restored' });
    for (const text of [noRetire, noRestore]) for (const secret of [key]) expect(text).not.toContain(tail(secret));
  }, HOOK_TIMEOUT_MS);
});
