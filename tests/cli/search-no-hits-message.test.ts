import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { tmpPath } from '../helpers/tmpPath';
import { EVIDENCE_PROVIDER_ENV } from '../helpers/stubChat';

/**
 * `renor search` with no hits printed nothing (0 bytes) and exited 0, so a person could not tell "no match" from
 * "broken" — and a hit was labelled `(semantic+recency)` while the notice above said semantic search is off (#14).
 *
 * Asserted at the real spawned CLI, with no EMBEDDING_PROVIDER set (the default self-hosted install: the keyword
 * index stands in for the semantic lane): no model is called.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The compiled `renor` bin (package.json `bin`), built by tests/globalSetup.ts before any test
// file loads: the surface a user runs, and without paying tsx's transform on every spawn.
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
// Each case spawns tsx (index or search); a loaded host can take tens of seconds.
const CLI_BUDGET_MS = 180_000;

const root = tmpPath('search-no-hits-message');
const vault = path.join(root, 'vault');
const dbPath = path.join(root, 'index.db');

/** The shipped CLI env: synthetic, offline, and without any provider credential or flag from the developer's shell. */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    ...EVIDENCE_PROVIDER_ENV, 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMS',
    'EMBEDDING_BATCH_SIZE', 'EMBEDDING_PROVIDER', 'LLM_EXTRACTION', 'VAULT_PATH', 'DB_PATH', 'MEMORY_LEDGER', 'RENOR_STRUCTURED_CONTEXT',
    'RENOR_READ_HONESTY', 'RENOR_QUERY_SCOPED_ROWS', 'RENOR_VAULT_STALENESS', 'RENOR_SESSION_ROUTER',
  ]) delete env[key];
  return {
    ...env,
    RENOR_SEARCH_EVIDENCE: '0',
    VAULT_PATH: vault,
    DB_PATH: dbPath,
    ...extra,
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Not run from the vault: where the process runs must not decide what it prints.
    execFile(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env, timeout: CLI_BUDGET_MS },
      (err, stdout, stderr) => resolve({
        code: err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : (err ? 1 : 0),
        stdout: String(stdout),
        stderr: String(stderr),
      }));
  });
}

beforeAll(async () => {
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'notebook.md'), '# Notebook\n\nI prefer tea over coffee.\n');
  const indexed = await runCli(['index'], cliEnv());
  expect(indexed.code, indexed.stderr).toBe(0);
  expect(indexed.stdout).toMatch(/Done\.\s*1\/1 indexed, 0 errors/);
}, 2 * CLI_BUDGET_MS);

describe('search with no hits, semantic search off', () => {
  it('prints one line naming the query and still exits 0', async () => {
    const noHits = await runCli(['search', 'zzzqq'], cliEnv());
    expect(noHits.code, noHits.stderr).toBe(0);
    expect(noHits.stdout.trim()).toBe('No notes matched "zzzqq"');
  }, CLI_BUDGET_MS);

  it('labels a keyword hit keyword, not semantic', async () => {
    const hit = await runCli(['search', 'tea'], cliEnv());
    expect(hit.code, hit.stderr).toBe(0);
    expect(hit.stdout).toContain('(keyword');
    expect(hit.stdout).not.toContain('semantic');
  }, CLI_BUDGET_MS);

  it('leaves the frozen search --json envelope alone: no hits is still just {"hits":[]}', async () => {
    const noHits = await runCli(['search', 'zzzqq', '--json'], cliEnv());
    expect(noHits.code, noHits.stderr).toBe(0);
    const body = JSON.parse(noHits.stdout);
    expect(Object.keys(body)).toEqual(['hits']);
    expect(body.hits).toEqual([]);
  }, CLI_BUDGET_MS);
});
