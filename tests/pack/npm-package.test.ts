import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * `npx -y renor-engine mcp` is the one line a directory listing or a README gives a stranger. These tests pack the engine
 * the way it is published (scripts/npm/pack.mjs: one bundled dist/cli.js), read the file list, unpack the tarball somewhere
 * that is not this repository and run the server from it, as the package's own `bin`, with an empty home directory and no
 * setting: it must remember a fact and recall it. Beside it sit ONLY the package's declared dependencies (this checkout's
 * copies), so a module the bundle forgot fails here rather than for a stranger. A registry install is the one thing a unit
 * test cannot do offline; the publish runbook repeats the whole thing against the registry.
 */

const ENGINE = path.resolve(__dirname, '../..');
const BUDGET = 240_000;
const PATIENTLY = { timeout: 180_000 };

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let work = '';
let unpacked = '';
let packed: { name: string; version: string; files: Array<{ path: string }> };
let manifest: { name: string; version: string; bin: Record<string, string>; private?: boolean; license: string; dependencies: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };

beforeAll(() => {
  work = scratch('renor-pack-');
  const destination = path.join(work, 'tarball');
  fs.mkdirSync(destination);
  // The script does not rebuild: it bundles the dist the suite just compiled.
  const pack = spawnSync(process.execPath, ['scripts/npm/pack.mjs', '--out', destination], {
    cwd: ENGINE, encoding: 'utf8', timeout: 120_000,
  });
  expect(pack.status, pack.stderr).toBe(0);
  const tarball = fs.readdirSync(destination).find(file => file.endsWith('.tgz'))!;
  const list = spawnSync('tar', ['-tzf', path.join(destination, tarball)], { encoding: 'utf8' });
  expect(list.status, list.stderr).toBe(0);
  const extract = path.join(work, 'extract');
  fs.mkdirSync(extract);
  const untar = spawnSync('tar', ['-xzf', path.join(destination, tarball), '-C', extract], { encoding: 'utf8' });
  expect(untar.status, untar.stderr).toBe(0);
  unpacked = path.join(extract, 'package');
  manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
  packed = { name: manifest.name, version: manifest.version, files: list.stdout.trim().split('\n').map(file => ({ path: file.replace(/^package\//, '') })) };
  // What `npm install` leaves next to the package: its declared dependencies and nothing else, here this checkout's copies
  // (their own dependencies resolve from where the links point).
  fs.mkdirSync(path.join(extract, 'node_modules'));
  for (const name of Object.keys(manifest.dependencies)) {
    fs.symlinkSync(path.join(ENGINE, 'node_modules', name), path.join(extract, 'node_modules', name));
  }
}, BUDGET);

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
});

describe('the npm package', () => {
  it('is renor-engine, Apache-2.0, with one bin named like the package that points at the built CLI', () => {
    expect(packed.name).toBe('renor-engine');
    expect(manifest.license).toBe('Apache-2.0');
    // `renor` is the setup CLI on npm; a second package claiming that command would collide on a global install.
    expect(manifest.bin).toEqual({ 'renor-engine': 'bin/renor-engine.cjs' });
    expect(fs.readFileSync(path.join(unpacked, manifest.bin['renor-engine']), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('is at or past the version NOTICE and the public README name as the first Apache-2.0 release', () => {
    // NOTICE says "<v> and later are Apache-2.0"; a packed version below <v> would ship Apache metadata on an AGPL-era number.
    const boundary = (text: string) => /(\d+\.\d+\.\d+) and later are\s+Apache-2\.0/.exec(text.replace(/\s+/g, ' '))?.[1];
    const notice = boundary(fs.readFileSync(path.join(unpacked, 'NOTICE'), 'utf8'));
    expect(notice).toBeDefined();
    // The private tree packs README.public.md; the public export renames it README.md (oss/public-files.txt).
    const readme = ['README.public.md', 'README.md'].map(name => path.join(unpacked, name)).find(file => fs.existsSync(file))!;
    expect(boundary(fs.readFileSync(readme, 'utf8'))).toBe(notice);
    const parts = (v: string) => v.split('-')[0].split('.').map(Number);
    const [have, need] = [parts(manifest.version), parts(notice!)];
    const cmp = have[0] - need[0] || have[1] - need[1] || have[2] - need[2];
    expect(cmp, `package ${manifest.version} is below NOTICE's Apache-2.0 boundary ${notice}`).toBeGreaterThanOrEqual(0);
  });

  it('packs the bundle, its data, the legal files and nothing else', () => {
    const files = packed.files.map(file => file.path).sort();
    expect(files).toEqual(['LICENSE', 'NOTICE', 'README.md', 'THIRD-PARTY-NOTICES', 'bin/renor-engine.cjs', 'dist/BUILD.json', 'dist/cli.js', 'dist/o200k.json', 'package.json']);
  });

  it('carries no private path or key-shaped text', () => {
    const problems: string[] = [];
    // An absolute home directory of anyone but the reviewed placeholder users, or a key-shaped string.
    const privateText = /(?<![\w.\/-])\/(?:home|Users)\/(?!(?:example|test|user|ana|you|yourname)\b)[A-Za-z]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bgh[opusr]_[A-Za-z0-9]{20,}/;
    for (const file of walk(unpacked)) {
      const bytes = fs.readFileSync(file);
      if (bytes.includes(0)) continue;
      if (privateText.test(bytes.toString('utf8'))) problems.push(path.relative(unpacked, file));
    }
    expect(problems).toEqual([]);
  });

  it('depends on the native modules alone; everything else is bundled or an optional peer', () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['sqlite-vec']);
    const optionalPeers = Object.keys(manifest.peerDependencies ?? {}).filter(name => manifest.peerDependenciesMeta?.[name]?.optional);
    expect(optionalPeers.sort()).toEqual(['@posthog/mcp', '@xenova/transformers', 'posthog-node']);
    // Every bare module the bundle still loads must be declared or built in. The rest are probes the bundled packages make
    // inside a try (chokidar's fsevents on macOS, debug's supports-color, js-yaml's esprima) and ajv's and ajv-formats' generated-code
    // strings, which are text, not loads.
    const declared = new Set([...Object.keys(manifest.dependencies), ...optionalPeers, 'fsevents', 'supports-color', 'esprima', 'ajv', 'ajv-formats']);
    const builtins = new Set(builtinModules);
    const missing = new Set<string>();
    const importRe = /(?:require|import)\(\s*["']([^."'\/][^"']*)["']\s*\)/g;
    for (const match of fs.readFileSync(path.join(unpacked, 'dist', 'cli.js'), 'utf8').matchAll(importRe)) {
      const spec = match[1];
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!(name.startsWith('node:') || builtins.has(name) || declared.has(name))) missing.add(name);
    }
    expect([...missing].sort()).toEqual([]);
  });
});

describe('the optional local embedding model', () => {
  it('is left out of the install, and asking for it says what to add', () => {
    expect(manifest.dependencies['@xenova/transformers'], 'hundreds of megabytes would slow the first npx start past a client\'s connect timeout').toBeUndefined();
    // The unpacked package has only its declared dependencies beside it, as in an install without the peer: indexing one
    // note with the local model must fail on that note and name the package to add.
    const home = scratch('renor-pack-local-');
    const vault = path.join(home, 'notes');
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(vault, 'a.md'), '# A\n\nhello\n');
    try {
      const run = spawnSync(process.execPath, [path.join(unpacked, manifest.bin['renor-engine']), 'index'], {
        cwd: home, encoding: 'utf8', timeout: 60_000,
        env: { HOME: home, USERPROFILE: home, VAULT_PATH: vault, EMBEDDING_PROVIDER: 'local' },
      });
      expect(run.stdout + run.stderr).toMatch(/EMBEDDING_PROVIDER=local needs the optional package @xenova\/transformers/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('npx renor-engine mcp, from the unpacked tarball', () => {
  /** The package's bin, run as `npx` runs it: from a folder that is not the repository, with only a home directory. */
  async function session(env: Record<string, string>, home: string) {
    const bin = path.join(unpacked, manifest.bin['renor-engine']);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, 'mcp'],
      cwd: home,
      // Sharing is not what this tests (tests/mcp/stdio-sharing.test.ts does): no notice, no learning log, no request.
      env: { HOME: home, USERPROFILE: home, RENOR_SHARING: 'off', ...env },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'renor-engine-pack-test', version: '1.0.0' });
    await client.connect(transport, PATIENTLY);
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }, undefined, PATIENTLY) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return JSON.parse(result.content.find(item => item.type === 'text')!.text!);
    };
    return { client, call, close: () => client.close(), stderr: () => stderr };
  }

  it('announces the packed package.json version from the MCP server and the CLI', async () => {
    const bin = path.join(unpacked, manifest.bin['renor-engine']);
    const cli = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    expect(cli.stdout.trim()).toBe(manifest.version);
    const home = scratch('renor-pack-version-');
    try {
      const { client, close } = await session({}, home);
      try {
        expect(client.getServerVersion()).toMatchObject({ name: 'renor', version: manifest.version });
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('with nothing set, remembers a fact in ~/.renor and recalls it', async () => {
    const home = scratch('renor-pack-home-');
    // A folder of the user's own named renor (a clone, say) must never be written into.
    fs.mkdirSync(path.join(home, 'renor'));
    fs.writeFileSync(path.join(home, 'renor', 'mine.md'), 'mine\n');
    try {
      const { call, close, stderr } = await session({}, home);
      try {
        await call('remember_fact', { subject: 'Ada', predicate: 'favorite_color', object: 'cerulean' });
        const found = await call('search', { query: "What is Ada's favorite color?" });
        expect(JSON.stringify(found).toLowerCase()).toContain('cerulean');
        expect(stderr(), 'the server says where the notes are').toContain(`Renor memory: ${path.join(home, '.renor')}`);
      } finally {
        await close();
      }
      const ledger = path.join(home, '.renor', 'System', 'Memory Events Ledger.md');
      expect(fs.existsSync(ledger), 'the default notes folder is ~/.renor').toBe(true);
      expect(fs.readdirSync(path.join(home, 'renor')), 'an existing renor folder is left alone').toEqual(['mine.md']);
      expect(fs.readFileSync(ledger, 'utf8').toLowerCase()).toContain('cerulean');
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }, BUDGET);

  it('with VAULT_PATH set, uses that folder and leaves ~/.renor alone', async () => {
    const home = scratch('renor-pack-home-');
    const vault = path.join(home, 'elsewhere');
    try {
      const { call, close, stderr } = await session({ VAULT_PATH: vault }, home);
      try {
        await call('remember_fact', { subject: 'Ada', predicate: 'favorite_color', object: 'cerulean' });
        expect(stderr()).not.toContain('Renor memory:');
      } finally {
        await close();
      }
      expect(fs.existsSync(path.join(vault, 'System', 'Memory Events Ledger.md'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.renor'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }, BUDGET);
});
