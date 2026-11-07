import Database from '../db/sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { scanSecrets } from '../extraction/secretScanner';
import { MAX_EXAMPLE_TEXT, type SharingLevel } from './fields';
import { EXAMPLES_FILE, effectiveLevel } from './state';

/**
 * The text of examples, kept only while the user has chosen `data`.
 *
 * The learning log holds keyed hashes and numbers, never text. An example for training needs the text, so at `data` the tap
 * hands this store the query and the text of each memory it served or saved, under the same keyed hashes the log uses
 * (query_key, memory_key). The projector joins them at send time. At any level below `data` this file does not exist: leaving
 * `data` deletes it at once, and so does `delete`.
 *
 * A text the secret scanner flags is not kept (the example is sent without text). A text is cut at MAX_EXAMPLE_TEXT characters.
 */

export interface ExampleReader {
  query(queryKey: string): string | null;
  memory(memoryKey: string): string | null;
}

export class ExampleStore implements ExampleReader {
  private constructor(private readonly db: Database.Database) {}

  static open(dir: string, create: boolean): ExampleStore | null {
    const file = path.join(dir, EXAMPLES_FILE);
    if (!create && !fs.existsSync(file)) return null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600));
    const db = new Database(file);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('secure_delete = ON');
      db.pragma('busy_timeout = 5000');
      db.exec(`
        CREATE TABLE IF NOT EXISTS queries (query_key TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS memories (memory_key TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
      `);
    } catch (err) {
      db.close();
      throw err;
    }
    return new ExampleStore(db);
  }

  putQuery(queryKey: string, text: string, at: number): void {
    const kept = keepable(text);
    if (kept === null) return;
    this.db.prepare('INSERT INTO queries (query_key, text, at) VALUES (?, ?, ?) ON CONFLICT (query_key) DO UPDATE SET text = excluded.text, at = excluded.at')
      .run(queryKey, kept, at);
  }

  putMemory(memoryKey: string, text: string, at: number): void {
    const kept = keepable(text);
    if (kept === null) return;
    this.db.prepare('INSERT INTO memories (memory_key, text, at) VALUES (?, ?, ?) ON CONFLICT (memory_key) DO UPDATE SET text = excluded.text, at = excluded.at')
      .run(memoryKey, kept, at);
  }

  query(queryKey: string): string | null {
    const row = this.db.prepare('SELECT text FROM queries WHERE query_key = ?').get(queryKey) as { text: string } | undefined;
    return row?.text ?? null;
  }

  memory(memoryKey: string): string | null {
    const row = this.db.prepare('SELECT text FROM memories WHERE memory_key = ?').get(memoryKey) as { text: string } | undefined;
    return row?.text ?? null;
  }

  count(): { queries: number; memories: number } {
    const n = (table: string): number => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { queries: n('queries'), memories: n('memories') };
  }

  /** Deletes the texts last put at or before `cutoff` (ms): after a full send, no unsent row uses them. */
  forgetUpTo(cutoff: number): void {
    this.db.prepare('DELETE FROM queries WHERE at <= ?').run(cutoff);
    this.db.prepare('DELETE FROM memories WHERE at <= ?').run(cutoff);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

/** A text worth keeping: not empty, not flagged by the secret scanner; cut at the limit. */
function keepable(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const cut = trimmed.length > MAX_EXAMPLE_TEXT ? trimmed.slice(0, MAX_EXAMPLE_TEXT) : trimmed;
  // The scan covers the whole text, not just the part kept: a secret past the cut still marks the text as one to leave out.
  return scanSecrets(trimmed) === null ? cut : null;
}

/**
 * What the learning tap calls. `level()` is asked at each call, so a choice takes effect on the next call. `query` and `memory`
 * do nothing below `data`, and nothing is opened until the first text arrives.
 */
export interface SharingHook {
  level(): SharingLevel;
  query(queryKey: string, text: string): void;
  memory(memoryKey: string, text: string): void;
}

const open = new Map<string, ExampleStore>();

export function closeExampleStores(): void {
  for (const store of open.values()) store.close();
  open.clear();
}

/**
 * Closes the handle this process holds on `dir`'s example store, if any, so its files can be removed: Windows refuses to
 * remove a file SQLite still holds open (EBUSY, #1563), and on POSIX a held handle would keep writing to a removed file.
 * The next example opens a fresh store.
 */
export function closeExampleStore(dir: string): void {
  const key = path.resolve(dir, EXAMPLES_FILE);
  open.get(key)?.close();
  open.delete(key);
}

/** The hook for one sharing folder. `now` is for tests. */
export function sharingHook(dir: string, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): SharingHook {
  const store = (): ExampleStore => {
    const key = path.resolve(dir, EXAMPLES_FILE);
    let held = open.get(key);
    // The file may have been removed by `off`/`delete` from another process: open a fresh handle if so.
    if (held && !fs.existsSync(key)) {
      held.close();
      open.delete(key);
      held = undefined;
    }
    if (!held) {
      const made = ExampleStore.open(dir, true);
      if (made === null) throw new Error('the example store could not be created');
      open.set(key, made);
      held = made;
    }
    return held;
  };
  const dataOn = (): boolean => effectiveLevel(dir, env) === 'data';
  return {
    level: () => effectiveLevel(dir, env),
    query(queryKey, text) {
      try {
        if (dataOn()) store().putQuery(queryKey, text, now());
      } catch {
        // Keeping an example must never fail the call it describes.
      }
    },
    memory(memoryKey, text) {
      try {
        if (dataOn()) store().putMemory(memoryKey, text, now());
      } catch {
        // As above.
      }
    },
  };
}
