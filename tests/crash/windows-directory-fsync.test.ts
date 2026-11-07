import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { appendDailyEntry } from '../../src/memory/writer';
import { appendLedgerEvent, resolveLedgerPath, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { createConfined } from '../../src/memory/confinedWrite';
import { isUnsupportedDirectorySync, syncDirectory, syncDirectorySync } from '../../src/memory/durableAppend';
import { JournalLog, readJournalLog } from '../../src/importing/journalLog';

/**
 * #1563: on Windows, fsync of a directory handle fails with EPERM, and renor-engine 1.4.3 failed every save there (538 test
 * failures in the public engine's first Windows run). The directory flush is what makes a created or renamed name durable
 * on POSIX; NTFS journals the name itself. So on win32, and for a directory only, that error is "not supported here", and
 * on POSIX it is still a failed save. This runs on Linux in CI, so Windows is simulated: process.platform says win32 and
 * the directory fsync throws what Windows throws.
 */
const dirs: string[] = [];
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', realPlatform);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...realPlatform, value });
}

const windowsError = (syscall: string) => Object.assign(new Error(`EPERM: operation not permitted, ${syscall}`), { errno: -4048, code: 'EPERM', syscall });

/**
 * Every fsync of a DIRECTORY throws EPERM, the way Windows does, through both the promise handle (`handle.sync()`) and
 * `fs.fsyncSync`. A file's fsync goes through. Returns how many file and directory fsyncs were attempted.
 */
function directoryFsyncFails(fileFsync: 'ok' | 'fails' = 'ok') {
  const calls = { file: 0, dir: 0 };
  const realFsyncSync = fs.fsyncSync.bind(fs);
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
    if (fs.fstatSync(fd).isDirectory()) { calls.dir++; throw windowsError('fsync'); }
    calls.file++;
    if (fileFsync === 'fails') throw windowsError('fsync');
    return realFsyncSync(fd);
  });
  const realOpen = fsp.open.bind(fsp);
  vi.spyOn(fsp, 'open').mockImplementation((async (...args: any[]) => {
    const handle: any = await (realOpen as any)(...args);
    const isDir = (await handle.stat()).isDirectory();
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === 'sync') {
          return async () => {
            if (isDir) { calls.dir++; throw windowsError('fsync'); }
            calls.file++;
            if (fileFsync === 'fails') throw windowsError('fsync');
            return target.sync();
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as any);
  return calls;
}

const ev = (id: string, object: string) => ({ id, at: new Date().toISOString(), kind: 'store' as const, subject: 'S', predicate: 'p', object, closedEvent: null, source: 'test' });

describe('which errors mean "a directory cannot be fsynced here"', () => {
  it('only EPERM, EISDIR and EINVAL, and only on win32', () => {
    for (const code of ['EPERM', 'EISDIR', 'EINVAL']) {
      expect(isUnsupportedDirectorySync({ code }, 'win32')).toBe(true);
      expect(isUnsupportedDirectorySync({ code }, 'linux')).toBe(false);
      expect(isUnsupportedDirectorySync({ code }, 'darwin')).toBe(false);
    }
    for (const code of ['EIO', 'ENOSPC', 'ENOENT', 'EACCES', undefined]) expect(isUnsupportedDirectorySync({ code }, 'win32')).toBe(false);
    expect(isUnsupportedDirectorySync(null, 'win32')).toBe(false);
  });
});

describe('on Windows (simulated), where a directory fsync throws EPERM', () => {
  it('a daily-note save succeeds, the file itself is still fsynced, and the directory flush was attempted', async () => {
    platform('win32');
    const vault = tmpDir('win-fsync-daily-');
    const calls = directoryFsyncFails();
    const { filePath } = await appendDailyEntry(vault, '2026-03-01', { text: 'remember: the Windows save works', source: 'test' });
    expect(fs.readFileSync(filePath, 'utf8')).toContain('remember: the Windows save works');
    expect(calls.file).toBeGreaterThan(0);
    expect(calls.dir).toBeGreaterThan(0);
  });

  it('a ledger save succeeds', async () => {
    platform('win32');
    const vault = tmpDir('win-fsync-ledger-');
    directoryFsyncFails();
    await appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_AAAAAAAAAAAAAA', 'kept'));
    expect(fs.readFileSync(resolveLedgerPath(vault, DEFAULT_LEDGER_REL), 'utf8')).toContain('## MEM_AAAAAAAAAAAAAA');
  });

  it('a new confined file and the import journal log are created', async () => {
    platform('win32');
    const vault = tmpDir('win-fsync-create-');
    directoryFsyncFails();
    const created = await createConfined(vault, 'notes/new.md', 'hello');
    expect(fs.readFileSync(created, 'utf8')).toBe('hello');
    const logFile = path.join(vault, 'batch.jsonl');
    const log = new JournalLog(logFile);
    log.append({ list: 'created', relPath: 'notes/new.md', hash: 'a'.repeat(64) });
    log.close();
    expect(readJournalLog(logFile)).toEqual([{ list: 'created', relPath: 'notes/new.md', hash: 'a'.repeat(64) }]);
  });

  it("still fails the save when the FILE's fsync fails: only the directory flush is tolerated", async () => {
    platform('win32');
    const vault = tmpDir('win-fsync-file-');
    directoryFsyncFails('fails');
    await expect(appendDailyEntry(vault, '2026-03-01', { text: 'not durable', source: 'test' })).rejects.toThrow(/EPERM/);
    const log = new JournalLog(path.join(vault, 'batch.jsonl'));
    expect(() => log.append({ list: 'created', relPath: 'x.md', hash: 'b'.repeat(64) })).toThrow(/EPERM/);
    log.close();
  });

  it('tolerates a directory that cannot even be opened for the flush', async () => {
    platform('win32');
    const dir = tmpDir('win-fsync-open-');
    vi.spyOn(fs, 'openSync').mockImplementation(() => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }); });
    vi.spyOn(fsp, 'open').mockImplementation((async () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }); }) as any);
    expect(() => syncDirectorySync(dir)).not.toThrow();
    await expect(syncDirectory(dir)).resolves.toBeUndefined();
  });
});

describe('on POSIX the directory flush is still required (unchanged)', () => {
  for (const posix of ['linux', 'darwin'] as const) {
    it(`${posix}: the same EPERM on the directory fsync fails the save`, async () => {
      platform(posix);
      const vault = tmpDir('posix-fsync-');
      directoryFsyncFails();
      await expect(appendDailyEntry(vault, '2026-03-01', { text: 'a new daily note needs its directory entry', source: 'test' })).rejects.toThrow(/EPERM/);
      expect(() => syncDirectorySync(vault)).toThrow(/EPERM/);
      await expect(syncDirectory(vault)).rejects.toThrow(/EPERM/);
    });
  }

  it('a real directory fsync still runs and succeeds', async () => {
    const dir = tmpDir('posix-fsync-real-');
    const spy = vi.spyOn(fs, 'fsyncSync');
    syncDirectorySync(dir);
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(syncDirectory(dir)).resolves.toBeUndefined();
  });
});
