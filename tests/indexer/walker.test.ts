import { describe, it, expect, vi, afterEach } from 'vitest';
import { walkVault, walkVaultStats } from '../../src/indexer/walker';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import { bytes, latin1, rawPath, supportsNonUtf8Names } from '../helpers/nonUtf8Names';

const FIXTURE = path.resolve('fixtures/vault');

describe('walkVault', () => {
  it('finds all markdown files', async () => {
    const files = await walkVault(FIXTURE);
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.every(f => f.endsWith('.md'))).toBe(true);
  });

  it('excludes .obsidian by default', async () => {
    const files = await walkVault(FIXTURE);
    expect(files.some(f => f.includes('.obsidian'))).toBe(false);
  });

  it('respects ignorePatterns option', async () => {
    const files = await walkVault(FIXTURE, { ignorePatterns: ['Daily/'] });
    expect(files.some(f => f.includes('Daily'))).toBe(false);
  });

  it('reads .semanticignore from vault root', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    fs.mkdirSync(path.join(tmp, 'Private'));
    fs.writeFileSync(path.join(tmp, 'Private', 'secret.md'), '# Secret');
    fs.writeFileSync(path.join(tmp, '.semanticignore'), 'Private/\n');
    const files = await walkVault(tmp);
    expect(files.some(f => f.includes('Private'))).toBe(false);
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns absolute paths', async () => {
    const files = await walkVault(FIXTURE);
    expect(files.every(f => path.isAbsolute(f))).toBe(true);
  });
});

// The walk as it was before its ignore test was compiled once per walk and relative paths were built
// as it went: the reference the current walk must agree with, entry for entry.
async function referenceWalk(vaultPath: string, ignorePatterns: string[] = []): Promise<string[]> {
  let patterns = ['.obsidian/', '.trash/', '.semantic-memory/', '.memory-index/', 'node_modules/', ...ignorePatterns];
  try {
    const raw = await fsp.readFile(path.join(vaultPath, '.semanticignore'), 'utf8');
    patterns = [...patterns, ...raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))];
  } catch { /* no .semanticignore */ }
  const results: string[] = [];
  async function walk(dir: string) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Patterns are written with `/`; on Windows path.relative answers with `\`.
      const rel = path.relative(vaultPath, full).split(path.sep).join('/');
      if (patterns.some(p => {
        const clean = p.replace(/\/$/, '');
        return rel === clean || rel.startsWith(clean + '/') || rel.includes('/' + clean + '/') || rel.endsWith('/' + clean);
      })) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) results.push(full);
    }
  }
  await walk(vaultPath);
  return results;
}

const tmpVaults: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpVaults.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function vault(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-'));
  tmpVaults.push(dir);
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `# ${rel}`);
  }
  return dir;
}

