// Adversary run renor-adv-vaultfs-1012: the retired-memory journal was opened without O_NONBLOCK and without a regular-file
// check, so a FIFO under its name hung every retire and read, and a hard link was appended to.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { retireMemory, type MemoryMapContext } from '../../src/memorymap/memoryMap';
import type Database from '../../src/db/sqlite';

function write(vault: string, rel: string, content: string) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

describe('the retired-memory journal', () => {
  let vault: string;
  let db: Database.Database;
  let ctx: MemoryMapContext;

  beforeEach(async () => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memmap-journal-'));
    db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    ctx = { db, memoryDir: vault, ledgerRelPath: DEFAULT_LEDGER_REL, indexOptions: {} };
    write(vault, 'Notes/open.md', '# Open\nan ordinary note\n');
    await indexVault(db, vault, {});
  });
  afterEach(() => {
    db.close();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('does not write the retired-memory journal through a hard link', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memmap-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'j.jsonl'), 'OUTSIDE\n');
      fs.mkdirSync(path.join(vault, '.trash/renor-retired'), { recursive: true });
      fs.linkSync(path.join(outside, 'j.jsonl'), path.join(vault, '.trash/renor-retired/retired.jsonl'));
      await expect(retireMemory(ctx, 'note:Notes/open.md')).rejects.toThrow(/refusing|not inside|single name/);
      expect(fs.readFileSync(path.join(outside, 'j.jsonl'), 'utf8')).toBe('OUTSIDE\n');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // Windows has no FIFOs (mkfifo does not exist), so there is nothing to plant (#1563).
  it.skipIf(process.platform === 'win32')('does not wait on a FIFO planted as the retired-memory journal', async () => {
    fs.mkdirSync(path.join(vault, '.trash/renor-retired'), { recursive: true });
    execFileSync('mkfifo', [path.join(vault, '.trash/renor-retired/retired.jsonl')]);
    const outcome = await Promise.race([
      retireMemory(ctx, 'note:Notes/open.md').then(() => 'retired', (e: Error) => e.message),
      new Promise<string>(resolve => setTimeout(() => resolve('HUNG'), 5000)),
    ]);
    expect(outcome).not.toBe('HUNG');
    expect(outcome).not.toBe('retired');
  }, 15000);
});
