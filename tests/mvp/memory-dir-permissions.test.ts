import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureOwnerOnlyFile, ensureOwnerOnlyMemoryDir } from '../../src/mvp/memoryDir';
import { openDb } from '../../src/db/client';
import { appendDailyMemory } from '../../src/memory/writer';
import { remember, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { runMigrations } from '../../src/db/schema';
import { localApp, cleanupLocalApps } from '../helpers/localMvpApp';

/**
 * The memory is the product's most private data, and it was created readable by every user of the machine on a
 * normal umask (adversary run renor-adv-localhost-1012, F2): directories 0755, daily notes, ledger and index.db 0644.
 * The OAuth client store already refuses such a directory; the memory now does the same, and everything the engine
 * creates inside is owner-only whatever the umask.
 */

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupLocalApps();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-perm-'));
  dirs.push(d);
  return d;
};
const mode = (p: string): number => fs.statSync(p).mode & 0o777;
/** Windows has no POSIX mode bits: stat reports 0o666/0o777 whatever was asked, and chmod only toggles read-only. The engine skips its owner-only checks there (no process.getuid). */
const WINDOWS = process.platform === 'win32';

/** Run with a permissive umask, as a default shell has, so a mode that comes out owner-only is the engine's doing. */
async function withUmask<T>(mask: number, run: () => Promise<T> | T): Promise<T> {
  const previous = process.umask(mask);
  try {
    return await run();
  } finally {
    process.umask(previous);
  }
}