describe('walkVault agrees with the reference walk, and walkVaultStats lists the same files', () => {
  it('on a tree with ignored directories at every depth, an ignore file, symlinks and non-markdown files', async () => {
    const dir = vault([
      'Keep/a.md', 'Private/secret.md', 'Keep/Private/nested.md', 'Deep/Private/x/y.md', 'System/ledger.md',
      '.obsidian/cfg.md', 'Keep/node_modules/pkg.md', 'privates/not-ignored.md', 'top.md', 'Keep/readme.txt',
      '.trash/old.md', 'Notes/.memory-index/x.md', 'Notes/b.md',
    ]);
    fs.writeFileSync(path.join(dir, '.semanticignore'), '# comment\nPrivate/\nSystem/\n\n  Notes/b.md  \n');
    fs.symlinkSync(path.join(dir, 'top.md'), path.join(dir, 'link.md'));
    fs.symlinkSync(path.join(dir, 'Keep'), path.join(dir, 'linkdir'));

    // Pinned by hand, so a reference walk that drifts from the rules (as it did on Windows) cannot pass by agreeing.
    const plain = (await walkVault(dir)).map(f => path.relative(dir, f).split(path.sep).join('/')).sort();
    expect(plain).toEqual(['Keep/a.md', 'privates/not-ignored.md', 'top.md']);
    expect((await referenceWalk(dir)).map(f => path.relative(dir, f).split(path.sep).join('/')).sort()).toEqual(plain);

    for (const [label, root] of [
      ['plain', dir],
      ['trailing slash', dir + path.sep],
      ['not normalized', path.join(dir, 'Keep', '..')],
    ] as const) {
      for (const extra of [[], ['Keep/'], ['a.md']]) {
        const expected = (await referenceWalk(root, extra)).sort();
        expect(expected.length, label).toBeGreaterThan(0);
        expect((await walkVault(root, { ignorePatterns: extra })).sort(), `${label} ${extra}`).toEqual(expected);
        expect((await walkVaultStats(root, { ignorePatterns: extra })).map(s => s.file).sort(), `${label} ${extra}`).toEqual(expected);
      }
    }
  });

  it('on seeded random trees and patterns', async () => {
    let seed = 20261003;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const segments = ['a', 'b', 'Private', 'priv', 'node_modules', '.trash', 'x.md', 'y.md', 'Private.md', 'deep', 'System', '.obsidian'];
    for (let trial = 0; trial < 25; trial++) {
      const files = Array.from({ length: 12 }, () => {
        const depth = 1 + Math.floor(rnd() * 3);
        const dirs = Array.from({ length: depth - 1 }, () => pick(segments.filter(s => !s.endsWith('.md'))));
        return [...dirs, pick(['x.md', 'y.md', 'z.md', 'Private.md', 'n.txt'])].join('/');
      });
      const dir = vault([...new Set(files)]);
      const patterns = Array.from({ length: Math.floor(rnd() * 4) }, () => pick(['Private/', 'priv', 'a/', 'x.md', 'deep/b', 'System']));
      fs.writeFileSync(path.join(dir, '.semanticignore'), patterns.join('\n'));
      const expected = (await referenceWalk(dir)).sort();
      expect((await walkVault(dir)).sort(), `trial ${trial} ${patterns}`).toEqual(expected);
      expect((await walkVaultStats(dir)).map(s => s.file).sort(), `trial ${trial}`).toEqual(expected);
    }
  });

  it('walkVaultStats gives each file its own size, times and inode', async () => {
    const dir = vault(['a.md', 'sub/b.md', 'sub/deeper/c.md']);
    fs.appendFileSync(path.join(dir, 'sub/b.md'), ' with more text');
    fs.utimesSync(path.join(dir, 'a.md'), 1_700_000_000, 1_700_000_000);
    fs.utimesSync(path.join(dir, 'sub/b.md'), 1_700_000_100, 1_700_000_100);
    const stats = await walkVaultStats(dir);
    expect(stats).toHaveLength(3);
    for (const { file, mtimeMs, ctimeMs, size, ino } of stats) {
      const real = fs.statSync(file);
      expect({ mtimeMs, ctimeMs, size, ino }).toEqual({ mtimeMs: real.mtimeMs, ctimeMs: real.ctimeMs, size: real.size, ino: real.ino });
    }
    expect(new Set(stats.map(s => s.size)).size).toBeGreaterThan(1);
    expect(new Set(stats.map(s => s.ino)).size).toBe(3);
  });

  it('walkVaultStats shows a rewrite that puts the modification time back, in the change time', async () => {
    const dir = vault(['a.md']);
    const file = path.join(dir, 'a.md');
    const whole = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, whole, whole);
    const [before] = await walkVaultStats(dir);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/./, 'X')); // the same size
    fs.utimesSync(file, whole, whole);
    const [after] = await walkVaultStats(dir);
    expect({ mtimeMs: after.mtimeMs, size: after.size, ino: after.ino }).toEqual({ mtimeMs: before.mtimeMs, size: before.size, ino: before.ino });
    expect(after.ctimeMs).toBeGreaterThan(before.ctimeMs);
  });

  it('walkVaultStats leaves out a file that vanishes between the listing and its stat', async () => {
    const dir = vault(['a.md', 'b.md']);
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((p: any, ...rest: any[]) =>
      String(p).endsWith('b.md') ? undefined : (real as any)(p, ...rest)) as typeof fs.statSync);
    expect((await walkVaultStats(dir)).map(s => path.basename(s.file))).toEqual(['a.md']);
  });

  it('walkVaultStats lists a file it cannot stat with a stamp that never matches, so the failure is reported by whoever reads it', async () => {
    const dir = vault(['a.md', 'b.md']);
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p).endsWith('b.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (real as any)(p, ...rest);
    }) as typeof fs.statSync);
    const stats = await walkVaultStats(dir);
    const b = stats.find(s => s.file.endsWith('b.md'))!;
    expect(stats).toHaveLength(2);
    expect(b.size).toBe(-1);
    expect(b.ino).toBe(-1);
    expect(Number.isNaN(b.mtimeMs)).toBe(true);
    expect(Number.isNaN(b.ctimeMs)).toBe(true);
  });

  it('walkVaultStats handles more files than one chunk, in order, with every stat right', async () => {
    const dir = vault(Array.from({ length: 1300 }, (_, i) => `many/n-${String(i).padStart(4, '0')}.md`));
    const stats = await walkVaultStats(dir);
    expect(stats).toHaveLength(1300);
    expect(stats.map(s => s.file)).toEqual((await walkVault(dir)));
    for (const s of stats.slice(0, 5).concat(stats.slice(-5))) expect(s.size).toBe(fs.statSync(s.file).size);
  });
});

