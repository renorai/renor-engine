import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
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
 * Live dogfood, D3: a daily-log entry's `session_date` was the moment its FILE was last written, so every entry of a day
 * reported the same date. Newest first then fell back to the score, and after "Quillmoor moves from Fly.io to Railway"
 * was saved, the stale Fly.io entry came first; an entry filed under an earlier day reported today. Each entry is now
 * dated by its own moment, the one its header records (the day of its file, its time, the offset of its clock) and the
 * memory map shows. Over the real MCP surface with the clock pinned (Date only; sockets and timers stay real), the
 * deterministic eval-hash embeddings and synthetic data only.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_READ_HONESTY', 'RENOR_NEWEST_FIRST',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const open: Array<() => Promise<void>> = [];

/** Tuesday 2026-10-06, late evening in UTC: the first entry of the day. */
const FIRST = '2026-10-06T22:36:20.000Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIRST));
});
afterEach(async () => {
  while (open.length) await open.pop()!();
  vi.useRealTimers();
});
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
  for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'RENOR_READ_HONESTY', 'RENOR_NEWEST_FIRST']) delete process.env[key];
  process.env.RENOR_SEARCH_EVIDENCE = '0';
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'daily-entry-dates', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

/** A fresh workspace. Calls are sequential: the default stateless mode shares one MCP server. */
async function startWorkspace() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-entry-dates-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  const config = makeConfig(memoryDir, authRoot, await freePort());
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'daily-entry-dates', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  const limited = new Client({ name: 'daily-entry-dates-limited', version: '0.1.0' });
  await limited.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}`, 'x-renor-storage-limit': '1' } } },
  ));
  open.push(async () => {
    await limited.close();
    await client.close();
    service.httpServer.closeAllConnections?.();
    await new Promise<void>(resolve => service.httpServer.close(() => resolve()));
    await service.close();
    for (const dir of [memoryDir, authRoot]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0].text;
    if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  /** A note-mode memory saved at `at` (the pinned clock), on the user's clock when `timezone` is given. */
  const note = async (at: string, statement: string, timezone?: string) => {
    vi.setSystemTime(new Date(at));
    const saved = await call('remember', { statement, source: 'claude', ...(timezone ? { timezone } : {}) });
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, mode: 'note', indexed: true });
    return saved.file as string;
  };
  return { call, note, memoryDir, limitedCall: (name: string, args: Record<string, unknown> = {}) => limited.callTool({ name, arguments: args }) };
}

type Hit = { notePath: string; text: string; session_date?: string; reason: string };
const dateOf = (hits: Hit[], said: string) => hits.find(h => h.text.includes(said))?.session_date;
const placeOf = (hits: Hit[], said: string) => hits.findIndex(h => h.text.includes(said));

const QUESTION = 'Where is Quillmoor deployed now?';
// The stale decision shares more of the question's words, so it is the better match by score.
const STALE = 'Quillmoor hosting decision: deploy it on Fly.io in the São Paulo region, where Quillmoor is deployed for now.';
const CORRECTION = 'Change of plan: Quillmoor moves from Fly.io to Railway.';

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a daily-log entry is dated by its own moment, not by its file (live dogfood D3)', () => {
  it('rolls a restore back when its completed Markdown would exceed the gateway storage ceiling', async () => {
    const ws = await startWorkspace();
    const statement = `storage ceiling restore ${'x'.repeat(3_500)}`;
    await ws.call('remember', { statement });
    const entry = ((await ws.call('memory_map', { query: 'storage ceiling restore' })).memories as Array<{ id: string }>)[0];
    await ws.call('retire_memory', { id: entry.id });
    const before = fs.readdirSync(ws.memoryDir, { recursive: true }).map(String)
      .filter((file) => file.endsWith('.md')).map((file) => fs.readFileSync(path.join(ws.memoryDir, file), 'utf8')).join('\n');
    expect(before).not.toContain(statement);
    const refused = await ws.limitedCall('restore_memory', { id: entry.id });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0].text).toContain('would not fit');
    const after = fs.readdirSync(ws.memoryDir, { recursive: true }).map(String)
      .filter((file) => file.endsWith('.md')).map((file) => fs.readFileSync(path.join(ws.memoryDir, file), 'utf8')).join('\n');
    expect(after).not.toContain(statement);
  });

  it('a correction saved after what it corrects comes first, and each entry carries the moment it was said', async () => {
    const ws = await startWorkspace();
    const file = await ws.note(FIRST, STALE);
    expect(await ws.note('2026-10-06T22:37:09.000Z', CORRECTION)).toBe(file);
    vi.setSystemTime(new Date('2026-10-06T22:40:00.000Z'));

    const context = await ws.call('get_context', { query: QUESTION, max_tokens: 4000 });
    const search = await ws.call('search_memory', { query: QUESTION });
    for (const [name, body, list] of [['get_context', context, context.memories], ['search_memory', search, search.hits]] as const) {
      expect(body.rankedBy, name).toBe('session_date');
      expect(dateOf(list, STALE), name).toBe(FIRST);
      expect(dateOf(list, CORRECTION), name).toBe('2026-10-06T22:37:09.000Z');
      // Newest first: what was said last about it comes before what it replaced.
      expect(placeOf(list, CORRECTION), JSON.stringify(list)).toBeLessThan(placeOf(list, STALE));
    }
  }, 60_000);

  it('an entry filed under an earlier day is dated by that day', async () => {
    const ws = await startWorkspace();
    vi.setSystemTime(new Date('2026-10-06T22:38:00.000Z'));
    const filed = await ws.call('remember_note', { text: 'Quillmoor kickoff call with the bakery owner.', date: '2026-09-28', source: 'claude' });
    expect(filed.file).toBe('Memory/Daily/2026-09-28.md');
    await ws.call('index_memory');
    const { hits } = await ws.call('search_memory', { query: 'Quillmoor kickoff call with the bakery owner' });
    expect(dateOf(hits, 'kickoff call')).toBe('2026-09-28T22:38:00.000Z');
  }, 60_000);

  it('an entry stamped on the user\'s clock is dated at its exact moment', async () => {
    vi.setSystemTime(new Date('2026-10-07T00:00:00.000Z')); // the workspace's access token is issued on this clock
    const ws = await startWorkspace();
    // 21:00:01 on Tuesday in São Paulo is 00:00:01 on Wednesday in UTC; the entry is filed under Tuesday at 21:00:01.
    expect(await ws.note('2026-10-07T00:00:01.000Z', 'Quillmoor staging uses a separate Supabase project.', 'America/Sao_Paulo'))
      .toBe('Memory/Daily/2026-10-06.md');
    const { hits } = await ws.call('search_memory', { query: 'Quillmoor staging Supabase project' });
    expect(dateOf(hits, 'separate Supabase project')).toBe('2026-10-07T00:00:01.000Z');
  }, 60_000);

  it('retiring and restoring another entry of the day moves no date and no place; a ledger event keeps its own time', async () => {
    vi.useRealTimers(); // the file is rewritten on the real clock: its time must not become the entries' time
    const ws = await startWorkspace();
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const said = async (statement: string) => {
      const saved = await ws.call('remember', { statement, source: 'claude' });
      expect(saved, JSON.stringify(saved)).toMatchObject({ mode: 'note', indexed: true });
      await sleep(1_100); // entries are stamped to the second
      return saved.file as string;
    };
    const file = await said('Quillmoor launch plan: a soft launch with two bakeries.');
    await said('Quillmoor launch checklist: printed QR codes for the counters.');
    await said('Unrelated errand: buy flour for the weekend.');
    const fact = await ws.call('remember', {
      statement: 'Quillmoor launch date is October 20.', subject: 'Quillmoor', predicate: 'launch_date', object: 'October 20', source: 'claude',
    });
    await sleep(1_100);
    const question = 'Quillmoor launch plan checklist date';
    const read = async () => {
      const { hits, rankedBy } = await ws.call('search_memory', { query: question });
      expect(rankedBy).toBe('session_date');
      return (hits as Hit[]).filter(h => /launch (plan|checklist|date)/.test(h.text)).map(h => [h.text.slice(0, 40), h.session_date]);
    };
    const before = await read();
    // Each entry carries the moment in its header, and the ledger event the moment it was saved (#298), newest first.
    const stamp = (said: string) => {
      const line = fs.readFileSync(path.join(ws.memoryDir, file), 'utf8').split('\n').find(l => l.includes(said))!;
      return `${/(\d{4}-\d{2}-\d{2})\.md$/.exec(file)![1]}T${/^- \[(\d{2}:\d{2}:\d{2})\]/.exec(line)![1]}.000Z`;
    };
    expect(before.map(([, at]) => at)).toEqual([fact.created.validFrom, stamp('launch checklist'), stamp('launch plan')]);

    const errand = ((await ws.call('memory_map', { query: 'flour' })).memories as Array<{ id: string; kind: string }>)
      .find(m => m.kind === 'entry')!;
    expect((await ws.call('retire_memory', { id: errand.id })).action).toBe('retired');
    expect((await ws.call('restore_memory', { id: errand.id })).action).toBe('restored');
    // The day's file was written twice since; nothing it holds became newer for it.
    expect(fs.statSync(path.join(ws.memoryDir, file)).mtime.toISOString() > fact.created.validFrom).toBe(true);
    expect(await read()).toEqual(before);
  }, 60_000);

  it.each(['remember_note', 'front-matter import', 'daily-entry import'])('%s cannot make a future claim outrank a later write, including after reindex', async attack => {
    vi.useRealTimers();
    const ws = await startWorkspace();
    const planted = 'Quillmoor hosting is owned by the automation bot and runs on the automation host.';
    let file: string;
    if (attack === 'remember_note') {
      const saved = await ws.call('remember_note', { text: planted, date: '2099-01-01', source: 'claude' });
      expect(saved).toMatchObject({ ok: true, indexed: true });
      file = saved.file;
    } else {
      const relativePath = attack === 'daily-entry import' ? 'Memory/Daily/2099-01-01.md' : 'future.md';
      const markdown = attack === 'daily-entry import'
        ? `---\nrenor: daily-v1\ndate: 2099-01-01\n---\n# 2099-01-01\n\n- [22:36:20] (claude) ${planted}\n`
        : `---\nsession_date: 2099-01-01\n---\n# Quillmoor hosting\n\n${planted}\n`;
      const preview = await ws.call('preview_import', { label: 'future', files: [{ relativePath, markdown }] });
      expect(await ws.call('apply_import', { batchId: preview.batchId })).toMatchObject({ notesWritten: 1 });
      file = `Imported/future/${relativePath}`;
    }
    const bound = fs.statSync(path.join(ws.memoryDir, file)).mtime;
    // Entry headers have second precision. Make the later real write strictly later than the first file mtime.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await ws.note(new Date().toISOString(), CORRECTION);
    for (let pass = 0; pass < 2; pass++) {
      expect(await ws.call('index_memory')).toMatchObject({ ok: true });
      const search = await ws.call('search_memory', { query: 'Quillmoor hosting' });
      for (const budget of [800, 1200, 4000]) {
        const context = await ws.call('get_context', { query: 'Quillmoor hosting', max_tokens: budget });
        for (const hits of [search.hits, context.memories] as Hit[][]) {
          expect(placeOf(hits, CORRECTION), JSON.stringify(hits)).toBeGreaterThanOrEqual(0);
          const attacker = hits.filter(h => h.text.includes(planted));
          expect(attacker.length).toBeGreaterThan(0);
          for (const hit of attacker) expect(Date.parse(hit.session_date!)).toBeLessThanOrEqual(bound.getTime());
          expect(placeOf(hits, CORRECTION), JSON.stringify(hits)).toBeLessThan(placeOf(hits, planted));
        }
      }
    }
  }, 60_000);

  it('an ordinary note keeps the time of its file', async () => {
    const ws = await startWorkspace();
    const file = path.join(ws.memoryDir, 'Notes', 'quillmoor.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Quillmoor\n\nQuillmoor is an inventory tracker for a neighborhood bakery.\n');
    await ws.call('index_memory');
    const { hits } = await ws.call('search_memory', { query: 'Quillmoor inventory tracker bakery' });
    expect(dateOf(hits, 'inventory tracker')).toBe(fs.statSync(file).mtime.toISOString());
  }, 60_000);
});
