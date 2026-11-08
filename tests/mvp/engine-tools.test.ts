import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { attachEngine, engineSearchMemory, readEmbeddingTableDims } from '../../src/mvp/engine';
import { EvidenceExtractor } from '../../src/evidence/secondPass';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const tmpDirs: string[] = [];
const services: Array<MvpApp & { httpServer: import('http').Server }> = [];

afterEach(async () => {
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
    await s.close();
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.MVP_EMBEDDING_DIMS;
  delete process.env.MVP_DB_PATH;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.RENOR_NEWEST_FIRST;
  delete process.env.RENOR_SEARCH_EVIDENCE;
  delete process.env.RENOR_READ_HONESTY;
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

function makeConfig(memoryDir: string, port: number): MvpConfig {
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  tmpDirs.push(authRoot);
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  return loadMvpConfig();
}

function stubProvider(dims: number): EmbeddingProvider {
  return {
    dimensions: dims,
    async embed(texts: string[]) {
      return texts.map((t, i) => {
        const v = new Array(dims).fill(0);
        v[0] = t.toLowerCase().includes('mango') ? 1 : 0.1;
        v[1] = t.toLowerCase().includes('passion') ? 1 : 0.05 * (i + 1);
        return v;
      });
    },
  };
}

async function registerAndToken(app: Express) {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'engine-test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

async function mcp(config: MvpConfig, token: string) {
  const client = new Client({ name: 'engine-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

function parse(res: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((res.content as { text: string }[])[0].text);
}

describe('engine tools on authenticated MCP (ADR-0003)', () => {
  it.skipIf(HTTP_SERVER_UNSUPPORTED)('lists engine tools; search_memory is unavailable without a provider; FTS/index/entity/daily-note work', async () => {
    const port = await freePort();
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-eng-'));
    tmpDirs.push(memoryDir);
    fs.mkdirSync(path.join(memoryDir, 'People'), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'People', 'Ada.md'), '# Ada\n\nAda likes mango juice.\n');
    const config = makeConfig(memoryDir, port);
    const started = await startMvpService(config);
    services.push(started);
    const token = await registerAndToken(started.app);
    const client = await mcp(config, token);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'save_memory', 'retrieve_memory', 'export_memory', 'search_history',
      'search_memory', 'search_text', 'lookup_entity', 'remember_note', 'index_memory', 'memory_status',
    ]));

    const indexed = parse(await client.callTool({ name: 'index_memory', arguments: {} }));
    expect(indexed.ok).toBe(true);
    expect(indexed.indexed).toBeGreaterThanOrEqual(1);

    const fts = parse(await client.callTool({ name: 'search_text', arguments: { query: 'mango' } }));
    expect(fts.ok).toBe(true);
    expect(fts.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(fts.results)).toContain('mango');

    const sem = parse(await client.callTool({ name: 'search_memory', arguments: { query: 'favorite drink' } }));
    expect(sem.ok).toBe(false);
    expect(sem.error).toBe('semantic-unavailable');

    const ent = parse(await client.callTool({ name: 'lookup_entity', arguments: { name: 'Ada' } }));
    expect(ent.entity.canonicalName).toBe('Ada');

    const note = parse(await client.callTool({ name: 'remember_note', arguments: { text: 'dogfood note', date: '2026-09-11' } }));
    expect(note.ok).toBe(true);
    expect(fs.readFileSync(path.join(memoryDir, 'Memory', 'Daily', '2026-09-11.md'), 'utf8')).toContain('dogfood note');

    const status = parse(await client.callTool({ name: 'memory_status', arguments: {} }));
    expect(status.notes).toBeGreaterThanOrEqual(1);
    expect(status.semantic).toBe(false);
    // No server capture feature is on here, so the answer is what it was before capture_features existed.
    expect(status).not.toHaveProperty('capture_features');
    // Switched on, the same answer carries the server capture state (the flag is read per call).
    process.env.RENOR_STATUS_LEDGER = '1';
    try {
      const on = parse(await client.callTool({ name: 'memory_status', arguments: {} }));
      expect(on.capture_features).toEqual({
        save_moment: 'off', status_ledger: true, pinned_rules: false,
        rule_approvals: false, session_index: false, capture_server: false,
      });
    } finally {
      delete process.env.RENOR_STATUS_LEDGER;
    }
    // No embedding provider: no vectors and no mirror, but the ledger's size is still reported.
    expect(status.storage).toEqual({ vectors: 0, ledgerBytes: expect.any(Number) });
    await client.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('stub embeddings rank mango over unrelated notes; no real model download', async () => {
    // This test isolates semantic ranking. Product search applies a default-on
    // newest-first presentation rerank after semantic selection, and the two
    // temp files can have different mtimes depending on filesystem timing.
    process.env.RENOR_NEWEST_FIRST = '0';
    const port = await freePort();
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-sem-'));
    tmpDirs.push(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'drinks.md'), '# Drinks\n\nRowan likes mango juice.\n');
    fs.writeFileSync(path.join(memoryDir, 'other.md'), '# Other\n\nRandom hardware notes.\n');
    const config = makeConfig(memoryDir, port);
    const started = await startMvpService(config, stubProvider(8));
    services.push(started);
    const token = await registerAndToken(started.app);
    const client = await mcp(config, token);
    parse(await client.callTool({ name: 'index_memory', arguments: {} }));
    const sem = parse(await client.callTool({ name: 'search_memory', arguments: { query: 'mango' } }));
    expect(sem.ok).toBe(true);
    expect(sem.hits[0].notePath).toContain('drinks');
    expect(typeof sem.hits[0].session_date).toBe('string');
    expect(sem.hits[0].session_date.length).toBeGreaterThan(0);
    expect(sem.hits[0].text).not.toMatch(/^\[Session date:/);
    // The per-tenant storage figures: the vectors stored, and the copy searches read (the f32 copy unless RENOR_VECTOR_INT8 is on).
    const withVectors = parse(await client.callTool({ name: 'memory_status', arguments: {} }));
    expect(withVectors.storage.vectors).toBeGreaterThan(0);
    expect(withVectors.storage.vectorMirror).toEqual(expect.objectContaining({ copy: 'f32', rows: withVectors.storage.vectors }));
    await client.close();
  });

  it('refuses to attach a provider whose dimensions disagree with an existing index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-dims-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'index.db');
    const db = openDb(dbPath);
    runMigrations(db);
    const idx = new VectorIndex(db, 1024);
    idx.initTable();
    expect(readEmbeddingTableDims(db)).toBe(1024);
    const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
    tmpDirs.push(authRoot);
    process.env.MVP_MEMORY_DIR = dir;
    process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
    process.env.MVP_BASE_URL = 'http://127.0.0.1:1';
    process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
    process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
    process.env.MVP_PORT = '3471';
    process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
    const config = loadMvpConfig();
    expect(() => attachEngine(db, config, stubProvider(768))).toThrow(/dimension mismatch/);
    db.close();
  });

  it('filters scope before evidence hydration so cross-scope notes cannot leak', async () => {
    process.env.RENOR_NEWEST_FIRST = '0';
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-evidence-scope-'));
    tmpDirs.push(memoryDir);
    const alphaDir = path.join(memoryDir, 'Memory', 'Scopes', 'alpha', 'Notes');
    const betaDir = path.join(memoryDir, 'Memory', 'Scopes', 'beta', 'Notes');
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });
    const alphaPath = path.join(alphaDir, 'alpha.md');
    const betaPath = path.join(betaDir, 'beta.md');
    fs.writeFileSync(alphaPath, '# Alpha\n\nALPHA_ALLOWED fact.\n');
    fs.writeFileSync(betaPath, '# Beta\n\nBETA_SECRET must never reach alpha evidence.\n');

    const dbPath = path.join(memoryDir, 'index.db');
    const db = openDb(dbPath);
    runMigrations(db);
    for (const [p, hash, text] of [
      [alphaPath, 'alpha-hash', 'ALPHA_ALLOWED fact.'],
      [betaPath, 'beta-hash', 'BETA_SECRET must never reach alpha evidence.'],
    ] as const) {
      db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?)')
        .run(p, path.basename(p), 'note', hash, '2026-09-21T00:00:00.000Z', '{}');
      db.prepare('INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)')
        .run(p, '', text, 0, 1, 8, hash);
    }
    const idx = new VectorIndex(db, 8);
    idx.initTable();
    for (const row of db.prepare('SELECT id FROM chunks').all() as Array<{ id: number }>) {
      idx.upsert(row.id, [1, 0, 0, 0, 0, 0, 0, 0]);
    }
    const provider: EmbeddingProvider = {
      dimensions: 8,
      async embed(texts: string[]) {
        return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);
      },
    };
    const chat = vi.fn(async (req: any) => {
      const prompt = req.messages[0].content as string;
      return {
        content: JSON.stringify({
          items: [{ item: prompt.includes('BETA_SECRET') ? 'cross-scope-leak' : 'alpha-only' }],
        }),
        latencyMs: 1,
      };
    }) as any;
    const extractor = new EvidenceExtractor({ chat });

    const res = await engineSearchMemory(
      db,
      { provider, vectorIndex: idx, dims: 8 },
      memoryDir,
      'list every fact',
      20,
      'scope:alpha',
      {
        options: { mode: 'always', model: 'test', maxSessions: 12, charCap: 6000, chat },
        extractor,
      },
    );

    expect(res.ok).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = chat.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('ALPHA_ALLOWED');
    expect(prompt).not.toContain('BETA_SECRET');
    expect(res.evidence?.items?.[0]?.item).toBe('alpha-only');
    expect(JSON.stringify(res.hits)).not.toContain('BETA_SECRET');
    expect((res.hits as any[])[0].reason).toBe('evidence');
    db.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('lookup_entity with scope returns only entities whose source note belongs to that scope', async () => {
    const port = await freePort();
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-scope-'));
    tmpDirs.push(memoryDir);
    fs.mkdirSync(path.join(memoryDir, 'Memory', 'Scopes', 'alpha', 'Notes'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'Memory', 'Scopes', 'beta', 'Notes'), { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, 'Memory', 'Scopes', 'alpha', 'Notes', 'Acme.md'),
      '# Acme\n\nAcme is the alpha project codename.\n',
    );
    fs.writeFileSync(
      path.join(memoryDir, 'Memory', 'Scopes', 'beta', 'Notes', 'Globex.md'),
      '# Globex\n\nGlobex is the beta project codename.\n',
    );
    const config = makeConfig(memoryDir, port);
    const started = await startMvpService(config);
    services.push(started);
    const token = await registerAndToken(started.app);
    const client = await mcp(config, token);
    parse(await client.callTool({ name: 'index_memory', arguments: {} }));

    // Same-scope lookup works and reports the scope.
    const alpha = parse(await client.callTool({ name: 'lookup_entity', arguments: { name: 'Acme', scope: 'scope:alpha' } }));
    expect(alpha.ok).toBe(true);
    expect(alpha.entity.canonicalName).toBe('Acme');
    expect(alpha.entity.sourceNote).toContain('Memory/Scopes/alpha/');
    expect(alpha.scope).toBe('scope:alpha');

    // Cross-scope lookup fails closed: no entity object leaks.
    const cross = parse(await client.callTool({ name: 'lookup_entity', arguments: { name: 'Acme', scope: 'scope:beta' } }));
    expect(cross.ok).toBe(true);
    expect(cross.entity).toBeNull();

    // ...and the miss itself leaks nothing: no existence-specific reason, no
    // canonical name, and no workspace-wide count. A caller holding only
    // scope:beta must not be able to learn that alpha holds "Acme" — the
    // response has to be the one it would get for a name that exists nowhere.
    const crossUnknown = parse(await client.callTool({ name: 'lookup_entity', arguments: { name: 'Nowhere', scope: 'scope:beta' } }));
    expect(Object.keys(cross).sort()).toEqual(Object.keys(crossUnknown).sort());
    expect(cross.reason).toBe(crossUnknown.reason);
    expect(cross.reason).toBe('no-entity-match');
    expect(cross.entitiesIndexed).toBe(crossUnknown.entitiesIndexed);
    // Identical apart from the name the CALLER supplied, which it already knew:
    // no other scope is named, no other entity is quoted, no count differs.
    expect(cross.note).toBe(crossUnknown.note.replace('Nowhere', 'Acme'));
    expect(JSON.stringify(cross)).not.toContain('alpha');
    // The count is authorized for the requested scope, not the whole workspace.
    const betaOwn = parse(await client.callTool({ name: 'lookup_entity', arguments: { name: 'Globex', scope: 'scope:beta' } }));
    expect(betaOwn.entity.canonicalName).toBe('Globex');
    expect(cross.entitiesIndexed).toBe(1);
    const unscopedCount = parse(await client.callTool({ name: 'lookup_entity', arguments: { name: 'Nowhere' } }));
    expect(unscopedCount.entitiesIndexed).toBeGreaterThan(cross.entitiesIndexed);

    // Global scope excludes scoped notes entirely.
    const global = parse(await client.callTool({ name: 'lookup_entity', arguments: { name: 'Acme', scope: 'global' } }));
    expect(global.ok).toBe(true);
    expect(global.entity).toBeNull();
    const globalUnknown = parse(await client.callTool({ name: 'lookup_entity', arguments: { name: 'Nowhere', scope: 'global' } }));
    expect(global.reason).toBe(globalUnknown.reason);
    expect(global.entitiesIndexed).toBe(globalUnknown.entitiesIndexed);
    expect(JSON.stringify(global)).not.toContain('beta');

    // Omitted scope preserves prior behavior.
    const unscoped = parse(await client.callTool({ name: 'lookup_entity', arguments: { name: 'Globex' } }));
    expect(unscoped.ok).toBe(true);
    expect(unscoped.entity.canonicalName).toBe('Globex');
    expect(unscoped.scope).toBeUndefined();

    await client.close();
  });
});

// Constant embeddings intentionally rank irrelevant memories highly.
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('read liveness through real MCP', () => {
  async function fixture() {
    delete process.env.RENOR_READ_HONESTY;
    process.env.RENOR_SEARCH_EVIDENCE = '0';
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-read-'));
    tmpDirs.push(memoryDir);
    const config = makeConfig(memoryDir, await freePort());
    const provider: EmbeddingProvider = {
      dimensions: 4,
      async embed(texts) { return texts.map(() => [1, 0, 0, 0]); },
    };
    const service = await startMvpService(config, provider);
    services.push(service);
    const client = await mcp(config, await registerAndToken(service.app));
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      parse(await client.callTool({ name, arguments: args }));
    await call('remember', { statement: 'Use Bun for TypeScript projects.', subject: 'user',
      predicate: 'prefers_package_manager_for_typescript', object: 'Bun' });
    await call('remember', { statement: 'Database is MySQL 8.', subject: 'production database',
      predicate: 'engine_and_extension', object: 'MySQL 8' });
    await call('index_memory');
    await call('remember', { statement: 'Correction: database is Postgres 16 with pgvector.',
      subject: 'production database', predicate: 'engine_and_extension', object: 'Postgres 16 with pgvector' });
    return { client, call, service, memoryDir };
  }

  it('never returns a closed ledger event as live, before or after reindex', async () => {
    const { client, call } = await fixture();
    try {
      for (const indexed of [false, true]) {
        if (indexed) await call('index_memory');
        const context = await call('get_context', { query: 'which database do we run in production?', max_tokens: 4000 });
        const search = await call('search_memory', { query: 'MySQL database' });
        if (process.env.RENOR_READ_REGRESSION_OUTPUT) fs.appendFileSync(process.env.RENOR_READ_REGRESSION_OUTPUT, JSON.stringify({ indexed, context, search }) + '\n');
        expect(context.facts[0].object).toBe('Postgres 16 with pgvector');
        expect(JSON.stringify(context.memories)).not.toContain('MySQL 8');
        expect(JSON.stringify(search.hits)).not.toContain('MySQL 8');
        const text = await call('search_text', { query: 'MySQL' });
        expect(JSON.stringify(text.results)).not.toContain('MySQL 8');
      }
      const history = await call('search_memory', { query: 'MySQL database', include_history: true });
      expect(JSON.stringify(history.hits)).toContain('MySQL 8');
      expect(JSON.stringify(history.hits)).toContain('superseded');
      const facts = await call('retrieve_memory', { subject: 'production database', include_history: true });
      expect(facts.facts).toHaveLength(2);
    } finally { await client.close(); }
  });

  it('filters closed events from full-note evidence hydration before extraction', async () => {
    const { client, call, service, memoryDir } = await fixture();
    try {
      await call('index_memory');
      const chat = vi.fn(async () => ({ content: '{"items":[{"item":"Postgres"}]}', latencyMs: 1 })) as any;
      const result = await engineSearchMemory(service.db, service.engine, memoryDir,
        'which production database?', 20, undefined, {
          options: { mode: 'always', model: 'test', maxSessions: 12, charCap: 6000, chat },
          extractor: new EvidenceExtractor({ chat }),
        });
      expect(result.ok).toBe(true);
      expect(chat).toHaveBeenCalledTimes(1);
      const prompt = chat.mock.calls[0][0].messages[0].content as string;
      expect(prompt).toContain('Postgres 16 with pgvector');
      expect(prompt).not.toContain('MySQL 8');
    } finally { await client.close(); }
  });

  it('liveness comes from closed_event links, never from the wording of the query', async () => {
    const { client, call } = await fixture();
    try {
      await call('remember', { statement: 'Staging deploy is make push-staging-WRONG.', subject: 'staging',
        predicate: 'deploy_command', object: 'make push-staging-WRONG' });
      await call('index_memory');
      await call('remember', { statement: 'Correction: staging deploy is make deploy-staging.', subject: 'staging',
        predicate: 'deploy_command', object: 'make deploy-staging' });
      await call('index_memory');
      const queries = [
        'what command is used to deploy to staging?',
        'what command is used to run staging deployments?',
        'what command is usually used to run staging deployments?',
        'which command is commonly used to run staging deployments?',
        'what command is currently used to run staging deployments?',
        'what command is not used to run staging deployments?',
        'what is the history retention policy for staging logs?',
        'what command did we use to use to deploy staging?',
        'which staging deploy command was previously used?',
        'what is the historical staging deploy command?',
        'what was the formerly used staging deploy command, superseded or not?',
        'what did we used to run to deploy staging?',
        'staging deploy command history of changes',
      ];
      for (const query of queries) {
        const context = await call('get_context', { query, max_tokens: 4000 });
        const search = await call('search_memory', { query });
        const text = await call('search_text', { query: 'WRONG' });
        if (process.env.RENOR_READ_REGRESSION_OUTPUT) fs.appendFileSync(process.env.RENOR_READ_REGRESSION_OUTPUT, JSON.stringify({ query, context, search }) + '\n');
        expect(JSON.stringify(context.memories), query).not.toContain('WRONG');
        expect(JSON.stringify(search.hits), query).not.toContain('WRONG');
        expect(JSON.stringify(text.results), query).not.toContain('WRONG');
      }
      const history = await call('get_context', { query: 'staging deploy command', max_tokens: 4000, include_history: true });
      expect(JSON.stringify(history.memories)).toContain('WRONG');
      expect(JSON.stringify(history.memories)).toContain('Superseded');
      const hits = await call('search_memory', { query: 'staging deploy command', include_history: true });
      expect(JSON.stringify(hits.hits)).toContain('Superseded');
    } finally { await client.close(); }
  });

  it('a note-identity hit on the ledger file never carries a closed event', async () => {
    const { client, call, memoryDir } = await fixture();
    try {
      await call('remember', { statement: 'Correction: use pnpm for TypeScript projects.', subject: 'user',
        predicate: 'prefers_package_manager_for_typescript', object: 'pnpm' });
      await call('index_memory');
      // `ledger.md` names the ledger note, but the opening chunk of a ledger that has its header is the engine's own
      // header, which is no memory: the identifier index adds nothing of the ledger beside the prose page.
      const named = await call('search_text', { query: 'ledger.md' });
      expect(named.results.map((r: any) => r.notePath)).not.toContain('System/Memory Events Ledger.md');
      expect(JSON.stringify(named.results)).not.toContain('Bun');
      expect(JSON.stringify(named.results)).not.toContain('Append-only');
      // A hand-edited or restored ledger may start at its first event: that opening chunk is now a closed one.
      const ledger = path.join(memoryDir, 'System', 'Memory Events Ledger.md');
      const raw = fs.readFileSync(ledger, 'utf8');
      fs.writeFileSync(ledger, raw.slice(raw.indexOf('## MEM_')));
      await call('index_memory');
      const headerless = await call('search_text', { query: 'ledger.md' });
      expect(JSON.stringify(headerless.results)).not.toContain('Bun');
      const context = await call('get_context', { query: 'ledger.md', max_tokens: 4000 });
      expect(JSON.stringify(context.memories)).not.toContain('Bun');
    } finally { await client.close(); }
  });
});
