import { describe, it, expect, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { indexVault } from '../../src/indexer/pipeline';
import { DEFAULT_LEDGER_REL, remember, replayLedger } from '../../src/memory/lifecycle';
import { createMcpTools, registerMcpHandlers } from '../../src/mcp/server';
import { createServer } from '../../src/api/server';
import { READING, MARKUP_WORDS, RECORDS, SOURCE_FACT, SOURCE_STATEMENT, chores, readingNotes, type LedgerRecord } from '../helpers/longLedger';

const TOKEN = 'synthetic-api-token-for-ledger-surfaces';

/**
 * Every way to read the index keeps the ledger out of what it returns (new-user re-check, finding N6).
 *
 * The first fix covered the MVP tools (tests/mvp/ledger-not-a-passage.test.ts). The ledger is the engine's own record
 * (its header, and the markup of its records), and the other public read surfaces called the shared retrieval layer
 * without telling it which file that is: the canonical MCP `search`, `evidence` and `keyword` tools, the HTTP
 * `/retrieve-context` route and the `renor search` CLI. Each is driven here through its public boundary, over a real
 * vault: a ledger written by the real writer, ordinary notes, and a note that merely looks like a ledger.
 *
 * Synthetic data only: temporary directories, loopback, the deterministic eval-hash embeddings.
 */

const BUN = 'Remember that I prefer Bun for TypeScript projects.';
const LEDGER_HEADER = 'Append-only durable record of memory events.';
/** The ledger's own words: its header, and the markup of a record (its header line and field lines). Nobody said these. */
const INTERNALS = /Append-only durable record|# Memory Events Ledger|## MEM_[A-Za-z0-9]+ · |(?:^|\n|\\n)- (?:kind|subject|predicate|object|closed_event|scope|statement|source): /;
const hasInternals = (value: unknown) => INTERNALS.test(typeof value === 'string' ? value : JSON.stringify(value));

type Hit = { notePath: string; headingPath?: string; text: string; score: number; reason: string };
const texts = (hits: Hit[]) => hits.map((h) => h.text);

const NOTES: Record<string, string> = {
  'Notes/codename.md': '# Codename\n\nMy project codename is Zanzibar.\n',
  // "memory" is in the header, in the heading of every record, and in these two notes.
  'Notes/palace.md': '# Palace\n\nA memory palace helps me remember lists.\n',
  'Notes/zoo.md': '# Zoo\n\nAnother memory: the quokka at the zoo.\n',
};
/** A note that merely holds a record: it is the person's text, and comes back as written. */
const PASTED = '# Pasted\n\nA record copied from somewhere:\n\n## MEM_NOSUCHEVENT · 2001-01-01T00:00:00.000Z\n- kind: store\n- subject: pasted\n- predicate: text\n- object: not an event\n';

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  while (dbs.length) { try { dbs.pop()!.close(); } catch { /* already closed */ } }
  delete process.env.RENOR_SEARCH_EVIDENCE;
  delete process.env.RENOR_STRUCTURED_CONTEXT;
  delete process.env.RENOR_READ_HONESTY;
});
afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The files of a vault, and its ledger written by the real writer: two facts, one with the user's words and one without, then `records`. */
async function writeVault(files: Record<string, string>, ledgerRel: string, records: LedgerRecord[] = []): Promise<string> {
  const vault = tmpDir('ledger-surfaces-vault-');
  for (const [rel, body] of Object.entries({ ...NOTES, ...files })) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), body);
  }
  // The writer projects into a database; this one is thrown away, the surfaces below open their own.
  const scratch = openDb(path.join(tmpDir('ledger-surfaces-scratch-'), 'scratch.db'));
  runMigrations(scratch);
  await remember(scratch, vault, ledgerRel, { subject: 'user', predicate: 'prefers_runtime', object: 'Bun', statement: BUN, source: 'claude' });
  await remember(scratch, vault, ledgerRel, { subject: 'Dana', predicate: 'works_at', object: 'Initech', source: 'claude' });
  for (const record of records) await remember(scratch, vault, ledgerRel, record);
  scratch.close();
  expect(fs.readFileSync(path.join(vault, ledgerRel), 'utf8')).toContain(LEDGER_HEADER);
  return vault;
}

