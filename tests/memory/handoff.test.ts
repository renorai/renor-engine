import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { hasHandoffTable } from '../../src/db/handoffTable';
import { removeTestDir } from '../helpers/removeDb';
import {
  HANDOFF_TTL_MS, handoffNoteEnabled, normaliseBranch, normaliseRepoKey, presentHandoffNote, readHandoffNote, runHandoffTool, writeHandoffNote,
} from '../../src/memory/handoff';

// Synthetic only. The gate of I6 as unit tests over the store: one note per repository and branch, overwritten; another
// branch or repository never sees it; gone after 7 days. tests/mvp/handoff-note.test.ts proves no read tool returns it.
const NOW = new Date('2026-10-22T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
const handles: ReturnType<typeof openDb>[] = [];

function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  dirs.push(dir);
  const database = openDb(path.join(dir, 'renor.db'));
  handles.push(database);
  runMigrations(database);
  return database;
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) removeTestDir(dir);
});

const REPO = 'git@github.com:Acme/Fjord.git';

describe('handoff note: keys', () => {
  it('one key per repository however its remote was cloned, with credentials and ports dropped', () => {
    for (const remote of [
      'git@github.com:Acme/Fjord.git', 'https://github.com/acme/fjord', 'https://github.com/acme/fjord.git/',
      'https://alice:ghp_synthetictoken123@github.com/Acme/Fjord.git', 'ssh://git@github.com:22/acme/fjord.git',
      'ssh://git@github.com/acme/fjord', '  https://GitHub.com/acme//fjord  ',
    ]) expect(normaliseRepoKey(remote), remote).toBe('remote:github.com/acme/fjord');
    expect(normaliseRepoKey('https://gitlab.example.test/group/sub/proj.git')).toBe('remote:https//gitlab.example.test/group/sub/proj.git');
    expect(normaliseRepoKey('/home/you/Fjord/')).toBe('path:/home/you/Fjord');
    expect(normaliseRepoKey('file:///home/you/Fjord')).toBe('path:/home/you/Fjord');
    expect(normaliseRepoKey('/home/you/Fjord')).not.toBe(normaliseRepoKey('/home/you/fjord'));
  });

  it('branches: refs/heads/ is dropped; empty and a detached HEAD are refused', () => {
    expect(normaliseBranch(' refs/heads/feature/x ')).toBe('feature/x');
    expect(() => normaliseBranch('')).toThrow(/needs branch/);
    expect(() => normaliseBranch('HEAD')).toThrow(/detached/);
    expect(() => normaliseRepoKey('   ')).toThrow(/needs repo/);
  });

  it('a credential in the remote is never stored', async () => {
    const database = db();
    await writeHandoffNote(database, { repo: 'https://alice:ghp_synthetictoken123@github.com/acme/fjord.git', branch: 'main', note: 'Mid-refactor.', writer: 'claude-code', now: NOW });
    const rows = JSON.stringify(database.prepare('SELECT * FROM handoff_notes').all());
    expect(rows).not.toMatch(/ghp_|alice/);
  });
});

