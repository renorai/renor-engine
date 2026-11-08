import fs from 'fs/promises';
import { constants as C } from 'fs';
import path from 'path';
import { markUnrecoverable, syncDirectory, unrecoverableReason, withAppendLock } from './durableAppend';
import { nameIsOpenFile, nameKind } from './sameFile';

/**
 * Writes into the vault that cannot be turned into a write somewhere else.
 *
 * The read side (memorymap's resolveVaultFile / ensureRealDir / openConfined) already refuses a symbolic link at any
 * level. These helpers give the write side the same rule, for a vault someone else put files in (a cloned or shared
 * notes repository, a synced folder, an archive): every directory between the vault's real root and the file is a real
 * directory (a link is refused, never followed), the file itself is opened with O_NOFOLLOW and O_NONBLOCK (so a link is
 * an error and a FIFO with no reader is an error, not a hang), and what was opened must be a regular file with one name
 * (a hard link would write through to the file it shares). The vault root itself may be a link: it is where the user put
 * their vault.
 *
 * The walk and the open are two steps, so a process that can write inside the vault could swap a directory for a link
 * between them. After the open and before the first byte, `assertHandleInside` asks the kernel where the open file really
 * is (/proc/self/fd/<fd>) and refuses unless that is under the vault's real root. Node has no openat2(RESOLVE_BENEATH) and
 * /proc exists on Linux only; elsewhere that race stays open (engine/docs/self-hosting.md says so).
 *
 * Windows has no O_NOFOLLOW (Node leaves the constant undefined, so the flag drops out of the open) and a final-name link is
 * followed there. Every open is therefore also checked by name (`assertNameIsOpenFile`, sameFile.ts): the name, not followed,
 * must be the very file that was opened, before a byte is written and before anything is removed by that name (#1563).
 *
 * Files are created 0600 and directories 0700: the vault holds the owner's statements in plain text.
 *
 * Durable as well (adv-crashsafe-1012 F1-F3): `appendConfined` is the one append for the daily log and the ledger. A write
 * that fails part-way is cut back to the length the file had before the call, or removed when the call created it, so a
 * caller told the save failed leaves no fragment; a successful write is fsynced before it returns, and so is the directory
 * entry of a file it created. The cut and the append share one per-file lock (durableAppend.ts).
 */

function refusal(relFile: string, why: string): Error {
  return new Error(`refusing to write ${JSON.stringify(relFile)}: ${why}`);
}

/** The vault-relative parts of `relFile`, refusing a path that is empty or leaves the vault. */
function partsOf(relFile: string): { dirs: string[]; name: string } {
  const parts = relFile.split(/[\\/]/).filter(p => p && p !== '.');
  const name = parts.pop();
  if (!name || parts.includes('..') || name === '..' || path.isAbsolute(relFile)) {
    throw refusal(relFile, 'it is not a path inside the vault');
  }
  return { dirs: parts, name };
}

