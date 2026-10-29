import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  admitRun,
  archiveRow,
  canonicalJson,
  codeIdentity,
  ORDINARY_CREDENTIAL_NAMED_ENV,
  isPresenceOnlyEnv,
  PRODUCT_ENV_NAMESPACES,
  productEnvironment,
  questionSet,
  readRunLedger,
  recordRun,
  resolveRunLedgerPath,
  runFingerprint,
  RunRefusedError,
  saveRunOutcome,
  type RunRecord,
} from '../../src/eval/runLedger';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import {
  PRODUCT_RUN_CODE_ROOTS,
  productProcessEnv,
  productRunConfig,
  runProductBenchmark,
  type ProductHooks,
  type ProductRunnerOptions,
} from '../../scripts/eval/run-longmemeval-product';
import { tmpPath } from '../helpers/tmpPath';

const ENGINE_ROOT = path.resolve(__dirname, '..', '..');

/** A valid two-session LongMemEval row whose answer is stated in the first session. */
function lmeRow(id: string, drink: string) {
  return {
    question_id: id,
    question_type: 'single-session-user',
    question: `What does ${id} drink in the morning?`,
    answer: drink,
    question_date: '2026/02/01 (Sun) 09:00',
    haystack_session_ids: [`${id}-s1`, `${id}-noise`],
    haystack_dates: ['2026/01/01 (Thu) 10:00', '2025/12/01 (Mon) 09:00'],
    haystack_sessions: [
      [{ role: 'user', content: `${id} drinks ${drink} every morning.` }, { role: 'assistant', content: 'Noted.' }],
      [{ role: 'user', content: 'Completely unrelated noise about gardening and the weather.' }],
    ],
    answer_session_ids: [`${id}-s1`],
  };
}

function writeDataset(file: string): string[] {
  const rows = [lmeRow('alex', 'mango juice'), lmeRow('sam', 'green tea')];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows.map(row => row.question_id);
}

describe('run ledger: the fingerprint', () => {
  it('is the sha256 of the canonical configuration: key order and absent members do not change it, any value does', () => {
    const config = { runner: 'longmemeval-product', answer: { model: 'a', baseUrl: 'https://x/v1' }, flags: [1, 2], absent: undefined };
    expect(canonicalJson(config)).toBe('{"answer":{"baseUrl":"https://x/v1","model":"a"},"flags":[1,2],"runner":"longmemeval-product"}');
    expect(runFingerprint(config)).toMatch(/^[0-9a-f]{64}$/);
    expect(runFingerprint({ flags: [1, 2], answer: { baseUrl: 'https://x/v1', model: 'a' }, runner: 'longmemeval-product' })).toBe(runFingerprint(config));
    const variants = [
      { ...config, runner: 'longmemeval-qa' },
      { ...config, answer: { model: 'b', baseUrl: 'https://x/v1' } },
      { ...config, flags: [2, 1] },
      { ...config, extra: null },
    ];
    for (const variant of variants) expect(runFingerprint(variant)).not.toBe(runFingerprint(config));
  });

  it('identifies code by the content of the files a run executes, in any worktree, and fails closed on a missing root', () => {
    const roots = ['src', 'package-lock.json'];
    const trees = [tmpPath('code-a'), tmpPath('code-b')];
    for (const tree of trees) {
      fs.mkdirSync(path.join(tree, 'src', 'eval'), { recursive: true });
      fs.writeFileSync(path.join(tree, 'src', 'eval', 'one.ts'), 'export const one = 1;\n');
      fs.writeFileSync(path.join(tree, 'src', 'two.ts'), 'export const two = 2;\n');
      fs.writeFileSync(path.join(tree, 'package-lock.json'), '{"lockfileVersion":3}\n');
    }
    const [a, b] = trees;
    const identity = codeIdentity(a, roots);
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(codeIdentity(b, roots)).toBe(identity);
    fs.writeFileSync(path.join(a, 'README.md'), 'docs are not executed\n');
    expect(codeIdentity(a, roots)).toBe(identity);

    fs.writeFileSync(path.join(b, 'src', 'two.ts'), 'export const two = 3;\n');
    expect(codeIdentity(b, roots)).not.toBe(identity);
    fs.writeFileSync(path.join(b, 'src', 'two.ts'), 'export const two = 2;\n');
    expect(codeIdentity(b, roots)).toBe(identity);
    fs.writeFileSync(path.join(b, 'src', 'eval', 'three.ts'), 'export {};\n');
    expect(codeIdentity(b, roots)).not.toBe(identity);
    fs.rmSync(path.join(b, 'src', 'eval', 'three.ts'));
    fs.renameSync(path.join(b, 'src', 'two.ts'), path.join(b, 'src', 'renamed.ts'));
    expect(codeIdentity(b, roots)).not.toBe(identity);
    fs.writeFileSync(path.join(b, 'package-lock.json'), '{"lockfileVersion":3,"x":1}\n');
    expect(codeIdentity(b, roots)).not.toBe(identity);

    expect(() => codeIdentity(a, ['missing'])).toThrow();
  });

  it('a question set is its ids, not their order', () => {
    expect(questionSet(['b', 'a'])).toEqual(questionSet(['a', 'b']));
    expect(questionSet(['a', 'b']).count).toBe(2);
    expect(questionSet(['a', 'c'])).not.toEqual(questionSet(['a', 'b']));
    expect(questionSet(['a'])).not.toEqual(questionSet(['a', 'b']));
  });
});

