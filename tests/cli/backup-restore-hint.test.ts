import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Issue #20: `backup` should tell the user what to run next, and `restore`
 * help should show an example, so a person who backs up a folder is not sent
 * to fail once on the required `--to` option.
 *
 * Spawns the actual CLI (the compiled `dist/cli.js`) with a synthetic temp
 * vault, a dummy OpenAI key and no embedding calls.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The compiled `renor` bin (package.json `bin`), built by tests/globalSetup.ts before any test
// file loads: the surface a user runs.
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];

function mkvault(): string {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1a-cli-'));
  tmpDirs.push(v);
  fs.writeFileSync(path.join(v, '.semanticignore'), 'System/\n');
  fs.mkdirSync(path.join(v, 'System'), { recursive: true });
  fs.writeFileSync(path.join(v, LEDGER), [
    `---`, `type: memory-ledger`, `---`, ``, `# Memory Events Ledger`, ``,
    `## MEM_CLI1 · 2026-09-09T00:00:00.000Z`,
    `- kind: store`,
    `- subject: SynthCli`,
    `- predicate: role`,
    `- object: survivor`,
    `- source: cli-test`,
    ``,
  ].join('\n'));
  return v;
}

function cliEnv(vault: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['OPENAI_API_KEY', 'EMBEDDING_PROVIDER', 'EMBEDDING_BASE_URL',
    'EMBEDDING_MODEL', 'EMBEDDING_DIMS', 'LLM_EXTRACTION', 'MEMORY_LEDGER',
    'DB_PATH', 'VAULT_PATH']) delete env[k];
  env.VAULT_PATH = vault;
  env.DB_PATH = path.join(vault, '.semantic-memory', 'index.db');
  env.EMBEDDING_PROVIDER = 'openai';
  env.OPENAI_API_KEY = 'sk-test-dummy-key-for-cli-tests';
  return env;
}

function runCli(args: string[], cwd: string, vault: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd,
      env: cliEnv(vault),
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err as unknown as { code?: number }).code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('backup/restore next-step hint (#20)', () => {
  it('backup prints a restore hint, restore --help shows an example, and the hint round-trips', async () => {
    const vault = mkvault();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1a-cli-backup-'));
    tmpDirs.push(work);

    const b = await runCli(['backup', '--out', 'b.tgz'], work, vault);
    expect(b.code).toBe(0);
    expect(b.stdout).toMatch(/Backed up \d+ file\(s\), \d+ bytes, to .*b\.tgz/);
    expect(b.stdout).toMatch(/Next: renor-engine restore .*b\.tgz --to <folder>/);
    expect(fs.existsSync(path.join(work, 'b.tgz'))).toBe(true);

    const h = await runCli(['restore', '--help'], work, vault);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('restore my-memory.tar.gz --to ~/memory-restored');

    const target = path.join(work, 'restored');
    const r = await runCli(['restore', 'b.tgz', '--to', target], work, vault);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Restored \d+ notes, \d+ facts, to /);
  }, 120_000);
});
