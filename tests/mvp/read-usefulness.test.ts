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
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { ReadUsefulness, contextItems, factItem, noteItem } from '../../src/mvp/readUsefulness';
import { emitTelemetry, flushTelemetry, type TelemetryEvent } from '../../src/mvp/telemetry';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Whether a read helped, measured by the engine alone (readUsefulness.ts): metadata-only events, a use inferred inside
 * this process, no content anywhere. Synthetic data, eval-hash embeddings, loopback only; no paid model is called.
 */

// ---- the tracker, with its clock and its sink in hand ------------------------------------------------------------

const MINUTE = 60_000;

function tracker(env: NodeJS.ProcessEnv = {}) {
  const events: TelemetryEvent[] = [];
  let clock = Date.parse('2026-10-06T12:00:00.000Z');
  const t = new ReadUsefulness(event => events.push(event), () => clock, env);
  return { t, events, advance: (ms: number) => { clock += ms; }, used: () => events.filter(e => e.event === 'read_used') };
}

describe('ReadUsefulness: what a served read says', () => {
  it('emits counts and opaque ids, never anything of the items', () => {
    const { t, events } = tracker();
    t.served('get_context', [factItem('Atlas Project', 'owner'), noteItem('Memory/Daily/2026-10-06.md'), { key: 'text:the vault code is SECRET-TEXT' }], true, true);
    expect(events).toHaveLength(1);
    const event = events[0] as Extract<TelemetryEvent, { event: 'read' }>;
    expect(event).toMatchObject({ event: 'read', tool: 'get_context', relevant: true, judged: true, items: 3 });
    expect(event.read).toMatch(/^[0-9a-f]{8}$/);
    expect(event.ids).toHaveLength(3);
    for (const id of event.ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
    const wire = JSON.stringify(event);
    for (const secret of ['Atlas', 'owner', 'Memory/Daily', '2026-10-06', 'SECRET-TEXT', 'vault']) expect(wire.toLowerCase()).not.toContain(secret.toLowerCase());
  });

  it('counts an item once however many times a reply holds it, and lists at most 20 ids', () => {
    const { t, events } = tracker();
    t.served('search_memory', [noteItem('a.md'), noteItem('a.md')], true, false);
    t.served('search_memory', Array.from({ length: 30 }, (_, i) => noteItem(`n${i}.md`)), true, false);
    const [first, second] = events as Array<Extract<TelemetryEvent, { event: 'read' }>>;
    expect(first.items).toBe(1);
    expect(second.items).toBe(30);
    expect(second.ids).toHaveLength(20);
  });

  it('makes ids that are the same within one tracker and unrelated between two workspaces', () => {
    const a = tracker();
    const b = tracker();
    for (const x of [a, b]) x.t.served('get_context', [noteItem('same.md')], true, true);
    a.t.served('get_context', [noteItem('same.md')], true, true);
    const ids = (events: TelemetryEvent[]) => (events as Array<Extract<TelemetryEvent, { event: 'read' }>>).map(e => e.ids[0]);
    expect(ids(a.events)[0]).toBe(ids(a.events)[1]);
    expect(ids(a.events)[0]).not.toBe(ids(b.events)[0]);
  });

  it('says relevant only from the engine\'s verdict when the reply has one', () => {
    expect(contextItems({ facts: [{ subject: 'x', predicate: 'y' }], memories: [], relevance: { relevant: false } })).toMatchObject({ relevant: false, judged: true });
    expect(contextItems({ facts: [{ subject: 'x', predicate: 'y' }], memories: [], relevance: { relevant: true } })).toMatchObject({ relevant: true, judged: true });
    expect(contextItems({ facts: [{ subject: 'x', predicate: 'y' }], memories: [] })).toMatchObject({ relevant: true, judged: false });
    expect(contextItems({ facts: [], memories: [] })).toMatchObject({ relevant: false, judged: false, items: [] });
  });
});

describe('ReadUsefulness: when a returned item counts as used', () => {
  it('counts a read in full of the same note, by note id or entry id, once per read', () => {
    const { t, events, used } = tracker();
    t.served('get_context', [noteItem('Memory/Daily/2026-10-06.md')], true, true);
    t.readInFull('Memory/Daily/other.md');
    t.readInFull('note:Memory/Notes/other.md');
    expect(used()).toHaveLength(0);
    t.readInFull('entry:Memory/Daily/2026-10-06.md#0123456789abcdef');
    expect(used()).toHaveLength(1);
    t.readInFull('note:Memory/Daily/2026-10-06.md');
    expect(used()).toHaveLength(1);
    const read = events[0] as Extract<TelemetryEvent, { event: 'read' }>;
    expect(used()[0]).toMatchObject({ event: 'read_used', tool: 'get_context', read: read.read, via: 'read', after_s: 0 });
  });

  it('counts a cite of a returned note, a memory id of it, or the subject of a returned fact', () => {
    const { t, used } = tracker();
    t.served('get_context', [noteItem('a.md')], true, true);
    t.served('retrieve_memory', [factItem('Atlas Project', 'owner')], true, false);
    t.cited(['unrelated.md', 'Someone Else']);
    expect(used()).toHaveLength(0);
    t.cited(['note:a.md']);
    t.cited(['  atlas   project ']);
    expect(used().map(e => (e as { via: string }).via)).toEqual(['cite', 'cite']);
  });

  it('counts a new value for the same subject and predicate, however it is spelled, and not another predicate', () => {
    const { t, used } = tracker();
    t.served('get_context', [factItem('Atlas Project', 'owner')], true, true);
    t.updated('Atlas Project', 'status');
    t.updated('Borealis', 'owner');
    expect(used()).toHaveLength(0);
    t.updated('atlas  PROJECT', 'Owner');
    expect(used()).toHaveLength(1);
    expect(used()[0]).toMatchObject({ via: 'update' });
  });

  it('marks every unused read that served the item, and each only once', () => {
    const { t, used } = tracker();
    t.served('get_context', [noteItem('a.md')], true, true);
    t.served('search_memory', [noteItem('a.md'), noteItem('b.md')], true, true);
    t.readInFull('note:a.md');
    expect(used().map(e => (e as { tool: string }).tool)).toEqual(['get_context', 'search_memory']);
    t.readInFull('note:b.md');
    expect(used()).toHaveLength(2);
  });

  it('uses a 30 minute window: 29 minutes in, 31 out', () => {
    const inside = tracker();
    inside.t.served('get_context', [noteItem('a.md')], true, true);
    inside.advance(29 * MINUTE);
    inside.t.readInFull('note:a.md');
    expect(inside.used()).toMatchObject([{ after_s: 29 * 60 }]);

    const outside = tracker();
    outside.t.served('get_context', [noteItem('a.md')], true, true);
    outside.advance(31 * MINUTE);
    outside.t.readInFull('note:a.md');
    expect(outside.used()).toHaveLength(0);
  });

  it('takes the window from RENOR_READ_USE_WINDOW_MINUTES, clamped, and ignores nonsense', () => {
    const wide = tracker({ RENOR_READ_USE_WINDOW_MINUTES: '60' });
    wide.t.served('get_context', [noteItem('a.md')], true, true);
    wide.advance(59 * MINUTE);
    wide.t.readInFull('note:a.md');
    expect(wide.used()).toHaveLength(1);

    const nonsense = tracker({ RENOR_READ_USE_WINDOW_MINUTES: 'soon' });
    nonsense.t.served('get_context', [noteItem('a.md')], true, true);
    nonsense.advance(31 * MINUTE);
    nonsense.t.readInFull('note:a.md');
    expect(nonsense.used()).toHaveLength(0);
  });

  it('does not track a read that served nothing relevant, so its nearest items can never become a use', () => {
    const { t, events, used } = tracker();
    t.served('get_context', [noteItem('a.md')], false, true);
    t.served('get_context', [], false, false);
    t.readInFull('note:a.md');
    expect(used()).toHaveLength(0);
    expect(events.map(e => (e as { relevant?: boolean }).relevant)).toEqual([false, false]);
  });

  it('never counts a use in another workspace: two trackers share nothing', () => {
    const a = tracker();
    const b = tracker();
    a.t.served('get_context', [noteItem('same.md'), factItem('Atlas', 'owner')], true, true);
    b.t.readInFull('note:same.md');
    b.t.cited(['same.md', 'Atlas']);
    b.t.updated('Atlas', 'owner');
    expect(a.used()).toHaveLength(0);
    expect(b.events).toHaveLength(0);
  });

  it('forgets what is older than the window and holds a bounded number of reads', () => {
    const { t, used, advance } = tracker();
    for (let i = 0; i < 400; i++) t.served('get_context', [noteItem(`n${i}.md`)], true, true);
    t.readInFull('note:n0.md'); // the oldest of 400 fell off the 300 kept
    expect(used()).toHaveLength(0);
    t.readInFull('note:n399.md');
    expect(used()).toHaveLength(1);
    advance(31 * MINUTE);
    t.readInFull('note:n398.md');
    expect(used()).toHaveLength(1);
  });
});

describe('telemetry refuses a read event that carries anything but counts and opaque ids', () => {
  afterEach(() => vi.restoreAllMocks());

  const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((args: unknown[]) => String(args[0]));

  it('drops an id that is text, a tool that is not a read tool and a negative delay', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const good = { event: 'read' as const, tool: 'get_context' as const, read: 'abcdef01', relevant: true, judged: true, items: 1, ids: ['01234567'] };
    emitTelemetry(good);
    emitTelemetry({ ...good, ids: ['the vault code'] });
    emitTelemetry({ ...good, read: 'Memory/Daily' });
    emitTelemetry({ ...good, tool: 'remember' as never });
    const used = { event: 'read_used' as const, tool: 'search_memory' as const, read: 'abcdef01', via: 'cite' as const, after_s: 5 };
    emitTelemetry(used);
    emitTelemetry({ ...used, via: 'the user said' as never });
    emitTelemetry({ ...used, after_s: -3 });
    expect(lines(log).map(line => JSON.parse(line).event)).toEqual(['read', 'read_used']);
  });

  it('drops a read event whose values are not plain strings, booleans and counts: a regex or a comparison must not coerce them', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // An object that reads as a valid id when it is coerced to a string, and writes out something else when it is serialised.
    const sneaky = { toString: () => 'abcdef01', secret: 'HOSTILE-CANARY-OBJECT' };
    const good = { event: 'read' as const, tool: 'get_context' as const, read: 'abcdef01', relevant: true, judged: true, items: 1, ids: ['01234567'] };
    const used = { event: 'read_used' as const, tool: 'search_memory' as const, read: 'abcdef01', via: 'cite' as const, after_s: 5 };
    const bad: unknown[] = [
      { ...good, read: sneaky },
      { ...good, read: ['abcdef01'] },
      { ...good, ids: [sneaky] },
      { ...good, ids: [['01234567']] },
      { ...good, ids: { length: 1, 0: '01234567', note: 'HOSTILE-CANARY-OBJECT' } },
      { ...good, tool: { toString: () => 'get_context', note: 'HOSTILE-CANARY-OBJECT' } },
      { ...good, items: '1' },
      { ...good, items: 1.5 },
      { ...good, items: Number.NaN },
      { ...good, items: Infinity },
      { ...good, items: -1 },
      { ...good, relevant: 'true' },
      { ...good, judged: 1 },
      { ...used, read: sneaky },
      { ...used, tool: { toString: () => 'search_memory', note: 'HOSTILE-CANARY-OBJECT' } },
      { ...used, via: { toString: () => 'cite', note: 'HOSTILE-CANARY-OBJECT' } },
      { ...used, via: ['cite'] },
      { ...used, after_s: '5' },
      { ...used, after_s: Number.NaN },
      { ...used, after_s: Infinity },
    ];
    for (const payload of bad) emitTelemetry(payload as never);
    expect(lines(log)).toHaveLength(0);
    emitTelemetry(good);
    emitTelemetry(used);
    expect(lines(log).map(line => JSON.parse(line).event)).toEqual(['read', 'read_used']);
  });

  it('drops a read event with any field outside the allowed set, however harmless it looks, and sends nothing to PostHog for it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.RENOR_POSTHOG_KEY = 'phc_test';
    try {
      const good = { event: 'read' as const, tool: 'get_context' as const, read: 'abcdef01', relevant: true, judged: true, items: 1, ids: ['01234567'] };
      const used = { event: 'read_used' as const, tool: 'search_memory' as const, read: 'abcdef01', via: 'cite' as const, after_s: 5 };
      emitTelemetry({ ...good, noteText: 'HOSTILE-CANARY-EXTRA', query: 'HOSTILE-CANARY-QUERY' } as never);
      emitTelemetry({ ...good, extra: 1 } as never);
      emitTelemetry({ ...used, subject: 'HOSTILE-CANARY-SUBJECT' } as never);
      const { items: _items, ...missing } = good;
      emitTelemetry(missing as never);
      expect(lines(log)).toHaveLength(0);
      emitTelemetry(good);
      emitTelemetry(used);
      await flushTelemetry();
      expect(lines(log).map(line => JSON.parse(line).event)).toEqual(['read', 'read_used']);
      for (const line of lines(log)) expect(line).not.toContain('HOSTILE');
      for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) expect(String(call[1].body)).not.toContain('HOSTILE');
    } finally {
      delete process.env.RENOR_POSTHOG_KEY;
      vi.unstubAllGlobals();
    }
  });
});

