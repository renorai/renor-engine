import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

/**
 * What the canonical Markdown and ledger appends and the start-up replay share (adv-crashsafe-1012, F1-F3). The append
 * itself is `appendConfined` (confinedWrite.ts): one function that keeps a write inside the vault AND makes it durable, so
 * a failed write leaves no bytes behind and an acknowledged write survives a power cut.
 *
 * Appends to one file run one at a time (withAppendLock), so the length a failed write is cut back to is still the length
 * its own bytes started at: no other append can land in between and be removed with it. A cut-back that itself fails
 * leaves the file refused for the rest of this process (markUnrecoverable), so no later append can make the fragment look
 * whole; a restart sets that tail aside (replay).
 */

/**
 * Windows cannot fsync a directory (#1563): opening one gives a handle, and FlushFileBuffers on it fails, which Node reports
 * as EPERM (EISDIR or EINVAL on some versions and file systems). NTFS journals its metadata, so a create or rename there is
 * already durable without that flush, and there is nothing else to call. So on win32, and only for a directory, those codes
 * mean "not supported here" and the write goes on. Everywhere else (POSIX: Linux, macOS) a failed directory fsync is still
 * an error: there it is what makes a created or renamed name survive a power cut, and the guarantee is unchanged. A file's
 * own fsync is never tolerated, on any platform.
 */
export function isUnsupportedDirectorySync(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EISDIR' || code === 'EINVAL';
}

/** Flush a directory so that a file created or renamed in it is still there after a power cut. */
export async function syncDirectory(dir: string): Promise<void> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(dir, 'r');
  } catch (err) {
    if (isUnsupportedDirectorySync(err)) return;
    throw err;
  }
  try {
    await handle.sync();
  } catch (err) {
    if (!isUnsupportedDirectorySync(err)) throw err;
  } finally {
    await handle.close();
  }
}

/** `syncDirectory` for synchronous writers, with the same platform rule. */
export function syncDirectorySync(dir: string): void {
  let fd: number;
  try {
    fd = fsSync.openSync(dir, 'r');
  } catch (err) {
    if (isUnsupportedDirectorySync(err)) return;
    throw err;
  }
  try {
    fsSync.fsyncSync(fd);
  } catch (err) {
    if (!isUnsupportedDirectorySync(err)) throw err;
  } finally {
    fsSync.closeSync(fd);
  }
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after every earlier call for the same file has finished, and before any later one starts. In-process only:
 * two engine processes on one workspace are not serialized by it (not covered by adv-crashsafe-1012 F6 either).
 */
export function withAppendLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

/** Files whose last failed write could not be cut back: refused until the process restarts (replay then sets it aside). */
const unrecoverable = new Map<string, string>();

/** Record that `file` holds the bytes of a failed write that could not be cut back. */
export function markUnrecoverable(file: string, reason: string): void {
  unrecoverable.set(path.resolve(file), reason);
}

/** Why `file` is refused for appends in this process, or `undefined` when it is not. */
export function unrecoverableReason(file: string): string | undefined {
  return unrecoverable.get(path.resolve(file));
}
