import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
// Imported while the file loads, not inside the test that compares them: see 'the tokenizer is loaded on first use'.
import { encode } from 'gpt-tokenizer';
import { encodeTokens } from '../../src/indexer/tokenizer.js';

/**
 * The per-workspace Node compile cache.
 *
 * Two halves, because the property is two-sided:
 *
 *  - CONFIGURATION refuses a cache directory that overlaps the memory, history or auth trees.
 *    Those trees are indexed, exported, or hold client secrets; compiled-code blobs belong in
 *    none of them. A refusal is REQUIRED here rather than a repair: silently relocating a
 *    misconfigured cache is how a shared directory would go unnoticed in the first place.
 *
 *  - ENABLEMENT is best-effort and must never keep the engine from starting. This is a speed
 *    optimisation, so an unwritable directory, a Node without compile-cache support, or
 *    NODE_DISABLE_COMPILE_CACHE=1 must all degrade to "no cache, engine runs".
 */

const BASE_ENV = { ...process.env };

function workspaceRoot(label: string): string {
  // Under the OS temp dir, which is what tmpdir() is for; every path here is synthetic.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `renor-cc-${label}-`));
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'auth'), { recursive: true, mode: 0o700 });
  return root;
}

function baseEnvFor(root: string): NodeJS.ProcessEnv {
  const memoryDir = path.join(root, 'memory');
  const authStatePath = path.join(root, 'auth', 'clients.json');
  return {
    ...BASE_ENV,
    MVP_MEMORY_DIR: memoryDir,
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_PORT: '3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-secret',
    MVP_AUTH_STATE_PATH: authStatePath,
    MVP_ALLOWED_CALLBACK_URIS: '',
    MVP_GATEWAY_SECRET: '',
  };
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in BASE_ENV)) delete process.env[key];
  }
  Object.assign(process.env, BASE_ENV);
});

/**
 * The compile cache is used only when its directory is owned by this user and closed to group and others, judged by POSIX
 * owner and mode bits (compileCache.ts unsafeExistingDir). Native Windows reports every directory as writable by group and
 * others, so there the cache is always declined, fail safe, and the engine starts without it; it serves the HTTP server,
 * which is POSIX-only by design (helpers/httpServerPlatform.ts). The tests that need a cache to be enabled are skipped on
 * win32 for that reason only (#1563); the refusals and the overlap checks run everywhere.
 */
const COMPILE_CACHE_NEEDS_POSIX_MODES = process.platform === 'win32';

