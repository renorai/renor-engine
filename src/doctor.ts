/**
 * `renor-engine doctor`: a read-only health report for a self-hosted engine, written to be pasted into a support request.
 *
 * Read-only is the contract: the database is opened with SQLite's readonly flag (no migration, no WAL checkpoint), the ledger
 * is parsed but never replayed, client config files are read and never written, and the only network call is one
 * timeout-bounded request to the configured embedding endpoint (skipped with --offline). Every string in the report goes
 * through redact() before it is printed, so a key, token or password never reaches the output whichever check produced it.
 *
 * Each check has a stable id and, when it fails, a stable machine-readable code (DOC_*) with a one-line fix.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from './db/sqlite';
import { loadConfig, type Config } from './config.js';
import { openReadOnlyDb } from './db/client.js';
import { LATEST_SCHEMA_VERSION } from './db/migrations.js';
import { parseLedgerEvents, resolveLedgerPath } from './memory/lifecycle.js';
import { engineStatus, StatusError } from './status.js';
import { ENGINE_VERSION } from './buildIdentity.js';
import { latestVersionLine, lookupLatestVersion } from './latestVersion.js';
import { effectiveLevel, sharingDirFor } from './sharing/state.js';

export type DoctorStatus = 'pass' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  /** Stable machine-readable code; present only when status is 'fail'. */
  code?: string;
  detail: string;
  /** One line telling the user what to do; present only when status is 'fail'. */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  engineVersion: string;
  nodeVersion: string;
  platform: string;
  generatedAt: string;
  offline: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  offline?: boolean;
  /** Milliseconds the embedding reachability probe may take. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Overrides the home folder client configs are read from (tests). */
  home?: string;
  /** Replaces fetch for the latest-version lookup (tests). */
  fetchImpl?: typeof fetch;
}

/** Every failure code `doctor` can report; tests keep this list, the source and docs/self-hosting.md in step. */
export const DOCTOR_CODES: readonly string[] = [
  'DOC_CONFIG_INVALID',
  'DOC_DB_OPEN_FAILED',
  'DOC_DB_QUICK_CHECK_FAILED',
  'DOC_EMBEDDING_AUTH_REJECTED',
  'DOC_EMBEDDING_TIMEOUT',
  'DOC_EMBEDDING_UNREACHABLE',
  'DOC_INDEX_STALE',
  'DOC_INDEX_UNREADABLE',
  'DOC_LEDGER_INDEX_UNREADABLE',
  'DOC_LEDGER_MISMATCH',
  'DOC_LEDGER_MISSING',
  'DOC_LEDGER_PATH_INVALID',
  'DOC_LEDGER_UNREADABLE',
  'DOC_SCHEMA_NEWER',
  'DOC_SCHEMA_OUTDATED',
  'DOC_SCHEMA_UNREADABLE',
  'DOC_SCHEMA_UNVERSIONED',
  'DOC_SHARING_UNREADABLE',
  'DOC_VAULT_MISSING',
  'DOC_VAULT_NOT_A_FOLDER',
  'DOC_VAULT_PERMISSIONS',
  'DOC_VAULT_UNREADABLE',
  'DOC_VECTORS_INCOMPLETE',
  'DOC_VECTORS_UNREADABLE',
  'DOC_WIN_PATH_TOO_LONG',
];

// ---------------------------------------------------------------------------------------------------------------- redaction

const REDACTED = '[redacted]';

