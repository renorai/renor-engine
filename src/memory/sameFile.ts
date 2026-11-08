import fs from 'fs';
import type { FileHandle } from 'fs/promises';

/**
 * Whether the name `file` is, right now and without following a link, the regular file `handle` (or `fd`) has open.
 *
 * WHY: the confined writers and readers open with O_NOFOLLOW so that a symbolic link at the final name is an error, never a
 * door out of the vault. Node has no O_NOFOLLOW on Windows (`fs.constants.O_NOFOLLOW` is undefined there and the flag
 * silently drops out of the open), so there the open follows a planted file link and lands outside (#1563). Comparing the
 * opened file with an lstat of its name catches that on every platform: a link's lstat describes the link, which is not the
 * file that was opened. Where O_NOFOLLOW exists this repeats what the open already refused, at the cost of one lstat.
 * Inode numbers are compared as bigints: NTFS file ids do not fit in a double.
 */
export async function nameIsOpenFile(handle: FileHandle, file: string): Promise<boolean> {
  const [opened, there] = await Promise.all([
    handle.stat({ bigint: true }),
    fs.promises.lstat(file, { bigint: true }).catch(() => null),
  ]);
  return there !== null && there.isFile() && opened.isFile() && opened.dev === there.dev && opened.ino === there.ino;
}

/** `nameIsOpenFile` for a synchronous descriptor. */
export function nameIsOpenFileSync(fd: number, file: string): boolean {
  const opened = fs.fstatSync(fd, { bigint: true });
  const there = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return there !== undefined && there.isFile() && opened.isFile() && opened.dev === there.dev && opened.ino === there.ino;
}

/** What is at `file` before an open that may create it: nothing, a regular file, or anything else (a link, a directory...). */
export type NameKind = 'absent' | 'file' | 'other';

/**
 * Looked at before an open that may create: on Windows an O_CREAT (even with O_EXCL) follows a dangling link at the name
 * and creates its target, outside the vault, before any check of the handle can run. A link found here is refused without
 * opening. A link planted between this lstat and the open is the same race the directory walk already documents.
 */
export async function nameKind(file: string): Promise<NameKind> {
  try {
    return (await fs.promises.lstat(file)).isFile() ? 'file' : 'other';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
}

/** `nameKind`, synchronously. */
export function nameKindSync(file: string): NameKind {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (st === undefined) return 'absent';
  return st.isFile() ? 'file' : 'other';
}
