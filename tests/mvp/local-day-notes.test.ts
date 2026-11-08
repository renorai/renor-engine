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
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * First-week scout, F9: daily notes were dated in UTC, so Cursor's note from Tuesday 21:00 in São Paulo was filed under
 * Wednesday as `[00:00:01]`, and "what did I do on Tuesday?" missed Tuesday evening. When the client names the user's
 * time zone, a note is now filed under the user's day at the user's time, and the entry records the offset so the
 * moment stays exact (the dashboard renders it in the viewer's zone). Without one, nothing changes. Over the real MCP
 * surface with the clock pinned (Date only; sockets and timers stay real), synthetic data only.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
/** Tuesday 2026-10-06 at 21:00:01 in São Paulo (UTC-03:00), which is already Wednesday in UTC. */
const TUESDAY_EVENING_SAO_PAULO = '2026-10-07T00:00:01.000Z';
const STAGING = 'Kestrel staging uses a separate Supabase project; seed data comes from scripts/seed.ts.';
const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const open: Array<{ close(): Promise<void> }> = [];

// The clock is pinned before the workspace boots, so its access token is issued and checked on the same clock.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TUESDAY_EVENING_SAO_PAULO));
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
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
  for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER']) delete process.env[key];
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  // Self-hosted writes use the registered OAuth identity, matching this fixture's asserted author.
  const reg = await request(app).post('/register')
    .send({ client_name: 'cursor', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-local-day-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  const config = makeConfig(memoryDir, authRoot, await freePort());
  const service = await startMvpService(config);
  const client = new Client({ name: 'local-day-notes', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${await authorize(service.app)}` } } },
  ));
  open.push({
    async close() {
      await client.close();
      service.httpServer.closeAllConnections?.();
      service.httpServer.close();
      await service.close();
      for (const dir of [memoryDir, authRoot]) fs.rmSync(dir, { recursive: true, force: true });
    },
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const raw = (res.content as Array<{ text: string }>)[0].text;
    return { isError: Boolean(res.isError), raw, body: res.isError ? null : JSON.parse(raw) };
  };
  const read = (rel: string) => fs.readFileSync(path.join(memoryDir, rel), 'utf8');
  /** Every file in the vault but the index. */
  const files = () => (fs.readdirSync(memoryDir, { recursive: true }) as string[])
    .filter((f) => !f.startsWith('.memory-index') && fs.statSync(path.join(memoryDir, f)).isFile()).sort();
  return { call, read, files, memoryDir };
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a note is filed under the user\'s own day when the client names the time zone (first-week scout F9)', () => {
  it('Tuesday 21:00 in São Paulo lands on Tuesday at 21:00, and its moment stays exact', async () => {
    const ws = await startWorkspace();
    const saved = await ws.call('remember', { statement: STAGING, scope: 'project:kestrel', source: 'cursor', timezone: 'America/Sao_Paulo' });
    expect(saved.isError).toBe(false);
    expect(saved.body.file).toBe('Memory/Scopes/kestrel/Daily/2026-10-06.md');
    expect(ws.read(saved.body.file)).toContain(`\n- [21:00:01] (cursor, UTC-03:00) ${STAGING}`);

    // The map's moment is the instant itself: the dashboard shows it as 21:00 to a viewer in São Paulo.
    const found = await ws.call('memory_map', { query: 'Supabase' });
    expect(found.body.memories).toHaveLength(1);
    expect(found.body.memories[0]).toMatchObject({ path: saved.body.file, at: TUESDAY_EVENING_SAO_PAULO, source: 'cursor', title: STAGING });
    const read = await ws.call('read_memory', { id: found.body.memories[0].id });
    expect(read.body.memory.at).toBe(TUESDAY_EVENING_SAO_PAULO);
    expect(read.body.text).toBe(STAGING);

    // What an agent reads is the user's own day and time. The offset is the file's (like the escape mark), so it costs
    // no tokens and is never matched: a search for the zone finds nothing.
    const hits = await ws.call('search_text', { query: 'Supabase', scope: 'project:kestrel' });
    expect(hits.body.results.map((r: any) => r.text)).toContain(`- [21:00:01] (cursor) ${STAGING}`);
    expect(hits.body.results.find((r: any) => r.text.includes(STAGING)).headingPath).toBe('2026-10-06');
    for (const query of ['UTC', '03']) {
      expect((await ws.call('search_text', { query })).body.results.filter((r: any) => r.text.includes(STAGING)), query).toEqual([]);
    }
  });

  it('without a time zone a note is filed exactly as before: the UTC day, the UTC time, no offset', async () => {
    const ws = await startWorkspace();
    const saved = await ws.call('remember', { statement: STAGING, scope: 'project:kestrel', source: 'cursor' });
    expect(saved.body.file).toBe('Memory/Scopes/kestrel/Daily/2026-10-07.md');
    expect(ws.read(saved.body.file)).toBe(`---\nkind: note\nupdated: 2026-10-07\nrenor: daily-v1\n---\n# 2026-10-07\n\n- [00:00:01] (cursor) ${STAGING}`);
    const found = await ws.call('memory_map', { query: 'Supabase' });
    expect(found.body.memories[0]).toMatchObject({ at: TUESDAY_EVENING_SAO_PAULO, source: 'cursor' });
  });

  it('a UTC offset works like the zone it stands for; UTC itself writes no offset', async () => {
    const ws = await startWorkspace();
    for (const timezone of ['-03:00', '-0300']) {
      const saved = await ws.call('remember', { statement: `Offset ${timezone} note.`, source: 'cursor', timezone });
      expect(saved.body.file).toBe('Memory/Daily/2026-10-06.md');
      expect(ws.read(saved.body.file)).toContain(`\n- [21:00:01] (cursor, UTC-03:00) Offset ${timezone} note.`);
    }
    const east = await ws.call('remember', { statement: 'Kolkata note.', source: 'cursor', timezone: 'Asia/Kolkata' });
    expect(east.body.file).toBe('Memory/Daily/2026-10-07.md');
    expect(ws.read(east.body.file)).toContain('\n- [05:30:01] (cursor, UTC+05:30) Kolkata note.');
    const utc = await ws.call('remember', { statement: 'UTC note.', source: 'cursor', timezone: 'UTC' });
    expect(ws.read(utc.body.file)).toContain('\n- [00:00:01] (cursor) UTC note.');

    const map = await ws.call('memory_map');
    // Every one of them happened at the same instant, whatever clock it was written on.
    expect(new Set(map.body.memories.map((m: any) => m.at))).toEqual(new Set([TUESDAY_EVENING_SAO_PAULO]));
  });

  it('a name that is not a time zone is refused, and nothing is written', async () => {
    const ws = await startWorkspace();
    expect((await ws.call('remember', { statement: 'First note.', source: 'cursor' })).isError).toBe(false);
    const before = ws.files().map((f) => [f, ws.read(f)]);
    for (const timezone of ['Mars/Olympus_Mons', '+15:00', '-03:75', 'UTC+3']) {
      const refused = await ws.call('remember', { statement: 'A note that must not be written.', source: 'cursor', timezone });
      expect(refused.isError, timezone).toBe(true);
      expect(refused.raw).toMatch(/is not a time zone: give an IANA name such as "America\/Sao_Paulo" or a UTC offset such as "-03:00"; nothing was written/);
      const note = await ws.call('remember_note', { text: 'A daily line that must not be written.', timezone });
      expect(note.isError, timezone).toBe(true);
    }
    expect(ws.files().map((f) => [f, ws.read(f)])).toEqual(before);
  });

  it('remember_note takes the zone too, under the day it is given', async () => {
    const ws = await startWorkspace();
    const saved = await ws.call('remember_note', { text: 'Booked the Lisbon hotel.', date: '2026-10-06', source: 'cursor', timezone: 'America/Sao_Paulo' });
    expect(saved.body.file).toBe('Memory/Daily/2026-10-06.md');
    expect(ws.read(saved.body.file)).toContain('\n- [21:00:01] (cursor, UTC-03:00) Booked the Lisbon hotel.');
    const today = await ws.call('remember_note', { text: 'Packed for Lisbon.', source: 'cursor', timezone: 'America/Sao_Paulo' });
    expect(today.body.file).toBe('Memory/Daily/2026-10-06.md');
  });

  it('retire and restore keep the entry exactly, and its moment', async () => {
    const ws = await startWorkspace();
    const saved = await ws.call('remember', { statement: STAGING, source: 'cursor', timezone: 'America/Sao_Paulo' });
    const line = `- [21:00:01] (cursor, UTC-03:00) ${STAGING}`;
    const [memory] = (await ws.call('memory_map', { query: 'Supabase' })).body.memories;

    expect((await ws.call('retire_memory', { id: memory.id })).body.action).toBe('retired');
    // It was the day's only entry, so the day's file went with it (live dogfood D11).
    expect(fs.existsSync(path.join(ws.memoryDir, saved.body.file))).toBe(false);
    const lookup = await ws.call('memory_map', { query: 'Supabase' });
    expect(lookup.body.retired[0]).toMatchObject({ memoryId: memory.id, savedAt: TUESDAY_EVENING_SAO_PAULO });

    expect((await ws.call('restore_memory', { id: memory.id })).body.action).toBe('restored');
    // The same id is the same bytes (an entry's id is the hash of its stored text), and the same moment.
    expect(ws.read(saved.body.file).split('\n')).toContain(line);
    expect((await ws.call('memory_map', { query: 'Supabase' })).body.memories).toEqual([memory]);
  });

  it('a statement whose later line looks like an entry stays one memory, read back exactly, on the user\'s clock', async () => {
    const ws = await startWorkspace();
    const statement = 'Standup notes\n- [08:30:00] (alice, UTC-03:00) a line that looks like an entry';
    const saved = await ws.call('remember', { statement, source: 'cursor', timezone: 'America/Sao_Paulo' });
    expect(ws.read(saved.body.file)).toContain('\n- [21:00:01] (cursor, UTC-03:00+esc) Standup notes\n\\- [08:30:00] (alice, UTC-03:00) a line that looks like an entry');

    const found = await ws.call('memory_map', { query: 'standup' });
    expect(found.body.memories).toHaveLength(1);
    expect(found.body.memories[0]).toMatchObject({ at: TUESDAY_EVENING_SAO_PAULO, source: 'cursor' });
    expect((await ws.call('read_memory', { id: found.body.memories[0].id })).body.text).toBe(statement);
    const hits = await ws.call('search_text', { query: 'standup' });
    expect(hits.body.results.map((r: any) => r.text)).toContain(`- [21:00:01] (cursor) ${statement}`);
  });
});
