import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import config from '../vitest.config';

const engineDir = path.resolve(__dirname, '..');

// Loading globalSetup pulls in the whole `typescript` package; on a loaded gate machine the first
// load can pass the 5 s default test timeout (#1464, "STACK_TRACE_ERROR" on run 1, pass on rerun).
// Warm the module once with a generous hook timeout and give each wiring test explicit headroom.
const SETUP_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  await import('./globalSetup.js');
}, SETUP_TIMEOUT_MS);

describe('globalSetup wiring', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('vitest.config.ts registers a globalSetup file that exists', () => {
    const entries = [config.test?.globalSetup ?? []].flat();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(fs.existsSync(path.resolve(engineDir, entry))).toBe(true);
    expect(entries.map((e) => path.basename(e))).toContain('globalSetup.ts');
  });

  async function loadWith(status: number) {
    const spawnSync = vi.fn(() => ({ status, stdout: 'out', stderr: 'diagnostic', error: undefined }));
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawnSync, default: { spawnSync } }));
    const mod = await import('./globalSetup.js');
    return { setup: mod.default as unknown as () => void, spawnSync };
  }

  it('compiles with tsc -b tsconfig.json and passes on exit 0', async () => {
    const { setup, spawnSync } = await loadWith(0);
    expect(() => setup()).not.toThrow();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnSync.mock.calls[0] as unknown as [string, string[], { timeout: number; maxBuffer: number }];
    expect(args[0]).toMatch(/typescript[\\/]bin[\\/]tsc$/);
    // Build mode is what makes the repeated invocations cheap: it returns without a compile when
    // the buildinfo matches the tree, where `-p` re-checks every file every time. The suite still
    // compiles the tree itself (the buildinfo is written only by a successful build), so a tree
    // that cannot compile fails here rather than being tested against a stale `dist/`.
    expect(args.slice(1)).toEqual(['-b', path.join(engineDir, 'tsconfig.json')]);
    expect(opts.timeout).toBeGreaterThanOrEqual(120_000);
    expect(opts.maxBuffer).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  }, SETUP_TIMEOUT_MS);

  it('throws, with the compiler output, on a non-zero exit', async () => {
    const { setup } = await loadWith(2);
    expect(() => setup()).toThrow(/exit 2[\s\S]*diagnostic/);
  }, SETUP_TIMEOUT_MS);
});

describe('pruneOrphanOutputs', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('removes outputs whose source is gone and keeps current ones', async () => {
    const { pruneOrphanOutputs } = await import('./globalSetup.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    dirs.push(root);
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' }, include: ['src/**/*'] }),
    );
    fs.mkdirSync(path.join(root, 'src/sub'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist/sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/live.ts'), '');
    fs.writeFileSync(path.join(root, 'src/sub/deep.ts'), '');
    const keep: string[] = ['live.js', 'live.d.ts', 'live.js.map', 'live.d.ts.map', 'sub/deep.js', 'data.json'];
    const drop: string[] = ['gone.js', 'gone.d.ts', 'gone.js.map', 'gone.d.ts.map', 'sub/old.js'];
    for (const f of [...keep, ...drop]) fs.writeFileSync(path.join(root, 'dist', f), '');
    // outside outDir: never touched
    fs.writeFileSync(path.join(root, 'stray.js'), '');

    const removed = pruneOrphanOutputs(path.join(root, 'tsconfig.json'));

    expect(removed.map((f: string) => path.relative(path.join(root, 'dist'), f)).sort()).toEqual([...drop].sort());
    for (const f of keep) expect(fs.existsSync(path.join(root, 'dist', f))).toBe(true);
    for (const f of drop) expect(fs.existsSync(path.join(root, 'dist', f))).toBe(false);
    expect(fs.existsSync(path.join(root, 'stray.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(true);
  });

  it('is a no-op when outDir does not exist', async () => {
    const { pruneOrphanOutputs } = await import('./globalSetup.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }));
    expect(pruneOrphanOutputs(path.join(root, 'tsconfig.json'))).toEqual([]);
  });
});

describe('missingOutputs', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /**
   * `tsc -b` decides from the buildinfo alone and would report "up to date" after `rm -rf dist`,
   * emitting nothing; the suite would then test against a directory that is not there. This is
   * the check that puts a full rebuild back in that case (#357: a compile the suite did not
   * really do is not a verdict), without costing anything while the outputs are present.
   */
  it('names a deleted output and clears once it is emitted; absent dist is all missing', async () => {
    const { missingOutputs } = await import('./globalSetup.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-'));
    dirs.push(root);
    const config = path.join(root, 'tsconfig.json');
    fs.writeFileSync(config, JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' }, include: ['src/**/*'] }));
    fs.mkdirSync(path.join(root, 'src/sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'src/sub/b.ts'), 'export const b = 2;\n');
    // A `.cts` emits `.cjs` (not `.js`), and a declaration input (here `.d.cts`, as
    // `src/memory/hiveNameHeader.d.cts` on main) emits nothing at all and must never be listed:
    // listing it would force a full rebuild on every run, which is what #532 measured in a gate.
    fs.writeFileSync(path.join(root, 'src/thing.cts'), 'export const t = 3;\n');
    fs.writeFileSync(path.join(root, 'src/types.d.cts'), 'export declare const d: number;\n');
    const rel = (files: string[]) => files.map((f) => path.relative(path.join(root, 'dist'), f)).sort();

    expect(rel(missingOutputs(config))).toEqual(['a.js', 'sub/b.js', 'thing.cjs']);

    fs.mkdirSync(path.join(root, 'dist/sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/a.js'), '');
    fs.writeFileSync(path.join(root, 'dist/sub/b.js'), '');
    fs.writeFileSync(path.join(root, 'dist/thing.cjs'), '');
    expect(missingOutputs(config)).toEqual([]);

    fs.rmSync(path.join(root, 'dist/sub/b.js'));
    expect(rel(missingOutputs(config))).toEqual(['sub/b.js']);
  });
});
