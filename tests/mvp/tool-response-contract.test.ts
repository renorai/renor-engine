import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import http from 'http';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { OLLAMA_KEY_ENV_NAMES } from '../../src/evidence/keyPool';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import type { Express } from 'express';

/**
 * The shape an agent actually reads, over the REAL remote MCP surface.
 *
 * Three findings from the new-user scout (renor-newuser-scout-memory-1002):
 *   15 — every search_memory carried `evidence: {skipped, extractor-unavailable}`,
 *         which reads like a broken deployment and cannot be told apart from a
 *         deliberate kill switch. A deployment with no evidence model now
 *         carries no evidence object at all: the note that nothing was missing
 *         was on every hosted search and told the agent nothing.
 *   17 — memory_map / read_memory / retire_memory / restore_memory answered in
 *         compact one-line JSON while every other tool indented, so the
 *         formatting an agent may assume depended on which tool replied.
 *         Since the first-week scout (F4), the one shape is compact: indented
 *         JSON cost about a fifth more tokens on every call.
 *   18 — lookup_entity returned a bare `entity: null` for a word that lives in
 *         saved note text, next to a memory_status entity count that said
 *         otherwise.
 *
 * No embeddings API and no network: the deterministic stub provider stands in
 * for eval-hash, and evidence keys are cleared so "no evidence model
 * configured" is a property of the test rather than of the machine.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const EVIDENCE_KEY_ENV = ['RENOR_EVIDENCE_API_KEY', 'RENOR_EVIDENCE_API_KEYS', ...OLLAMA_KEY_ENV_NAMES];
const tmpDirs: string[] = [];
const services: Array<MvpApp & { httpServer: import('http').Server }> = [];
const CLEARED_ENV = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL',
  'MVP_OWNER_PASSWORD', 'MVP_PORT', 'MVP_ALLOWED_CALLBACK_URIS',
  'MVP_EMBEDDING_PROVIDER', 'MVP_EMBEDDING_DIMS', 'EMBEDDING_PROVIDER',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_EVIDENCE_MODE', 'RENOR_EVIDENCE_MODEL',
  'RENOR_EVIDENCE_CACHE', 'RENOR_EVIDENCE_BASE_URL', 'RENOR_EVIDENCE_SESSIONS',
  ...EVIDENCE_KEY_ENV,
];

const savedEnv: Record<string, string | undefined> = {};

// Evidence keys are read by NAME from process.env, so a machine that has them
// exported would make "unavailable" depend on the host. Snapshot, then clear.
beforeEach(() => {
  for (const name of CLEARED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
    await s.close();
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
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

async function makeConfig(memoryDir: string, port: number): Promise<MvpConfig> {
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  tmpDirs.push(authRoot);
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  // This fixture models a connection named by the private gateway.
  return { ...loadMvpConfig(), gatewaySecret: 'synthetic-gateway-secret' };
}

/** Deterministic 8-d stub in place of eval-hash: no model, no download, no API. */
function stubProvider(dims: number): EmbeddingProvider {
  return {
    dimensions: dims,
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v = new Array(dims).fill(0.1);
        v[0] = t.toLowerCase().includes('mango') ? 1 : 0.1;
        return v;
      });
    },
  };
}

async function registerAndToken(app: Express): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'contract-test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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
  return tokens.body.access_token as string;
}

async function connect(config: MvpConfig, token: string): Promise<Client> {
  const client = new Client({ name: 'contract-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    // A named connection, as the gateway would send it: an unnamed one cannot answer or close a request.
    { requestInit: { headers: { Authorization: `Bearer ${token}`, 'x-renor-agent': 'contract' } } },
  ));
  return client;
}

interface Call { isError: boolean; raw: string; body: any }

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Call> {
  const res = await client.callTool({ name, arguments: args } as any);
  const raw = (res.content as { text: string }[])[0].text;
  return { isError: Boolean(res.isError), raw, body: JSON.parse(raw) };
}

