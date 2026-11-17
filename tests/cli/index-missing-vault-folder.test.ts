import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * #12: `renor index` on a VAULT_PATH that does not exist used to create the
 * folder (openIndexDb's mkdirSync of the db parent) and report `Done. 0/0
 * indexed, 0 errors.` with exit 0. A typo in VAULT_PATH therefore looked like a
 * healthy empty index. Guard the `index` command before setup() opens the db,
 * so a missing folder is reported and fails instead of being silently created.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
const tmpDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-missing-vault-'));
  tmpDirs.push(dir);
  return dir;
}

function cliEnv(vault: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'EMBEDDING_BASE_URL',
    'RENOR_EXTRACTOR_API_KEY', 'RENOR_EXTRACTOR_API_KEYS', 'RENOR_EXTRACTOR_BASE_URL',
    'EMBEDDING_PROVIDER', 'DB_PATH', 'VAULT_PATH',
    'RENOR_TYPED_FACTS', 'RENOR_CHRONICLE', 'RENOR_PREFS',
  ]) delete env[key];
  env.VAULT_PATH = vault;
  env.DB_PATH = path.join(vault, '.semantic-memory', 'index.db');
  env.EMBEDDING_PROVIDER = 'eval-hash';
  return env;
}

function runCli(vault: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'index'], {
      cwd: REPO_ROOT,
      env: cliEnv(vault),
      timeout: 90_000,
    }, (err, stdout, stderr) => {
      const error = err as NodeJS.ErrnoException & { code?: number | string } | null;
      resolve({
        code: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('index on a missing vault folder (#12)', () => {
  it('reports the missing folder, exits non-zero, and does not create it', async () => {
    const missing = path.join(scratch(), 'typo-folder');
    const result = await runCli(missing);
    expect(
      result.stderr,
      `${result.stdout}\n${result.stderr}`,
    ).toMatch(/does not exist.*VAULT_PATH|VAULT_PATH.*does not exist|Memory folder.*exist/i);
    expect(result.stdout, `${result.stdout}\n${result.stderr}`).not.toMatch(/Done\. 0\/0 indexed/);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(fs.existsSync(missing), 'a typo in VAULT_PATH must not silently create the folder').toBe(false);
  }, 90_000);

  it('still indexes an existing empty folder — the guard is not over-firing', async () => {
    const vault = path.join(scratch(), 'vault');
    fs.mkdirSync(vault, { recursive: true });
    const result = await runCli(vault);
    expect(result.stdout, `${result.stdout}\n${result.stderr}`).toMatch(/Done\. 0\/0 indexed, 0 errors\./);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 90_000);
});
