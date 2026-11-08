/**
 * Regressions for the Frontier review of PR 819 (head ef432321, NOT-MERGE). Each case failed on that head:
 *  1. distinct repositories shared a key (a dropped port, folded path case on any host, `.git` dropped from a local path),
 *     so one repository's read returned another's note;
 *  2. with RENOR_HANDOFF_NOTE off, opening a database added a table and a schema version;
 *  3. with it off, export_memory's manifest listed a handoff entry;
 *  4. expiry ran only on handoff reads and writes, a clock set back kept a note alive, and a deleted or replaced note's
 *     text stayed readable in the database file.
 * Synthetic fixtures only.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { ensureHandoffTable, hasHandoffTable } from '../../src/db/handoffTable';
import { HANDOFF_TTL_MS, normaliseRepoKey, readHandoffNote, startHandoffSweep, sweepHandoffNotes, writeHandoffNote, type HandoffClock } from '../../src/memory/handoff';
import { NOT_EXPORTED, notExported } from '../../src/mvp/exportAll';
import { describeSalvage, restoreIndexTables, salvageIndexTables } from '../../src/db/indexSalvage';
import { named, restoreEnv, startWorkspace } from '../helpers/hiveHarness';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

const NOW = new Date('2026-10-22T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-819-'));
  dirs.push(dir);
  return dir;
}
const handles: Array<ReturnType<typeof openDb>> = [];
function db(file = path.join(tmp(), 'index.db')) {
  const database = openDb(file);
  handles.push(database);
  runMigrations(database);
  return { database, file };
}
/** Whether `marker` is anywhere in the database file or its -wal. */
function onDisk(file: string, marker: string): string[] {
  return [file, `${file}-wal`].filter(f => fs.existsSync(f) && fs.readFileSync(f).includes(marker)).map(f => path.basename(f));
}
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(restoreEnv);

describe('819-1: one key per repository, never shared by two', () => {
  // Each pair names two different repositories; on ef432321 every pair got one key.
  const DISTINCT: Array<[string, string]> = [
    ['https://git.example.test:8443/acme/fjord', 'https://git.example.test/acme/fjord'],
    ['ssh://git@git.example.test:2222/acme/fjord.git', 'git@git.example.test:acme/fjord.git'],
    ['https://git.example.test/Acme/Fjord', 'https://git.example.test/acme/fjord'],
    ['https://git.example.test/acme/fjord.git', 'https://git.example.test/acme/fjord'],
    ['https://git.example.test/acme/fjord', 'git@git.example.test:acme/fjord'],
    ['/srv/repos/fjord.git', '/srv/repos/fjord'],
    ['/srv/repos/Fjord', '/srv/repos/fjord'],
    ['https://git.example.test//acme/fjord', 'https://git.example.test/acme/fjord'],
    ['/srv/x', 'git@srv:x'],
    // Re-review of 1670b4f0: a home-relative and a root-absolute scp path were one key.
    ['git@git.example.test:acme/fjord', 'git@git.example.test:/acme/fjord'],
    ['git@git.example.test:acme/fjord', 'ssh://git@git.example.test/acme/fjord'],
    ['alice@git.example.test:fjord', 'bob@git.example.test:fjord'],
    ['git@git.example.test:2222/fjord', 'ssh://git@git.example.test:2222/fjord'],
    ['https://git.example.test/acme/fjord/', 'https://git.example.test/acme/fjord'],
  ];
  // Each group names one repository and keeps one key.
  const SAME: string[][] = [
    ['git@github.com:Acme/Fjord.git', 'https://github.com/acme/fjord', 'https://u:ghp_synthetic123@github.com/acme/fjord.git/', 'ssh://git@github.com:22/acme/fjord'],
    ['ssh://git@git.example.test/acme/fjord', 'git@git.example.test:/acme/fjord', 'ssh://other@git.example.test:22/acme/fjord'],
    ['git@git.example.test:~/fjord', 'ssh://git@git.example.test/~/fjord', 'ssh://git:secretpw@git.example.test:22/~/fjord'],
    ['https://git.example.test/acme/fjord', 'http://git.example.test/acme/fjord', 'https://git.example.test:443/acme/fjord'],
    ['/srv/repos/fjord/', '/srv/repos/fjord', 'file:///srv/repos/fjord'],
  ];

  it('two repositories that collided on ef432321 get two keys', () => {
    for (const [a, b] of DISTINCT) expect(normaliseRepoKey(a), `${a} vs ${b}`).not.toBe(normaliseRepoKey(b));
  });

  it('spellings of one repository still share a key, with no credential in it', () => {
    for (const group of SAME) {
      const keys = new Set(group.map(normaliseRepoKey));
      expect(keys.size, group.join(' | ')).toBe(1);
      // A password never; a login name only where it decides the path (relative to that login's home).
      expect([...keys][0]).not.toMatch(/ghp_|secretpw|u@|other@/);
    }
  });

  it('the key says what kind it is, so a path and a remote never meet', () => {
    expect(normaliseRepoKey('git@github.com:acme/fjord.git')).toBe('remote:github.com/acme/fjord');
    expect(normaliseRepoKey('https://git.example.test:8443/acme/fjord')).toBe('remote:https//git.example.test:8443/acme/fjord');
    expect(normaliseRepoKey('/srv/repos/fjord.git')).toBe('path:/srv/repos/fjord.git');
    expect(normaliseRepoKey('C:\\Users\\you\\fjord')).toBe('path:C:/Users/you/fjord');
    expect(normaliseRepoKey('git@git.example.test:acme/fjord')).toBe('remote:ssh-home//git@git.example.test|acme/fjord');
    expect(normaliseRepoKey('git@git.example.test:/acme/fjord')).toBe('remote:ssh//git.example.test/acme/fjord');
  });

  it('a read in one repository of a colliding pair never returns the other\'s note', async () => {
    const { database } = db();
    for (const [i, [a, b]] of DISTINCT.entries()) {
      await writeHandoffNote(database, { repo: a, branch: 'main', note: `note-a-${i}`, writer: 'w', now: NOW });
      expect(readHandoffNote(database, { repo: b, branch: 'main', now: NOW })?.note ?? null, `${a} -> ${b}`).not.toBe(`note-a-${i}`);
    }
  });
});

