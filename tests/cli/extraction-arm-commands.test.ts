import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFile, type ChildProcess } from 'child_process';
import { execFileTree, killTree } from '../helpers/childTree';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { openExtractorClient, resolveExtractorClientConfig } from '../../src/extraction/extractionClient';
import { buildWritePathExtractors } from '../../src/cli-extractors';
import { FACTS_MODEL } from '../../src/extraction/typedFacts';
import { removeTestDir } from '../helpers/removeDb';
import { removeTempDirsAfterAll } from '../helpers/tmpCleanup';

removeTempDirsAfterAll();

/**
 * An armed structured-row flag with no extractor provider must fail the
 * commands that extract (index, rebuild, watch) so a clean run cannot look
 * like an empty extraction. search, serve, and mcp do not extract. They must
 * still run; the benchmark transport is `search --json`.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The compiled `renor` bin (package.json `bin`), built by tests/globalSetup.ts before any test
// file loads: the surface a user runs, and without paying tsx's transform on every spawn.
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
const tmpDirs: string[] = [];
const API_TOKEN = 'synthetic-api-token-for-the-serve-command';

function mkvault(): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-cli-'));
  tmpDirs.push(vault);
  fs.writeFileSync(path.join(vault, '.semanticignore'), 'System/\n');
  fs.mkdirSync(path.join(vault, 'System'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'note.md'), '# Empty\n\nNothing to extract.\n');
  return vault;
}

function armedEnv(vault: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'EMBEDDING_BASE_URL',
    'RENOR_EXTRACTOR_API_KEY', 'RENOR_EXTRACTOR_API_KEYS', 'RENOR_EXTRACTOR_BASE_URL',
    // EVERY name `resolveExtractorClientConfig` reads, not a sample of them. The
    // list used to stop at `OLLAMA_CLOUD_KEY_2` while the resolver read six Ollama
    // names, so any *other* one in the environment answered this suite's
    // "no provider" premise with a live 401. Measured on a credential-bearing host:
    // OLLAMA_CLOUD_KEY_3, _4 and OLLAMA_MAX_KEY each turn `7 passed` into
    // `1 failed | 6 passed`. `no-provider-premise.test.ts` pins the premise itself.
    'OLLAMA_API_KEY', 'OLLAMA_CLOUD_KEY_1', 'OLLAMA_CLOUD_KEY_2',
    'OLLAMA_CLOUD_KEY_3', 'OLLAMA_CLOUD_KEY_4', 'OLLAMA_MAX_KEY',
    'EMBEDDING_PROVIDER', 'DB_PATH', 'VAULT_PATH',
    // `serve` refuses to start with one, so a host that has it set must not decide what these runs prove.
    'RENOR_API_TOKEN',
  ]) delete env[key];
  env.VAULT_PATH = vault;
  env.DB_PATH = path.join(vault, '.semantic-memory', 'index.db');
  env.EMBEDDING_PROVIDER = 'eval-hash';
  env.RENOR_TYPED_FACTS = '1';
  env.RENOR_CHRONICLE = '1';
  env.RENOR_PREFS = '1';
  return env;
}

function runCli(
  args: string[],
  vault: string,
  timeout = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: armedEnv(vault),
      timeout,
    }, (err, stdout, stderr) => {
      const error = err as NodeJS.ErrnoException & { code?: number | string; signal?: NodeJS.Signals } | null;
      resolve({
        code: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
        stdout: String(stdout),
        stderr: String(stderr),
        signal: error?.signal ?? null,
      });
    });
    void child;
  });
}

/** Resolves once `child` has exited (at once if it already has). */
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) removeTestDir(dir);
});

