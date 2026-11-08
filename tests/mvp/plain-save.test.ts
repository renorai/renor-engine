import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Saving a memory is one plain sentence: `remember({statement})`. The structured shape (subject, predicate and object
 * beside the statement, or `save_memory`) is still accepted exactly as before, and is what makes a later value replace
 * an earlier one. Both shapes are driven here through the real MCP tools of a keyword-only workspace, in memory.
 *
 * Why the plain shape is the documented default and not the only one: measured through these same tools on a world of
 * 24 values that each change once (scripts/bench/save-shape-ab.ts), a structured save leaves no line asserting only the
 * old value in a default get_context reply (0/24) where plain statements leave one in most replies, and only a
 * structured save can be read back by subject (retrieve_memory), found by lookup_entity, or recorded as a no-op when
 * repeated. The "what structure buys" block below pins those behaviours, so dropping the structure is a decision with a
 * failing test, not an accident of a refactor. Synthetic data only; no embeddings, no network.
 */

const HOOK_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
  'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'RENOR_READ_HONESTY',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A fresh keyword-only workspace. Calls are sequential: one shared stateless MCP server. */
async function startWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-save-'));
  const memoryDir = path.join(root, 'memory');
  const authRoot = path.join(root, 'auth');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    MVP_EMBEDDING_PROVIDER: 'none',
  });
  const app = createMvpApp(loadMvpConfig());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'plain-save', version: '0.1.0' });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    memoryDir,
    /** The result as the agent reads it. A schema rejection is a protocol error whose message is what the agent sees. */
    async call(name: string, args: Record<string, unknown> = {}) {
      try {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as any)[0].text as string;
        return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
      } catch (err) {
        return { isError: true, text: err instanceof Error ? err.message : String(err), body: null as any };
      }
    },
    /** Everything a reader is handed by get_context, in order: the current facts, then the memories. */
    async read(query: string, extra: Record<string, unknown> = {}): Promise<string[]> {
      const res = await this.call('get_context', { query, ...extra });
      expect(res.isError, res.text).toBe(false);
      return [
        ...(res.body.facts ?? []).map((f: any) => `${f.subject} ${f.predicate} ${f.object}`),
        ...(res.body.memories ?? []).map((m: any) => String(m.text)),
      ];
    },
    async close() {
      await client.close();
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Workspace = Awaited<ReturnType<typeof startWorkspace>>;

const someItem = (items: string[], word: string) => items.some(item => item.includes(word));

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a plain save: one argument, nothing to build', () => {
  let ws: Workspace;
  beforeAll(async () => { ws = await startWorkspace(); }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('remember({statement}) is a complete save: stored whole, indexed at once, found by get_context', async () => {
    const saved = await ws.call('remember', { statement: 'We moved the Fjord database to SQLite because it needs no server.' });
    expect(saved.body).toMatchObject({ ok: true, mode: 'note', scope: 'global', indexed: true });
    expect(saved.body.id).toMatch(/^entry:/);
    const back = await ws.call('read_memory', { id: saved.body.id });
    expect(back.isError, back.text).toBe(false);
    expect(back.text).toContain('We moved the Fjord database to SQLite because it needs no server.');
    expect(someItem(await ws.read('Which database does Fjord use now?'), 'SQLite')).toBe(true);
  });

  it('a client that fills every optional argument with null (or an empty string) saves exactly as if it had left them out', async () => {
    const nulls = await ws.call('remember', {
      statement: 'Standup moved to 10:30.', subject: null, predicate: null, object: null, scope: null, source: null, timezone: null,
    });
    expect(nulls.isError, nulls.text).toBe(false);
    expect(nulls.body).toMatchObject({ ok: true, mode: 'note', scope: 'global', indexed: true });

    const blanks = await ws.call('remember', {
      statement: 'Retro moved to Friday.', subject: '', predicate: '', object: '', scope: '', source: '', timezone: '',
    });
    expect(blanks.isError, blanks.text).toBe(false);
    expect(blanks.body).toMatchObject({ ok: true, mode: 'note', scope: 'global', indexed: true });
    expect(someItem(await ws.read('When is the retro?'), 'Friday')).toBe(true);
  });

  it('remember_note({text}) is a complete save, nulls are omissions, and a long journal line is not refused at 2000', async () => {
    const note = await ws.call('remember_note', { text: 'Ran the nightly build; two flaky tests in the importer.' });
    expect(note.body).toMatchObject({ ok: true, indexed: true, scope: 'global' });
    const nulled = await ws.call('remember_note', { text: 'Release notes drafted.', date: null, source: null, scope: null, timezone: null });
    expect(nulled.isError, nulled.text).toBe(false);
    const blankDate = await ws.call('remember_note', { text: 'Roadmap reviewed.', date: '' });
    expect(blankDate.isError, blankDate.text).toBe(false);
    const long = await ws.call('remember_note', { text: `Status of the board: ${'item resolved, owner confirmed. '.repeat(75)}` });
    expect(long.isError, long.text).toBe(false);
    expect(long.body).toMatchObject({ ok: true });
  });

  it('the limit is one number: a note line of 4001 characters is refused as a statement is, and nothing is cut', async () => {
    const tooLong = await ws.call('remember_note', { text: 'x'.repeat(4001) });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toContain('4000');
    const statement = await ws.call('remember', { statement: 'x'.repeat(4001) });
    expect(statement.isError).toBe(true);
    expect(statement.text).toContain('4000');
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a structured save: the old shape is accepted exactly as before', () => {
  let ws: Workspace;
  beforeAll(async () => { ws = await startWorkspace(); }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('remember with subject, predicate and object stores a fact, repeats are no-ops and a new value supersedes', async () => {
    const first = await ws.call('remember', { statement: "Fjord's database is DuckDB.", subject: 'Fjord', predicate: 'database', object: 'DuckDB' });
    expect(first.body).toMatchObject({ ok: true, mode: 'fact', action: 'store', subject: 'Fjord', predicate: 'database' });
    const again = await ws.call('remember', { statement: "Fjord's database is DuckDB.", subject: 'Fjord', predicate: 'database', object: 'DuckDB' });
    expect(again.body).toMatchObject({ action: 'nochange' });
    const corrected = await ws.call('remember', { statement: "Fjord's database is SQLite.", subject: 'Fjord', predicate: 'database', object: 'SQLite' });
    expect(corrected.body).toMatchObject({ action: 'supersede', closed: { object: 'DuckDB' }, created: { object: 'SQLite' } });
  });

  it('the structured fields may travel with null for everything else', async () => {
    const saved = await ws.call('remember', {
      statement: 'Acme sprints last two weeks.', subject: 'Acme', predicate: 'sprint_length', object: 'two weeks', scope: null, source: null, timezone: null,
    });
    expect(saved.body).toMatchObject({ ok: true, mode: 'fact', action: 'store', scope: 'global' });
  });

  it('save_memory keeps its receipt, and takes null or an empty string for what it leaves out', async () => {
    const saved = await ws.call('save_memory', { subject: 'Acme', predicate: 'billing_provider', object: 'Stripe' });
    expect(saved.body).toMatchObject({ ok: true, action: 'store', subject: 'Acme', predicate: 'billing_provider' });
    expect(typeof saved.body.eventId).toBe('string');
    expect(typeof saved.body.ledger).toBe('string');
    const nulled = await ws.call('save_memory', { subject: 'Acme', predicate: 'billing_provider', object: 'Paddle', scope: null, source: '' });
    expect(nulled.body).toMatchObject({ ok: true, action: 'supersede', closed: { object: 'Stripe' } });
  });

  it('the schema an agent is shown still lists remember with one required argument and string-typed optionals', async () => {
    const { tools } = await ws.client.listTools();
    const schema = (name: string) => tools.find(tool => tool.name === name)!.inputSchema as { required?: string[]; properties: Record<string, { type?: unknown }> };
    expect(schema('remember').required).toEqual(['statement']);
    for (const field of ['subject', 'predicate', 'object', 'source', 'scope', 'timezone']) {
      expect(schema('remember').properties[field].type, `remember.${field}`).toBe('string');
    }
    expect(schema('remember_note').required).toEqual(['text']);
    for (const field of ['date', 'source', 'scope', 'timezone']) {
      expect(schema('remember_note').properties[field].type, `remember_note.${field}`).toBe('string');
    }
    for (const field of ['subject', 'predicate', 'object', 'source', 'scope']) {
      expect(schema('save_memory').properties[field].type, `save_memory.${field}`).toBe('string');
    }
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('what an agent is told, and what it is told when a save is refused', () => {
  let ws: Workspace;
  beforeAll(async () => { ws = await startWorkspace(); }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('the documented default is one plain argument, with a one-line example on every save tool', async () => {
    const { tools } = await ws.client.listTools();
    const description = (name: string) => tools.find(tool => tool.name === name)!.description ?? '';
    expect(description('remember')).toMatch(/^Save something to memory: pass `statement`, in plain words, and nothing else\./);
    expect(description('remember')).toContain('remember({"statement":');
    expect(description('remember_note')).toContain('remember_note({"text":');
    expect(description('remember_note')).toContain('`remember` saves a statement on its own the same way and is the default');
    expect(description('save_memory')).toContain('save_memory({"subject":');
    expect(description('save_memory')).toContain('call remember');
    expect(ws.client.getInstructions()).toContain('call remember with one argument, statement');
  });

  it('save_memory without its three fields says what to call instead, and saves nothing', async () => {
    const before = (await ws.call('memory_status')).body;
    for (const args of [{ statement: 'Decided: Acme moves to Paddle.' }, { text: 'Decided: Acme moves to Paddle.' }, {}]) {
      const refused = await ws.call('save_memory', args);
      expect(refused.isError, JSON.stringify(args)).toBe(true);
      expect(refused.text).toContain('save_memory saves one fact and needs subject, predicate and object (missing: subject, predicate, object)');
      expect(refused.text).toContain('call remember with only statement');
    }
    const partial = await ws.call('save_memory', { subject: 'Acme', predicate: 'billing_provider' });
    expect(partial.text).toContain('(missing: object)');
    expect((await ws.call('memory_status')).body).toMatchObject({ facts: before.facts, notes: before.notes });
  });

  it('remember with only some of the three says so, and that plain words need only the statement', async () => {
    const refused = await ws.call('remember', { statement: 'Decided: Fjord moves to SQLite.', subject: 'Fjord' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('subject, predicate, and object together, or none of them');
    expect(refused.text).toContain('pass only statement');
  });

  it('a value with a line break says where longer text goes, on both tools, and writes nothing', async () => {
    const before = (await ws.call('memory_status')).body;
    for (const [tool, extra] of [['remember', { statement: 'Fjord notes.' }], ['save_memory', {}]] as const) {
      const refused = await ws.call(tool, { ...extra, subject: 'Fjord', predicate: 'notes', object: 'line one\nline two' });
      expect(refused.isError, tool).toBe(true);
      expect(refused.text, tool).toContain('lifecycle object contains control characters');
      expect(refused.text, tool).toContain('Keep object to one line: longer text belongs in the statement of a remember call.');
    }
    expect((await ws.call('memory_status')).body).toMatchObject({ facts: before.facts, notes: before.notes });
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('what structure buys (pinned: dropping it is a decision, not an accident)', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    // The same kind of correction, saved both ways.
    await ws.call('remember', { statement: "Fjord's database is DuckDB.", subject: 'Fjord', predicate: 'database', object: 'DuckDB' });
    await ws.call('remember', { statement: "Birch's test runner is Jest." });
    await new Promise(resolve => setTimeout(resolve, 1100)); // the correction is a later second, as a real one is
    await ws.call('remember', { statement: "Fjord's database is SQLite.", subject: 'Fjord', predicate: 'database', object: 'SQLite' });
    await ws.call('remember', { statement: "Birch's test runner is Vitest." });
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a structured correction replaces the value: a default read hands over only the new one, history keeps the old', async () => {
    const now = await ws.read("What is Fjord's database now?");
    expect(someItem(now, 'SQLite')).toBe(true);
    expect(someItem(now, 'DuckDB')).toBe(false);
    const history = await ws.read("What was Fjord's database before?", { include_history: true });
    expect(someItem(history, 'DuckDB')).toBe(true);
  });

  it('only a structured save can be read back by subject and predicate, with its history', async () => {
    const current = await ws.call('retrieve_memory', { subject: 'Fjord', predicate: 'database' });
    expect(current.body.facts).toHaveLength(1);
    expect(current.body.facts[0]).toMatchObject({ object: 'SQLite', current: true });
    const history = await ws.call('retrieve_memory', { subject: 'Fjord', predicate: 'database', include_history: true });
    expect(history.body.facts.map((f: any) => f.object).sort()).toEqual(['DuckDB', 'SQLite']);
    const plain = await ws.call('retrieve_memory', { subject: 'Birch' });
    expect(plain.body).toMatchObject({ facts: [], known: false });
  });

  it('only a structured subject is an entity lookup_entity finds', async () => {
    expect((await ws.call('lookup_entity', { name: 'Fjord' })).body.entity).toMatchObject({ canonicalName: 'Fjord' });
    expect((await ws.call('lookup_entity', { name: 'Birch' })).body.entity ?? null).toBeNull();
  });

  it('a plain correction is a second note: nothing is retired, so a default read hands over both statements', async () => {
    const now = await ws.read("What is Birch's test runner now?");
    expect(someItem(now, 'Vitest')).toBe(true);
    expect(someItem(now, 'Jest')).toBe(true);
  });

  it('the same fact saved again is a no-op when structured and a second entry when plain', async () => {
    const fact = { statement: 'Acme was founded in 2014.', subject: 'Acme', predicate: 'founded_year', object: '2014' };
    expect((await ws.call('remember', fact)).body).toMatchObject({ action: 'store' });
    expect((await ws.call('remember', fact)).body).toMatchObject({ action: 'nochange' });
    const statement = 'Rotterdam is where Acme has its headquarters.';
    const first = await ws.call('remember', { statement });
    expect((await ws.call('remember', { statement })).body).toMatchObject({ ok: true, mode: 'note' });
    // Plain words are a log: each save is its own entry (an id hashes the entry with its second, so two in one second share it).
    const day = fs.readFileSync(path.join(ws.memoryDir, first.body.file), 'utf8');
    expect(day.split(statement).length - 1).toBe(2);
  });
});
