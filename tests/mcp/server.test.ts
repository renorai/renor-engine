import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { createMcpTools, registerMcpHandlers, TOOLS } from '../../src/mcp/server';
import { DEFAULT_LEDGER_REL, replayLedger, factsFor } from '../../src/memory/lifecycle';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { tmpPath } from '../helpers/tmpPath';
import { hitList } from '../helpers/hitList';

// These tests pin the previous stdio tool list: RENOR_MCP_LEGACY_STDIO=1 restores it (the default lists the hosted names; see tests/mcp/stdio-hosted-names.test.ts).
process.env.RENOR_MCP_LEGACY_STDIO = '1';

const DB = tmpPath('test-mcp.db');
const tmpDirs: string[] = [];
afterEach(() => {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function seedDb() {
  const db = openDb(DB);
  runMigrations(db);
  db.prepare("INSERT INTO notes VALUES ('/v/john.md','John','person','h1','2026-03-30T00:00:00.000Z','{}')").run();
  db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
    .run('/v/john.md', '', 'John is an engineer at Acme.', 0, 2, 7, 'h1');
  db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
    .run('person', 'John', '["JD"]', '/v/john.md', 1.0, '2026-03-30');
  const entityId = (db.prepare('SELECT id FROM entities LIMIT 1').get() as any).id;
  db.prepare("INSERT INTO facts (subject_entity_id,predicate,object_text,source_path,confidence,valid_from,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(entityId, 'works_at', 'Acme Corp', '/v/john.md', 0.9, '2026-03-30', '2026-03-30');
  return db;
}

describe('MCP tools', () => {
  it('status returns counts', async () => {
    const db = seedDb();
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: DEFAULT_LEDGER_REL });
    const result = await tools.status({});
    expect(result.notes).toBe(1);
    expect(result.chunks).toBe(1);
    expect(result.entities).toBe(1);
    expect(result.facts).toBe(1);
    db.close();
  });

  it('entity finds by name', async () => {
    const db = seedDb();
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: DEFAULT_LEDGER_REL });
    const result = await tools.entity({ name: 'John' });
    expect(result).not.toBeNull();
    expect(result!.canonicalName).toBe('John');
    db.close();
  });

  it('entity finds by alias', async () => {
    const db = seedDb();
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: DEFAULT_LEDGER_REL });
    const result = await tools.entity({ name: 'JD' });
    expect(result).not.toBeNull();
    expect(result!.canonicalName).toBe('John');
    db.close();
  });

  it('facts returns facts for entity', async () => {
    const db = seedDb();
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: DEFAULT_LEDGER_REL });
    const result = await tools.facts({ entityName: 'John' });
    expect(result).toHaveLength(1);
    expect(result[0].predicate).toBe('works_at');
    db.close();
  });

  it('remember_fact creates entity and fact, writes the ledger, and survives rebuild (PoC T4)', async () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1a-mcp-'));
    tmpDirs.push(v);
    const db = seedDb();
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any,
      { vaultPath: v, memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: 'System/Memory Events Ledger.md' });
    const result = await tools.remember_fact({ subject: 'Alice', predicate: 'works_at', object: 'Globex' });
    expect(result.ok).toBe(true);
    expect(result.created!.factId).toBeGreaterThan(0);
    const facts = await tools.facts({ entityName: 'Alice' });
    expect(facts).toHaveLength(1);
    expect(facts[0].object_text).toBe('Globex');
    db.close();

    // B4 (PoC T4 store-fact-writes-ledger): the write must be ledger-durable.
    const ledgerPath = path.join(v, 'System/Memory Events Ledger.md');
    expect(fs.existsSync(ledgerPath)).toBe(true);

    // B4 (PoC T4 fact-survives-rebuild): the fact survives a fresh replay.
    const db2 = openDb(path.join(v, 'rebuild.db'));
    runMigrations(db2);
    await replayLedger(db2, v, 'System/Memory Events Ledger.md');
    const survived = factsFor(db2, 'Alice') as any[];
    expect(survived.length).toBeGreaterThan(0);
    expect(survived[0].object_text).toBe('Globex');
    db2.close();
  });

  it('search returns hits', async () => {
    const db = seedDb();
    const chunkId = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as any).id;
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(chunkId, [1, 0, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.9, 0, 0, 0]]) };
    const tools = createMcpTools(db, idx, provider as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: DEFAULT_LEDGER_REL });
    const result = hitList(await tools.search({ query: 'engineer', topK: 5 }));
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].notePath).toBe('/v/john.md');
    expect(result[0].session_date).toBe('2026-03-30T00:00:00.000Z');
    expect(result[0].text).toBe('John is an engineer at Acme.');
    db.close();
  });

  it('search exposes frontmatter session_date for clients to stamp excerpts', async () => {
    const db = openDb(DB);
    runMigrations(db);
    db.prepare("INSERT INTO notes VALUES ('/v/s.md','S','longmemeval-session','h1','2026-03-30T00:00:00.000Z',?)")
      .run(JSON.stringify({ session_date: '2023/05/20 (Sat) 02:10' }));
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/s.md', '', 'John is an engineer at Acme.', 0, 2, 7, 'h1');
    const chunkId = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as any).id;
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(chunkId, [1, 0, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.9, 0, 0, 0]]) };
    const tools = createMcpTools(db, idx, provider as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: DEFAULT_LEDGER_REL });
    const result = hitList(await tools.search({ query: 'engineer', topK: 5 }));
    expect(result[0].session_date).toBe('2023/05/20 (Sat) 02:10');
    expect(result[0].text.startsWith('[Session date:')).toBe(false);
    db.close();
  });

  it('search defaults to 20 hits and still honors an explicit topK of 10', async () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    for (let i = 0; i < 25; i++) {
      const path = `/v/n${i}.md`;
      db.prepare("INSERT INTO notes VALUES (?,?,'note','h','2026-03-30','{}')").run(path, `N${i}`);
      db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
        .run(path, '', `contentful note ${i} about widgets and retrieval depth.`, 0, 2, 8, `h${i}`);
      const id = (db.prepare('SELECT id FROM chunks WHERE chunk_hash=?').get(`h${i}`) as { id: number }).id;
      idx.upsert(id, [1 - i * 0.001, 0, 0, 0]);
    }
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };
    const tools = createMcpTools(db, idx, provider as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: DEFAULT_LEDGER_REL });
    const defaulted = await tools.search({ query: 'widgets' });
    expect(defaulted).toHaveLength(20);
    const explicit = await tools.search({ query: 'widgets', topK: 10 });
    expect(explicit).toHaveLength(10);
    db.close();
  });
});

