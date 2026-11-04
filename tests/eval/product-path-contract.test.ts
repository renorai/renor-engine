import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertNoSidecarFlags,
  assertProductScoreEligibility,
  assertGoldIsolatedRuntimeInputs,
  MANIFEST_CONTRACT_VERSION,
  PRODUCT_RUNTIME_FIELD_ALLOWLIST,
  SIDECAR_FLAGS,
  validateTruthFields,
  type ManifestTruthFields,
} from '../../src/eval/runManifest';
import { assembleClientContext, cliPublicSearch, parseIndexErrors, ProductPreconditionError, runProductBenchmark, type ProductHooks, type PublicHit } from '../../scripts/eval/run-longmemeval-product';
import { createEmbedProxy, classifyInput, type EmbeddingUpstream, type EmbedProxyStats } from '../../scripts/eval/embed-proxy';

const REPO_ROOT = process.cwd();

// Cases that start `tsx` (the product runner or the scorer CLI) cost 0.3-1.2s of CPU each (measured: the CPU of the
// spawned process tree, 3 runs). Their budget is 20x the slowest, rounded up to 5s, so a case still passes while its
// process tree gets about 5% of one core. Vitest's 5s default is wall time, which only says how busy the host is.
const SPAWN_BUDGET_MS = 25_000;

// ─── Static trust-boundary scans (a, b) ───

const productRunnerSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts/eval/run-longmemeval-product.ts'), 'utf8');

/** All static `from '<specifier>'` import specifiers in a source file. */
function importSpecifiersOf(source: string): string[] {
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
}

describe('product-path contract: static import boundary', () => {
  // NOTE (residual risk, recorded): this scan covers static `from` specifiers;
  // dynamic import() evasion is not covered. The current runner is all-static —
  // if a future arm adds dynamic imports, extend importSpecifiersOf accordingly.
  it('the authoritative product runner imports only src/eval measurement infra, node builtins, and CLI deps', () => {
    const specifiers = importSpecifiersOf(productRunnerSource);
    expect(specifiers.length).toBeGreaterThan(0);
    const allowedPackages = ['commander', 'gpt-tokenizer'];
    for (const specifier of specifiers) {
      const allowed = specifier.startsWith('node:')
        || allowedPackages.includes(specifier)
        || /^(\.\.\/)+src\/eval\//.test(specifier);
      if (!allowed) throw new Error(`Forbidden import in the product runner: ${specifier}`);
    }
  });

  it('the product runner never references scripts/night or src internals by path', () => {
    // Only executable import/require references count; prose comments that
    // describe the prohibition are not violations.
    const references = [
      ...importSpecifiersOf(productRunnerSource),
      ...[...productRunnerSource.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]),
    ];
    for (const reference of references) {
      expect(reference).not.toMatch(/scripts\/night/);
      expect(reference).not.toMatch(/src\/(indexer|retrieval|mvp|evidence|db|embeddings|mcp|api|extraction|memory|watcher|conversation|context)\b/);
    }
  });
});

describe('product-path contract: scripts/night isolation', () => {
  it('no file under src/ imports scripts/night', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const offenders = walk(path.join(REPO_ROOT, 'src'))
      .filter(file => fs.readFileSync(file, 'utf8').includes('scripts/night'));
    expect(offenders).toEqual([]);
  });
});

// ─── Sidecar refusal (c) ───

describe('product-path contract: research sidecar flags are refused for product-public execution', () => {
  it('assertNoSidecarFlags rejects every registered sidecar flag', () => {
    for (const flag of SIDECAR_FLAGS) {
      expect(() => assertNoSidecarFlags(['--dataset', 'd', flag])).toThrow(/Refused for product-public execution/);
    }
    expect(() => assertNoSidecarFlags(['--dataset', 'd'])).not.toThrow();
  });

  it('the product runner CLI exits non-zero on a sidecar flag', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval/run-longmemeval-product.ts', '--dataset', 'x', '--output', 'y', '--facts-file', 'gold.json'], { encoding: 'utf8', cwd: REPO_ROOT });
    expect(run.status).not.toBe(0);
    expect((run.stderr + run.stdout)).toMatch(/sidecar|Unknown option/i);
  }, SPAWN_BUDGET_MS);
});

// ─── Gold isolation (d) — poisoned fixture parity through the REAL public CLI ───

interface TinyRow {
  question_id: string; question_type: string; question: string; answer: string;
  question_date: string; haystack_session_ids: string[]; haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>; answer_session_ids: string[];
}

function baseRow(): TinyRow {
  return {
    question_id: 'q_smoke_1',
    question_type: 'single_session_user',
    question: 'What does Alex drink in the morning?',
    answer: 'mango juice',
    question_date: '2026/02/01 (Sun) 09:00',
    haystack_session_ids: ['sess-1', 'noise-1'],
    haystack_dates: ['2026/01/01 (Thu) 10:00', '2025/12/01 (Mon) 09:00'],
    haystack_sessions: [
      [
        { role: 'user', content: 'Alex drinks mango juice every morning.' },
        { role: 'assistant', content: 'Noted.' },
      ],
      [
        { role: 'user', content: 'Completely unrelated noise content for retrieval contrast.' },
      ],
    ],
    answer_session_ids: ['sess-1'],
  };
}

const stubModels = (captured: Array<{ callType: string; requestBody: Record<string, unknown> }>): ProductHooks['models'] => ({
  async modelCall(callType, requestBody) {
    captured.push({ callType, requestBody });
    if (callType === 'answer') {
      return { rawContent: 'mango juice', modelEcho: 'stub-answer-model', finishReason: 'stop', promptTokens: 10, completionTokens: 2, latencyMs: 1 };
    }
    return { rawContent: '1', modelEcho: 'stub-judge-model', finishReason: 'stop', promptTokens: 10, completionTokens: 1, latencyMs: 1 };
  },
  async sentinel() { /* stub: tests must never make provider calls */ },
});

