import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { applyRelativeMtimes, hashFixture, sha256Buffer } from '../../scripts/eval/renorbench-common';
import { HASH_RELEVANCE_BAR } from '../../src/eval/renorbenchProduct';
import { buildBaseline, checkAgainstBaseline, loadRunDir } from '../../src/eval/renorbenchBaseline';
import { encodeTokens } from '../../src/indexer/tokenizer';

/**
 * The product arm of RenorBench runs the shipped `search_memory` tool in process. What this pins is what makes it fit to
 * stand in a gate: it is free (no network, no key, no model), deterministic, deaf to the caller's shell, and honest
 * about what it asked and what it left out. Each run is a child process with a whitelisted environment, as the
 * RenorBench session-expansion test does it: nothing ambient reaches the runner except what a test puts there.
 */

const ENGINE_ROOT = path.resolve(__dirname, '../..');
const PER_RUN_TIMEOUT_MS = 180_000;
const RUNNER = 'scripts/eval/run-renorbench-product.ts';
/** The bar a request that names something nothing on file mentions must clear: the product raises it (UNKNOWN_NAME_MARGIN). */
const RAISED_BAR = Math.round((HASH_RELEVANCE_BAR + 0.05) * 1000) / 1000;

const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
};

let workDir: string;
const names = { next: 0 };

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  dir: string;
  manifest: Record<string, any>;
  summary: Record<string, any>;
  results: Array<Record<string, any>>;
  files: string[];
}