describe('819-2: with the switch off, the database is untouched', () => {
  it('opening a database creates no handoff table, and leaves its bytes as they were', () => {
    delete process.env.RENOR_HANDOFF_NOTE;
    const { database, file } = db();
    expect(hasHandoffTable(database)).toBe(false);
    database.close();
    const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const reopened = openDb(file);
    runMigrations(reopened);
    expect(hasHandoffTable(reopened)).toBe(false);
    reopened.close();
    expect(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(before);
  });

  it('no migration creates the handoff table', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/db/migrations.ts'), 'utf8');
    expect(source).not.toMatch(/handoff/i);
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a hosted workspace run with the switch off never gets the table, through saves, reads and an export', async () => {
    delete process.env.RENOR_HANDOFF_NOTE;
    const ws = await startWorkspace();
    try {
      const client = await ws.connect(named('claude-code'));
      await ws.call(client, 'remember', { statement: 'The Fjord project stores its data in SQLite.' });
      await ws.call(client, 'get_context', { query: 'Fjord' });
      await client.callTool({ name: 'export_memory', arguments: {} });
      await client.close();
      const check = openDb(ws.config.dbPath);
      try { expect(hasHandoffTable(check)).toBe(false); } finally { check.close(); }
    } finally { await ws.close(); }
  }, 60_000);
});

describe('819-2: index salvage without the table is what it was; with it, the notes come back', () => {
  it('a damaged index with no handoff table salvages and logs only the three tables it always did', () => {
    const { database } = db();
    const salvage = salvageIndexTables(database);
    expect(Object.keys(salvage.rows)).toEqual(['agent_requests', 'agent_cursors', 'known_agents']);
    const fresh = db().database;
    const { restored, rejected } = restoreIndexTables(fresh, salvage);
    expect(describeSalvage(salvage, restored, rejected)).toBe('Kept from the damaged index: agent_requests 0, agent_cursors 0, known_agents 0.');
    expect(hasHandoffTable(fresh)).toBe(false);
  });

  it('a damaged index with handoff notes carries them into the rebuilt one, creating the table there', async () => {
    const { database } = db();
    await writeHandoffNote(database, { repo: 'git@github.com:acme/fjord.git', branch: 'main', note: 'Next: tests.', writer: 'w', now: new Date() });
    const salvage = salvageIndexTables(database);
    const fresh = db().database;
    const { restored } = restoreIndexTables(fresh, salvage);
    expect(restored.handoff_notes).toBe(1);
    expect(readHandoffNote(fresh, { repo: 'https://github.com/acme/fjord', branch: 'main' })?.note).toBe('Next: tests.');
  });
});