/** A vault indexed through the real pipeline, with the database the in-process surfaces read. */
async function indexedVault(opts: { ledgerRel?: string; files?: Record<string, string>; records?: LedgerRecord[] } = {}) {
  const ledgerRel = opts.ledgerRel ?? DEFAULT_LEDGER_REL;
  const vault = await writeVault(opts.files ?? {}, ledgerRel, opts.records);
  const db = openDb(path.join(tmpDir('ledger-surfaces-db-'), 'index.db'));
  dbs.push(db);
  runMigrations(db);
  await replayLedger(db, vault, ledgerRel);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await indexVault(db, vault, { embeddingProvider: provider, vectorIndex }, 1);
  return { vault, db, provider, vectorIndex, ledgerRel };
}
type Indexed = Awaited<ReturnType<typeof indexedVault>>;

// ─── 1. The canonical MCP tools, over the protocol a client speaks ───────────

async function mcpCall(ix: Indexed) {
  const tools = createMcpTools(ix.db, ix.vectorIndex, ix.provider, {
    vaultPath: ix.vault, memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: ix.ledgerRel,
  });
  const server = new Server({ name: 'renor', version: '1.0.0' }, { capabilities: { tools: {} } });
  registerMcpHandlers(server, tools);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ledger-read-surfaces', version: '0.1.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0].text;
    if (res.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  return { call, close: () => client.close() };
}

