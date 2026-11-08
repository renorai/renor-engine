import { describe, it, expect, afterAll, afterEach } from 'vitest';
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
import { engineRememberNote } from '../../src/mvp/engine';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * First-week scout, F5: retire_memory takes an id that only memory_map gave, so forgetting one note cost an agent the
 * whole map (37.5 KB on day 4, 115 KB on day 14, past Claude Code's 25,000-token cap for one tool result). memory_map
 * now takes a query: the memories (and retired memories) that have its words, so "forget X" is two small calls and
 * "bring X back" is too. Over the real MCP surface, synthetic data only, no embeddings.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const open: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
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
  const reg = await request(app).post('/register')
    .send({ client_name: 'forget-lookup', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

interface Answer { isError: boolean; raw: string; body: any }

/**
 * A workspace holding `files` (vault-relative path -> text) and the daily entries `notes`, written as remember_note writes
 * them (engineRememberNote is its writer) and indexed once. remember_note itself also runs an index pass on every call
 * since #328, which for a week of entries put this setup at most of the 5 s a test has on a busy host. Calls are
 * sequential: the default stateless mode shares one MCP server.
 */
async function startWorkspace(files: Record<string, string>, notes: Array<{ text: string; date: string }>) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-forget-lookup-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(memoryDir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, rel), text);
  }
  const config = makeConfig(memoryDir, authRoot, await freePort());
  const service = await startMvpService(config);
  const client = new Client({ name: 'forget-lookup', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${await authorize(service.app)}` } } },
  ));
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Answer> => {
    const res = await client.callTool({ name, arguments: args });
    const raw = (res.content as Array<{ text: string }>)[0].text;
    return { isError: Boolean(res.isError), raw, body: res.isError ? null : JSON.parse(raw) };
  };
  open.push({
    async close() {
      await client.close();
      service.httpServer.closeAllConnections?.();
      service.httpServer.close();
      await service.close();
      for (const dir of [memoryDir, authRoot]) fs.rmSync(dir, { recursive: true, force: true });
    },
  });
  for (const n of notes) await engineRememberNote(config, n.text, n.date, 'claude-code');
  expect((await call('index_memory')).isError).toBe(false);
  return { call, client, memoryDir };
}

/** A week of ordinary work: entries that share no word with the ones a test looks for. */
function filler(days: number, perDay: number): Array<{ text: string; date: string }> {
  const out: Array<{ text: string; date: string }> = [];
  for (let d = 1; d <= days; d++) {
    for (let i = 0; i < perDay; i++) {
      out.push({ date: `2026-10-${String(d).padStart(2, '0')}`, text: `Atlas worklog ${d}.${i}: the shipments service handled ${100 + i} webhooks; queue depth stayed under ${20 + d}.` });
    }
  }
  return out;
}

const LANDLORD = 'My landlord, Mr. Duarte, wants the rent paid by the 5th of each month via PIX.';

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('forgetting one memory without the whole map (first-week scout F5)', () => {
  it('finds the memory by its words in a small answer, retires it, finds it again among the retired, and restores it', async () => {
    const ws = await startWorkspace({}, [...filler(6, 8), { date: '2026-10-04', text: LANDLORD }]);

    const whole = await ws.call('memory_map', { limit: 200 });
    expect(whole.body.memories.length).toBe(49);

    const found = await ws.call('memory_map', { query: 'landlord' });
    expect(found.isError).toBe(false);
    expect(found.body.memories.map((m: any) => m.title)).toEqual([LANDLORD]);
    const [memory] = found.body.memories;
    expect(memory.id).toMatch(/^entry:Memory\/Daily\/2026-10-04\.md#[0-9a-f]{16}$/);
    // Only what a lookup is for: no facts, links, things, topics or events of the whole workspace.
    expect(Object.keys(found.body).sort()).toEqual(['generatedAt', 'memories', 'ok', 'query', 'retired', 'truncated']);
    expect(found.body.truncated).toEqual({ memories: false, retired: false });
    // Small whatever the workspace holds: the whole map is tens of times larger already at 49 memories.
    expect(found.raw.length * 20).toBeLessThan(whole.raw.length);

    const retired = await ws.call('retire_memory', { id: memory.id });
    expect(retired.body).toMatchObject({ ok: true, action: 'retired', id: memory.id });
    const gone = await ws.call('search_text', { query: 'Duarte' });
    expect(gone.body.results.filter((r: any) => r.reason !== 'fact')).toEqual([]);

    // "Bring it back": the same lookup lists it among the retired, with the id restore_memory takes.
    const afterRetire = await ws.call('memory_map', { query: 'landlord' });
    expect(afterRetire.body.memories).toEqual([]);
    expect(afterRetire.body.retired).toHaveLength(1);
    expect(afterRetire.body.retired[0]).toMatchObject({ memoryId: memory.id, kind: 'entry', title: LANDLORD, savedAt: memory.at });
    const restored = await ws.call('restore_memory', { id: afterRetire.body.retired[0].id });
    expect(restored.body).toMatchObject({ ok: true, action: 'restored', id: memory.id });

    const back = await ws.call('memory_map', { query: 'landlord' });
    expect(back.body.memories).toEqual([memory]);
    expect(back.body.retired).toEqual([]);
  });

  it('a retired note file is found by a word only its body has, and comes back from that lookup', async () => {
    const ws = await startWorkspace({ 'Notes/house.md': '# House upkeep\n\nThe landlord wants the rent paid by the 5th.\n' }, filler(2, 3));
    const live = await ws.call('memory_map', { query: 'landlord' });
    expect(live.body.memories.map((m: any) => m.id)).toEqual(['note:Notes/house.md']);
    expect((await ws.call('retire_memory', { id: 'note:Notes/house.md' })).body.action).toBe('retired');

    // "landlord" is in the body only: neither the path nor the title has it. The note's copy in the retired area is read.
    const lookup = await ws.call('memory_map', { query: 'landlord' });
    expect(lookup.body.memories).toEqual([]);
    expect(lookup.body.retired).toHaveLength(1);
    expect(lookup.body.retired[0]).toMatchObject({ memoryId: 'note:Notes/house.md', kind: 'note', title: live.body.memories[0].title });
    expect((await ws.call('restore_memory', { id: lookup.body.retired[0].id })).body.action).toBe('restored');
    expect((await ws.call('memory_map', { query: 'landlord' })).body.memories.map((m: any) => m.id)).toEqual(['note:Notes/house.md']);
  });

  it('reads a retired note\'s copy only inside the retired area', async () => {
    const ws = await startWorkspace({
      'Notes/house.md': '# House upkeep\n\nThe landlord wants the rent paid by the 5th.\n',
      'Notes/outside.md': '# Outside\n\nThe zanzibarq key lives here.\n',
    }, []);
    expect((await ws.call('retire_memory', { id: 'note:Notes/house.md' })).body.action).toBe('retired');
    // A record whose stored copy is a live note outside the retired area. The engine never writes one; a lookup must not
    // read a file a record merely names.
    fs.appendFileSync(path.join(ws.memoryDir, '.trash', 'renor-retired', 'retired.jsonl'), `${JSON.stringify({
      rid: 'retired:00000000deadbeef', id: 'note:Notes/forged.md', kind: 'note', path: 'Notes/forged.md',
      title: 'Forged record', retiredAt: '2026-10-03T00:00:00.000Z', storedAt: 'Notes/outside.md',
    })}\n`);
    const found = await ws.call('memory_map', { query: 'zanzibarq' });
    expect(found.body.memories.map((m: any) => m.id)).toEqual(['note:Notes/outside.md']);
    expect(found.body.retired).toEqual([]);
    // Its own title still finds it, as the whole map lists it.
    expect((await ws.call('memory_map', { query: 'forged' })).body.retired.map((r: any) => r.id)).toEqual(['retired:00000000deadbeef']);
  });

  it('the rare word of a phrase decides: the landlord entry leads, not the newer ones that only say "note"', async () => {
    const notes = [
      { date: '2026-10-01', text: LANDLORD },
      ...[2, 3, 4, 5].map((d) => ({ date: `2026-10-0${d}`, text: `Note to self: water the plants on day ${d}.` })),
      { date: '2026-10-06', text: 'Standup notes: the release train leaves on Tuesday.' },
    ];
    const ws = await startWorkspace({}, notes);
    const found = await ws.call('memory_map', { query: 'the note about my landlord' });
    // Stop words do not count; "note" and "landlord" do, and the one memory with "landlord" weighs most.
    expect(found.body.memories[0].title).toBe(LANDLORD);
    expect(found.body.memories).toHaveLength(6);
    // Equal weights stay newest first.
    expect(found.body.memories.slice(1).map((m: any) => m.path)).toEqual([
      'Memory/Daily/2026-10-06.md', 'Memory/Daily/2026-10-05.md', 'Memory/Daily/2026-10-04.md',
      'Memory/Daily/2026-10-03.md', 'Memory/Daily/2026-10-02.md',
    ]);
  });

  it('a word matches where a word starts, in the text, the title or the path of a note', async () => {
    const ws = await startWorkspace(
      { 'Projects/Atlas/Architecture.md': '# Atlas architecture\n\nAtlas runs on Postgres 13 and deploys to Heroku.\n' },
      [
        { date: '2026-10-01', text: LANDLORD },
        { date: '2026-10-02', text: 'We rented a car for the Lisbon trip.' },
        { date: '2026-10-03', text: 'The current sprint ends on Friday.' },
      ],
    );
    const rent = await ws.call('memory_map', { query: 'rent' });
    expect(rent.body.memories.map((m: any) => m.title).sort()).toEqual([LANDLORD, 'We rented a car for the Lisbon trip.'].sort());

    const byPath = await ws.call('memory_map', { query: 'architecture' });
    expect(byPath.body.memories.map((m: any) => m.id)).toEqual(['note:Projects/Atlas/Architecture.md']);
    expect(byPath.body.memories[0]).toMatchObject({ kind: 'note', path: 'Projects/Atlas/Architecture.md' });

    expect((await ws.call('memory_map', { query: 'Heroku' })).body.memories.map((m: any) => m.id)).toEqual(['note:Projects/Atlas/Architecture.md']);
    expect((await ws.call('memory_map', { query: 'dentist' })).body.memories).toEqual([]);
  });

  it('returns 10 matches unless asked for more, says when there were more, and refuses a query with no word in it', async () => {
    // Past dates only: a future-dated entry is clamped to its write instant, so the tie order would not be fixed.
    const kestrel = Array.from({ length: 15 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, text: `Kestrel build ${i + 1} went to TestFlight.` }));
    const ws = await startWorkspace({}, [...kestrel, { date: '2026-09-20', text: LANDLORD }]);

    const first = await ws.call('memory_map', { query: 'kestrel' });
    expect(first.body.memories).toHaveLength(10);
    expect(first.body.truncated.memories).toBe(true);
    expect(first.body.memories[0].title).toBe('Kestrel build 15 went to TestFlight.');

    const all = await ws.call('memory_map', { query: 'kestrel', limit: 50 });
    expect(all.body.memories).toHaveLength(15);
    expect(all.body.truncated.memories).toBe(false);

    const none = await ws.call('memory_map', { query: 'a' });
    expect(none.isError).toBe(true);
    expect(none.raw).toMatch(/no word to look for/);
  });

  it('without a query the map is bounded at the default limit, and limit caps every list', async () => {
    const ws = await startWorkspace({}, filler(3, 4));
    const whole = await ws.call('memory_map');
    expect(Object.keys(whole.body).sort()).toEqual(['events', 'facts', 'generatedAt', 'limit', 'links', 'memories', 'ok', 'retired', 'things', 'topics', 'total', 'truncated']);
    expect(whole.body.limit).toBe(20);
    expect(whole.body.memories).toHaveLength(12);
    expect(whole.body.truncated.memories).toBe(false);

    const capped = await ws.call('memory_map', { limit: 5 });
    expect(capped.body.memories).toEqual(whole.body.memories.slice(0, 5));
    expect(capped.body.truncated.memories).toBe(true);
  });

  it('the tools say how to find one memory without loading the whole map', async () => {
    const ws = await startWorkspace({}, []);
    // The descriptions are the agent's only manual: retire_memory points at memory_map's query.
    const described = Object.fromEntries((await ws.client.listTools()).tools.map((t) => [t.name, t.description ?? '']));
    expect(described.retire_memory).toMatch(/memory_map with a query/);
    expect(described.memory_map).toMatch(/pass query/);
    expect(described.memory_map).toMatch(/limit bounds every list/);
  });
});
