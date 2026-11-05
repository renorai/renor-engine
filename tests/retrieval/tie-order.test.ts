import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex, KNN_MAX_K } from '../../src/embeddings/vectorIndex';
import { semanticSearch } from '../../src/retrieval/semantic';
import { keywordSearch } from '../../src/retrieval/keyword';
import { lookupEntity } from '../../src/retrieval/entityLookup';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { tmpPath } from '../helpers/tmpPath';

/**
 * Equal scores are ordered by what the chunks are (note path, then place in the note), never by the order the index
 * happened to write the notes in. Every case builds the same notes twice, the notes written in opposite orders (each
 * note's chunks top to bottom, as the indexer writes them), so row ids and the order vectors are stored in differ, and
 * asserts both answer alike and in place order. Before this, each of these answered by write order: sqlite-vec picks
 * among equally near vectors by where it stored them, FTS5 returns equal BM25 scores in row-id order, and SQLite
 * returns the first-written of entities that match a name equally well.
 */

const opened: Array<{ db: Database.Database; file: string }> = [];
afterEach(() => {
  for (const { db, file } of opened.splice(0)) {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  }
  delete process.env.RENOR_NEWEST_FIRST;
});

let dbCount = 0;
function freshDb(): Database.Database {
  const file = tmpPath(`tie-order-${process.pid}-${dbCount++}.db`);
  const db = openDb(file);
  runMigrations(db);
  opened.push({ db, file });
  return db;
}

interface ChunkSpec { note: string; startLine: number; text: string; vector?: number[]; tokens?: number }

/**
 * The chunks, written to a new index note by note, in the order each note first appears, and each note's chunks top to
 * bottom; returns the index and each chunk's row id by `note@line`.
 */