/** A one-note vault with a body, so the evidence path has a session to offer. */
async function vaultWithNote(body: string, noteRel: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-contract-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, path.dirname(noteRel)), { recursive: true });
  fs.writeFileSync(path.join(dir, noteRel), body);
  return dir;
}

async function searchService(memoryDir: string) {
  const config = await makeConfig(memoryDir, await freePort());
  const started = await startMvpService(config, stubProvider(8));
  services.push(started);
  const client = await connect(config, await registerAndToken(started.app));
  await call(client, 'index_memory');
  return client;
}

describe('finding 15: search_memory says which state the evidence second pass is in', () => {
  it('carries no evidence object when no evidence model is configured: no second pass ran, so there is nothing to report', async () => {
    const memoryDir = await vaultWithNote('# Mango notes\n\nRowan likes mango juice.\n', 'People/Rowan.md');
    const client = await searchService(memoryDir);

    // Every hosted workspace runs without an evidence model, so this is every search it answers. A sentence saying that
    // nothing is missing, on each of them, told the agent nothing and cost it the tokens.
    for (const query of ['favorite drink', 'mango']) {
      const res = await call(client, 'search_memory', { query });
      expect(res.body.ok).toBe(true);
      expect(res.body.hits.length).toBeGreaterThan(0);
      expect(res.body.hits.map((h: { reason: string }) => h.reason)).not.toContain('evidence');
      expect(res.body).not.toHaveProperty('evidence');
      expect(res.raw).not.toMatch(/extractor-unavailable|evidence model/i);
    }

    // The description says when there is no evidence object, and no longer names a state search_memory cannot answer.
    const described = (await client.listTools()).tools.find((t) => t.name === 'search_memory')?.description ?? '';
    expect(described).toMatch(/There is no `evidence` object when this deployment has no evidence model configured and the pass is not switched off: no second pass runs, and the hits are the whole result\./);
    expect(described).toContain('"off"');
    expect(described).toContain('"failed"');
    expect(described).not.toContain('"unavailable"');
    expect(described).not.toMatch(/When RENOR_SEARCH_EVIDENCE is on, also runs/);

    await client.close();
  });

  it('reports "failed" when an evidence model is configured and its call fails, and the hits are still the result', async () => {
    let requests = 0;
    const refusing = http.createServer((_req, res) => {
      requests++;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'synthetic refusal' }));
    });
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve));
    const chatPort = (refusing.address() as net.AddressInfo).port;

    const memoryDir = await vaultWithNote('# Mango notes\n\nRowan likes mango juice.\n', 'People/Rowan.md');
    process.env.RENOR_EVIDENCE_BASE_URL = `http://127.0.0.1:${chatPort}/v1`;
    process.env.RENOR_EVIDENCE_API_KEY = 'synthetic-local-key';
    process.env.RENOR_EVIDENCE_MODE = 'always'; // the engine's unset default is off (src/evidence/gate.ts)
    const client = await searchService(memoryDir);

    const res = await call(client, 'search_memory', { query: 'favorite drink' });
    expect(requests).toBeGreaterThan(0);
    expect(res.body.ok).toBe(true);
    expect(res.body.hits.length).toBeGreaterThan(0);
    expect(res.body.hits.map((h: { reason: string }) => h.reason)).not.toContain('evidence');
    expect(res.body.evidence).toMatchObject({ status: 'skipped', reason: 'extractor-error', state: 'failed' });
    expect(res.body.evidence.note).toMatch(/evidence model call failed/i);

    await client.close();
    await new Promise<void>((resolve) => refusing.close(() => resolve()));
  });

  it('reports "off" — not "unavailable" — when the kill switch is set, so the two are distinguishable', async () => {
    const memoryDir = await vaultWithNote('# Mango notes\n\nRowan likes mango juice.\n', 'People/Rowan.md');
    process.env.RENOR_SEARCH_EVIDENCE = '0';
    const client = await searchService(memoryDir);

    const res = await call(client, 'search_memory', { query: 'favorite drink' });
    expect(res.body.ok).toBe(true);
    expect(res.body.hits.length).toBeGreaterThan(0);
    expect(res.body.evidence.reason).toBe('flag-off');
    expect(res.body.evidence.state).toBe('off');
    expect(res.body.evidence.note).toMatch(/switched off/i);
    expect(res.body.evidence.note).not.toMatch(/no evidence model configured/i);
    // A deliberate switch must be visible, not an absent key.
    expect(res.body).toHaveProperty('evidence');

    await client.close();
  });

  it('reports "ok" and really prepends the dated item table the description promises', async () => {
    const items = JSON.stringify({
      items: [{ item: 'camping trip', action: 'went on', amount: '3 days', date: '2023/05/29' }],
    });
    const fake = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: items } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const chatPort = (fake.address() as net.AddressInfo).port;

    const memoryDir = await vaultWithNote('# Session\n\nWe went camping for 3 days near the lake.\n', 'Sessions/s.md');
    process.env.RENOR_EVIDENCE_BASE_URL = `http://127.0.0.1:${chatPort}/v1`;
    process.env.RENOR_EVIDENCE_API_KEY = 'synthetic-local-key';
    process.env.RENOR_EVIDENCE_MODE = 'always'; // the engine's unset default is off (src/evidence/gate.ts)
    const client = await searchService(memoryDir);

    const res = await call(client, 'search_memory', { query: 'How many days was the camping trip?' });
    expect(res.body.ok).toBe(true);
    expect(res.body.evidence.status).toBe('ok');
    expect(res.body.evidence.state).toBe('ok');
    expect(res.body.evidence.note).toMatch(/prepended as the first hit/i);
    // The description's promise, kept honest: the table is hit zero.
    expect(res.body.hits[0].reason).toBe('evidence');
    expect(res.body.hits[0].text).toContain('camping trip');
    expect(res.body.hits[0].text).toContain('3 days');

    await client.close();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });
});

