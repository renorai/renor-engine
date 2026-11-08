import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { IMPORT_LIMITS } from '../../src/importing/hosted';
import { KEY_SHAPES, Rng } from '../../scripts/eval/secret-guard/plantedSet';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const tmpDirs: string[] = [];
const SAVED_GUARD = process.env.RENOR_SECRET_GUARD;
const services: Array<MvpApp & { httpServer: import('http').Server }> = [];

afterEach(async () => {
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
    await s.close();
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.MVP_EMBEDDING_DIMS;
  delete process.env.MVP_DB_PATH;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.RENOR_NEWEST_FIRST;
  delete process.env.RENOR_SEARCH_EVIDENCE;
  if (SAVED_GUARD === undefined) delete process.env.RENOR_SECRET_GUARD;
  else process.env.RENOR_SECRET_GUARD = SAVED_GUARD;
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

async function registerAndToken(app: Express, clientName = 'engine-test') {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

function journalOf(memoryDir: string, batchId: string) {
  return JSON.parse(fs.readFileSync(path.join(memoryDir, '.renor-imports', `${batchId}.json`), 'utf8')) as
    { state: string; created: Array<{ relPath: string; retired?: boolean }>; reasserted?: Array<{ relPath: string; hash: string; retired?: boolean }> };
}

const fixtureRoot = path.join(__dirname, '../fixtures/hosted-import');
const fixtureFiles = ['People/Ada.md', 'Projects/Launch.md'].map(relativePath => ({
  relativePath, markdown: fs.readFileSync(path.join(fixtureRoot, relativePath), 'utf8'),
}));
async function tenant(overrides: Partial<MvpConfig> = {}) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-import-'));
  tmpDirs.push(memoryDir);
  const config = makeConfig(memoryDir, await freePort());
  config.embeddingProvider = 'none';
  Object.assign(config, overrides);
  const service = await startMvpService(config);
  services.push(service);
  const token = await registerAndToken(service.app);
  const client = await mcp(config, token);
  return { memoryDir, config, service, client };
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const reply = await client.callTool({ name, arguments: args });
  expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
  const body = parse(reply);
  // Every memory tool renders its JSON the same way, on one line (tool-response-contract.test.ts, finding 17).
  expect((reply.content as { text: string }[])[0].text).toBe(JSON.stringify(body));
  return body;
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('hosted vault import over authenticated MCP', () => {
  it('keeps notes re-asserted by a later batch until that batch is undone', async () => {
    const t = await tenant();
    try {
      const previewA = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      expect(await call(t.client, 'apply_import', { batchId: previewA.batchId })).toMatchObject({ notesWritten: 2, notesUnchanged: 0 });
      const previewB = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      expect(await call(t.client, 'apply_import', { batchId: previewB.batchId })).toMatchObject({ notesWritten: 0, notesUnchanged: 2 });

      const undoneA = await call(t.client, 'undo_import', { batchId: previewA.batchId });
      expect(undoneA).toMatchObject({ retired: 0, alreadyUndone: false });
      expect(undoneA.preserved).toEqual(fixtureFiles.map(file => `Imported/fixture/${file.relativePath}`));
      expect(undoneA.preservedReasons).toEqual(Object.fromEntries(fixtureFiles.map(file => [
        `Imported/fixture/${file.relativePath}`, 'kept: re-asserted by a later import',
      ])));
      expect((await call(t.client, 'search_text', { query: 'Silverpine' })).results).toHaveLength(1);
      expect(await call(t.client, 'undo_import', { batchId: previewA.batchId })).toMatchObject({ retired: 0, alreadyUndone: true });

      // Simplest ownership rule: undoing the last live assertion retires the note when its creator was already undone.
      expect(await call(t.client, 'undo_import', { batchId: previewB.batchId })).toMatchObject({ retired: 2, preserved: [] });
      expect((await call(t.client, 'search_text', { query: 'Silverpine' })).results).toEqual([]);
    } finally { await t.client.close(); }
  });

  it('continues undoing a creator batch when a re-asserted note is gone', async () => {
    const t = await tenant();
    try {
      const previewA = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      await call(t.client, 'apply_import', { batchId: previewA.batchId });
      const previewB = await call(t.client, 'preview_import', { label: 'fixture', files: [fixtureFiles[0]] });
      await call(t.client, 'apply_import', { batchId: previewB.batchId });
      fs.rmSync(path.join(t.memoryDir, 'Imported/fixture/People/Ada.md'));

      expect(await call(t.client, 'undo_import', { batchId: previewA.batchId })).toMatchObject({
        retired: 1, preserved: [], alreadyUndone: false,
      });
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported/fixture/Projects/Launch.md'))).toBe(false);
      expect(await call(t.client, 'undo_import', { batchId: previewA.batchId })).toMatchObject({ retired: 0, alreadyUndone: true });
      expect(await call(t.client, 'undo_import', { batchId: previewB.batchId })).toMatchObject({ retired: 0, preserved: [] });
    } finally { await t.client.close(); }
  });

  it('preserves a re-asserted note replaced by a directory and continues undoing both batches', async () => {
    const t = await tenant();
    try {
      const previewA = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      await call(t.client, 'apply_import', { batchId: previewA.batchId });
      const previewB = await call(t.client, 'preview_import', { label: 'fixture', files: [fixtureFiles[0]] });
      await call(t.client, 'apply_import', { batchId: previewB.batchId });
      const ada = path.join(t.memoryDir, 'Imported/fixture/People/Ada.md');
      fs.rmSync(ada);
      fs.mkdirSync(ada);
      fs.writeFileSync(path.join(ada, 'owner.md'), 'Owner data');

      expect(await call(t.client, 'undo_import', { batchId: previewA.batchId })).toMatchObject({
        retired: 1, preserved: ['Imported/fixture/People/Ada.md'], alreadyUndone: false,
      });
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported/fixture/Projects/Launch.md'))).toBe(false);
      expect(await call(t.client, 'undo_import', { batchId: previewB.batchId })).toMatchObject({
        retired: 0, preserved: ['Imported/fixture/People/Ada.md'], alreadyUndone: false,
      });
      expect(fs.readFileSync(path.join(ada, 'owner.md'), 'utf8')).toBe('Owner data');
    } finally { await t.client.close(); }
  });

  it('reads an old receipt without reasserted notes with its original creator-only behavior', async () => {
    const t = await tenant();
    try {
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      await call(t.client, 'apply_import', { batchId: preview.batchId });
      const journalPath = path.join(t.memoryDir, '.renor-imports', `${preview.batchId}.json`);
      const oldManifest = journalOf(t.memoryDir, preview.batchId);
      delete oldManifest.reasserted;
      fs.writeFileSync(journalPath, JSON.stringify(oldManifest));
      expect(await call(t.client, 'undo_import', { batchId: preview.batchId })).toMatchObject({ retired: 2, preserved: [] });
    } finally { await t.client.close(); }
  });

  it('previews a local fixture, applies, recalls a fact, restarts, undoes and confirms recall is gone', async () => {
    const t = await tenant();
    try {
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      expect(preview.toWrite).toBe(2);
      expect(preview.conflicts).toEqual([]);
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported'))).toBe(false);
      expect(t.service.db.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 0 });
      const applied = await call(t.client, 'apply_import', { batchId: preview.batchId });
      expect(applied.notesWritten).toBe(2);
      expect(await call(t.client, 'apply_import', { batchId: preview.batchId })).toMatchObject({ notesWritten: 2 });
      const recall = await call(t.client, 'search_text', { query: 'Silverpine' });
      expect(recall.results).toHaveLength(1);
      expect(recall.results[0].text).toContain("Ada's preferred observatory is Silverpine Observatory.");
      expect(fs.readFileSync(path.join(t.memoryDir, 'Imported/fixture/People/Ada.md'), 'utf8')).toBe(fixtureFiles[0].markdown);
      await t.client.close();
      t.service.httpServer.closeAllConnections?.();
      await new Promise<void>(resolve => t.service.httpServer.close(() => resolve()));
      await t.service.close();
      services.splice(services.indexOf(t.service), 1);
      const restarted = await startMvpService(t.config);
      services.push(restarted);
      // The restarted service is a fresh client with its own name: a second registration of a
      // name a live client already holds is refused, so two clients are never one agent.
      const client = await mcp(t.config, await registerAndToken(restarted.app, 'engine-test-restart'));
      try {
        const undone = await call(client, 'undo_import', { batchId: preview.batchId });
        expect(undone).toMatchObject({ retired: 2, preserved: [] });
        expect((await call(client, 'search_text', { query: 'Silverpine' })).results).toEqual([]);
        expect(JSON.stringify(await call(client, 'get_context', { query: 'Silverpine Observatory' }))).not.toContain('preferred observatory');
        expect(fs.existsSync(path.join(t.memoryDir, 'Imported/fixture/People/Ada.md'))).toBe(false);
        expect(await call(client, 'undo_import', { batchId: preview.batchId })).toMatchObject({ retired: 0, alreadyUndone: true });
      } finally { await client.close(); }
    } finally { await t.client.close(); }
  });

  it('preserves conflicts, unchanged existing files and later edits; honors selection and reports skipped files', async () => {
    const t = await tenant();
    try {
      const dir = path.join(t.memoryDir, 'Imported/fixture/People');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Ada.md'), 'Owner already has a different Ada note.');
      fs.writeFileSync(path.join(dir, 'existing.md'), 'Existing identical bytes');
      const files = [...fixtureFiles,
        { relativePath: 'People/existing.md', markdown: 'Existing identical bytes' },
        { relativePath: '.obsidian/config.md', markdown: 'private config' },
        { relativePath: 'Private/secret.md', markdown: 'excluded' },
        { relativePath: 'empty.md', markdown: '   ' },
      ];
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files, exclude: ['Private'] });
      expect(preview.conflicts).toEqual(['Imported/fixture/People/Ada.md']);
      expect(preview.unchanged).toBe(1);
      expect(preview.skipped).toHaveLength(3);
      const applied = await call(t.client, 'apply_import', { batchId: preview.batchId });
      expect(applied).toMatchObject({ notesWritten: 1, notesConflicting: 1, notesUnchanged: 1 });
      const changed = path.join(t.memoryDir, 'Imported/fixture/Projects/Launch.md');
      fs.appendFileSync(changed, '\nOwner edit.');
      expect(await call(t.client, 'undo_import', { batchId: preview.batchId })).toMatchObject({ retired: 0, preserved: ['Imported/fixture/Projects/Launch.md'] });
      expect(fs.readFileSync(changed, 'utf8')).toContain('Owner edit.');
      expect(fs.readFileSync(path.join(dir, 'Ada.md'), 'utf8')).toContain('different Ada');
      expect(fs.readFileSync(path.join(dir, 'existing.md'), 'utf8')).toBe('Existing identical bytes');
    } finally { await t.client.close(); }
  });

  it('refuses unsafe paths, non-Markdown, invalid text, duplicates and oversized batches without writing', async () => {
    const t = await tenant();
    try {
      const inputs = [
        ...['../escape.md', '/absolute.md', 'C:/drive.md', 'a\\b.md', 'a/../escape.md', 'a//b.md', ' a.md', 'image.png', 'upper.MD', '\ud800.md'].map(relativePath => [{ relativePath, markdown: 'safe' }]),
        [{ relativePath: 'binary.md', markdown: 'a\0b' }],
        [{ relativePath: 'bad.md', markdown: '\ud800' }],
        [{ relativePath: 'bad.md', markdown: '---\nsecret: [invalid\n---\nbody' }],
        [{ relativePath: 'big.md', markdown: 'é'.repeat(IMPORT_LIMITS.fileBytes) }],
        Array.from({ length: 3 }, (_, i) => ({ relativePath: `${i}.md`, markdown: 'x'.repeat(50_000) })),
        Array.from({ length: 101 }, (_, i) => ({ relativePath: `${i}.md`, markdown: 'x' })),
        [{ relativePath: 'same.md', markdown: 'one' }, { relativePath: 'same.md', markdown: 'two' }],
      ];
      for (const files of inputs) {
        const reply = await t.client.callTool({ name: 'preview_import', arguments: { label: 'fixture', files } });
        expect(reply.isError, JSON.stringify(files.map(f => f.relativePath))).toBe(true);
      }
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported'))).toBe(false);
      expect(t.service.db.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 0 });
      expect((await t.client.callTool({ name: 'apply_import', arguments: { batchId: crypto.randomUUID() } })).isError).toBe(true);
    } finally { await t.client.close(); }
  });

  it('confines batch receipts to their tenant and refuses symlink ancestors; rejects unauthenticated imports', async () => {
    const a = await tenant();
    const b = await tenant();
    try {
      const preview = await call(a.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      for (const name of ['apply_import', 'undo_import']) {
        expect((await b.client.callTool({ name, arguments: { batchId: preview.batchId } })).isError).toBe(true);
      }
      await request(a.service.app).post(MVP_MCP_PATH).send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply_import', arguments: { batchId: preview.batchId } } }).expect(401);
      fs.symlinkSync(b.memoryDir, path.join(a.memoryDir, 'Imported'));
      expect((await a.client.callTool({ name: 'apply_import', arguments: { batchId: preview.batchId } })).isError).toBe(true);
      expect(fs.existsSync(path.join(b.memoryDir, 'fixture'))).toBe(false);
    } finally { await a.client.close(); await b.client.close(); }
  });
  it('rechecks new conflicts after preview, serializes concurrent apply, and supports gateway bearer sessions', async () => {
    const t = await tenant({ gatewaySecret: 'synthetic-gateway-secret', mcpJsonResponse: false });
    try {
      const minted = await request(t.service.app).post('/internal/gateway-token').set('x-renor-gateway-secret', t.config.gatewaySecret).send({}).expect(200);
      const client = await mcp(t.config, minted.body.access_token);
      try {
        const preview = await call(client, 'preview_import', { label: 'fixture', files: fixtureFiles });
        const target = path.join(t.memoryDir, 'Imported/fixture/People/Ada.md');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'A note arriving after preview');
        const replies = await Promise.all([
          call(client, 'apply_import', { batchId: preview.batchId }),
          call(client, 'apply_import', { batchId: preview.batchId }),
        ]);
        expect(replies[0]).toMatchObject({ notesWritten: 1, notesConflicting: 1 });
        expect(replies[1]).toMatchObject({ notesWritten: 1, notesConflicting: 1 });
        expect(await call(client, 'undo_import', { batchId: preview.batchId })).toMatchObject({ retired: 1 });
        expect(fs.readFileSync(target, 'utf8')).toBe('A note arriving after preview');
      } finally { await client.close(); }
    } finally { await t.client.close(); }
  });

  it('expires previews and refuses the ninth pending batch', async () => {
    const t = await tenant();
    try {
      const first = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      for (let i = 1; i < 8; i++) await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      expect((await t.client.callTool({ name: 'preview_import', arguments: { label: 'fixture', files: fixtureFiles } })).isError).toBe(true);
      const later = Date.now() + 16 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      expect((await t.client.callTool({ name: 'apply_import', arguments: { batchId: first.batchId } })).isError).toBe(true);
      await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported'))).toBe(false);
    } finally { await t.client.close(); }
  });

  it('rolls back a failed import without touching owner notes and retains an undo receipt', async () => {
    const t = await tenant();
    try {
      fs.writeFileSync(path.join(t.memoryDir, 'owner.md'), 'Keep owner data');
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      t.service.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT, 'synthetic chunk failure'); END");
      const failure = await t.client.callTool({ name: 'apply_import', arguments: { batchId: preview.batchId } });
      expect(failure.isError).toBe(true);
      expect(JSON.stringify(failure.content)).toContain('import rolled back');
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported/fixture/People/Ada.md'))).toBe(false);
      expect(t.service.db.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 0 });
      expect(fs.readFileSync(path.join(t.memoryDir, 'owner.md'), 'utf8')).toBe('Keep owner data');
      expect(await call(t.client, 'undo_import', { batchId: preview.batchId })).toMatchObject({ retired: 0 });
    } finally { await t.client.close(); }
  });

  it('never executes JavaScript frontmatter from uploaded notes', async () => {
    const t = await tenant();
    try {
      for (const opening of ['---js', '---javascript', '\uFEFF---javascript']) {
        const reply = await t.client.callTool({ name: 'preview_import', arguments: { label: 'fixture', files: [{
          relativePath: 'untrusted.md', markdown: `${opening}\n(globalThis.__hostedImportExecuted = true, {})\n---\n# Untrusted`,
        }] } });
        expect(reply.isError).toBe(true);
        expect((globalThis as any).__hostedImportExecuted).toBeUndefined();
      }
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported'))).toBe(false);
    } finally { await t.client.close(); }
  });

  it('refuses YAML alias bombs inside the byte cap before writing anything', async () => {
    const t = await tenant();
    try {
      let yaml = 'a0: &a0 [x,x,x,x,x,x,x,x]\n';
      for (let i = 1; i <= 8; i++) yaml += `a${i}: &a${i} [${Array(8).fill(`*a${i - 1}`).join(',')}]\n`;
      const markdown = `---\n${yaml}---\n# Bomb`;
      expect(Buffer.byteLength(markdown)).toBeLessThan(1000);
      const started = Date.now();
      const reply = await t.client.callTool({ name: 'preview_import', arguments: { label: 'fixture', files: [{ relativePath: 'bomb.md', markdown }] } });
      expect(reply.isError).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported'))).toBe(false);
    } finally { await t.client.close(); }
  });

  it('reports a note replaced by a symlink as preserved instead of aborting undo', async () => {
    const t = await tenant();
    try {
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      await call(t.client, 'apply_import', { batchId: preview.batchId });
      const target = path.join(t.memoryDir, 'Imported/fixture', fixtureFiles[0].relativePath);
      const outside = path.join(path.dirname(t.memoryDir), 'outside-secret.txt');
      fs.writeFileSync(outside, 'OUTSIDE');
      fs.rmSync(target);
      fs.symlinkSync(outside, target);
      const undone = await call(t.client, 'undo_import', { batchId: preview.batchId });
      expect(undone.preserved).toContain(`Imported/fixture/${fixtureFiles[0].relativePath}`);
      expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE');
    } finally { await t.client.close(); }
  });

  it('refuses a flat alias of one large scalar before writing anything', async () => {
    const t = await tenant();
    try {
      const flat = (width: number, count: number) => `---\nbig: &big ${'x'.repeat(width)}\nlist: [${Array(count).fill('*big').join(', ')}]\n---\n# Flat`;
      // 10,000 aliases of a 30,000-character scalar: the most a note under the 64 KiB cap can expand to (300 MB).
      const worst = `---\nb: &b ${'x'.repeat(30_000)}\nl: [${Array(10_000).fill('*b').join(',')}]\n---\n# Flat`;
      // A 15 KB note that serializes to 5 MB, a 62 KB note that serializes to 72 MB, and the worst case above.
      for (const markdown of [flat(2_500, 2_000), flat(8_000, 9_000), worst]) {
        expect(Buffer.byteLength(markdown)).toBeLessThan(IMPORT_LIMITS.fileBytes);
        const before = process.cpuUsage();
        const reply = await t.client.callTool({ name: 'preview_import', arguments: { label: 'fixture', files: [{ relativePath: 'flat.md', markdown }] } });
        const cpu = process.cpuUsage(before);
        expect(reply.isError).toBe(true);
        // CPU time, not wall time: a busy host stretches the wall clock but not the work done. Refusing costs well
        // under 150 ms of CPU; serializing the 300 MB expansion first costs over 900 ms. The budget sits between them.
        // The exact guards (elements touched, peak memory in a fresh process) are in tests/indexer/frontmatter-bound-work.test.ts.
        expect((cpu.user + cpu.system) / 1000, 'CPU ms to refuse').toBeLessThan(750);
      }
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported'))).toBe(false);
      expect(t.service.db.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 0 });
    } finally { await t.client.close(); }
  });

  it('still imports ordinary YAML anchors, aliases and merge keys', async () => {
    const t = await tenant();
    try {
      const markdown = '---\nbase: &base {kind: person, tags: [a, b]}\ncopy: *base\nmerged:\n  <<: *base\n  name: Ada\n---\n# Anchored\n\nAda keeps notes about anchors.';
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files: [{ relativePath: 'anchored.md', markdown }] });
      expect(preview.toWrite).toBe(1);
      await call(t.client, 'apply_import', { batchId: preview.batchId });
      const row = t.service.db.prepare("SELECT frontmatter_json FROM notes WHERE path LIKE '%anchored.md'").get() as { frontmatter_json: string };
      expect(JSON.parse(row.frontmatter_json).merged).toEqual({ kind: 'person', tags: ['a', 'b'], name: 'Ada' });
    } finally { await t.client.close(); }
  });

  it('refuses a note on every retry when its first parse failed, instead of serving it from a cache', async () => {
    const t = await tenant();
    try {
      const broken = [
        '---\nsecret: [invalid\n---\nbody',
        "---\nrun: !!js/function 'function () { return 1; }'\n---\nbody",
        `---\ndeep: ${'['.repeat(2_000)}${']'.repeat(2_000)}\n---\nbody`,
      ];
      for (const markdown of broken) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const reply = await t.client.callTool({ name: 'preview_import', arguments: { label: 'fixture', files: [{ relativePath: 'broken.md', markdown }] } });
          expect(reply.isError, `attempt ${attempt}: ${markdown.slice(0, 24)}`).toBe(true);
        }
      }
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported'))).toBe(false);
      expect(t.service.db.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 0 });
    } finally { await t.client.close(); }
  });

  it('treats a symlinked ancestor as preserved and still undoes the rest of the batch', async () => {
    const t = await tenant();
    try {
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      await call(t.client, 'apply_import', { batchId: preview.batchId });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-import-outside-'));
      tmpDirs.push(outside);
      const people = path.join(t.memoryDir, 'Imported/fixture/People');
      fs.renameSync(people, path.join(outside, 'People'));
      fs.symlinkSync(path.join(outside, 'People'), people);
      const undone = await call(t.client, 'undo_import', { batchId: preview.batchId });
      expect(undone).toMatchObject({ retired: 1, preserved: ['Imported/fixture/People/Ada.md'] });
      expect(fs.readFileSync(path.join(outside, 'People/Ada.md'), 'utf8')).toBe(fixtureFiles[0].markdown);
      expect(fs.lstatSync(people).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported/fixture/Projects/Launch.md'))).toBe(false);
      const journal = journalOf(t.memoryDir, preview.batchId);
      expect(journal.state).toBe('undone');
      expect(journal.created.find(n => n.relPath === 'Imported/fixture/People/Ada.md')?.retired).toBeFalsy();
      expect(journal.created.find(n => n.relPath === 'Imported/fixture/Projects/Launch.md')?.retired).toBe(true);
      // The owner puts the directory back. The preserved note was never marked retired, so a later undo takes it.
      fs.rmSync(people);
      fs.renameSync(path.join(outside, 'People'), people);
      expect(await call(t.client, 'undo_import', { batchId: preview.batchId })).toMatchObject({ retired: 1, preserved: [] });
      expect(fs.existsSync(path.join(people, 'Ada.md'))).toBe(false);
      expect(journalOf(t.memoryDir, preview.batchId).created.every(n => n.retired)).toBe(true);
    } finally { await t.client.close(); }
  });

  it('treats a note path replaced by a directory as preserved and still undoes the rest of the batch', async () => {
    const t = await tenant();
    try {
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      await call(t.client, 'apply_import', { batchId: preview.batchId });
      const ada = path.join(t.memoryDir, 'Imported/fixture/People/Ada.md');
      fs.rmSync(ada);
      fs.mkdirSync(ada);
      fs.writeFileSync(path.join(ada, 'owner.md'), 'Owner data');
      const undone = await call(t.client, 'undo_import', { batchId: preview.batchId });
      expect(undone).toMatchObject({ retired: 1, preserved: ['Imported/fixture/People/Ada.md'] });
      expect(fs.readFileSync(path.join(ada, 'owner.md'), 'utf8')).toBe('Owner data');
      expect(journalOf(t.memoryDir, preview.batchId).created.find(n => n.relPath === 'Imported/fixture/People/Ada.md')?.retired).toBeFalsy();
    } finally { await t.client.close(); }
  });

  it('does not mark a dangling symlink retired, and leaves the link in place', async () => {
    const t = await tenant();
    try {
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files: fixtureFiles });
      await call(t.client, 'apply_import', { batchId: preview.batchId });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-import-outside-'));
      tmpDirs.push(outside);
      const ada = path.join(t.memoryDir, 'Imported/fixture/People/Ada.md');
      fs.rmSync(ada);
      fs.symlinkSync(path.join(outside, 'missing.md'), ada);
      expect(fs.existsSync(ada)).toBe(false);
      const undone = await call(t.client, 'undo_import', { batchId: preview.batchId });
      expect(undone).toMatchObject({ retired: 1, preserved: ['Imported/fixture/People/Ada.md'] });
      expect(fs.lstatSync(ada).isSymbolicLink()).toBe(true);
      const journal = journalOf(t.memoryDir, preview.batchId);
      expect(journal.created.find(n => n.relPath === 'Imported/fixture/People/Ada.md')?.retired).toBeFalsy();
      expect(journal.created.find(n => n.relPath === 'Imported/fixture/Projects/Launch.md')?.retired).toBe(true);
      // Only once the link itself is gone is there nothing left to preserve.
      fs.rmSync(ada);
      expect(await call(t.client, 'undo_import', { batchId: preview.batchId })).toMatchObject({ retired: 0, preserved: [] });
      expect(journalOf(t.memoryDir, preview.batchId).created.every(n => n.retired)).toBe(true);
    } finally { await t.client.close(); }
  });

});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('hosted vault import with the secret guard (RENOR_SECRET_GUARD) on', () => {
  // A planted synthetic key (scripts/eval/secret-guard/plantedSet.ts), as the guard's own tests use.
  const TOKEN = KEY_SHAPES.github(new Rng(20261003));
  const keysNote = { relativePath: 'Projects/keys.md', markdown: `# Keys\n\nThe deploy token is ${TOKEN}.\n` };
  const keysPath = 'Imported/fixture/Projects/keys.md';

  it('a dry run lists the notes the guard leaves out, by path and field and never their text, and apply writes only the rest', async () => {
    const t = await tenant();
    try {
      process.env.RENOR_SECRET_GUARD = '0';
      const open = await call(t.client, 'preview_import', { label: 'fixture', files: [...fixtureFiles, keysNote] });
      expect('secretGuard' in open).toBe(false); // with the guard off the dry run is what it was
      expect(open.toWrite).toBe(3);

      vi.spyOn(console, 'warn').mockImplementation(() => {}); // the guard logs one line per note it leaves out
      process.env.RENOR_SECRET_GUARD = '1';
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files: [...fixtureFiles, keysNote] });
      expect(preview.secretGuard).toEqual({ notes: [{ ref: keysPath, field: 'content', reason: 'credential' }], events: [] });
      expect(preview.toWrite).toBe(2);
      expect(JSON.stringify(preview)).not.toContain(TOKEN.slice(-14));
      expect(await call(t.client, 'apply_import', { batchId: preview.batchId })).toMatchObject({ notesWritten: 2 });
      expect(fs.existsSync(path.join(t.memoryDir, keysPath))).toBe(false);
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported/fixture/People/Ada.md'))).toBe(true);
    } finally { await t.client.close(); }
  });

  it('an undo keeps a note the guard will not retire, reports it preserved and undoes the rest; a later undo retries it', async () => {
    const t = await tenant();
    try {
      // Imported while the guard was off: text that is already stored is what retiring has to move.
      process.env.RENOR_SECRET_GUARD = '0';
      const preview = await call(t.client, 'preview_import', { label: 'fixture', files: [...fixtureFiles, keysNote] });
      expect(await call(t.client, 'apply_import', { batchId: preview.batchId })).toMatchObject({ notesWritten: 3 });

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.RENOR_SECRET_GUARD = '1';
      const undone = await call(t.client, 'undo_import', { batchId: preview.batchId });
      expect(undone).toMatchObject({ retired: 2, preserved: [keysPath] });
      expect(fs.readFileSync(path.join(t.memoryDir, keysPath), 'utf8')).toBe(keysNote.markdown);
      expect(fs.existsSync(path.join(t.memoryDir, 'Imported/fixture/People/Ada.md'))).toBe(false);
      expect(journalOf(t.memoryDir, preview.batchId).created.find(n => n.relPath === keysPath)?.retired).toBeFalsy();

      process.env.RENOR_SECRET_GUARD = '0';
      expect(await call(t.client, 'undo_import', { batchId: preview.batchId })).toMatchObject({ retired: 1, preserved: [] });
      expect(fs.existsSync(path.join(t.memoryDir, keysPath))).toBe(false);
      expect(journalOf(t.memoryDir, preview.batchId).created.every(n => n.retired)).toBe(true);
    } finally { await t.client.close(); }
  });
});