function build(chunks: ChunkSpec[], dims = 4): { db: Database.Database; idx: VectorIndex; ids: Map<string, number> } {
  const db = freshDb();
  const idx = new VectorIndex(db, dims);
  idx.initTable();
  const ids = new Map<string, number>();
  const notes = [...new Set(chunks.map(c => c.note))];
  const written = notes.flatMap(note => chunks.filter(c => c.note === note).sort((a, b) => a.startLine - b.startLine));
  for (const c of written) {
    db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, null, 'h', '2025-01-01T00:00:00.000Z', '{}')").run(c.note, c.note);
    const id = Number(db.prepare(
      'INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(c.note, '', c.text, c.startLine, c.startLine + 1, c.tokens ?? 5, `${c.note}@${c.startLine}`).lastInsertRowid);
    ids.set(`${c.note}@${c.startLine}`, id);
    if (c.vector) idx.upsert(id, c.vector);
  }
  return { db, idx, ids };
}

/** The same notes written in opposite orders. */
function bothOrders(chunks: ChunkSpec[], dims = 4) {
  return [build(chunks, dims), build([...chunks].reverse(), dims)];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A dense unit vector. Not an embedding model: the test has to store something that is not a sparse hash. */
function unit(rng: () => number, dims: number): number[] {
  const v = new Array<number>(dims);
  let mag = 0;
  for (let i = 0; i < dims; i++) {
    const u = rng() || 1e-12;
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    v[i] = z;
    mag += z * z;
  }
  mag = Math.sqrt(mag) || 1;
  return v.map(x => x / mag);
}

/**
 * What sqlite-vec itself answers, including a tie at the cut, ordered by distance then chunk id. Independent of
 * VectorIndex.search: one `vec_distance_l2` over the stored blobs.
 */
function knnOracle(db: Database.Database, query: number[], topK: number, among?: number[]): Array<{ chunkId: number; score: number }> {
  const mag = Math.sqrt(query.reduce((sum, v) => sum + v * v, 0));
  const norm = mag === 0 ? query : query.map(v => v / mag);
  const buf = Buffer.from(new Float32Array(norm).buffer);
  const rows = (among === undefined
    ? db.prepare('SELECT rowid, vec_distance_l2(embedding, ?) AS distance FROM chunk_embeddings').all(buf)
    : db.prepare(
      'SELECT rowid, vec_distance_l2(embedding, ?) AS distance FROM chunk_embeddings WHERE rowid IN (SELECT value FROM json_each(?))'
    ).all(buf, JSON.stringify(among))) as Array<{ rowid: number | bigint; distance: number }>;
  rows.sort((a, b) => a.distance - b.distance || Number(a.rowid) - Number(b.rowid));
  const edge = rows.length > topK ? rows[topK - 1].distance : Number.POSITIVE_INFINITY;
  return rows.filter((r, i) => i < topK || r.distance === edge).map(r => ({
    chunkId: Number(r.rowid),
    score: 1 - (r.distance * r.distance) / 2,
  }));
}

const place = (hits: Array<{ notePath: string; startLine: number }>) => hits.map(h => `${h.notePath}@${h.startLine}`);

describe('VectorIndex.search returns a tie at the edge whole', () => {
  const query = [1, 0, 0, 0];
  const tied = [0.6, 0.8, 0, 0];

  it('returns every vector as near as the topK-th, beyond topK, and none farther', () => {
    const chunks: ChunkSpec[] = [
      { note: '/v/near.md', startLine: 0, text: 'near', vector: [1, 0, 0, 0] },
      ...['/v/e.md', '/v/b.md', '/v/d.md', '/v/a.md', '/v/c.md'].map(note => ({ note, startLine: 0, text: 'tied', vector: tied })),
      { note: '/v/far.md', startLine: 0, text: 'far', vector: [0, 0, 1, 0] },
    ];
    for (const { idx, ids } of bothOrders(chunks)) {
      const found = idx.search(query, 3);
      expect(found).toHaveLength(6);
      expect(found[0].chunkId).toBe(ids.get('/v/near.md@0'));
      expect(new Set(found.slice(1).map(r => r.chunkId))).toEqual(new Set(['e', 'b', 'd', 'a', 'c'].map(n => ids.get(`/v/${n}.md@0`))));
      expect(new Set(found.slice(1).map(r => r.score)).size).toBe(1);
      expect(found.map(r => r.chunkId)).not.toContain(ids.get('/v/far.md@0'));
    }
  });

  it('reads further, as often as it takes, when the tie is longer than one widening', () => {
    const chunks: ChunkSpec[] = [
      { note: '/v/near.md', startLine: 0, text: 'near', vector: [1, 0, 0, 0] },
      ...Array.from({ length: 40 }, (_, i) => ({ note: `/v/t${i}.md`, startLine: 0, text: 'tied', vector: tied })),
      { note: '/v/far.md', startLine: 0, text: 'far', vector: [0, 0, 1, 0] },
    ];
    for (const { idx } of bothOrders(chunks)) expect(idx.search(query, 2)).toHaveLength(41);
  });

  it('reads a tie wider than one nearest-neighbour query may return by computing every distance', () => {
    const { db, idx } = build([{ note: '/v/near.md', startLine: 0, text: 'near', vector: [1, 0] }], 2);
    db.transaction(() => {
      for (let i = 0; i < KNN_MAX_K + 10; i++) idx.upsert(1000 + i, [0.6, 0.8]);
    })();
    const found = idx.search([1, 0], 3);
    expect(found).toHaveLength(KNN_MAX_K + 11);
    expect(new Set(found.map(r => r.chunkId)).size).toBe(KNN_MAX_K + 11);
  });

  it('matches sqlite-vec on a dense index after a shadow load, a replace, and a delete it did not do', () => {
    // Long enough that the answer cannot be a full exact pass over a handful of rows, and dense so a scan distance
    // is not the stored distance. 768 is what a hosted workspace stores. The five identical vectors are a tie at the
    // cut; the rest sit far from it.
    const dims = 768;
    const rng = mulberry32(11);
    const tied = unit(rng, dims);
    const db = freshDb();
    const idx = new VectorIndex(db, dims);
    idx.initTable();
    db.transaction(() => {
      for (let id = 1; id <= 5; id++) idx.upsert(id, tied);
      for (let id = 6; id <= 300; id++) idx.upsert(id, unit(rng, dims));
    })();
    const loaded = new VectorIndex(db, dims);
    expect(loaded.search(tied, 3)).toEqual(knnOracle(db, tied, 3));
    expect(idx.search(tied, 3)).toEqual(knnOracle(db, tied, 3));
    expect(idx.search(tied, 3)).toHaveLength(5);

    idx.upsert(6, tied); // same row count: a mirror that ignored the write still has five, sqlite has six
    expect(idx.search(tied, 3)).toEqual(knnOracle(db, tied, 3));
    expect(idx.search(tied, 3)).toHaveLength(6);

    db.prepare('DELETE FROM chunk_embeddings WHERE rowid = ?').run(BigInt(1));
    expect(idx.search(tied, 3)).toEqual(knnOracle(db, tied, 3));

    const among = [4, 5, 100];
    expect(idx.search(tied, 1, among)).toEqual(knnOracle(db, tied, 1, among));
    expect(idx.search(tied, 1, among).map(r => r.chunkId).sort((a, b) => a - b)).toEqual([4, 5]);
  });

  it('is the plain nearest-neighbour answer when the edge is not tied', () => {
    const chunks: ChunkSpec[] = Array.from({ length: 30 }, (_, i) => ({
      note: `/v/n${i}.md`, startLine: 0, text: `n${i}`,
      vector: [Math.sin(i * 0.37) + 1.1, Math.cos(i * 0.71), Math.sin(i * 1.3) * 0.5, (i % 5) * 0.1],
    }));
    const { db, idx } = build(chunks);
    const knn = db.prepare('SELECT rowid, distance FROM chunk_embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance')
      .all(Buffer.from(new Float32Array([0.5, 0.5, 0.5, 0.5]).buffer), 7) as Array<{ rowid: number; distance: number }>;
    expect(idx.search([1, 1, 1, 1], 7)).toEqual(knn.map(r => ({ chunkId: Number(r.rowid), score: 1 - (r.distance * r.distance) / 2 })));
  });
});

describe('semanticSearch cuts a tie at the edge by place', () => {
  it('keeps the tied chunks that come first by note path and line, whatever order they were indexed in', async () => {
    const tied = [0.6, 0.8, 0, 0];
    const chunks: ChunkSpec[] = [
      { note: '/v/b.md', startLine: 0, text: 'b0', vector: tied },
      { note: '/v/a.md', startLine: 7, text: 'a7', vector: tied },
      { note: '/v/c.md', startLine: 0, text: 'c0', vector: [1, 0, 0, 0] },
      { note: '/v/a.md', startLine: 2, text: 'a2', vector: tied },
      { note: '/v/b.md', startLine: 3, text: 'b3', vector: tied },
    ];
    const provider = { embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]) };
    for (const { db, idx } of bothOrders(chunks)) {
      expect(place(await semanticSearch(db, idx, provider, 'q', 3))).toEqual(['/v/c.md@0', '/v/a.md@2', '/v/a.md@7']);
      expect(place(await semanticSearch(db, idx, provider, 'q', 10))).toEqual(['/v/c.md@0', '/v/a.md@2', '/v/a.md@7', '/v/b.md@0', '/v/b.md@3']);
    }
  });
});

