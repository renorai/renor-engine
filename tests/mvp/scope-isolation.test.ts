import Database from '../../src/db/sqlite';
import { describe, expect, it } from 'vitest';
import {
  dailyDirForScope, normalizeScope, notePathMatchesScope, savedScopeMatches, savedScopeSqlPredicate, scopeSqlPredicate,
} from '../../src/mvp/scope';
import { lookupEntity } from '../../src/retrieval/entityLookup';

/**
 * The scope rule now has two implementations: notePathMatchesScope (JS, over a
 * vault-relative path) and scopeSqlPredicate (SQL, over a stored path). A scope
 * that means one thing in JS and another in SQL is an isolation bug waiting to
 * happen, so they are pinned against each other over the path forms the engine
 * really stores.
 */

const PATHS = [
  'People/Ada.md',
  'Memory/Daily/2026-10-02.md',
  'Memory/Scopes/alpha/Notes/Acme.md',
  'Memory/Scopes/beta/Notes/Globex.md',
  'Memory/Scopes/alpha/Daily/2026-10-02.md',
  'Memory/Scopes/alpha',
  '_mcp_',
  '/vault/Memory/Scopes/alpha/Notes/Acme.md',
  '/vault/Memory/Scopes/beta/Notes/Globex.md',
  '/vault/People/Ada.md',
  '/vault/Memory/Daily/2026-10-02.md',
  '/srv/vault-1/Memory/Scopes/alpha/Notes/Acme.md',
  // Another case is another folder to the JS rule: SQLite's LIKE folds ASCII case, so the SQL rule may not use it.
  'memory/scopes/alpha/Notes/Acme.md',
  'MEMORY/SCOPES/alpha',
  // Paths stored on Windows are separated by backslashes; the JS rule reads them as '/', and so must the SQL rule (#1563).
  'Memory\\Scopes\\alpha\\Notes\\Acme.md',
  'C:\\vault\\Memory\\Scopes\\beta\\Notes\\Globex.md',
  'C:\\vault\\Memory\\Daily\\2026-10-02.md',
  'Memory\\Scopes\\alpha',
];

const SCOPES = ['global', 'scope:alpha', 'scope:beta', 'project:alpha'] as const;

describe('scopeSqlPredicate agrees with notePathMatchesScope', () => {
  for (const scope of SCOPES) {
    it(`${scope}: SQL and JS accept exactly the same paths`, () => {
      const norm = normalizeScope(scope);
      const { sql, params } = scopeSqlPredicate(norm, 'stored_path');
      const db = new Database(':memory:');
      db.exec('CREATE TABLE t (stored_path TEXT)');
      const insert = db.prepare('INSERT INTO t VALUES (?)');
      const select = db.prepare<string[], { in_scope: number }>(`SELECT 1 AS in_scope FROM t WHERE stored_path = ? AND ${sql}`);
      for (const p of PATHS) {
        insert.run(p);
        const inSql = select.get(p, ...params)?.in_scope === 1;
        expect({ path: p, inScope: inSql }).toEqual({ path: p, inScope: notePathMatchesScope(p, norm) });
      }
      db.close();
    });
  }
});

describe('notes and facts follow one scope rule', () => {
  // Every spelling an agent can send for two slugs and for global: a named scope is its slug, whatever the kind.
  const SPELLINGS = ['global', '', 'alpha', 'scope:alpha', 'project:alpha', ' Project:Alpha ', 'beta', 'project:beta'];

  it('a note and a fact saved in the same scope are read in exactly the same scopes, by the JS and the SQL rule alike', () => {
    const db = new Database(':memory:');
    for (const savedAs of SPELLINGS) {
      const saved = normalizeScope(savedAs);
      const note = `${dailyDirForScope(saved)}/2026-10-03.md`; // where a note saved in this spelling is written
      for (const readAs of SPELLINGS) {
        const read = normalizeScope(readAs);
        const { sql, params } = savedScopeSqlPredicate(read, 'saved');
        const factInSql = db.prepare(`SELECT 1 AS hit FROM (SELECT ? AS saved) WHERE ${sql}`).get(saved, ...params) !== undefined;
        const noteIn = notePathMatchesScope(note, read);
        expect({ savedAs, readAs, fact: savedScopeMatches(saved, read), factInSql })
          .toEqual({ savedAs, readAs, fact: noteIn, factInSql: noteIn });
      }
    }
    db.close();
  });
});