describe('the canonical MCP tools keep the ledger out', () => {
  let ix: Indexed;
  let mcp: Awaited<ReturnType<typeof mcpCall>>;
  afterEach(async () => { await mcp?.close(); });

  // A tiny vault answers every question with every chunk it has: the header, two records, three notes.
  it('search: a question nothing answers gets no text of the ledger', async () => {
    ix = await indexedVault();
    mcp = await mcpCall(ix);
    for (const query of ['who is my dentist', 'Memory Events Ledger Append-only durable record of memory events Replayed on rebuild', 'ledger']) {
      const hits = (await mcp.call('search', { query })) as Hit[];
      expect(hits.length, query).toBeGreaterThan(0);
      expect(hits.filter((h) => hasInternals(h.text) || h.headingPath === 'Memory Events Ledger'), query).toEqual([]);
    }
  });

  it('search: what the user said comes back as exactly those words, and a fact nobody put into words as the fact', async () => {
    ix = await indexedVault();
    mcp = await mcpCall(ix);
    const hits = (await mcp.call('search', { query: 'which runtime do I prefer, and where does Dana work' })) as Hit[];
    expect(texts(hits)).toContain(BUN);
    expect(texts(hits)).toContain('Dana — works_at: Initech');
    expect(hits.filter((h) => hasInternals(h.text))).toEqual([]);
  });

  it('search: the header does not take a place on the page', async () => {
    ix = await indexedVault();
    mcp = await mcpCall(ix);
    const sentence = 'Memory Events Ledger Append-only durable record of memory events Replayed on rebuild';
    const hits = (await mcp.call('search', { query: sentence, topK: 3 })) as Hit[];
    expect(hits).toHaveLength(3);
    expect(hits.filter((h) => hasInternals(h.text))).toEqual([]);
  });

  it('search with the structured context on: the composed context is built from what the user said', async () => {
    process.env.RENOR_STRUCTURED_CONTEXT = '1';
    ix = await indexedVault();
    mcp = await mcpCall(ix);
    const result = await mcp.call('search', { query: 'which runtime do I prefer for TypeScript' });
    expect((result.hits as Hit[]).filter((h) => hasInternals(h.text))).toEqual([]);
    expect(hasInternals(result.composedContext)).toBe(false);
    expect(texts(result.hits)).toContain(BUN);
  });

  it('evidence: the hits it returns are what the user said, not the ledger\'s record', async () => {
    ix = await indexedVault();
    mcp = await mcpCall(ix);
    const result = await mcp.call('evidence', { query: 'which runtime do I prefer for TypeScript' });
    expect(result.hits.length).toBeGreaterThan(0);
    expect((result.hits as Hit[]).filter((h) => hasInternals(h.text) || h.headingPath === 'Memory Events Ledger')).toEqual([]);
    expect(texts(result.hits)).toContain(BUN);
  });

  it('keyword: the words of the header and of the markup find nothing of the ledger', async () => {
    ix = await indexedVault();
    mcp = await mcpCall(ix);
    for (const query of ['durable record', 'Append-only', 'Replayed on rebuild', 'Memory Events Ledger', 'ledger', 'kind', 'store', 'source', 'claude', 'subject', 'ledger.md', '2026']) {
      const found = (await mcp.call('keyword', { query })) as Hit[];
      expect(found.filter((h) => h.notePath.endsWith('Memory Events Ledger.md')), query).toEqual([]);
      expect(found.filter((h) => hasInternals(h.text)), query).toEqual([]);
    }
  });

  it('keyword: what an event says finds it, as the words the user used', async () => {
    ix = await indexedVault();
    mcp = await mcpCall(ix);
    expect(texts((await mcp.call('keyword', { query: 'Bun' })) as Hit[])).toEqual([BUN]);
    expect(texts((await mcp.call('keyword', { query: 'Initech' })) as Hit[])).toEqual(['Dana — works_at: Initech']);
    expect(texts((await mcp.call('keyword', { query: 'works_at' })) as Hit[])).toEqual(['Dana — works_at: Initech']);
  });

  it('keyword: the page is cut after the ledger\'s rows come off it, not before', async () => {
    ix = await indexedVault();
    mcp = await mcpCall(ix);
    // "memory" is in the header, in the heading of both records, and in two notes: the page of two is the two notes.
    const found = (await mcp.call('keyword', { query: 'memory', topK: 2 })) as Hit[];
    expect(found.map((h) => path.basename(h.notePath)).sort()).toEqual(['palace.md', 'zoo.md']);
  });

  it('keyword: a vault with no ledger keeps the same rows and order, with vault-relative paths', async () => {
    const vault = tmpDir('ledger-surfaces-plain-');
    for (const [rel, body] of Object.entries(NOTES)) {
      fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
      fs.writeFileSync(path.join(vault, rel), body);
    }
    const db = openDb(path.join(tmpDir('ledger-surfaces-db-'), 'index.db'));
    dbs.push(db);
    runMigrations(db);
    await indexVault(db, vault, {}, 1);
    const provider = new EvalHashEmbeddingProvider();
    const vectorIndex = new VectorIndex(db, provider.dimensions);
    vectorIndex.initTable();
    const tools = createMcpTools(db, vectorIndex, provider, { vaultPath: vault, memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: DEFAULT_LEDGER_REL });
    const got = (await tools.keyword({ query: 'memory', topK: 2 })) as Hit[];
    const old = (db.prepare(
      `SELECT c.id as chunkId, c.note_path as notePath, c.heading_path as headingPath, c.text, bm25(chunks_fts) as score
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`,
    ).all('"memory"', 2) as any[]).map((r) => ({ ...r, notePath: path.relative(vault, r.notePath), score: Math.abs(r.score), reason: 'fts' }));
    expect(got).toEqual(old);
  });

  it('a ledger the owner put elsewhere is the ledger, and the file at the default path is a note', async () => {
    const own = '# Memory Events Ledger\n\nMy own notes about the events ledger idea. The password is quokkaword.\n';
    ix = await indexedVault({ ledgerRel: 'Records/My Ledger.md', files: { [DEFAULT_LEDGER_REL]: own } });
    mcp = await mcpCall(ix);
    const hits = (await mcp.call('search', { query: 'who is my dentist' })) as Hit[];
    // The custom ledger's header is gone; the person's own note, whose first line is the same heading, is not.
    expect(hits.filter((h) => h.text.includes(LEDGER_HEADER))).toEqual([]);
    expect(texts(hits)).toContain(own.trim());
    expect(texts((await mcp.call('keyword', { query: 'quokkaword' })) as Hit[])).toEqual([own.trim()]);
    expect(texts((await mcp.call('keyword', { query: 'durable record' })) as Hit[])).toEqual([]);
  });

  it('a note that holds a record is a note, and comes back as written', async () => {
    ix = await indexedVault({ files: { 'Notes/pasted.md': PASTED } });
    mcp = await mcpCall(ix);
    const record = PASTED.slice(PASTED.indexOf('## MEM_')).trim();
    expect(texts((await mcp.call('keyword', { query: 'NOSUCHEVENT' })) as Hit[])).toEqual([record]);
    expect(texts((await mcp.call('search', { query: 'a record copied from somewhere not an event' })) as Hit[])).toContain(record);
  });
});

