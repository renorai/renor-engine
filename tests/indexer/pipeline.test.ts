import { describe, it, expect, afterEach, vi } from 'vitest';
import { indexFile, indexVault } from '../../src/indexer/pipeline';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import path from 'path';
import fs from 'fs';
import { tmpPath } from '../helpers/tmpPath';
import { removeDb } from '../helpers/removeDb';

const DB = tmpPath('test-pipeline.db');
const VAULT = path.resolve('fixtures/vault');
afterEach(() => removeDb(DB));

describe('indexFile', () => {
  it('inserts note and chunks', async () => {
    const db = openDb(DB); runMigrations(db);
    await indexFile(db, `${VAULT}/People/John.md`);
    const note = db.prepare('SELECT * FROM notes WHERE path LIKE ?').get('%John.md') as any;
    expect(note).toBeTruthy();
    expect(note.title).toBe('John Doe');
    const chunks = db.prepare('SELECT * FROM chunks WHERE note_path = ?').all(note.path);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('is idempotent — indexing same file twice does not duplicate rows', async () => {
    const db = openDb(DB); runMigrations(db);
    const f = `${VAULT}/People/John.md`;
    await indexFile(db, f);
    await indexFile(db, f);
    expect((db.prepare('SELECT count(*) as c FROM notes WHERE path LIKE ?').get('%John.md') as any).c).toBe(1);
    db.close();
  });

  it('extracts entity from frontmatter', async () => {
    const db = openDb(DB); runMigrations(db);
    await indexFile(db, `${VAULT}/People/John.md`);
    const entity = db.prepare('SELECT * FROM entities WHERE canonical_name = ?').get('John Doe') as any;
    expect(entity).toBeTruthy();
    expect(entity.type).toBe('person');
    db.close();
  });

  it('extracts facts from frontmatter', async () => {
    const db = openDb(DB); runMigrations(db);
    await indexFile(db, `${VAULT}/Projects/Alpha.md`);
    const facts = db.prepare('SELECT * FROM facts WHERE source_path LIKE ?').all('%Alpha.md') as any[];
    expect(facts.length).toBeGreaterThanOrEqual(1);
    const statusFact = facts.find(f => f.predicate === 'status');
    expect(statusFact?.object_text).toBe('active');
    db.close();
  });

  it('stores embeddings when provider given', async () => {
    const db = openDb(DB); runMigrations(db);
    const embedded: Array<{id: number, vec: number[]}> = [];
    const mockProvider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]) };
    const mockIndex = { upsert: vi.fn((id: number, vec: number[]) => embedded.push({id, vec})), delete: vi.fn() };

    await indexFile(db, `${VAULT}/People/John.md`, { embeddingProvider: mockProvider, vectorIndex: mockIndex });
    expect(mockProvider.embed).toHaveBeenCalled();
    expect(mockIndex.upsert).toHaveBeenCalled();
    db.close();
  });

  it('deletes old vectors on re-index', async () => {
    const db = openDb(DB); runMigrations(db);
    const mockProvider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]) };
    const mockIndex = { upsert: vi.fn(), delete: vi.fn() };
    const filePath = `${VAULT}/People/John.md`;

    // First index — no old vectors to delete
    await indexFile(db, filePath, { embeddingProvider: mockProvider, vectorIndex: mockIndex });
    const firstChunkIds = (db.prepare('SELECT id FROM chunks WHERE note_path = ?').all(filePath) as any[]).map(r => r.id);
    expect(firstChunkIds.length).toBeGreaterThanOrEqual(1);
    expect(mockIndex.delete).not.toHaveBeenCalled();

    // Force re-index by resetting stored hash so idempotency check doesn't skip
    db.prepare('UPDATE notes SET note_hash = ? WHERE path = ?').run('', filePath);

    // Re-index — should delete the previously inserted chunk vectors
    await indexFile(db, filePath, { embeddingProvider: mockProvider, vectorIndex: mockIndex });
    expect(mockIndex.delete).toHaveBeenCalledTimes(firstChunkIds.length);
    for (const id of firstChunkIds) {
      expect(mockIndex.delete).toHaveBeenCalledWith(id);
    }
    db.close();
  });

  it('saves wikilink relations between notes', async () => {
    const db = openDb(DB); runMigrations(db);
    // Index John first so his entity exists, then Alpha which links to People/John
    await indexFile(db, `${VAULT}/People/John.md`);
    await indexFile(db, `${VAULT}/Projects/Alpha.md`);

    const relations = db.prepare('SELECT * FROM relations WHERE source_note LIKE ?').all('%Alpha.md') as any[];
    expect(relations.length).toBeGreaterThanOrEqual(1);

    const linkToJohn = relations.find((r: any) => {
      const target = db.prepare('SELECT canonical_name FROM entities WHERE id = ?').get(r.target_entity_id) as any;
      return target?.canonical_name === 'John Doe';
    });
    expect(linkToJohn).toBeTruthy();
    expect(linkToJohn.relation).toBe('links_to');
    expect(linkToJohn.confidence).toBe(1.0);
    db.close();
  });

  it('stores LLM-extracted facts when factExtractor is provided', async () => {
    const db = openDb(DB); runMigrations(db);
    const mockExtractor = vi.fn().mockResolvedValue([
      { subject: 'John', predicate: 'works_at', object: 'Acme Corp', confidence: 0.85 }
    ]);

    await indexFile(db, `${VAULT}/People/John.md`, { factExtractor: mockExtractor });

    expect(mockExtractor).toHaveBeenCalledWith('John Doe', expect.any(String));

    const facts = db.prepare('SELECT * FROM facts WHERE source_path LIKE ? AND predicate = ?')
      .all('%John.md', 'works_at') as any[];
    expect(facts).toHaveLength(1);
    expect(facts[0].confidence).toBe(0.85);
    db.close();
  });

  it('clears stale relations on re-index', async () => {
    const db = openDb(DB); runMigrations(db);
    await indexFile(db, `${VAULT}/People/John.md`);
    await indexFile(db, `${VAULT}/Projects/Alpha.md`);

    const before = (db.prepare('SELECT count(*) as c FROM relations WHERE source_note LIKE ?').get('%Alpha.md') as any).c;
    // Re-index Alpha — relation count should stay the same (no duplicates)
    await indexFile(db, `${VAULT}/Projects/Alpha.md`);
    const after = (db.prepare('SELECT count(*) as c FROM relations WHERE source_note LIKE ?').get('%Alpha.md') as any).c;
    expect(after).toBe(before);
    db.close();
  });
});