describe('MVP_COMPILE_CACHE_DIR', () => {
  let root: string;

  beforeEach(() => {
    root = workspaceRoot('cfg');
  });

  it('has NO derived default: unset means no cache, never a path worked out from memory', async () => {
    // A default derived from MVP_MEMORY_DIR lands in a shared place when the memory directory is
    // (for example) /tmp/x: /tmp/cache/compile. Only the explicit, per-workspace value counts.
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    Object.assign(process.env, baseEnvFor(root));
    delete process.env.MVP_COMPILE_CACHE_DIR;
    delete process.env.MVP_HISTORY_DIR;

    expect(loadMvpConfig().compileCacheDir).toBeNull();
  });

  it('accepts an explicit directory outside every data tree', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    const explicit = path.join(root, 'cache', 'compile');
    Object.assign(process.env, baseEnvFor(root), { MVP_COMPILE_CACHE_DIR: explicit });

    expect(loadMvpConfig().compileCacheDir).toBe(explicit);
  });

  it('refuses a cache directory inside the memory tree', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    Object.assign(process.env, baseEnvFor(root), {
      MVP_COMPILE_CACHE_DIR: path.join(root, 'memory', 'cache'),
    });

    expect(() => loadMvpConfig()).toThrow(/MVP_COMPILE_CACHE_DIR/);
    expect(() => loadMvpConfig()).toThrow(/MVP_MEMORY_DIR/);
  });

  it('refuses a cache directory that CONTAINS the memory tree', async () => {
    // The dangerous direction is both ways: a cache directory that is an ancestor of the memory
    // directory would put the memory tree inside the cache.
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    Object.assign(process.env, baseEnvFor(root), { MVP_COMPILE_CACHE_DIR: root });

    expect(() => loadMvpConfig()).toThrow(/MVP_MEMORY_DIR/);
  });

  it('refuses a cache directory equal to the memory directory itself', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    Object.assign(process.env, baseEnvFor(root), { MVP_COMPILE_CACHE_DIR: path.join(root, 'memory') });

    expect(() => loadMvpConfig()).toThrow(/MVP_MEMORY_DIR/);
  });

  it('refuses a cache directory inside the promoted history tree', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    const historyDir = path.join(root, 'history');
    fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
    Object.assign(process.env, baseEnvFor(root), {
      MVP_HISTORY_DIR: historyDir,
      MVP_COMPILE_CACHE_DIR: path.join(historyDir, 'cache'),
    });

    expect(() => loadMvpConfig()).toThrow(/MVP_HISTORY_DIR/);
  });

  it('refuses a cache directory that contains the client registry', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    Object.assign(process.env, baseEnvFor(root), { MVP_COMPILE_CACHE_DIR: path.join(root, 'auth') });

    expect(() => loadMvpConfig()).toThrow(/MVP_AUTH_STATE_PATH/);
  });

  it('names the directory AND the tree in the refusal, so the fix is readable', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    const bad = path.join(root, 'memory', 'cache');
    Object.assign(process.env, baseEnvFor(root), { MVP_COMPILE_CACHE_DIR: bad });

    let message = '';
    try {
      loadMvpConfig();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(bad);
    expect(message).toMatch(/rebuildable cache/);
  });

  it('a sibling directory of the memory tree is accepted even next to a history tree', async () => {
    // The layout the provisioner writes (state/cache/compile beside state/memory) must be legal.
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    const historyDir = path.join(root, 'history');
    fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
    const explicit = path.join(root, 'cache', 'compile');
    Object.assign(process.env, baseEnvFor(root), {
      MVP_HISTORY_DIR: historyDir,
      MVP_COMPILE_CACHE_DIR: explicit,
    });

    const config = loadMvpConfig();
    expect(config.compileCacheDir).toBe(explicit);
    expect(config.historyDir).toBe(historyDir);
  });
});

/**
 * Enable the cache the way the engine does, in a CHILD process.
 *
 * Node allows exactly ONE compile cache per process: the first enableCompileCache() wins and
 * every later call reports ALREADY_ENABLED with the first directory (verified on Node 22 — a
 * second call naming a different directory returns the FIRST one). So testing this in-process
 * would make the assertions depend on which test ran first, and would let one case silently
 * assert another case's directory. A child process is also what actually happens: every wake is
 * a fresh process.
 */