// ---- over the real MCP surface, two workspaces in one process ----------------------------------------------------

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';

interface Workspace {
  client: Client;
  running: MvpApp & { httpServer: import('http').Server };
  dirs: string[];
}

const open: Workspace[] = [];

afterEach(async () => {
  for (const ws of open.splice(0)) {
    await ws.client.close();
    ws.running.httpServer.close();
    await ws.running.close();
    for (const dir of ws.dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
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
  return loadMvpConfig();
}

async function startWorkspace(): Promise<Workspace> {
  const dirs = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-usefulness-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-')),
  ];
  const config = makeConfig(dirs[0], dirs[1], await freePort());
  const running = await startMvpService(config, new EvalHashEmbeddingProvider());
  const app = running.app;
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'usefulness-test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] }).expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorize.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  const client = new Client({ name: 'usefulness-test', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } } },
  ));
  const ws = { client, running, dirs };
  open.push(ws);
  return ws;
}

const call = async (ws: Workspace, name: string, args: Record<string, unknown>) =>
  JSON.parse(((await ws.client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text);

/** Every read and read_used event the engines wrote to stdout since the spy was set, parsed. */
function recorder() {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const all = () => spy.mock.calls
    .map(call => String(call[0]))
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as Record<string, any>)
    .filter(event => event.event === 'read' || event.event === 'read_used');
  return {
    all,
    reads: () => all().filter(e => e.event === 'read'),
    used: () => all().filter(e => e.event === 'read_used'),
    wire: () => JSON.stringify(all()),
  };
}

const FACT = { subject: 'Atlas Project', predicate: 'owner' };
const NOTE = 'The Atlas launch checklist lives in the Notion space called Harbor';

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('read usefulness over MCP, two workspaces holding the same things', () => {
  it('records served reads and infers each kind of use, inside the workspace that was read, with no content in any event', async () => {
    const events = recorder();
    const a = await startWorkspace();
    const b = await startWorkspace();
    const noteIds: string[] = [];
    for (const ws of [a, b]) {
      await call(ws, 'save_memory', { ...FACT, object: 'Ana Moreira' });
      const saved = await call(ws, 'remember', { statement: NOTE });
      expect(saved.mode).toBe('note');
      noteIds.push(saved.id);
    }
    expect(events.all()).toHaveLength(0); // saves are not reads

    // A reads: served, relevant (no verdict armed here, so it counts as relevant because it returned something).
    const first = await call(a, 'get_context', { query: 'who owns the Atlas Project' });
    expect(first.facts.length).toBeGreaterThan(0);
    expect(events.reads()).toHaveLength(1);
    expect(events.reads()[0]).toMatchObject({ event: 'read', tool: 'get_context', relevant: true, judged: false });
    expect(events.reads()[0].items).toBeGreaterThan(0);
    expect(events.reads()[0].ids.length).toBe(events.reads()[0].items);

    // B does everything that would be a use in A, and A's read stays unused.
    await call(b, 'get_context', { query: 'who owns the Atlas Project' });
    await call(b, 'read_memory', { id: noteIds[1] });
    await call(b, 'save_memory', { ...FACT, object: 'Bea Costa', cites: ['Atlas Project'] });
    expect(events.used().length).toBeGreaterThan(0); // B's own read was followed by use in B
    expect(events.used().map(e => e.read)).toEqual(expect.not.arrayContaining([events.reads()[0].read]));
    const afterB = events.used().length;

    // A updates the fact: the first read is followed by use, once.
    await call(a, 'save_memory', { ...FACT, object: 'Cleo Dias' });
    expect(events.used()).toHaveLength(afterB + 1);
    expect(events.used().at(-1)).toMatchObject({ event: 'read_used', tool: 'get_context', read: events.reads()[0].read, via: 'update' });
    await call(a, 'save_memory', { ...FACT, object: 'Dora Eze' });
    expect(events.used()).toHaveLength(afterB + 1);

    // An identical save is no update.
    const second = await call(a, 'get_context', { query: 'who owns the Atlas Project' });
    expect(second.facts[0].object).toBe('Dora Eze');
    await call(a, 'save_memory', { ...FACT, object: 'Dora Eze' });
    expect(events.used()).toHaveLength(afterB + 1);

    // A reads the note in full: a read of it that was served is followed by use.
    const third = await call(a, 'get_context', { query: 'where does the launch checklist live' });
    const served = third.memories.find((m: { notePath: string }) => m.notePath);
    expect(served).toBeDefined();
    const before = events.used().length;
    await call(a, 'read_memory', { id: noteIds[0] });
    expect(events.used().length).toBeGreaterThan(before);
    expect(events.used().at(-1)).toMatchObject({ via: 'read', tool: 'get_context' });

    // A save that cites a note a read returned is followed by use as well.
    const fourth = await call(a, 'search_memory', { query: 'launch checklist Notion Harbor' });
    const hit = fourth.hits.find((h: { notePath: string }) => h.notePath);
    expect(hit).toBeDefined();
    const beforeCite = events.used().length;
    await call(a, 'remember_note', { text: 'Moved the checklist plan forward', cites: [hit.notePath] });
    expect(events.used().length).toBeGreaterThan(beforeCite);
    expect(events.used().at(-1)).toMatchObject({ via: 'cite', tool: 'search_memory', read: events.reads().at(-1)!.read });

    // retrieve_memory serves the facts of a subject, and the cite names its subject.
    await call(a, 'retrieve_memory', { subject: 'Atlas Project' });
    expect(events.reads().at(-1)).toMatchObject({ tool: 'retrieve_memory', relevant: true, judged: false });
    const beforeSubject = events.used().length;
    await call(a, 'remember', { statement: 'Dora also leads the review', cites: ['atlas project'] });
    expect(events.used().length).toBeGreaterThan(beforeSubject);
    expect(events.used().at(-1)).toMatchObject({ via: 'cite', tool: 'retrieve_memory', read: events.reads().at(-1)!.read });

    // An unknown subject serves nothing relevant.
    await call(a, 'retrieve_memory', { subject: 'Nothing Like This' });
    expect(events.reads().at(-1)).toMatchObject({ tool: 'retrieve_memory', relevant: false, items: 0 });

    // No event holds anything of a memory, a query, a path or a name.
    const wire = events.wire();
    for (const secret of ['Atlas', 'Ana', 'Bea', 'Cleo', 'Dora', 'Moreira', 'Notion', 'Harbor', 'checklist', 'Memory/', '.md', 'owner', 'launch', 'who owns']) {
      expect(wire).not.toContain(secret);
    }
    for (const event of events.all()) {
      for (const [key, value] of Object.entries(event)) {
        if (['ts', 'instance', 'event', 'tool', 'via', 'after_s'].includes(key)) continue;
        if (['read'].includes(key)) expect(value).toMatch(/^[0-9a-f]{8}$/);
        if (key === 'ids') for (const id of value as string[]) expect(id).toMatch(/^[0-9a-f]{8}$/);
      }
    }
  }, 60_000);

  it('serves a failed read as no event, and keeps cites optional', async () => {
    const events = recorder();
    const ws = await startWorkspace();
    const res = await ws.client.callTool({ name: 'retrieve_memory', arguments: {} });
    expect(res.isError).toBe(true);
    expect(events.all()).toHaveLength(0);
    // Every save works with no cites, with null cites and with cites that name nothing.
    for (const cites of [undefined, null, ['nothing.md']]) {
      const saved = await ws.client.callTool({ name: 'remember_note', arguments: { text: 'no cites needed', ...(cites === undefined ? {} : { cites }) } });
      expect(saved.isError).not.toBe(true);
    }
    const tools = (await ws.client.listTools()).tools;
    for (const name of ['remember', 'save_memory', 'remember_note']) {
      const schema = tools.find(t => t.name === name)!.inputSchema as { required?: string[]; properties: Record<string, { description?: string }> };
      expect(schema.required ?? []).not.toContain('cites');
      expect(schema.properties.cites.description).toContain('Optional, never required');
    }
  }, 60_000);
});