describe('819-3: with the switch off, export_memory\'s manifest is unchanged', () => {
  it('notExported is the list without a handoff entry when off, and names it when on', () => {
    expect(notExported({})).toBe(NOT_EXPORTED);
    expect(NOT_EXPORTED.map(e => e.kind)).not.toContain('handoffNotes');
    expect(notExported({ RENOR_HANDOFF_NOTE: '1' }).map(e => e.kind)).toEqual([...NOT_EXPORTED.map(e => e.kind), 'handoffNotes']);
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('the hosted export reply carries the same notExported as without this change', async () => {
    delete process.env.RENOR_HANDOFF_NOTE;
    const ws = await startWorkspace();
    try {
      const client = await ws.connect(named('claude-code'));
      const res = await client.callTool({ name: 'export_memory', arguments: {} });
      const manifest = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      // The kinds main lists (tests/mvp/export-everything.test.ts), and nothing more.
      expect(manifest.notExported.map((e: { kind: string }) => e.kind)).toEqual(
        ['agentRequests', 'importReceipts', 'activity', 'agentState', 'searchHistory', 'searchIndex', 'sharingStore', 'otherFiles']);
      expect(manifest.notExported).toEqual(NOT_EXPORTED);
      await client.close();
    } finally { await ws.close(); }
  }, 60_000);
});

describe('819-4: expiry is a delete, on a schedule, that a clock rollback cannot extend', () => {
  const REPO = 'git@github.com:acme/fjord.git';

  it('the sweep deletes an expired note without any read or write, and its text is gone from the file and the -wal', async () => {
    const { database, file } = db();
    await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'zqmarkerexpiredzq in progress', writer: 'w', now: NOW });
    database.pragma('wal_checkpoint(TRUNCATE)');
    expect(onDisk(file, 'zqmarkerexpiredzq')).not.toEqual([]);
    const stop = startHandoffSweep(database, 60_000, { wall: () => NOW.getTime() + HANDOFF_TTL_MS });
    stop();
    expect(database.prepare('SELECT COUNT(*) AS c FROM handoff_notes').get()).toEqual({ c: 0 });
    expect(onDisk(file, 'zqmarkerexpiredzq')).toEqual([]);
    database.close();
    expect(onDisk(file, 'zqmarkerexpiredzq')).toEqual([]);
  });

  it('an overwritten note\'s old text is gone from disk', async () => {
    const { database, file } = db();
    await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'zqmarkeroldzq first version', writer: 'w', now: NOW });
    await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'second', writer: 'w', now: NOW });
    database.close();
    expect(onDisk(file, 'zqmarkeroldzq')).toEqual([]);
  });

  it('a note dated ahead of this workspace\'s clock (written by a faster clock) is not shown, and is deleted', async () => {
    const { database, file } = db();
    ensureHandoffTable(database);
    database.prepare('INSERT INTO handoff_notes VALUES (?, ?, ?, ?, ?, ?)').run(normaliseRepoKey(REPO), 'main', 'zqmarkerfuturezq', 'w',
      new Date(NOW.getTime() + 30 * DAY).toISOString(), new Date(NOW.getTime() + 37 * DAY).toISOString());
    expect(readHandoffNote(database, { repo: REPO, branch: 'main', now: NOW })).toBeNull();
    expect(database.prepare('SELECT COUNT(*) AS c FROM handoff_notes').get()).toEqual({ c: 0 });
    database.close();
    expect(onDisk(file, 'zqmarkerfuturezq')).toEqual([]);
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a hosted server with the switch on sweeps an expired note at start, with no handoff call', async () => {
    const memoryDir = tmp();
    const dbPath = path.join(memoryDir, '.memory-index', 'index.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const seeded = openDb(dbPath);
    runMigrations(seeded);
    ensureHandoffTable(seeded);
    seeded.prepare('INSERT INTO handoff_notes VALUES (?, ?, ?, ?, ?, ?)')
      .run('remote:github.com/acme/fjord', 'main', 'zqmarkerseededzq', 'w', new Date(Date.now() - 8 * DAY).toISOString(), new Date(Date.now() - DAY).toISOString());
    seeded.close();
    expect(onDisk(dbPath, 'zqmarkerseededzq')).not.toEqual([]);
    process.env.RENOR_HANDOFF_NOTE = '1';
    const ws = await startWorkspace({ memoryDir });
    try {
      const check = openDb(dbPath);
      try { expect(check.prepare('SELECT COUNT(*) AS c FROM handoff_notes').get()).toEqual({ c: 0 }); } finally { check.close(); }
      expect(onDisk(dbPath, 'zqmarkerseededzq')).toEqual([]);
    } finally {
      await ws.close();
      delete process.env.RENOR_HANDOFF_NOTE;
    }
  }, 60_000);
});

