import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * `renor-engine status`: one command that says whether the self-host setup works. Real subprocess against the built CLI.
 * Offline: no case sets a network-reaching provider, and every case passes --offline, so the command makes no network call (the latest-version lookup is in tests/cli/latest-version.test.ts).
 */
const CLI = path.join(path.resolve(__dirname, '..', '..'), 'dist', 'cli.js');
const tmpDirs: string[] = [];

function mkvault(): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'status-cmd-'));
  tmpDirs.push(vault);
  return vault;
}

function env(vault: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['OPENAI_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_PROVIDER', 'DB_PATH', 'VAULT_PATH', 'MVP_MEMORY_DIR', 'RENOR_SHARING_DIR']) delete e[k];
  e.VAULT_PATH = vault;
  e.DB_PATH = path.join(vault, '.semantic-memory', 'index.db');
  e.RENOR_SHARING_DIR = path.join(vault, '.sharing');
  return e;
}

function run(args: string[], vault: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: env(vault), timeout: 90_000 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      resolve({ code: typeof code === 'number' ? code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('renor-engine status', () => {
  it('an empty folder says what to save first', async () => {
    const vault = mkvault();
    const r = await run(['status', '--offline'], vault);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`memory folder: ${vault}`);
    expect(r.stdout).toContain('0 notes, 0 facts');
    expect(r.stdout).toContain('save your first memory');
    expect(r.stdout).toContain('keyword-only');
    expect(r.stdout.trim().split('\n').length).toBeLessThanOrEqual(8);
  }, 120_000);

  it('a seeded, indexed folder reports counts and a current index; --json holds the same fields', async () => {
    const vault = mkvault();
    fs.writeFileSync(path.join(vault, 'a.md'), '# Alpha\n\nSecret sentence about llamas.\n');
    fs.writeFileSync(path.join(vault, 'b.md'), '# Beta\n\nAnother note.\n');
    const idx = await run(['index'], vault);
    expect(idx.code).toBe(0);
    const r = await run(['status', '--offline'], vault);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('2 notes');
    expect(r.stdout).toContain('index: current');
    expect(r.stdout).not.toContain('llamas');
    const j = await run(['status', '--offline', '--json'], vault);
    expect(j.code).toBe(0);
    const parsed = JSON.parse(j.stdout);
    expect(parsed).toMatchObject({ notes: 2, indexCurrent: true, staleNotes: 0, fix: null, search: 'keyword-only', memoryFolder: vault });
    for (const key of ['engineVersion', 'nodeVersion', 'facts', 'lastSaved', 'sharing']) expect(parsed).toHaveProperty(key);
    expect(j.stdout).not.toContain('llamas');
  }, 120_000);

  it('a stale index names the one command that fixes it', async () => {
    const vault = mkvault();
    fs.writeFileSync(path.join(vault, 'a.md'), '# Alpha\n\nFirst.\n');
    await run(['index'], vault);
    fs.writeFileSync(path.join(vault, 'new.md'), '# New\n\nAdded after the index.\n');
    const r = await run(['status', '--offline'], vault);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('index: stale');
    expect(r.stdout).toContain('fix: renor-engine index');
    const parsed = JSON.parse((await run(['status', '--offline', '--json'], vault)).stdout);
    expect(parsed).toMatchObject({ indexCurrent: false, fix: 'renor-engine index' });
    expect(parsed.staleNotes).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('exits 1 with the reason when the folder cannot be opened', async () => {
    const vault = path.join(mkvault(), 'missing');
    const r = await run(['status', '--offline'], vault);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('does not exist');
  }, 120_000);
});
