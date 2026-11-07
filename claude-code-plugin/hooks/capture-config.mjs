import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const on = value => value === true || ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** True when this user owns the entry (always true where the platform has no uids). */
export const ownedByMe = st => typeof process.getuid !== 'function' || st.uid === process.getuid();

/** The owner's home directory with every symlink resolved, once; null when it is not an existing directory. */
export function realHome(env = process.env) {
  try {
    return fs.realpathSync(env.HOME || os.homedir());
  } catch {
    return null;
  }
}

/**
 * The text of a file the owner wrote: never a symlink, a regular file owned by this user, and (with `privateOnly`) no
 * group or other access. The lstat is taken before the open and the open refuses a final symlink (O_NOFOLLOW), and the
 * opened descriptor must still be the file that was checked. Anything else reads as null.
 */
export function readOwnedFile(file, { privateOnly = false } = {}) {
  let before;
  try {
    before = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!before.isFile() || !ownedByMe(before) || (privateOnly && (before.mode & 0o077) !== 0)) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The key lives at exactly ~/.renor/key. A keyFile naming anything else (absolute, traversing, or another path) is refused. */
const KEY_NAMES = new Set(['~/.renor/key', '.renor/key']);

/** Fill hook settings from the owner's private capture file. Explicit environment values always win. */
export function captureEnvironment(base = process.env) {
  const env = { ...base };
  const home = realHome(base);
  const renor = home ? path.join(home, '.renor') : null;
  // ~/.renor itself must be a real directory: a symlink there would move the config and the key elsewhere.
  let renorIsDir = false;
  try {
    renorIsDir = renor !== null && fs.lstatSync(renor).isDirectory() && ownedByMe(fs.lstatSync(renor));
  } catch {
    renorIsDir = false;
  }
  let config = {};
  if (renorIsDir) {
    try {
      const parsed = JSON.parse(readOwnedFile(path.join(renor, 'capture.json'), { privateOnly: true }) ?? 'null');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    } catch { /* invalid JSON means the safe, off defaults */ }
  }
  if (env.RENOR_SAVE_HOOK === undefined && on(config.saveHook)) env.RENOR_SAVE_HOOK = '1';
  if (env.RENOR_STANDING_RULES_HOOK === undefined && on(config.rulesHook)) env.RENOR_STANDING_RULES_HOOK = '1';
  if (env.RENOR_AUTO_RECALL === undefined && on(config.autoRecall)) env.RENOR_AUTO_RECALL = '1';
  if (env.RENOR_CAPTURE_MODE === undefined && ['off', 'user', 'server', 'alternate', 'trial'].includes(config.mode)) env.RENOR_CAPTURE_MODE = config.mode;
  if (env.RENOR_CAPTURE_EVERY_TURNS === undefined && Number.isInteger(config.everyTurns) && config.everyTurns > 0) env.RENOR_CAPTURE_EVERY_TURNS = String(config.everyTurns);
  if (env.RENOR_CONNECT_TOKEN === undefined && renorIsDir) {
    const named = config.keyFile === undefined ? '~/.renor/key' : config.keyFile;
    if (typeof named === 'string' && KEY_NAMES.has(named)) {
      const token = readOwnedFile(path.join(renor, 'key'), { privateOnly: true });
      if (token !== null) env.RENOR_CONNECT_TOKEN = token.trim();
    }
  }
  const skip = Array.isArray(config.skipWhenEnv) ? config.skipWhenEnv : [];
  return { env, skip: skip.some(name => typeof name === 'string' && name && base[name] !== undefined) };
}

/** Observation capture is opt-in; unsafe or missing owner config is off. */
export function observeEnabled(env = process.env) {
  const home = realHome(env);
  if (!home) return false;
  const dir = path.join(home, '.renor');
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || !ownedByMe(st)) return false;
    const raw = readOwnedFile(path.join(dir, 'capture.json'), { privateOnly: true });
    return raw !== null && JSON.parse(raw).observe === true;
  } catch { return false; }
}
