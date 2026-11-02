import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { replyTokens } from '../../src/mvp/agentMemory';
import { CalibratedIdentityProvider } from '../helpers/calibratedIdentityProvider';
import { useCurrentDriver } from '../helpers/currentDriver';

/**
 * Differential against the current merged main: floor=0 restores all 834 search_memory/get_context responses
 * on RenorBench v1/v2 byte for byte. tools/list is identical with the floor off AND at the default.
 * Export both pinned source trees, so later unrelated changes do not turn this historical differential into a false failure.
 * Index once and restore the same database at the same path; freeze time to stabilize ranking ties.
 */
/** Current main merged into this branch. */
const BASE = 'd5d2b12e9246584cdb0307c51ecc0bc1cad303d4';
/** Final default-floor product code: repin after a product-code edit, so future unrelated branches test this same pair. */
const CHANGE = '07ed0c9e453e42472c5c72b8be04d0b97cbdac40';
/** The files of engine/src this change touches: the only difference between BASE and CHANGE. */
const CHANGE_FILES = [
  'engine/src/mvp/engine.ts',
  'engine/src/mvp/hitFloor.ts',
  'engine/src/mvp/server.ts',
];
/** What the change adds to search_memory's listing, so it can be taken off to compare the rest. */

const ENGINE = path.resolve(__dirname, '../..');
const REPO = path.resolve(ENGINE, '..');
const FROZEN_NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const DAY_MS = 86_400_000;

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Why the two pinned commits cannot be compared here, or '' when they can. */
function missingCommit(): string {
  for (const sha of [BASE, CHANGE]) {
    try {
      git('cat-file', '-e', `${sha}^{commit}`);
    } catch {
      return `${sha.slice(0, 8)} is not in this checkout's history (a shallow clone?)`;
    }
  }
  return '';
}

const why = missingCommit();
const tmpDirs: string[] = [];
const mkdir = (tag: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hit-floor-off-${tag}-`));
  tmpDirs.push(dir);
  return dir;
};

/** The plugin directory engine/src imports from (hooks/inert.cjs), for a base that already has it; an older base has no such path and `git archive` refuses a missing one. */
function pluginPaths(sha: string): string[] {
  return spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${sha}:engine/claude-code-plugin`]).status === 0 ? ['engine/claude-code-plugin'] : [];
}

/** engine/src of `sha`, exported from git (nothing in the checkout is touched). */
function exportSrc(sha: string, tag: string): string {
  const dir = mkdir(tag);
  const tar = execFileSync('git', ['-C', REPO, 'archive', '--format=tar', sha, 'engine/src', ...pluginPaths(sha)], { maxBuffer: 1 << 28 });
  if (spawnSync('tar', ['-x', '-C', dir], { input: tar }).status !== 0) throw new Error(`tar could not unpack ${sha}`);
  fs.symlinkSync(path.join(ENGINE, 'node_modules'), path.join(dir, 'engine', 'node_modules'));
  const src = path.join(dir, 'engine', 'src');
  useCurrentDriver(src);
  return src;
}

interface Suite { name: string; fixture: string; questions: Array<{ id: string; query: string }> }

