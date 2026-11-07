import Database from './sqlite';
import fs from 'fs';
import path from 'path';
import { runMigrations } from './migrations';
import { salvageIndexTables, restoreIndexTables, describeSalvage, unreadableSalvage, type IndexSalvage } from './indexSalvage';
import { createLogger } from '../mvp/log';

const log = createLogger('engine');

/**
 * Map up to this much of the database file into memory for reads (`PRAGMA mmap_size`). SQLite maps only
 * what exists, so a small database is untouched; the ceiling is address space, not memory.
 *
 * Why: a sqlite-vec nearest-neighbour query reads every vector chunk, each a multi-megabyte BLOB, and
 * SQLite reads a BLOB's overflow pages straight from the file, one pread() per 4 KB page, bypassing its
 * page cache (so a bigger cache_size does not help). On a 10,000-note workspace that was ~60% kernel time
 * per query. Reading through the mapping turns those syscalls into copies and cut the scan's CPU by about
 * a third (scripts/bench/mcp-latency.ts). Only reads change: writes still go through write(), and answers
 * are identical.
 *
 * The one thing a mapped read cannot survive is the file shrinking under it. The engine never VACUUMs or
 * truncates its database, and the data-deletion runbook stops the service before touching the files.
 * Not applied to `openReadOnlyDb`, which inspects or imports from files this process does not own.
 */
const MMAP_SIZE_BYTES = 1024 * 1024 * 1024;

export function openDb(dbPath: string): Database.Database {
  const onDisk = dbPath !== ':memory:' && dbPath !== '';
  if (onDisk) {
    // The index holds every remembered statement in plain text. A new one is created owner-only whatever the
    // umask; SQLite gives its -wal and -shm files the main file's mode. An existing file keeps its mode.
    // Windows has no POSIX mode bits: there both modes are ignored and the file is created writable.
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(dbPath, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600));
  }
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma(`mmap_size = ${MMAP_SIZE_BYTES}`);
  } catch (err) {
    // A file that is not a database fails on its first pragma; do not leave its handle open for the caller that never gets it.
    db.close();
    throw err;
  }
  return db;
}

/**
 * Opens the derived index, and rebuilds it when it is damaged. The index is rebuilt from the ledger and the Markdown
 * (the CLI banner says so), so a damaged `index.db` is not a reason to refuse to start: it is moved aside, with its
 * `-wal` and `-shm`, to `index.db.corrupt-<timestamp>` (kept for forensics) and the caller gets a fresh index, exactly
 * as for a missing one. Only corruption is moved aside: an open that fails for another reason (permissions, I/O) throws.
 * The move needs the ledger to rebuild from, so with no ledger a damaged index throws rather than being set aside.
 * The ledger itself is never touched here.
 */
export function openIndexDb(dbPath: string, ledgerPath: string): Database.Database {
  let damage: string;
  try {
    const db = openDb(dbPath);
    let verdict: unknown;
    try {
      verdict = db.pragma('quick_check', { simple: true });
    } catch (err) {
      db.close();
      throw err;
    }
    if (verdict === 'ok') return db;
    db.close();
    damage = String(verdict);
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    damage = (err as Error).message;
  }
  if (!fs.existsSync(ledgerPath)) {
    throw new Error(`index ${dbPath} is damaged (${damage}) and there is no ledger to rebuild it from; it was not moved aside. Restore the ledger, or move the index aside by hand.`);
  }
  // Read what the damaged file still gives before it is moved: the pending requests and cursors are not in the ledger.
  const salvage = readDamagedIndex(dbPath);
  const aside = setIndexAside(dbPath);
  const db = openDb(dbPath);
  runMigrations(db);
  const { restored, rejected } = restoreIndexTables(db, salvage);
  log.error('index_rebuilt_from_ledger', { index: path.basename(dbPath), damage, movedTo: path.basename(aside), salvage: describeSalvage(salvage, restored, rejected) });
  return db;
}

/** The rows the ledger does not hold, read from the damaged file, read-only (openReadOnlyDb: the file is not written). */
function readDamagedIndex(dbPath: string): IndexSalvage {
  let db: Database.Database;
  try {
    db = openReadOnlyDb(dbPath);
  } catch (err) {
    return unreadableSalvage(err instanceof Error ? err.message : String(err));
  }
  try {
    return salvageIndexTables(db);
  } finally {
    db.close();
  }
}

/** A SQLite error that says the file is damaged, as opposed to unreadable for some other reason. */
function isCorruptionError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT' || code.startsWith('SQLITE_CORRUPT_'));
}

/**
 * Renames the index's side files first and the main file last: if this is interrupted, the damaged main file is still
 * there to be found again on the next start, and no WAL is ever left beside a fresh database it does not belong to.
 */
function setIndexAside(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let aside = `${dbPath}.corrupt-${stamp}`;
  for (let n = 2; ['', '-wal', '-shm'].some(side => fs.existsSync(aside + side)); n++) aside = `${dbPath}.corrupt-${stamp}-${n}`;
  for (const side of ['-wal', '-shm', '']) {
    if (fs.existsSync(dbPath + side)) fs.renameSync(dbPath + side, aside + side);
  }
  return aside;
}

/**
 * Read-only open of a SQLite database by path — a product index being inspected, or a
 * source index an import reads from.
 *
 * Read-only is enforced by SQLite itself rather than by convention, so a read can never
 * write to the store it is reading. That matters for the WAL side files too: a
 * write-capable open of a WAL database can create `-wal`/`-shm` and checkpoint back into
 * the main file. `journal_mode` is deliberately NOT set here, because setting it is a
 * write. Product code must reach product SQLite through this module
 * (`tests/eval/product-path-contract.test.ts` guards the `openDb` boundary).
 */
export function openReadOnlyDb(dbPath: string): Database.Database {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`database not found: ${dbPath}`);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  return db;
}
