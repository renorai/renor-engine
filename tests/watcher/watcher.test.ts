import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import fs from 'fs';

const DB = tmpPath('test-watcher.db');

// Mock chokidar
const mockOn = vi.fn().mockReturnThis();
const mockClose = vi.fn();
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({ on: mockOn, close: mockClose })),
  },
}));

// Mock indexFile
vi.mock('../../src/indexer/pipeline', () => ({
  indexFile: vi.fn().mockResolvedValue(undefined),
}));

import { startWatcher } from '../../src/watcher/watcher';
import chokidar from 'chokidar';
import { tmpPath } from '../helpers/tmpPath';
import { indexFile } from '../../src/indexer/pipeline';
import { captureConsole, errorNaming } from '../helpers/consoleCapture';

beforeEach(() => {
  vi.clearAllMocks();
  mockOn.mockReturnThis();
});

afterEach(() => { if (fs.existsSync(DB)) fs.unlinkSync(DB); });

describe('startWatcher', () => {
  it('registers add, change, and unlink handlers', () => {
    const db = openDb(DB); runMigrations(db);
    startWatcher('/vault', db, {});
    const events = mockOn.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain('add');
    expect(events).toContain('change');
    expect(events).toContain('unlink');
    db.close();
  });

  it('watches the vault directory', () => {
    const db = openDb(DB); runMigrations(db);
    startWatcher('/vault', db, {});
    expect(chokidar.watch).toHaveBeenCalledWith(
      '/vault',
      expect.objectContaining({ persistent: true, ignoreInitial: true })
    );
    db.close();
  });

  it('unlink handler deletes note and relations', () => {
    const db = openDb(DB); runMigrations(db);
    // Seed a note
    db.prepare("INSERT INTO notes VALUES ('/vault/test.md','Test',null,'h','2026-03-30','{}')").run();
    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('note', 'Test', '[]', '/vault/test.md', 1.0, '2026-03-30');

    startWatcher('/vault', db, {});

    // Find the unlink handler and call it
    const unlinkCall = mockOn.mock.calls.find((c: any[]) => c[0] === 'unlink');
    expect(unlinkCall).toBeTruthy();
    const unlinkHandler = unlinkCall![1];
    unlinkHandler('/vault/test.md');

    // Verify note was deleted (cascade deletes entities)
    const note = db.prepare('SELECT * FROM notes WHERE path = ?').get('/vault/test.md');
    expect(note).toBeUndefined();
    db.close();
  });

  it('reports a failed index as one structured line that never names the vault folder', async () => {
    vi.useFakeTimers();
    try {
      const vault = '/var/lib/renor/acme';
      const db = openDb(DB); runMigrations(db);
      vi.mocked(indexFile).mockRejectedValueOnce(errorNaming(vault));
      startWatcher(vault, db, {});
      const calls = captureConsole();
      const add = mockOn.mock.calls.find((c: any[]) => c[0] === 'add')![1];
      add(`${vault}/notes/private.md`);
      await vi.advanceTimersByTimeAsync(600);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('error');
      expect(calls[0].args).toHaveLength(1); // the line alone: no Error object as a second argument
      const line = String(calls[0].args[0]);
      expect(line).not.toContain(vault);
      expect(JSON.parse(line)).toMatchObject({ level: 'error', svc: 'engine', event: 'watcher_index_failed', file: 'notes/private.md' });
      db.close();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