describe('handoff note: store', () => {
  it('overwriting keeps exactly one note per repository and branch, the latest, never appended', async () => {
    const database = db();
    const first = await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'First: halfway through the parser.', writer: 'claude-code', now: NOW });
    expect(first.replaced).toBe(false);
    const second = await writeHandoffNote(database, { repo: 'https://github.com/acme/fjord', branch: 'main', note: 'Second: parser done, next the tests.', writer: 'codex', now: new Date(NOW.getTime() + 60_000) });
    expect(second.replaced).toBe(true);
    const rows = database.prepare('SELECT * FROM handoff_notes').all() as Array<{ note: string; writer: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe('Second: parser done, next the tests.');
    expect(rows[0].note).not.toContain('First');
    expect(rows[0].writer).toBe('codex');
  });

  it('another branch or another repository never sees it', async () => {
    const database = db();
    await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'Main note.', writer: 'claude-code', now: NOW });
    expect(readHandoffNote(database, { repo: REPO, branch: 'feature/x', now: NOW })).toBeNull();
    expect(readHandoffNote(database, { repo: 'git@github.com:acme/fjord-docs.git', branch: 'main', now: NOW })).toBeNull();
    expect(readHandoffNote(database, { repo: 'git@gitlab.com:acme/fjord.git', branch: 'main', now: NOW })).toBeNull();
    expect(readHandoffNote(database, { repo: 'git@github.com:other/fjord.git', branch: 'main', now: NOW })).toBeNull();
    expect(readHandoffNote(database, { repo: REPO, branch: 'Main', now: NOW })).toBeNull();
    expect(readHandoffNote(database, { repo: REPO, branch: 'main', now: NOW })?.note).toBe('Main note.');
    await writeHandoffNote(database, { repo: REPO, branch: 'feature/x', note: 'Feature note.', writer: 'codex', now: NOW });
    expect(readHandoffNote(database, { repo: REPO, branch: 'main', now: NOW })?.note).toBe('Main note.');
    expect(readHandoffNote(database, { repo: REPO, branch: 'feature/x', now: NOW })?.note).toBe('Feature note.');
  });

  it('expires 7 days after it was written, and is deleted, not only hidden', async () => {
    const database = db();
    await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'Will expire.', writer: 'claude-code', now: NOW });
    expect(readHandoffNote(database, { repo: REPO, branch: 'main', now: new Date(NOW.getTime() + 6 * DAY + 23 * 3600_000) })?.note).toBe('Will expire.');
    expect(readHandoffNote(database, { repo: REPO, branch: 'main', now: new Date(NOW.getTime() + HANDOFF_TTL_MS) })).toBeNull();
    expect(database.prepare('SELECT COUNT(*) AS c FROM handoff_notes').get()).toEqual({ c: 0 });
  });

  it('a rewrite restarts the 7 days; a later write purges expired notes of other branches', async () => {
    const database = db();
    await writeHandoffNote(database, { repo: REPO, branch: 'stale', note: 'Stale.', writer: 'a', now: NOW });
    await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'Old.', writer: 'a', now: NOW });
    await writeHandoffNote(database, { repo: REPO, branch: 'main', note: 'Fresh.', writer: 'a', now: new Date(NOW.getTime() + 5 * DAY) });
    expect(readHandoffNote(database, { repo: REPO, branch: 'main', now: new Date(NOW.getTime() + 8 * DAY) })?.note).toBe('Fresh.');
    await writeHandoffNote(database, { repo: REPO, branch: 'other', note: 'Other.', writer: 'a', now: new Date(NOW.getTime() + 8 * DAY) });
    expect(database.prepare('SELECT branch FROM handoff_notes ORDER BY branch').all()).toEqual([{ branch: 'main' }, { branch: 'other' }]);
  });

  it('over 200 words is refused, never cut, and nothing is written', async () => {
    const database = db();
    const long = Array.from({ length: 201 }, (_, i) => `w${i}`).join(' ');
    await expect(writeHandoffNote(database, { repo: REPO, branch: 'main', note: long, writer: 'a', now: NOW })).rejects.toThrow(/201 words; at most 200/);
    await expect(writeHandoffNote(database, { repo: REPO, branch: 'main', note: '   ', writer: 'a', now: NOW })).rejects.toThrow(/needs note/);
    // A refused write writes nothing, not even the table.
    expect(hasHandoffTable(database)).toBe(false);
    const exactly = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    await expect(writeHandoffNote(database, { repo: REPO, branch: 'main', note: exactly, writer: 'a', now: NOW })).resolves.toMatchObject({ replaced: false });
  });

  it('runHandoffTool: the documented entry, read and write, with the date and the writer shown', async () => {
    const database = db();
    expect(await runHandoffTool(database, { action: 'read', repo: REPO, branch: 'main' }, 'claude-code', NOW))
      .toEqual({ ok: true, action: 'read', found: false, repo: 'remote:github.com/acme/fjord', branch: 'main' });
    const wrote = await runHandoffTool(database, { action: 'write', repo: REPO, branch: 'main', note: 'In progress: X. Next: Y. Open: Z?' }, 'claude-code', NOW);
    expect(wrote).toMatchObject({ ok: true, action: 'write', replaced: false, words: 7, writer: 'claude-code', written_at: NOW.toISOString() });
    const read = await runHandoffTool(database, { action: 'read', repo: REPO, branch: 'main' }, 'codex', new Date(NOW.getTime() + 2 * DAY));
    expect(read).toMatchObject({ found: true, note: 'In progress: X. Next: Y. Open: Z?', writer: 'claude-code' });
    expect(read.shown).toBe(presentHandoffNote(read as any, new Date(NOW.getTime() + 2 * DAY)));
    expect(read.shown).toContain('written 2026-10-22 09:00 UTC (2 days ago) by claude-code');
  });

  it('is off unless RENOR_HANDOFF_NOTE is an on value', () => {
    expect(handoffNoteEnabled({})).toBe(false);
    expect(handoffNoteEnabled({ RENOR_HANDOFF_NOTE: '0' })).toBe(false);
    expect(handoffNoteEnabled({ RENOR_HANDOFF_NOTE: 'maybe' })).toBe(false);
    for (const on of ['1', 'true', 'YES', ' on ']) expect(handoffNoteEnabled({ RENOR_HANDOFF_NOTE: on })).toBe(true);
  });
});