describe('indexFile frontmatter safety', () => {
  function plant(name: string, content: string): string {
    const dir = tmpPath('frontmatter-safety');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  it('refuses frontmatter that would expand far beyond the note before writing a row', async () => {
    const db = openDb(DB); runMigrations(db);
    const file = plant('flat.md', `---\nbig: &big ${'x'.repeat(2_500)}\nlist: [${Array(2_000).fill('*big').join(', ')}]\n---\n# Flat`);
    await expect(indexFile(db, file)).rejects.toThrow(/too large/);
    expect(db.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 0 });
    db.close();
  });

  it('never evaluates JavaScript frontmatter on a file that is already on disk', async () => {
    const db = openDb(DB); runMigrations(db);
    for (const opening of ['---js', '---javascript']) {
      const file = plant('planted.md', `${opening}\n(globalThis.__indexFileExecuted = true, {})\n---\n# Planted`);
      await expect(indexFile(db, file)).rejects.toThrow();
      expect((globalThis as { __indexFileExecuted?: boolean }).__indexFileExecuted).toBeUndefined();
    }
    expect(db.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('indexVault', () => {
  it('indexes all markdown files in vault and returns stats', async () => {
    const db = openDb(DB); runMigrations(db);
    const stats = await indexVault(db, VAULT);
    expect(stats.total).toBeGreaterThanOrEqual(4);
    expect(stats.indexed).toBe(stats.total);
    expect(stats.errors).toBe(0);
    expect((db.prepare('SELECT count(*) as c FROM notes').get() as any).c).toBeGreaterThanOrEqual(4);
    db.close();
  });

  it('returns { total: 0, indexed: 0, errors: 0 } for empty vault', async () => {
    const db = openDb(DB); runMigrations(db);
    const emptyVault = tmpPath('osm-empty-vault-test');
    fs.mkdirSync(emptyVault, { recursive: true });
    const stats = await indexVault(db, emptyVault);
    expect(stats).toEqual({ total: 0, indexed: 0, errors: 0, skippedNonUtf8Names: [] });
    fs.rmdirSync(emptyVault);
    db.close();
  });

});