/** Run the runner as a child. `preload` is extra `--import` modules, `env` is added to the whitelisted environment. */
function run(args: string[], env: Record<string, string> = {}, preload: string[] = []): Promise<Run> {
  const dir = path.join(workDir, `run-${names.next++}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...preload.flatMap(file => ['--import', file]), '--import', 'tsx', RUNNER, '--allow-dirty', '--output', dir, ...args], {
      cwd: ENGINE_ROOT,
      env: { ...BASE_ENV, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      const read = (file: string) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : '');
      const results = read('results.jsonl').split('\n').filter(Boolean).map(line => JSON.parse(line));
      resolve({
        status, stdout, stderr, dir,
        manifest: read('manifest.json') ? JSON.parse(read('manifest.json')) : {},
        summary: read('summary.json') ? JSON.parse(read('summary.json')) : {},
        results,
        files: fs.existsSync(dir) ? fs.readdirSync(dir) : [],
      });
    });
  });
}

/** What a run says apart from how long it took. */
const withoutLatency = (results: Array<Record<string, any>>) => results.map(({ latencyMs: _latencyMs, ...rest }) => rest);

let defaults: Run;

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renorbench-product-'));
  defaults = await run([]);
}, PER_RUN_TIMEOUT_MS);

afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe('the run at the shipped defaults', () => {
  it('captures fixed TOON replies after the erasure restart and counts their final text', async () => {
    const toon = await run(['--capture-replies', '--env', 'RENOR_MCP_RESPONSE=toon']);
    expect(toon.status, toon.stderr).toBe(0);
    const raw = fs.readFileSync(path.join(toon.dir, 'replies.jsonl'), 'utf8');
    expect(sha256Buffer(raw)).toBe(toon.manifest.repliesSha256);
    const searches = raw.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.tool === 'search_memory');
    expect(searches).toHaveLength(toon.manifest.caseCount);
    expect(searches.length).toBeGreaterThan(0);
    for (const [i, row] of searches.entries()) {
      const text = row.result.content[0].text;
      expect(text).toMatch(/^Format: TOON\n/);
      expect(encodeTokens(text)).toBe(toon.results[i].replyTokens);
    }
    const contentOnly = (rows: Run['results']) => rows.map(({ latencyMs: _latency, replyTokens: _tokens, ...rest }) => rest);
    expect(contentOnly(toon.results)).toEqual(contentOnly(defaults.results));
    expect(defaults.files).not.toContain('replies.jsonl');
  }, PER_RUN_TIMEOUT_MS);

  it('hash defaults produce the same replies as the explicit operator off setting', async () => {
    const off = await run(['--env', 'RENOR_SEARCH_HIT_FLOOR=0']);
    expect(off.status, off.stderr.slice(0, 600)).toBe(0);
    expect(off.manifest.productMode.overrides).toEqual(['RENOR_SEARCH_HIT_FLOOR=0']);
    expect(withoutLatency(off.results)).toEqual(withoutLatency(defaults.results));
  }, PER_RUN_TIMEOUT_MS);

  it('finishes, and says which arm it is, how it asked and what it could not measure', () => {
    expect(defaults.status, defaults.stderr.slice(0, 600)).toBe(0);
    expect(defaults.manifest).toMatchObject({
      benchmark: 'renorbench-v1-product',
      arm: 'product',
      qualityEligible: false,
      provider: { kind: 'hash' },
      caseCount: 191,
      conditions: { clockPinned: true },
      network: { blockedFetchCalls: 0, guarded: true },
      entryPoint: { kind: 'mcp-in-process', searchTool: 'search_memory', searchArguments: 'query only: top_k, scope and include_history left at the tool defaults' },
      productMode: { overrides: [], relevanceBar: { value: HASH_RELEVANCE_BAR } },
    });
    expect(defaults.manifest.warning).toContain('MUST NOT be reported as a Renor quality score');
    // The product judges by the harness bar, and by the raised one for a request that names what nothing on file mentions.
    expect(defaults.summary.productPath).toMatchObject({ replies: 191, factHitReplies: 0, evidenceReplies: 0, verdictBars: [HASH_RELEVANCE_BAR, RAISED_BAR] });
  });

  it('asks the same questions of the same data as the chunk arm', async () => {
    const fixtureDir = path.join(ENGINE_ROOT, 'fixtures/eval/renorbench-v1');
    expect(defaults.manifest.fixtureSha256).toBe(await hashFixture(fixtureDir));
    expect(defaults.manifest.casesSha256).toBe(sha256Buffer(fs.readFileSync(path.join(ENGINE_ROOT, 'docs/evals/renorbench-v1.dev.jsonl'))));
    // The same note ages, from the code both arms share: every note of the fixture has one.
    const meta = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'fixture.json'), 'utf8'));
    const copy = fs.mkdtempSync(path.join(workDir, 'vault-'));
    fs.cpSync(path.join(fixtureDir, 'vault'), copy, { recursive: true });
    await expect(applyRelativeMtimes(copy, meta)).resolves.toBeUndefined();
  });

  it('answers every case from the reply of the real tool: a window of hits, session-expansion statements, a verdict, a cost', () => {
    expect(defaults.results).toHaveLength(191);
    for (const row of defaults.results) {
      const matches = row.hits.filter((hit: { reason?: string }) => hit.reason !== 'session-expand');
      expect(matches.length, row.id).toBeGreaterThan(20); // the tool's default window is 50 since PR 1024: more than the 20 it was, over a 54-chunk vault
      expect(matches.length, row.id).toBeLessThanOrEqual(50);
      expect(row.verdict, row.id).not.toBeNull();
      expect([HASH_RELEVANCE_BAR, RAISED_BAR], row.id).toContain(row.verdict.bar);
      expect(row.replyTokens, row.id).toBeGreaterThan(500);
      // The statements the expansion adds come last, as the scorer reads them.
      const first = row.hits.findIndex((hit: { reason?: string }) => hit.reason === 'session-expand');
      if (first >= 0) expect(row.hits.slice(first).every((hit: { reason?: string }) => hit.reason === 'session-expand'), row.id).toBe(true);
    }
    // Guard against passing on nothing: the expansion fires on most replies.
    expect(defaults.summary.productPath.sessionExpandReplies).toBeGreaterThan(100);
  });

  it('reads the vault at the frozen clock: the notes a few days old are recent, which only the pinned clock says', () => {
    // The product boosts a note by how recent it is, relative to Date.now(). The fixture's ages are relative to the
    // chunk arm's EVAL_NOW, and on the real clock every one of them is months old: a run that did not pin the clock
    // would carry no recency at all, and would score a different tool.
    const recent = defaults.results.reduce((count, row) => count + row.hits.filter((hit: { reason?: string }) => /\+recency/.test(hit.reason ?? '')).length, 0);
    expect(recent).toBeGreaterThan(1000);
  });

  it('keeps erased notes out of every reply, through the delete-and-rebuild the fixture asks for', () => {
    expect(defaults.manifest.erasure).toMatchObject({ deleted: ['Erasure/zenith-notes.md', 'Erasure/old-journal.md'] });
    expect(defaults.summary.overall).toMatchObject({ forbiddenSensitiveCases: 14, forbiddenInReplyRate: 0 });
    for (const row of defaults.results) {
      expect(row.hits.some((hit: { notePath: string }) => hit.notePath.startsWith('Erasure/')), row.id).toBe(false);
    }
  });

  it('scores the run the way the check re-scores it', () => {
    const loaded = loadRunDir(defaults.dir);
    expect(JSON.stringify(loaded.summary)).toBe(JSON.stringify({ overall: stripAnnotation(defaults.summary).overall, byCategory: stripAnnotation(defaults.summary).byCategory }));
  });

  it('is a client: the only calls it makes to the product carry a query, and nothing of the case but its query', () => {
    const source = fs.readFileSync(path.join(ENGINE_ROOT, RUNNER), 'utf8');
    const calls = source.split('\n').filter(line => /workspace\.call\(/.test(line)).map(line => line.trim());
    const allowed = [
      /^let indexed = JSON\.parse\(\(await workspace\.call\('index_memory'\)\)\.text\)/,
      /^indexed = JSON\.parse\(\(await workspace\.call\('index_memory'\)\)\.text\)/,
      /^const reply = await workspace\.call\('search_memory', \{ query: test\.query, \.\.\.\(topK === undefined \? \{\} : \{ top_k: topK \}\) \}\);$/,
      // The documents suite also reads each question through get_context at its default budget: the query and a size, nothing of the case.
      /^const ctx = await workspace\.call\('get_context', \{ query: test\.query, max_tokens: DOCUMENTS_CONTEXT_MAX_TOKENS \}\);$/,
    ];
    expect(calls.length).toBe(4);
    for (const call of calls) expect(allowed.some(pattern => pattern.test(call)), call).toBe(true);
  });
});

function stripAnnotation(summary: Record<string, any>) {
  const { productPath: _productPath, ...scored } = summary;
  return scored;
}

describe('free, deterministic, and deaf to the caller\'s shell', () => {
  const secrets = ['ambient-secret-0001', 'ambient-secret-0002'];
  let polluted: Run;

  beforeAll(async () => {
    // Flags that would change the answer, keys that would reach a model, and a setting that would move the product's
    // storage: all of them in the caller's environment, none of them allowed to count.
    polluted = await run([], {
      RENOR_SESSION_EXPAND: '0',
      RENOR_CONTEXT_RELEVANCE: '0',
      RENOR_TEMPORAL_RANKING: '0',
      RENOR_SEARCH_EVIDENCE: '1',
      OLLAMA_CLOUD_KEY_1: secrets[0],
      RENOR_EVIDENCE_API_KEY: secrets[1],
      MVP_HISTORY_DIR: '/nonexistent/history',
    });
  }, PER_RUN_TIMEOUT_MS);

  it('gives the same replies as the clean run: the same hits, verdicts and token counts, run after run', () => {
    expect(polluted.status, polluted.stderr.slice(0, 600)).toBe(0);
    expect(withoutLatency(polluted.results)).toEqual(withoutLatency(defaults.results));
    expect(stripSummaryLatency(polluted.summary)).toEqual(stripSummaryLatency(defaults.summary));
  });

  it('names what it ignored, and never writes a value', () => {
    expect(polluted.manifest.ambientEnvIgnored).toEqual([
      'MVP_HISTORY_DIR', 'OLLAMA_CLOUD_KEY_1', 'RENOR_CONTEXT_RELEVANCE', 'RENOR_EVIDENCE_API_KEY', 'RENOR_SEARCH_EVIDENCE', 'RENOR_SESSION_EXPAND', 'RENOR_TEMPORAL_RANKING',
    ]);
    expect(defaults.manifest.ambientEnvIgnored).toEqual([]);
    const everything = [polluted.stdout, polluted.stderr, ...polluted.files.map(file => fs.readFileSync(path.join(polluted.dir, file), 'utf8'))].join('\n');
    for (const secret of secrets) expect(everything).not.toContain(secret);
    expect(polluted.manifest.productMode.overrides).toEqual([]);
  });

  it('fails the run when anything in the product tries the network, instead of reaching for it', async () => {
    const probe = path.join(workDir, 'network-probe.mjs');
    // A call to fetch made while the run is going on, as a model client inside the product would make it.
    fs.writeFileSync(probe, [
      'const timer = setInterval(() => {',
      "  if (globalThis.fetch.name === 'fetch') return; // the runner has not closed the network yet",
      '  clearInterval(timer);',
      "  try { globalThis.fetch('http://127.0.0.1:9/'); } catch { /* the guard throws */ }",
      '}, 10);',
      'timer.unref();',
    ].join('\n'));
    const probed = await run([], {}, [probe]);
    expect(probed.status).toBe(1);
    expect(probed.stderr).toContain('tried 1 network call(s)');
  }, PER_RUN_TIMEOUT_MS);
});

function stripSummaryLatency(summary: Record<string, any>) {
  const strip = (map: Record<string, unknown>) => Object.fromEntries(Object.entries(map).filter(([key]) => !/LatencyMs$/.test(key)));
  const scored = stripAnnotation(summary);
  return { overall: strip(scored.overall), byCategory: Object.fromEntries(Object.entries(scored.byCategory as Record<string, Record<string, unknown>>).map(([name, map]) => [name, strip(map)])), productPath: summary.productPath };
}

describe('a flag armed on purpose is recorded, and moves the identity of the run', () => {
  let armed: Run;

  beforeAll(async () => {
    armed = await run(['--env', 'RENOR_SESSION_EXPAND=0']);
  }, PER_RUN_TIMEOUT_MS);

  it('records the flag, and the product answers by it', () => {
    expect(armed.status, armed.stderr.slice(0, 600)).toBe(0);
    expect(armed.manifest.productMode.overrides).toEqual(['RENOR_SESSION_EXPAND=0']);
    expect(armed.summary.productPath.sessionExpandReplies).toBe(0);
    expect(armed.summary.overall.meanReplyTokens).toBeLessThan(defaults.summary.overall.meanReplyTokens);
  });

  it('is not held to the baseline of the defaults: the check says it was not made the same way', () => {
    // Isolate the flag identity from changes to the evaluator itself (such as adding reply capture).
    const baseline = buildBaseline({ run: loadRunDir(defaults.dir), reason: 'test defaults', recordedAt: '2026-10-27' });
    expect(checkAgainstBaseline(baseline, loadRunDir(defaults.dir)).ok).toBe(true);
    const check = checkAgainstBaseline(baseline, loadRunDir(armed.dir));
    expect(check).toMatchObject({ ok: false, verdict: 'INCOMPARABLE' });
    expect(check.problem).toContain('the run was not made the way the baseline was');
    expect(check.problem).toContain('productMode');
  });

  it('refuses what an ablation may not arm: a key, a non-product variable, the verdict bar', async () => {
    for (const flag of ['OLLAMA_API_KEY=x', 'RENOR_EVIDENCE_API_KEY=x', 'RENOR_AUTH_TOKEN=x', 'RENOR_ACCESSTOKEN=x', 'MVP_HISTORY_DIR=/x', 'RENOR_CONTEXT_RELEVANCE_MIN=0.1', 'RENOR_SESSION_EXPAND']) {
      const refused = await run(['--env', flag]);
      expect(refused.status, flag).toBe(1);
      expect(refused.stderr, flag).toMatch(/--env takes NAME=VALUE for a RENOR_ product flag|--relevance-bar/);
      expect(refused.files, `${flag} must leave nothing behind`).toEqual([]);
    }
  }, PER_RUN_TIMEOUT_MS);
});

describe('a count flag is not a credential: a TOKENS name can be armed, a TOKEN name cannot', () => {
  let limited: Run;
  let conversationOnly: Run;

  beforeAll(async () => {
    // A limit of one token admits no statement, so this is also the positive control of the flag: the product answers by it.
    // RenorBench v1 holds notes shaped like documents, so a limit of one token stops the expansion only when both limits are armed.
    limited = await run(['--env', 'RENOR_SESSION_EXPAND_STATEMENT_TOKENS=1', '--env', 'RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS=1']);
    conversationOnly = await run(['--env', 'RENOR_SESSION_EXPAND_STATEMENT_TOKENS=1']);
  }, 2 * PER_RUN_TIMEOUT_MS);

  it('arms RENOR_SESSION_EXPAND_STATEMENT_TOKENS, records it, and the expansion stops adding statements', () => {
    expect(limited.status, limited.stderr.slice(0, 600)).toBe(0);
    expect(limited.manifest.productMode.overrides).toEqual(['RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS=1', 'RENOR_SESSION_EXPAND_STATEMENT_TOKENS=1']);
    expect(defaults.summary.productPath.sessionExpandReplies).toBeGreaterThan(100);
    expect(limited.summary.productPath.sessionExpandReplies).toBe(0);
    expect(limited.summary.overall.meanReplyTokens).toBeLessThan(defaults.summary.overall.meanReplyTokens);
    // The conversation limit alone leaves the document-shaped notes of this vault as they were.
    expect(conversationOnly.status, conversationOnly.stderr.slice(0, 600)).toBe(0);
    expect(conversationOnly.summary.productPath.sessionExpandReplies).toBe(defaults.summary.productPath.sessionExpandReplies);
  });
});

describe('what the arm will not run on', () => {
  it('never runs a local embedding model, and leaves nothing behind when it refuses one', async () => {
    const refused = await run(['--provider', 'local']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('never a local model');
    expect(refused.files).toEqual([]);
  }, PER_RUN_TIMEOUT_MS);
});