/**
 * Removes secrets from a string: OpenAI-style keys, bearer tokens, JWTs, `name=value` / `"name": "value"` pairs whose name looks
 * like a credential, URL passwords and credential-looking query parameters. Applied to the whole report, not per check.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, REDACTED)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED)
    .replace(/\b(gh[pousr]_|github_pat_|xox[abprs]-|AIza)[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/(:\/\/[^\s/@:]*:)[^\s/@]+@/g, `$1${REDACTED}@`)
    .replace(/([?&][A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|auth|signature|sig)[A-Za-z0-9_.-]*=)[^&\s"']+/gi, `$1${REDACTED}`)
    .replace(/(["']?[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["']?)[^\s"',}&]+\2/gi,
      (_m, head: string, quote: string) => `${head}${quote}${REDACTED}${quote}`);
}

function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}

// ------------------------------------------------------------------------------------------------------------------ helpers

const pass = (id: string, title: string, detail: string): DoctorCheck => ({ id, title, status: 'pass', detail });
const skip = (id: string, title: string, detail: string): DoctorCheck => ({ id, title, status: 'skip', detail });
const fail = (id: string, title: string, code: string, detail: string, fix: string): DoctorCheck => ({ id, title, status: 'fail', code, detail, fix });
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

// ------------------------------------------------------------------------------------------------------------------- checks

function checkVault(config: Config, platform: NodeJS.Platform): DoctorCheck {
  const title = 'Memory folder';
  let st: fs.Stats;
  try {
    st = fs.statSync(config.vaultPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return fail('vault', title, 'DOC_VAULT_MISSING', `${config.vaultPath} does not exist`, 'Set VAULT_PATH to your notes folder, or save a first memory so the default folder is created.');
    }
    return fail('vault', title, 'DOC_VAULT_UNREADABLE', `${config.vaultPath}: ${msg(err)}`, 'Fix the folder permissions, or point VAULT_PATH at a folder this user can read.');
  }
  if (!st.isDirectory()) {
    return fail('vault', title, 'DOC_VAULT_NOT_A_FOLDER', `${config.vaultPath} is not a folder`, 'Point VAULT_PATH at a folder, not a file.');
  }
  try {
    fs.accessSync(config.vaultPath, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch (err) {
    return fail('vault', title, 'DOC_VAULT_PERMISSIONS', `${config.vaultPath} (mode ${modeString(st.mode)}) is not readable and writable by this user: ${msg(err)}`,
      platform === 'win32' ? 'Grant this user full control of the folder, or choose another VAULT_PATH.' : `Run: chmod u+rwx "${config.vaultPath}" (or choose another VAULT_PATH).`);
  }
  const mode = platform === 'win32' ? '' : `, mode ${modeString(st.mode)}`;
  const shared = platform !== 'win32' && (st.mode & 0o007) !== 0 ? '; note: other users can access it' : '';
  return pass('vault', title, `${config.vaultPath} (readable, writable${mode})${shared}`);
}

interface DbProbe { db: Database.Database | null; checks: DoctorCheck[] }

function checkDatabase(config: Config): DbProbe {
  const checks: DoctorCheck[] = [];
  if (!fs.existsSync(config.dbPath)) {
    checks.push(pass('database', 'Index database', `${config.dbPath} does not exist yet; the first index or save creates it`));
    return { db: null, checks };
  }
  let db: Database.Database;
  try {
    db = openReadOnlyDb(config.dbPath);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    checks.push(fail('database', 'Index database', 'DOC_DB_OPEN_FAILED', `${config.dbPath} cannot be opened: ${msg(err)}`,
      'Run `renor-engine rebuild` to rebuild the index from your notes (the notes and ledger are the source of truth).'));
    return { db: null, checks };
  }
  checks.push(pass('database', 'Index database', `${config.dbPath} opens read-only`));
  try {
    const rows = db.pragma('quick_check') as { quick_check: string }[];
    const problems = rows.map(r => r.quick_check).filter(r => r !== 'ok');
    if (problems.length > 0) {
      checks.push(fail('quick_check', 'SQLite integrity', 'DOC_DB_QUICK_CHECK_FAILED', `quick_check: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`,
        'Run `renor-engine rebuild` to recreate the index from your notes.'));
    } else {
      checks.push(pass('quick_check', 'SQLite integrity', 'quick_check: ok'));
    }
  } catch (err) {
    checks.push(fail('quick_check', 'SQLite integrity', 'DOC_DB_QUICK_CHECK_FAILED', `quick_check could not run: ${msg(err)}`, 'Run `renor-engine rebuild` to recreate the index from your notes.'));
    db.close();
    return { db: null, checks };
  }
  return { db, checks };
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(name) !== undefined;
}

function checkSchema(db: Database.Database): DoctorCheck {
  const title = 'Schema version';
  try {
    if (!tableExists(db, 'schema_version')) {
      return fail('schema', title, 'DOC_SCHEMA_UNVERSIONED', 'the index has no schema_version table', 'Run `renor-engine index`: it migrates the index, or `renor-engine rebuild` to start it fresh.');
    }
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    const v = row?.version ?? 0;
    if (v > LATEST_SCHEMA_VERSION) {
      return fail('schema', title, 'DOC_SCHEMA_NEWER', `index is at v${v}, this engine knows up to v${LATEST_SCHEMA_VERSION}`, 'Upgrade renor-engine to the version that wrote this index (npm i -g renor-engine@latest).');
    }
    if (v < LATEST_SCHEMA_VERSION) {
      return fail('schema', title, 'DOC_SCHEMA_OUTDATED', `index is at v${v}, this engine expects v${LATEST_SCHEMA_VERSION}`, 'Run `renor-engine index`: it applies the pending migrations.');
    }
    return pass('schema', title, `v${v} (current)`);
  } catch (err) {
    return fail('schema', title, 'DOC_SCHEMA_UNREADABLE', msg(err), 'Run `renor-engine rebuild` to recreate the index.');
  }
}

/** Counts ledger events in the file and compares them with the events the index says it applied. Never replays. */
function checkLedger(config: Config, db: Database.Database | null): DoctorCheck {
  const title = 'Ledger replay';
  let file: string;
  try {
    file = resolveLedgerPath(config.vaultPath, config.memoryLedger);
  } catch (err) {
    return fail('ledger', title, 'DOC_LEDGER_PATH_INVALID', msg(err), 'Fix MEMORY_LEDGER: it must be a path inside the memory folder.');
  }
  let events: number | null = null;
  if (fs.existsSync(file)) {
    try {
      events = parseLedgerEvents(fs.readFileSync(file, 'utf8')).length;
    } catch (err) {
      return fail('ledger', title, 'DOC_LEDGER_UNREADABLE', `${file}: ${msg(err)}`, 'Restore the ledger from a backup or git history; do not delete it, it is the source of truth for facts.');
    }
  }
  if (db === null) return pass('ledger', title, events === null ? 'no ledger yet' : `${events} event(s) in the ledger; no index to compare with`);
  let applied = 0;
  try {
    if (tableExists(db, 'applied_ledger_events')) applied = (db.prepare('SELECT COUNT(*) AS c FROM applied_ledger_events').get() as { c: number }).c;
  } catch (err) {
    return fail('ledger', title, 'DOC_LEDGER_INDEX_UNREADABLE', msg(err), 'Run `renor-engine rebuild`.');
  }
  if (events === null) {
    return applied === 0
      ? pass('ledger', title, 'no ledger, no applied events')
      : fail('ledger', title, 'DOC_LEDGER_MISSING', `the index applied ${applied} event(s) but ${file} is gone`, 'Restore the ledger file; `renor-engine rebuild` without it would drop every saved fact.');
  }
  if (events !== applied) {
    return fail('ledger', title, 'DOC_LEDGER_MISMATCH', `ledger holds ${events} event(s), the index applied ${applied}`, 'Run `renor-engine index` (or `renor-engine rebuild`) to replay the ledger into the index.');
  }
  return pass('ledger', title, `${events} event(s) in the ledger, ${applied} applied`);
}