const legacyRequests: Array<{ apiKey: string; body: { model?: string } }> = [];
vi.mock('openai', () => {
  class OpenAI {
    apiKey: string;
    chat: { completions: { create: (body: { model?: string }) => Promise<unknown> } };
    constructor(options: { apiKey?: string }) {
      this.apiKey = options.apiKey ?? '';
      this.chat = {
        completions: {
          create: async (body: { model?: string }) => {
            legacyRequests.push({ apiKey: options.apiKey ?? '', body });
            return {
              choices: [{ message: { content: JSON.stringify({ facts: [{ subject: 'Ada', predicate: 'founded', object: 'Renor', confidence: 1 }] }) } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        },
      };
    }
  }
  return { default: OpenAI };
});

describe('legacy LLM fact extraction', () => {
  it('calls the legacy fact client with a bare OPENAI_API_KEY and leaves structured lanes unarmed', async () => {
    const env = {
      LLM_EXTRACTION: 'true',
      OPENAI_API_KEY: 'sk-test-not-real',
      RENOR_TYPED_FACTS: '1',
      RENOR_CHRONICLE: '1',
      RENOR_PREFS: '1',
    } as NodeJS.ProcessEnv;
    expect(openExtractorClient('gemma4:31b', env)).toBeNull();
    const extractors = buildWritePathExtractors({
      llmExtraction: true,
      openaiApiKey: 'sk-test-not-real',
    }, env);
    expect(extractors.numericFactExtractor).toBeUndefined();
    expect(extractors.eventExtractor).toBeUndefined();
    expect(extractors.preferenceExtractor).toBeUndefined();
    const facts = await extractors.factExtractor!('Legacy', 'Ada founded Renor.');
    expect(facts).toEqual([{ subject: 'Ada', predicate: 'founded', object: 'Renor', confidence: 1 }]);
    expect(legacyRequests).toEqual([
      expect.objectContaining({ apiKey: 'sk-test-not-real', body: expect.objectContaining({ model: 'gpt-4o-mini' }) }),
    ]);
  });

  it('sends the fact extractor default, not FACTS_MODEL, on the generic OpenAI fallback', async () => {
    // The third row of the matrix. The bare-key row above names no base URL, so
    // no extractor client resolves and the legacy OpenAI client is used; the
    // row below names a DEDICATED provider, which serves FACTS_MODEL. This row
    // names OPENAI_API_KEY plus OPENAI_BASE_URL: a client does resolve, but the
    // endpoint is OpenAI-shaped and does not serve gemma4:31b, so the fact path
    // must keep the model `main` sent there. Nothing pinned this row before, so
    // the two rows either side stayed green while the shipped surface asked the
    // generic endpoint for the gemma model.
    const env = {
      LLM_EXTRACTION: 'true',
      OPENAI_API_KEY: 'sk-test-not-real',
      OPENAI_BASE_URL: 'https://example.invalid/v1',
    } as NodeJS.ProcessEnv;
    expect(openExtractorClient('gemma4:31b', env)?.config.provider).toBe('openai-fallback');
    const urls: string[] = [];
    const seen: Array<{ model?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      urls.push(String(url));
      seen.push(JSON.parse(String(init.body)) as { model?: string });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] }),
        text: async () => '',
      };
    }));
    const extractors = buildWritePathExtractors({
      llmExtraction: true,
      openaiApiKey: 'sk-test-not-real',
    }, env);
    try {
      await extractors.factExtractor!('Legacy', 'Ada founded Renor.');
      // Model and endpoint only — whether the structured lanes are armed on this
      // row is a separate decision and is deliberately not pinned here.
      expect(seen.map(request => request.model)).toEqual(['gpt-4o-mini']);
      expect(urls.every(url => url.startsWith('https://example.invalid/v1'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends the named provider model when LLM_EXTRACTION uses the extractor client', async () => {
    const env = {
      LLM_EXTRACTION: 'true',
      RENOR_EXTRACTOR_API_KEY: 'dedicated',
      RENOR_EXTRACTOR_BASE_URL: 'https://dedicated.invalid/v1',
    } as NodeJS.ProcessEnv;
    const seen: Array<{ model?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)) as { model?: string });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] }),
        text: async () => '',
      };
    }));
    const extractors = buildWritePathExtractors({
      llmExtraction: true,
      openaiApiKey: 'sk-test-not-real',
    }, env);
    try {
      await extractors.factExtractor!('Legacy', 'Ada founded Renor.');
      expect(seen.map(request => request.model)).toEqual([FACTS_MODEL]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not invent a legacy fact extractor when LLM_EXTRACTION is off', () => {
    const env = { OPENAI_API_KEY: 'sk-test-not-real' } as NodeJS.ProcessEnv;
    const extractors = buildWritePathExtractors({
      llmExtraction: false,
      openaiApiKey: 'sk-test-not-real',
    }, env);
    expect(extractors.factExtractor).toBeUndefined();
  });
});