// A name another OS or locale wrote can hold bytes that are not UTF-8 (a Latin-1 "Reunião").
// Node decodes such a name with U+FFFD, so its string form names nothing that exists.
// The tests below skip on a filesystem that cannot store such a name (APFS); on Linux a skip would
// only hide them, so say so loudly.
it.runIf(process.platform === 'linux')('can store a name that is not valid UTF-8, so the tests below are not silently skipped', () => {
  expect(supportsNonUtf8Names).toBe(true);
});

describe.skipIf(!supportsNonUtf8Names)('walkVault with names that are not valid UTF-8', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  function vault(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    dirs.push(dir);
    return dir;
  }
  function put(root: string, segments: Buffer[], text = '# note\n') {
    fs.mkdirSync(rawPath(root, ...segments.slice(0, -1)), { recursive: true });
    fs.writeFileSync(rawPath(root, ...segments), text);
  }
  async function walk(root: string) {
    const reported: string[] = [];
    const files = await walkVault(root, { onNonUtf8Markdown: relPath => reported.push(relPath) });
    return { files, reported: reported.sort() };
  }

  it('reports a Markdown file with such a name instead of returning a path that does not exist', async () => {
    const root = vault();
    put(root, [Buffer.from('good.md')]);
    put(root, [bytes([0xff, 0xfe], 'name.md')]);
    put(root, [latin1('Reunião.md')]);
    const { files, reported } = await walk(root);
    expect(files).toEqual([path.join(root, 'good.md')]);
    // Bad bytes are written \xNN, so the name is unambiguous and printable.
    expect(reported).toEqual([String.raw`Reuni\xe3o.md`, String.raw`\xff\xfename.md`]);
  });

  it('reports each Markdown file below a folder with such a name, and nothing for a folder without any', async () => {
    const root = vault();
    put(root, [Buffer.from('ok.md')]);
    put(root, [latin1('Reunião'), Buffer.from('ata.md')]);
    put(root, [latin1('Reunião'), Buffer.from('sub'), Buffer.from('deep.md')]);
    put(root, [latin1('Reunião'), Buffer.from('notes.txt')], 'not markdown');
    put(root, [latin1('Anexoç'), Buffer.from('logo.png')], 'not markdown');
    put(root, [Buffer.from('Projects'), latin1('Ação'), Buffer.from('plan.md')]);
    const { files, reported } = await walk(root);
    expect(files).toEqual([path.join(root, 'ok.md')]);
    expect(reported).toEqual([
      String.raw`Projects/A\xe7\xe3o/plan.md`,
      String.raw`Reuni\xe3o/ata.md`,
      String.raw`Reuni\xe3o/sub/deep.md`,
    ]);
  });

  it('judges a name by its bytes: a real U+FFFD in a valid name is a valid name', async () => {
    const root = vault();
    put(root, [Buffer.from('broken\u{FFFD}name.md')]);
    put(root, [Buffer.from('Résumé 日本語 😀.md')]);
    const { files, reported } = await walk(root);
    expect(files.map(file => path.basename(file)).sort()).toEqual(['Résumé 日本語 😀.md', 'broken\u{FFFD}name.md'].sort());
    expect(reported).toEqual([]);
  });

  it('keeps applying the ignore rules to such names, so ignored folders report nothing', async () => {
    const root = vault();
    put(root, [Buffer.from('.obsidian'), bytes([0xff], '.md')]);
    put(root, [Buffer.from('Private'), bytes([0xff], '.md')]);
    put(root, [bytes([0xfe], 'Secrets'), Buffer.from('a.md')]);
    put(root, [Buffer.from('kept.md')]);
    fs.writeFileSync(path.join(root, '.semanticignore'), 'Private/\n');
    const { files, reported } = await walk(root);
    expect(files).toEqual([path.join(root, 'kept.md')]);
    expect(reported).toEqual([String.raw`\xfeSecrets/a.md`]);
  });

  it('writes valid multi-byte characters as they are and every byte of a malformed sequence as \\xNN', async () => {
    const root = vault();
    put(root, [bytes('Ação ', [0xff], ' 日本語 😀.md')]); // valid multi-byte characters beside an invalid byte
    put(root, [bytes([0xc0, 0x80], '.md')]); // overlong encoding of NUL
    put(root, [bytes([0xed, 0xa0, 0x80], '.md')]); // a UTF-16 surrogate half
    put(root, [bytes([0xf4, 0x90, 0x80, 0x80], '.md')]); // beyond U+10FFFF
    put(root, [bytes('cut ', [0xe3, 0x81], '.md')]); // a three-byte sequence cut short
    put(root, [bytes('c1 ', [0xc2, 0x85], ' ', [0xff], '.md')]); // U+0085 is a control character: never printed raw
    const { files, reported } = await walk(root);
    expect(files).toEqual([]);
    expect(reported).toEqual([
      String.raw`Ação \xff 日本語 😀.md`,
      String.raw`\xc0\x80.md`,
      String.raw`\xed\xa0\x80.md`,
      String.raw`\xf4\x90\x80\x80.md`,
      String.raw`c1 \xc2\x85 \xff.md`,
      String.raw`cut \xe3\x81.md`,
    ].sort());
  });

  it('writes a backslash or control character in a name so it cannot pass for an escape or break a line', async () => {
    const root = vault();
    put(root, [bytes('back\\xff', [0xff], '.md')]);
    put(root, [bytes('new\nline', [0xff], '.md')]);
    const { files, reported } = await walk(root);
    expect(files).toEqual([]);
    expect(reported).toEqual([String.raw`back\\xff\xff.md`, String.raw`new\x0aline\xff.md`]);
  });
});