/** The vault's real root; a vault that does not exist yet is created (the writers always did). */
async function realRoot(vaultRoot: string): Promise<string> {
  try {
    return await fs.realpath(vaultRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await fs.mkdir(vaultRoot, { recursive: true });
    return fs.realpath(vaultRoot);
  }
}

/**
 * Walk the directories below the root, one lstat at a time. `create` makes a missing one (as `mkdir -p` did); without it a
 * missing directory ends the walk with `null`.
 */
async function walkDirs(root: string, relFile: string, dirs: string[], create: boolean): Promise<string | null> {
  let dir = root;
  for (const part of dirs) {
    dir = path.join(dir, part);
    let st;
    try {
      st = await fs.lstat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (!create) return null;
      try { await fs.mkdir(dir, { mode: 0o700 }); } catch (e2) { if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2; }
      st = await fs.lstat(dir);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw refusal(relFile, `${JSON.stringify(dirs.join('/'))} is a symbolic link or not a plain directory inside the vault`);
    }
  }
  return dir;
}

/**
 * Refuse an open file that is not under the vault's real root, whatever path was used to reach it. A directory swapped for
 * a link after the walk makes the open land elsewhere; the kernel's own answer for the descriptor says where. Without
 * /proc (not Linux) there is nothing to ask and the check passes: the residual is documented. A file this call just
 * created outside is left where it landed, empty: a later step never removes it by name, because the name may by then
 * resolve to some other file.
 */
export async function assertHandleInside(handle: fs.FileHandle, realVaultRoot: string, relFile: string): Promise<void> {
  let where: string;
  try {
    where = await fs.readlink(`/proc/self/fd/${handle.fd}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw err;
  }
  const rel = path.relative(realVaultRoot, where);
  // '..safe' is a plain name below the root; only a '..' component leaves it.
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw refusal(relFile, 'the file opened is outside the vault (a directory was replaced by a link while it was written)');
  }
}

/** Refuse an open that went through a link at the final name: the name, not followed, must be the file that was opened. */
async function assertNameIsOpenFile(handle: fs.FileHandle, file: string, relFile: string): Promise<void> {
  if (!(await nameIsOpenFile(handle, file))) throw refusal(relFile, 'it is a symbolic link or not a regular file');
}

async function checkHandle(handle: fs.FileHandle, root: string, relFile: string, file: string): Promise<void> {
  await assertHandleInside(handle, root, relFile);
  await assertNameIsOpenFile(handle, file, relFile);
  const st = await handle.stat();
  if (!st.isFile() || st.nlink !== 1) throw refusal(relFile, 'it is not a regular file with a single name');
}

/**
 * Append to a vault file, creating it (and its directories) when absent. `header` goes in first, and only when this call
 * created the file. Resolves once the bytes are on disk; rejects with the original error after undoing whatever landed.
 * Returns the file's path.
 */
export async function appendConfined(vaultRoot: string, relFile: string, content: string, header = ''): Promise<string> {
  const { dirs, name } = partsOf(relFile);
  const root = await realRoot(vaultRoot);
  const dir = (await walkDirs(root, relFile, dirs, true))!;
  const file = path.join(dir, name);
  const key = path.resolve(vaultRoot, relFile);
  return withAppendLock(key, async () => {
    const refused = unrecoverableReason(key);
    if (refused) throw refusal(relFile, `it holds the bytes of a failed write that could not be cut back (${refused}); refusing further appends until the engine restarts, which sets that tail aside`);
    const OPEN = C.O_WRONLY | C.O_APPEND | C.O_NOFOLLOW | C.O_NONBLOCK;
    if ((await nameKind(file)) === 'other') throw refusal(relFile, 'it is a symbolic link or not a regular file');
    let handle: fs.FileHandle;
    let created = false;
    try {
      // O_EXCL does not follow a link at the final component: a link there, dangling or not, is EEXIST.
      handle = await fs.open(file, OPEN | C.O_CREAT | C.O_EXCL, 0o600);
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        handle = await fs.open(file, OPEN);
      } catch (e2) {
        const code = (e2 as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENXIO') throw refusal(relFile, 'it is a symbolic link or not a regular file');
        throw e2;
      }
    }
    let before: number | null = null;
    let inside = false;
    let failure: { error: unknown } | null = null;
    try {
      await assertHandleInside(handle, root, relFile);
      // Before `inside`: an open that followed a link (Windows, no O_NOFOLLOW) must not lead to removing that name below.
      await assertNameIsOpenFile(handle, file, relFile);
      inside = true;
      await checkHandle(handle, root, relFile, file);
      before = (await handle.stat()).size;
      await handle.appendFile(created ? header + content : content, 'utf8');
      await handle.sync();
      if (created) await syncDirectory(dir);
    } catch (error) {
      failure = { error };
      // Cut the partial bytes back. Only a known length is ever truncated to: a failed stat must not be read as zero.
      if (!created && before !== null) {
        const length = before;
        await handle.truncate(length).then(() => handle.sync())
          .catch(() => cutThroughSecondHandle(handle, file, length))
          .catch((cutError: unknown) => {
            markUnrecoverable(key, cutError instanceof Error ? cutError.message : String(cutError));
          });
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (failure) {
      // Removed by name only when the open landed inside the vault (adv-crashsafe-1012 review P3-3): when it did not, the
      // name may now resolve to some other file, so the empty file this call made stays where it landed.
      if (created && inside) await fs.rm(file, { force: true }).catch(() => undefined);
      throw failure.error;
    }
    return file;
  });
}

/**
 * Cut `file` back to `length` through a second handle opened without O_APPEND. On Windows an append handle carries only the
 * right to append (libuv opens O_APPEND as FILE_APPEND_DATA), so ftruncate on it fails with EPERM and a failed save could
 * never be cut back (#1563). The second open is confined like the first: no link at the name, and it must be the very file
 * the append handle has open, so nothing else is ever cut. The caller holds the file's append lock.
 */
async function cutThroughSecondHandle(appendHandle: fs.FileHandle, file: string, length: number): Promise<void> {
  const cut = await fs.open(file, C.O_WRONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const [was, now] = await Promise.all([appendHandle.stat({ bigint: true }), cut.stat({ bigint: true })]);
    if (was.dev !== now.dev || was.ino !== now.ino || !(await nameIsOpenFile(cut, file))) {
      throw new Error('the file changed before a failed write could be cut back');
    }
    await cut.truncate(length);
    await cut.sync();
  } finally {
    await cut.close().catch(() => undefined);
  }
}

/**
 * Create a new vault file, durably: `content` is synced and so is the directory entry. It never replaces anything: a name
 * that is taken (a file, or a link at it, dangling or not) fails with EEXIST, and the caller picks another name.
 * Confined like every other write here. Returns the file's path.
 */
export async function createConfined(vaultRoot: string, relFile: string, content: string | Buffer): Promise<string> {
  const { dirs, name } = partsOf(relFile);
  const root = await realRoot(vaultRoot);
  const dir = (await walkDirs(root, relFile, dirs, true))!;
  const file = path.join(dir, name);
  // Windows follows a dangling link even under O_EXCL: a taken name, link or not, is EEXIST before any open.
  if ((await nameKind(file)) !== 'absent') throw Object.assign(new Error(`EEXIST: file already exists, open '${file}'`), { code: 'EEXIST' });
  const handle = await fs.open(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
  let inside = false;
  let failure: { error: unknown } | null = null;
  try {
    await assertHandleInside(handle, root, relFile);
    await assertNameIsOpenFile(handle, file, relFile);
    inside = true;
    await checkHandle(handle, root, relFile, file);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await syncDirectory(dir);
  } catch (error) {
    failure = { error };
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (failure) {
    if (inside) await fs.rm(file, { force: true }).catch(() => undefined);
    throw failure.error;
  }
  return file;
}

/**
 * Runs `fn` with an open handle on an existing vault file, opened the way a confined write opens it: the directories on
 * the way are real, the file is opened with O_NOFOLLOW and O_NONBLOCK, and what was opened must be a regular file with one
 * name inside the vault. The handle is read and written by `fn`, and closed after it.
 */
export async function withConfinedFile<T>(vaultRoot: string, relFile: string, fn: (handle: fs.FileHandle) => Promise<T>): Promise<T> {
  const { dirs, name } = partsOf(relFile);
  const root = await realRoot(vaultRoot);
  const dir = await walkDirs(root, relFile, dirs, false);
  if (dir === null) throw Object.assign(new Error(`ENOENT: no such file or directory, ${relFile}`), { code: 'ENOENT' });
  const file = path.join(dir, name);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENXIO') throw refusal(relFile, 'it is a symbolic link or not a regular file');
    throw err;
  }
  try {
    await checkHandle(handle, root, relFile, file);
    return await fn(handle);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Create a vault file, or replace the content of the regular file already there. Returns the file's path. */
export async function writeConfined(vaultRoot: string, relFile: string, content: string): Promise<string> {
  const { dirs, name } = partsOf(relFile);
  const root = await realRoot(vaultRoot);
  const dir = (await walkDirs(root, relFile, dirs, true))!;
  const file = path.join(dir, name);
  if ((await nameKind(file)) === 'other') throw refusal(relFile, 'it is a symbolic link or not a regular file');
  let handle: fs.FileHandle;
  try {
    // No O_TRUNC: the file is only emptied once it is known to be a regular file with a single name.
    handle = await fs.open(file, C.O_WRONLY | C.O_CREAT | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENXIO') throw refusal(relFile, 'it is a symbolic link or not a regular file');
    throw err;
  }
  try {
    await checkHandle(handle, root, relFile, file);
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
  return file;
}

/**
 * Refuse, before anything is read or written, a vault file that a confined write would refuse: a link or a directory on
 * the way, or an existing file that is not a regular file with one name. An absent file or directory is fine.
 */
export async function assertConfinedTarget(vaultRoot: string, relFile: string): Promise<void> {
  const { dirs, name } = partsOf(relFile);
  let root: string;
  try {
    root = await fs.realpath(vaultRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const dir = await walkDirs(root, relFile, dirs, false);
  if (dir === null) return;
  let st;
  try {
    st = await fs.lstat(path.join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!st.isFile() || st.nlink !== 1) throw refusal(relFile, 'it is a symbolic link or not a regular file with a single name');
}
