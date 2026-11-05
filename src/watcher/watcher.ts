import chokidar, { type FSWatcher } from 'chokidar';
import Database from '../db/sqlite';
import fs from 'fs';
import path from 'path';
import { indexFile, IndexOptions } from '../indexer/pipeline';
import { createLogger } from '../mvp/log';

const log = createLogger('engine');

function loadIgnorePatterns(vaultPath: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(vaultPath, '.semanticignore'), 'utf8');
    return raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function isIgnored(filePath: string, vaultPath: string, patterns: string[]): boolean {
  const rel = path.relative(vaultPath, filePath);
  return patterns.some(p => {
    const clean = p.replace(/\/$/, '');
    return rel === clean || rel.startsWith(clean + '/') || rel.includes('/' + clean + '/') || rel.endsWith('/' + clean);
  });
}

const isMarkdown = (p: string) => p.endsWith('.md');

// Below the vault, so a vault that itself sits under a folder of this name is still watched.
const WALKER_SKIPS = /(^|[\\/])(\.trash|\.memory-index|node_modules)([\\/]|$)/;

export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  options: IndexOptions = {}
): FSWatcher {
  const ignorePatterns = loadIgnorePatterns(vaultPath);

  // chokidar 4 takes no globs: watch the vault and keep only markdown files (a directory must stay unignored to be walked).
  const watcher = chokidar.watch(vaultPath, {
    // The walker's rules, so the watcher never indexes what an index pass would leave out (retired notes under .trash,
    // node_modules), and no symbolic link: the walker never lists one, and a link in the vault must not pull in a file
    // outside it.
    ignored: [
      /\.obsidian/,
      /\.semantic-memory/,
      (p: string) => WALKER_SKIPS.test(path.relative(vaultPath, p)),
      (p: string, stats?: fs.Stats) => !!stats && !stats.isDirectory() && !isMarkdown(p),
    ],
    followSymlinks: false,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  const pending = new Map<string, NodeJS.Timeout>();

  const handle = (filePath: string) => {
    if (!isMarkdown(filePath) || isIgnored(filePath, vaultPath, ignorePatterns)) return;
    // chokidar reports a link to a file as the file, and a FIFO named like a note as a note; the walker lists neither.
    const st = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (st && !st.isFile()) return;
    if (pending.has(filePath)) clearTimeout(pending.get(filePath)!);
    pending.set(filePath, setTimeout(async () => {
      pending.delete(filePath);
      try {
        await indexFile(db, filePath, options);
        log.info('watcher_indexed', { file: path.relative(vaultPath, filePath) });
      } catch (err) {
        log.error('watcher_index_failed', { file: path.relative(vaultPath, filePath) }, err);
      }
    }, 500));
  };

  watcher
    .on('add', handle)
    .on('change', handle)
    .on('unlink', (filePath: string) => {
      if (!isMarkdown(filePath) || isIgnored(filePath, vaultPath, ignorePatterns)) return;
      db.transaction(() => {
        db.prepare('DELETE FROM relations WHERE source_note = ?').run(filePath);
        db.prepare('DELETE FROM notes WHERE path = ?').run(filePath);
      })();
      log.info('watcher_removed', { file: path.relative(vaultPath, filePath) });
    });

  return watcher;
}