describe('keywordSearch orders equal BM25 scores by place', () => {
  // Same text, same length: one BM25 score for all of them. Plus one better and one worse match.
  const chunks: ChunkSpec[] = [
    { note: '/v/m.md', startLine: 4, text: 'billing release notes' },
    { note: '/v/k.md', startLine: 0, text: 'billing release notes' },
    { note: '/v/z.md', startLine: 0, text: 'billing billing billing' },
    { note: '/v/m.md', startLine: 1, text: 'billing release notes' },
    { note: '/v/a.md', startLine: 9, text: 'billing release notes' },
    { note: '/v/q.md', startLine: 0, text: 'billing and a much longer chunk of other words around it' },
  ];
  const ranked = (db: Database.Database, limit: number) => keywordSearch(db, '"billing"', limit).map(r => `${r.notePath}:${r.text}`);

  it('answers alike in any write order, ties in note path then line order', () => {
    const answers = bothOrders(chunks).map(({ db }) => ranked(db, 10));
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toEqual([
      '/v/z.md:billing billing billing',
      '/v/a.md:billing release notes', '/v/k.md:billing release notes', '/v/m.md:billing release notes', '/v/m.md:billing release notes',
      '/v/q.md:billing and a much longer chunk of other words around it',
    ]);
  });

  it('cuts a page that ends inside a tie by place', () => {
    for (const { db } of bothOrders(chunks)) {
      expect(ranked(db, 3)).toEqual(['/v/z.md:billing billing billing', '/v/a.md:billing release notes', '/v/k.md:billing release notes']);
      const m = keywordSearch(db, '"billing"', 5).filter(r => r.notePath === '/v/m.md');
      expect(m.map(r => (db.prepare('SELECT start_line FROM chunks WHERE id = ?').get(r.chunkId) as { start_line: number }).start_line)).toEqual([1, 4]);
    }
  });

  it('reads only the page when its last place is not tied, and answers what the ranking before ties were ordered did', () => {
    process.env.RENOR_KEYWORD_STEM = '0'; // The hand-written comparator below intentionally names the legacy table.
    const { db } = build([
      { note: '/v/a.md', startLine: 0, text: 'invoice' },
      { note: '/v/b.md', startLine: 0, text: 'invoice invoice and more' },
      { note: '/v/c.md', startLine: 0, text: 'an invoice among several other words here' },
      { note: '/v/d.md', startLine: 0, text: 'invoice paid' },
    ]);
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
    const page = keywordSearch(db, '"invoice"', 2);
    expect(seen.filter(sql => /chunks_fts MATCH/.test(sql))).toHaveLength(1);
    const before = prepare(
      `SELECT c.id as chunkId, c.note_path as notePath, c.heading_path as headingPath, c.text, bm25(chunks_fts) as score
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`,
    ).all('"invoice"', 2);
    expect(page).toEqual(before);
    expect(keywordSearch(db, '"invoice"', 10)).toEqual(prepare(
      `SELECT c.id as chunkId, c.note_path as notePath, c.heading_path as headingPath, c.text, bm25(chunks_fts) as score
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`,
    ).all('"invoice"', 10));
    delete process.env.RENOR_KEYWORD_STEM;
  });

  it('returns a chunk indexed after the same search, and not a hit a caller changed', () => {
    const { db } = build([{ note: '/v/a.md', startLine: 0, text: 'billing notes' }]);
    const first = keywordSearch(db, '"billing"', 5);
    expect(first.map(r => r.notePath)).toEqual(['/v/a.md']);
    first[0].text = 'changed by the caller';
    db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, null, 'h', '2025-01-01T00:00:00.000Z', '{}')").run('/v/b.md', '/v/b.md');
    db.prepare('INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('/v/b.md', '', 'billing billing billing', 0, 1, 5, '/v/b.md@0');
    const second = keywordSearch(db, '"billing"', 5);
    expect(second.map(r => r.text)).toContain('billing billing billing');
    expect(second.map(r => r.text)).not.toContain('changed by the caller');
  });

  it('drops a page read inside a transaction once that transaction rolls back', () => {
    const { db } = build([{ note: '/v/a.md', startLine: 0, text: 'invoice paid' }]);
    expect(keywordSearch(db, '"invoice"', 5).map(r => r.notePath)).toEqual(['/v/a.md']);
    db.exec('BEGIN');
    db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, null, 'h', '2025-01-01T00:00:00.000Z', '{}')").run('/v/b.md', '/v/b.md');
    db.prepare('INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('/v/b.md', '', 'invoice invoice', 0, 1, 5, '/v/b.md@0');
    expect(keywordSearch(db, '"invoice"', 5).some(r => r.notePath === '/v/b.md')).toBe(true);
    db.exec('ROLLBACK');
    expect(keywordSearch(db, '"invoice"', 5).map(r => r.notePath)).toEqual(['/v/a.md']);
  });
});

