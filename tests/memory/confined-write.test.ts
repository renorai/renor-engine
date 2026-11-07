// Adversary run renor-adv-vaultfs-1012, F1/F6: the memory write side followed a symbolic link, wrote through a hard link and
// blocked on a FIFO planted in the vault, while the read side refused all three. Each test plants one and asserts that
// nothing outside the vault is touched, nothing hangs, and the refusal says why.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { appendDailyEntry } from '../../src/memory/writer';
import { appendLedgerEvent, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { engineDailyHeader } from '../../src/memory/dailyNote';
import { appendConfined } from '../../src/memory/confinedWrite';

let root: string;
let vault: string;
let outside: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'confined-')));
  vault = path.join(root, 'vault');
  outside = path.join(root, 'outside');
  fs.mkdirSync(vault);
  fs.mkdirSync(outside);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const CANARY = 'OUTSIDE-FILE-CANARY\n';
const entry = { text: 'ATTACKER-LINE', source: 'vfs' };
const event = {
  id: 'mem_vfs0001', at: '2026-10-12T00:00:00.000Z', kind: 'store', subject: 'Zed', predicate: 'color',
  object: 'LEDGER-ATTACK', source: 'test', closedEvent: null,
};
const TODAY = '2026-10-12';
const REFUSED = /refusing to write/;

describe('a daily log', () => {
  it('is not appended through a symlinked file', async () => {
    fs.writeFileSync(path.join(outside, 'target.md'), CANARY);
    fs.mkdirSync(path.join(vault, 'Memory/Daily'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'target.md'), path.join(vault, `Memory/Daily/${TODAY}.md`));
    await expect(appendDailyEntry(vault, TODAY, entry)).rejects.toThrow(REFUSED);
    expect(fs.readFileSync(path.join(outside, 'target.md'), 'utf8')).toBe(CANARY);
  });

  it('is not created through a dangling symlink', async () => {
    fs.mkdirSync(path.join(vault, 'Memory/Daily'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'new-file.md'), path.join(vault, `Memory/Daily/${TODAY}.md`));
    await expect(appendDailyEntry(vault, TODAY, entry)).rejects.toThrow(REFUSED);
    expect(fs.existsSync(path.join(outside, 'new-file.md'))).toBe(false);
  });

  it('is not written below a symlinked Memory/Daily directory', async () => {
    fs.mkdirSync(path.join(vault, 'Memory'));
    fs.mkdirSync(path.join(outside, 'dailies'));
    fs.symlinkSync(path.join(outside, 'dailies'), path.join(vault, 'Memory/Daily'));
    await expect(appendDailyEntry(vault, TODAY, entry)).rejects.toThrow(REFUSED);
    expect(fs.readdirSync(path.join(outside, 'dailies'))).toEqual([]);
  });

  it('is not written below a symlinked scope directory', async () => {
    fs.mkdirSync(path.join(vault, 'Memory/Scopes'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'sc'));
    fs.symlinkSync(path.join(outside, 'sc'), path.join(vault, 'Memory/Scopes/proj'));
    await expect(appendDailyEntry(vault, TODAY, entry, 'Memory/Scopes/proj/Daily')).rejects.toThrow(REFUSED);
    expect(fs.readdirSync(path.join(outside, 'sc'))).toEqual([]);
  });

  it('does not hand a multi-line note a standalone line in a shell startup file behind a dated link', async () => {
    fs.writeFileSync(path.join(outside, 'rc'), '# user shell startup\n');
    fs.mkdirSync(path.join(vault, 'Memory/Daily'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'rc'), path.join(vault, 'Memory/Daily/2030-01-01.md'));
    await expect(appendDailyEntry(vault, '2030-01-01', { text: 'harmless\ntouch /tmp/PWNED-STANDALONE', source: 'vfs' }))
      .rejects.toThrow(REFUSED);
    expect(fs.readFileSync(path.join(outside, 'rc'), 'utf8')).toBe('# user shell startup\n');
  });

  it('is not written through a hard link to a file outside the vault', async () => {
    fs.writeFileSync(path.join(outside, 'h.md'), CANARY);
    fs.mkdirSync(path.join(vault, 'Memory/Daily'), { recursive: true });
    fs.linkSync(path.join(outside, 'h.md'), path.join(vault, `Memory/Daily/${TODAY}.md`));
    await expect(appendDailyEntry(vault, TODAY, entry)).rejects.toThrow(REFUSED);
    expect(fs.readFileSync(path.join(outside, 'h.md'), 'utf8')).toBe(CANARY);
  });

  it('does not block on a FIFO planted under its name', async () => {
    fs.mkdirSync(path.join(vault, 'Memory/Daily'), { recursive: true });
    execFileSync('mkfifo', [path.join(vault, `Memory/Daily/${TODAY}.md`)]);
    const outcome = await Promise.race([
      appendDailyEntry(vault, TODAY, entry).then(() => 'wrote', (e: Error) => e.message),
      new Promise<string>(resolve => setTimeout(() => resolve('HUNG'), 5000)),
    ]);
    expect(outcome).toMatch(REFUSED);
  }, 15000);

  it('is written as before in an ordinary vault: same bytes, created and appended', async () => {
    const clock = { time: '11:33:20' };
    const first = await appendDailyEntry(vault, TODAY, entry, 'Memory/Daily', clock);
    await appendDailyEntry(vault, TODAY, { text: 'second', source: 'vfs' }, 'Memory/Daily', clock);
    expect(first.filePath).toBe(path.join(vault, 'Memory/Daily', `${TODAY}.md`));
    // The bytes the writer has always stored: the engine's header once, then each entry behind a line break.
    expect(fs.readFileSync(first.filePath, 'utf8'))
      .toBe(`${engineDailyHeader(TODAY)}\n- [11:33:20] (vfs) ATTACKER-LINE\n- [11:33:20] (vfs) second`);
    // Windows has no POSIX mode bits: stat reports 0o666/0o777 whatever was asked, and chmod only toggles read-only.
    if (process.platform !== 'win32') expect(fs.statSync(first.filePath).mode & 0o777).toBe(0o600);
  });

  it('is written into a folder whose name merely starts with two dots (the post-open check is not fooled by it)', async () => {
    await appendConfined(vault, '..safe/log.md', 'inside\n');
    expect(fs.readFileSync(path.join(vault, '..safe/log.md'), 'utf8')).toBe('inside\n');
  });

  it('is written when the vault itself is reached through a link (the user put it there)', async () => {
    const link = path.join(root, 'vault-link');
    fs.symlinkSync(vault, link);
    await appendDailyEntry(link, TODAY, entry);
    expect(fs.existsSync(path.join(vault, 'Memory/Daily', `${TODAY}.md`))).toBe(true);
  });
});

