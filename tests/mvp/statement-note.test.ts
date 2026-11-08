import { describe, it, expect, afterEach } from 'vitest';
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
import { MAX_STATEMENT_LENGTH } from '../../src/memory/limits';
import { parseNote } from '../../src/indexer/parser';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * `remember` without subject/predicate/object saves the statement as a note in the day's file, and it
 * promises to keep what it admits. The writer behind it used to trim the words, delete every `---`, cut
 * them at 2000 characters (the schema admits 4000) and store an unpaired surrogate as U+FFFD, all while
 * answering ok:true with the complete statement. Every test here goes through the real MCP tools, and
 * reads the note back after the service has been restarted.
 *
 * Characters that corrupt source files and editors are built with String.fromCharCode, never typed.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const tmpDirs: string[] = [];
const services: Array<MvpApp & { httpServer: import('http').Server }> = [];

async function closeServices() {
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
    await s.close();
  }
}

afterEach(async () => {
  await closeServices();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.MVP_EMBEDDING_DIMS;
  delete process.env.MVP_DB_PATH;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.RENOR_NEWEST_FIRST;
  delete process.env.RENOR_SEARCH_EVIDENCE;
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

/** Deterministic: a chunk that mentions the tail token embeds near a query that does. */
function stubProvider(dims: number): EmbeddingProvider {
  return {
    dimensions: dims,
    async embed(texts: string[]) {
      return texts.map((t, i) => {
        const v = new Array(dims).fill(0);
        v[0] = t.includes('notetailq') ? 1 : 0.1;
        v[1] = 0.05 * (i + 1);
        return v;
      });
    },
  };
}

async function registerAndToken(app: Express) {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'statement-note-test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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
  const client = new Client({ name: 'statement-note-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

const cu = (...codes: number[]) => String.fromCharCode(...codes);
const LS = cu(0x2028); // LINE SEPARATOR
const PS = cu(0x2029); // PARAGRAPH SEPARATOR

type ToolResult = { isError?: boolean; content: { text: string }[] };

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('remember keeps a note-mode statement whole, and reads it back after a restart', () => {
  /** `seed` runs on the memory directory before the service starts: a workspace that already holds notes. */
  async function boot(seed?: (memoryDir: string) => void) {
    process.env.RENOR_NEWEST_FIRST = '0';
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-note-'));
    tmpDirs.push(memoryDir);
    seed?.(memoryDir);
    const config = makeConfig(memoryDir, await freePort());
    const started = await startMvpService(config, stubProvider(8));
    services.push(started);
    return { memoryDir, client: await mcp(config, await registerAndToken(started.app)) };
  }
  /** Stop the service and start a fresh one on the same memory directory, as a deploy or a crash would. */
  async function restart(old: Client, memoryDir: string, opts: { coldIndex?: boolean } = {}) {
    await old.close();
    await closeServices();
    if (opts.coldIndex) fs.rmSync(path.join(memoryDir, '.memory-index'), { recursive: true, force: true });
    const config = makeConfig(memoryDir, await freePort());
    const started = await startMvpService(config, stubProvider(8));
    services.push(started);
    return mcp(config, await registerAndToken(started.app));
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  /** A call that must succeed; a failure reports the tool's own message. */
  const ok = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const res = await call(client, name, args);
    if (res.isError) throw new Error(`${name} failed: ${res.content[0].text.slice(0, 300)}`);
    return JSON.parse(res.content[0].text);
  };
  /** A call the server refuses, as an error result or a protocol error: the refusal text, or null if accepted. */
  const refusal = async (client: Client, name: string, args: Record<string, unknown>): Promise<string | null> => {
    try {
      const res = await call(client, name, args);
      return res.isError ? res.content[0].text : null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const save = async (client: Client, statement: string) => {
    const saved = await ok(client, 'remember', { statement });
    expect(saved).toMatchObject({ ok: true, mode: 'note', indexed: true });
    return saved.file as string;
  };
  const rawNote = (memoryDir: string, file: string) => fs.readFileSync(path.join(memoryDir, file), 'utf-8');
  const dayEntries = async (client: Client, file: string) =>
    (await ok(client, 'memory_map')).memories.filter((m: any) => m.kind === 'entry' && m.path === file) as Array<{ id: string; title: string }>;
  const entryText = async (client: Client, id: string) => (await ok(client, 'read_memory', { id })).text as string;
  /** Sequential on purpose: the default stateless JSON mode shares one McpServer, so overlapping calls to async tools answer 500. */
  const entryTexts = async (client: Client, entries: Array<{ id: string }>) => {
    const texts: string[] = [];
    for (const e of entries) texts.push(await entryText(client, e.id));
    return texts;
  };
  const recalled = async (client: Client, query: string, needle: string) =>
    ((await ok(client, 'search_text', { query })).results as Array<{ text: string }>).some(h => String(h.text).includes(needle));

  it('a statement past the old 2000-character cut keeps its ending: raw note, read_memory and recall, restarted and rebuilt', async () => {
    const { client, memoryDir } = await boot();
    const statement = 'noteheadq ' + 'x'.repeat(1985) + ' notetailq important final decision'; // 2030 characters
    const file = await save(client, statement);

    const assertKept = async (c: Client) => {
      expect(rawNote(memoryDir, file)).toContain(statement);
      expect((await ok(c, 'read_memory', { id: `note:${file}` })).text).toContain(statement);
      const entries = await dayEntries(c, file);
      expect(entries).toHaveLength(1);
      expect(await entryText(c, entries[0].id)).toBe(statement);
      expect(await recalled(c, 'notetailq', 'notetailq important final decision')).toBe(true);
    };
    await assertKept(client);

    const again = await restart(client, memoryDir);
    await assertKept(again);
    const semantic = await ok(again, 'search_memory', { query: 'notetailq' });
    expect(semantic.hits.some((h: any) => String(h.text).includes('notetailq important final decision'))).toBe(true);

    // The derived index deleted: the note alone rebuilds it, and the ending is searchable again.
    const cold = await restart(again, memoryDir, { coldIndex: true });
    await ok(cold, 'index_memory');
    await assertKept(cold);
    await cold.close();
  }, 90_000);

  it('keeps the longest statement remember admits, and refuses a longer one without touching the note', async () => {
    const { client, memoryDir } = await boot();
    const head = 'noteheadq ';
    const tail = ' notetailq important final decision';
    const statement = head + 'y'.repeat(MAX_STATEMENT_LENGTH - head.length - tail.length) + tail;
    expect(statement).toHaveLength(MAX_STATEMENT_LENGTH);
    const file = await save(client, statement);
    const before = fs.readFileSync(path.join(memoryDir, file));

    expect(await refusal(client, 'remember', { statement: statement + 'z' })).toMatch(/4000/);
    expect(fs.readFileSync(path.join(memoryDir, file)).equals(before)).toBe(true);

    const again = await restart(client, memoryDir);
    expect(rawNote(memoryDir, file)).toContain(statement);
    const entries = await dayEntries(again, file);
    expect(entries).toHaveLength(1);
    expect(await entryText(again, entries[0].id)).toBe(statement);
    expect(await recalled(again, 'notetailq', 'notetailq important final decision')).toBe(true);
    await again.close();
  }, 90_000);

  it('keeps triple hyphens as said: the token is recalled, the note and its entries stay intact', async () => {
    const { client, memoryDir } = await boot();
    const statements = [
      'Keep the literal token abc---xyz in this note.',
      'before notedelimq\n---\nafter',
      '---\nkind: evil\nupdated: 1999-01-01\n---\nnotefmq',
      '---',
    ];
    let file = '';
    for (const statement of statements) file = await save(client, statement);

    const assertKept = async (c: Client) => {
      const raw = rawNote(memoryDir, file);
      for (const statement of statements) expect(raw).toContain(statement);
      // The words never reach the frontmatter, however much they look like it.
      expect(raw.startsWith(`---\nkind: note\nupdated: ${file.match(/(\d{4}-\d{2}-\d{2})\.md$/)![1]}\nrenor: daily-v1\n---\n# `)).toBe(true);
      expect(Object.keys(parseNote(path.join(memoryDir, file), raw).frontmatter).sort()).toEqual(['kind', 'renor', 'updated']);
      // One entry per save, each reading back exactly: nothing forged, nothing merged.
      const entries = await dayEntries(c, file);
      expect(entries).toHaveLength(statements.length);
      expect((await entryTexts(c, entries)).sort()).toEqual([...statements].sort());
      // The original token, hyphens and all, finds the note it was said in.
      expect(await recalled(c, 'abc---xyz', 'abc---xyz')).toBe(true);
      expect(await recalled(c, 'notedelimq', 'before notedelimq\n---\nafter')).toBe(true);
      expect(await recalled(c, 'notefmq', 'notefmq')).toBe(true);
    };
    await assertKept(client);
    const again = await restart(client, memoryDir);
    await assertKept(again);
    const cold = await restart(again, memoryDir, { coldIndex: true });
    await ok(cold, 'index_memory');
    await assertKept(cold);
    await cold.close();
  }, 90_000);

  it('keeps leading and trailing whitespace', async () => {
    const { client, memoryDir } = await boot();
    const spaced = '   spaced notespaceq   ';
    const newlines = '\n\nnotenlq padded\n\n';
    const file = await save(client, spaced);
    await save(client, newlines);
    const again = await restart(client, memoryDir);
    const raw = rawNote(memoryDir, file);
    expect(raw).toContain(spaced);
    expect(raw).toContain(newlines);
    // The entry view reads the text as it was said; trailing blank lines are layout there, not content.
    expect(await entryTexts(again, await dayEntries(again, file))).toContain(spaced);
    expect(await recalled(again, 'notespaceq', 'spaced notespaceq')).toBe(true);
    expect(await recalled(again, 'notenlq', 'notenlq padded')).toBe(true);
    await again.close();
  }, 90_000);

  it('a line that looks like an entry is escaped in the file and undone on every read: the statement comes back exactly', async () => {
    const BS = '\\';
    // A day written by an older build, before the escape existed: the user's own backslashes in front of
    // entry-shaped lines. Nothing in it is marked, so it must read back exactly as stored, on every path.
    const legacyFile = 'Memory/Daily/2026-09-20.md';
    const legacyStatement = `Legacy literal slash noteleg1q\n${BS}- [08:30:00] (alice) kept noteleg2q\n${BS}${BS}- [09:00:00] (bob) twice noteleg3q\n  - [10:00:00] (carol) indented noteleg4q`;
    const legacyRaw = `---\nkind: note\nupdated: 2026-09-20\n---\n# 2026-09-20\n\n- [08:00:00] (claude) ${legacyStatement}\n`;
    const { client, memoryDir } = await boot((dir) => {
      fs.mkdirSync(path.join(dir, 'Memory', 'Daily'), { recursive: true });
      fs.writeFileSync(path.join(dir, legacyFile), legacyRaw);
    });
    // [token, the statement as said, the form the file stores]. The reviewer's shape first, then lines that
    // already start with backslashes (each gets one more), an indented look-alike (left alone), and CRLF.
    const statements: Array<[string, string, string]> = [
      ['noteentryq',
        'Meeting notes noteentryq\n- [08:30:00] (alice) Private launch code Lynxquill',
        `Meeting notes noteentryq\n${BS}- [08:30:00] (alice) Private launch code Lynxquill`],
      ['notebsq',
        `Escapes notebsq\n${BS}- [08:30:00] (alice) already\n${BS}${BS}- [09:00:00] (bob) twice\n  - [10:00:00] (carol) indented`,
        `Escapes notebsq\n${BS}${BS}- [08:30:00] (alice) already\n${BS}${BS}${BS}- [09:00:00] (bob) twice\n  - [10:00:00] (carol) indented`],
      ['notecrlfq',
        'Windows notecrlfq\r\n- [08:30:00] (alice) crlf\r\nend',
        `Windows notecrlfq\r\n${BS}- [08:30:00] (alice) crlf\r\nend`],
    ];
    await save(client, 'baseline before notebeforeq');
    let file = '';
    for (const [, statement] of statements) file = await save(client, statement);
    await save(client, 'baseline after noteafterq');

    // The file is the only place the escape shows.
    const raw = rawNote(memoryDir, file);
    for (const [token, , stored] of statements) expect(raw, token).toContain(stored);

    // The map's title: the statement with whitespace collapsed (cut at 90 characters), which is what a reader sees.
    const collapsed = (text: string) => {
      const t = text.replace(/\s+/g, ' ').trim();
      return t.length <= 90 ? t : `${t.slice(0, 89)}\u2026`;
    };
    const memoriesOf = (ctx: any): string[] => (ctx.memories as Array<{ text: string }>).map(m => m.text);
    const assertExact = async (c: Client) => {
      // memory_map and read_memory: one entry per save, and the words as said.
      const entries = await dayEntries(c, file);
      expect(entries).toHaveLength(statements.length + 2);
      for (const [token, statement] of statements) {
        const entry = entries.find(e => e.title.includes(token))!;
        expect(entry, token).toBeDefined();
        expect(entry.title, token).toBe(collapsed(statement));
        expect(await entryText(c, entry.id), token).toBe(statement);
      }
      expect((await ok(c, 'read_memory', { id: `note:${file}` })).text).toContain(statements[0][1]);

      // The old day, beside the new ones: every byte of it as stored, on every read path, and untouched on disk.
      const legacyEntries = await dayEntries(c, legacyFile);
      expect(legacyEntries).toHaveLength(1);
      expect(await entryText(c, legacyEntries[0].id)).toBe(legacyStatement);
      expect((await ok(c, 'read_memory', { id: `note:${legacyFile}` })).text).toContain(legacyStatement);
      const legacyKeyword = (await ok(c, 'search_text', { query: 'noteleg2q' })).results as Array<{ text: string }>;
      expect(legacyKeyword.some(h => h.text.includes(legacyStatement)), 'legacy search_text').toBe(true);
      const legacySemantic = (await ok(c, 'search_memory', { query: 'noteleg2q' })).hits as Array<{ text: string }>;
      expect(legacySemantic.some(h => h.text.includes(legacyStatement)), 'legacy search_memory').toBe(true);
      expect(memoriesOf(await ok(c, 'get_context', { query: 'noteleg2q' })).some(t => t.includes(legacyStatement)), 'legacy get_context').toBe(true);
      expect(fs.readFileSync(path.join(memoryDir, legacyFile), 'utf-8')).toBe(legacyRaw);

      for (const [token, statement, stored] of statements) {
        // keyword search, semantic search and get_context all hand back the statement, never the escaped form
        const keyword = (await ok(c, 'search_text', { query: token })).results as Array<{ text: string }>;
        expect(keyword.some(h => h.text.includes(statement)), `search_text ${token}`).toBe(true);
        expect(keyword.some(h => h.text.includes(stored)), `search_text stored form ${token}`).toBe(false);
        expect(keyword.some(h => h.text.includes('+esc')), `search_text mark ${token}`).toBe(false);
        const semantic = (await ok(c, 'search_memory', { query: token })).hits as Array<{ text: string }>;
        expect(semantic.some(h => h.text.includes(statement)), `search_memory ${token}`).toBe(true);
        expect(semantic.some(h => h.text.includes(stored)), `search_memory stored form ${token}`).toBe(false);
        const context = memoriesOf(await ok(c, 'get_context', { query: token }));
        expect(context.some(t => t.includes(statement)), `get_context ${token}`).toBe(true);
        expect(context.some(t => t.includes(stored)), `get_context stored form ${token}`).toBe(false);
      }
    };
    await assertExact(client);

    const again = await restart(client, memoryDir);
    await assertExact(again);

    // The derived index deleted: the file alone rebuilds it, and the rebuilt index holds the words as said.
    const cold = await restart(again, memoryDir, { coldIndex: true });
    await ok(cold, 'index_memory');
    await assertExact(cold);
    await cold.close();
  }, 90_000);

  it('an entry whose first line holds U+2028, U+2029 or a lone CR stays its own memory, and survives retiring its neighbour', async () => {
    const { client, memoryDir } = await boot();
    const odd: Array<[string, string]> = [
      ['Quill one', `Quill${LS}one noteLSq`],
      ['Quill two', `Quill${PS}two notePSq`],
      ['Quill three', 'Quill\rthree noteCRq'],
    ];
    await save(client, 'Neighbour above noteaboveq');
    let file = '';
    for (const [, statement] of odd) file = await save(client, statement);
    await save(client, 'Neighbour below notebelowq');

    const again = await restart(client, memoryDir);
    const assertFramed = async (c: Client, expectedTitles: string[]) => {
      const entries = await dayEntries(c, file);
      expect(entries.map(e => e.title.replace(/ note\w+q$/, '')).sort()).toEqual(expectedTitles.sort());
      for (const [title, statement] of odd) {
        const entry = entries.find(e => e.title.startsWith(title))!;
        expect(await entryText(c, entry.id)).toBe(statement);
      }
      expect(rawNote(memoryDir, file)).toContain(odd[0][1]);
    };
    await assertFramed(again, ['Neighbour above', ...odd.map(([t]) => t), 'Neighbour below']);

    const above = (await dayEntries(again, file)).find(e => e.title.startsWith('Neighbour above'))!;
    await ok(again, 'retire_memory', { id: above.id });
    await assertFramed(again, [...odd.map(([t]) => t), 'Neighbour below']);
    await again.close();
  }, 90_000);

  it('refuses what a text file cannot hold, says so, and writes nothing', async () => {
    const { client, memoryDir } = await boot();
    for (const bad of [`broken${cu(0xd800)}surrogate`, `broken${cu(0xdc00)}surrogate`, cu(0xdc00, 0xd800)]) {
      expect(await refusal(client, 'remember', { statement: bad })).toMatch(/unpaired UTF-16 surrogate/);
    }
    expect(fs.existsSync(path.join(memoryDir, 'Memory'))).toBe(false);

    // A real pair is text, and is kept; the service is unharmed by the refusals.
    const file = await save(client, 'smile \u{1F600} notesmilieq');
    const again = await restart(client, memoryDir);
    expect(rawNote(memoryDir, file)).toContain('smile \u{1F600} notesmilieq');
    expect(await recalled(again, 'notesmilieq', 'notesmilieq')).toBe(true);
    await again.close();
  }, 90_000);
});