describe('lookupEntity resolves a name several entities match to the same one in any write order', () => {
  type Entity = [name: string, note: string, aliases?: string[]];
  const seeded = (entities: Entity[]) => {
    const db = freshDb();
    for (const [name, note, aliases = []] of entities) {
      db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, null, 'h', '2025-01-01T00:00:00.000Z', '{}')").run(note, name);
      db.prepare("INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('note', ?, ?, ?, 1, '2025-01-01')")
        .run(name, JSON.stringify(aliases), note);
    }
    return db;
  };
  const both = (entities: Entity[]) => [seeded(entities), seeded([...entities].reverse())];

  it('an exact name: the remembered subject first, then the note that comes first by path', () => {
    for (const db of both([['Atlas', '/v/z/Atlas.md'], ['Atlas', '_mcp_'], ['Atlas', '/v/a/Atlas.md']])) {
      expect(lookupEntity(db, 'atlas')?.sourceNote).toBe('_mcp_');
    }
    for (const db of both([['Atlas', '/v/z/Atlas.md'], ['Atlas', '/v/a/Atlas.md']])) {
      expect(lookupEntity(db, 'Atlas')?.sourceNote).toBe('/v/a/Atlas.md');
    }
  });

  it('an alias, a part of a name and a part of a path: the same rule after their own order', () => {
    for (const db of both([['Comet', '/v/z/Comet.md', ['ship']], ['Rocket', '/v/a/Rocket.md', ['ship']]])) {
      expect(lookupEntity(db, 'ship')?.sourceNote).toBe('/v/a/Rocket.md');
    }
    // Shortest name first, as before; of equally short names, by path.
    for (const db of both([['Beta two', '/v/c.md'], ['Beta', '/v/z.md'], ['Beta', '/v/b.md']])) {
      expect(lookupEntity(db, 'bet')?.sourceNote).toBe('/v/b.md');
    }
    for (const db of both([['Nine', '/v/proj/nine.md'], ['Four', '/v/proj/four.md'], ['Sixty', '/v/proj/sixty.md']])) {
      expect(lookupEntity(db, 'proj')?.canonicalName).toBe('Four');
    }
  });
});

