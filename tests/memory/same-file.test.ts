import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { nameIsOpenFile, nameIsOpenFileSync } from '../../src/memory/sameFile';

/**
 * The check that stands in for O_NOFOLLOW where Node has none (Windows, #1563). There, an open of a name that is a link
 * follows it and returns a handle on the target outside the vault: the same situation as opening the target directly and
 * then asking about the link's name, which is what these tests do, so they prove the check on every platform.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup(): { vault: string; outside: string; link: string; plain: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'same-file-'));
  dirs.push(root);
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, 'victim\n');
  const plain = path.join(vault, 'plain.md');
  fs.writeFileSync(plain, 'mine\n');
  const link = path.join(vault, 'link.md');
  fs.symlinkSync(outside, link, 'file');
  return { vault, outside, link, plain };
}

describe('nameIsOpenFile: the name, not followed, is the file that was opened', () => {
  it('accepts a regular file opened by its own name', async () => {
    const { plain } = setup();
    const handle = await fsp.open(plain, 'r');
    try {
      expect(await nameIsOpenFile(handle, plain)).toBe(true);
    } finally { await handle.close(); }
  });

  it('refuses a name that is a link to the file that was opened (the open followed it)', async () => {
    const { outside, link } = setup();
    const handle = await fsp.open(outside, 'r');
    try {
      expect(await nameIsOpenFile(handle, link)).toBe(false);
    } finally { await handle.close(); }
    expect(fs.readFileSync(outside, 'utf8')).toBe('victim\n');
  });

  it('refuses a name that now holds another file, or nothing', async () => {
    const { plain, vault } = setup();
    const handle = await fsp.open(plain, 'r');
    try {
      const other = path.join(vault, 'other.md');
      fs.writeFileSync(other, 'other\n');
      expect(await nameIsOpenFile(handle, other)).toBe(false);
      expect(await nameIsOpenFile(handle, path.join(vault, 'missing.md'))).toBe(false);
    } finally { await handle.close(); }
  });

  it('the synchronous form gives the same answers', () => {
    const { outside, link, plain } = setup();
    const fd = fs.openSync(outside, 'r');
    try {
      expect(nameIsOpenFileSync(fd, link)).toBe(false);
      expect(nameIsOpenFileSync(fd, outside)).toBe(true);
      expect(nameIsOpenFileSync(fd, plain)).toBe(false);
    } finally { fs.closeSync(fd); }
  });
});