describe('the canonical keyword tool: records of the ledger never take a place from a person\'s own words', () => {
  let mcp: Awaited<ReturnType<typeof mcpCall>>;
  afterEach(async () => { await mcp?.close(); });

  // The re-review's reproduction: 260 real records, and a long note that says "source". Each record is turned away
  // (nobody said "source" in it; the word is in its markup), and they were turned away after the page was cut at
  // 200 rows, so the note, ranked below all of them, was never read.
  it('a word that every record carries as markup finds the note that says it, behind any number of records', async () => {
    const ix = await indexedVault({ files: { 'Notes/reading.md': READING }, records: chores(RECORDS) });
    mcp = await mcpCall(ix);
    for (const query of MARKUP_WORDS) {
      const found = (await mcp.call('keyword', { query })) as Hit[];
      expect(texts(found), query).toEqual([READING.trim()]);
    }
    // Whatever the size of the page asked for.
    for (const topK of [1, 3, 50]) {
      expect(texts((await mcp.call('keyword', { query: 'source', topK })) as Hit[]), String(topK)).toEqual([READING.trim()]);
    }
  }, 120_000);

  it('what the user said in an event comes back too, however many records outrank it for the word', async () => {
    const records = [...chores(RECORDS), SOURCE_FACT];
    const ix = await indexedVault({ files: { 'Notes/reading.md': READING }, records });
    mcp = await mcpCall(ix);
    const found = (await mcp.call('keyword', { query: 'source' })) as Hit[];
    expect(texts(found).sort()).toEqual([READING.trim(), SOURCE_STATEMENT].sort());
    expect(found.filter((h) => hasInternals(h.text))).toEqual([]);
  }, 120_000);

  it('a page is exactly as long as it was asked to be when enough notes say the word, whatever ranks above them', async () => {
    const ix = await indexedVault({ files: readingNotes(30), records: chores(RECORDS) });
    mcp = await mcpCall(ix);
    for (const [topK, length] of [[1, 1], [7, 7], [20, 20], [30, 30], [50, 30]]) {
      const found = (await mcp.call('keyword', { query: 'source', topK })) as Hit[];
      expect(found.length, String(topK)).toBe(length);
      expect(found.every((h) => /\/reading-\d+\.md$/.test(h.notePath)), String(topK)).toBe(true);
      expect(new Set(found.map((h) => h.notePath)).size, String(topK)).toBe(length);
    }
  }, 120_000);

  it('a word that only the markup carries finds nothing, and the read ends, however many records carry it', async () => {
    const ix = await indexedVault({ records: chores(RECORDS) });
    mcp = await mcpCall(ix);
    for (const query of MARKUP_WORDS) expect(await mcp.call('keyword', { query }), query).toEqual([]);
  }, 120_000);
});

// ─── 2. The HTTP route ───────────────────────────────────────────────────────

describe('POST /retrieve-context keeps the ledger out', () => {
  const read = (ix: Indexed, ledgerPath: string | undefined) => {
    const app = createServer(ix.db, ix.vectorIndex, ix.provider as never, ix.vault, [], undefined, ledgerPath, { apiToken: TOKEN });
    return (query: string, extra: Record<string, unknown> = {}) => request(app).post('/retrieve-context').set('Authorization', `Bearer ${TOKEN}`).send({ query, ...extra });
  };

  it('a question nothing answers, and what the user said, as the evidence pass is off', async () => {
    process.env.RENOR_SEARCH_EVIDENCE = '0';
    const ix = await indexedVault();
    const ask = read(ix, undefined);
    const never = await ask('who is my dentist');
    expect(never.status).toBe(200);
    expect(never.body.hits.length).toBeGreaterThan(0);
    expect((never.body.hits as Hit[]).filter((h) => hasInternals(h.text) || h.headingPath === 'Memory Events Ledger')).toEqual([]);
    const bun = await ask('which runtime do I prefer for TypeScript');
    expect(texts(bun.body.hits)).toContain(BUN);
    expect(hasInternals(bun.body)).toBe(false);
  });

  it('the header does not take a place on the page: the page is filled by memories', async () => {
    process.env.RENOR_SEARCH_EVIDENCE = '0';
    const ix = await indexedVault();
    // The question is the header's own sentence, so by meaning the header outranks everything.
    const res = await read(ix, undefined)('Memory Events Ledger Append-only durable record of memory events Replayed on rebuild', { topK: 3 });
    expect(res.body.hits).toHaveLength(3);
    expect(hasInternals(res.body.hits)).toBe(false);
  });

  it('and as the evidence pass is on', async () => {
    process.env.RENOR_SEARCH_EVIDENCE = '1';
    const ix = await indexedVault();
    const res = await read(ix, undefined)('which runtime do I prefer for TypeScript');
    expect(res.status).toBe(200);
    expect(res.body.evidence).toBeDefined();
    expect((res.body.hits as Hit[]).filter((h) => hasInternals(h.text) || h.headingPath === 'Memory Events Ledger')).toEqual([]);
    expect(texts(res.body.hits)).toContain(BUN);
  });

  it('with the structured context and read-time honesty on, both are built from what the user said', async () => {
    process.env.RENOR_SEARCH_EVIDENCE = '0';
    process.env.RENOR_STRUCTURED_CONTEXT = '1';
    process.env.RENOR_READ_HONESTY = '1';
    const ix = await indexedVault();
    const res = await read(ix, undefined)('which runtime do I prefer for TypeScript');
    expect(res.body.composedContext).toBeDefined();
    expect(hasInternals(res.body.composedContext)).toBe(false);
    expect(res.body.readHonesty.provenance).toHaveLength(res.body.hits.length);
    expect(hasInternals(res.body)).toBe(false);
  });

  it('a ledger the owner put elsewhere (the route is told where) is the ledger', async () => {
    process.env.RENOR_SEARCH_EVIDENCE = '0';
    const ix = await indexedVault({ ledgerRel: 'Records/My Ledger.md' });
    const res = await read(ix, 'Records/My Ledger.md')('who is my dentist');
    expect(res.body.hits.length).toBeGreaterThan(0);
    expect(hasInternals(res.body.hits)).toBe(false);
  });
});