describe('product-path contract: gold isolation through the real public CLI surface', () => {
  it('mutating gold fields never changes the public-surface output or the marshaled runtime inputs', async () => {
    const clean = baseRow();
    const poisoned: TinyRow = {
      ...clean,
      answer: 'POISON-GOLD-999 the answer is POISON-GOLD-999',
      question_type: 'poisoned_category',
      answer_session_ids: ['noise-1', 'sess-1'],
    };

    const capturedByFixture: Array<Array<{ callType: string; requestBody: Record<string, unknown> }>> = [];
    const results: Array<{
      manifest: Record<string, unknown>;
      cases: Array<{ runtimeInputSha256: string; hitsUsed: number; contextTokens: number }>;
    }> = [];
    for (const row of [clean, poisoned]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-poison-'));
      try {
        const datasetPath = path.join(root, 'dataset.json');
        await fsp.writeFile(datasetPath, JSON.stringify([row]));
        const outputDir = path.join(root, 'out');
        const captured: Array<{ callType: string; requestBody: Record<string, unknown> }> = [];
        capturedByFixture.push(captured);
        const hooks: ProductHooks = { publicSearch: cliPublicSearch, models: stubModels(captured) };
        const result = await runProductBenchmark({
          dataset: datasetPath, output: outputDir, topK: 20, limit: 0, offset: 0,
          shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
          embeddingProvider: 'eval-hash', arm: 'promotion', maxLiveCalls: 25, cache: false,
          answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
          apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
        }, hooks);
        const manifest = result.manifest;
        // The runner really used the public CLI surface.
        expect(manifest.publicEntryPoint).toBe('cli');
        expect((manifest.entryPointDetail as { transport: string }).transport).toBe('cli-subprocess');
        expect((manifest.entryPointDetail as { command: string }).command).toContain('src/cli.ts');
        expect(manifest.executionKind).toBe('product-public');
        expect(manifest.goldIsolated).toBe(true);
        // Manifest contract fields are internally valid.
        expect(validateTruthFields(manifest)).toEqual([]);
        results.push({
          manifest,
          cases: result.cases.map(c => ({ runtimeInputSha256: c.runtimeInputSha256, hitsUsed: c.hitsUsed, contextTokens: c.contextTokens })),
        });
        // The public surface actually returned retrieval hits (real product path ran).
        expect(result.cases[0].hitsUsed).toBeGreaterThan(0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }

    // Gold mutation parity: runtime inputs and public output are identical.
    expect(results[0].cases).toEqual(results[1].cases);

    // The poisoned gold answer must never appear in the answer request body.
    for (const captured of capturedByFixture) {
      const answerBody = JSON.stringify(captured.find(call => call.callType === 'answer')!.requestBody);
      expect(answerBody).not.toContain('POISON-GOLD-999');
      expect(answerBody).not.toContain('poisoned_category');
    }
    // Both fixtures sent the SAME answer prompt (gold-blind runtime).
    expect(
      JSON.stringify(capturedByFixture[0].find(call => call.callType === 'answer')!.requestBody),
    ).toEqual(JSON.stringify(capturedByFixture[1].find(call => call.callType === 'answer')!.requestBody));
  }, 120_000);

  it('the structural marshal check refuses gold field names in runtime inputs', () => {
    expect(() => assertGoldIsolatedRuntimeInputs({ query: 'q', argv: ['--shouldAbstain=true'], env: {} })).toThrow(/gold field/i);
    expect(() => assertGoldIsolatedRuntimeInputs({ query: 'q', argv: [], env: { ANSWER_SESSION_IDS: 'x' } })).toThrow(/gold field/i);
    expect(() => assertGoldIsolatedRuntimeInputs({ query: 'what is the answer', argv: ['src/cli.ts', 'search'], env: { VAULT_PATH: '/tmp/v' } })).not.toThrow();
  });
});

describe('product-path contract: mechanical run preconditions (the 1/10 smoke lesson)', () => {
  it('parseIndexErrors matches the literal CLI summary format (healthy, errored, missing)', () => {
    expect(parseIndexErrors('[index] 2/2 files (0 errors)\nDone. 2/2 indexed, 0 errors.')).toEqual({ indexed: 2, total: 2, errors: 0 });
    expect(parseIndexErrors('[index] 2/2 files (2 errors)\nDone. 0/2 indexed, 2 errors.')).toEqual({ indexed: 0, total: 2, errors: 2 });
    expect(parseIndexErrors('no summary line at all')).toEqual({ indexed: -1, total: -1, errors: -1 });
  });

  it('a partial index aborts the run through the exit status too, not only the summary line (#188)', async () => {
    // The index command exits non-zero on a per-file error since #188, so the
    // spawn rejects before the summary is parsed. That rejection has to stay a
    // ProductPreconditionError: a raw Error is caught by the per-case handler,
    // recorded as one case's error, and the run keeps scoring the incomplete
    // vault — the failure the precondition exists to prevent.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-index-precond-'));
    try {
      const vaultDir = path.join(root, 'vault');
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(path.join(vaultDir, 'good.md'), '# Good note\n\nNothing special.\n');
      // Unterminated YAML flow sequence: gray-matter throws inside indexFile.
      fs.writeFileSync(
        path.join(vaultDir, 'broken.md'),
        '---\nkind: session\ntags: [a, b\n---\n# Broken\n\nBad frontmatter.\n',
      );
      const run = cliPublicSearch({
        query: 'nothing special',
        vaultDir,
        dbPath: path.join(root, 'index.db'),
        env: {
          VAULT_PATH: vaultDir,
          DB_PATH: path.join(root, 'index.db'),
          EMBEDDING_PROVIDER: 'eval-hash',
          LLM_EXTRACTION: 'false',
          // A lane flag left armed in an operator's shell must not turn this
          // case into a different abort ("armed without a provider").
          RENOR_TYPED_FACTS: '',
          RENOR_CHRONICLE: '',
          RENOR_PREFS: '',
        },
        topK: 20,
        cwd: path.resolve(__dirname, '..', '..'),
      });
      await expect(run).rejects.toThrow(ProductPreconditionError);
      // ...and it is the partial-index failure, not some other abort: the
      // rejection names the note whose parse failed.
      await expect(run).rejects.toThrow(/broken\.md/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('context-dates renders session_date lines and answer-style switches the instruction (arm options are mechanical, not vibes)', () => {
    const hits: PublicHit[] = [
      { notePath: 'Sessions/a.md', text: 'I spent 45 USD on lunch.', score: 1, session_date: '2024-01-15T00:00:00.000Z' },
      { notePath: 'Sessions/b.md', text: 'I ran 12 miles.', score: 0.9 },
    ];
    const withDates = assembleClientContext(hits, 6000, { contextDates: true });
    expect(withDates.context).toContain('Session date: 2024-01-15T00:00:00.000Z');
    expect(withDates.context).toContain('[Excerpt 1]');
    // Undated hits render without a date line (unknown stays unknown).
    expect(withDates.context).not.toContain('Session date: undefined');
    const withoutDates = assembleClientContext(hits, 6000);
    expect(withoutDates.context).not.toContain('Session date:');
    // Byte-identical default: baseline assembly unchanged when the flag is off.
    expect(withoutDates.context).toBe('[Excerpt 1]\nI spent 45 USD on lunch.\n\n[Excerpt 2]\nI ran 12 miles.');
  });

  it('promotion seeds the canonical pool — a subsequent iteration arm REPLAYS the recordings (two-run proof), and within-run duplicates abort', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-seed-'));
    const prevScope = process.env.RENOR_QA_CACHE_SCOPE;
    process.env.RENOR_QA_CACHE_SCOPE = 'product-path-v1-seed-test';
    try {
      const hooks: ProductHooks = {
        publicSearch: async () => ({ hits: [{ notePath: 'Sessions/sess-1.md', text: 'Alex drinks mango juice every morning.', score: 1 }], transport: 'stub', command: 'stub', durationMs: 0 }),
        models: stubModels([]),
      };
      const base = { topK: 20, limit: 0, offset: 0, shardIndex: 0, shardCount: 1, maxContextTokens: 6000, embeddingProvider: 'openai', answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub', apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1 } as const;
      const cacheDb = path.join(root, 'pool.db');

      // Run 1: promotion, fresh cacheDir, pinned scope → zero reads by construction,
      // and the write-through must ACTUALLY seed the DB under the pinned scope.
      const dataset1 = path.join(root, 'dataset1.json');
      await fsp.writeFile(dataset1, JSON.stringify([baseRow()]));
      const promo = await runProductBenchmark({ ...base, dataset: dataset1, output: path.join(root, 'out-promo'), arm: 'promotion', maxLiveCalls: 25, cache: true, cacheDir: cacheDb }, hooks);
      const promoCache = promo.manifest.cache as { reads: number; hits: number; writes: number; dbPath: string };
      expect(promoCache.hits).toBe(0);
      expect(promoCache.writes).toBeGreaterThan(0);
      expect(fs.existsSync(cacheDb)).toBe(true);

      // Run 2: iteration arm, SAME scope + SAME DB + same stub question → the
      // recordings must REPLAY (hits > 0). This is the entire purpose of the
      // write-through seeding, verified rather than assumed.
      const iter = await runProductBenchmark({ ...base, dataset: dataset1, output: path.join(root, 'out-iter'), arm: 'iteration' as const, cache: true, cacheDir: cacheDb }, hooks);
      const iterCache = iter.manifest.cache as { reads: number; hits: number; writes: number };
      expect(iterCache.hits).toBeGreaterThan(0);

      // Within-run duplicate decision, encoded: two identical questions in ONE
      // promotion run → the second reads the first's write → a promotion hit →
      // abort. Promotion means every answer is a fresh draw; a replay inside the
      // authoritative run is a defect, not a convenience.
      const dupRow = { ...baseRow(), question_id: 'q_smoke_1_dup' };
      const dataset2 = path.join(root, 'dataset2.json');
      await fsp.writeFile(dataset2, JSON.stringify([baseRow(), dupRow]));
      const cacheDb2 = path.join(root, 'pool2.db');
      await expect(runProductBenchmark({ ...base, dataset: dataset2, output: path.join(root, 'out-dup'), arm: 'promotion', maxLiveCalls: 25, cache: true, cacheDir: cacheDb2 }, hooks)).rejects.toThrow(/cache HIT/);
    } finally {
      if (prevScope === undefined) delete process.env.RENOR_QA_CACHE_SCOPE;
      else process.env.RENOR_QA_CACHE_SCOPE = prevScope;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('promotion resume: judge-failed cases retry forced-live (guard cannot deadlock); foreign DB refuses', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-resume-'));
    const prevScope = process.env.RENOR_QA_CACHE_SCOPE;
    process.env.RENOR_QA_CACHE_SCOPE = 'product-path-v1-resume-test';
    try {
      const datasetPath = path.join(root, 'dataset.json');
      await fsp.writeFile(datasetPath, JSON.stringify([baseRow()]));
      const cacheDb = path.join(root, 'pool.db');
      const goodHooks: ProductHooks = {
        publicSearch: async () => ({ hits: [{ notePath: 'Sessions/sess-1.md', text: 'Alex drinks mango juice every morning.', score: 1 }], transport: 'stub', command: 'stub', durationMs: 0 }),
        models: stubModels([]),
      };
      const base = { dataset: datasetPath, topK: 20, limit: 0, offset: 0, shardIndex: 0, shardCount: 1, maxContextTokens: 6000, embeddingProvider: 'openai', answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub', apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1 } as const;

      // Run 1: JUDGE fails after the answer succeeded — the answer IS written to
      // the cache. This is the deadlock class: a naive retry would read its own
      // cached answer back → promotion zero-hit guard aborts forever.
      let judgeFailed = false;
      const judgeFailHooks: ProductHooks = {
        ...goodHooks,
        models: {
          async modelCall(callType: 'answer' | 'judge', requestBody: Record<string, unknown>) {
            if (callType === 'judge' && !judgeFailed) {
              judgeFailed = true;
              throw new Error('API failed after 1 attempts: simulated judge abort');
            }
            return stubModels([]).modelCall(callType, requestBody);
          },
          async sentinel() { /* stub: tests must never make provider calls */ },
        },
      };
      const partial = await runProductBenchmark({ ...base, output: path.join(root, 'out'), arm: 'promotion', maxLiveCalls: 25, cache: true, cacheDir: cacheDb }, judgeFailHooks);
      expect((partial.manifest.coverage as { answerErrors: number }).answerErrors).toBe(0);
      expect((partial.manifest.coverage as { judgeParseFailures: number }).judgeParseFailures + (partial.cases.filter(c => c.error).length)).toBeGreaterThan(0);

      // Resume with good hooks: the errored case is retried FORCED-LIVE (its
      // own cached answer from run 1 is NOT read) → completes with zero hits.
      const resumed = await runProductBenchmark({ ...base, output: path.join(root, 'out'), arm: 'promotion', maxLiveCalls: 25, cache: true, cacheDir: cacheDb }, goodHooks);
      expect((resumed.manifest.cache as { hits: number }).hits).toBe(0);
      expect(resumed.cases.filter(c => !c.error).length).toBe(1);
      // The retry made two real calls (answer + judge) without a single cache lookup, so counting misses reports 0.
      expect(JSON.parse(fs.readFileSync(path.join(root, 'out', 'cache-report.json'), 'utf8')).liveProviderCalls).toBe(2);
      // The checkpoint was compacted: exactly one row per id (no double-count).
      const checkpointRows = fs.readFileSync(path.join(root, 'out', 'qa-cases.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      expect(checkpointRows.length).toBe(1);

      // Foreign DB: an existing cache DB whose output dir does not provably
      // belong to this run must be refused — --cache-dir must not become a
      // general bypass of the leftover-DB guard.
      const foreignOut = path.join(root, 'foreign-out');
      fs.mkdirSync(foreignOut);
      fs.writeFileSync(path.join(foreignOut, 'qa-cases.jsonl'), JSON.stringify({ id: 'q_foreign_999' }) + '\n');
      const foreignDb = path.join(root, 'foreign.db');
      fs.writeFileSync(foreignDb, 'leftover');
      await expect(runProductBenchmark({ ...base, output: foreignOut, arm: 'promotion', maxLiveCalls: 25, cache: true, cacheDir: foreignDb }, goodHooks)).rejects.toThrow(/foreign/);
    } finally {
      if (prevScope === undefined) delete process.env.RENOR_QA_CACHE_SCOPE;
      else process.env.RENOR_QA_CACHE_SCOPE = prevScope;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the live-call budget is a hard cap: a run aborts at its declared budget, not beyond it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-budget-'));
    const prevScope = process.env.RENOR_QA_CACHE_SCOPE;
    process.env.RENOR_QA_CACHE_SCOPE = 'product-path-v1-budget-test';
    try {
      const datasetPath = path.join(root, 'dataset.json');
      await fsp.writeFile(datasetPath, JSON.stringify([baseRow()]));
      const hooks: ProductHooks = {
        publicSearch: async () => ({ hits: [{ notePath: 'Sessions/sess-1.md', text: 'Alex drinks mango juice every morning.', score: 1 }], transport: 'stub', command: 'stub', durationMs: 0 }),
        models: stubModels([]),
      };
      // Budget 1: the answer consumes it; the judge exceeds → hard abort.
      await expect(runProductBenchmark({
        dataset: datasetPath, output: path.join(root, 'out'), topK: 20, limit: 0, offset: 0,
        shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
        embeddingProvider: 'openai', arm: 'promotion', cache: true, cacheDir: path.join(root, 'pool.db'),
        maxLiveCalls: 1,
        answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
        apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
      }, hooks)).rejects.toThrow(/budget exceeded/);
    } finally {
      if (prevScope === undefined) delete process.env.RENOR_QA_CACHE_SCOPE;
      else process.env.RENOR_QA_CACHE_SCOPE = prevScope;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a live second invocation of the same output dir is refused (run lock); a stale lock is recovered', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-runlock-'));
    const prevScope = process.env.RENOR_QA_CACHE_SCOPE;
    process.env.RENOR_QA_CACHE_SCOPE = 'product-path-v1-lock-test';
    try {
      const outDir = path.join(root, 'out');
      fs.mkdirSync(outDir);
      // Resume-mode fixture: a checkpoint row makes this a resumable output dir
      // (fresh runs would hit claimDirectory's exclusive-claim EEXIST first).
      fs.writeFileSync(path.join(outDir, 'qa-cases.jsonl'), JSON.stringify({ id: 'q_smoke_1' }) + '\n');
      const aliveLock = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n';
      fs.writeFileSync(path.join(outDir, '.run.lock'), aliveLock);
      const datasetPath = path.join(root, 'dataset.json');
      await fsp.writeFile(datasetPath, JSON.stringify([baseRow()]));
      const hooks: ProductHooks = {
        publicSearch: async () => ({ hits: [{ notePath: 'Sessions/sess-1.md', text: 'hit', score: 1 }], transport: 'stub', command: 'stub', durationMs: 0 }),
        models: stubModels([]),
      };
      const base = { dataset: datasetPath, topK: 20, limit: 0, offset: 0, shardIndex: 0, shardCount: 1, maxContextTokens: 6000, embeddingProvider: 'openai', answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub', apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1 };
      // Live owner (this very process) → refused.
      await expect(runProductBenchmark({ ...base, output: outDir, arm: 'promotion', maxLiveCalls: 25, cache: false }, hooks)).rejects.toThrow(/another run owns/);
      // Stale (corrupt) lock → recovered: run proceeds and completes.
      fs.writeFileSync(path.join(outDir, '.run.lock'), '{corrupt');
      const result = await runProductBenchmark({ ...base, output: outDir, arm: 'promotion', maxLiveCalls: 25, cache: false }, hooks);
      expect(result.manifest.executionKind).toBe('product-public');
      // Lock released on completion.
      expect(fs.existsSync(path.join(outDir, '.run.lock'))).toBe(false);
    } finally {
      if (prevScope === undefined) delete process.env.RENOR_QA_CACHE_SCOPE;
      else process.env.RENOR_QA_CACHE_SCOPE = prevScope;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('promotion arms require a fresh --cache-dir (write-through, zero reads by construction) and refuse leftover DBs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-promo-cache-'));
    const prevScope = process.env.RENOR_QA_CACHE_SCOPE;
    try {
      const datasetPath = path.join(root, 'dataset.json');
      await fsp.writeFile(datasetPath, JSON.stringify([baseRow()]));
      const staleDb = path.join(root, 'stale.db');
      fs.writeFileSync(staleDb, 'leftover');
      const hooks: ProductHooks = {
        publicSearch: async () => ({ hits: [{ notePath: 'Sessions/sess-1.md', text: 'hit', score: 1 }], transport: 'stub', command: 'stub', durationMs: 0 }),
        models: stubModels([]),
      };
      const base = { dataset: datasetPath, topK: 20, limit: 0, offset: 0, shardIndex: 0, shardCount: 1, maxContextTokens: 6000, embeddingProvider: 'openai', answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub', apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1 };

      // No --cache-dir → refused (config check).
      await expect(runProductBenchmark({ ...base, output: path.join(root, 'out1'), arm: 'promotion', maxLiveCalls: 25, cache: true }, hooks)).rejects.toThrow(/require --cache-dir/);

      // No pinned scope → refused (writes must seed the canonical pool).
      await expect(runProductBenchmark({ ...base, output: path.join(root, 'out2'), arm: 'promotion', maxLiveCalls: 25, cache: true, cacheDir: path.join(root, 'fresh2.db') }, hooks)).rejects.toThrow(/pinned RENOR_QA_CACHE_SCOPE/);

      // Leftover DB with a FRESH output dir (no checkpoint) → refused by the
      // identity gate: the DB does not provably belong to this run.
      process.env.RENOR_QA_CACHE_SCOPE = 'product-path-v1-fresh-test';
      await expect(runProductBenchmark({ ...base, output: path.join(root, 'out3'), arm: 'promotion', maxLiveCalls: 25, cache: true, cacheDir: staleDb }, hooks)).rejects.toThrow(/provably belong to this run/);
    } finally {
      if (prevScope === undefined) delete process.env.RENOR_QA_CACHE_SCOPE;
      else process.env.RENOR_QA_CACHE_SCOPE = prevScope;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a zero-hit retrieval precondition aborts the run instead of scoring an empty case', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-precond-'));
    try {
      const datasetPath = path.join(root, 'dataset.json');
      await fsp.writeFile(datasetPath, JSON.stringify([baseRow()]));
      const hooks: ProductHooks = {
        publicSearch: async () => ({ hits: [], transport: 'stub', command: 'stub', durationMs: 0 }),
        models: stubModels([]),
      };
      await expect(runProductBenchmark({
        dataset: datasetPath, output: path.join(root, 'out'), topK: 20, limit: 0, offset: 0,
        shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
        embeddingProvider: 'openai', arm: 'promotion', maxLiveCalls: 25, cache: false,
        answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
        apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
      }, hooks)).rejects.toThrow(ProductPreconditionError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Scorer refusals (e) ───

// The declared truth fields plus the two keys assertProductScoreEligibility reads off the manifest
// through a cast (src/eval/runManifest.ts), which ManifestTruthFields does not declare.
type EligibleManifest = ManifestTruthFields & { embeddingProvider: string; transportSmoke: boolean };

function validTruthFields(overrides: Partial<EligibleManifest> = {}): EligibleManifest {
  return {
    manifestContractVersion: MANIFEST_CONTRACT_VERSION,
    executionKind: 'product-public',
    publicEntryPoint: 'cli',
    entryPointDetail: { transport: 'cli-subprocess', command: 'node --import tsx src/cli.ts search --json --top-k 20 <query>' },
    runtimeVisibleFieldAllowlist: [...PRODUCT_RUNTIME_FIELD_ALLOWLIST],
    goldIsolated: true,
    productMode: { defaults: 'shipped defaults', overrides: [] },
    composition: { arms: ['promotion'], live: 2, cacheHits: 0, mergedFrom: null },
    coverage: { casesTotal: 1, casesCompleted: 1, answerErrors: 0, judgeParseFailures: 0, failedRunRecorded: false },
    embeddingProvider: 'openai',
    transportSmoke: false,
    cache: { enabled: false, arm: 'promotion', scope: null, reads: 0, hits: 0, writes: 2, dbPath: null },
    provenance: {
      gitSha: 'a'.repeat(40), gitDirty: false,
      evaluatorSha256: 'b'.repeat(64), datasetSha256: 'c'.repeat(64), packageLockSha256: null,
    },
    models: { answerRequested: 'answer-model', answerEchoes: ['echo-a'], judgeRequested: 'judge-model', judgeEchoes: ['echo-j'] },
    watermark: null,
    ...overrides,
  };
}

function writeScorerFixture(root: string, manifest: object, runManifest: object = manifest): { qa: string; run: string; output: string } {
  const qa = path.join(root, 'qa');
  const run = path.join(root, 'retrieval');
  fs.mkdirSync(qa); fs.mkdirSync(run);
  fs.writeFileSync(path.join(qa, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(run, 'manifest.json'), JSON.stringify(runManifest));
  fs.writeFileSync(path.join(qa, 'qa-cases.jsonl'), JSON.stringify({
    id: 'q1', category: 'single_session_user', shouldAbstain: false, hitsUsed: 2, contextTokens: 50,
    answer: { text: 'mango juice', modelEcho: 'echo-a', finishReason: 'stop', attempts: 1, latencyMs: 5 },
    judge: { raw: '1', verdict: 1, parseOk: true, modelEcho: 'echo-j', attempts: 1, latencyMs: 5 },
  }) + '\n');
  fs.writeFileSync(path.join(run, 'cases.jsonl'), JSON.stringify({
    id: 'q1', category: 'single_session_user', query: 'q', relevant: [{ match: 's1', role: 'positive' }],
    expectedAnswer: 'mango juice', shouldAbstain: false, split: 'test',
  }) + '\n');
  fs.writeFileSync(path.join(run, 'results.jsonl'), JSON.stringify({ id: 'q1', hits: [{ text: 'mango juice', notePath: 'Sessions/s1.md', score: 1 }] }) + '\n');
  return { qa, run, output: path.join(root, 'report.json') };
}

function runScorer(fix: { qa: string; run: string; output: string }, label: 'research' | 'product', extraArgs: string[] = []) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval/score-longmemeval-qa.ts', '--qa', fix.qa, '--run', fix.run, '--output', fix.output, '--label', label, ...extraArgs], { encoding: 'utf8', cwd: REPO_ROOT });
}

describe('product-path contract: scorer fail-closed refusals', () => {
  it('refuses a product label for research execution', () => {
    const manifest = { ...validTruthFields({ executionKind: 'research', watermark: 'RESEARCH-ONLY', publicEntryPoint: null, entryPointDetail: null, goldIsolated: false, productMode: null, runtimeVisibleFieldAllowlist: [...PRODUCT_RUNTIME_FIELD_ALLOWLIST, 'category', 'shouldAbstain'] }) };
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-score-'));
    try {
      const run = runScorer(writeScorerFixture(tempRoot, manifest), 'product');
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/RESEARCH-ONLY/);
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  }, SPAWN_BUDGET_MS);

  it('refuses a product label on a dirty source tree', () => {
    const manifest = { ...validTruthFields({ provenance: { ...validTruthFields().provenance!, gitDirty: true } }) };
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-score-'));
    try {
      const run = runScorer(writeScorerFixture(tempRoot, manifest), 'product');
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/gitDirty/);
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  }, SPAWN_BUDGET_MS);

  it('refuses a product label when provenance hashes are missing', () => {
    const manifest = { ...validTruthFields(), provenance: null };
    expect(() => assertProductScoreEligibility(manifest)).toThrow(/evaluatorSha256/);
  });

  it('promotion cache gate: HITS are refused (replays); fresh write-through (attempts, zero hits) is eligible — plan Task 8', () => {
    // Replayed responses in a promotion arm = refusal.
    const replayed = { ...validTruthFields({ cache: { enabled: true, arm: 'promotion', scope: 'canonical', reads: 3, hits: 3, writes: 0, dbPath: 'db' } }) };
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-score-'));
    try {
      const run = runScorer(writeScorerFixture(tempRoot, replayed), 'product');
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/require zero cache hits/);
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
    // Fresh write-through (the overnight baseline pattern): 972 read attempts
    // against a verified-fresh DB, zero hits — eligible for the product label.
    const tempRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-score-'));
    try {
      const fresh = { ...validTruthFields({ cache: { enabled: true, arm: 'promotion', scope: 'canonical', reads: 972, hits: 0, writes: 972, dbPath: 'fresh.db' } }) };
      const fix = writeScorerFixture(tempRoot2, fresh);
      const run = runScorer(fix, 'product');
      expect(run.status).toBe(0);
      const report = JSON.parse(fs.readFileSync(fix.output, 'utf8'));
      expect(report.scoreAuthority).toBe('product-public');
      expect(report.cache.reads).toBe(972);
      expect(report.cache.hits).toBe(0);
    } finally { fs.rmSync(tempRoot2, { recursive: true, force: true }); }
  }, SPAWN_BUDGET_MS);

  it('refuses a product label on incomplete coverage unless explicitly recorded as a failed run', () => {
    const incomplete = { ...validTruthFields({ coverage: { casesTotal: 2, casesCompleted: 1, answerErrors: 0, judgeParseFailures: 0, failedRunRecorded: false } }) };
    const errored = { ...validTruthFields({ coverage: { casesTotal: 1, casesCompleted: 1, answerErrors: 1, judgeParseFailures: 0, failedRunRecorded: false } }) };
    const recorded = { ...validTruthFields({ coverage: { casesTotal: 2, casesCompleted: 1, answerErrors: 0, judgeParseFailures: 0, failedRunRecorded: true } }) };
    expect(() => assertProductScoreEligibility(incomplete)).toThrow(/incomplete coverage/);
    expect(() => assertProductScoreEligibility(errored)).toThrow(/answer error/);
    expect(assertProductScoreEligibility(recorded).failedRunRecord).toBe(true);
  });

  it('refuses a product label when model echoes are missing', () => {
    const manifest = { ...validTruthFields({ models: { answerRequested: 'a', answerEchoes: [], judgeRequested: 'j', judgeEchoes: ['e'] } }) };
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-score-'));
    try {
      const run = runScorer(writeScorerFixture(tempRoot, manifest), 'product');
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/missing answer model echo/);
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  }, SPAWN_BUDGET_MS);

  it('refuses a product label on non-production embeddings (eval-hash/local) — with or without the transport-smoke watermark — and requires a recorded embedding provider', () => {
    const evalHash = { ...validTruthFields(), embeddingProvider: 'eval-hash' };
    const local = { ...validTruthFields(), embeddingProvider: 'local' };
    expect(() => assertProductScoreEligibility(evalHash)).toThrow(/non-production embeddings can never carry a product label/);
    expect(() => assertProductScoreEligibility(local)).toThrow(/non-production embeddings can never carry a product label/);
    const unrecorded = { ...validTruthFields() };
    delete (unrecorded as { embeddingProvider?: unknown }).embeddingProvider;
    expect(() => assertProductScoreEligibility(unrecorded)).toThrow(/embeddingProvider missing/);
    // The watermark lets smoke runs exist for research scoring; it must NEVER
    // let a smoke run carry the product label.
    const smoke = { ...validTruthFields(), embeddingProvider: 'eval-hash', transportSmoke: true };
    expect(() => assertProductScoreEligibility(smoke)).toThrow(/transport-smoke runs .* never carry a product label/);
  });

  it('refuses a product label when the retrieval run is research-kind or pre-contract', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-score-'));
    try {
      const researchRun = runScorer(writeScorerFixture(tempRoot, validTruthFields(), { ...validTruthFields(), executionKind: 'research', watermark: 'RESEARCH-ONLY' }), 'product');
      expect(researchRun.status).not.toBe(0);
      expect(researchRun.stderr).toMatch(/retrieval run executionKind/);
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  }, SPAWN_BUDGET_MS);

  it('refuses a product label on QA/retrieval provenance mismatch', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-score-'));
    try {
      const mismatched = { ...validTruthFields(), provenance: { ...validTruthFields().provenance!, datasetSha256: 'd'.repeat(64) } };
      const run = runScorer(writeScorerFixture(tempRoot, validTruthFields(), mismatched), 'product');
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/datasetSha256 mismatch/);
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  }, SPAWN_BUDGET_MS);

  it('accepts a valid product-public manifest with --label product and refuses a research label on it', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-score-'));
    try {
      const fix = writeScorerFixture(tempRoot, validTruthFields());
      const product = runScorer(fix, 'product');
      expect(product.status).toBe(0);
      const report = JSON.parse(fs.readFileSync(fix.output, 'utf8'));
      expect(report.scoreAuthority).toBe('product-public');
      expect(report.watermark).toBeNull();
      expect(report.cache.arm).toBe('promotion');
      expect(report.cache.reads).toBe(0);
      expect(report.embeddingProvider).toBe('openai');
      expect(report.transportSmoke).toBe(false);

      const research = runScorer(fix, 'research');
      expect(research.status).not.toBe(0);
      expect(research.stderr).toMatch(/score it with --label product/);
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
    // Two `tsx` scorer spawns (~1.7s warm on an idle host each) under vitest's 5s default cap is a
    // timeout that fires as a FLAKE under suite load, not a defect: the same tree failed here at
    // 5,286ms on run 1 of the 2026-09-30 gate on a benchmark-arm branch @0284106 (pass=1066 fail=1
    // flakes=1, this the sole red) and passed its isolated rerun in 1,090ms. Same measured class as
    // change-benchmark-binding (0d9ea93). Raising the budget adds NO assertion and weakens nothing:
    // every expectation above still runs; mutation on the repair commit - flipping the acceptance
    // expectation to a fail still fails the test (1/34).
  }, 60_000);

  it('scores legacy pre-contract manifests only as watermarked research', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-score-'));
    try {
      const fix = writeScorerFixture(tempRoot, { schemaVersion: 1, benchmark: 'longmemeval-s-qa-end-to-end' });
      const run = runScorer(fix, 'research');
      expect(run.status).toBe(0);
      const report = JSON.parse(fs.readFileSync(fix.output, 'utf8'));
      expect(report.watermark).toBe('RESEARCH-ONLY');
      const productRun = runScorer(fix, 'product');
      expect(productRun.status).not.toBe(0);
      expect(productRun.stderr).toMatch(/pre-contract/);
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  }, SPAWN_BUDGET_MS);
});

// ─── PRAGMA / raw-Database guard (f) ───

describe('product-path contract: product SQLite is only opened through openDb()', () => {
  it('no raw new Database( on the product schema outside src/db/client.ts (cache DBs exempt)', () => {
    const allowed = new Set([
      'src/db/client.ts', // product schema entry point; sets WAL + foreign_keys pragma
      'src/embeddings/caching.ts', // embedding cache DB
      'src/evidence/evidenceCache.ts', // evidence cache DB
      'src/eval/evalCache.ts', // eval cache DB
      'src/router/routerCache.ts', // session-router cache DB (note summaries + routing answers), not the product schema
      'src/digests/digestCache.ts', // write-time digest cache DB (note digests + item vectors), not the product schema
      'src/learning/store.ts', // optional learning-log DB, a separate user-owned activity log, not the product schema
      'src/sharing/examples.ts', // the shared-example texts' own DB (only at the data level), not the product schema
      'scripts/eval/benchmark-embed-inventory.ts', // eval helper: reads the embedding cache files read-only, never the product schema
      'scripts/eval/cloud-bundle/build-bundle.ts', // eval helper: copies eval cache DB vectors into the benchmark bundle DB, never the product schema
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const relative = path.relative(REPO_ROOT, full).replaceAll(path.sep, '/');
        const source = fs.readFileSync(full, 'utf8');
        if (/new\s+Database\(/.test(source) && !allowed.has(relative)) offenders.push(relative);
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
    walk(path.join(REPO_ROOT, 'scripts/eval'));
    expect(offenders).toEqual([]);
    // The exempt product-schema path really sets the FK pragma (C0 cascade caveat).
    const client = fs.readFileSync(path.join(REPO_ROOT, 'src/db/client.ts'), 'utf8');
    expect(client).toContain("pragma('foreign_keys = ON')");
  });
});

// ─── Embed proxy (scripts/eval/embed-proxy.ts): translation, cache, stats ───

interface StubUpstreamCall { taskType: 'query' | 'document'; inputs: string[] }

/** Deterministic 768-dim stub vector from the text (never touches Vertex). */
function stubVector(text: string): number[] {
  const digest = crypto.createHash('sha256').update(text).digest();
  return Array.from({ length: 768 }, (_, i) => (digest[i % digest.length] + i) / 257 - 1);
}

function makeStubUpstream(): EmbeddingUpstream & { calls: StubUpstreamCall[] } {
  const calls: StubUpstreamCall[] = [];
  const upstream = {
    model: 'gemini-embedding-001',
    dimensions: 768,
    usage: { inputTokens: 0 },
    calls,
    async embed(texts: string[]): Promise<number[][]> {
      calls.push({ taskType: 'document', inputs: [...texts] });
      upstream.usage.inputTokens += texts.reduce((n, t) => n + t.length, 0);
      return texts.map(t => stubVector(t));
    },
    async embedQuery(text: string): Promise<number[]> {
      calls.push({ taskType: 'query', inputs: [text] });
      upstream.usage.inputTokens += text.length;
      return stubVector(text);
    },
  };
  return upstream as EmbeddingUpstream & { calls: StubUpstreamCall[] };
}

async function postEmbed(port: number, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

describe('product-path contract: embed proxy translation (stub upstream, no Vertex)', () => {
  it('translates OpenAI-shaped requests, routes query/vault-chunk task types, refuses unknown models/dims, and writes split stats', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-proxy-'));
    const upstream = makeStubUpstream();
    const statsPath = path.join(root, 'stats.json');
    const proxy = createEmbedProxy({ port: 0, statsPath, cachePath: path.join(root, 'cache.db'), upstream });
    try {
      const port = await proxy.start();

      // Product-path query input → RETRIEVAL_QUERY routing; exact OpenAI response shape.
      const query = 'Question date: 2026/02/01 (Sun) 09:00\nWhat does Alex drink in the morning?';
      const queryResponse = await postEmbed(port, { model: 'gemini-embedding-001', input: query, dimensions: 768 });
      expect(queryResponse.status).toBe(200);
      expect(queryResponse.json).toMatchObject({ object: 'list', model: 'gemini-embedding-001' });
      const list = queryResponse.json.data as Array<{ object: string; index: number; embedding: number[] }>;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ object: 'embedding', index: 0 });
      expect(list[0].embedding).toEqual(stubVector(query));
      expect(upstream.calls[0]).toEqual({ taskType: 'query', inputs: [query] });

      // Vault chunks (no "Question date: " prefix) → RETRIEVAL_DOCUMENT batch, order preserved.
      const chunks = ['alpha chunk text', 'beta chunk text'];
      const chunkResponse = await postEmbed(port, { model: 'gemini-embedding-001', input: chunks, dimensions: 768 });
      expect(chunkResponse.status).toBe(200);
      const chunkList = chunkResponse.json.data as Array<{ index: number; embedding: number[] }>;
      expect(chunkList.map(d => d.embedding)).toEqual(chunks.map(stubVector));
      expect(upstream.calls[1]).toEqual({ taskType: 'document', inputs: chunks });

      // The models/gemini-embedding-001 alias is accepted and mapped exactly.
      const aliasResponse = await postEmbed(port, { model: 'models/gemini-embedding-001', input: 'Question date: alias check', dimensions: 768 });
      expect(aliasResponse.status).toBe(200);
      expect((aliasResponse.json as { model: string }).model).toBe('models/gemini-embedding-001');

      // Unknown model refused explicitly (400), never routed upstream.
      const unknown = await postEmbed(port, { model: 'text-embedding-3-small', input: 'x' });
      expect(unknown.status).toBe(400);
      expect((unknown.json.error as { message: string }).message).toMatch(/unsupported model/);

      // Dims mismatch with the pinned namespace refused explicitly — never re-dimensioned.
      const wrongDims = await postEmbed(port, { model: 'gemini-embedding-001', input: 'x', dimensions: 1536 });
      expect(wrongDims.status).toBe(400);
      expect((wrongDims.json.error as { message: string }).message).toMatch(/provisions the warm 768 namespace/);

      // Faithful omission default: a request WITHOUT `dimensions` is served at
      // 3072 (real Google's omission default, verified live) — never forgiven to
      // 768 — and counted as an omission-default request.
      const omission = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-embedding-001', input: ['omission probe text'] }),
      });
      const omissionJson = await omission.json() as { data: Array<{ embedding: unknown }> };
      const omissionVec = Array.isArray(omissionJson.data[0].embedding) ? omissionJson.data[0].embedding : null;
      if (!omissionVec) throw new Error('omission-default request must return a float array (faithful Google default)');
      // The stub upstream serves its fixed-dims vectors; the assertion that
      // matters is the ROUTING: stats must record the omission-default request.
      const statsAfterOmission = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as EmbedProxyStats;
      expect(statsAfterOmission.omissionDefaultRequests).toBe(1);
      expect(upstream.calls.filter(c => c.inputs[0] === 'x')).toEqual([]);

      // Stats file: all mandated fields with the component split.
      const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as EmbedProxyStats;
      expect(stats.namespace).toBe('vertex/gemini-embedding-001/768');
      expect(stats.upstream).toEqual({ endpoint: 'vertex-predict', model: 'gemini-embedding-001', dims: 768 });
      expect(stats.requests).toBe(4);
      expect(stats.errors).toBe(2);
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(5); // 2 queries + 2 chunks + 1 omission-default chunk, all misses
      expect(stats.queryMisses).toBe(2);
      expect(stats.queryHits).toBe(0);
      expect(stats.vaultChunkMisses).toBe(3); // 2 chunks + the omission-default probe
      expect(stats.vaultChunkHits).toBe(0);
      expect(stats.omissionDefaultRequests).toBe(1);
      expect(stats.inputTokens).toBeGreaterThan(0);
      expect(stats.startedAt).toBeTruthy();
      expect(stats.lastAt).toBeTruthy();
    } finally {
      await proxy.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('strict-dimensions mode refuses omission requests with a 400 — the guard cannot be a silent no-op', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-proxy-strict-'));
    try {
      const upstream = makeStubUpstream();
      const statsPath = path.join(root, 'stats.json');
      const proxy = createEmbedProxy({ port: 0, statsPath, cachePath: path.join(root, 'cache.db'), upstream, strictDimensions: true });
      const port = await proxy.start();
      try {
        const refused = await postEmbed(port, { model: 'gemini-embedding-001', input: 'no dimensions sent' });
        expect(refused.status).toBe(400);
        expect((refused.json.error as { message: string }).message).toMatch(/strict-dimensions mode/);
        const allowed = await postEmbed(port, { model: 'gemini-embedding-001', input: 'dimensions sent', dimensions: 768 });
        expect(allowed.status).toBe(200);
        const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as EmbedProxyStats;
        expect(stats.omissionDefaultRequests).toBe(1);
      } finally {
        await proxy.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves a second identical request from the content-addressed cache with byte-identical vectors', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-proxy-'));
    const upstream = makeStubUpstream();
    const statsPath = path.join(root, 'stats.json');
    const proxy = createEmbedProxy({ port: 0, statsPath, cachePath: path.join(root, 'cache.db'), upstream });
    try {
      const port = await proxy.start();
      const body = { model: 'gemini-embedding-001', input: 'deterministic vault chunk for the cache-hit check' };
      const first = await postEmbed(port, body);
      const second = await postEmbed(port, body);
      const third = await postEmbed(port, body);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
      const firstVec = (first.json.data as Array<{ embedding: number[] }>)[0].embedding;
      const secondVec = (second.json.data as Array<{ embedding: number[] }>)[0].embedding;
      const thirdVec = (third.json.data as Array<{ embedding: number[] }>)[0].embedding;
      // Cache hits are byte-identical to each other: the exact stored vector.
      expect(thirdVec).toEqual(secondVec);
      expect(JSON.stringify(thirdVec)).toBe(JSON.stringify(secondVec));
      // A hit is the float32-serialized provider vector — never re-dimensioned or altered beyond the standard cache storage.
      expect(secondVec).toEqual(Array.from(new Float32Array(firstVec)));
      // Upstream was called exactly once for this text.
      expect(upstream.calls).toHaveLength(1);
      const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as EmbedProxyStats;
      expect(stats.cacheHits).toBe(2);
      expect(stats.cacheMisses).toBe(1);
      expect(stats.vaultChunkHits).toBe(2);
      expect(stats.vaultChunkMisses).toBe(1);
    } finally {
      await proxy.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts what it sent upstream beside its lookup counters: a text repeated in one request is sent once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-proxy-dup-'));
    const upstream = makeStubUpstream();
    const statsPath = path.join(root, 'stats.json');
    const proxy = createEmbedProxy({ port: 0, statsPath, cachePath: path.join(root, 'cache.db'), upstream });
    try {
      const port = await proxy.start();
      const first = await postEmbed(port, { model: 'gemini-embedding-001', input: ['vault chunk repeated', 'vault chunk repeated'] });
      expect(first.status).toBe(200);
      expect(upstream.calls).toEqual([{ taskType: 'document', inputs: ['vault chunk repeated'] }]); // one text in one upstream call
      let stats = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as EmbedProxyStats;
      expect(stats.cacheMisses).toBe(2); // both occurrences missed at lookup
      expect(stats.upstreamTexts).toBe(1); // but one text went upstream
      expect(stats.upstreamCalls).toBe(1);

      // a repeat is served entirely from the cache: the lookup hits grow, nothing more goes upstream
      const second = await postEmbed(port, { model: 'gemini-embedding-001', input: ['vault chunk repeated', 'vault chunk repeated'] });
      expect(second.status).toBe(200);
      stats = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as EmbedProxyStats;
      expect(stats.cacheHits).toBe(2);
      expect({ texts: stats.upstreamTexts, calls: stats.upstreamCalls }).toEqual({ texts: 1, calls: 1 });
      expect(upstream.calls).toHaveLength(1);
    } finally {
      await proxy.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('product-path contract: embed-proxy manifest integration', () => {
  it('embeds proxy stats + embeddingUpstream provenance into the manifest when the stats file exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-manifest-'));
    const previousBaseUrl = process.env.EMBEDDING_BASE_URL;
    try {
      const statsPath = path.join(root, 'embed-proxy-stats.json');
      // This stats file carries no upstream/omission counters; its readers treat them as optional (src/eval/cacheReport.ts).
      const statsFile: Omit<EmbedProxyStats, 'upstreamTexts' | 'upstreamCalls' | 'omissionDefaultRequests'> = {
        namespace: 'vertex/gemini-embedding-001/768',
        upstream: { endpoint: 'vertex-predict', model: 'gemini-embedding-001', dims: 768 },
        requests: 12, cacheHits: 30, cacheMisses: 6,
        vaultChunkHits: 24, vaultChunkMisses: 5, queryHits: 6, queryMisses: 1,
        inputTokens: 12345, errors: 0,
        startedAt: '2026-09-21T00:00:00.000Z', lastAt: '2026-09-21T01:00:00.000Z',
      };
      fs.writeFileSync(statsPath, JSON.stringify(statsFile, null, 2));

      const datasetPath = path.join(root, 'dataset.json');
      await fsp.writeFile(datasetPath, JSON.stringify([baseRow()]));
      const captured: Array<{ callType: string; requestBody: Record<string, unknown> }> = [];
      const hooks: ProductHooks = {
        // Stubbed public surface: no CLI spawn, no embeddings, no model calls.
        async publicSearch() {
          return { hits: [{ notePath: '_renor/sess-1.md', text: 'Alex drinks mango juice every morning.', score: 1 }], transport: 'stub', command: 'stub', durationMs: 1 };
        },
        models: stubModels(captured),
      };
      process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:45999/v1';
      const result = await runProductBenchmark({
        dataset: datasetPath, output: path.join(root, 'out'), topK: 20, limit: 0, offset: 0,
        shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
        embeddingProvider: 'openai', arm: 'promotion', maxLiveCalls: 25, cache: false,
        embedProxyStats: statsPath,
        answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
        apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
      }, hooks);
      const manifest = result.manifest;
      expect(manifest.embeddingProxy).toMatchObject({
        present: true,
        namespace: 'vertex/gemini-embedding-001/768',
        vaultChunkHits: 24, vaultChunkMisses: 5, queryHits: 6, queryMisses: 1,
      });
      // The proxy URL alone is not provenance: the upstream fields must be present.
      expect(manifest.embeddingUpstream).toEqual({
        endpoint: 'vertex-predict',
        model: 'gemini-embedding-001',
        dims: 768,
        note: 'vectors may be served from the shared vertex cache namespace',
      });
      expect(manifest.embeddingBaseURL).toBe('http://127.0.0.1:45999/v1');

      // Missing stats file is recorded honestly, not fabricated.
      const missing = await runProductBenchmark({
        dataset: datasetPath, output: path.join(root, 'out-missing'), topK: 20, limit: 0, offset: 0,
        shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
        embeddingProvider: 'openai', arm: 'promotion', maxLiveCalls: 25, cache: false,
        embedProxyStats: path.join(root, 'nope.json'),
        answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
        apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
      }, hooks);
      expect(missing.manifest.embeddingProxy).toMatchObject({ present: false });
      // Without a localhost base URL there is no upstream provenance claim.
      delete process.env.EMBEDDING_BASE_URL;
      const remote = await runProductBenchmark({
        dataset: datasetPath, output: path.join(root, 'out-remote'), topK: 20, limit: 0, offset: 0,
        shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
        embeddingProvider: 'openai', arm: 'promotion', maxLiveCalls: 25, cache: false,
        answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
        apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
      }, hooks);
      expect(remote.manifest.embeddingUpstream).toBeNull();
      expect(remote.manifest.embeddingProxy).toBeNull();
    } finally {
      if (previousBaseUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
      else process.env.EMBEDDING_BASE_URL = previousBaseUrl;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('reports this run\'s embedding hit rate as the change in the long-lived proxy\'s counters, not its lifetime totals', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-proxy-window-'));
    try {
      const statsPath = path.join(root, 'embed-proxy-stats.json');
      const lifetime = { startedAt: '2026-09-21T00:00:00.000Z', cacheHits: 900, cacheMisses: 100 };
      fs.writeFileSync(statsPath, JSON.stringify(lifetime));
      const datasetPath = path.join(root, 'dataset.json');
      await fsp.writeFile(datasetPath, JSON.stringify([baseRow()]));
      const hooks: ProductHooks = {
        async publicSearch() {
          // The shared proxy serves this run's requests: 8 hits and 2 misses on top of its lifetime totals.
          fs.writeFileSync(statsPath, JSON.stringify({ ...lifetime, cacheHits: 908, cacheMisses: 102 }));
          return { hits: [{ notePath: '_renor/sess-1.md', text: 'Alex drinks mango juice every morning.', score: 1 }], transport: 'stub', command: 'stub', durationMs: 1 };
        },
        models: stubModels([]),
      };
      await runProductBenchmark({
        dataset: datasetPath, output: path.join(root, 'out'), topK: 20, limit: 0, offset: 0,
        shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
        embeddingProvider: 'openai', arm: 'promotion', maxLiveCalls: 25, cache: false,
        embedProxyStats: statsPath,
        answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
        apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
      }, hooks);
      const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'cache-report.json'), 'utf8'));
      expect(report.embedding).toEqual({ hits: 8, misses: 2, hitRate: 0.8 }); // not 908/1010
      // 2 embedding misses plus the answer and judge call of this run, which has no eval cache (it used to report only the 2)
      expect(report.liveProviderCalls).toBe(4);
      expect(report.uncached).toEqual({ model: 2 });
      expect(report.healthProbeCalls).toBe(2);
      // this proxy predates the sent counters, so its 2 lookup misses are an upper bound and the report says so
      expect(report.embeddingCallsUpperBound).toBe(true);
      expect(report.embeddingSent).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('counts the embedding calls from what the proxy sent upstream, not from its lookup misses', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-proxy-sent-'));
    try {
      const statsPath = path.join(root, 'embed-proxy-stats.json');
      const lifetime = { startedAt: '2026-09-21T00:00:00.000Z', cacheHits: 900, cacheMisses: 100, upstreamTexts: 80, upstreamCalls: 30 };
      fs.writeFileSync(statsPath, JSON.stringify(lifetime));
      const datasetPath = path.join(root, 'dataset.json');
      await fsp.writeFile(datasetPath, JSON.stringify([baseRow()]));
      const hooks: ProductHooks = {
        async publicSearch() {
          // this run's lookups: 8 hits and 2 misses, but the 2 misses were one text repeated, so 1 text went upstream in 1 call
          fs.writeFileSync(statsPath, JSON.stringify({ ...lifetime, cacheHits: 908, cacheMisses: 102, upstreamTexts: 81, upstreamCalls: 31 }));
          return { hits: [{ notePath: '_renor/sess-1.md', text: 'Alex drinks mango juice every morning.', score: 1 }], transport: 'stub', command: 'stub', durationMs: 1 };
        },
        models: stubModels([]),
      };
      await runProductBenchmark({
        dataset: datasetPath, output: path.join(root, 'out'), topK: 20, limit: 0, offset: 0,
        shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
        embeddingProvider: 'openai', arm: 'promotion', maxLiveCalls: 25, cache: false,
        embedProxyStats: statsPath,
        answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
        apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
      }, hooks);
      const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'cache-report.json'), 'utf8'));
      expect(report.embedding).toEqual({ hits: 8, misses: 2, hitRate: 0.8 }); // the lookup rate is unchanged
      expect(report.embeddingSent).toEqual({ texts: 1, calls: 1 });
      expect(report.embeddingCallsUpperBound).toBeUndefined();
      expect(report.liveProviderCalls).toBe(3); // 1 embedding call + the answer and judge call (cache off); it was 4 from the misses
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

// ─── Client-side context assembly over public output only ───

describe('product-path contract: cross-run eval-cache replay (v4 keys, zero live calls)', () => {
  it('a promotion run seeds the pinned pool and a fresh run replays answer+judge from it end-to-end', async () => {
    const previousScope = process.env.RENOR_QA_CACHE_SCOPE;
    process.env.RENOR_QA_CACHE_SCOPE = 'product-path-v1-diag';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-replay-'));
    try {
      const datasetPath = path.join(root, 'dataset.json');
      await fsp.writeFile(datasetPath, JSON.stringify([baseRow()]));
      const cacheDir = path.join(root, 'pool.db');
      const runOpts = {
        dataset: datasetPath, topK: 20, limit: 0, offset: 0,
        shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
        embeddingProvider: 'eval-hash', maxLiveCalls: 25,
        answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
        apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
      } as const;

      // Run 1 (promotion, fresh pool): zero reads, writes seed the pinned scope.
      const captured1: Array<{ callType: string }> = [];
      const run1 = await runProductBenchmark({
        ...runOpts, output: path.join(root, 'out-seed'), arm: 'promotion', cache: true, cacheDir,
      }, { publicSearch: cliPublicSearch, models: stubModels(captured1 as never) });
      expect(run1.cases[0].answer?.fromCache).toBe(false);
      expect(run1.cases[0].judge?.fromCache).toBe(false);
      expect((run1.manifest.cache as { reads: number; hits: number }).reads).toBe(2);
      expect((run1.manifest.cache as { hits: number }).hits).toBe(0);
      expect(captured1.length).toBe(2); // one answer + one judge, live (stub)

      // Run 2 (fresh output dir, iteration arm, SAME pinned scope + pool):
      // per-case temp dirs differ, qaSession differs — replay must still fire.
      const captured2: Array<{ callType: string }> = [];
      const run2 = await runProductBenchmark({
        ...runOpts, output: path.join(root, 'out-replay'), arm: 'iteration', cache: true, cacheDir,
      }, { publicSearch: cliPublicSearch, models: stubModels(captured2 as never) });
      expect(run2.cases[0].answer?.fromCache).toBe(true);
      expect(run2.cases[0].judge?.fromCache).toBe(true);
      expect(captured2.length).toBe(0); // ZERO model calls in the replay run
      // The per-run hit-rate report is written beside the manifest.
      const report2 = JSON.parse(fs.readFileSync(path.join(root, 'out-replay', 'cache-report.json'), 'utf8'));
      // Zero cacheable provider calls; the pre-flight health probes are real calls and are reported, never hidden.
      expect(report2).toMatchObject({ answer: { hits: 1, misses: 0, hitRate: 1 }, judge: { hits: 1, misses: 0, hitRate: 1 }, liveProviderCalls: 0, healthProbeCalls: 2, repeatRunBlockers: [] });
      expect(JSON.parse(fs.readFileSync(path.join(root, 'out-seed', 'cache-report.json'), 'utf8'))).toMatchObject({ answer: { hits: 0, misses: 1, hitRate: 0 }, liveProviderCalls: 2, healthProbeCalls: 2 });
      expect((run2.manifest.cache as { reads: number }).reads).toBeGreaterThan(0);
      expect((run2.manifest.cache as { hits: number }).hits).toBeGreaterThan(0);
      expect((run2.manifest.cache as { schemaVersion: string }).schemaVersion).toBe('evalcache-v4');
    } finally {
      if (previousScope === undefined) delete process.env.RENOR_QA_CACHE_SCOPE;
      else process.env.RENOR_QA_CACHE_SCOPE = previousScope;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('product-path contract: the cache report counts calls made without a cache', () => {
  it('a run with the eval cache off reports the answer and judge calls it made instead of "no caches in use ... 0"', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-uncached-report-'));
    try {
      const datasetPath = path.join(root, 'dataset.json');
      await fsp.writeFile(datasetPath, JSON.stringify([baseRow()]));
      const captured: Array<{ callType: string; requestBody: Record<string, unknown> }> = [];
      const hooks: ProductHooks = {
        publicSearch: async () => ({ hits: [{ notePath: 'Sessions/sess-1.md', text: 'Alex drinks mango juice every morning.', score: 1 }], transport: 'stub', command: 'stub', durationMs: 0 }),
        models: stubModels(captured),
      };
      await runProductBenchmark({
        dataset: datasetPath, output: path.join(root, 'out'), topK: 20, limit: 0, offset: 0,
        shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
        embeddingProvider: 'eval-hash', arm: 'promotion', maxLiveCalls: 25, cache: false,
        answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
        apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
      }, hooks);
      const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'cache-report.json'), 'utf8'));
      expect(captured.length).toBe(2); // one answer and one judge reached the (stub) provider
      expect(report).toMatchObject({ liveProviderCalls: captured.length, healthProbeCalls: 2, uncached: { model: 2 } });
      expect(report.repeatRunBlockers).toHaveLength(1);
      expect(report.repeatRunBlockers[0]).toMatch(/answer\/judge calls ran with the eval cache off/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('product-path contract: client context assembly', () => {
  it('assembles context from public hits with dedupe and a token cap', () => {
    const hits = [
      { notePath: 'a.md', text: 'alpha text', score: 0.9 },
      { notePath: 'b.md', text: 'alpha text', score: 0.8 }, // exact duplicate — collapsed
      { notePath: 'c.md', text: 'beta text', score: 0.7 },
    ];
    const assembled = assembleClientContext(hits, 30);
    expect(assembled.hitsUsed).toBe(2);
    expect(assembled.context).toContain('alpha text');
    expect(assembled.context).toContain('beta text');
    // Token cap drops everything over budget:
    expect(assembleClientContext([{ notePath: 'd.md', text: 'x'.repeat(400), score: 1 }], 10).hitsUsed).toBe(0);
  });
});
