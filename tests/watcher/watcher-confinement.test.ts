// Adversary run renor-adv-vaultfs-1012, F4: `renor watch` had rules of its own (real chokidar, no walker): it followed
// symlinks out of the vault and indexed retired notes under .trash and node_modules. Real chokidar and the real indexer here.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile } from '../../src/indexer/pipeline';
import { startWatcher } from '../../src/watcher/watcher';
import { removeTestDir } from '../helpers/removeDb';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function watchRun(prep: (vault: string, outside: string) => void, after: (vault: string, outside: string) => void, vaultName = 'vault') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-confine-')));
  const vault = path.join(root, vaultName);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(outside);
  prep(vault, outside);
  const db = openDb(path.join(root, 'idx.db'));
  runMigrations(db);
  const watcher = startWatcher(vault, db, {});
  await new Promise<void>(resolve => watcher.on('ready', () => resolve()));
  after(vault, outside);
  await sleep(2500);
  const paths = (db.prepare('SELECT path FROM notes').all() as { path: string }[]).map(r => path.relative(root, r.path)).sort();
  await watcher.close();
  db.close();
  removeTestDir(root);
  return paths;
}

describe('renor watch follows the walker\'s rules', () => {
  it('does not index a symlinked file or directory that points outside the vault', async () => {
    const indexed = await watchRun(
      (_v, o) => {
        fs.writeFileSync(path.join(o, 'secret.md'), '# s\nwatchsecret');
        fs.mkdirSync(path.join(o, 'dir'));
        fs.writeFileSync(path.join(o, 'dir/in.md'), '# d\nwatchdir');
      },
      (v, o) => {
        fs.symlinkSync(path.join(o, 'secret.md'), path.join(v, 'link.md'));
        fs.symlinkSync(path.join(o, 'dir'), path.join(v, 'linkdir'));
        fs.writeFileSync(path.join(v, 'plain.md'), '# p\nplain');
      },
    );
    expect(indexed).toEqual(['vault/plain.md']);
  }, 30000);

  it('does not index retired notes under .trash, nor node_modules', async () => {
    const indexed = await watchRun(
      () => {},
      (v) => {
        fs.mkdirSync(path.join(v, '.trash/renor-retired/files/r1'), { recursive: true });
        fs.writeFileSync(path.join(v, '.trash/renor-retired/files/r1/forgot.md'), '# forgot\nretiredwatchword');
        fs.mkdirSync(path.join(v, 'node_modules/p'), { recursive: true });
        fs.writeFileSync(path.join(v, 'node_modules/p/R.md'), '# r\nnm');
        fs.writeFileSync(path.join(v, 'ok.md'), '# ok\nok');
      },
    );
    expect(indexed).toEqual(['vault/ok.md']);
  }, 30000);

  it('still watches a vault that itself sits under a folder named node_modules', async () => {
    const indexed = await watchRun(() => {}, (v) => { fs.writeFileSync(path.join(v, 'ok.md'), '# ok\nok'); }, 'node_modules/vault');
    expect(indexed).toEqual(['node_modules/vault/ok.md']);
  }, 30000);

  it('indexes only markdown files, also in a vault whose path holds glob characters', async () => {
    const indexed = await watchRun(() => {}, (v) => {
      fs.mkdirSync(path.join(v, 'sub'));
      fs.writeFileSync(path.join(v, 'sub/ok.md'), '# ok\nok');
      fs.writeFileSync(path.join(v, 'notes.txt'), 'not a note');
      fs.writeFileSync(path.join(v, 'ok.md.bak'), '# bak\nbak');
    }, 'vault [1] {a,b}');
    expect(indexed).toEqual(['vault [1] {a,b}/sub/ok.md']);
  }, 30000);
});

describe('indexFile', () => {
  it('does not read through a symlink', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'index-link-')));
    let db: ReturnType<typeof openDb> | undefined;
    try {
      fs.writeFileSync(path.join(root, 'secret.md'), '# s\nindexsecret');
      fs.symlinkSync(path.join(root, 'secret.md'), path.join(root, 'link.md'));
      db = openDb(path.join(root, 'idx.db'));
      runMigrations(db);
      await expect(indexFile(db, path.join(root, 'link.md'))).rejects.toThrow(/symbolic link/);
      expect(db.prepare('SELECT count(*) AS c FROM notes').get()).toEqual({ c: 0 });
    } finally {
      // Closed here, not at the end of the try, so a failed expectation cannot leave it open for the removal.
      db?.close();
      removeTestDir(root);
    }
  });
});