describe('819 re-review of 1670b4f0', () => {
  const REPO = 'git@github.com:acme/fjord.git';

  it('P1: a note written through a home-relative scp address is not read through the root-absolute one', async () => {
    const { database } = db();
    await writeHandoffNote(database, { repo: 'git@git.example.test:acme/fjord', branch: 'main', note: 'relative repo note', writer: 'w', now: NOW });
    expect(readHandoffNote(database, { repo: 'git@git.example.test:/acme/fjord', branch: 'main', now: NOW })).toBeNull();
    expect(readHandoffNote(database, { repo: 'ssh://git@git.example.test/acme/fjord', branch: 'main', now: NOW })).toBeNull();
    expect(readHandoffNote(database, { repo: 'bob@git.example.test:acme/fjord', branch: 'main', now: NOW })).toBeNull();
    expect(readHandoffNote(database, { repo: 'git@git.example.test:acme/fjord', branch: 'main', now: NOW })?.note).toBe('relative repo note');
  });

  it('P2: eight elapsed days expire a note even when the wall clock was set back four days in the middle', async () => {
    const { database } = db();
    // Wall: Oct 1, Oct 7, then set back to Oct 3, then Oct 5. Monotonic: 0, 6, 6, 8 days elapsed.
    let wall = Date.parse('2026-10-01T00:00:00.000Z');
    let mono = 0;
    const clock: HandoffClock = { wall: () => wall, mono: () => mono };
    await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'n', writer: 'w', clock });
    wall += 6 * DAY; mono += 6 * DAY;
    expect(readHandoffNote(database, { repo: REPO, branch: 'main', clock })?.note).toBe('n');
    wall -= 4 * DAY;
    expect(readHandoffNote(database, { repo: REPO, branch: 'main', clock })?.note).toBe('n');
    wall += 2 * DAY; mono += 2 * DAY;
    expect(readHandoffNote(database, { repo: REPO, branch: 'main', clock })).toBeNull();
  });

  it('P2: across a restart the clock never goes behind the latest instant it gave', async () => {
    const { database, file } = db();
    await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'n', writer: 'w', now: new Date('2026-10-01T00:00:00Z') });
    readHandoffNote(database, { repo: REPO, branch: 'main', now: new Date('2026-10-07T00:00:00Z') });
    database.close();
    // A new process (a new connection, nothing in memory) whose wall clock was set back four days.
    const restarted = openDb(file);
    expect(readHandoffNote(restarted, { repo: REPO, branch: 'main', now: new Date('2026-10-03T00:00:00Z') })?.note).toBe('n');
    // One more day on the stored clock, and the 7 days are over, though the wall clock reads Oct 4.
    expect(readHandoffNote(restarted, { repo: REPO, branch: 'main', clock: { wall: () => Date.parse('2026-10-04T00:00:00Z'), mono: () => 0 } })?.note).toBe('n');
    expect(readHandoffNote(restarted, { repo: REPO, branch: 'main', clock: { wall: () => Date.parse('2026-10-04T00:00:00Z'), mono: () => 1.5 * DAY } })).toBeNull();
    restarted.close();
  });

  it('P2: a checkpoint a reader blocked is retried by a later, otherwise idle sweep until the bytes are gone', async () => {
    const { database, file } = db();
    await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'zqmarkerheldzq', writer: 'w', now: NOW });
    database.pragma('wal_checkpoint(TRUNCATE)');
    const reader = openDb(file);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM handoff_notes').get();
    const later = { wall: () => NOW.getTime() + HANDOFF_TTL_MS };
    sweepHandoffNotes(database, later);
    expect(database.prepare('SELECT COUNT(*) AS c FROM handoff_notes').get()).toEqual({ c: 0 });
    expect(onDisk(file, 'zqmarkerheldzq')).toContain('index.db');
    reader.exec('COMMIT');
    reader.close();
    sweepHandoffNotes(database, later);
    expect(onDisk(file, 'zqmarkerheldzq')).toEqual([]);
    database.close();
    expect(onDisk(file, 'zqmarkerheldzq')).toEqual([]);
  });
});