function enableInChild(env: Record<string, string | undefined>): {
  enabled: boolean;
  directory: string | null;
  reason: string | null;
  seeded: number;
  cacheRootMode: string | null;
} {
  const script = `
    const { enableWorkspaceCompileCache } = require(${JSON.stringify(path.resolve(__dirname, '../../dist/mvp/compileCache.js'))});
    const report = enableWorkspaceCompileCache();
    const fs = require('node:fs');
    const mode = (() => {
      try { return (fs.statSync(process.env.MVP_COMPILE_CACHE_DIR).mode & 0o777).toString(8); }
      catch { return null; }
    })();
    process.stdout.write(JSON.stringify({ ...report, cacheRootMode: mode }));
  `;
  const res = spawnSync(process.execPath, ['-e', script], {
    env: { ...BASE_ENV, ...env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.status !== 0) {
    throw new Error(`child failed (${res.status}): ${(res.stderr || '').slice(0, 500)}`);
  }
  return JSON.parse(res.stdout);
}

describe('enabling the workspace compile cache', () => {
  let root: string;

  beforeEach(() => {
    root = workspaceRoot('enable');
  });

  it.skipIf(COMPILE_CACHE_NEEDS_POSIX_MODES)('enables a cache in this workspace\'s own directory and creates it 0700', () => {
    const dir = path.join(root, 'cache', 'compile');
    const report = enableInChild({
      MVP_MEMORY_DIR: path.join(root, 'memory'),
      MVP_COMPILE_CACHE_DIR: dir,
    });

    expect(report.enabled).toBe(true);
    expect(report.reason).toBeNull();
    // Node scopes entries by Node version under the directory it is given, so what it reports
    // back may be that versioned child. What matters for isolation is that it is inside THIS
    // workspace's directory and nowhere else.
    expect(report.directory === dir || report.directory!.startsWith(dir + path.sep)).toBe(true);
    expect(report.cacheRootMode).toBe('700');
  });

  it('a workspace that never named a directory gets NO cache, and nothing is created beside memory', () => {
    const report = enableInChild({
      MVP_MEMORY_DIR: path.join(root, 'memory'),
      MVP_COMPILE_CACHE_DIR: undefined,
    });

    expect(report.enabled).toBe(false);
    expect(report.reason).toMatch(/MVP_COMPILE_CACHE_DIR is not set/);
    expect(fs.existsSync(path.join(root, 'cache'))).toBe(false);
  });

  it.skipIf(COMPILE_CACHE_NEEDS_POSIX_MODES)('refuses an existing directory that group or others can write', () => {
    // Loading V8 code from a directory another account can write is loading code that account
    // chose. 0777 was accepted before this check existed.
    const dir = path.join(root, 'cache', 'compile');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777);

    const report = enableInChild({ MVP_MEMORY_DIR: path.join(root, 'memory'), MVP_COMPILE_CACHE_DIR: dir });

    expect(report.enabled).toBe(false);
    expect(report.reason).toMatch(/writable by group or others/);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o777);
  });

  it('refuses a cache directory that is a symlink', () => {
    const target = path.join(root, 'elsewhere');
    fs.mkdirSync(target, { mode: 0o700 });
    const link = path.join(root, 'cache-link');
    fs.symlinkSync(target, link);

    const report = enableInChild({ MVP_MEMORY_DIR: path.join(root, 'memory'), MVP_COMPILE_CACHE_DIR: link });

    expect(report.enabled).toBe(false);
    expect(report.reason).toMatch(/symlink/);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it.each([
    ['memory', (r: string) => path.join(r, 'memory', 'ccache')],
    ['history', (r: string) => path.join(r, 'history', 'ccache')],
    ['auth', (r: string) => path.join(r, 'auth')],
  ])('does not create or enable a cache inside the %s tree', (label, pick) => {
    fs.mkdirSync(path.join(root, 'history'), { recursive: true, mode: 0o700 });
    const dir = pick(root);

    const report = enableInChild({
      MVP_MEMORY_DIR: path.join(root, 'memory'),
      MVP_HISTORY_DIR: path.join(root, 'history'),
      MVP_AUTH_STATE_PATH: path.join(root, 'auth', 'clients.json'),
      MVP_COMPILE_CACHE_DIR: dir,
    });

    expect(report.enabled).toBe(false);
    // 'auth' is the directory that CONTAINS the registry, so it exists already: what must hold
    // is that nothing was written into it.
    if (label === 'auth') expect(filesUnder(dir)).toEqual([]);
    else expect(fs.existsSync(dir)).toBe(false);
  });

  it('reports, and does not throw, when the directory cannot be used', () => {
    // A path whose parent is a FILE cannot be created. Startup must continue: this is a speed
    // optimisation and must never be the reason a workspace fails to wake.
    const blocker = path.join(root, 'not-a-dir');
    fs.writeFileSync(blocker, 'this is a file, not a directory');

    const report = enableInChild({
      MVP_MEMORY_DIR: path.join(root, 'memory'),
      MVP_COMPILE_CACHE_DIR: path.join(blocker, 'cache'),
    });

    // Node may still accept the directory name and simply fail to write; what is asserted is
    // that the call returned a report at all, with a reason when it declined.
    if (!report.enabled) expect(report.reason).toBeTruthy();
    expect(report.directory === null || typeof report.directory === 'string').toBe(true);
  });

  it('declines cleanly when nothing is configured at all', () => {
    const report = enableInChild({
      MVP_MEMORY_DIR: undefined,
      MVP_COMPILE_CACHE_DIR: undefined,
    });

    expect(report.enabled).toBe(false);
    expect(report.reason).toMatch(/MVP_COMPILE_CACHE_DIR/);
  });
});

describe('the release seed', () => {
  // Node names the sub-directory of a cache after its version, architecture, V8 flag hash and the owner's uid. The seed is made by
  // the build account, so its uid is not the workspace's: the copy has to match on everything but the uid.
  let root: string;
  let seed: string;
  let versioned: string;

  /** The name Node gives this build's cache sub-directory, found by enabling a throwaway cache. */
  function versionedName(): string {
    const script = `
      const { enableWorkspaceCompileCache } = require(${JSON.stringify(path.resolve(__dirname, '../../dist/mvp/compileCache.js'))});
      enableWorkspaceCompileCache();
      process.stdout.write(require('node:path').basename(require('node:module').getCompileCacheDir()));
    `;
    const res = spawnSync(process.execPath, ['-e', script], {
      env: { ...BASE_ENV, MVP_MEMORY_DIR: path.join(root, 'memory'), MVP_COMPILE_CACHE_DIR: path.join(root, 'probe') } as NodeJS.ProcessEnv,
      encoding: 'utf8', timeout: 30_000,
    });
    if (res.status !== 0) throw new Error(`child failed (${res.status}): ${(res.stderr || '').slice(0, 500)}`);
    return res.stdout;
  }

  const entries = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

  /**
   * What deploy-remote.sh does to a seed before any engine reads it (`chmod -R go-w`), so a fixture's modes do not depend on the
   * umask the suite runs under: under 0002 (a non-root shell with per-user groups) mkdir leaves the seed group-writable, and the
   * engine rightly refuses it. The tests that need an untrusted seed make it so explicitly, after this.
   */
  function sealLikeDeploy(dir: string): void {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) return;
    fs.chmodSync(dir, st.mode & 0o7777 & ~0o022);
    if (st.isDirectory()) for (const name of fs.readdirSync(dir)) sealLikeDeploy(path.join(dir, name));
  }

  beforeEach(() => {
    root = workspaceRoot('seed');
    versioned = versionedName();
    seed = path.join(root, 'seed');
    // The build account's uid (here 0) in place of this one.
    fs.mkdirSync(path.join(seed, versioned.replace(/-\d+$/, '-0')), { recursive: true });
    for (const name of ['0a1b2c3d', 'deadbeef']) fs.writeFileSync(path.join(seed, versioned.replace(/-\d+$/, '-0'), name), `entry ${name}`);
    sealLikeDeploy(seed);
  });

  function enableWithSeed(cacheDir: string, seedDir: string | undefined = seed): { report: ReturnType<typeof enableInChild>; cached: string[] } {
    const report = enableInChild({ MVP_MEMORY_DIR: path.join(root, 'memory'), MVP_COMPILE_CACHE_DIR: cacheDir, MVP_COMPILE_SEED_DIR: seedDir });
    return { report, cached: entries(path.join(cacheDir, versioned)) };
  }

  it.skipIf(COMPILE_CACHE_NEEDS_POSIX_MODES)('copies the release seed into an empty cache of this workspace, whatever uid the seed was made under', () => {
    const { report, cached } = enableWithSeed(path.join(root, 'cache', 'compile'));

    expect(report.enabled).toBe(true);
    expect(report.seeded).toBe(2);
    expect(cached).toEqual(['0a1b2c3d', 'deadbeef']);
    expect(fs.readFileSync(path.join(root, 'cache', 'compile', versioned, 'deadbeef'), 'utf8')).toBe('entry deadbeef');
  });

  it.skipIf(COMPILE_CACHE_NEEDS_POSIX_MODES)('never mixes the seed into a cache that already holds entries of its own', () => {
    const cacheDir = path.join(root, 'cache', 'compile');
    fs.mkdirSync(path.join(cacheDir, versioned), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cacheDir, versioned, '11111111'), 'own entry');

    const { report, cached } = enableWithSeed(cacheDir);

    expect(report.seeded).toBe(0);
    expect(cached).toEqual(['11111111']);
  });

  it.skipIf(COMPILE_CACHE_NEEDS_POSIX_MODES)('does not read a seed directory that group or others can write', () => {
    fs.chmodSync(seed, 0o775);
    const { report, cached } = enableWithSeed(path.join(root, 'cache', 'compile'));

    expect(report.enabled).toBe(true);
    expect(report.seeded).toBe(0);
    expect(cached).toEqual([]);
  });

  it.skipIf(COMPILE_CACHE_NEEDS_POSIX_MODES)('does not read a seed sub-directory writable by others, or one made by a different Node or V8 build', () => {
    const sub = path.join(seed, versioned.replace(/-\d+$/, '-0'));
    fs.chmodSync(sub, 0o777);
    expect(enableWithSeed(path.join(root, 'cache', 'a')).report.seeded).toBe(0);
    fs.chmodSync(sub, 0o755);
    fs.renameSync(sub, path.join(seed, versioned.replace(/-[0-9a-f]+-\d+$/, '-00000000-0')));
    expect(enableWithSeed(path.join(root, 'cache', 'b')).report.seeded).toBe(0);
  });

  it.skipIf(COMPILE_CACHE_NEEDS_POSIX_MODES)('copies regular entries with hex names only: a symlink, a directory or another name is left', () => {
    const sub = path.join(seed, versioned.replace(/-\d+$/, '-0'));
    fs.symlinkSync('/etc/hostname', path.join(sub, 'cafebabe'));
    fs.mkdirSync(path.join(sub, 'abcdef01'));
    fs.writeFileSync(path.join(sub, 'evil.js'), 'x');
    fs.writeFileSync(path.join(sub, 'ABCDEF02'), 'x');

    const { report, cached } = enableWithSeed(path.join(root, 'cache', 'compile'));

    expect(report.seeded).toBe(2);
    expect(cached).toEqual(['0a1b2c3d', 'deadbeef']);
  });

  it.skipIf(COMPILE_CACHE_NEEDS_POSIX_MODES)('starts as it always did when there is no seed, or the seed path is not a directory', () => {
    expect(enableWithSeed(path.join(root, 'cache', 'a'), path.join(root, 'no-such-seed')).report.seeded).toBe(0);
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, 'x');
    const none = enableWithSeed(path.join(root, 'cache', 'b'), file);
    expect(none.report.enabled).toBe(true);
    expect(none.report.seeded).toBe(0);
  });

  it.skipIf(COMPILE_CACHE_NEEDS_POSIX_MODES)('a seed made by compileSeed.js is used by the next start: the first start of a release finds the modules cached', () => {
    // The real thing, end to end: the seeding script fills a cache, and an engine start copies it. The copied entries are Node's own
    // (not stand-ins), so this is what a deploy followed by a first wake does.
    const seeded = path.join(root, 'real-seed');
    const make = spawnSync(process.execPath, [path.resolve(__dirname, '../../dist/mvp/compileSeed.js')], {
      env: { ...BASE_ENV, MVP_COMPILE_CACHE_DIR: seeded } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 120_000,
    });
    expect(make.status).toBe(0);
    expect(entries(path.join(seeded, versioned.replace(/-\d+$/, `-${process.getuid!()}`))).length).toBeGreaterThan(50);
    sealLikeDeploy(seeded);

    const { report, cached } = enableWithSeed(path.join(root, 'cache', 'compile'), seeded);

    expect(report.seeded).toBeGreaterThan(50);
    expect(cached.length).toBe(report.seeded);
  });
});

