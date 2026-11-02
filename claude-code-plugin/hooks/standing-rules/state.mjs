// Per-session state of the SessionStart hook (the frozen session index and the ids it listed), kept for the session's
// later starts and read by automatic recall in another process. It lives in one per-user private directory. Another
// local user can never plant a file there: the directory must be a real directory owned by this user with no group or
// other bits, a file is opened without following links and must be a regular 0600 file owned by this user, and every
// write goes through a new exclusive temporary file. Anything that fails these checks is treated as absent, and the
// caller fails closed (no frozen output is trusted, and no index is asked for without a private directory to keep it in).
//
// src/recall/autoRecall.ts reads these files and must resolve the same directory (pinnedStateDir and its reader).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Files older than this are removed at the next start (a session's frozen output is kept at most this long). */
export const MAX_AGE_MS = 7 * 86400000;
/** The most files kept in the directory; the oldest go first. */
export const MAX_ENTRIES = 512;
/** The most bytes kept in the directory, in total; the oldest go first. */
export const MAX_BYTES = 8 * 1024 * 1024;

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

const euid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** True when `dir` is a real directory owned by this user with mode exactly 0700 (not a link, not shared). */
function ownPrivateRuntimeDir(dir) {
  try {
    if (euid() < 0) return false;
    const st = fs.lstatSync(dir);
    return st.isDirectory() && st.uid === euid() && (st.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

/**
 * The directory for the hook's per-session state: $XDG_RUNTIME_DIR/renor/pinned-rules when XDG_RUNTIME_DIR is an
 * absolute path to this user's own 0700 directory (a per-user tmpfs on Linux), else ~/.renor/cache/pinned-rules.
 */
export function pinnedStateDir(env = process.env) {
  const runtime = String(env.XDG_RUNTIME_DIR ?? '').trim();
  if (path.isAbsolute(runtime) && ownPrivateRuntimeDir(runtime)) return path.join(runtime, 'renor', 'pinned-rules');
  return path.join(os.homedir(), '.renor', 'cache', 'pinned-rules');
}

/** True when `dir` is (or can be made) a real directory owned by this user with no group or other bits. */
export function ensurePrivateDir(dir) {
  try {
    if (euid() < 0) return false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    return st.isDirectory() && st.uid === euid() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** The text of a private regular file (owner-only, this user's), or null when it is missing or not private. */
export function readPrivateFile(file) {
  let fd;
  try {
    if (euid() < 0) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== euid() || (st.mode & 0o777) !== 0o600) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Writes `text` as the private file `file` in `dir`: a new exclusive temporary file, renamed into place. */
export function writePrivateFile(dir, file, text) {
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Removes what the cap does not keep: files older than MAX_AGE_MS, then the oldest until the directory holds at most
 * MAX_ENTRIES files and MAX_BYTES bytes. `keep` names files that are never removed (the session starting now).
 */
export function prunePrivateDir(dir, keep = new Set(), now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  // Kept files count against the caps but are never removed; everything else is a candidate, oldest first.
  let count = 0;
  let bytes = 0;
  const candidates = [];
  for (const name of entries) {
    const file = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    if (keep.has(name)) {
      count += 1;
      bytes += st.size;
    } else if (now - st.mtimeMs > MAX_AGE_MS) {
      fs.rmSync(file, { force: true });
    } else {
      candidates.push({ file, mtime: st.mtimeMs, size: st.size });
      count += 1;
      bytes += st.size;
    }
  }
  candidates.sort((a, b) => a.mtime - b.mtime);
  for (const f of candidates) {
    if (count <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    fs.rmSync(f.file, { force: true });
    count -= 1;
    bytes -= f.size;
  }
}