describe('walkVault on a runtime whose byte-mode readdir returns bare Buffers (Bun)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('walks files and folders the same as with Dirents', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-walk-'));
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'a.md'), 'a');
    fs.writeFileSync(path.join(root, 'sub', 'b.md'), 'b');
    fs.writeFileSync(path.join(root, 'c.txt'), 'c');
    const real = fsp.readdir.bind(fsp) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(fsp, 'readdir').mockImplementation((async (dir: unknown, opts?: { encoding?: string }) => {
      if (opts?.encoding === 'buffer') return real(dir, { encoding: 'buffer' }); // bare Buffers, no Dirent
      return real(dir, opts);
    }) as never);
    const found: string[] = [];
    const files = await walkVault(root, { onNonUtf8Markdown: l => found.push(l) });
    expect(files.map(f => path.relative(root, f)).sort()).toEqual(['a.md', path.join('sub', 'b.md')]);
    expect(found).toEqual([]);
  });
});

describe('walkVault with onNonUtf8Markdown', () => {
  afterEach(() => vi.restoreAllMocks());

  it('finishes without a file that vanishes between the listing and the stat', async () => {
    const dir = vault(['a.md', 'gone.md', 'b.md']);
    const realReaddir = fsp.readdir.bind(fsp) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(fsp, 'readdir').mockImplementation((async (d: unknown, opts?: { encoding?: string }) => {
      if (opts?.encoding === 'buffer') return realReaddir(d, { encoding: 'buffer' }); // bare Buffers, as Bun returns them
      return realReaddir(d, opts);
    }) as never);
    const real = fsp.lstat.bind(fsp);
    vi.spyOn(fsp, 'lstat').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (Buffer.from(p as Buffer).toString('utf8').endsWith('gone.md')) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    const files = await walkVault(dir, { onNonUtf8Markdown: () => {} });
    expect(files.map(f => path.basename(f)).sort()).toEqual(['a.md', 'b.md']);
  });
});