describe('run ledger: what the product runner fingerprints', () => {
  const opts: ProductRunnerOptions = {
    dataset: '/data/longmemeval_s.json', output: '/runs/one', topK: 20, limit: 0, offset: 0, shardIndex: 0, shardCount: 1,
    maxContextTokens: 6000, embeddingProvider: 'openai', arm: 'promotion', cache: false, maxLiveCalls: 1200,
    answerModel: 'deepseek-v4.1-flash', judgeModel: 'gemma4:31b', baseUrl: 'https://ollama.com/v1', apiKeyEnv: 'OLLAMA_API_KEY',
    answerStyle: 'bestguess', contextDates: true, temperature: 0, retries: 5,
  };
  const childEnv: Record<string, string> = {
    EMBEDDING_PROVIDER: 'openai', LLM_EXTRACTION: 'false', INDEX_CONCURRENCY: '4',
    EMBEDDING_MODEL: 'gemini-embedding-001', EMBEDDING_BASE_URL: 'http://127.0.0.1:18793/v1', EMBEDDING_DIMS: '768',
    OPENAI_API_KEY: 'sk-embed-secret-value', OLLAMA_CLOUD_KEY_4: 'ollama-secret-value',
    RENOR_EVIDENCE_MODE: 'always', RENOR_EVIDENCE_SESSIONS: '20', RENOR_EVIDENCE_CACHE: '/scratch/lane-a/evidence.db',
  };
  const config = (
    o: ProductRunnerOptions = opts,
    env: Record<string, string> = childEnv,
    extra: Partial<{ datasetSha256: string; questionIds: string[]; codeSha256: string }> = {},
  ) => productRunConfig({ opts: o, childEnv: env, datasetSha256: 'd'.repeat(64), questionIds: ['q1', 'q2'], codeSha256: 'c'.repeat(64), ...extra });

  it('changes with every model, endpoint, prompt flag, product setting, question, dataset and code', () => {
    const { OLLAMA_CLOUD_KEY_4: _key, ...noEvidenceKey } = childEnv;
    const variants: Record<string, Record<string, unknown>> = {
      answerModel: config({ ...opts, answerModel: 'accounts/fireworks/models/deepseek-v4p1-flash' }),
      answerEndpoint: config({ ...opts, baseUrl: 'https://api.fireworks.ai/inference/v1' }),
      judgeModel: config({ ...opts, judgeModel: 'openai/gpt-oss-20b' }),
      judgeEndpoint: config({ ...opts, judgeBaseUrl: 'https://api.groq.com/openai/v1' }),
      answerStyle: config({ ...opts, answerStyle: 'direct' }),
      contextDates: config({ ...opts, contextDates: false }),
      stripExcerptMeta: config({ ...opts, stripExcerptMeta: true }),
      topK: config({ ...opts, topK: 10 }),
      maxContextTokens: config({ ...opts, maxContextTokens: 4000 }),
      temperature: config({ ...opts, temperature: 0.2 }),
      arm: config({ ...opts, arm: 'iteration', cache: true }),
      transportSmoke: config({ ...opts, transportSmoke: true }),
      extractorModel: config(opts, { ...childEnv, RENOR_EVIDENCE_MODEL: 'gemini-3.5-flash-lite' }),
      extractorEndpoint: config(opts, { ...childEnv, RENOR_EVIDENCE_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai' }),
      evidenceOff: config(opts, { ...childEnv, RENOR_SEARCH_EVIDENCE: '0' }),
      evidenceSessions: config(opts, { ...childEnv, RENOR_EVIDENCE_SESSIONS: '12' }),
      noEvidenceKey: config(opts, noEvidenceKey),
      embeddingModel: config(opts, { ...childEnv, EMBEDDING_MODEL: 'voyage-4-large' }),
      structuredRows: config(opts, { ...childEnv, RENOR_TYPED_FACTS: '1' }),
      // Settings the product reads that no runner names: they reach the child from the operator's shell.
      newestFirstOff: config(opts, { ...childEnv, RENOR_NEWEST_FIRST: '0' }),
      temporalRankingOff: config(opts, { ...childEnv, RENOR_TEMPORAL_RANKING: '0' }),
      vaultStaleness: config(opts, { ...childEnv, RENOR_VAULT_STALENESS: '1' }),
      chunkSize: config(opts, { ...childEnv, CHUNK_MAX_TOKENS: '300' }),
      timeZone: config(opts, { ...childEnv, TZ: 'Asia/Tokyo' }),
      questions: config(opts, childEnv, { questionIds: ['q1'] }),
      dataset: config(opts, childEnv, { datasetSha256: 'e'.repeat(64) }),
      code: config(opts, childEnv, { codeSha256: 'f'.repeat(64) }),
    };
    const base = runFingerprint(config());
    const fingerprints = Object.entries(variants).map(([name, variant]) => [name, runFingerprint(variant)] as const);
    for (const [name, fingerprint] of fingerprints) expect(fingerprint, name).not.toBe(base);
    expect(new Set(fingerprints.map(([, fingerprint]) => fingerprint)).size).toBe(fingerprints.length);
  });

  it('the product process receives exactly the fingerprinted environment: the per-case env is childEnv plus the two per-case paths, and nothing else writes to it', () => {
    // A variable passed to the product process but missing from the fingerprint would let two different
    // measurements share one fingerprint, and the second would be refused as a repeat. Open PRs add passthrough
    // names (evidence bounds, router knobs); they belong in childEnv, never in a second write inside the case loop.
    const source = fs.readFileSync(path.join(ENGINE_ROOT, 'scripts/eval/run-longmemeval-product.ts'), 'utf8');
    const writes = source.match(/\bspawnEnv\b(?!\s*,|\s*\})/g) ?? [];
    expect(source).toContain('const spawnEnv: Record<string, string> = { VAULT_PATH: rendered.vaultDir, DB_PATH: dbPath, ...childEnv };');
    expect(writes).toEqual(['spawnEnv']); // the declaration; every other use reads it (`env: spawnEnv,` / `env: spawnEnv }`)
    expect(source).not.toMatch(/spawnEnv\s*\[|Object\.assign\(\s*spawnEnv/);
    // The process is spawned with the same merge the fingerprint is computed from, and with no other environment.
    const spawnCli = /function spawnCli\([\s\S]*?\n}\n/.exec(source)?.[0] ?? '';
    expect(spawnCli).toContain('env: productProcessEnv(args.env),');
    expect(spawnCli).not.toContain('process.env');
    expect(source.match(/\bspawn\(/g)).toHaveLength(1); // the only child process the runner starts is spawnCli's
    expect(source).toContain('childEnv: productProcessEnv(childEnv),');
  });

  it('records what the product process actually receives, including settings inherited from the shell that no runner names', async () => {
    const root = tmpPath('child-env');
    const dataset = path.join(root, 'dataset.json');
    writeDataset(dataset);
    const ledgerPath = path.join(root, 'ledger.jsonl');
    const childEnvs: Array<Record<string, string>> = [];
    // Two kinds of ambient variable: ones the runner passes on by name, and ones only the product reads, which
    // reach the process because it inherits the runner's environment (the review's F1: RENOR_NEWEST_FIRST).
    const set = {
      RENOR_EVIDENCE_MODEL: 'minimax-m3', RENOR_EVIDENCE_BASE_URL: 'https://example.invalid/v1', OLLAMA_CLOUD_KEY_4: 'child-env-secret',
      RENOR_EVIDENCE_CACHE: path.join(root, 'evidence.db'), RENOR_NEWEST_FIRST: '0', CHUNK_MAX_TOKENS: '300',
    };
    const previous = Object.fromEntries(Object.keys(set).map(name => [name, process.env[name]]));
    Object.assign(process.env, set);
    try {
      const hooks = countingHooks([]);
      await runProductBenchmark({
        dataset, output: path.join(root, 'out'), topK: 20, limit: 0, offset: 0, shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
        embeddingProvider: 'openai', arm: 'iteration', cache: false, maxLiveCalls: 50, runLedger: { path: ledgerPath },
        answerModel: 'stub-answer', judgeModel: 'stub-judge', baseUrl: 'unused://stub', apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
      }, {
        ...hooks,
        publicSearch: async args => {
          // What the CLI spawn really passes (spawnCli: productProcessEnv), minus the two per-case paths.
          const { VAULT_PATH: _vault, DB_PATH: _db, ...received } = productProcessEnv(args.env) as Record<string, string>;
          childEnvs.push(received);
          return hooks.publicSearch(args);
        },
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const [record] = readRunLedger(ledgerPath);
    const productEnv = record.config.productEnv as Record<string, string>;
    expect(childEnvs).toHaveLength(2);
    for (const received of childEnvs) expect(productEnv).toEqual(productEnvironment(received));
    expect(productEnv).toMatchObject({
      RENOR_EVIDENCE_MODEL: 'minimax-m3', RENOR_EVIDENCE_BASE_URL: 'https://example.invalid/v1', OLLAMA_CLOUD_KEY_4: 'set', RENOR_EVIDENCE_CACHE: 'set',
      RENOR_NEWEST_FIRST: '0', CHUNK_MAX_TOKENS: '300',
    });
    expect(fs.readFileSync(ledgerPath, 'utf8')).not.toContain('child-env-secret');
  });

  it('does not change with output paths, budgets, retries, key names or credential and cache-path values, and never holds a credential', () => {
    const base = runFingerprint(config());
    expect(runFingerprint(config({ ...opts, output: '/runs/two', cacheDir: '/caches/eval.db', maxLiveCalls: 5, retries: 1, apiKeyEnv: 'OTHER_KEY', embedProxyStats: '/s.json', idsFile: '/ids.txt' }))).toBe(base);
    expect(runFingerprint(config(opts, { ...childEnv, OPENAI_API_KEY: 'another-secret', OLLAMA_CLOUD_KEY_4: 'rotated-secret', RENOR_EVIDENCE_CACHE: '/scratch/lane-b/evidence.db' }))).toBe(base);
    expect(runFingerprint(config(opts, childEnv, { questionIds: ['q2', 'q1'] }))).toBe(base);
    // Shell and session variables, the eval runners' own variables and a spend cap are not product configuration.
    expect(runFingerprint(config(opts, {
      ...childEnv, PATH: '/usr/bin', HOME: '/home/example', TERM: 'xterm', SHELL: '/bin/zsh', PWD: '/elsewhere',
      RENOR_QA_SESSION: 'lane-42', RENOR_QA_CACHE_SCOPE: 'scope-a', RENOR_EVAL_RUN_LEDGER: '/scratch/ledger.jsonl', RENOR_EVAL_MAX_EMBED_TOKENS: '5000000',
    }))).toBe(base);
    const json = canonicalJson(config());
    for (const secret of ['sk-embed-secret-value', 'ollama-secret-value', '/scratch/lane-a/evidence.db']) expect(json).not.toContain(secret);
    // A setting that merely contains a credential-like word keeps its value, so it cannot hide a difference.
    expect(runFingerprint(config(opts, { ...childEnv, RENOR_KEYWORD_WEIGHT: '2' })))
      .not.toBe(runFingerprint(config(opts, { ...childEnv, RENOR_KEYWORD_WEIGHT: '3' })));
    expect(config().productEnv).toMatchObject({ OPENAI_API_KEY: 'set', OLLAMA_CLOUD_KEY_4: 'set', RENOR_EVIDENCE_CACHE: 'set', RENOR_EVIDENCE_MODE: 'always', EMBEDDING_MODEL: 'gemini-embedding-001' });
  });
});

describe('run ledger: which environment is configuration', () => {
  it('keeps every product-namespace variable, drops shell, session and runner-only ones, and records credentials, project ids and caches by presence', () => {
    const env = {
      RENOR_NEWEST_FIRST: '0', RENOR_TEMPORAL_RANKING: 'off', RENOR_VAULT_STALENESS: '1', RENOR_EVIDENCE_MODEL: 'gemma4:31b', MVP_EMBEDDING_PROVIDER: 'vertex',
      EMBEDDING_MODEL: 'gemini-embedding-001', OPENAI_BASE_URL: 'http://127.0.0.1:18793/v1', CHUNK_MAX_TOKENS: '300', INDEX_CONCURRENCY: '4',
      LLM_EXTRACTION: 'false', MEMORY_DIR: 'Memory/Daily', CONVERSATIONS_DIR: 'Conversations', PRIORITY_PATHS: 'a,b', TZ: 'UTC',
      OPENAI_API_KEY: 'v1', OLLAMA_CLOUD_KEY_4: 'v2', RENOR_EVIDENCE_API_KEYS: 'v3', MVP_GATEWAY_SECRET: 'v4', GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
      MVP_VERTEX_KEY_FILE: '/k2.json', RENOR_EVAL_VERTEX_PROJECT: 'acct', RENOR_EVIDENCE_CACHE: '/c.db',
      PATH: '/usr/bin', HOME: '/home/example', TERM: 'xterm', SHELL: '/bin/bash', LANG: 'C.UTF-8', VAULT_PATH: '/v', DB_PATH: '/d',
      RENOR_QA_SESSION: 's', RENOR_QA_CACHE_SCOPE: 'x', RENOR_EVAL_RUN_LEDGER: '/l.jsonl', RENOR_EVAL_MAX_EMBED_TOKENS: '9', UNSET: undefined,
    };
    expect(productEnvironment(env)).toEqual({
      RENOR_NEWEST_FIRST: '0', RENOR_TEMPORAL_RANKING: 'off', RENOR_VAULT_STALENESS: '1', RENOR_EVIDENCE_MODEL: 'gemma4:31b', MVP_EMBEDDING_PROVIDER: 'vertex',
      EMBEDDING_MODEL: 'gemini-embedding-001', OPENAI_BASE_URL: 'http://127.0.0.1:18793/v1', CHUNK_MAX_TOKENS: '300', INDEX_CONCURRENCY: '4',
      LLM_EXTRACTION: 'false', MEMORY_DIR: 'Memory/Daily', CONVERSATIONS_DIR: 'Conversations', PRIORITY_PATHS: 'a,b', TZ: 'UTC',
      OPENAI_API_KEY: 'set', OLLAMA_CLOUD_KEY_4: 'set', RENOR_EVIDENCE_API_KEYS: 'set', MVP_GATEWAY_SECRET: 'set', GOOGLE_APPLICATION_CREDENTIALS: 'set',
      MVP_VERTEX_KEY_FILE: 'set', RENOR_EVAL_VERTEX_PROJECT: 'set', RENOR_EVIDENCE_CACHE: 'set',
    });
    // Every credential name the runner passes today, and the router keys an open PR adds, keeps only its presence...
    for (const name of ['OPENAI_API_KEY', 'RENOR_EVIDENCE_API_KEY', 'RENOR_EVIDENCE_API_KEYS', 'OLLAMA_CLOUD_KEY_1', 'OLLAMA_MAX_KEY', 'OLLAMA_API_KEY', 'RENOR_EXTRACTOR_API_KEYS', 'RENOR_ROUTER_API_KEYS', 'RENOR_ROUTER_CACHE']) {
      expect(isPresenceOnlyEnv(name), name).toBe(true);
    }
    // ...and so does a credential name with anything after the credential word (the OPENAI_API_KEY_BENCH value was
    // written to the shared ledger in plain text because only a name ENDING in _KEY was masked)...
    for (const name of ['OPENAI_API_KEY_BENCH', 'OPENAI_API_KEYS_BENCH', 'RENOR_EVIDENCE_API_KEY_PRIMARY', 'OLLAMA_CLOUD_KEY_BENCH_2', 'RENOR_DIGEST_API_KEY_B',
      'MVP_GATEWAY_SECRET_NEW', 'RENOR_API_TOKEN_PROD', 'GOOGLE_OAUTH_ACCESS_TOKEN_2', 'MVP_OWNER_PASSWORD_OLD', 'GOOGLE_APPLICATION_CREDENTIALS_BENCH', 'RENOR_VERTEX_KEY_FILE_2', 'EMBEDDING_APIKEY']) {
      expect(isPresenceOnlyEnv(name), name).toBe(true);
    }
    // ...whatever word the name then ends in: a trailing setting word never turns a credential name into a setting.
    for (const word of ['TTL_SECONDS', 'SECONDS', 'MS', 'MAX', 'MIN', 'LIMIT', 'COUNT', 'TIMEOUT', 'ENABLED', 'GUARD', 'ENV', 'NAMES', 'CANARY', 'CANDIDATE', 'MODE', 'POLICY', 'FILE']) {
      for (const credential of ['OPENAI_API_KEY_BENCH', 'MVP_REFRESH_TOKEN', 'RENOR_GATEWAY_SECRET', 'MVP_OWNER_PASSWORD', 'GOOGLE_APPLICATION_CREDENTIALS']) {
        expect(isPresenceOnlyEnv(`${credential}_${word}`), `${credential}_${word}`).toBe(true);
      }
    }
    // ...and a credential word in front of anything does too (the first part of the name is not special).
    for (const name of ['RENOR_SECRET_SCANNER_MODE', 'MVP_PASSWORD_POLICY', 'RENOR_TOKEN_TIMEOUT_MS', 'OPENAI_KEY_ENV', 'OLLAMA_KEY_ENV_NAMES', 'RENOR_SECRET_CANARY', 'RENOR_SECRET_CANDIDATE', 'RENOR_EVAL_SECRETS_FILE']) {
      expect(isPresenceOnlyEnv(name), name).toBe(true);
    }
    // Settings that merely contain such a letter run, or count tokens (the plural), keep their value, so they cannot hide a difference.
    for (const name of ['RENOR_EVIDENCE_MAX_TOKENS', 'RENOR_KEYWORD_WEIGHT', 'RENOR_SESSION_ROUTER', 'CHUNK_MAX_TOKENS', 'RENOR_CONTEXT_BUDGET_TOKENS', 'RENOR_DIGEST_TOKENS', 'RENOR_SESSION_EXPAND_TOKENS', 'MVP_KEYSTONE_MODE', 'RENOR_MONKEY_PATCH']) {
      expect(isPresenceOnlyEnv(name), name).toBe(false);
    }
    // The settings that really are read from the environment and carry a credential word keep their value, by full name only.
    for (const name of ['MVP_ACCESS_TOKEN_TTL_SECONDS', 'RENOR_SECRET_GUARD']) {
      expect(isPresenceOnlyEnv(name), name).toBe(false);
    }
    expect(isPresenceOnlyEnv('MVP_ACCESS_TOKEN_TTL_SECONDS_BENCH')).toBe(true);
    expect(isPresenceOnlyEnv('PREFIX_RENOR_SECRET_GUARD')).toBe(true);
    expect(isPresenceOnlyEnv('RENOR_SECRET_GUARD_KEY')).toBe(true);
  });

  it('records a suffixed credential name as "set", never its value, in the run record environment', () => {
    const secret = 'THIS-MUST-NOT-APPEAR-credential-value';
    const credentialNames = ['OPENAI_API_KEY_BENCH', 'OPENAI_API_KEY', 'RENOR_API_TOKEN_PROD', 'MVP_GATEWAY_SECRET_NEW', 'OPENAI_API_KEY_BENCH_TTL_SECONDS',
      'OPENAI_API_KEY_BENCH_ENABLED', 'OPENAI_API_KEY_BENCH_GUARD', 'OPENAI_API_KEY_BENCH_ENV', 'RENOR_SECRET_SCANNER_MODE', 'MVP_PASSWORD_POLICY'];
    const settings = { MVP_ACCESS_TOKEN_TTL_SECONDS: '900', RENOR_SECRET_GUARD: 'on', RENOR_EVIDENCE_MAX_TOKENS: '4096', CHUNK_MAX_TOKENS: '300' };
    const env = productEnvironment({ ...Object.fromEntries(credentialNames.map(name => [name, secret])), ...settings });
    expect(env).toEqual({ ...Object.fromEntries(credentialNames.map(name => [name, 'set'])), ...settings });
    expect(JSON.stringify(env)).not.toContain(secret);
  });

  it('every ordinary setting listed as having a credential word in its name is still read by engine/src', () => {
    // A listed name that engine/src no longer reads is stale and would keep a future credential of that name in the clear.
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith('.ts') && entry.name !== 'runLedger.ts' ? [path.join(dir, entry.name)] : []);
    const text = files(path.join(ENGINE_ROOT, 'src')).map(file => fs.readFileSync(file, 'utf8')).join('\n');
    for (const name of ORDINARY_CREDENTIAL_NAMED_ENV) expect(text.includes(name), name).toBe(true);
    expect([...ORDINARY_CREDENTIAL_NAMED_ENV].sort()).toEqual(['MVP_ACCESS_TOKEN_TTL_SECONDS', 'RENOR_SECRET_GUARD']);
  });

  it('every environment variable engine/src reads is inside the fingerprinted namespaces, or is listed here with why it is not configuration', () => {
    // If this fails, the product reads a new variable outside PRODUCT_ENV_NAMESPACES (src/eval/runLedger.ts): two runs
    // that differ in it would share a fingerprint and the second would be refused as a repeat. Widen the namespaces,
    // or add the name below with the reason its value cannot change a benchmark result.
    const notConfiguration: Record<string, string> = {
      VAULT_PATH: 'set per case by the runners; the vault content is fingerprinted as the dataset and question set',
      DB_PATH: 'set per case by the runners (a fresh index per question)',
      HOME: 'where caches and the run ledger live',
      LANGFUSE_HOST: 'MVP server telemetry; never on the CLI path, no effect on results',
      LANGFUSE_PUBLIC_KEY: 'MVP server telemetry',
      LANGFUSE_SECRET_KEY: 'MVP server telemetry',
      DO_NOT_TRACK: 'the sharing choice (src/sharing): it can only turn sharing off; no effect on results',
      XDG_CONFIG_HOME: 'where the sharing choice is kept (src/sharing/state.ts); no effect on results',
      XDG_STATE_HOME: 'where the sharing install id is kept (src/sharing/state.ts); no effect on results',
    };
    const read = new Set<string>();
    const access = /(?:process\.env|\benv)\s*(?:\.\s*([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g;
    const viaHelper = /\b[a-zA-Z_][a-zA-Z0-9_]*\(\s*['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]/g;
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : []);
    for (const file of walk(path.join(ENGINE_ROOT, 'src'))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(access)) read.add(match[1] ?? match[2]);
      for (const match of source.matchAll(viaHelper)) read.add(match[1]);
    }
    // The scan sees both direct reads and the helper-read flags (envFlagOn('RENOR_TEMPORAL_ASOF'), requiredEnv('MVP_...')).
    for (const known of ['RENOR_NEWEST_FIRST', 'RENOR_TEMPORAL_RANKING', 'RENOR_TEMPORAL_ASOF', 'RENOR_VAULT_STALENESS', 'CHUNK_MAX_TOKENS', 'MVP_INSTANCE_ID', 'EMBEDDING_PROVIDER']) {
      expect(read.has(known), known).toBe(true);
    }
    const uncovered = [...read].filter(name => !PRODUCT_ENV_NAMESPACES.test(name) && !(name in notConfiguration)).sort();
    expect(uncovered).toEqual([]);
  });
});

describe('run ledger: the file', () => {
  it('lives beside the eval caches under HOME unless RENOR_EVAL_RUN_LEDGER names another file, and cannot be turned off', () => {
    expect(resolveRunLedgerPath({ HOME: '/home/example' })).toBe('/home/example/.local/share/renor/eval-run-ledger.jsonl');
    expect(resolveRunLedgerPath({ HOME: '/home/example', RENOR_EVAL_RUN_LEDGER: '/scratch/ledger.jsonl' })).toBe('/scratch/ledger.jsonl');
    for (const off of ['off', '0']) expect(() => resolveRunLedgerPath({ RENOR_EVAL_RUN_LEDGER: off })).toThrow(/cannot turn the run ledger off/);
  });

  it('skips a torn last line (an append in progress) and fails closed on any other unreadable line', () => {
    const file = tmpPath('ledger-read.jsonl');
    expect(readRunLedger(file)).toEqual([]);
    const row = (id: string) => JSON.stringify({ id, fingerprint: id.repeat(4), outputDir: `/runs/${id}` });
    fs.writeFileSync(file, `${row('a')}\n${row('b')}\n{"id":"c","finger`);
    expect(readRunLedger(file).map(record => record.id)).toEqual(['a', 'b']);
    fs.writeFileSync(file, `${row('a')}\nnot json\n${row('b')}\n`);
    expect(() => readRunLedger(file)).toThrow(/line 2 is not JSON/);
    fs.writeFileSync(file, `${row('a')}\n{"id":"x"}\n`);
    expect(() => readRunLedger(file)).toThrow(/line 2 has no fingerprint/);
  });
});

describe('run ledger: admission', () => {
  it('admits a first run, refuses its exact repeat anywhere else, resumes it in its own directory, and records a stated reason', () => {
    const root = tmpPath('admission');
    const ledgerPath = path.join(root, 'ledger.jsonl');
    const runner = 'longmemeval-product';
    const config = { runner, answer: { model: 'deepseek-v4.1-flash' }, questions: questionSet(['q1', 'q2']) };
    const out = (name: string) => path.join(root, 'runs', name);
    const results = (name: string) => path.join(out(name), 'qa-cases.jsonl');
    const git = { gitSha: 'a'.repeat(40), gitDirty: false };

    const first = admitRun({ ledgerPath, runner, config, outputDir: out('one'), resuming: false });
    expect(first).toMatchObject({ priors: [], resumes: [], rerunReason: null, fingerprint: runFingerprint(config) });
    const one = recordRun(first, { ...git, perQuestionResults: results('one') });
    expect(readRunLedger(ledgerPath)).toEqual([one]);
    expect(one).toMatchObject({
      schema: 'renor-eval-run/v1', runner, fingerprint: runFingerprint(config), config, gitSha: git.gitSha, gitDirty: false,
      outputDir: out('one'), perQuestionResults: results('one'), resumes: [], rerun: null,
    });
    expect(path.dirname(path.dirname(one.archiveDir))).toBe(root);
    expect(fs.statSync(one.archiveDir).isDirectory()).toBe(true);

    // The same configuration anywhere else is a repeat; a different one is not.
    expect(() => admitRun({ ledgerPath, runner, config, outputDir: out('two'), resuming: false })).toThrow(RunRefusedError);
    expect(() => admitRun({ ledgerPath, runner, config, outputDir: out('two'), resuming: true })).toThrow(RunRefusedError);
    expect(admitRun({ ledgerPath, runner, config: { ...config, answer: { model: 'gemini-3.1-flash-lite' } }, outputDir: out('two'), resuming: false }).priors).toEqual([]);

    // Its own directory with its checkpoint is the same run; the same path without one is a repeat.
    const resumed = admitRun({ ledgerPath, runner, config, outputDir: out('one'), resuming: true });
    expect(resumed.priors).toEqual([]);
    expect(resumed.resumes.map(record => record.id)).toEqual([one.id]);
    const continued = recordRun(resumed, { ...git, perQuestionResults: results('one') });
    expect(continued).toMatchObject({ resumes: [one.id], rerun: null });
    expect(() => admitRun({ ledgerPath, runner, config, outputDir: out('one'), resuming: false })).toThrow(RunRefusedError);

    // A stated reason admits the repeat and is recorded with the runs it repeats.
    expect(() => admitRun({ ledgerPath, runner, config, outputDir: out('three'), resuming: false, rerunReason: '   ' })).toThrow(/--rerun-reason is empty/);
    const repeat = admitRun({ ledgerPath, runner, config, outputDir: out('three'), resuming: false, rerunReason: '  a fresh answer draw  ' });
    const three = recordRun(repeat, { ...git, perQuestionResults: results('three') });
    expect(three.rerun).toEqual({ reason: 'a fresh answer draw', priorRecordIds: [one.id, continued.id] });
    expect(readRunLedger(ledgerPath).map(record => record.id)).toEqual([one.id, continued.id, three.id]);
  });

  it('the refusal names every earlier run, its result if it finished, and where its per-question results are', () => {
    const root = tmpPath('refusal');
    const ledgerPath = path.join(root, 'ledger.jsonl');
    const runner = 'longmemeval-qa';
    const config = { runner, judge: { model: 'gemma4:31b' } };
    const git = { gitSha: 'b'.repeat(40), gitDirty: false };
    const outDir = (name: string) => path.join(root, name);

    // A run that was killed: on the ledger, two rows archived as they were written, no outcome.
    const killed = recordRun(admitRun({ ledgerPath, runner, config, outputDir: outDir('killed'), resuming: false }),
      { ...git, perQuestionResults: path.join(outDir('killed'), 'qa-cases.jsonl') });
    archiveRow(killed, JSON.stringify({ id: 'q1' }));
    archiveRow(killed, `${JSON.stringify({ id: 'q2' })}\n`);
    // A run that finished: its JSON artifacts are copied and its outcome written.
    const finished = recordRun(admitRun({ ledgerPath, runner, config, outputDir: outDir('finished'), resuming: false, rerunReason: 'the first one was killed' }),
      { ...git, perQuestionResults: path.join(outDir('finished'), 'qa-cases.jsonl') });
    fs.mkdirSync(outDir('finished'), { recursive: true });
    fs.writeFileSync(path.join(outDir('finished'), 'qa-cases.jsonl'), '{"id":"q1"}\n{"id":"q2"}\n');
    fs.writeFileSync(path.join(outDir('finished'), 'manifest.json'), '{"benchmark":"x"}\n');
    fs.writeFileSync(path.join(outDir('finished'), 'index.db'), 'not copied');
    saveRunOutcome(finished, { status: 'complete', finishedAt: '2026-10-03T00:00:00.000Z', casesTotal: 2, casesCompleted: 2, correct: 1 });
    expect(fs.readFileSync(path.join(finished.archiveDir, 'manifest.json'), 'utf8')).toBe('{"benchmark":"x"}\n');
    expect(fs.existsSync(path.join(finished.archiveDir, 'index.db'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(finished.archiveDir, 'outcome.json'), 'utf8'))).toMatchObject({ recordId: finished.id, status: 'complete', correct: 1 });

    let message = '';
    try {
      admitRun({ ledgerPath, runner, config, outputDir: outDir('third'), resuming: false });
    } catch (error) {
      expect(error).toBeInstanceOf(RunRefusedError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Refused: this exact configuration \(fingerprint [0-9a-f]{16}\) has already run 2 time\(s\)/);
    expect(message).toContain(outDir('killed'));
    expect(message).toContain(`no outcome recorded (stopped, killed or still running); 2 per-question row(s) in ${path.join(killed.archiveDir, 'qa-cases.jsonl')}`);
    expect(message).toContain(`complete: 1 correct, 2/2 questions; results ${finished.archiveDir}`);
    expect(message).toContain('(itself a re-run: the first one was killed)');
    expect(message).toContain('--rerun-reason');
    expect(message).toContain(`Ledger: ${ledgerPath}`);
  });
});

/** Model stubs that count every call the runner makes, health probes included. */
function countingHooks(calls: string[], judge: 'right' | 'fails' = 'right'): ProductHooks {
  return {
    publicSearch: async () => ({ hits: [{ notePath: 'Sessions/s1.md', text: 'alex drinks mango juice every morning.', score: 1 }], transport: 'stub', command: 'stub', durationMs: 0 }),
    models: {
      async modelCall(callType) {
        calls.push(callType);
        if (callType === 'judge' && judge === 'fails') throw new Error('HTTP 429');
        return callType === 'answer'
          ? { rawContent: 'mango juice', modelEcho: 'stub-answer', finishReason: 'stop', promptTokens: 10, completionTokens: 2, latencyMs: 1 }
          : { rawContent: '1', modelEcho: 'stub-judge', finishReason: 'stop', promptTokens: 10, completionTokens: 1, latencyMs: 1 };
      },
      async sentinel(callType) { calls.push(`sentinel:${callType}`); },
    },
  };
}

describe('the product runner records every run and refuses a repeat before it spends', () => {
  it('appends one record per run with its per-question results, archives them with the outcome, and refuses the repeat with zero provider calls', async () => {
    const root = tmpPath('product-ledger');
    const dataset = path.join(root, 'dataset.json');
    const ids = writeDataset(dataset);
    const ledgerPath = path.join(root, 'ledger.jsonl');
    const out = (name: string) => path.join(root, 'runs', name);
    const base: ProductRunnerOptions = {
      dataset, output: '', topK: 20, limit: 0, offset: 0, shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
      embeddingProvider: 'openai', arm: 'iteration', cache: false, maxLiveCalls: 50,
      answerModel: 'stub-answer', judgeModel: 'stub-judge', baseUrl: 'unused://stub', apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
    };
    const calls: string[] = [];
    const hooks = countingHooks(calls);

    await runProductBenchmark({ ...base, output: out('one'), runLedger: { path: ledgerPath } }, hooks);
    expect(calls).toEqual(['sentinel:answer', 'sentinel:judge', 'answer', 'judge', 'answer', 'judge']);
    const [one] = readRunLedger(ledgerPath);
    expect(one).toMatchObject({
      runner: 'longmemeval-product', outputDir: out('one'), perQuestionResults: path.join(out('one'), 'qa-cases.jsonl'), resumes: [], rerun: null,
    });
    expect(one.fingerprint).toBe(runFingerprint(one.config));
    expect(one.config).toMatchObject({
      answer: { model: 'stub-answer', baseUrl: 'unused://stub' },
      judge: { model: 'stub-judge', baseUrl: 'unused://stub' },
      questions: questionSet(ids),
      codeSha256: codeIdentity(ENGINE_ROOT, PRODUCT_RUN_CODE_ROOTS),
    });
    expect(fs.readFileSync(path.join(one.archiveDir, 'qa-cases.jsonl'), 'utf8')).toBe(fs.readFileSync(path.join(out('one'), 'qa-cases.jsonl'), 'utf8'));
    expect(fs.existsSync(path.join(one.archiveDir, 'manifest.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(one.archiveDir, 'outcome.json'), 'utf8'))).toMatchObject({
      recordId: one.id, status: 'complete', casesTotal: 2, casesCompleted: 2, correct: 2, answerErrors: 0, judgeParseFailures: 0, liveModelCalls: 4,
    });

    // The exact repeat in another directory: refused before the first provider call, nothing claimed, nothing recorded.
    await expect(runProductBenchmark({ ...base, output: out('two'), runLedger: { path: ledgerPath } }, hooks))
      .rejects.toThrow(/^Refused: this exact configuration[\s\S]*complete: 2 correct, 2\/2 questions/);
    await expect(runProductBenchmark({ ...base, output: out('two'), runLedger: { path: ledgerPath } }, hooks)).rejects.toBeInstanceOf(RunRefusedError);
    expect(calls).toHaveLength(6);
    expect(fs.existsSync(out('two'))).toBe(false);
    expect(readRunLedger(ledgerPath)).toHaveLength(1);

    // A stated reason runs it, and the reason is on its record.
    await runProductBenchmark({ ...base, output: out('three'), runLedger: { path: ledgerPath, rerunReason: 'fresh answer draw' } }, hooks);
    expect(calls).toHaveLength(12);
    const three = readRunLedger(ledgerPath)[1];
    expect(three).toMatchObject({ fingerprint: one.fingerprint, outputDir: out('three'), rerun: { reason: 'fresh answer draw', priorRecordIds: [one.id] } });

    // Another configuration is not a repeat.
    await runProductBenchmark({ ...base, answerStyle: 'bestguess', output: out('four'), runLedger: { path: ledgerPath } }, hooks);
    const four = readRunLedger(ledgerPath)[2];
    expect(four.fingerprint).not.toBe(one.fingerprint);
    expect(four.rerun).toBeNull();
  }, 60_000);

  it('a stopped run continues in its own directory without a reason, recorded as a resume of the first record', async () => {
    const root = tmpPath('product-ledger-resume');
    const dataset = path.join(root, 'dataset.json');
    writeDataset(dataset);
    const ledgerPath = path.join(root, 'ledger.jsonl');
    const output = path.join(root, 'runs', 'one');
    const base: ProductRunnerOptions = {
      dataset, output, topK: 20, limit: 0, offset: 0, shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
      embeddingProvider: 'openai', arm: 'iteration', cache: false, maxLiveCalls: 50, runLedger: { path: ledgerPath },
      answerModel: 'stub-answer', judgeModel: 'stub-judge', baseUrl: 'unused://stub', apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
    };
    const calls: string[] = [];

    await runProductBenchmark(base, countingHooks(calls, 'fails'));
    const [first] = readRunLedger(ledgerPath);
    expect(JSON.parse(fs.readFileSync(path.join(first.archiveDir, 'outcome.json'), 'utf8'))).toMatchObject({ status: 'incomplete', casesCompleted: 2, correct: 0 });

    await runProductBenchmark(base, countingHooks(calls));
    const records = readRunLedger(ledgerPath);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ fingerprint: first.fingerprint, outputDir: output, resumes: [first.id], rerun: null });
    expect(JSON.parse(fs.readFileSync(path.join(records[1].archiveDir, 'outcome.json'), 'utf8'))).toMatchObject({ status: 'complete', casesCompleted: 2, correct: 2 });
    expect(fs.readFileSync(path.join(records[1].archiveDir, 'qa-cases.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  }, 60_000);
});

// ─── The real runner processes: what an agent actually runs ───

interface Endpoint { baseUrl: string; requests: () => number; close(): Promise<void> }

/** An OpenAI-compatible /chat/completions stub on loopback that answers the runners' health probes and judges every answer correct. */
async function startChatEndpoint(): Promise<Endpoint> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests += 1;
      const request = JSON.parse(body) as { model: string; messages: Array<{ content: string }> };
      const last = request.messages[request.messages.length - 1].content;
      const content = /Reply with exactly OK/.test(last) ? 'OK' : request.model === 'stub-judge' ? '1' : 'mango juice';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: request.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests: () => requests, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/**
 * An OpenAI-compatible /embeddings stub on loopback serving deterministic hash vectors. With `failOn`, a request
 * carrying that text is answered HTTP 400, which the embedding client does not retry: the run stops at that question.
 */
async function startEmbeddingEndpoint(options: { failOn?: string } = {}): Promise<Endpoint> {
  const hash = new EvalHashEmbeddingProvider();
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      void (async () => {
        requests += 1;
        const { input, encoding_format: encoding } = JSON.parse(body) as { input: string | string[]; encoding_format?: string };
        const texts = Array.isArray(input) ? input : [input];
        if (options.failOn && texts.some(text => text.includes(options.failOn!))) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'stub: refused on purpose', type: 'invalid_request_error' } }));
          return;
        }
        const vectors = await hash.embed(texts);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          model: 'stub-eval-hash',
          data: vectors.map((vector, index) => ({
            object: 'embedding',
            index,
            embedding: encoding === 'base64' ? Buffer.from(new Float32Array(vector).buffer).toString('base64') : vector,
          })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }));
      })();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests: () => requests, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/**
 * Run a runner script as an agent would, with a scrubbed environment: a throwaway HOME (so nothing reaches the
 * real ledger or caches), loopback endpoints only, no credential but a stub key.
 */
function runScript(script: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: ENGINE_ROOT,
      env: { PATH: process.env.PATH ?? '', TMPDIR: os.tmpdir(), ...env },
    });
    let stderr = '';
    child.stdout.on('data', () => { /* the result JSON is not needed */ });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
}

/** The three-step contract every runner CLI keeps: record the first run, refuse the repeat before any request, run it with a reason. */
async function expectRecordRefuseRerun(args: {
  runner: string;
  endpoint: Endpoint;
  ledgerPath: string;
  run: (output: string, extra: string[]) => Promise<{ code: number | null; stderr: string }>;
  outputs: [string, string, string];
  expectFirst: (record: RunRecord) => void;
}): Promise<void> {
  const [first, repeat, stated] = args.outputs;
  const one = await args.run(first, []);
  expect(one.code, one.stderr).toBe(0);
  const records = readRunLedger(args.ledgerPath);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ runner: args.runner, outputDir: first, rerun: null });
  expect(records[0].fingerprint).toBe(runFingerprint(records[0].config));
  expect(fs.existsSync(path.join(records[0].archiveDir, 'outcome.json'))).toBe(true);
  args.expectFirst(records[0]);

  const before = args.endpoint.requests();
  const refused = await args.run(repeat, []);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toMatch(/Refused: this exact configuration \(fingerprint [0-9a-f]{16}\) has already run 1 time\(s\)/);
  expect(refused.stderr).toContain(first);
  expect(refused.stderr).not.toMatch(/\n\s+at /); // the refusal, not a stack trace
  expect(args.endpoint.requests()).toBe(before);
  expect(fs.existsSync(repeat)).toBe(false);
  expect(readRunLedger(args.ledgerPath)).toHaveLength(1);

  const again = await args.run(stated, ['--rerun-reason', 'prove the stated repeat is recorded']);
  expect(again.code, again.stderr).toBe(0);
  expect(args.endpoint.requests()).toBeGreaterThan(before);
  const after = readRunLedger(args.ledgerPath);
  expect(after).toHaveLength(2);
  expect(after[1]).toMatchObject({ fingerprint: records[0].fingerprint, outputDir: stated, rerun: { reason: 'prove the stated repeat is recorded', priorRecordIds: [records[0].id] } });
}

describe('every LongMemEval runner CLI records its run and refuses a repeat before any provider request', () => {
  it('the product runner', async () => {
    const endpoint = await startChatEndpoint();
    const root = tmpPath('cli-product');
    const dataset = path.join(root, 'dataset.json');
    writeDataset(dataset);
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const ledgerPath = path.join(root, 'ledger', 'runs.jsonl');
    const out = (name: string) => path.join(root, 'runs', name);
    const runProduct = (output: string, extra: string[], env: Record<string, string> = {}) => runScript('scripts/eval/run-longmemeval-product.ts', [
      '--dataset', dataset, '--output', output, '--embedding-provider', 'eval-hash', '--transport-smoke', '--limit', '0',
      '--no-cache', '--max-live-calls', '10', '--base-url', endpoint.baseUrl, '--answer-model', 'stub-answer',
      '--judge-model', 'stub-judge', '--api-key-env', 'STUB_QA_KEY', '--retries', '1', ...extra,
    ], { HOME: home, STUB_QA_KEY: 'stub-key', RENOR_EVAL_RUN_LEDGER: ledgerPath, RENOR_SEARCH_EVIDENCE: '0', ...env });
    try {
      await expectRecordRefuseRerun({
        runner: 'longmemeval-product',
        endpoint,
        ledgerPath,
        outputs: [out('one'), out('two'), out('three')],
        run: (output, extra) => runProduct(output, extra),
        expectFirst: record => {
          expect(record.perQuestionResults).toBe(path.join(out('one'), 'qa-cases.jsonl'));
          expect(JSON.parse(fs.readFileSync(path.join(record.archiveDir, 'outcome.json'), 'utf8'))).toMatchObject({ status: 'complete', casesTotal: 2, correct: 2 });
        },
      });
      expect(fs.existsSync(path.join(home, '.local'))).toBe(false); // RENOR_EVAL_RUN_LEDGER was honoured

      // A setting the product reads but no runner names reaches the product process from the shell (the review's F1):
      // it is a different configuration, so the run is admitted without a reason and recorded with that value...
      const before = endpoint.requests();
      const newestOff = await runProduct(out('newest-off'), [], { RENOR_NEWEST_FIRST: '0' });
      expect(newestOff.code, newestOff.stderr).toBe(0);
      expect(endpoint.requests()).toBeGreaterThan(before);
      const records = readRunLedger(ledgerPath);
      expect(records).toHaveLength(3);
      expect(records[2]).toMatchObject({ outputDir: out('newest-off'), rerun: null });
      expect(records[2].fingerprint).not.toBe(records[0].fingerprint);
      expect((records[2].config.productEnv as Record<string, string>).RENOR_NEWEST_FIRST).toBe('0');
      // ...and its own exact repeat is refused like any other.
      const repeat = await runProduct(out('newest-off-again'), [], { RENOR_NEWEST_FIRST: '0' });
      expect(repeat.code).not.toBe(0);
      expect(repeat.stderr).toContain(out('newest-off'));
      expect(readRunLedger(ledgerPath)).toHaveLength(3);
    } finally {
      await endpoint.close();
    }
  }, 240_000);

  it('the QA stage, with the ledger at its default path, and the same retrieval artifacts copied elsewhere still a repeat', async () => {
    const endpoint = await startChatEndpoint();
    const root = tmpPath('cli-qa');
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const retrieval = (name: string) => path.join(root, name);
    const caseRows = ['alex', 'sam'].map(id => ({ id, category: 'single-session-user', query: `Question date: 2026/02/01 (Sun) 09:00\nWhat does ${id} drink?`, relevant: [], expectedAnswer: 'mango juice', shouldAbstain: false }));
    const resultRows = caseRows.map(row => ({ id: row.id, hits: [{ text: `${row.id} drinks mango juice every morning.`, notePath: `People/${row.id}.md`, score: 1 }], latencyMs: 1, contextTokens: 9 }));
    for (const name of ['retrieval-a', 'retrieval-b']) {
      fs.mkdirSync(retrieval(name), { recursive: true });
      fs.writeFileSync(path.join(retrieval(name), 'cases.jsonl'), caseRows.map(row => JSON.stringify(row)).join('\n') + '\n');
      fs.writeFileSync(path.join(retrieval(name), 'results.jsonl'), resultRows.map(row => JSON.stringify(row)).join('\n') + '\n');
      fs.writeFileSync(path.join(retrieval(name), 'manifest.json'), '{}\n');
    }
    const ledgerPath = path.join(home, '.local', 'share', 'renor', 'eval-run-ledger.jsonl');
    const out = (name: string) => path.join(root, 'runs', name);
    try {
      await expectRecordRefuseRerun({
        runner: 'longmemeval-qa',
        endpoint,
        ledgerPath,
        outputs: [out('one'), out('two'), out('three')],
        // The repeat reads a byte-identical copy of the retrieval run from another directory.
        run: (output, extra) => runScript('scripts/eval/run-longmemeval-qa.ts', [
          '--run', retrieval(output === out('one') ? 'retrieval-a' : 'retrieval-b'), '--output', output, '--no-cache',
          '--base-url', endpoint.baseUrl, '--answer-model', 'stub-answer', '--judge-model', 'stub-judge', '--api-key-env', 'STUB_QA_KEY',
          '--retries', '1', ...extra,
        ], { HOME: home, STUB_QA_KEY: 'stub-key', RENOR_QA_BASE_URL: endpoint.baseUrl }),
        expectFirst: record => {
          expect(record.perQuestionResults).toBe(path.join(out('one'), 'qa-cases.jsonl'));
          expect(fs.readFileSync(path.join(record.archiveDir, 'qa-cases.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
          expect(JSON.parse(fs.readFileSync(path.join(record.archiveDir, 'outcome.json'), 'utf8'))).toMatchObject({ status: 'complete', casesTotal: 2, correct: 2, liveModelCalls: 4 });
        },
      });
    } finally {
      await endpoint.close();
    }
  }, 240_000);

  it('the retrieval stage, including a shell setting it reads in-process and a run that stops halfway', async () => {
    const endpoint = await startEmbeddingEndpoint();
    const failing = await startEmbeddingEndpoint({ failOn: 'green tea' });
    const root = tmpPath('cli-retrieval');
    const dataset = path.join(root, 'dataset.json');
    writeDataset(dataset);
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const ledgerPath = path.join(root, 'ledger.jsonl');
    const out = (name: string) => path.join(root, 'runs', name);
    const runRetrieval = (output: string, extra: string[], env: Record<string, string> = {}) => runScript('scripts/eval/run-longmemeval.ts', [
      '--dataset', dataset, '--output', output, '--provider', 'openai', '--model', 'stub-eval-hash', '--top-k', '5', '--limit', '0', ...extra,
    ], {
      HOME: home, RENOR_EVAL_RUN_LEDGER: ledgerPath, RENOR_EVAL_EMBEDDING_BASE_URL: endpoint.baseUrl, RENOR_EVAL_EMBEDDING_API_KEY: 'stub-key',
      RENOR_EVAL_EMBEDDING_DIMS: '256', RENOR_SEARCH_EVIDENCE: '0',
      // A fresh embedding cache per run, so every admitted run really calls the provider. (With the cache off
      // the runner cannot write its manifest: CountingEmbeddingProvider has no describe(), a defect on main.)
      RENOR_EVAL_EMBED_CACHE: path.join(root, `embed-cache-${path.basename(output)}.db`),
      ...env,
    });
    try {
      await expectRecordRefuseRerun({
        runner: 'longmemeval-retrieval',
        endpoint,
        ledgerPath,
        outputs: [out('one'), out('two'), out('three')],
        run: (output, extra) => runRetrieval(output, extra),
        expectFirst: record => {
          expect(record.perQuestionResults).toBe(path.join(out('one'), 'results.jsonl'));
          expect(fs.readFileSync(path.join(record.archiveDir, 'results.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
          expect(JSON.parse(fs.readFileSync(path.join(record.archiveDir, 'outcome.json'), 'utf8'))).toMatchObject({ status: 'complete', casesTotal: 2, casesCompleted: 2 });
        },
      });

      // The retrieval code runs inside this process, so a shell setting it reads is configuration too.
      const newestOff = await runRetrieval(out('newest-off'), [], { RENOR_NEWEST_FIRST: '0' });
      expect(newestOff.code, newestOff.stderr).toBe(0);
      const afterNewest = readRunLedger(ledgerPath);
      expect(afterNewest).toHaveLength(3);
      expect(afterNewest[2].fingerprint).not.toBe(afterNewest[0].fingerprint);
      expect((afterNewest[2].config.productEnv as Record<string, string>).RENOR_NEWEST_FIRST).toBe('0');

      // A run that stops at its second question is on the ledger with its first question's row archived, and no outcome.
      const stopped = await runRetrieval(out('stopped'), [], { RENOR_EVAL_EMBEDDING_BASE_URL: failing.baseUrl });
      expect(stopped.code).not.toBe(0);
      const stoppedRecord = readRunLedger(ledgerPath)[3];
      expect(stoppedRecord).toMatchObject({ runner: 'longmemeval-retrieval', outputDir: out('stopped') });
      const archived = fs.readFileSync(path.join(stoppedRecord.archiveDir, 'results.jsonl'), 'utf8').trim().split('\n');
      expect(archived.map(line => (JSON.parse(line) as { id: string }).id)).toEqual(['alex']);
      expect(fs.existsSync(path.join(stoppedRecord.archiveDir, 'outcome.json'))).toBe(false);
      const repeatStopped = await runRetrieval(out('stopped-again'), [], { RENOR_EVAL_EMBEDDING_BASE_URL: failing.baseUrl });
      expect(repeatStopped.code).not.toBe(0);
      expect(repeatStopped.stderr).toContain('no outcome recorded (stopped, killed or still running); 1 per-question row(s)');
    } finally {
      await endpoint.close();
      await failing.close();
    }
  }, 240_000);
});
