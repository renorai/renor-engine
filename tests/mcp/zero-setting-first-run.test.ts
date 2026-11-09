import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * The first run needs no setting. The READMEs' Quickstart ends with `node scripts/smoke-self-hosted.mjs`; these tests run
 * that command in a truly empty environment (not even PATH), so it starts the engine on its own defaults, saves a fact and
 * finds it again, and prove what the Quickstart promises around it: it never touches the notes you already have, it makes no
 * network connection, and its install steps build as written.
 *
 * Needs the engine's default embedding provider to be `none`, so that no key and no model are wanted (the command-line
 * server used to default to `openai`, which exits unless OPENAI_API_KEY is set).
 */

const ENGINE = path.resolve(__dirname, '../..');
// An engine start is seconds on a free machine and minutes on a starved one (the suite runs beside builds); the smoke client waits
// up to three minutes per request, so the processes it starts get longer than that before they are given up on.
const BUDGET = 420_000;
const PATIENTLY = { timeout: 180_000 };
const SMOKE = 'node scripts/smoke-self-hosted.mjs';
const PASS = 'PASS: self-hosted stdio MCP can remember and retrieve a current fact.';
const RECORDER = path.join(ENGINE, 'tests', 'helpers', 'recordNetwork.cjs');
// In this repository README.md is the engine's own page and README.public.md is the public one; in the public export
// README.public.md is README.md, and README.public.md does not exist. Test each page that is here.
const READMES = ['README.md', 'README.public.md'].filter(name => fs.existsSync(path.join(ENGINE, name)));
const PUBLIC_README = fs.existsSync(path.join(ENGINE, 'README.public.md')) ? 'README.public.md' : 'README.md';

function readme(name: string): string {
  return fs.readFileSync(path.join(ENGINE, name), 'utf8');
}

/**
 * The commands of the first fenced block under "## Build from source" (the public page, whose Quickstart is the npx path),
 * else under "## Quickstart" (the engine's own page), without comments.
 */
