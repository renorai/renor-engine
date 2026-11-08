import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import type Database from '../../src/db/sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * What memory_status counts, driven through the real MCP tools over the authenticated Streamable HTTP endpoint.
 * Synthetic data only (mkdtemp memory dirs, loopback, the deterministic eval-hash embeddings).
 *
 * The new-user re-check (finding N5) saved two notes and one fact and read NOTES 3, FACTS 2, ENTITIES 3 on the
 * Memories tab, where the dashboard says "counted, not estimated" and sums the three to decide whether a workspace
 * holds anything at all. None of the extra rows was something the stranger said:
 *  - the engine keeps two notes of its own, the synthetic `_mcp_` row that owns the facts' subjects and the ledger
 *    file that records them, and both were counted as notes (the ledger's own entity was counted as an entity);
 *  - the engine writes `updated: YYYY-MM-DD` into every daily note, YAML reads that as a Date, and the indexer
 *    stored the Date printed in the host's timezone as a "fact" of the note: one per day, a different text on each
 *    host, and served to an agent as a current fact by retrieve_memory.
 *
 * Only a note the engine wrote loses that row, and the engine's note is told by its front matter alone: the marker its
 * writer stamps on the notes it creates, or the complete front matter it wrote before it had one. A person's own daily
 * note, a log of timestamped lines in the engine's own entry format included, keeps its `updated`.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const TEST_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'RENOR_SEARCH_EVIDENCE', 'TZ',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

/** The header the engine writes when it creates the ledger file (memory/lifecycle.ts), byte for byte. */
const LEDGER_HEADER = '---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Memory Events Ledger\n\nAppend-only durable record of memory events. Replayed on rebuild.\n';

/** The text finding N5 read in the `updated` fact of a daily note, on a host in America/Sao_Paulo. */
const HOST_TIMEZONE_DATE = 'Fri Oct 02 2026 21:00:00 GMT-0300 (Brasilia Standard Time)';

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

function makeConfig(memoryDir: string, authRoot: string, port: number, ledgerRel?: string): MvpConfig {
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
  process.env.RENOR_SEARCH_EVIDENCE = '0';
  if (ledgerRel) process.env.MVP_LEDGER_REL = ledgerRel;
  else delete process.env.MVP_LEDGER_REL;
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'inventory-counts', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

interface WorkspaceOptions {
  /** `MVP_LEDGER_REL`: where this workspace keeps its ledger. */
  ledgerRel?: string;
  /** Files already in the memory directory when the service starts. */
  seed?: (memoryDir: string) => void;
  /** Start on a memory directory a stopped workspace left behind (its index, ledger and notes), as a restart does. */
  dir?: string;
}

/** An authenticated service on its own memory dir, or on one a stopped workspace left. Calls are sequential: one shared stateless MCP server. */
async function startWorkspace(options: WorkspaceOptions = {}) {
  const memoryDir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-inventory-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  if (!options.dir) options.seed?.(memoryDir);
  let stopped = false;
  const config = makeConfig(memoryDir, authRoot, await freePort(), options.ledgerRel);
  const service = await startMvpService(config, new EvalHashEmbeddingProvider());
  const token = await authorize(service.app);
  const client = new Client({ name: 'inventory-counts', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  const workspace = {
    service, memoryDir, client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ text: string }>)[0].text;
      if (res.isError) throw new Error(`${name} failed: ${text}`);
      return JSON.parse(text);
    },
    /** The three numbers the Memories header shows, and the dashboard sums to decide whether anything is held. */
    async counts() {
      const { notes, facts, entities } = await workspace.call('memory_status');
      return { notes, facts, entities };
    },
    /** Stop the service and keep the memory directory: what the host does when it restarts the engine. */
    async stop() {
      if (stopped) return;
      stopped = true;
      await client.close();
      service.httpServer.closeAllConnections?.();
      await new Promise<void>(resolve => service.httpServer.close(() => resolve()));
      await service.close();
    },
    async close() {
      await workspace.stop();
      fs.rmSync(memoryDir, { recursive: true, force: true });
      fs.rmSync(authRoot, { recursive: true, force: true });
    },
  };
  open.push(workspace);
  return workspace;
}

type Workspace = Awaited<ReturnType<typeof startWorkspace>>;

/** What the stranger of finding N5 did, through an agent: two notes and one fact, on one day. */
async function strangerSaves(ws: Workspace): Promise<{ file: string; day: string }> {
  const first = await ws.call('remember', { statement: 'The mango juice stand closes at six.' });
  const second = await ws.call('remember', { statement: 'My dentist appointment is next Tuesday.' });
  await ws.call('remember', {
    statement: 'My favourite drink is mango juice',
    subject: 'Rowan', predicate: 'favourite_drink', object: 'mango juice',
  });
  // Both notes belong to one daily file; if the clock crossed UTC midnight between the two calls, say so.
  expect(second.file, 'the two notes were saved either side of UTC midnight; rerun').toBe(first.file);
  return { file: first.file as string, day: path.basename(first.file as string, '.md') };
}

/** The text an earlier build's indexer stored for the header of `day`: that day as a Date, printed on a host in São Paulo. */
function earlierBuildsText(day: string): string {
  process.env.TZ = 'America/Sao_Paulo';
  try {
    return String(new Date(`${day}T00:00:00Z`));
  } finally {
    if (savedEnv.TZ === undefined) delete process.env.TZ;
    else process.env.TZ = savedEnv.TZ;
  }
}

/** Make the `updated` fact of an indexed note the one an earlier build's indexer made of it (the date as a Date, printed in São Paulo), and only that one. */
function asEarlierBuildLeftIt(db: Database.Database, file: string, day: string): void {
  const entity = db.prepare('SELECT id FROM entities WHERE source_note = ?').get(file) as { id: number };
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM facts WHERE source_path = ? AND predicate = 'updated'`).run(file);
  db.prepare(
    `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at)
     VALUES (?, 'updated', ?, ?, 1.0, ?, ?)`,
  ).run(entity.id, earlierBuildsText(day), file, now, now);
}

/** The front matter and heading the engine wrote before it stamped its notes, as the files an existing workspace holds have it. */
const LEGACY_DAY = (day: string) => `---\nkind: note\nupdated: ${day}\n---\n# ${day}\n`;

/** A person's own daily note, in the very format the engine writes its entries in. */
const MY_LOG = (day: string) => `---\ntitle: Journal\nupdated: ${day}\n---\n# ${day}\n\n- [08:30:00] (alice) Met Bob for breakfast.\n- [12:10:00] (alice) Lunch with Carol.\n`;

function updatedFactCount(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM facts WHERE predicate = 'updated'`).get() as { c: number }).c;
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('memory_status counts what the user saved', () => {
  it('reads an empty workspace as empty', async () => {
    const ws = await startWorkspace();
    expect(await ws.counts()).toEqual({ notes: 0, facts: 0, entities: 0 });
  }, TEST_TIMEOUT_MS);

  it('reads two notes and one fact as one note file, one fact and two entities', async () => {
    const ws = await startWorkspace();
    await strangerSaves(ws);
    // Two notes were said, on one day, so they share one daily log: one note FILE. The facts are the one fact that
    // was said. The entities are what the index registers: the daily log by its title, and the fact's subject.
    // Before the fix: notes 3 (daily + `_mcp_` + ledger), facts 2 (+ the daily note's `updated`), entities 3 (+ ledger).
    expect(await ws.counts()).toEqual({ notes: 1, facts: 1, entities: 2 });
  }, TEST_TIMEOUT_MS);

  it('agrees with memory_map, the list the same screen shows under the numbers', async () => {
    const ws = await startWorkspace();
    await strangerSaves(ws);
    const status = await ws.call('memory_status');
    const map = await ws.call('memory_map');

    const noteFiles = new Set<string>(map.memories.map((m: { path: string }) => m.path));
    expect(map.memories).toHaveLength(2); // both notes the stranger said are listed
    expect(status.notes).toBe(noteFiles.size); // in the file(s) the header counts
    expect(status.facts).toBe(map.facts.length);
    // One entity for each note file and one for each subject a fact is about, and nothing else.
    expect(status.entities).toBe(noteFiles.size + map.things.length);
  }, TEST_TIMEOUT_MS);

  it('does not make a fact of the date the engine writes into its own daily notes, in any host timezone', async () => {
    // The finding was read on a host in America/Sao_Paulo; the same save on another host stored another text.
    const renderedIn = (zone: string) => {
      process.env.TZ = zone;
      return new Date('2026-10-03T00:00:00Z').toString();
    };
    expect(renderedIn('America/Sao_Paulo')).toContain('GMT-0300');
    expect(renderedIn('Pacific/Kiritimati')).toContain('GMT+1400');

    for (const zone of ['America/Sao_Paulo', 'Pacific/Kiritimati', 'UTC']) {
      process.env.TZ = zone;
      const ws = await startWorkspace();
      const { day } = await strangerSaves(ws);

      const rows = ws.service.db.prepare('SELECT predicate, object_text FROM facts').all() as Array<{ predicate: string; object_text: string }>;
      expect(rows, zone).toEqual([{ predicate: 'favourite_drink', object_text: 'mango juice' }]);

      // The date is the name of the daily note's entity, and an agent can ask about it: it must not be told a fact.
      const served = await ws.call('retrieve_memory', { subject: day });
      expect(served.facts, zone).toEqual([]);
      await ws.close();
      open.splice(open.indexOf(ws), 1);
    }
  }, TEST_TIMEOUT_MS);

  it('drops the header facts an earlier build indexed when the workspace restarts, and leaves everything a person wrote alone', async () => {
    // A workspace the way the previous release left it. The engine's daily notes of two days, whose headers are facts:
    // one it wrote before it stamped its notes (the front matter every note on disk from that release has) and one the
    // stranger has just saved. A person's own daily notes in the same folder, each with the `updated` fact that release
    // made of it: a natural `updated: 2026-03-29`, a quoted date, and a log of timestamped lines in the engine's own entry
    // format under a front matter of the person's own. And a fact a person told it, which is named `updated` too.
    const before = await startWorkspace({
      seed: (dir) => {
        fs.mkdirSync(path.join(dir, 'Daily'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'Daily', '2026-03-29.md'), '---\nupdated: 2026-03-29\n---\n# 2026-03-29\n\nA journal note.\n');
        fs.writeFileSync(path.join(dir, 'Daily', '2026-03-30.md'), '---\nupdated: "2026-03-30"\n---\n# 2026-03-30\n\nA journal note.\n');
        fs.writeFileSync(path.join(dir, 'Daily', '2026-03-28.md'), MY_LOG('2026-03-28'));
        fs.mkdirSync(path.join(dir, 'Memory', 'Daily'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'Memory', 'Daily', '2026-09-01.md'), `${LEGACY_DAY('2026-09-01')}\n- [09:00:00] (claude) Rain all day.\n`);
      },
    });
    const { file, day } = await strangerSaves(before);
    await before.call('remember', {
      statement: 'My phone was last updated then',
      subject: 'my phone', predicate: 'updated', object: HOST_TIMEZONE_DATE,
    });
    await before.call('index_memory');
    const db = before.service.db;
    asEarlierBuildLeftIt(db, path.join(before.memoryDir, file), day);
    asEarlierBuildLeftIt(db, path.join(before.memoryDir, 'Memory', 'Daily', '2026-09-01.md'), '2026-09-01');
    asEarlierBuildLeftIt(db, path.join(before.memoryDir, 'Daily', '2026-03-29.md'), '2026-03-29');
    asEarlierBuildLeftIt(db, path.join(before.memoryDir, 'Daily', '2026-03-28.md'), '2026-03-28');
    expect(updatedFactCount(db)).toBe(6); // the engine's two, the person's three, the fact about the phone
    const dir = before.memoryDir;
    await before.stop();

    const log = vi.spyOn(console, 'log');
    const after = await startWorkspace({ dir });
    // Nothing has been asked of it yet, and nothing has been indexed: the engine's rows went when it started, a person's did not.
    const left = (after.service.db.prepare(`SELECT source_path FROM facts WHERE predicate = 'updated' ORDER BY source_path`).all() as Array<{ source_path: string }>)
      .map(r => (r.source_path === '_mcp_' ? r.source_path : path.relative(dir, r.source_path)));
    expect(left).toEqual(['Daily/2026-03-28.md', 'Daily/2026-03-29.md', 'Daily/2026-03-30.md', '_mcp_']);
    // ...and it said how many, so an operator can see it happen once.
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/"event":"startup_header_facts_removed","facts":2,/));
    log.mockRestore();

    // What an agent is told: no header for either of the engine's days, and what a person wrote still there, to the byte.
    const told = async (subject: string) =>
      ((await after.call('retrieve_memory', { subject })).facts as Array<{ predicate: string; object: string }>).map(f => [f.predicate, f.object]);
    expect(await told(day)).toEqual([]);
    expect(await told('2026-09-01')).toEqual([]);
    expect(await told('2026-03-29')).toEqual([['updated', earlierBuildsText('2026-03-29')]]);
    expect(await told('2026-03-30')).toEqual([['updated', '2026-03-30']]);
    expect(await told('2026-03-28')).toEqual([['updated', earlierBuildsText('2026-03-28')]]);
    expect(await told('my phone')).toEqual([['updated', HOST_TIMEZONE_DATE]]);

    // Five note files (the engine's two days and the person's three), five facts (the drink, the phone and the three
    // `updated` of the person's notes), and an entity for each of the five notes and for each of the two subjects.
    expect(await after.counts()).toEqual({ notes: 5, facts: 5, entities: 7 });
    // The note the stranger saved carries the marker; the one the previous release wrote does not, and is told by its front matter.
    expect(fs.readFileSync(path.join(dir, file), 'utf8').startsWith('---\nkind: note\nupdated: ' + day + '\nrenor: daily-v1\n---\n')).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'Memory', 'Daily', '2026-09-01.md'), 'utf8')).not.toContain('renor:');
  }, TEST_TIMEOUT_MS);

  it('drops them when the workspace is re-indexed without a restart, though the notes have not changed, and keeps a person\'s own', async () => {
    const ws = await startWorkspace({
      seed: (dir) => {
        fs.mkdirSync(path.join(dir, 'Daily'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'Daily', '2026-03-29.md'), '---\nupdated: 2026-03-29\n---\n# 2026-03-29\n\nA journal note.\n');
        fs.writeFileSync(path.join(dir, 'Daily', '2026-03-28.md'), MY_LOG('2026-03-28'));
        fs.mkdirSync(path.join(dir, 'Memory', 'Daily'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'Memory', 'Daily', '2026-09-01.md'), `${LEGACY_DAY('2026-09-01')}\n- [09:00:00] (claude) Rain all day.\n`);
      },
    });
    const { file, day } = await strangerSaves(ws);
    await ws.call('index_memory');
    asEarlierBuildLeftIt(ws.service.db, path.join(ws.memoryDir, file), day);
    asEarlierBuildLeftIt(ws.service.db, path.join(ws.memoryDir, 'Memory', 'Daily', '2026-09-01.md'), '2026-09-01');
    asEarlierBuildLeftIt(ws.service.db, path.join(ws.memoryDir, 'Daily', '2026-03-29.md'), '2026-03-29');
    asEarlierBuildLeftIt(ws.service.db, path.join(ws.memoryDir, 'Daily', '2026-03-28.md'), '2026-03-28');
    expect(updatedFactCount(ws.service.db)).toBe(4);
    expect((await ws.call('retrieve_memory', { subject: day })).facts).toHaveLength(1); // the engine's header is being served
    expect((await ws.call('retrieve_memory', { subject: '2026-09-01' })).facts).toHaveLength(1);

    await ws.call('index_memory');

    expect(updatedFactCount(ws.service.db)).toBe(2); // the person's two
    expect((await ws.call('retrieve_memory', { subject: day })).facts).toEqual([]);
    expect((await ws.call('retrieve_memory', { subject: '2026-09-01' })).facts).toEqual([]);
    for (const own of ['2026-03-29', '2026-03-28']) {
      const told = (await ws.call('retrieve_memory', { subject: own })).facts as Array<{ predicate: string; object: string }>;
      expect(told.map(f => [f.predicate, f.object]), own).toEqual([['updated', earlierBuildsText(own)]]);
    }
    expect(await ws.counts()).toEqual({ notes: 4, facts: 3, entities: 5 });
  }, TEST_TIMEOUT_MS);

  it('reads a workspace that holds only the engine\'s own ledger as empty, so it is not counted as activated', async () => {
    // `notes + facts + entities > 0` is what the dashboard calls a workspace holding memory.
    const ws = await startWorkspace({
      seed: (dir) => {
        fs.mkdirSync(path.join(dir, 'System'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'System', 'Memory Events Ledger.md'), LEDGER_HEADER);
      },
    });
    const indexed = await ws.call('index_memory');
    expect(indexed.indexed).toBe(1);

    const status = await ws.call('memory_status');
    // The ledger really is in the index (it is searchable, and `chunks` is index size), it is just not a memory.
    expect(status.chunks).toBeGreaterThan(0);
    expect({ notes: status.notes, facts: status.facts, entities: status.entities }).toEqual({ notes: 0, facts: 0, entities: 0 });
  }, TEST_TIMEOUT_MS);

  it('leaves out the ledger this workspace is configured with, wherever it is, and counts a note that claims to be one', async () => {
    const ws = await startWorkspace({
      ledgerRel: 'Ledgers/events.md',
      seed: (dir) => {
        // Claims to be the ledger in its own front matter: still a user's note.
        fs.mkdirSync(path.join(dir, 'People'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'People', 'Sys.md'),
          '---\nkind: system\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n# Sys\n\nA note that says it is the ledger.\n',
        );
      },
    });
    await ws.call('remember', {
      statement: 'My favourite drink is mango juice',
      subject: 'Rowan', predicate: 'favourite_drink', object: 'mango juice',
    });
    expect(fs.existsSync(path.join(ws.memoryDir, 'Ledgers', 'events.md'))).toBe(true);
    // The index holds all three, so what the count leaves out is a choice and not an absence.
    const indexed = (ws.service.db.prepare('SELECT path FROM notes').all() as Array<{ path: string }>)
      .map(n => (n.path === '_mcp_' ? n.path : path.relative(ws.memoryDir, n.path)));
    expect(indexed.sort()).toEqual(['Ledgers/events.md', 'People/Sys.md', '_mcp_']);

    // The one note of the user's, and its entity and the fact's subject: not the configured ledger, not the `_mcp_` row.
    expect(await ws.counts()).toEqual({ notes: 1, facts: 1, entities: 2 });
  }, TEST_TIMEOUT_MS);

  it('counts a note that only has the default ledger\'s name when the ledger is configured elsewhere', async () => {
    const ws = await startWorkspace({
      ledgerRel: 'Ledgers/events.md',
      seed: (dir) => {
        fs.mkdirSync(path.join(dir, 'System'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'System', 'Memory Events Ledger.md'), '# Purchases\n\nBought a bike in May.\n');
      },
    });
    await ws.call('index_memory');
    expect(await ws.counts()).toEqual({ notes: 1, facts: 0, entities: 1 });
  }, TEST_TIMEOUT_MS);

  it('still counts every fact a person\'s own notes name, `updated` included, even in the daily layout', async () => {
    const ws = await startWorkspace({
      seed: (dir) => {
        fs.mkdirSync(path.join(dir, 'People'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'People', 'Acme.md'), '---\nstatus: active\nupdated: "2025-01-01"\n---\n# Acme\n\nAcme ships the mango press.\n');
        // A daily note of the person's own, under the engine's two keys and one more, over a body in free text.
        fs.mkdirSync(path.join(dir, 'Daily'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'Daily', '2026-03-30.md'), '---\nkind: note\nupdated: 2026-03-30\ntags: [journal]\n---\n# 2026-03-30\n\nDiscussed Alpha with John.\n');
        // And one under a front matter of their own over a log of timestamped lines in the engine's own entry format.
        fs.writeFileSync(path.join(dir, 'Daily', '2026-03-31.md'), MY_LOG('2026-03-31'));
      },
    });
    await ws.call('index_memory');

    const rows = ws.service.db.prepare('SELECT predicate FROM facts ORDER BY predicate').all() as Array<{ predicate: string }>;
    expect(rows.map(r => r.predicate)).toEqual(['status', 'tags', 'updated', 'updated', 'updated']); // Acme's two, and the daily notes' own three
    expect(await ws.counts()).toEqual({ notes: 3, facts: 5, entities: 3 });
  }, TEST_TIMEOUT_MS);

  it('gives lookup_entity the entity count memory_status gives', async () => {
    // Finding 18: a miss that names a different number of entities than memory_status reads as a contradiction.
    const ws = await startWorkspace();
    await strangerSaves(ws);
    const status = await ws.call('memory_status');
    const miss = await ws.call('lookup_entity', { name: 'nothing-is-called-this' });
    expect(miss.reason).toBe('no-entity-match');
    expect(miss.entitiesIndexed).toBe(status.entities);
    expect(status.entities).toBe(2);
  }, TEST_TIMEOUT_MS);

  it('says in its description what it counts', async () => {
    const ws = await startWorkspace();
    const described = (await ws.client.listTools()).tools.find((t) => t.name === 'memory_status')?.description ?? '';
    expect(described).toMatch(/one note per day/i);
    expect(described).toMatch(/ledger/i);
  }, TEST_TIMEOUT_MS);
});