function checkVectors(db: Database.Database | null, config: Config): DoctorCheck {
  const title = 'Vector coverage';
  if (db === null) return skip('vectors', title, 'no index yet');
  try {
    const chunks = (db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c;
    // vec0 keeps its row ids in a plain shadow table, so no extension is needed to count them.
    const embedded = tableExists(db, 'chunk_embeddings_rowids')
      ? (db.prepare('SELECT COUNT(*) AS c FROM chunk_embeddings_rowids').get() as { c: number }).c
      : 0;
    const missing = Math.max(0, chunks - embedded);
    const detail = `${embedded} chunk(s) with embeddings, ${missing} without, of ${chunks}`;
    if (config.embeddingProvider === 'none') return pass('vectors', title, `${detail}; keyword-only search (EMBEDDING_PROVIDER=none)`);
    if (chunks > 0 && missing > 0) {
      return fail('vectors', title, 'DOC_VECTORS_INCOMPLETE', detail, 'Run `renor-engine index` to embed the missing chunks (or `renor-engine rebuild` after changing the embedding model).');
    }
    return pass('vectors', title, detail);
  } catch (err) {
    return fail('vectors', title, 'DOC_VECTORS_UNREADABLE', msg(err), 'Run `renor-engine rebuild`.');
  }
}

async function checkEmbedding(config: Config, opts: Required<Pick<DoctorOptions, 'timeoutMs'>> & { offline: boolean }): Promise<DoctorCheck> {
  const title = 'Embedding provider';
  const p = config.embeddingProvider;
  if (p === 'none') return pass('embedding', title, 'none configured: keyword-only search');
  if (p === 'eval-hash') return pass('embedding', title, 'eval-hash: offline lexical embeddings (evaluation only)');
  if (p === 'local') {
    return pass('embedding', title, `local model ${config.embeddingModel ?? 'Xenova/multilingual-e5-base'} (runs in-process, nothing to reach)`);
  }
  const base = (config.embeddingBaseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const label = `openai${config.embeddingModel ? ` model ${config.embeddingModel}` : ''} at ${base}; key ${config.openaiApiKey ? 'set' : 'missing'}`;
  if (opts.offline) return skip('embedding', title, `${label}; reachability not checked (--offline)`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${base}/models`, { method: 'GET', headers: { authorization: `Bearer ${config.openaiApiKey ?? ''}` }, signal: ctl.signal });
    if (res.status === 401 || res.status === 403) {
      return fail('embedding', title, 'DOC_EMBEDDING_AUTH_REJECTED', `${label}: HTTP ${res.status}`, 'Check OPENAI_API_KEY (and EMBEDDING_BASE_URL if you use a compatible gateway).');
    }
    return pass('embedding', title, `${label}: reachable (HTTP ${res.status})`);
  } catch (err) {
    const timedOut = ctl.signal.aborted;
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return fail('embedding', title, timedOut ? 'DOC_EMBEDDING_TIMEOUT' : 'DOC_EMBEDDING_UNREACHABLE',
      `${label}: ${timedOut ? `no answer within ${opts.timeoutMs} ms` : cause?.code ?? cause?.message ?? msg(err)}`,
      'Check your network and EMBEDDING_BASE_URL, or run with EMBEDDING_PROVIDER=none for keyword-only search.');
  } finally {
    clearTimeout(timer);
  }
}

async function checkIndexAndSharing(env: NodeJS.ProcessEnv, haveIndex: boolean): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let level: string;
  try {
    const memoryDir = (env.MVP_MEMORY_DIR ?? '').trim();
    level = effectiveLevel(sharingDirFor(memoryDir === '' ? null : memoryDir, env, undefined), env);
    checks.push(pass('sharing', 'Sharing and telemetry', `level: ${level} (change with \`renor-engine telemetry\`)`));
  } catch (err) {
    checks.push(fail('sharing', 'Sharing and telemetry', 'DOC_SHARING_UNREADABLE', msg(err), 'Run `renor-engine telemetry status`, or `renor-engine telemetry off` to reset.'));
  }
  if (haveIndex) {
    try {
      const s = await engineStatus(env);
      checks.push(s.indexCurrent
        ? pass('freshness', 'Index freshness', `${s.notes} notes, ${s.facts} facts; index matches the folder`)
        : fail('freshness', 'Index freshness', 'DOC_INDEX_STALE', `${s.staleNotes} note(s) differ from the folder`, `Run \`${s.fix ?? 'renor-engine index'}\`.`));
    } catch (err) {
      if (!(err instanceof StatusError)) throw err;
      checks.push(fail('freshness', 'Index freshness', 'DOC_INDEX_UNREADABLE', err.message, 'Run `renor-engine rebuild`.'));
    }
  }
  return checks;
}

// ------------------------------------------------------------------------------------------------------- client configs

function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i++; } else if (ch === '"') inString = false;
    } else if (ch === '"') { inString = true; out += ch; }
    else if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

