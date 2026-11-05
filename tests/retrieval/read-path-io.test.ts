import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { semanticSearch } from '../../src/retrieval/semantic';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { engineSearchText } from '../../src/mvp/engine';
import { tmpPath } from '../helpers/tmpPath';

/**
 * How the read tools (get_context / search_memory / search_text) reach SQLite. Each case below was a
 * measured hotspot on a 10,000-note workspace (scripts/bench/mcp-latency.ts) and none of them changes
 * what a query returns, so a results-only assertion would never notice one coming back. These pin the
 * shape of the access, and assert alongside it that the answers are the ones the previous SQL gave.
 */
const DB = tmpPath('test-read-path-io.db');
afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(DB + suffix)) fs.unlinkSync(DB + suffix);
});

const mmapSize = (db: Database.Database): number => db.pragma('mmap_size', { simple: true }) as number;

function spyOnPrepare(db: Database.Database): string[] {
  const seen: string[] = [];
  const real = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  return seen;
}

function addNote(db: Database.Database, p: string, texts: string[]): number[] {
  db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?)').run(p, p, null, 'h', '2026-01-01T00:00:00.000Z', '{}');
  return texts.map((text, i) => Number((db.prepare(
    'INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)'
  ).run(p, '', text, i, i + 1, 5, `${p}-${i}`)).lastInsertRowid));
}

