import { describe, it, expect, afterEach } from 'vitest';
import { lookupEntity } from '../../src/retrieval/entityLookup';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { tmpPath } from '../helpers/tmpPath';
import { removeDb } from '../helpers/removeDb';

const DB = tmpPath('test-entity.db');
afterEach(() => removeDb(DB));

function seedEntity(db: any) {
  db.prepare("INSERT INTO notes VALUES ('/v/john.md','John Doe','person','h','2026-01-01','{}')").run();
  db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
    .run('person','John Doe','["John","JD"]','/v/john.md',1.0,'2026-01-01');
}

describe('lookupEntity', () => {
  it('finds by canonical name', () => {
    const db = openDb(DB); runMigrations(db); seedEntity(db);
    expect(lookupEntity(db,'John Doe')?.type).toBe('person');
    db.close();
  });

  it('finds by alias', () => {
    const db = openDb(DB); runMigrations(db); seedEntity(db);
    expect(lookupEntity(db,'JD')?.canonicalName).toBe('John Doe');
    db.close();
  });

  it('returns null for unknown name', () => {
    const db = openDb(DB); runMigrations(db);
    expect(lookupEntity(db,'Nobody')).toBeNull();
    db.close();
  });

  it('finds a one-character name that JavaScript counts as two units', () => {
    const db = openDb(DB); runMigrations(db);
    const name = '😀';
    expect(name.length).toBe(2);
    db.prepare("INSERT INTO notes VALUES ('/v/e.md', ?, null, 'h', '2026-01-01', '{}')").run(name);
    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('thing', name, '[]', '/v/e.md', 1, '2026-01-01');
    expect(lookupEntity(db, name)?.canonicalName).toBe(name);
    db.close();
  });

  it('finds a longer name saved after a shorter one was looked up', () => {
    const db = openDb(DB); runMigrations(db);
    db.prepare("INSERT INTO notes VALUES ('/v/a.md','A','t','h','2026-01-01','{}')").run();
    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('thing', 'A', '[]', '/v/a.md', 1, '2026-01-01');
    expect(lookupEntity(db, 'A')?.canonicalName).toBe('A');
    db.prepare("INSERT INTO notes VALUES ('/v/long.md','Longer Name','t','h','2026-01-01','{}')").run();
    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('thing', 'Longer Name', '[]', '/v/long.md', 1, '2026-01-01');
    expect(lookupEntity(db, 'Longer Name')?.sourceNote).toBe('/v/long.md');
    db.close();
  });
});