describe('the arm-without-a-provider premise holds for the WHOLE Ollama namespace', () => {
  const RESOLVER_KEY_NAMES = [
    'OLLAMA_CLOUD_KEY_1',
    'OLLAMA_CLOUD_KEY_2',
    'OLLAMA_CLOUD_KEY_3',
    'OLLAMA_CLOUD_KEY_4',
    'OLLAMA_MAX_KEY',
    'OLLAMA_API_KEY',
  ];

  it('scrubs every name the resolver reads, so `armedEnv` really means no provider', () => {
    const vault = mkvault();
    const saved: Record<string, string | undefined> = {};
    try {
      for (const name of RESOLVER_KEY_NAMES) {
        saved[name] = process.env[name];
        process.env[name] = `host-ambient-${name}`;
      }
      // At the CALL SITE, with those names in the environment: a name the
      // scrub forgets is visible to the child, so asserting on `armedEnv` alone
      // cannot catch it.
      expect(resolveExtractorClientConfig(armedEnv(vault), 'gemma4:31b')).toBeNull();
    } finally {
      for (const name of RESOLVER_KEY_NAMES) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  it('fails the drift scan when a module names a key this list does not scrub', () => {
    // The list above is hand-kept; the tree's own sources are the truth. Scan
    // them so a SEVENTH name fails HERE, on the gate host, instead of on a
    // credentialed host as a 401 mid-extraction. Deliberately RECURSIVE over all
    // of src/ and not pinned to one file: the first version of this check scanned
    // only src/extraction + src/evidence, and `src/eval/evalCache.ts` already
    // reads two of the six names — a seventh could have landed there, or in a
    // subdirectory, and passed. Centralising the pool moves the literals between
    // modules too, and the check must survive that move.
    const dirs = ['src'];
    const found = new Set<string>();
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...walk(rel));
        else if (/\.tsx?$/.test(entry.name)) out.push(rel);
      }
      return out;
    };
    for (const dir of dirs) {
      for (const rel of walk(dir)) {
        const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/\/\/[^\n]*/g, ' ');
        // A name built from a RANGE — `[1, 2, 3].map(i => env[\`OLLAMA_CLOUD_KEY_${i}\`])`.
        // It spells no `OLLAMA_...` literal, so a literal-only scan cannot see
        // it, and that is exactly how the evidence pool named three of six.
        const ranged = /\[([\d,\s]+)\]\.map\([^;]*?(OLLAMA_[A-Z0-9_]+)\$\{/g;
        for (const match of source.matchAll(ranged)) {
          for (const index of match[1].split(',')) {
            if (index.trim()) found.add(`${match[2]}${index.trim()}`);
          }
        }
        // READ positions only: a quoted literal (`env['OLLAMA_...']`) or a
        // property read (`env.OLLAMA_...`). A bare IDENTIFIER is not an env var
        // — `export const OLLAMA_KEY_ENV_NAMES = […]` declares the pool without
        // reading it, and a token-level scan would flag it as a missing key.
        for (const match of source.matchAll(/'OLLAMA_[A-Z0-9_]+'/g)) {
          found.add(match[0].slice(1, -1));
        }
        for (const match of source.matchAll(/\benv\.(OLLAMA_[A-Z0-9_]+)/g)) {
          found.add(match[1]);
        }
      }
    }
    // The scan must actually SEE the namespace. A passing run whose `found` set
    // is empty proves nothing, and this assertion is what distinguishes "the
    // scan sees the names" from "the scan sees nothing and passes".
    expect([...found].sort()).toEqual([...RESOLVER_KEY_NAMES].sort());
    for (const name of found) {
      // Anything left unexpanded is not itself scrubable — a concatenated or
      // partially generated name means the module reads a namespace it does not
      // spell out, so the scan must FAIL rather than pass quietly.
      expect(RESOLVER_KEY_NAMES, `${name} is read under ${dirs.join('/')} but not scrubbed`).toContain(name);
    }
  });

  it('still refuses index on a credential-bearing host instead of 401-ing mid-extraction', async () => {
    const vault = mkvault();
    const saved: Record<string, string | undefined> = {};
    try {
      for (const name of RESOLVER_KEY_NAMES) {
        saved[name] = process.env[name];
        process.env[name] = `host-ambient-${name}`;
      }
      const result = await runCli(['index'], vault);
      expect(result.stderr).toMatch(/armed without a provider/);
      expect(result.stderr).not.toMatch(/Unauthorized/);
    } finally {
      for (const name of RESOLVER_KEY_NAMES) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  }, 60_000);
});

describe('structured-row arm without a provider', () => {
  it('fails index, rebuild, and watch before they look like an empty extraction', async () => {
    const vault = mkvault();
    for (const command of ['index', 'rebuild', 'watch'] as const) {
      const result = await runCli([command], vault);
      expect(result.code, command).not.toBe(0);
      expect(result.stderr, command).toMatch(/armed without a provider/);
      expect(result.stderr, command).toMatch(/RENOR_TYPED_FACTS/);
    }
  }, 90_000);

  it('still searches when the flags are armed and no extractor is configured', async () => {
    const vault = mkvault();
    const result = await runCli(['search', 'nothing here', '--json'], vault);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/armed without a provider/);
    // Migration logs share stdout with the JSON contract. The command still
    // has to finish and emit the hits object instead of exiting on the arm.
    const jsonLine = result.stdout.split('\n').find(line => line.startsWith('{'));
    expect(jsonLine, result.stdout).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as { hits: unknown };
    expect(parsed.hits).toEqual([]);
  }, 60_000);

  it('refuses to serve without RENOR_API_TOKEN and says how to set it', async () => {
    const vault = mkvault();
    const result = await runCli(['serve', '--port', '0'], vault);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/RENOR_API_TOKEN is not set/);
    expect(result.stderr).toMatch(/Authorization: Bearer/);
    // Refused before the vault was opened: no index was created by the refused start.
    expect(fs.existsSync(path.join(vault, '.semantic-memory'))).toBe(false);
  }, 60_000);

  it('still serves and starts mcp when the flags are armed and no extractor is configured', async () => {
    const vault = mkvault();
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const chosen = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolve(chosen));
      });
    });
    const serve = execFileTree(process.execPath, [CLI, 'serve', '--port', String(port)], {
      cwd: REPO_ROOT,
      env: { ...armedEnv(vault), RENOR_API_TOKEN: API_TOKEN },
    });
    const mcpEnv = armedEnv(vault);
    mcpEnv.DB_PATH = path.join(vault, '.semantic-memory', 'mcp.db');
    mcpEnv.RENOR_SHARING = 'off'; // this test is about extraction, not sharing
    const mcp = execFileTree(process.execPath, [CLI, 'mcp'], {
      cwd: REPO_ROOT,
      env: mcpEnv,
    });
    const serveErr: string[] = [];
    const mcpErr: string[] = [];
    serve.stderr?.on('data', (chunk) => serveErr.push(String(chunk)));
    mcp.stderr?.on('data', (chunk) => mcpErr.push(String(chunk)));
    try {
      const ready = await new Promise<boolean>((resolve) => {
        const started = Date.now();
        let checking = false;
        const timer = setInterval(async () => {
          if (checking) return;
          checking = true;
          if (serve.exitCode != null || mcp.exitCode != null || Date.now() - started > 20_000) {
            clearInterval(timer);
            checking = false;
            resolve(false);
            return;
          }
          const controller = new AbortController();
          const abort = setTimeout(() => controller.abort(), 500);
          try {
            const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal, headers: { Authorization: `Bearer ${API_TOKEN}` } });
            if (response.ok) {
              clearInterval(timer);
              resolve(true);
            }
          } catch {
            // not listening yet, or this probe was aborted
          } finally {
            clearTimeout(abort);
            checking = false;
          }
        }, 200);
      });
      expect(ready, serveErr.join('')).toBe(true);
      expect(serve.exitCode).toBeNull();
      expect(mcp.exitCode).toBeNull();
      expect(serveErr.join('')).not.toMatch(/armed without a provider/);
      expect(mcpErr.join('')).not.toMatch(/armed without a provider/);
    } finally {
      killTree(serve, 'SIGTERM');
      killTree(mcp, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 300));
      killTree(serve, 'SIGKILL');
      killTree(mcp, 'SIGKILL');
      // Both hold a database in the vault open until they exit; Windows refuses afterAll's removal while they do.
      await Promise.all([exited(serve), exited(mcp)]);
    }
  }, 40_000);
});
