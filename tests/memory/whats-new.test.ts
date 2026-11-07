import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { readWhatsNew, whatsNewPageFromEnv } from '../../src/memory/whatsNew';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const dirs: string[] = [];

function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whats-new-'));
  dirs.push(dir);
  const database = openDb(path.join(dir, 'renor.db'));
  runMigrations(database);
  return database;
}

function save(database: ReturnType<typeof db>, at: string, author: string | null, scope = 'global', action = 'store', summary = 'saved') {
  database.prepare(
    'INSERT INTO write_events (note_path, action, summary, created_at, author, scope) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('_memory_ledger_', action, summary, at, author, scope);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('whats_new', () => {
  it('the first call is the last 7 days, newest first, and a second call does not repeat them', () => {
    const database = db();
    save(database, '2026-09-01T00:00:00.000Z', 'richard', 'global', 'store', 'too old');
    save(database, '2026-10-07T00:00:00.000Z', 'richard', 'global', 'store', 'older');
    save(database, '2026-10-08T01:00:00.000Z', 'grokbot', 'global', 'note', 'newer');
    const first = readWhatsNew(database, { agent: 'firstmate', now: NOW });
    expect(first.items.map((item) => item.summary)).toEqual(['newer', 'older']);
    expect(first.items[0]).toMatchObject({ kind: 'note', source: 'grokbot' });
    expect(first.cursor).toBeNull();
    expect(first.next_since).toBe(NOW.toISOString());
    const second = readWhatsNew(database, { agent: 'firstmate', now: new Date('2026-10-08T13:00:00.000Z') });
    expect(second.items).toEqual([]);
  });

  it('leaves out what this connection wrote, unless asked', () => {
    const database = db();
    save(database, '2026-10-08T01:00:00.000Z', 'firstmate', 'global', 'store', 'mine');
    save(database, '2026-10-08T02:00:00.000Z', 'richard', 'global', 'store', 'theirs');
    save(database, '2026-10-08T03:00:00.000Z', null, 'global', 'store', 'unnamed');
    const hidden = readWhatsNew(database, { agent: 'firstmate', now: NOW });
    expect(hidden.items.map((item) => item.summary)).toEqual(['unnamed', 'theirs']);
    expect(hidden.items[0].source).toBe('unnamed');
    const shown = readWhatsNew(database, { agent: 'other', includeOwn: true, now: NOW });
    expect(shown.items.map((item) => item.summary)).toEqual(['unnamed', 'theirs', 'mine']);
  });

  it('a full page returns a cursor, and the next page neither repeats nor skips', () => {
    const database = db();
    save(database, '2026-10-08T01:00:00.000Z', 'richard', 'global', 'store', 'one');
    save(database, '2026-10-08T02:00:00.000Z', 'richard', 'global', 'store', 'two');
    save(database, '2026-10-08T03:00:00.000Z', 'richard', 'global', 'store', 'three');
    const page = readWhatsNew(database, { agent: 'firstmate', now: NOW, limit: 2 });
    expect(page.items.map((item) => item.summary)).toEqual(['three', 'two']);
    expect(page.cursor).toBeTruthy();
    expect(page.next_since).toBeNull();
    const rest = readWhatsNew(database, { agent: 'firstmate', now: NOW, limit: 2, cursor: page.cursor! });
    expect(rest.items.map((item) => item.summary)).toEqual(['one']);
    expect(rest.cursor).toBeNull();
    const again = readWhatsNew(database, { agent: 'firstmate', now: new Date('2026-10-08T13:00:00.000Z') });
    expect(again.items).toEqual([]);
  });

  it('with no limit named, the default page is 5 items and the rest come by cursor', () => {
    const database = db();
    for (let i = 1; i <= 7; i++) save(database, `2026-10-08T0${i}:00:00.000Z`, 'richard', 'global', 'store', `item ${i}`);
    const limit = whatsNewPageFromEnv({});
    expect(limit).toBe(5);
    const page = readWhatsNew(database, { agent: 'firstmate', now: NOW, limit });
    expect(page.items.map((item) => item.summary)).toEqual(['item 7', 'item 6', 'item 5', 'item 4', 'item 3']);
    expect(page.cursor).toBeTruthy();
    const rest = readWhatsNew(database, { agent: 'firstmate', now: NOW, limit, cursor: page.cursor! });
    expect(rest.items.map((item) => item.summary)).toEqual(['item 2', 'item 1']);
    expect(rest.cursor).toBeNull();
  });

  it('a scope sees only that scope', () => {
    const database = db();
    save(database, '2026-10-08T01:00:00.000Z', 'richard', 'project:atlas', 'store', 'atlas');
    save(database, '2026-10-08T02:00:00.000Z', 'richard', 'global', 'store', 'global');
    const scoped = readWhatsNew(database, { agent: 'firstmate', scope: 'project:atlas', now: NOW });
    expect(scoped.items.map((item) => item.summary)).toEqual(['atlas']);
  });
  it('every spelling of a scope reads the same rows and shares one mark, and an unscoped row is global', () => {
    const database = db();
    save(database, '2026-10-08T01:00:00.000Z', 'richard', 'project:atlas', 'store', 'atlas');
    database.prepare(
      'INSERT INTO write_events (note_path, action, summary, created_at, author, scope) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run('Memory/Daily/2026-10-08.md', 'retire', 'old row', '2026-10-08T02:00:00.000Z', 'richard');
    for (const spelling of ['atlas', 'scope:atlas', 'project:atlas', 'Project:Atlas']) {
      expect(readWhatsNew(database, { agent: `reader-${spelling}`, scope: spelling, now: NOW }).items.map((item) => item.summary), spelling)
        .toEqual(['atlas']);
    }
    expect(readWhatsNew(database, { agent: 'firstmate', scope: 'global', now: NOW }).items.map((item) => item.summary)).toEqual(['old row']);
    expect(readWhatsNew(database, { agent: 'firstmate', scope: 'atlas', now: NOW }).items.map((item) => item.summary)).toEqual(['atlas']);
    expect(readWhatsNew(database, { agent: 'firstmate', scope: 'project:atlas', now: new Date('2026-10-08T13:00:00.000Z') }).items).toEqual([]);
  });

  it('an explicit since is a peek: writes before it are still shown to the next plain call, across its pages too', () => {
    const database = db();
    readWhatsNew(database, { agent: 'beta', now: NOW });
    save(database, '2026-10-08T12:01:00.000Z', 'alpha', 'global', 'note', 'before the peek');
    save(database, '2026-10-08T12:03:00.000Z', 'alpha', 'global', 'note', 'after the peek');
    const later = new Date('2026-10-08T12:10:00.000Z');
    const peek = readWhatsNew(database, { agent: 'beta', since: '2026-10-08T12:02:00.000Z', now: later });
    expect(peek.items.map((item) => item.summary)).toEqual(['after the peek']);
    const paged = readWhatsNew(database, { agent: 'beta', since: '2026-10-08T00:00:00.000Z', now: later, limit: 1 });
    expect(paged.cursor).toBeTruthy();
    readWhatsNew(database, { agent: 'beta', now: later, limit: 1, cursor: paged.cursor! });
    const plain = readWhatsNew(database, { agent: 'beta', now: new Date('2026-10-08T12:11:00.000Z') });
    expect(plain.items.map((item) => item.summary)).toEqual(['after the peek', 'before the peek']);
  });

  it('a write in the same millisecond as a read is shown by the next read, once', () => {
    const database = db();
    readWhatsNew(database, { agent: 'beta', now: NOW });
    save(database, NOW.toISOString(), 'alpha', 'global', 'note', 'same-ms');
    const next = readWhatsNew(database, { agent: 'beta', now: new Date('2026-10-08T12:00:05.000Z') });
    expect(next.items.map((item) => item.summary)).toEqual(['same-ms']);
    const after = readWhatsNew(database, { agent: 'beta', now: new Date('2026-10-08T12:00:10.000Z') });
    expect(after.items).toEqual([]);
  });

  it('a row at the as_of of a read is left for the next read, not shown twice', () => {
    const database = db();
    save(database, NOW.toISOString(), 'alpha', 'global', 'note', 'at as_of');
    const first = readWhatsNew(database, { agent: 'beta', now: NOW });
    expect(first.items.map((item) => item.summary)).toEqual([]);
    const second = readWhatsNew(database, { agent: 'beta', now: new Date('2026-10-08T12:00:05.000Z') });
    expect(second.items.map((item) => item.summary)).toEqual(['at as_of']);
    expect(readWhatsNew(database, { agent: 'beta', now: new Date('2026-10-08T12:00:10.000Z') }).items).toEqual([]);
  });
});