describe('retrieveContext lays out and selects equal scores by place', () => {
  // A pin rather than a change: SQLite's window sort already kept row order here. The query now states the order.
  it('a related note found through a link stands in with its first longest chunk, and related notes over the window are cut by path', async () => {
    const chunks: ChunkSpec[] = [
      { note: '/v/hub.md', startLine: 0, text: 'Redis caching plan for the hub.', vector: [1, 0, 0, 0] },
      { note: '/v/r2.md', startLine: 9, text: 'Second long section of r2.', tokens: 30 },
      { note: '/v/r2.md', startLine: 4, text: 'First long section of r2.', tokens: 30 },
      { note: '/v/r2.md', startLine: 0, text: 'Short r2 intro.', tokens: 3 },
      { note: '/v/r1.md', startLine: 0, text: 'Only section of r1.', tokens: 10 },
      { note: '/v/r3.md', startLine: 0, text: 'Only section of r3.', tokens: 10 },
    ];
    const provider = { embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]) };
    const answers: string[][] = [];
    for (const { db, idx } of bothOrders(chunks)) {
      const entity = (note: string) => Number(db.prepare(
        "INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('note', ?, '[]', ?, 1, '2025-01-01')",
      ).run(note, note).lastInsertRowid);
      const hub = entity('/v/hub.md');
      for (const note of ['/v/r3.md', '/v/r2.md', '/v/r1.md']) {
        db.prepare("INSERT INTO relations (source_entity_id, relation, target_entity_id, source_note, confidence) VALUES (?, 'links_to', ?, '/v/hub.md', 1)")
          .run(hub, entity(note));
      }
      process.env.RENOR_NEWEST_FIRST = '0';
      // Three related notes reach the window at one score (0.3): topK 3 keeps the hub's hit and the first two by path.
      const result = await retrieveContext(db, idx, provider, 'Redis caching', 3, [], { nowMs: Date.parse('2026-10-03T00:00:00Z') });
      answers.push(result.hits.map(h => `${h.notePath}:${h.text}:${h.reason}`));
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toEqual([
      '/v/hub.md:Redis caching plan for the hub.:semantic',
      '/v/r1.md:Only section of r1.:graph',
      '/v/r2.md:First long section of r2.:graph',
    ]);
  });

  it('equal scores in the score layout come by note path and line', async () => {
    const tied = [0.6, 0.8, 0, 0];
    const chunks: ChunkSpec[] = [
      { note: '/v/b.md', startLine: 3, text: 'b three', vector: tied },
      { note: '/v/a.md', startLine: 8, text: 'a eight', vector: tied },
      { note: '/v/b.md', startLine: 1, text: 'b one', vector: tied },
      { note: '/v/a.md', startLine: 2, text: 'a two', vector: tied },
    ];
    const provider = { embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]) };
    process.env.RENOR_NEWEST_FIRST = '0';
    for (const { db, idx } of bothOrders(chunks)) {
      const result = await retrieveContext(db, idx, provider, 'q', 10, [], { nowMs: Date.parse('2026-10-03T00:00:00Z') });
      expect(result.rankedBy).toBe('score');
      expect(result.hits.map(h => h.text)).toEqual(['a two', 'a eight', 'b one', 'b three']);
    }
  });
});