describe.skipIf(WINDOWS)('memory directory policy', () => {
  /** A directory as `mkdir -p` leaves it on a normal umask, with notes in it: nested, a symlink and a foreign-looking file. */
  function readableMemory(m: number): string {
    const dir = path.join(tmp(), 'memory');
    fs.mkdirSync(path.join(dir, 'Memory', 'Daily'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Memory', 'Daily', '2026-10-12.md'), 'a statement\n', { mode: 0o644 });
    fs.writeFileSync(path.join(dir, 'ledger.md'), 'events\n', { mode: 0o644 });
    fs.mkdirSync(path.join(dir, '.memory-index'));
    fs.writeFileSync(path.join(dir, '.memory-index', 'index.db'), 'db', { mode: 0o644 });
    fs.symlinkSync('ledger.md', path.join(dir, 'link.md'));
    for (const d of [path.join(dir, 'Memory', 'Daily'), path.join(dir, 'Memory'), path.join(dir, '.memory-index'), dir]) fs.chmodSync(d, m);
    return dir;
  }

  it.each([0o755, 0o750, 0o705, 0o770, 0o777])('tightens an existing directory with mode %o and the files in it, and says so once', (m) => {
    const dir = readableMemory(m);
    const log = vi.fn();
    ensureOwnerOnlyMemoryDir(dir, log);
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, 'Memory'))).toBe(0o700);
    expect(mode(path.join(dir, 'Memory', 'Daily'))).toBe(0o700);
    expect(mode(path.join(dir, '.memory-index'))).toBe(0o700);
    expect(mode(path.join(dir, 'Memory', 'Daily', '2026-10-12.md'))).toBe(0o600);
    expect(mode(path.join(dir, 'ledger.md'))).toBe(0o600);
    expect(mode(path.join(dir, '.memory-index', 'index.db'))).toBe(0o600);
    // Bytes are untouched, and the symlink is neither followed nor replaced.
    expect(fs.readFileSync(path.join(dir, 'Memory', 'Daily', '2026-10-12.md'), 'utf8')).toBe('a statement\n');
    expect(fs.lstatSync(path.join(dir, 'link.md')).isSymbolicLink()).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(new RegExp(`\\[mvp\\] memory directory .* was accessible by group or others \\(mode ${m.toString(8)}\\); tightened to owner-only`));
    // A second start finds it tight: nothing to do, nothing said.
    ensureOwnerOnlyMemoryDir(dir, log);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('leaves an owner-only directory and the modes inside it alone, silently', () => {
    const dir = readableMemory(0o700);
    const log = vi.fn();
    ensureOwnerOnlyMemoryDir(dir, log);
    expect(log).not.toHaveBeenCalled();
    expect(mode(path.join(dir, 'ledger.md'))).toBe(0o644);
  });

  it('refuses a readable directory it does not own: it cannot be tightened', () => {
    const dir = readableMemory(0o755);
    const real = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(real + 1);
    const log = vi.fn();
    expect(() => ensureOwnerOnlyMemoryDir(dir, log)).toThrow(/Memory directory is not usable: it is not owned by the service user.*Refusing to start .*\(fail closed\)\. Run: chmod -R go-rwx/s);
    expect(mode(dir)).toBe(0o755);
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses when the change is refused, and leaves the directory as it was', () => {
    const dir = readableMemory(0o755);
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); });
    expect(() => ensureOwnerOnlyMemoryDir(dir, vi.fn())).toThrow(/mode 755\) and cannot be tightened to owner-only \(0700\) \(EPERM\)/);
    vi.restoreAllMocks();
    expect(mode(dir)).toBe(0o755);
  });

  it('refuses a path that is a file', () => {
    const file = path.join(tmp(), 'memory');
    fs.writeFileSync(file, 'x');
    expect(() => ensureOwnerOnlyMemoryDir(file)).toThrow(/not a directory/);
  });

  it('accepts an owner-only directory, and creates a missing one 0700 under a permissive umask', async () => {
    const root = tmp();
    const existing = path.join(root, 'existing');
    fs.mkdirSync(existing, { mode: 0o700 });
    await withUmask(0o022, () => ensureOwnerOnlyMemoryDir(existing));
    const fresh = path.join(root, 'a', 'b', 'memory');
    await withUmask(0o000, () => ensureOwnerOnlyMemoryDir(fresh));
    expect(mode(fresh)).toBe(0o700);
  });

  it('starts npm run mvp on a readable memory directory and its index, tightened and said once', () => {
    const dir = path.join(tmp(), 'memory');
    fs.mkdirSync(path.join(dir, '.memory-index'), { recursive: true });
    const first = openDb(path.join(dir, '.memory-index', 'index.db'));
    runMigrations(first);
    first.close();
    fs.chmodSync(path.join(dir, '.memory-index', 'index.db'), 0o644);
    fs.chmodSync(path.join(dir, '.memory-index'), 0o755);
    fs.chmodSync(dir, 0o755);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    localApp({ memoryDir: dir });
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, '.memory-index', 'index.db'))).toBe(0o600);
    expect(log.mock.calls.filter(([line]) => String(line).includes('tightened to owner-only'))).toHaveLength(1);
  });

  it('stops npm run mvp before anything is opened when the memory directory is another user\'s', () => {
    const dir = readableMemory(0o755);
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    expect(() => localApp({ memoryDir: dir })).toThrow(/Memory directory is not usable/);
    expect(fs.existsSync(path.join(dir, '.memory-index', 'index.db-wal'))).toBe(false);
  });

  it('tightens a database file kept outside the memory directory, with its -wal and -shm', () => {
    const root = tmp();
    const db = path.join(root, 'index.db');
    for (const suffix of ['', '-wal', '-shm']) fs.writeFileSync(db + suffix, 'x', { mode: 0o644 });
    ensureOwnerOnlyFile(db);
    for (const suffix of ['', '-wal', '-shm']) expect(mode(db + suffix)).toBe(0o600);
    ensureOwnerOnlyFile(path.join(root, 'missing.db'));
  });

  it('starts on a fresh path and keeps the notes, the ledger and the index owner-only under umask 000', async () => {
    const root = tmp();
    const memoryDir = path.join(root, 'memory');
    await withUmask(0o000, async () => {
      const { app } = localApp({ memoryDir });
      expect(mode(memoryDir)).toBe(0o700);
      // What `remember` does for a statement: the ledger, then the daily note.
      const receipt = await remember(app.db, memoryDir, DEFAULT_LEDGER_REL, { subject: 'Alice', predicate: 'works_at', object: 'Globex', source: 'perm-test' });
      expect(receipt.ok).toBe(true);
      await appendDailyMemory(memoryDir, '2026-10-12', { text: 'a statement the owner made', source: 'perm-test' });
    });
    const modes: Record<string, number> = {};
    const walk = (d: string) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        modes[path.relative(memoryDir, p)] = mode(p);
        if (fs.statSync(p).isDirectory()) walk(p);
      }
    };
    walk(memoryDir);
    for (const [rel, m] of Object.entries(modes)) {
      const isDir = fs.statSync(path.join(memoryDir, rel)).isDirectory();
      expect(m, `${rel} (${m.toString(8)})`).toBe(isDir ? 0o700 : 0o600);
    }
    expect(Object.keys(modes)).toEqual(expect.arrayContaining([
      '.memory-index', '.memory-index/index.db', 'Memory', 'Memory/Daily', DEFAULT_LEDGER_REL,
    ]));
    expect(Object.keys(modes).some(rel => rel.startsWith('Memory/Daily/2026-10-12'))).toBe(true);
  });
});

describe('index database', () => {
  it.skipIf(WINDOWS)('is created 0600 in a 0700 directory under umask 000, and an existing file keeps its mode', async () => {
    const root = tmp();
    const dbPath = path.join(root, 'nested', '.semantic-memory', 'index.db');
    await withUmask(0o000, () => {
      const db = openDb(dbPath);
      runMigrations(db);
      db.prepare('CREATE TABLE IF NOT EXISTS t (x)').run();
      db.prepare('INSERT INTO t VALUES (1)').run();
      db.close();
    });
    expect(mode(path.dirname(dbPath))).toBe(0o700);
    expect(mode(dbPath)).toBe(0o600);
    for (const side of ['-wal', '-shm']) if (fs.existsSync(dbPath + side)) expect(mode(dbPath + side)).toBe(0o600);
    fs.chmodSync(dbPath, 0o640);
    openDb(dbPath).close();
    expect(mode(dbPath)).toBe(0o640);
  });

  it('still opens an in-memory database', () => {
    const db = openDb(':memory:');
    expect(db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    db.close();
  });
});