interface ClientFile { client: string; file: string; kind: 'json' | 'toml'; servers: (parsed: unknown) => Record<string, unknown> }

/** The same files `cli/lib/clients.mjs` reads (claude-code, codex, cursor, opencode, gemini, pi, vscode), resolved the same way. */
export function clientConfigFiles(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string): ClientFile[] {
  const xdg = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  const vscode = platform === 'darwin' ? path.join(homeDir, 'Library', 'Application Support', 'Code', 'User')
    : platform === 'win32' ? path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Code', 'User')
    : path.join(xdg, 'Code', 'User');
  const key = (name: string) => (v: unknown) => ((v as Record<string, unknown> | null)?.[name] ?? {}) as Record<string, unknown>;
  const opencodeDir = path.join(xdg, 'opencode');
  const opencode = fs.existsSync(path.join(opencodeDir, 'opencode.jsonc')) ? 'opencode.jsonc' : 'opencode.json';
  return [
    { client: 'claude-code', file: path.join(env.CLAUDE_CONFIG_DIR || homeDir, '.claude.json'), kind: 'json', servers: key('mcpServers') },
    { client: 'codex', file: path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'config.toml'), kind: 'toml', servers: () => ({}) },
    { client: 'cursor', file: path.join(homeDir, '.cursor', 'mcp.json'), kind: 'json', servers: key('mcpServers') },
    { client: 'opencode', file: path.join(opencodeDir, opencode), kind: 'json', servers: key('mcp') },
    { client: 'gemini', file: path.join(homeDir, '.gemini', 'settings.json'), kind: 'json', servers: key('mcpServers') },
    { client: 'pi', file: path.join(homeDir, '.pi', 'agent', 'mcp.json'), kind: 'json', servers: key('mcpServers') },
    { client: 'vscode', file: path.join(vscode, 'mcp.json'), kind: 'json', servers: key('servers') },
  ];
}