describe('the ledger', () => {
  it('is not appended through a symlinked file', async () => {
    fs.writeFileSync(path.join(outside, 'ledger-target.md'), CANARY);
    fs.mkdirSync(path.join(vault, 'System'));
    fs.symlinkSync(path.join(outside, 'ledger-target.md'), path.join(vault, DEFAULT_LEDGER_REL));
    await expect(appendLedgerEvent(vault, DEFAULT_LEDGER_REL, event)).rejects.toThrow(REFUSED);
    expect(fs.readFileSync(path.join(outside, 'ledger-target.md'), 'utf8')).toBe(CANARY);
  });

  it('is not created below a symlinked System directory', async () => {
    fs.mkdirSync(path.join(outside, 'sys'));
    fs.symlinkSync(path.join(outside, 'sys'), path.join(vault, 'System'));
    await expect(appendLedgerEvent(vault, DEFAULT_LEDGER_REL, event)).rejects.toThrow(REFUSED);
    expect(fs.readdirSync(path.join(outside, 'sys'))).toEqual([]);
  });

  it('is not written through a hard link', async () => {
    fs.writeFileSync(path.join(outside, 'l.md'), CANARY);
    fs.mkdirSync(path.join(vault, 'System'));
    fs.linkSync(path.join(outside, 'l.md'), path.join(vault, DEFAULT_LEDGER_REL));
    await expect(appendLedgerEvent(vault, DEFAULT_LEDGER_REL, event)).rejects.toThrow(REFUSED);
    expect(fs.readFileSync(path.join(outside, 'l.md'), 'utf8')).toBe(CANARY);
  });

  it('is created with its header once and appended to after, in an ordinary vault', async () => {
    await appendLedgerEvent(vault, DEFAULT_LEDGER_REL, event);
    await appendLedgerEvent(vault, DEFAULT_LEDGER_REL, { ...event, id: 'mem_vfs0002' });
    const text = fs.readFileSync(path.join(vault, DEFAULT_LEDGER_REL), 'utf8');
    expect(text.startsWith('---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Memory Events Ledger\n')).toBe(true);
    expect(text.match(/^# Memory Events Ledger$/gm)).toHaveLength(1);
    expect(text).toContain('## mem_vfs0001 · 2026-10-12T00:00:00.000Z');
    expect(text).toContain('## mem_vfs0002 · 2026-10-12T00:00:00.000Z');
  });
});

describe('appendConfined', () => {
  it('refuses a path that leaves the vault', async () => {
    await expect(appendConfined(vault, '../outside/x.md', 'a')).rejects.toThrow(REFUSED);
    await expect(appendConfined(vault, path.join(outside, 'x.md'), 'a')).rejects.toThrow(REFUSED);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