describe('finding 17: every tool renders its JSON the same way, on one line', () => {
  it('every tool the server lists answers compact JSON, keys and values unchanged', async () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-shape-'));
    tmpDirs.push(memoryDir);
    const config = await makeConfig(memoryDir, await freePort());
    const started = await startMvpService(config);
    services.push(started);
    const client = await connect(config, await registerAndToken(started.app));

    // Indentation is whitespace an agent pays for in tokens and reads nothing from. A new tool without a row here
    // fails the last assertion, so no tool can come back indented.
    const answered = new Set<string>();
    const check = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await call(client, name, args);
      expect(res.raw, name).toBe(JSON.stringify(res.body));
      answered.add(name);
      return res;
    };

    expect((await check('memory_status')).body).toHaveProperty('notes');
    await check('remember_note', { text: 'The mango juice stand closes at six.', date: '2026-10-02' });
    await check('index_memory');
    expect((await check('remember', { statement: 'The mango stand is run by Ana.', subject: 'mango stand', predicate: 'run_by', object: 'Ana' })).body.mode).toBe('fact');
    expect((await check('remember', { statement: 'Mango season peaks in December.' })).body.mode).toBe('note');
    expect((await check('save_memory', { subject: 'mango stand', predicate: 'opens_at', object: 'nine' })).body.ok).toBe(true);
    expect((await check('retrieve_memory', { subject: 'mango stand' })).body.facts.length).toBe(2);
    expect((await check('get_context', { query: 'When does the mango stand close?' })).body.ok).toBe(true);
    expect((await check('search_text', { query: 'mango' })).body.ok).toBe(true);
    expect((await check('search_memory', { query: 'mango' })).body.error).toBe('semantic-unavailable');
    expect((await check('lookup_entity', { name: 'mango' })).body.ok).toBe(true);
    expect((await check('search_history', { query: 'mango' })).body.configured).toBe(false);
    expect((await check('export_memory')).body.format).toBe('markdown');
    expect((await check('whats_new', { include_own: true })).body.items.length).toBeGreaterThan(0);
    // Asked of this connection itself (its key's name), so the same client can answer and close it.
    const asked = await check('ask_agent', { to: 'contract', request: 'Is the mango stand open on Sunday?' });
    expect(asked.body.from_agent).toBe('contract');
    expect(asked.body.status).toBe('open');
    expect((await check('list_requests', {})).body.requests.map((r: any) => r.id)).toContain(asked.body.id);
    expect((await check('answer_request', { id: asked.body.id, answer: 'Yes, until noon.' })).body.status).toBe('answered');
    expect((await check('close_request', { id: asked.body.id })).body.status).toBe('closed');

    const map = await check('memory_map');
    // Same keys and values as before: formatting only.
    expect(map.body.ok).toBe(true);
    expect(Object.keys(map.body).sort()).toEqual(expect.arrayContaining(['ok', 'memories', 'facts']));
    const entry = map.body.memories.find((m: any) => m.kind === 'entry' && /juice stand/.test(m.title));
    expect(entry).toBeTruthy();

    const read = await check('read_memory', { id: entry.id });
    expect(read.body.text).toContain('mango juice stand');

    const retired = await check('retire_memory', { id: entry.id });
    expect(retired.body.action).toBe('retired');
    expect((await check('memory_map', { query: 'juice' })).body.retired.map((r: any) => r.memoryId)).toEqual([entry.id]);

    const restored = await check('restore_memory', { id: entry.id });
    expect(restored.body.action).toBe('restored');

    const preview = await check('preview_import', { label: 'shape', files: [{ relativePath: 'Mango.md', markdown: '# Mango\n\nThe mango press is in the shed.\n' }] });
    expect(preview.body.toWrite).toBe(1);
    expect((await check('apply_import', { batchId: preview.body.batchId })).body.ok).toBe(true);
    expect((await check('undo_import', { batchId: preview.body.batchId })).body.retired).toBe(1);

    expect((await check('sharing_level', { action: 'get' })).body.ok).toBe(true);

    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    expect([...answered].sort()).toEqual(listed);

    await client.close();
  });
});