function quickstartCommands(name: string): string[] {
  const text = readme(name);
  const fromSource = text.search(/^## Build from source\s*$/m);
  const at = fromSource >= 0 ? fromSource : text.search(/^## Quickstart\s*$/m);
  expect(at, `${name} has no "## Build from source" or "## Quickstart" heading`).toBeGreaterThanOrEqual(0);
  const fence = /```bash\n([\s\S]*?)```/.exec(text.slice(at));
  expect(fence, `${name}: no bash block under its build heading`).not.toBeNull();
  return fence![1].split('\n').map(line => line.replace(/\s+#.*$/, '').trim()).filter(line => line !== '' && !line.startsWith('#'));
}

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

/** The smoke client run the way the Quickstart runs it: its own process, in the engine folder, with `env` as its whole environment. */
function runSmoke(env: Record<string, string>, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(ENGINE, 'scripts', 'smoke-self-hosted.mjs'), ...args], {
    cwd: ENGINE, env, encoding: 'utf8', timeout: BUDGET - 30_000,
  });
}

describe('the Quickstart in the READMEs', () => {
  for (const name of READMES) {
    it(`${name}: ends with the smoke command, sets nothing, and names only commands that exist`, () => {
      const commands = quickstartCommands(name);
      expect(commands[commands.length - 1]).toBe(SMOKE);
      // No command in the block sets an environment variable: the first run needs none.
      expect(commands.filter(command => /^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(command))).toEqual([]);
      const scripts = JSON.parse(fs.readFileSync(path.join(ENGINE, 'package.json'), 'utf8')).scripts as Record<string, string>;
      for (const command of commands) {
        for (const part of command.split('&&').map(piece => piece.trim())) {
          const run = /^npm run (\S+)$/.exec(part);
          if (run) expect(scripts[run[1]], `${part} is not a script in package.json`).toBeDefined();
          const file = /^node (\S+\.mjs)$/.exec(part);
          if (file) expect(fs.existsSync(path.join(ENGINE, file[1])), `${part}: no such file`).toBe(true);
        }
      }
    });

    it(`${name}: every build identity it tells you to set is one the build accepts`, () => {
      const assignments = [...readme(name).matchAll(/RENOR_BUILD_COMMIT=("?)([^\s"#]*)\1/g)].map(match => match[2]);
      for (const value of assignments) {
        expect(value, 'the same pattern scripts/ci/stamp-build.mjs checks').toMatch(/^[0-9a-fA-F]{7,40}$/);
      }
    });
  }

  it('the public README: the build identity it gives a ZIP download stamps a tree with no git history, and the build needs it there', () => {
    const documented = /RENOR_BUILD_COMMIT=("?)([0-9a-fA-F]{7,40})\1/.exec(readme(PUBLIC_README));
    expect(documented, `${PUBLIC_README} documents no RENOR_BUILD_COMMIT for an archive`).not.toBeNull();
    // A copy of the tree with no .git: only the stamp script, in the place it is in the tree.
    const tree = scratch('renor-zip-build-');
    try {
      fs.mkdirSync(path.join(tree, 'scripts', 'ci'), { recursive: true });
      fs.copyFileSync(path.join(ENGINE, 'scripts', 'ci', 'stamp-build.mjs'), path.join(tree, 'scripts', 'ci', 'stamp-build.mjs'));
      const stamp = (extra: Record<string, string>) => spawnSync(process.execPath, ['scripts/ci/stamp-build.mjs'], {
        cwd: tree, env: { GIT_CEILING_DIRECTORIES: path.dirname(tree), ...extra }, encoding: 'utf8', timeout: 60_000,
      });
      const without = stamp({});
      expect(without.status, without.stderr).toBe(1);
      expect(without.stderr).toContain('RENOR_BUILD_COMMIT');
      const stamped = stamp({ RENOR_BUILD_COMMIT: documented![2] });
      expect(stamped.status, stamped.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(tree, 'dist', 'BUILD.json'), 'utf8')).commit).toBe(documented![2]);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  }, BUDGET);
});

describe('the first run with nothing set', () => {
  it('starts the engine, saves a fact and finds it again, in an empty environment', () => {
    const run = runSmoke({});
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(PASS);
    for (const query of ["What is Ada's favorite color?", 'Ada favorite color cerulean', 'cerulean']) {
      expect(run.stdout).toContain(`search: ${JSON.stringify(query)} -> cerulean`);
    }
    // It used a notes folder of its own and removed it.
    const folder = /^notes folder: (\S+) \(temporary/m.exec(run.stdout);
    expect(folder, run.stdout).not.toBeNull();
    expect(fs.existsSync(path.dirname(folder![1]))).toBe(false);
  }, BUDGET);

  it('does not read VAULT_PATH from the environment, so a check run by habit leaves your notes alone', () => {
    const mine = scratch('renor-zero-mine-');
    try {
      const run = runSmoke({ VAULT_PATH: mine });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('(temporary;');
      expect(fs.readdirSync(mine)).toEqual([]);
    } finally {
      fs.rmSync(mine, { recursive: true, force: true });
    }
  }, BUDGET);

  it('checks the folder you name, and leaves the test fact in its ledger', () => {
    const named = scratch('renor-zero-named-');
    try {
      const run = runSmoke({}, [named]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('(yours;');
      expect(fs.readFileSync(path.join(named, 'System', 'Memory Events Ledger.md'), 'utf8')).toContain('cerulean');
      expect(runSmoke({}, ['relative/folder']).status, 'a relative folder is refused').toBe(1);
    } finally {
      fs.rmSync(named, { recursive: true, force: true });
    }
  }, BUDGET);

  // Sharing is the one thing a default stdio server sends (anonymous numbers, after the first-run notice; tests/mcp/stdio-sharing.test.ts
  // proves it goes only to Renor's sharing endpoint). With it off, nothing else may connect: no model, no update check, nothing.
  it('makes no network connection with sharing off while it starts, saves a fact and searches for it', async () => {
    const dir = scratch('renor-zero-network-');
    const log = path.join(dir, 'network.log');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ENGINE, 'dist', 'cli.js'), 'mcp'],
      cwd: ENGINE,
      env: { VAULT_PATH: path.join(dir, 'vault'), RENOR_SHARING: 'off', NODE_OPTIONS: `--require=${RECORDER}`, RECORD_NETWORK_LOG: log },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'zero-setting-first-run-test', version: '1.0.0' });
    try {
      await client.connect(transport, PATIENTLY);
      const saved = await client.callTool({ name: 'remember_fact', arguments: { subject: 'Ada', predicate: 'favorite_color', object: 'cerulean' } }, undefined, PATIENTLY);
      expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
      const found = await client.callTool({ name: 'search', arguments: { query: 'What is Ada favorite color' } }, undefined, PATIENTLY);
      expect(JSON.stringify(found)).toContain('cerulean');
    } finally {
      await client.close();
    }
    const attempts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    fs.rmSync(dir, { recursive: true, force: true });
    expect(attempts).toBe('');
  }, BUDGET);

  it('the recorder it relies on sees a connection attempt, so an empty log means none was made', () => {
    const dir = scratch('renor-zero-recorder-');
    const log = path.join(dir, 'network.log');
    try {
      const run = spawnSync(process.execPath, ['-e', "require('node:net').connect(9, '127.0.0.1').on('error', () => {})"], {
        env: { NODE_OPTIONS: `--require=${RECORDER}`, RECORD_NETWORK_LOG: log }, encoding: 'utf8', timeout: 30_000,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(fs.readFileSync(log, 'utf8')).toContain('connect 127.0.0.1:9');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, BUDGET);
});