/**
 * The real entry point, spawned. Node writes its cache entries when the process exits, and a
 * refused start exits too, so the only honest proof that a refusal leaves nothing behind is to
 * run `dist/mvp/cli.js`, let it refuse, and count what is in the data tree afterwards.
 */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' });
}

function runCli(env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const res = spawnSync(process.execPath, [path.resolve(__dirname, '../../dist/mvp/cli.js')], {
    env: { ...env, MVP_EMBEDDING_PROVIDER: 'none', NODE_DISABLE_COMPILE_CACHE: undefined } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stderr: res.stderr ?? '' };
}

describe('a start refused for an overlapping cache directory', () => {
  it.each([
    ['memory', (r: string) => path.join(r, 'memory', 'ccache'), /MVP_MEMORY_DIR/],
    ['auth', (r: string) => path.join(r, 'auth'), /MVP_AUTH_STATE_PATH/],
  ])('refuses and writes no file into the %s tree', (label, pick, message) => {
    const root = workspaceRoot('cli');
    const dir = pick(root);

    const res = runCli({ ...baseEnvFor(root), MVP_COMPILE_CACHE_DIR: dir });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(message);
    expect(filesUnder(path.join(root, 'memory'))).toEqual([]);
    expect(filesUnder(path.join(root, 'auth'))).toEqual([]);
    // The auth case names the directory holding the registry, which exists already.
    if (label !== 'auth') expect(fs.existsSync(dir)).toBe(false);
  });

  it.skipIf(COMPILE_CACHE_NEEDS_POSIX_MODES)('control: the same start with a disjoint cache directory does fill it', async () => {
    // Without this the two tests above would pass on a CLI that never writes a cache at all.
    const root = workspaceRoot('cli-ctl');
    const dir = path.join(root, 'cache', 'compile');
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    try {
      const { port } = blocker.address() as net.AddressInfo;
      const env = {
        ...baseEnvFor(root), MVP_COMPILE_CACHE_DIR: dir,
        MVP_PORT: String(port), MVP_BASE_URL: `http://127.0.0.1:${port}`,
      };
      // Keeping the port occupied makes startup fail after cache enablement, even as root.
      // The failed process still exits and flushes its cache entries.
      const res = runCli(env);

      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/EADDRINUSE/);
      expect(filesUnder(dir).length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close(err => err ? reject(err) : resolve());
      });
    }
  });
});