describe('read path I/O shape', () => {
  it('opens the server database with memory-mapped reads (the vector scan reads every vector page)', () => {
    const db = openDb(DB);
    expect(mmapSize(db)).toBeGreaterThan(0);
    db.close();
  });

  it('answers a vector search with the same neighbours through the mapping as through plain reads', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 8); idx.initTable();
    // Chunk-sized BLOBs so the scan crosses many overflow pages, as a real index does.
    const [first] = addNote(db, '/v/a.md', ['seed']);
    for (let i = 0; i < 1500; i++) {
      const id = i === 0 ? first : addNote(db, `/v/n${i}.md`, [`chunk ${i}`])[0];
      idx.upsert(id, Array.from({ length: 8 }, (_, d) => Math.sin(i * 0.37 + d) + (i % 7) * 0.01));
    }
    const query = Array.from({ length: 8 }, (_, d) => Math.cos(d + 0.5));

    expect(mmapSize(db)).toBeGreaterThan(0);
    const mapped = idx.search(query, 25);
    db.pragma('mmap_size = 0');
    expect(mmapSize(db)).toBe(0);
    const plain = idx.search(query, 25);

    expect(mapped).toHaveLength(25);
    expect(mapped).toEqual(plain);
    db.close();
  });

  it('does not scan the vector table to find out whether it has any vectors', async () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    const [id] = addNote(db, '/v/a.md', ['alpha']);
    const embeds: string[] = [];
    const provider = { dimensions: 4, embed: async (t: string[]) => { embeds.push(...t); return t.map(() => [1, 0, 0, 0]); } };
    const seen = spyOnPrepare(db);

    expect(await semanticSearch(db, idx, provider, 'q', 3)).toEqual([]); // empty index: no embedding call
    expect(embeds).toEqual([]);

    idx.upsert(id, [1, 0, 0, 0]);
    const hits = await semanticSearch(db, idx, provider, 'q', 3);
    expect(hits.map(h => h.chunkId)).toEqual([id]);

    // `SELECT 1 FROM chunk_embeddings LIMIT 1` visits every vector of the vec0 table (cost grows with
    // the index); its rowid shadow table answers "any row at all?" in constant time.
    expect(seen.filter(sql => /FROM\s+chunk_embeddings\s+LIMIT/i.test(sql))).toEqual([]);

    // The shortcut is only as good as the shadow table's bookkeeping: it must empty with the last vector.
    idx.delete(id);
    embeds.length = 0;
    expect(await semanticSearch(db, idx, provider, 'q', 3)).toEqual([]);
    expect(embeds).toEqual([]);
    db.close();
  });

  it('ranks and limits inside the FTS subquery before reading chunk text, returning the rows of the full ranking', () => {
    process.env.RENOR_KEYWORD_STEM = '0'; // This test owns the legacy index's exact SQL plan.
    const db = openDb(DB); runMigrations(db);
    // Many chunks with IDENTICAL text -> identical bm25 scores, written in an order that is not their place order.
    const texts: string[] = [];
    for (let i = 0; i < 40; i++) texts.push('release notes for the billing system');
    for (let i = 0; i < 30; i++) texts.push(`release ${'filler '.repeat(i % 7)} billing ${i}`);
    texts.push('billing');
    addNote(db, '/v/n.md', texts);
    for (let i = 0; i < 20; i++) addNote(db, `/v/m${i}.md`, ['billing release', 'unrelated chunk about release']);
    const seen = spyOnPrepare(db);

    // Every match ranked, then cut: equal scores by place (note path, then chunk id), never by row order alone.
    const ranking = (match: string, limit: number) => (db.prepare(
      `SELECT c.id as chunkId, c.note_path as notePath, c.heading_path as headingPath, c.text, bm25(chunks_fts) as score
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ?`
    ).all(match) as any[])
      .sort((a, b) => a.score - b.score || (a.notePath < b.notePath ? -1 : a.notePath > b.notePath ? 1 : 0) || a.chunkId - b.chunkId)
      .slice(0, limit)
      .map(r => ({
        notePath: r.notePath.replace(/^\/v\//, ''), headingPath: r.headingPath, text: r.text, score: Math.abs(r.score), reason: 'fts',
      }));

    for (const [query, topK] of [['release', 6], ['billing', 20], ['release notes', 6], ['billing', 100]] as const) {
      const got = engineSearchText(db, '/v', query, topK);
      expect(got.ok).toBe(true);
      expect(got.results).toEqual(ranking(`"${query}"`, topK));
    }

    // Plan shape: the ORDER BY ... LIMIT happens on the FTS rows alone, and only then is chunk text fetched
    // (a join first reads the text of every matching chunk, thousands of them for a common word, to keep a handful).
    const ftsSql = seen.find(sql => /chunks_fts MATCH/.test(sql))!;
    // The page's parameters: the match, the ranked window (one row past the page), the boundary offset and the page size.
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${ftsSql}`).all('"release"', 7, 6, 6) as Array<{ detail: string }>).map(r => r.detail);
    const sortAt = plan.findIndex(d => /TEMP B-TREE FOR ORDER BY/.test(d));
    const chunkLookupAt = plan.findIndex(d => /SEARCH c /.test(d));
    expect(sortAt).toBeGreaterThanOrEqual(0);
    expect(chunkLookupAt).toBeGreaterThan(sortAt);
    db.close();
    delete process.env.RENOR_KEYWORD_STEM;
  });

  it('reads no more chunk rows than the page holds when no row is dropped', () => {
    const db = openDb(DB); runMigrations(db);
    // One chunk per length: with one `billing` each, BM25 is strictly longer-is-worse, so no two rows tie at the page's edge.
    for (let n = 0; n < 1000; n++) addNote(db, `/v/n${n}.md`, [`billing ${'filler '.repeat(n)}`.trim()]);
    const edge = (db.prepare(`SELECT bm25(chunks_fts) AS s FROM chunks_fts WHERE chunks_fts MATCH '"billing"' ORDER BY s LIMIT 101`).all() as Array<{ s: number }>);
    expect(edge[99].s).not.toBe(edge[100].s); // precondition: the page's edge is not a tie
    // Rows handed back by the statements that rank chunks, across one search for the top 10.
    let rows = 0;
    const real = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      const st: any = real(sql);
      if (!/chunks_fts MATCH/.test(sql)) return st;
      return new Proxy(st, { get(target, key) {
        if (key === 'all') return (...args: unknown[]) => { const r = target.all(...args); rows += r.length; return r; };
        const v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      } });
    };
    const got = engineSearchText(db, '/v', 'billing', 10);
    expect(got.ok).toBe(true);
    expect((got as { results: unknown[] }).results).toHaveLength(10);
    expect(rows).toBeLessThanOrEqual(10 * 10);
    db.close();
  });

  it('prepares each per-hit retrieval statement once per call, not once per hit', async () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    for (let n = 0; n < 12; n++) {
      const path = `/v/note-${n}.md`;
      const [id] = addNote(db, path, [`Billing decision number ${n} for the quarter, reviewed and signed off by the owner.`]);
      idx.upsert(id, [1, 0.01 * n, 0, 0]);
      // An entity per note, so the per-hit facts lookup runs as well as the per-hit note lookup.
      db.prepare('INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)')
        .run('note', `Note ${n}`, '[]', path, 1, '2026-01-01');
    }
    const provider = { dimensions: 4, embed: async () => [[1, 0, 0, 0]] };
    const seen = spyOnPrepare(db);

    const { hits } = await retrieveContext(db, idx, provider, 'billing decision', 12, []);
    expect(hits.length).toBe(12);

    expect(seen.filter(sql => /FROM notes WHERE path = \?/.test(sql)).length).toBeLessThanOrEqual(1);
    expect(seen.filter(sql => /FROM facts WHERE subject_entity_id = \?/.test(sql)).length).toBeLessThanOrEqual(1);
    db.close();
  });
});
