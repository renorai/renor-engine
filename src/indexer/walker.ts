import fs from 'fs/promises';
import fsSync from 'fs';
import { isUtf8 } from 'buffer';
import path from 'path';

const DEFAULT_IGNORE = ['.obsidian/', '.trash/', '.semantic-memory/', '.memory-index/', 'node_modules/'];

interface WalkOptions {
  ignorePatterns?: string[];
  /**
   * Opt in to being told about Markdown files that have no usable path. A name another OS or
   * locale wrote can hold bytes that are not UTF-8; Node decodes those as U+FFFD, so the path it
   * yields names nothing that exists and the first read of it fails with an unrelated ENOENT.
   * With this set such files are not returned: each is reported here by its path below the
   * vault, bad bytes written `\xNN`, including every Markdown file below a folder whose own name
   * is not valid UTF-8. Without it the walk is exactly what it was.
   */
  onNonUtf8Markdown?: (relPath: string) => void;
}

/**
 * The vault's ignore test, built once per walk instead of rebuilt for every entry: a relative path is
 * ignored when a pattern names it, a directory above it, a directory anywhere inside it, or its last segment.
 * Patterns are written with `/`, so a path that Windows spells with `\` is turned into `/` first; without that a
 * nested `node_modules/` was not ignored on Windows.
 */
function compileIgnore(patterns: string[]): (rel: string) => boolean {
  const rules = patterns.map(p => {
    const clean = p.replace(/\/$/, '');
    return { clean, dir: clean + '/', inside: '/' + clean + '/', tail: '/' + clean };
  });
  return rel => {
    if (path.sep !== '/') rel = rel.split(path.sep).join('/');
    return rules.some(r => rel === r.clean || rel.startsWith(r.dir) || rel.includes(r.inside) || rel.endsWith(r.tail));
  };
}

/** The default ignore patterns, then `extra`, then the lines of the vault's .semanticignore (blank and `#` lines skipped). */
async function vaultIgnorePatterns(vaultPath: string, extra: string[] = []): Promise<string[]> {
  const patterns = [...DEFAULT_IGNORE, ...extra];
  try {
    const raw = await fs.readFile(path.join(vaultPath, '.semanticignore'), 'utf8');
    patterns.push(...raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  } catch { /* no .semanticignore */ }
  return patterns;
}

/**
 * `readdir(folder, { withFileTypes: true, encoding: 'buffer' })`. Node returns Dirents whose name is a Buffer; Bun returns
 * the bare Buffers instead, with no type. Those are wrapped as Dirents typed by `lstat` (as a Dirent is: a link is not
 * followed), so the walk reads the same on both runtimes. Node's answer is returned untouched.
 */
async function readDirentsAsBytes(folder: string | Buffer): Promise<Array<fsSync.Dirent<Buffer>>> {
  const entries = await fs.readdir(folder, { withFileTypes: true, encoding: 'buffer' }) as unknown as Array<fsSync.Dirent<Buffer> | Buffer>;
  if (!entries.some(e => Buffer.isBuffer(e))) return entries as Array<fsSync.Dirent<Buffer>>;
  const base = Buffer.isBuffer(folder) ? folder : Buffer.from(folder);
  const resolved = await Promise.all(entries.map(async e => {
    if (!Buffer.isBuffer(e)) return e;
    let st: fsSync.Stats;
    try {
      st = await fs.lstat(Buffer.concat([base, Buffer.from(path.sep), e]) as unknown as string);
    } catch (err) {
      // Gone between the listing and the stat: a Dirent would have listed it, the walk just skips it.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return {
      name: e, parentPath: '', path: '',
      isFile: () => st.isFile(), isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink(),
      isBlockDevice: () => st.isBlockDevice(), isCharacterDevice: () => st.isCharacterDevice(),
      isFIFO: () => st.isFIFO(), isSocket: () => st.isSocket(),
    } as fsSync.Dirent<Buffer>;
  }));
  return resolved.filter((e): e is fsSync.Dirent<Buffer> => e !== null);
}

export async function walkVault(vaultPath: string, options: WalkOptions = {}): Promise<string[]> {
  const ignored = compileIgnore(await vaultIgnorePatterns(vaultPath, options.ignorePatterns));

  const results: string[] = [];

  /**
   * `relDir` is the folder's path below the vault. `raw` is the folder as bytes and `shown` its path below the
   * vault as a message writes it; both are set once a name on the way down is not valid UTF-8, because `dir`
   * then names nothing real.
   */
  async function walk(dir: string, relDir: string, raw?: Buffer, shown?: string) {
    // Names are read as bytes only to report the ones that are not UTF-8; otherwise as strings, which Node decodes
    // the same way. Every save walks the vault, so this and the join below are paid per file per save.
    const entries: Array<fsSync.Dirent<string> | fsSync.Dirent<Buffer>> = options.onNonUtf8Markdown
      ? await readDirentsAsBytes(raw ?? dir)
      : await fs.readdir(dir, { withFileTypes: true });
    // `path.join(dir, name)` for a name read from a folder (one segment, never `.` or `..`): the folder as join
    // writes it, joined once per folder rather than once per entry.
    const folder = path.join(dir, 'x').slice(0, -1);
    for (const entry of entries) {
      const bytes = typeof entry.name === 'string' ? null : entry.name;
      const name = bytes ? bytes.toString('utf8') : entry.name as string;
      const full = folder + name;
      const rel = relDir ? relDir + path.sep + name : name;
      if (ignored(rel)) continue;
      if (options.onNonUtf8Markdown && bytes && (raw || !isUtf8(bytes))) {
        const prefix = shown ?? relDir.split(path.sep).filter(Boolean).map(showName).join('/');
        const label = prefix ? `${prefix}/${showName(bytes)}` : showName(bytes);
        if (entry.isDirectory()) await walk(full, rel, Buffer.concat([raw ?? Buffer.from(dir), Buffer.from(path.sep), bytes]), label);
        else if (entry.isFile() && name.endsWith('.md')) options.onNonUtf8Markdown(label);
        continue;
      }
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile() && name.endsWith('.md')) results.push(full);
    }
  }

  await walk(vaultPath, '');
  return results;
}