// ─── 3. `renor search`, spawned as a user runs it ────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The compiled `renor` bin (package.json `bin`), built by tests/globalSetup.ts before any test file
// loads: the surface a user runs, and without paying tsx's transform on every spawn.
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

function cliEnv(vault: string, ledgerRel: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'OPENAI_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMS', 'EMBEDDING_BATCH_SIZE', 'LLM_EXTRACTION',
    'VAULT_PATH', 'DB_PATH', 'MEMORY_LEDGER', 'RENOR_SEARCH_EVIDENCE', 'RENOR_STRUCTURED_CONTEXT', 'RENOR_READ_HONESTY',
  ]) delete env[key];
  return Object.assign(env, {
    VAULT_PATH: vault,
    DB_PATH: path.join(vault, '.semantic-memory', 'index.db'),
    EMBEDDING_PROVIDER: 'eval-hash',
    RENOR_SEARCH_EVIDENCE: '0',
    MEMORY_LEDGER: ledgerRel,
  });
}

function renor(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env, timeout: 120_000 }, (err, stdout, stderr) => resolve({
      code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : (err ? 1 : 0),
      stdout: String(stdout),
      stderr: String(stderr),
    }));
  });
}

describe('`renor search` keeps the ledger out', () => {
  it('prints no text of the ledger for a question nothing answers, and what the user said for one it does (--json and plain)', async () => {
    const vault = await writeVault({}, DEFAULT_LEDGER_REL);
    const env = cliEnv(vault, DEFAULT_LEDGER_REL);
    const indexed = await renor(['index'], env);
    expect(indexed.code, indexed.stderr).toBe(0);

    const never = await renor(['search', 'who is my dentist', '--json'], env);
    expect(never.code, never.stderr).toBe(0);
    const neverHits = JSON.parse(never.stdout).hits as Hit[];
    expect(neverHits.length).toBeGreaterThan(0);
    expect(neverHits.filter((h) => hasInternals(h.text))).toEqual([]);

    const bun = await renor(['search', 'which runtime do I prefer for TypeScript', '--json'], env);
    expect(texts(JSON.parse(bun.stdout).hits)).toContain(BUN);
    expect(hasInternals(bun.stdout)).toBe(false);

    // The same question, as a person reads it in a terminal.
    const plain = await renor(['search', 'who is my dentist'], env);
    expect(plain.code, plain.stderr).toBe(0);
    expect(hasInternals(plain.stdout)).toBe(false);
    expect(plain.stdout).toContain('Zanzibar');
  }, 180_000);

  it('the header does not take a place on the page: -k 3 prints three memories', async () => {
    const vault = await writeVault({}, DEFAULT_LEDGER_REL);
    const env = cliEnv(vault, DEFAULT_LEDGER_REL);
    expect((await renor(['index'], env)).code).toBe(0);
    const res = await renor(['search', 'Memory Events Ledger Append-only durable record of memory events Replayed on rebuild', '-k', '3', '--json'], env);
    const hits = JSON.parse(res.stdout).hits as Hit[];
    expect(hits).toHaveLength(3);
    expect(hits.filter((h) => hasInternals(h.text))).toEqual([]);
  }, 180_000);

  it('knows a ledger the owner put elsewhere (MEMORY_LEDGER)', async () => {
    const vault = await writeVault({}, 'Records/My Ledger.md');
    const env = cliEnv(vault, 'Records/My Ledger.md');
    expect((await renor(['index'], env)).code).toBe(0);
    const never = await renor(['search', 'who is my dentist', '--json'], env);
    const hits = JSON.parse(never.stdout).hits as Hit[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.filter((h) => hasInternals(h.text))).toEqual([]);
  }, 180_000);
});