describe('finding 18: a lookup_entity miss names the boundary instead of returning null', () => {
  it('says a note-text word is not an entity, and points at the tool that finds it', async () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-entity-'));
    tmpDirs.push(memoryDir);
    fs.mkdirSync(path.join(memoryDir, 'People'), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'People', 'Acme.md'), '# Acme\n\nAcme ships the mango press.\n');
    const config = await makeConfig(memoryDir, await freePort());
    const started = await startMvpService(config);
    services.push(started);
    const client = await connect(config, await registerAndToken(started.app));

    // A word that only ever lives in note text.
    await call(client, 'remember_note', { text: 'the zephyrfly rollout slipped to november', date: '2026-10-02' });
    await call(client, 'index_memory');

    // memory_status counts entities, which is exactly what made the bare null
    // look contradictory.
    const status = await call(client, 'memory_status');
    expect(status.body.entities).toBeGreaterThan(0);

    const miss = await call(client, 'lookup_entity', { name: 'zephyrfly' });
    expect(miss.body.ok).toBe(true);
    expect(miss.body.entity).toBe(null);
    expect(miss.body.reason).toBe('no-entity-match');
    expect(miss.body.entitiesIndexed).toBe(status.body.entities);
    expect(miss.body.note).toMatch(/search_text/);
    expect(miss.body.searched).toMatch(/never words inside note text/i);

    // The boundary is a fact, not a lookup failure: the word is still findable.
    const fts = await call(client, 'search_text', { query: 'zephyrfly' });
    expect(fts.body.ok).toBe(true);
    expect(JSON.stringify(fts.body.results)).toContain('zephyrfly');

    // A registered entity name still resolves, unchanged.
    const hit = await call(client, 'lookup_entity', { name: 'Acme' });
    expect(hit.body.entity.canonicalName).toBe('Acme');
    expect(hit.body.reason).toBeUndefined();

    // The stated surface is the lookup that runs, not a narrower claim:
    // canonical-name substring and source-note-path substring both match.
    fs.writeFileSync(path.join(memoryDir, 'People', 'Acme Robotics.md'), '# Acme Robotics\n\nArms for the mango press.\n');
    await call(client, 'index_memory');
    const bySubstring = await call(client, 'lookup_entity', { name: 'Robotics' });
    expect(bySubstring.body.entity.canonicalName).toBe('Acme Robotics');

    fs.mkdirSync(path.join(memoryDir, 'Vendors', 'Globex'), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'Vendors', 'Globex', 'Widget.md'), '# Widget\n\nA widget.\n');
    await call(client, 'index_memory');
    const byPath = await call(client, 'lookup_entity', { name: 'Vendors/Globex' });
    expect(byPath.body.entity.canonicalName).toBe('Widget');

    const described = (await client.listTools()).tools.find((t) => t.name === 'lookup_entity')?.description ?? '';
    expect(described).toContain('no-entity-match');
    expect(described).toContain('substring of a source note path');

    await client.close();
  });
});
describe('a workspace without semantic search: search_memory says what to use instead', () => {
  it('answers semantic-unavailable with a note naming search_text, and the advice works', async () => {
    // What a new self-serve workspace runs: no MVP_EMBEDDING_PROVIDER (cleared above), so no provider.
    const memoryDir = await vaultWithNote('# Drinks\n\nRowan likes mango juice.\n', 'People/Rowan.md');
    const config = await makeConfig(memoryDir, await freePort());
    const started = await startMvpService(config);
    services.push(started);
    const client = await connect(config, await registerAndToken(started.app));
    await call(client, 'index_memory');

    const status = await call(client, 'memory_status');
    expect(status.body.semantic).toBe(false);

    // The machine contract is unchanged: a tool error with the same code and no hits.
    const res = await call(client, 'search_memory', { query: 'favorite drink' });
    expect(res.isError).toBe(true);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('semantic-unavailable');
    expect(res.body.hits).toEqual([]);
    // The code alone left the agent no next step; the note names the search this workspace has.
    expect(res.body.note).toMatch(/no semantic search/i);
    expect(res.body.note).toMatch(/search_text/);

    // Following the note finds the memory search_memory could not.
    const fts = await call(client, 'search_text', { query: 'mango' });
    expect(fts.body.ok).toBe(true);
    expect(JSON.stringify(fts.body.results)).toContain('mango juice');

    // get_context says which search ran, and matched words itself: the note is search_memory's alone.
    const ctx = await call(client, 'get_context', { query: 'mango juice' });
    expect(ctx.body.retrieval).toBe('keyword');
    expect(ctx.body).not.toHaveProperty('note');
    // Nor is a workspace without semantic search an outage: get_context's notice is for a rebuild or a failed provider.
    expect(ctx.body).not.toHaveProperty('notice');

    // A lookup miss no longer sends the agent to a search this workspace does not have, unqualified.
    const miss = await call(client, 'lookup_entity', { name: 'zephyrfly' });
    expect(miss.body.note).toMatch(/search_memory for meaning where the workspace has semantic search/);

    // The description states the condition and the fallback, not a provider this surface does not run.
    const tool = (await client.listTools()).tools.find((t) => t.name === 'search_memory');
    expect(tool?.description).toContain('semantic: true');
    expect(tool?.description).toContain('semantic-unavailable');
    expect(tool?.description).toContain('semantic-rebuilding');
    expect(tool?.description).toContain('search_text');
    expect(tool?.description).not.toMatch(/Voyage/);

    await client.close();
  });

  it('carries no note when semantic search ran', async () => {
    const memoryDir = await vaultWithNote('# Drinks\n\nRowan likes mango juice.\n', 'People/Rowan.md');
    const client = await searchService(memoryDir);

    const res = await call(client, 'search_memory', { query: 'favorite drink' });
    expect(res.isError).toBe(false);
    expect(res.body.ok).toBe(true);
    expect(res.body).not.toHaveProperty('note');

    const ctx = await call(client, 'get_context', { query: 'mango juice' });
    expect(ctx.body.retrieval).toBe('hybrid');

    await client.close();
  });
});