describe('the tokenizer is loaded on first use', () => {
  // Both vocabularies are built while the file is collected, where vitest applies no per-test timeout: gpt-tokenizer's by the
  // import at the top of the file, the counter's by this first count. Importing gpt-tokenizer parses its 8 MB o200k_base ranks
  // module and builds a 200,000-entry Map, and the counter builds its tables on its first count; on a loaded 4-vCPU box that
  // took from under a second to over 14 s, and inside the comparison test it ran under the default 5 s timeout, which bounds
  // no product behaviour. That the counter builds on the first count and not at
  // import is asserted by the next test, in a fresh child; the comparison test asserts the counts.
  encodeTokens('warm');

  it('does not build the token vocabulary at import time, builds it on the first count, and never loads gpt-tokenizer', async () => {
    // The measurement this protects: the o200k_base table cost ~205 ms of a cold start (and ~45 MiB of resident memory for
    // ever after) when it was gpt-tokenizer's Map, and nothing before the engine is Listening counts a token. The counter
    // that replaced it (src/indexer/o200k.ts) keeps the vocabulary in ~4 MiB of typed arrays and builds them on the first
    // count; gpt-tokenizer is only the test oracle, so it must not be in a running engine's module graph at all.
    //
    // Run in a child process against require.cache, because the property is about what a FRESH
    // module graph contains: this test file has already loaded plenty, and an in-process check
    // could only ever observe this process's cache, not whether importing the module loads the
    // tokenizer.
    const script = `
      const gpt = () => Object.keys(require.cache).filter((k) => k.includes('gpt-tokenizer')).length;
      const packed = () => Object.keys(require.cache).filter((k) => k.endsWith('o200k.json')).length;
      const before = { gpt: gpt(), packed: packed() };
      const mod = require(${JSON.stringify(path.resolve(__dirname, '../../dist/indexer/tokenizer.js'))});
      const afterImport = { gpt: gpt(), packed: packed(), reported: mod.tokenizerLoaded() };
      const count = mod.encodeTokens('a short note about cold starts');
      process.stdout.write(JSON.stringify({
        before, afterImport, afterFirstCount: { gpt: gpt(), packed: packed(), reported: mod.tokenizerLoaded() }, count,
      }));
    `;
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
    if (res.status !== 0) throw new Error(`child failed (${res.status}): ${(res.stderr || '').slice(0, 500)}`);
    const out = JSON.parse(res.stdout) as {
      before: { gpt: number; packed: number };
      afterImport: { gpt: number; packed: number; reported: boolean };
      afterFirstCount: { gpt: number; packed: number; reported: boolean };
      count: number;
    };

    // Nothing loaded it before this test, so a non-zero here would be leakage from elsewhere.
    expect(out.before).toEqual({ gpt: 0, packed: 0 });
    expect(out.afterImport).toEqual({ gpt: 0, packed: 0, reported: false });

    // The work is DEFERRED, not skipped: the first count builds the vocabulary and returns a real count. The packed file
    // is read once and not kept in the module cache (its 1.4 MB string would stay resident for the life of the process).
    expect(out.afterFirstCount).toEqual({ gpt: 0, packed: 0, reported: true });
    expect(out.count).toBeGreaterThan(0);
  });

  it('counts tokens identically to gpt-tokenizer called directly', () => {
    for (const sample of [
      'hello world',
      'A note with <|im_start|> special-token syntax inside it, which must count as plain text.',
      'unicode: ação, 日本語, emoji \u{1f9e0}, and a very long '.repeat(50),
      '',
    ]) {
      expect(encodeTokens(sample)).toBe(encode(sample, { disallowedSpecial: new Set() }).length);
    }
  });
});