const suite = (name: 'v1' | 'v2'): Suite => ({
  name,
  fixture: path.join(ENGINE, 'fixtures', 'eval', `renorbench-${name}`),
  questions: fs.readFileSync(path.join(ENGINE, 'docs', 'evals', `renorbench-${name}.dev.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; query: string }),
});

/** The fixture vault, copied with every note dated as the fixture says, relative to the frozen clock. */
function copyVault(fixture: string, memoryDir: string): void {
  fs.cpSync(path.join(fixture, 'vault'), memoryDir, { recursive: true });
  const meta = JSON.parse(fs.readFileSync(path.join(fixture, 'fixture.json'), 'utf8')) as { relativeMtimeDays?: Record<string, number> };
  for (const [rel, days] of Object.entries(meta.relativeMtimeDays ?? {})) {
    const file = path.join(memoryDir, rel);
    const when = new Date(FROZEN_NOW - days * DAY_MS);
    if (fs.existsSync(file)) fs.utimesSync(file, when, when);
  }
}

const ENV_CLEARED = [
  'MVP_EMBEDDING_PROVIDER', 'MVP_EMBEDDING_DIMS', 'MVP_DB_PATH', 'MVP_MCP_JSON', 'EMBEDDING_PROVIDER', 'RENOR_NEWEST_FIRST',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_EVIDENCE_MODE', 'RENOR_EVIDENCE_MODEL', 'RENOR_EVIDENCE_CACHE', 'RENOR_EVIDENCE_BASE_URL',
  'RENOR_EVIDENCE_ASYNC', 'RENOR_EVIDENCE_API_KEY', 'RENOR_EVIDENCE_API_KEYS', 'RENOR_READ_HONESTY', 'RENOR_DIGESTS',
  'RENOR_SEARCH_HIT_FLOOR', 'RENOR_CONTEXT_RELEVANCE', 'RENOR_CONTEXT_RELEVANCE_MIN', 'RENOR_SESSION_DIVERSITY', 'RENOR_STRUCTURED_CONTEXT',
];

interface Workspace { memoryDir: string; snapshot: string }

/** `src`'s MVP server on `memoryDir`, its environment set and the clock frozen; `use` gets an MCP client. */
async function serve<T>(src: string, memoryDir: string, use: (client: Client) => Promise<T>, floor = '0'): Promise<T> {
  const { createMvpApp } = await import(path.join(src, 'mvp/server.ts'));
  const { loadMvpConfig } = await import(path.join(src, 'mvp/config.ts'));
  const authDir = mkdir('auth');
  const saved = { ...process.env };
  for (const name of ENV_CLEARED) delete process.env[name];
  Object.assign(process.env, {
    RENOR_SEARCH_HIT_FLOOR: floor,
    RENOR_TELEMETRY_DISABLED: 'true',
    RENOR_SEARCH_EVIDENCE: '0',
    MVP_EMBEDDING_PROVIDER: 'none',
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authDir, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:1',
    MVP_OWNER_EMAIL: 'off-identity@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-off-identity-123',
    MVP_PORT: '1',
    MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
  });
  vi.useFakeTimers({ now: FROZEN_NOW, toFake: ['Date'] });
  const app = createMvpApp(loadMvpConfig(), new CalibratedIdentityProvider());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverSide);
  const client = new Client({ name: 'hit-floor-off-identity', version: '0' });
  await client.connect(clientSide);
  try {
    return await use(client);
  } finally {
    await client.close();
    await app.close();
    vi.useRealTimers();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

/** The fixture indexed once (by the base tree), then snapshotted: every run starts from this exact state. */
async function indexOnce(src: string, fixture: string): Promise<Workspace> {
  const memoryDir = mkdir('workspace');
  copyVault(fixture, memoryDir);
  await serve(src, memoryDir, client => client.callTool({ name: 'index_memory', arguments: {} }));
  const snapshot = mkdir('snapshot');
  fs.cpSync(memoryDir, snapshot, { recursive: true, preserveTimestamps: true });
  return { memoryDir, snapshot };
}

interface Listed { name: string; description?: string; inputSchema: { properties?: Record<string, unknown> } }

/** Everything one tree answers for a suite's dev questions, in a comparable form. */
async function answers(src: string, ws: Workspace, questions: Suite['questions'], defaultContextOnly = false): Promise<{ lines: string[]; tools: Listed[] }> {
  fs.rmSync(ws.memoryDir, { recursive: true, force: true });
  fs.cpSync(ws.snapshot, ws.memoryDir, { recursive: true, preserveTimestamps: true });
  return serve(src, ws.memoryDir, async client => {
    const text = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return (res.content as Array<{ text: string }>)[0].text;
    };
    const lines: string[] = [];
    for (const q of questions) {
      lines.push(`get_context ${q.id} ${await text('get_context', { query: q.query })}`);
      if (defaultContextOnly) continue;
      lines.push(`search_memory ${q.id} ${await text('search_memory', { query: q.query })}`);
      lines.push(`search_memory top_k 5 history ${q.id} ${await text('search_memory', { query: q.query, top_k: 5, include_history: true })}`);
    }
    return { lines, tools: (await client.listTools()).tools as Listed[] };
  }, defaultContextOnly ? '0.63' : '0');
}

function firstDifference(a: string[], b: string[]): string {
  const at = a.findIndex((line, i) => line !== b[i]);
  if (at < 0) return a.length === b.length ? 'none' : `lengths ${a.length} vs ${b.length}`;
  const x = a[at] ?? '';
  const y = b[at] ?? '';
  let c = 0;
  while (c < x.length && x[c] === y[c]) c++;
  return `line ${at} (${x.slice(0, 60)}...) at char ${c}: base ${JSON.stringify(x.slice(Math.max(0, c - 80), c + 120))} vs change ${JSON.stringify(y.slice(Math.max(0, c - 80), c + 120))}`;
}

describe.skipIf(why !== '')(`floor disabled: the same answers as the tree it was built on${why ? ` (skipped: ${why})` : ''}`, () => {
  let baseSrc = '';
  let changeSrc = '';
  const workspaces = new Map<string, Workspace>();
  const suites = [suite('v1'), suite('v2')];
  beforeAll(async () => {
    baseSrc = exportSrc(BASE, 'base');
    changeSrc = exportSrc(CHANGE, 'change');
    for (const s of suites) workspaces.set(s.name, await indexOnce(baseSrc, s.fixture));
  }, 120_000);
  afterAll(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('the two trees differ in engine/src by exactly this change\'s files', () => {
    expect(git('diff', '--name-only', BASE, CHANGE, '--', 'engine/src').split('\n').filter(Boolean).sort()).toEqual([...CHANGE_FILES].sort());
  });

  it('every get_context and search_memory answer to the dev questions of RenorBench v1 and v2 is the same, byte for byte', async () => {
    const verdicts = new Set<boolean>();
    let expansion = false;
    for (const s of suites) {
      const before = await answers(baseSrc, workspaces.get(s.name)!, s.questions);
      const after = await answers(changeSrc, workspaces.get(s.name)!, s.questions);
      expect(before.lines.length, s.name).toBe(3 * s.questions.length);
      for (const line of before.lines.filter(l => l.startsWith('search_memory '))) {
        const body = JSON.parse(line.slice(line.indexOf('{'))) as { relevance?: { relevant: boolean }; hits: Array<{ reason: string }> };
        if (body.relevance) verdicts.add(body.relevance.relevant);
        if (body.hits.some(hit => hit.reason === 'session-expand')) expansion = true;
      }
      expect(firstDifference(before.lines, after.lines), s.name).toBe('none');
      const defaultContext = await answers(changeSrc, workspaces.get(s.name)!, s.questions, true);
      expect(firstDifference(before.lines.filter(line => line.startsWith('get_context ')), defaultContext.lines), `${s.name}: default floor leaves get_context unchanged`).toBe('none');
    }
    // The comparison is not vacuous: every question was asked three ways, the verdict said yes to some and no to others,
    // and pages held statements the session expansion added, which the change's mapping passes through.
    expect([...verdicts].sort()).toEqual([false, true]);
    expect(expansion).toBe(true);
  }, 240_000);

  it('tools/list is byte-identical to main with the floor off and at its shipped default (zero extra tokens)', async () => {
    const s = suites[0];
    const before = (await answers(baseSrc, workspaces.get(s.name)!, s.questions.slice(0, 1))).tools;
    const after = (await answers(changeSrc, workspaces.get(s.name)!, s.questions.slice(0, 1))).tools;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const entry = before.find(tool => tool.name === 'search_memory')!;
    fs.mkdirSync(path.join(REPO, '.gate'), { recursive: true });
    fs.writeFileSync(path.join(REPO, '.gate', 'hitfloor-listing-measurement.json'), JSON.stringify({ toolsBytes: Buffer.byteLength(JSON.stringify(before)), toolsTokens: replyTokens(JSON.stringify(before)), searchTokens: replyTokens(JSON.stringify(entry)), deltaBytes: 0, deltaTokens: 0 }));
    await serve(changeSrc, workspaces.get(s.name)!.memoryDir, async client => {
      delete process.env.RENOR_SEARCH_HIT_FLOOR;
      expect(JSON.stringify((await client.listTools()).tools)).toBe(JSON.stringify(before));
    });
  }, 240_000);
});
