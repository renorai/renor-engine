import { describe, it, expect, afterEach, vi } from 'vitest';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import fs from 'fs';
import { tmpPath } from '../helpers/tmpPath';
import { indexFile } from '../../src/indexer/pipeline';
import { factsFor } from '../../src/memory/lifecycle';
import { removeDb } from '../helpers/removeDb';

const DB_PATH = tmpPath('test-schema.db');
afterEach(() => removeDb(DB_PATH));

describe('runMigrations', () => {
  it('creates all required tables', () => {
    const db = openDb(DB_PATH);
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((r: any) => r.name);
    ['notes','chunks','entities','facts','relations','write_events'].forEach(t =>
      expect(tables).toContain(t)
    );
    db.close();
  });

  it('is idempotent', () => {
    const db = openDb(DB_PATH);
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it('migration 24 lifts existing note reads using index time, preserves scope spellings and excludes future content dates', async () => {
    const db = openDb(DB_PATH);
    runMigrations(db);
    const note = tmpPath('Existing clock.md');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-10T12:00:00Z'));
      fs.writeFileSync(note, '---\nowner: Avery\nstatus: planned\n---\n\n# Existing clock\n');
      await indexFile(db, note);
      // A pre-upgrade note fact with a future content date; updated_at is still the indexer's own observation.
      db.prepare("UPDATE facts SET valid_from = '2099-01-01T00:00:00.000Z' WHERE predicate = 'status'").run();
      db.prepare("UPDATE facts SET scope = 'scope:atlas'").run();
      db.exec('DROP TABLE note_index_clock');
      db.prepare('UPDATE schema_version SET version = 21').run();
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      runMigrations(db);
      expect(db.prepare('SELECT * FROM note_index_clock').all()).toEqual([
        { scope: 'scope:atlas', observed_at: '2026-10-10T12:00:00.000Z' },
      ]);
      for (const scope of ['scope:atlas', 'project:atlas']) {
        expect(factsFor(db, 'Existing clock', { scope })).toEqual([
          expect.objectContaining({ predicate: 'owner', object_text: 'Avery' }),
        ]);
      }
      expect(factsFor(db, 'Existing clock', { scope: 'global' })).toHaveLength(0);
      expect(factsFor(db, 'Existing clock', { asOf: '2026-01-01T00:00:00.000Z' })).toHaveLength(0);
      expect(factsFor(db, 'Existing clock', { includeHistory: true })).toHaveLength(2);
      expect(() => runMigrations(db)).not.toThrow();
    } finally {
      vi.useRealTimers();
      db.close();
      fs.rmSync(note, { force: true });
    }
  });

  it('migration 6 repairs pre-existing duplicate current facts before enforcing the single-current invariant', () => {
    const db = openDb(DB_PATH);
    runMigrations(db);
    // Rewind to the pre-fix schema (v5) with B2-race-style duplicate current
    // facts for one (subject, predicate), then apply migration 6 on top.
    db.prepare('DROP INDEX IF EXISTS idx_facts_current').run();
    db.exec('DROP TABLE IF EXISTS applied_ledger_events');
    db.prepare(`CREATE UNIQUE INDEX idx_facts_unique ON facts(subject_entity_id, predicate, object_text)`).run();
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version) VALUES (5)').run();

    db.prepare(
      `INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', '2026-01-01T00:00:00.000Z', '{}')`
    ).run();
    const entityId = (db.prepare(
      `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', 'SynthDup', '[]', '_mcp_', 1.0, '2026-01-01T00:00:00.000Z') RETURNING id`
    ).get() as any).id;
    for (const [obj, from] of [['X1', '2026-01-01T00:00:01.000Z'], ['X2', '2026-01-01T00:00:02.000Z'], ['X3', '2026-01-01T00:00:03.000Z']]) {
      db.prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at) VALUES (?, 'wants', ?, '_mcp_', 1.0, ?, NULL, ?)`
      ).run(entityId, obj, from, from);
    }

    expect(() => runMigrations(db)).not.toThrow();
    // Deterministic repair: newest current fact (X3) stays open, older ones closed.
    const open = db.prepare(
      `SELECT object_text FROM facts WHERE subject_entity_id = ? AND predicate = 'wants' AND valid_to IS NULL`
    ).all(entityId) as any[];
    expect(open).toHaveLength(1);
    expect(open[0].object_text).toBe('X3');
    // The new invariant is enforced at the DB level.
    expect(() => db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at) VALUES (?, 'wants', 'X4', '_mcp_', 1.0, '2026-01-02T00:00:00.000Z', NULL, '2026-01-02T00:00:00.000Z')`
    ).run(entityId)).toThrow(/UNIQUE/);
    db.close();
  });

  it('migration 7 re-scopes a DB that already applied the first candidate\'s globally-scoped migration 6', () => {
    const db = openDb(DB_PATH);
    runMigrations(db); // fresh: v6 (scoped) + v7 applied
    // Rewind to the first candidate\'s v6 shape: GLOBAL idx_facts_current.
    db.prepare('DROP INDEX IF EXISTS idx_facts_current').run();
    db.prepare(`CREATE UNIQUE INDEX idx_facts_current ON facts(subject_entity_id, predicate) WHERE valid_to IS NULL`).run();
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version) VALUES (6)').run();

    expect(() => runMigrations(db)).not.toThrow();
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_facts_current'").get() as any;
    expect(sql.sql).toContain("source_path = '_mcp_'");

    // The global over-enforcement is gone for non-lifecycle writers...
    db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('/v/n.md', 'N', 'note', 'h', '2026-01-01T00:00:00.000Z', '{}')`).run();
    const noteEntity = (db.prepare(`INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('note', 'N', '[]', '/v/n.md', 1.0, '2026-01-01T00:00:00.000Z') RETURNING id`).get() as any).id;
    expect(() => db.prepare(`INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at) VALUES (?, 'works_at', 'A', '/v/n.md', 1.0, '2026-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z')`).run(noteEntity)).not.toThrow();
    expect(() => db.prepare(`INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at) VALUES (?, 'works_at', 'B', '/v/n.md', 1.0, '2026-01-01T00:00:01.000Z', NULL, '2026-01-01T00:00:01.000Z')`).run(noteEntity)).not.toThrow();
    // ...while lifecycle single-current is still enforced.
    db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', '2026-01-01T00:00:00.000Z', '{}')`).run();
    const lifecycleEntity = (db.prepare(`INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', 'SynthLife', '[]', '_mcp_', 1.0, '2026-01-01T00:00:00.000Z') RETURNING id`).get() as any).id;
    expect(() => db.prepare(`INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at) VALUES (?, 'wants', 'X1', '_mcp_', 1.0, '2026-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z')`).run(lifecycleEntity)).not.toThrow();
    expect(() => db.prepare(`INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at) VALUES (?, 'wants', 'X2', '_mcp_', 1.0, '2026-01-01T00:00:01.000Z', NULL, '2026-01-01T00:00:01.000Z')`).run(lifecycleEntity)).toThrow(/UNIQUE/);
    db.close();
  });
});
