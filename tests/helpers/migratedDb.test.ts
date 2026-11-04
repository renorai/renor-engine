import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { openMigratedDb } from './migratedDb';

/**
 * openMigratedDb gives a test the database `openDb` + `runMigrations` would, from a copy of one made earlier. These tests
 * hold it to that: the same schema and migration record, a file of its own, and a database a test can write to.
 */

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const dbIn = (open: (file: string) => Database.Database) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrated-db-'));
  dirs.push(dir);
  const db = open(path.join(dir, 'index.db'));
  dbs.push(db);
  return { dir, db };
};
const migrated = (file: string) => {
  const db = openDb(file);
  runMigrations(db);
  return db;
};
const schemaOf = (db: Database.Database) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();

describe('openMigratedDb', () => {
  it('is the schema a migrated new file has: every table, index, trigger and virtual table, and the version it stopped at', () => {
    const fresh = dbIn(migrated).db;
    const copy = dbIn(openMigratedDb).db;
    expect(schemaOf(copy)).toEqual(schemaOf(fresh));
    expect(schemaOf(copy).length).toBeGreaterThan(20);
    const version = (db: Database.Database) => db.prepare('SELECT version FROM schema_version').pluck().all();
    expect(version(copy)).toEqual(version(fresh));
    expect(version(copy)).toHaveLength(1);
    expect(version(copy)[0] as number).toBeGreaterThanOrEqual(25);
  });

  it('is empty, in WAL mode, with the foreign keys on, as openDb leaves a database', () => {
    const { db } = dbIn(openMigratedDb);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM notes').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM facts').pluck().get()).toBe(0);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('gives each test a file of its own: a write to one is in no other, and none is the template', () => {
    const a = dbIn(openMigratedDb);
    const b = dbIn(openMigratedDb);
    a.db.prepare("INSERT INTO notes (path, title, kind, note_hash, modified_at) VALUES ('a.md', 'A', 'note', 'h', 'now')").run();
    expect(a.db.prepare('SELECT COUNT(*) FROM notes').pluck().get()).toBe(1);
    expect(b.db.prepare('SELECT COUNT(*) FROM notes').pluck().get()).toBe(0);
    const c = dbIn(openMigratedDb);
    expect(c.db.prepare('SELECT COUNT(*) FROM notes').pluck().get()).toBe(0);
    expect(fs.realpathSync(path.join(a.dir, 'index.db'))).not.toBe(fs.realpathSync(path.join(b.dir, 'index.db')));
  });

  it('copies one template for every database it is asked for, and does not run the migrations again', () => {
    dbIn(openMigratedDb); // makes the template, if no test above has asked for it yet
    const copies = vi.spyOn(fs, 'copyFileSync');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) dbIn(openMigratedDb);
      expect(new Set(copies.mock.calls.map((call) => String(call[0]))).size).toBe(1);
      expect(copies.mock.calls).toHaveLength(3);
      // runMigrations logs one database_ready line when it applies any, and there were none to run.
      expect(logged.mock.calls.filter((call) => String(call[0]).includes('"event":"database_ready"'))).toEqual([]);
    } finally {
      copies.mockRestore();
      logged.mockRestore();
    }
  });

  it('puts a copy where it is asked, making the folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrated-db-nested-'));
    dirs.push(dir);
    const file = path.join(dir, 'a', 'b', 'index.db');
    dbs.push(openMigratedDb(file));
    expect(fs.existsSync(file)).toBe(true);
  });
});
