import fs from 'fs';
import path from 'path';

/**
 * Test teardown for a SQLite file: removes it with its -wal and -shm side files. The test must have closed every handle
 * on it first. POSIX lets an open file be unlinked, so a leaked handle went unnoticed there; Windows refuses (EBUSY, #1563).
 * So a handle still open is reported as the test's bug, naming the file, on every platform: on Windows by the EBUSY, on
 * Linux by asking the kernel which files this process holds open (/proc/self/fd) before anything is removed.
 */
export function removeDb(dbPath: string): void {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const open = openFilesOf(files);
  if (open.length > 0) throw new Error(`${open.join(', ')} is still open: close the database before removing it`);
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM') {
        throw new Error(`${file} is still open (${code}): close the database before removing it`, { cause: err });
      }
      throw err;
    }
  }
}

/**
 * Removes a test's temporary directory after checking that no file under it is still open by this process (Linux; elsewhere
 * the removal itself reports it, as EBUSY on Windows). Use it where a suite keeps its databases inside a temporary directory.
 */
export function removeTestDir(dir: string): void {
  const open = openFilesUnder(dir);
  if (open.length > 0) throw new Error(`${open.join(', ')} is still open: close the database before removing ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The files this process holds open, as the kernel names them, or [] where there is no /proc (macOS, Windows). */
function openPaths(): string[] {
  let fds: string[];
  try {
    fds = fs.readdirSync('/proc/self/fd');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const fd of fds) {
    try { out.push(fs.readlinkSync(`/proc/self/fd/${fd}`)); } catch { /* closed while listing */ }
  }
  return out;
}

function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function openFilesOf(files: string[]): string[] {
  const wanted = new Set(files.map(real));
  return [...new Set(openPaths().filter(p => wanted.has(p)))];
}

function openFilesUnder(dir: string): string[] {
  const root = real(dir) + path.sep;
  return [...new Set(openPaths().filter(p => p.startsWith(root)))];
}