/** True when an MCP entry launches this engine (command or args name renor-engine). */
function launchesEngine(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const e = entry as { command?: unknown; args?: unknown };
  const parts = [e.command, ...(Array.isArray(e.args) ? e.args : []), ...(Array.isArray(e.command) ? e.command : [])];
  return parts.some(p => typeof p === 'string' && /renor-engine/.test(p));
}

function checkClients(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string): DoctorCheck {
  const title = 'Client configs';
  const lines: string[] = [];
  let unreadable = 0;
  for (const c of clientConfigFiles(env, platform, homeDir)) {
    if (!fs.existsSync(c.file)) continue;
    let text: string;
    try { text = fs.readFileSync(c.file, 'utf8'); } catch { lines.push(`${c.client}: ${c.file} (not readable)`); unreadable++; continue; }
    if (c.kind === 'toml') {
      const lowered = text.toLowerCase();
      const hit = /\[\s*mcp_servers\s*\.\s*["']?renor["']?\s*\]/.test(lowered);
      const engine = hit && /renor-engine/.test(text);
      lines.push(`${c.client}: ${c.file} (${engine ? 'runs this engine' : hit ? 'renor entry (hosted)' : 'no renor entry'})`);
      continue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(stripJsonComments(text) || '{}'); } catch { lines.push(`${c.client}: ${c.file} (not valid JSON, not inspected)`); unreadable++; continue; }
    const servers = c.servers(parsed);
    const names = Object.keys(servers).filter(n => /renor/i.test(n) || launchesEngine(servers[n]));
    const engine = names.filter(n => launchesEngine(servers[n]));
    const state = engine.length > 0 ? `runs this engine as "${engine[0]}"` : names.length > 0 ? `renor entry "${names[0]}" (hosted)` : 'no renor entry';
    lines.push(`${c.client}: ${c.file} (${state})`);
  }
  if (lines.length === 0) return pass('clients', title, 'no client config files found');
  const note = unreadable > 0 ? ` [${unreadable} not inspected]` : '';
  return pass('clients', title, `${lines.join('; ')}${note}`);
}

// ---------------------------------------------------------------------------------------------------------------- windows

function checkWindows(config: Config, platform: NodeJS.Platform): DoctorCheck {
  const title = 'Windows notes';
  if (platform !== 'win32') return skip('windows', title, `not applicable on ${platform}`);
  const longest = Math.max(config.vaultPath.length, config.dbPath.length);
  if (longest > 200) {
    return fail('windows', title, 'DOC_WIN_PATH_TOO_LONG', `a path of ${longest} characters leaves little room under Windows' 260-character limit`, 'Move the memory folder somewhere shorter (set VAULT_PATH), or enable long paths in Windows.');
  }
  const synced = /onedrive|dropbox|google drive/i.test(config.vaultPath);
  return pass('windows', title, `directory fsync is skipped on Windows and databases are closed before files are removed (fix #1565)${synced ? '; note: the memory folder is inside a synced folder, which can lock files while it syncs' : ''}`);
}

// ------------------------------------------------------------------------------------------------------------------- driver

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const offline = options.offline === true;
  const checks: DoctorCheck[] = [];
  let config: Config | null = null;
  try {
    config = loadConfig();
    checks.push(pass('config', 'Configuration', `embedding provider: ${config.embeddingProvider}; ledger: ${config.memoryLedger}`));
  } catch (err) {
    checks.push(fail('config', 'Configuration', 'DOC_CONFIG_INVALID', msg(err), 'Fix the environment variable named in the message, then run doctor again.'));
  }
  if (config !== null) {
    const vault = checkVault(config, platform);
    checks.push(vault);
    if (vault.status === 'pass') {
      const { db, checks: dbChecks } = checkDatabase(config);
      checks.push(...dbChecks);
      try {
        if (db !== null) checks.push(checkSchema(db));
        checks.push(checkLedger(config, db));
        checks.push(checkVectors(db, config));
      } finally {
        db?.close();
      }
      const dbOk = dbChecks.every(c => c.status === 'pass');
      checks.push(await checkEmbedding(config, { offline, timeoutMs: options.timeoutMs ?? 5000 }));
      checks.push(...await checkIndexAndSharing(env, dbOk && db !== null));
    } else {
      checks.push(await checkEmbedding(config, { offline, timeoutMs: options.timeoutMs ?? 5000 }));
      checks.push(...await checkIndexAndSharing(env, false));
    }
    checks.push(checkWindows(config, platform));
  }
  const latest = await lookupLatestVersion({ env, offline, fetchImpl: options.fetchImpl });
  checks.push(pass('versions', 'Versions', `${latestVersionLine(ENGINE_VERSION, latest)}, node ${process.version}, ${platform} ${os.arch()}`));
  checks.push(checkClients(env, platform, options.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir()));
  return redactDeep({
    ok: checks.every(c => c.status !== 'fail'),
    engineVersion: ENGINE_VERSION,
    nodeVersion: process.version,
    platform: `${platform} ${os.release()}`,
    generatedAt: new Date().toISOString(),
    offline,
    checks,
  });
}

export function doctorMarkdown(r: DoctorReport): string {
  const mark: Record<DoctorStatus, string> = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };
  const out = [
    '# renor-engine doctor',
    '',
    `- engine ${r.engineVersion}, node ${r.nodeVersion}, ${r.platform}`,
    `- generated ${r.generatedAt}${r.offline ? ' (offline: network checks skipped)' : ''}`,
    `- result: **${r.ok ? 'all checks passed' : `${r.checks.filter(c => c.status === 'fail').length} check(s) failed`}**`,
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
  ];
  for (const c of r.checks) {
    out.push(`| ${c.title} | ${mark[c.status]}${c.code ? ` \`${c.code}\`` : ''} | ${c.detail.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
  }
  const failed = r.checks.filter(c => c.status === 'fail');
  if (failed.length > 0) {
    out.push('', '## Fixes', '');
    for (const c of failed) out.push(`- \`${c.code}\`: ${c.fix}`);
  }
  return `${out.join('\n')}\n`;
}