/**
 * Drive the REAL MCP protocol path — the same tools/list + tools/call handlers `renor mcp`
 * serves over stdio — so these regressions assert what a client actually receives, not what an
 * internal function returns. (registerMcpHandlers is the production wiring, extracted from
 * startMcpServer; a test that re-declared its own handlers would pass even if the published
 * schema or the error envelope regressed.)
 */
async function withMcpServer<T>(
  tools: ReturnType<typeof createMcpTools>,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = new Server({ name: 'renor', version: '1.0.0' }, { capabilities: { tools: {} } });
  registerMcpHandlers(server, tools);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-write-path', version: '0' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('remember_fact over the MCP tool path', () => {
  function writePathTools(vault: string) {
    const db = openDb(path.join(vault, 'index.db'));
    runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    return {
      db,
      tools: createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any, {
        vaultPath: vault, memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: 'System/Memory Events Ledger.md',
      }),
    };
  }

  it('publishes every argument with a description, so a model does not guess object is a value of any type', async () => {
    const published = TOOLS.find((t) => t.name === 'remember_fact')!;
    const properties = (published.inputSchema as any).properties;
    expect(Object.keys(properties).sort()).toEqual(['object', 'predicate', 'source', 'subject']);
    // Every property is documented. This is the trap: `object` reads as "the value", so a model
    // sends a list or a struct and the write dies with an opaque type error. The description is
    // the only thing standing between the model and that dead end.
    for (const [name, schema] of Object.entries<any>(properties)) {
      expect(typeof schema.description, `remember_fact.${name} has no description`).toBe('string');
      expect(schema.description.length, `remember_fact.${name} has an empty description`).toBeGreaterThan(0);
    }
    expect(properties.object.description).toMatch(/string/i);
    expect(published.inputSchema.required).toEqual(['subject', 'predicate', 'object']);

    // Asserted through a live tools/list too, so the schema a client receives is the schema guarded.
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-schema-'));
    tmpDirs.push(v);
    const { db, tools } = writePathTools(v);
    await withMcpServer(tools, async (client) => {
      const live = (await client.listTools()).tools.find((t) => t.name === 'remember_fact')!;
      expect((live.inputSchema as any).properties.object.description).toMatch(/string/i);
    });
    db.close();
  });

  it('accepts plain-string subject/predicate/object and writes a durable ledger fact', async () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remember-ok-'));
    tmpDirs.push(v);
    const { db, tools } = writePathTools(v);
    await withMcpServer(tools, async (client) => {
      const res = await client.callTool({
        name: 'remember_fact',
        arguments: { subject: 'Alice', predicate: 'works_at', object: 'Globex', source: 'mcp-test' },
      });
      expect(res.isError ?? false).toBe(false);
      const receipt = JSON.parse((res.content as any[])[0].text);
      expect(receipt.ok).toBe(true);
      expect(receipt.action).toBe('store');
      expect(receipt.created.object).toBe('Globex');
    });
    // Durable, not just accepted: the ledger is the thing that survives an index rebuild.
    const ledgerPath = path.join(v, 'System/Memory Events Ledger.md');
    expect(fs.readFileSync(ledgerPath, 'utf8')).toContain('- object: Globex');
    db.close();
  });

  it('names the offending field, the expected type and the received type when object is not a string', async () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remember-bad-'));
    tmpDirs.push(v);
    const { db, tools } = writePathTools(v);
    await withMcpServer(tools, async (client) => {
      const res = await client.callTool({
        name: 'remember_fact',
        arguments: { subject: 'Alice', predicate: 'languages', object: ['js', 'ts'] },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as any[])[0].text;
      // The field, the expected type, and what actually arrived — an agent can act on this
      // without reading the engine source.
      expect(text).toMatch(/lifecycle object must be a string/);
      expect(text).toMatch(/received array/);
    });
    // A rejected write must not touch the ledger: nothing canonical was published.
    expect(fs.existsSync(path.join(v, 'System/Memory Events Ledger.md'))).toBe(false);
    db.close();
  });

  it('cuts a saved note with the chunk sizes renor index defaults to (400/50) when the config names none', async () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-save-chunk-defaults-'));
    tmpDirs.push(v);
    const db = openDb(path.join(v, 'index.db'));
    runMigrations(db);
    const tools = createMcpTools(db, undefined, undefined, {
      vaultPath: v, memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: 'System/Memory Events Ledger.md',
    });
    // One entry of 70 short paragraphs (~850 tokens, under the 4000-character limit of a save): the cut splits it
    // into chunks of at most 400 tokens, and each paragraph is small enough to be carried over.
    const paragraphs = Array.from({ length: 70 }, (_, p) => Array.from({ length: 8 }, (_, i) => `w${p}x${i}`).join(' '));
    const saved = await tools.note({ text: paragraphs.join('\n\n'), date: '2026-10-10' }) as any;
    expect(saved.ok).toBe(true);
    expect(saved.warning).toBeUndefined();
    const chunks = db.prepare('SELECT text FROM chunks WHERE note_path = ? ORDER BY start_line, id').all(saved.path) as { text: string }[];
    expect(chunks.length).toBeGreaterThan(2);
    // An overlap of 50 repeats the end of a chunk at the start of the next; an overlap of 0 repeats nothing.
    for (let i = 1; i < chunks.length; i++) {
      const lastOfPrevious = chunks[i - 1].text.split('\n\n').pop()!;
      expect(chunks[i].text.startsWith(lastOfPrevious)).toBe(true);
    }
    db.close();
  });

  it('keeps the default overlap below a chunk maximum the config names', async () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-save-chunk-max-only-'));
    tmpDirs.push(v);
    const db = openDb(path.join(v, 'index.db'));
    runMigrations(db);
    const tools = createMcpTools(db, undefined, undefined, {
      vaultPath: v, memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: 'System/Memory Events Ledger.md', chunkMaxTokens: 20,
    });
    const paragraphs = Array.from({ length: 20 }, (_, p) => `word${p} tail`);
    const saved = await tools.note({ text: paragraphs.join('\n\n'), date: '2026-10-10' }) as any;
    expect(saved.ok).toBe(true);
    expect(saved.warning).toBeUndefined();
    const sizes = (db.prepare('SELECT token_count AS n FROM chunks WHERE note_path = ?').all(saved.path) as { n: number }[]).map((r) => r.n);
    expect(sizes.length).toBeGreaterThan(2);
    // An overlap of 50 against a maximum of 20 made every chunk carry the last one and grow (67 tokens by the 12th).
    expect(Math.max(...sizes)).toBeLessThanOrEqual(30);
    db.close();
  });

  it('keeps a saved memory and says so when the index refresh after it fails', async () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-save-refresh-failed-'));
    tmpDirs.push(v);
    const db = openDb(path.join(v, 'index.db'));
    runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn().mockRejectedValue(new Error('embedding service down')), dimensions: 4 } as any, {
      vaultPath: v, memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: 'System/Memory Events Ledger.md',
    });
    const fact = await tools.remember_fact({ subject: 'Alice', predicate: 'works_at', object: 'Globex' }) as any;
    expect(fact.ok).toBe(true);
    expect(fact.warning).toBe('memory-saved-but-index-refresh-failed');
    expect(fs.readFileSync(path.join(v, 'System/Memory Events Ledger.md'), 'utf8')).toContain('Globex');
    const note = await tools.note({ text: 'Alice moved to Lisbon', date: '2026-10-10' }) as any;
    expect(note.ok).toBe(true);
    expect(note.warning).toBe('memory-saved-but-index-refresh-failed');
    expect(fs.readFileSync(note.path, 'utf8')).toContain('Alice moved to Lisbon');
    db.close();
  });

  it('reports a non-string subject as a subject error, not an object error', async () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remember-subject-'));
    tmpDirs.push(v);
    const { db, tools } = writePathTools(v);
    await withMcpServer(tools, async (client) => {
      const res = await client.callTool({
        name: 'remember_fact',
        arguments: { subject: { name: 'Alice' }, predicate: 'works_at', object: 'Globex' },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any[])[0].text).toMatch(/lifecycle subject must be a string \(received object\)/);
    });
    db.close();
  });
});