describe('lookupEntity applies a scope restriction inside the search', () => {
  function seeded() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE entities (
      id INTEGER PRIMARY KEY, type TEXT, canonical_name TEXT, aliases_json TEXT,
      source_note TEXT, confidence REAL, updated_at TEXT
    )`);
    const insert = db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,1.0,?)');
    // A shorter out-of-scope name that would shadow the in-scope one if the
    // scope were applied after the lookup instead of inside it.
    insert.run(1, 'project', 'Globex', '[]', '/vault/Memory/Scopes/beta/Notes/Globex.md', '2026-10-01');
    insert.run(2, 'project', 'Acme Robotics', '[]', '/vault/Memory/Scopes/alpha/Notes/Acme Robotics.md', '2026-10-01');
    insert.run(3, 'person', 'Ada', '["countess"]', '/vault/People/Ada.md', '2026-10-01');
    insert.run(4, 'concept', 'Neovim', '[]', '_mcp_', '2026-10-01');
    return db;
  }

  it('finds the in-scope entity even when an out-of-scope row would match first', () => {
    const db = seeded();
    const alpha = scopeSqlPredicate(normalizeScope('scope:alpha'), 'source_note');
    // "Acme" matches nothing in alpha by exact name, but "Acme Robotics" does by
    // canonical-name substring — inside alpha.
    expect(lookupEntity(db, 'Acme', alpha)?.canonicalName).toBe('Acme Robotics');
    // Unscoped, "Acme" resolves by substring too. To the path rule alone the
    // reserved _mcp_ row reads as global; lookup_entity judges that row by the
    // scopes of its facts instead (entityScopeFilter, lookup-entity-scope.test.ts).
    expect(lookupEntity(db, 'Neovim')?.canonicalName).toBe('Neovim');
    expect(lookupEntity(db, 'Neovim', scopeSqlPredicate(normalizeScope('global'), 'source_note'))?.canonicalName).toBe('Neovim');
    expect(lookupEntity(db, 'Neovim', scopeSqlPredicate(normalizeScope('scope:alpha'), 'source_note'))).toBeNull();
    db.close();
  });

  it('never returns an entity from outside the requested scope', () => {
    const db = seeded();
    for (const scope of SCOPES) {
      const row = lookupEntity(db, 'Acme', scopeSqlPredicate(normalizeScope(scope), 'source_note'));
      if (row) expect(notePathMatchesScope(row.sourceNote, normalizeScope(scope))).toBe(true);
    }
    // Beta's own entity is reachable from beta and from no other scope.
    expect(lookupEntity(db, 'Globex', scopeSqlPredicate(normalizeScope('scope:beta'), 'source_note')))
      .toMatchObject({ sourceNote: expect.stringContaining('beta') });
    for (const scope of ['global', 'scope:alpha'] as const) {
      expect(lookupEntity(db, 'Globex', scopeSqlPredicate(normalizeScope(scope), 'source_note'))).toBeNull();
    }
    // An alias resolves inside its own scope and nowhere else.
    expect(lookupEntity(db, 'countess', scopeSqlPredicate(normalizeScope('global'), 'source_note'))?.canonicalName).toBe('Ada');
    expect(lookupEntity(db, 'countess', scopeSqlPredicate(normalizeScope('scope:alpha'), 'source_note'))).toBeNull();
    db.close();
  });
});