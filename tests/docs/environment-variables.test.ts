import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { loadConfig } from '../../src/config';
import { loadMvpConfig } from '../../src/mvp/config';
import { resolveEvidenceMode } from '../../src/evidence/gate';

/**
 * Anti-drift guard for docs/ENVIRONMENT-VARIABLES.md and docs/ENVIRONMENT-VARIABLES-REFERENCE.md.
 *
 * The engine reads far more environment variables than `grep process.env.NAME` finds (a count of those alone was 57;
 * the source reads 153): a parameter named `env` that defaults to process.env, `process.env[name]` behind a helper,
 * a constant that holds the name. So this reads the syntax tree of every file under src/ and takes
 *
 *   - `process.env.NAME`, `env.NAME` and `x.env.NAME`,
 *   - `process.env['NAME']` and `env['NAME']`, and
 *   - any string literal written like a variable (capitals, with an underscore), which is how a name reaches a helper or a
 *     constant. Comments are not read, so a name that is only mentioned in one does not count.
 *
 * A literal that looks like a variable but is not one goes in NOT_ENV below, with what it is. The page must list every name
 * this finds and no other, in the first column of its tables, and state the defaults of the settings a first run meets
 * as the code resolves them. It cannot check a description.
 */

const ENGINE = path.resolve(__dirname, '../..');
const SRC = path.join(ENGINE, 'src');
/** The settings a person running Renor may want, and the operator and experiment reference. Together they list every variable. */
const PAGES = ['ENVIRONMENT-VARIABLES.md', 'ENVIRONMENT-VARIABLES-REFERENCE.md'].map(name => path.join(ENGINE, 'docs', name));

const NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const WRITTEN_LIKE_A_VARIABLE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Literals in src/ written like a variable that are not one. A new entry says what the literal is. */
const NOT_ENV: Record<string, string> = {
  DESCRIPTIVE_ONLY: 'a verdict of the benchmark comparison',
  RETRIEVAL_DOCUMENT: 'a task type of the Vertex embeddings request',
  RETRIEVAL_QUERY: 'a task type of the Vertex embeddings request',
  ERR_OUT_OF_RANGE: 'the code node:sqlite gives an integer beyond 2^53',
  ERR_SQLITE_ERROR: 'the code node:sqlite gives its errors',
  SQLITE_CANTOPEN: 'a SQLite error code',
  SQLITE_CONSTRAINT_UNIQUE: 'a SQLite error code',
  SQLITE_CORRUPT: 'a SQLite error code',
  SQLITE_NOTADB: 'a SQLite error code',
  EVIDENCE_MODEL_DEFAULT: 'the name of a constant of the evidence second pass (src/evidence/secondPass.ts), pinned in the index snapshot key',
  EVIDENCE_REASONING_EFFORTS: 'the name of a constant of the evidence second pass (src/evidence/secondPass.ts), pinned in the index snapshot key',
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** `process.env`, or `env`, or `anything.env`: the object a variable is read from. */
function isEnvObject(node: ts.Expression): boolean {
  return (ts.isIdentifier(node) && node.text === 'env') || (ts.isPropertyAccessExpression(node) && node.name.text === 'env');
}

/** Every variable name the source reads, with the files that read it. */
function envReads(): Map<string, Set<string>> {
  const reads = new Map<string, Set<string>>();
  for (const file of sourceFiles(SRC)) {
    const where = path.relative(ENGINE, file).split(path.sep).join('/');
    const add = (name: string) => reads.set(name, (reads.get(name) ?? new Set<string>()).add(where));
    const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression) && NAME.test(node.name.text)) {
        add(node.name.text);
      } else if (ts.isElementAccessExpression(node) && isEnvObject(node.expression)
          && ts.isStringLiteralLike(node.argumentExpression) && NAME.test(node.argumentExpression.text)) {
        add(node.argumentExpression.text);
      } else if (ts.isStringLiteralLike(node) && WRITTEN_LIKE_A_VARIABLE.test(node.text) && !(node.text in NOT_ENV)) {
        add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return reads;
}

interface Row {
  names: string[];
  cells: string[];
}

/** The rows of the page's tables: the names in backticks in the first column, and the three cells. */
function documentedRows(): Row[] {
  return PAGES.flatMap(page => fs.readFileSync(page, 'utf8').split('\n'))
    .filter(line => line.startsWith('|'))
    .map(line => line.slice(1, line.lastIndexOf('|')).split('|').map(cell => cell.trim()))
    .filter(cells => cells[0] !== 'Variable' && !/^-+$/.test(cells[0]))
    .map(cells => ({ cells, names: [...cells[0].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(match => match[1]) }));
}

function documentedNames(): string[] {
  return documentedRows().flatMap(row => row.names);
}

/** The default cell of a variable's row. */
function documentedDefault(name: string): string {
  const row = documentedRows().find(candidate => candidate.names.includes(name));
  if (!row) throw new Error(`${name} has no row in ${'docs/ENVIRONMENT-VARIABLES*.md'}`);
  return row.cells[1];
}

/** Runs `fn` with every documented variable cleared (HOME stays: the process needs it) and `vars` set, then puts the environment back. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const name of new Set([...documentedNames().filter(documented => documented !== 'HOME'), ...Object.keys(vars)])) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('docs/ENVIRONMENT-VARIABLES*.md', () => {
  it('lists every environment variable src/ reads, and no other', () => {
    const read = envReads();
    const documented = new Set(documentedNames());
    const missing = [...read.keys()].filter(name => !documented.has(name)).sort();
    expect(
      missing,
      'src/ reads these variables and the page has no row for them: add a row to docs/ENVIRONMENT-VARIABLES.md (a setting a user may want) or docs/ENVIRONMENT-VARIABLES-REFERENCE.md (an operator or experiment switch). '
      + 'If a name is only a string written like a variable, add it to NOT_ENV in this test with what it is.\n'
      + missing.map(name => `  ${name}  (${[...read.get(name)!].join(', ')})`).join('\n'),
    ).toEqual([]);
    const stale = [...documented].filter(name => !read.has(name)).sort();
    expect(stale, 'the page has rows for variables that src/ no longer reads: remove them').toEqual([]);
    // The scan itself finds the settings people know and the ones a plain grep misses.
    for (const known of ['VAULT_PATH', 'EMBEDDING_PROVIDER', 'RENOR_TEMPORAL_ASOF', 'MVP_MEMORY_DIR', 'OLLAMA_CLOUD_KEY_4', 'RENOR_EMBED_READ_BUDGET_MS']) {
      expect(read.has(known), known).toBe(true);
    }
  }, 120_000); // it parses every file under src/, which takes seconds on a loaded machine

  it('keeps the user page short, and leaves the experiment switches to the reference', () => {
    const rowsOf = (page: string) => fs.readFileSync(page, 'utf8').split('\n').filter(line => /^\| `[A-Z]/.test(line)).length;
    expect(rowsOf(PAGES[0]), 'the user page is for settings a person running Renor may want: move the rest to the reference').toBeLessThanOrEqual(30);
    expect(rowsOf(PAGES[1])).toBeGreaterThan(rowsOf(PAGES[0]));
  });

  it('gives each variable one row, with a default and a description', () => {
    const rows = documentedRows();
    for (const row of rows) {
      expect(row.cells.length, row.cells[0]).toBe(3);
      expect(row.names.length, `a row with no variable in its first column: ${row.cells[0]}`).toBeGreaterThan(0);
      expect(row.cells[1], `${row.cells[0]} has no default`).not.toBe('');
      expect(row.cells[2], `${row.cells[0]} has no description`).not.toBe('');
    }
    const names = documentedNames();
    expect(names.filter((name, i) => names.indexOf(name) !== i), 'variables with more than one row').toEqual([]);
  });

  it('states the defaults of the command-line server as loadConfig() resolves them', () => {
    // No setting is a first run in a renor folder in the home directory, and an empty one is the same as unset.
    expect(withEnv({}, () => loadConfig()).vaultPath).toBe(path.join(os.homedir(), '.renor'));
    expect(withEnv({ VAULT_PATH: '' }, () => loadConfig()).vaultPath).toBe(path.join(os.homedir(), '.renor'));
    expect(documentedDefault('VAULT_PATH')).toBe('`~/.renor`');
    const config = withEnv({ VAULT_PATH: '/vault' }, () => loadConfig());
    const stated: Record<string, string> = {
      EMBEDDING_PROVIDER: config.embeddingProvider,
      DB_PATH: config.dbPath.replace('/vault', '<VAULT_PATH>'),
      MEMORY_DIR: config.memoryDir,
      MEMORY_LEDGER: config.memoryLedger,
      CHUNK_MAX_TOKENS: String(config.chunkMaxTokens),
      CHUNK_OVERLAP_TOKENS: String(config.chunkOverlapTokens),
      INDEX_CONCURRENCY: String(config.indexConcurrency),
      LLM_EXTRACTION: String(config.llmExtraction),
      RENOR_EVIDENCE_MODE: withEnv({}, () => resolveEvidenceMode()),
    };
    for (const [name, value] of Object.entries(stated)) {
      expect(documentedDefault(name), name).toBe('`' + value + '`');
    }
  });

  it('states the defaults of the HTTP server as loadMvpConfig() resolves them', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-env-reference-'));
    const config = withEnv({
      MVP_MEMORY_DIR: path.join(scratch, 'memory'),
      MVP_BASE_URL: 'http://127.0.0.1:3471',
      MVP_OWNER_EMAIL: 'owner@example.test',
      MVP_OWNER_PASSWORD: 'a-long-random-test-secret',
      MVP_AUTH_STATE_PATH: path.join(scratch, 'auth', 'clients.json'),
    }, () => loadMvpConfig());
    fs.rmSync(scratch, { recursive: true, force: true });
    const stated: Record<string, string> = {
      MVP_EMBEDDING_PROVIDER: config.embeddingProvider,
      MVP_PORT: String(config.port),
      MVP_ACCESS_TOKEN_TTL_SECONDS: String(config.accessTokenTtlSeconds),
      MVP_LOGIN_MAX_FAILURES: String(config.loginMaxFailures),
      MVP_LOGIN_LOCKOUT_MS: String(config.loginLockoutMs),
      MVP_MCP_JSON: String(config.mcpJsonResponse),
      MVP_MCP_MAX_SESSIONS: String(config.mcpMaxSessions),
      MVP_MCP_SESSION_TTL_MS: String(config.mcpSessionTtlMs),
      MVP_LEDGER_REL: config.ledgerRelPath,
    };
    for (const [name, value] of Object.entries(stated)) {
      expect(documentedDefault(name), name).toBe('`' + value + '`');
    }
    // Required means the server refuses to start without it.
    for (const required of ['MVP_MEMORY_DIR', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_AUTH_STATE_PATH']) {
      expect(documentedDefault(required), required).toMatch(/required/);
    }
  });
});
