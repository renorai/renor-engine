import { describe, it, expect, afterEach, vi } from 'vitest';
import { semanticSearch } from '../../src/retrieval/semantic';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { tmpPath } from '../helpers/tmpPath';
import { removeDb } from '../helpers/removeDb';

const DB = tmpPath('test-semantic.db');
afterEach(() => removeDb(DB));

describe('semanticSearch', () => {
  it('returns chunks ranked by similarity', async () => {
    const db = openDb(DB); runMigrations(db);
    db.prepare("INSERT INTO notes VALUES ('/v/t.md','Test',null,'h','2026-01-01','{}')").run();
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/t.md','','TypeScript backend.',0,2,5,'h1');
    const id = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as any).id;
    const idx = new VectorIndex(db, 4); idx.initTable(); idx.upsert(id, [1,0,0,0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.9,0.1,0,0]]) };

    const hits = await semanticSearch(db, idx, provider, 'TypeScript', 3);
    expect(hits.length).toBe(1);
    expect(hits[0].notePath).toBe('/v/t.md');
    expect(hits[0].score).toBeGreaterThan(0.5);
    db.close();
  });

  it('does not request a query embedding when the vector index is empty', async () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };

    const hits = await semanticSearch(db, idx, provider, 'anything', 20);

    expect(hits).toEqual([]);
    expect(provider.embed).not.toHaveBeenCalled();
    db.close();
  });
});