/**
 * A name as a message writes it: valid UTF-8 as it is, every other byte as `\xNN`, and a
 * backslash or control character the same way (the backslash doubled), so the result is
 * unambiguous, one line, and cannot carry a terminal escape sequence.
 */
function showName(name: Buffer | string): string {
  const bytes = typeof name === 'string' ? Buffer.from(name) : name;
  let shown = '';
  for (let i = 0; i < bytes.length;) {
    const lead = bytes[i];
    const length = lead < 0xc2 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf5 ? 4 : 0;
    const isC1Control = lead === 0xc2 && bytes[i + 1] < 0xa0; // U+0080-U+009F
    if (lead >= 0x80 && length > 0 && i + length <= bytes.length && isUtf8(bytes.subarray(i, i + length)) && !isC1Control) {
      shown += bytes.toString('utf8', i, i + length);
      i += length;
      continue;
    }
    if (lead === 0x5c) shown += '\\\\';
    else if (lead >= 0x80 || lead < 0x20 || lead === 0x7f) shown += `\\x${lead.toString(16).padStart(2, '0')}`;
    else shown += String.fromCharCode(lead);
    i += 1;
  }
  return shown;
}

/**
 * What a file's stat says about whether it changed: when it was last written (`mtimeMs`), when its inode last
 * changed (`ctimeMs`, which a program cannot set, so it moves when a file is rewritten and its modification time
 * put back), its size, and which inode the path names (a file replaced by a rename gets another).
 */
export interface VaultFileStat {
  file: string;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}

const STAT_CHUNK = 512;

/**
 * The files walkVault lists, each with the stat fields above, for a caller that wants to know what changed
 * without reading anything. Stats are synchronous (a few microseconds each, against tens for an asynchronous
 * call that fans out over the thread pool) in chunks, with a turn of the event loop between them. A file that
 * vanishes between the listing and its stat is left out; one whose stat fails for another reason is listed with
 * a stamp that never matches, so whoever reads it reports the error as a full pass would.
 */
export async function walkVaultStats(vaultPath: string, options: WalkOptions = {}): Promise<VaultFileStat[]> {
  const files = await walkVault(vaultPath, options);
  const stats: VaultFileStat[] = [];
  for (let i = 0; i < files.length; i += STAT_CHUNK) {
    for (const file of files.slice(i, i + STAT_CHUNK)) {
      const s = statVaultFile(file);
      if (s) stats.push(s);
    }
    if (i + STAT_CHUNK < files.length) await new Promise<void>(resolve => setImmediate(resolve));
  }
  return stats;
}

/** One file's stat (see walkVaultStats): undefined when it is gone, a stamp that never matches when its stat fails. */
function statVaultFile(file: string): VaultFileStat | undefined {
  try {
    const s = fsSync.statSync(file, { throwIfNoEntry: false });
    return s ? { file, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size, ino: s.ino } : undefined;
  } catch {
    return { file, mtimeMs: NaN, ctimeMs: NaN, size: -1, ino: -1 };
  }
}

/**
 * The stat of each of the listed files that is there, for a caller that names the files it wants to check (a save's)
 * instead of walking the vault. A file that is gone is left out, as walkVaultStats leaves it out.
 */
export function statVaultFiles(files: string[]): VaultFileStat[] {
  const stats: VaultFileStat[] = [];
  for (const file of files) {
    const s = statVaultFile(file);
    if (s) stats.push(s);
  }
  return stats;
}

/**
 * The vault's ignore rules as walkVault applies them, for a caller that names files instead of listing them: true when the
 * walk would never reach the file, which it prunes at an ignored folder as well as skipping an ignored file. Reads
 * .semanticignore once, when asked.
 */
export async function vaultIgnores(vaultPath: string): Promise<(file: string) => boolean> {
  const ignored = compileIgnore(await vaultIgnorePatterns(vaultPath));
  return (file) => {
    const parts = path.relative(vaultPath, file).split(path.sep);
    return parts.some((_, i) => ignored(parts.slice(0, i + 1).join(path.sep)));
  };
}

/**
 * Whether the vault's own ignore rules (the defaults and .semanticignore) leave out a vault-relative path. The tools that
 * address a note by id (read_memory, retire_memory) ask it, so a file the owner excluded from memory cannot be read or
 * moved through its path any more than it can be found by search.
 */
export async function isIgnoredByVault(vaultPath: string, rel: string): Promise<boolean> {
  return compileIgnore(await vaultIgnorePatterns(vaultPath))(rel.split('/').join(path.sep));
}
