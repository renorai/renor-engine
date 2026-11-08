import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { appendDailyEntry } from '../../src/memory/writer';
import { appendLedgerEvent, resolveLedgerPath, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';

/**
 * STANDING TEST (adv-crashsafe-1012, F3). A write that fails with ENOSPC must leave the file as it was: a client told
 * "failed" has not saved anything. Today the bytes written before the disk filled stay in the file, so the cut entry
 * is indexed, served as a memory, and (for the ledger) replayed on every restart or refused at start-up.
 * The partial write is reproduced the way tmpfs and ext4 do it: the first half of the buffer lands, then ENOSPC.
 */
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * The disk fills half-way through the write, however the append is issued: through fs.appendFile, or through a file
 * handle opened in append mode (write, then sync). Either way the first half of the buffer lands, then ENOSPC.
 */
function halfThenEnospc() {
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const realAppendFile = fsp.appendFile.bind(fsp);
  vi.spyOn(fsp, 'appendFile').mockImplementation(async (file: any, data: any, options?: any) => {
    const buf = Buffer.from(typeof data === 'string' ? data : data);
    await realAppendFile(file, buf.subarray(0, Math.floor(buf.length / 2)), options);
    throw enospc();
  });
  const realOpen = fsp.open.bind(fsp);
  vi.spyOn(fsp, 'open').mockImplementation((async (...args: any[]) => {
    const handle: any = await (realOpen as any)(...args);
    const halfWrite = async (data: any) => {
      const buf = Buffer.from(typeof data === 'string' ? data : data);
      await handle.write(buf.subarray(0, Math.floor(buf.length / 2)));
      throw enospc();
    };
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === 'appendFile' || prop === 'writeFile' || prop === 'write') return halfWrite;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as any);
}

describe('an append that hits ENOSPC', () => {
  it('leaves the daily note byte-identical to what it was before the failed save', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'enospc-daily-')); dirs.push(vault);
    const file = await appendDailyEntry(vault, '2026-03-01', { text: 'first note, saved before the disk filled', source: 'test' }).then(r => r.filePath);
    const before = fs.readFileSync(file);
    halfThenEnospc();
    await expect(appendDailyEntry(vault, '2026-03-01', { text: 'second note '.repeat(40), source: 'test' })).rejects.toThrow(/ENOSPC/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('leaves the ledger byte-identical to what it was before the failed save', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'enospc-ledger-')); dirs.push(vault);
    const ev = (id: string, object: string) => ({ id, at: new Date().toISOString(), kind: 'store' as const, subject: 'S', predicate: 'p', object, closedEvent: null, source: 'test' });
    await appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_AAAAAAAAAAAAAA', 'before'));
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    const before = fs.readFileSync(ledger);
    halfThenEnospc();
    await expect(appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_BBBBBBBBBBBBBB', 'after '.repeat(30)))).rejects.toThrow(/ENOSPC/);
    expect(fs.readFileSync(ledger).equals(before)).toBe(true);
  });

  it('does not cut back another append that lands while the failing write is still in progress', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'enospc-race-')); dirs.push(vault);
    const ev = (id: string, object: string) => ({ id, at: new Date().toISOString(), kind: 'store' as const, subject: 'S', predicate: 'p', object, closedEvent: null, source: 'test' });
    await appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_AAAAAAAAAAAAAA', 'before'));
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    // The first append writes half its bytes, waits, then fails: while it waits, a second append completes.
    const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const realOpen = fsp.open.bind(fsp);
    let slowFirst = true;
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: any[]) => {
      const handle: any = await (realOpen as any)(...args);
      if (!slowFirst) return handle;
      slowFirst = false;
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'appendFile') {
            return async (data: any) => {
              const buf = Buffer.from(data);
              await target.write(buf.subarray(0, Math.floor(buf.length / 2)));
              await new Promise(resolve => setTimeout(resolve, 150));
              throw enospc();
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as any);
    const failing = appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_BBBBBBBBBBBBBB', 'failing '.repeat(30)));
    await new Promise(resolve => setTimeout(resolve, 20));
    const survivor = appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_CCCCCCCCCCCCCC', 'survivor'));
    await expect(failing).rejects.toThrow(/ENOSPC/);
    await survivor; // acknowledged: the caller was told it saved
    expect(fs.readFileSync(ledger, 'utf8')).toContain('## MEM_CCCCCCCCCCCCCC');
  });

  it('refuses further appends to a file whose failed write could not be cut back', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'enospc-stuck-')); dirs.push(vault);
    const ev = (id: string, object: string) => ({ id, at: new Date().toISOString(), kind: 'store' as const, subject: 'S', predicate: 'p', object, closedEvent: null, source: 'test' });
    await appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_AAAAAAAAAAAAAA', 'before'));
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    // The half-write lands and the cut back fails too (an I/O error on truncate).
    const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: any[]) => {
      const handle: any = await (realOpen as any)(...args);
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'appendFile') {
            return async (data: any) => {
              const buf = Buffer.from(data);
              await target.write(buf.subarray(0, Math.floor(buf.length / 2)));
              throw enospc();
            };
          }
          if (prop === 'truncate') return async () => { throw Object.assign(new Error('EIO: i/o error, ftruncate'), { code: 'EIO' }); };
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as any);
    await expect(appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_BBBBBBBBBBBBBB', 'failing '.repeat(30)))).rejects.toThrow(/ENOSPC/);
    vi.restoreAllMocks();
    const stuck = fs.readFileSync(ledger);
    // A later, small append must not be written after the fragment, where it would make the fragment look whole.
    await expect(appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_CCCCCCCCCCCCCC', 'later'))).rejects.toThrow(/could not be cut back/);
    expect(fs.readFileSync(ledger).equals(stuck)).toBe(true);
  });

  it('cuts back through a second handle when the append handle may not truncate (Windows, #1563), and keeps accepting saves', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'enospc-append-only-')); dirs.push(vault);
    const ev = (id: string, object: string) => ({ id, at: new Date().toISOString(), kind: 'store' as const, subject: 'S', predicate: 'p', object, closedEvent: null, source: 'test' });
    await appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_AAAAAAAAAAAAAA', 'before'));
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    const before = fs.readFileSync(ledger);
    // What Windows does: a handle opened O_APPEND carries only the right to append, so ftruncate on it is EPERM. A handle
    // opened without O_APPEND may truncate.
    const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: any[]) => {
      const handle: any = await (realOpen as any)(...args);
      const appendOnly = typeof args[1] === 'number' && (args[1] & fs.constants.O_APPEND) !== 0;
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'appendFile') {
            return async (data: any) => {
              const buf = Buffer.from(data);
              await target.write(buf.subarray(0, Math.floor(buf.length / 2)));
              throw enospc();
            };
          }
          if (prop === 'truncate' && appendOnly) {
            return async () => { throw Object.assign(new Error('EPERM: operation not permitted, ftruncate'), { code: 'EPERM' }); };
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as any);
    await expect(appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_BBBBBBBBBBBBBB', 'failing '.repeat(30)))).rejects.toThrow(/ENOSPC/);
    vi.restoreAllMocks();
    expect(fs.readFileSync(ledger).equals(before)).toBe(true);
    await appendLedgerEvent(vault, DEFAULT_LEDGER_REL, ev('MEM_CCCCCCCCCCCCCC', 'later'));
    expect(fs.readFileSync(ledger, 'utf8')).toContain('## MEM_CCCCCCCCCCCCCC');
  });
});