// ─── 4. A new way to read the index must say what it does about the ledger ──

/** Every .ts file under src/, with its text. */
function sourceFiles(dir: string): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push({ rel: path.relative(path.join(REPO_ROOT, 'src'), full), text: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

describe('the read surfaces are the ones this suite drives', () => {
  const files = sourceFiles(path.join(REPO_ROOT, 'src'));

  it('every call of retrieveContext in the product names the ledger (isLedgerNote), outside its own definition', () => {
    const calls: string[] = [];
    for (const { rel, text } of files) {
      for (const match of text.matchAll(/\bretrieveContext\(/g)) {
        const before = text.slice(Math.max(0, match.index! - 20), match.index);
        if (/function\s*$/.test(before)) continue; // the definition
        const line = text.slice(text.lastIndexOf('\n', match.index!) + 1, match.index);
        if (/^\s*(\/\/|\*)/.test(line)) continue; // a comment
        calls.push(`${rel}: ${text.slice(match.index!, match.index! + 500).includes('isLedgerNote') ? 'names the ledger' : 'DOES NOT NAME THE LEDGER'}`);
      }
    }
    expect(calls.sort()).toEqual([
      'api/server.ts: names the ledger',
      'cli.ts: names the ledger',
      'mcp/server.ts: names the ledger',
      'mcp/server.ts: names the ledger',
      'mvp/engine.ts: names the ledger',
    ]);
  });

  it('every read of the keyword index that returns chunk text applies the keyword guard, and cuts its page after it', () => {
    // The guard is the judgement handed to shownPage, which reads on until the page is full: a page cut at a fixed
    // number of rows and judged afterwards lets the records of the ledger take the places of a person's own words.
    const judgedBeforeTheCut = (text: string) => {
      const at = text.indexOf('shownPage(');
      return at >= 0 && text.slice(at, at + 600).includes('keywordLedgerHits');
    };
    // A reader that returns no chunk text shows nobody anything: the facts lane only asks whether the newest event is
    // indexed (`SELECT 1`). It is exempt only while it reads no chunk text.
    const textless = new Set(['mvp/factsLane.ts']);
    for (const { rel, text } of files.filter(f => textless.has(f.rel))) expect(text, rel).not.toMatch(/\bc\.text\b|chunks\.text\b/);
    // The ranking the readers share (keywordSearch) shows nobody anything itself: it is exempt only while every call of
    // it is a reader's read, handed to shownPage, so its rows reach no one before the guard has judged them. A file that
    // calls it reads the keyword index as much as one that holds the SQL.
    const ranking = 'retrieval/keyword.ts';
    const callsRanking = (text: string) => /\bkeywordSearch\(/.test(text);
    const readInShownPage = (text: string) => [...text.matchAll(/\bkeywordSearch\(/g)].every(call => {
      const at = text.lastIndexOf('shownPage(', call.index);
      return at >= 0 && call.index! - at < 200;
    });
    const rankingCalls = files
      .filter(({ rel, text }) => rel !== ranking && callsRanking(text))
      .map(({ rel, text }) => `${rel}: ${readInShownPage(text) ? 'read in shownPage' : 'READ OUTSIDE shownPage'}`);
    expect(rankingCalls.sort()).toEqual([
      'mcp/server.ts: read in shownPage',
      'mvp/engine.ts: read in shownPage',
      'retrieval/orchestrator.ts: read in shownPage',
    ]);
    const readers = files
      .filter(({ rel, text }) => !rel.startsWith('db/') && !rel.startsWith('importing/') && !textless.has(rel) && rel !== ranking
        && (/FROM chunks_fts|chunks_fts MATCH/.test(text) || callsRanking(text)))
      .map(({ rel, text }) => `${rel}: ${text.includes('keywordLedgerHits') ? 'guarded' : 'NOT GUARDED'}, ${judgedBeforeTheCut(text) ? 'page cut after the guard' : 'PAGE CUT BEFORE THE GUARD'}`);
    expect(readers.sort()).toEqual([
      'mcp/server.ts: guarded, page cut after the guard',
      'mvp/engine.ts: guarded, page cut after the guard',
      'retrieval/orchestrator.ts: guarded, page cut after the guard',
    ]);
  });
});
