import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { signTestP } from '../../scripts/eval/session-router-trial-report';
import { startStubServer } from '../router/stubRouterModel';
import { SESSIONS } from '../router/fixtureSessions';

/**
 * The one-command session-router trial (scripts/eval/session-router-trial.sh), end to end and offline: --smoke runs
 * the three arms through the product benchmark client with eval-hash embeddings and every model (summaries, router,
 * reader, judge) answered by a local stub, then writes the paired report. Proves the plumbing the paid full-500 run
 * relies on: arms differ only in the router flag, the router arms share one router cache, and the report pairs them.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The trial refuses any Node major but the engine's pin (mise.toml), as the agent gate does: a measurement run on another
// major would fail native modules for the wrong reason. So the tests that get past that refusal run only on the pinned
// major (the public CI's Node 24 job skips them); the refusals themselves are tested on every Node.
const PINNED_NODE = /^node\s*=\s*"?(\d+)/m.exec(fs.readFileSync(path.join(REPO_ROOT, 'mise.toml'), 'utf8'))?.[1];
const ON_PINNED_NODE = process.versions.node.split('.')[0] === PINNED_NODE;

function dataset(root: string): string {
  const row = (id: string, question: string, answer: string, gold: string[]) => ({
    question_id: id,
    question,
    question_date: '2023/05/30 (Tue) 12:00',
    answer,
    answer_session_ids: gold,
    question_type: 'multi-session',
    haystack_session_ids: SESSIONS.map(s => s.id),
    haystack_sessions: SESSIONS.map(s => s.turns.map(turn => ({ ...turn, ...(/adopted/.test(turn.content) && turn.role === 'user' ? { has_answer: true } : {}) }))),
    haystack_dates: SESSIONS.map(s => s.date),
  });
  const file = path.join(root, 'ds.json');
  fs.writeFileSync(file, JSON.stringify([
    row('trial-q1', 'Which cat did I take home from the shelter?', 'Tofu', ['sess-cats-3']),
  ]));
  return file;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('bash', ['scripts/eval/session-router-trial.sh', ...args], { cwd: REPO_ROOT, env, timeout: 280_000 }, (err, stdout, stderr) => resolve({
      code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0,
      stdout: String(stdout),
      stderr: String(stderr),
    }));
  });
}

/** A token endpoint for a made-up service account, and the key file that names it (never a Google endpoint). */
async function fakeServiceAccount(root: string): Promise<{ keyFile: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'vertex-test-token', expires_in: 3600 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = path.join(root, 'service-account.json');
  fs.writeFileSync(keyFile, JSON.stringify({
    client_email: 'trial@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`,
  }));
  return { keyFile, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe('session-router trial command (offline smoke)', () => {
  it('refuses a fresh control without a reason (the captain\'s rule: never re-run the default as a baseline)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-router-control-'));
    try {
      const result = await run(['--smoke', '--dataset', dataset(root), '--out', path.join(root, 'trial'), '--arms', 'replace,control',
        '--router-key-env', 'PATH', '--answer-key-env', 'PATH'], { PATH: process.env.PATH, HOME: process.env.HOME });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('a fresh control re-runs the default configuration');
      expect(fs.existsSync(path.join(root, 'trial', 'control'))).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  });

  it('pairs the router arms with a recorded run and names every setting that differs from it', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-router-baseline-'));
    try {
      const manifest = (overrides: string[], answerModel = 'reader-x') => ({
        models: { answerRequested: answerModel, judgeRequested: 'judge-y' }, topK: 20, maxContextTokens: 6000, temperature: 0,
        productMode: { overrides: ['EMBEDDING_PROVIDER=openai', 'topK=20', 'contextDates=true', 'stripExcerptMeta=false', 'answerStyle=direct', ...overrides] },
        embeddingProvider: 'openai', embeddingModel: 'gemini-embedding-001', embeddingDims: 768,
        provenance: { datasetSha256: 'd1', evaluatorSha256: 'e1', gitSha: 'abc' },
      });
      const write = (dir: string, cases: Array<{ id: string; verdict: 0 | 1 }>, m: object) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'qa-cases.jsonl'), cases.map(c => JSON.stringify({
          id: c.id, category: 'multi-session', contextTokens: 100, hitsUsed: 1, answer: { usage: {} }, judge: { verdict: c.verdict },
        })).join('\n') + '\n');
        fs.writeFileSync(path.join(dir, 'results.jsonl'), cases.map(c => JSON.stringify({ id: c.id, hits: [] })).join('\n') + '\n');
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
      };
      const out = path.join(root, 'trial');
      const ids = ['q1', 'q2', 'q3'];
      write(path.join(out, 'replace'), ids.map((id, i) => ({ id, verdict: (i < 2 ? 1 : 0) as 0 | 1 })),
        manifest(['RENOR_SESSION_ROUTER=replace', 'RENOR_ROUTER_MODEL=m', 'idsFile=ids.txt(3 ids)']));
      write(path.join(out, 'union'), ids.map(id => ({ id, verdict: 1 as const })), manifest(['RENOR_SESSION_ROUTER=union'], 'reader-z'));
      // An older recorded run: it leaves the default-valued client settings out of its overrides and ran other evaluator code.
      const recorded = manifest([]) as ReturnType<typeof manifest> & { productMode: { overrides: string[] } };
      recorded.productMode.overrides = ['EMBEDDING_PROVIDER=openai', 'topK=20', 'contextDates=true'];
      recorded.provenance = { ...recorded.provenance, evaluatorSha256: 'e0' };
      write(path.join(root, 'recorded'), ids.map(id => ({ id, verdict: 0 as const })), recorded);
      const ds = path.join(root, 'ds.json');
      fs.writeFileSync(ds, JSON.stringify(ids.map(id => ({ question_id: id, question_type: 'multi-session', answer_session_ids: [], haystack_session_ids: [], haystack_sessions: [] }))));
      const result = await new Promise<{ code: number; stderr: string }>(resolve => execFile(process.execPath, [
        '--import', 'tsx', 'scripts/eval/session-router-trial-report.ts', '--out', out, '--dataset', ds, '--arms', 'replace,union',
        '--baseline', path.join(root, 'recorded'),
      ], { cwd: REPO_ROOT }, (err, _stdout, stderr) => resolve({ code: err ? 1 : 0, stderr: String(stderr) })));
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
      expect(report.pairedWithControl.replace).toMatchObject({
        comparator: 'baseline', cases: 3, wins: 2, losses: 0, configurationDifferences: [], evaluator: { arm: 'e1', comparator: 'e0', same: false },
      });
      expect(report.pairedWithControl.union).toMatchObject({
        comparator: 'baseline', wins: 3, configurationDifferences: [{ field: 'answerModel', arm: 'reader-z', comparator: 'reader-x' }],
      });
      const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
      expect(md).toContain('the recorded run');
      expect(md).toContain('| replace | 3 | 2 | 0 | +2 |');
      expect(md).toContain('settings match exactly; evaluator code differs');
      expect(md).toContain('settings differ: answerModel');
    } finally {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  });

  it('computes the exact two-sided sign test', () => {
    expect(signTestP(0, 0)).toBe(1);
    expect(signTestP(10, 0)).toBeCloseTo(0.001953, 6); // 2 * 0.5^10
    expect(signTestP(3, 3)).toBe(1);
    expect(signTestP(13, 3)).toBeCloseTo(0.02127, 4); // the scout's Tu vs Bev
  });

  it.runIf(ON_PINNED_NODE)('stops before the summary phase could exceed --warm-max-calls (exit 3, no arm runs), and a rerun continues', async () => {
    const stub = await startStubServer();
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-router-warm-'));
    try {
      const out = path.join(root, 'trial');
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), STUB_KEY: 'stub-key' };
      const args = [
        '--smoke', '--dataset', dataset(root), '--out', out, '--evidence', 'off', '--arms', 'replace', '--warm-only',
        '--router-model', 'stub-router', '--summary-model', 'stub-summary', '--router-base-url', stub.baseUrl,
        '--router-key-env', 'STUB_KEY', '--router-retries', '0',
        '--answer-model', 'stub-reader', '--answer-base-url', stub.baseUrl, '--answer-key-env', 'STUB_KEY', '--judge-model', 'stub-judge',
      ];
      const stopped = await run([...args, '--warm-max-calls', '5'], env);
      expect(stopped.code, stopped.stderr).toBe(3);
      expect(stopped.stderr).toContain('stopped at --warm-max-calls 5');
      expect(fs.existsSync(path.join(out, 'replace'))).toBe(false);
      expect(stub.calls).toHaveLength(0);
      const resumed = await run(args, env);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain('--warm-only: summaries are in place, no arm was run');
      expect(fs.readFileSync(path.join(out, 'summaries.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
        .toEqual([expect.objectContaining({ id: 'trial-q1', model: 'stub-summary', notes: 4, summarized: 4, failed: 0, calls: 1 })]);
      expect(stub.calls.map(call => call.kind)).toEqual(['summary']);
    } finally {
      await stub.close();
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }, 300_000);

  it.runIf(ON_PINNED_NODE)('--vertex-roles sends the summaries, the router and the reader through the Vertex chat proxy, and never the judge', async () => {
    const vertex = await startStubServer(); // stands in for Vertex's OpenAI-compatible endpoint
    const judge = await startStubServer();
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-router-vertex-'));
    const account = await fakeServiceAccount(root);
    try {
      const out = path.join(root, 'trial');
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), JUDGE_KEY: 'judge-key',
        GOOGLE_APPLICATION_CREDENTIALS: account.keyFile, RENOR_EVAL_VERTEX_PROJECT: 'eval-project',
        RENOR_EVAL_RUN_LEDGER: path.join(root, 'run-ledger.jsonl'), // never the shared run ledger
      };
      const result = await run([
        '--smoke', '--dataset', dataset(root), '--out', out, '--evidence', 'off', '--arms', 'replace',
        '--vertex-roles', 'summaries,router,reader', '--vertex-upstream-base', vertex.baseUrl,
        '--router-model', 'stub-router', '--summary-model', 'stub-summary', '--router-retries', '0', '--answer-model', 'stub-reader',
        '--judge-model', 'stub-judge', '--judge-base-url', judge.baseUrl, '--judge-key-env', 'JUDGE_KEY',
      ], env);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);

      // Every summary, routing and reader call reached the upstream through the proxy, under the Vertex model names.
      expect(new Set(vertex.calls.map(call => call.kind))).toEqual(new Set(['summary', 'route', 'sentinel', 'answer']));
      expect(vertex.calls.every(call => String(call.body.model).startsWith('google/'))).toBe(true);
      expect(new Set(judge.calls.map(call => call.kind))).toEqual(new Set(['sentinel', 'judge']));
      const stats = JSON.parse(fs.readFileSync(path.join(out, 'vertex-chat-proxy-stats.json'), 'utf8'));
      expect(Object.keys(stats.byModel).sort()).toEqual(['stub-reader', 'stub-router', 'stub-summary']);
      expect(stats.byModel['stub-summary']).toMatchObject({ requests: 1, ok: 1 });
      expect(stats.byModel['stub-router']).toMatchObject({ requests: 1, ok: 1 });
      expect(stats.tokenRenewals).toBe(1);

      // The run names each role's endpoint: Vertex for the three, the judge's own for the judge; never a key.
      const [run0] = fs.readFileSync(path.join(out, 'trial-runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const label = `vertex-ai (upstream ${vertex.baseUrl}, via scripts/eval/vertex-chat-proxy.ts)`;
      expect(run0).toMatchObject({ vertexRoles: 'summaries,router,reader', summaryEndpoint: label, routerEndpoint: label, readerEndpoint: label, judgeEndpoint: judge.baseUrl });
      expect(JSON.stringify(run0)).not.toMatch(/judge-key|vertex-test-token/);
      const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
      expect(report.arms.replace).toMatchObject({ n: 1, correct: 1 });
      expect(report.summaryPhase.byEndpoint[label]).toMatchObject({ questions: 1, calls: 1 });
    } finally {
      await vertex.close();
      await judge.close();
      await account.close();
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }, 300_000);

  it.runIf(ON_PINNED_NODE)('runs replace, union and control through the product client and writes the paired report', async () => {
    const stub = await startStubServer();
    const summaries = await startStubServer(); // the summary phase's own endpoint (as --vertex-summaries gives it)
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-router-trial-'));
    try {
      const out = path.join(root, 'trial');
      const ledgerPath = path.join(root, 'run-ledger.jsonl');
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), STUB_KEY: 'stub-key', SUMMARY_STUB_KEY: 'summary-key',
        RENOR_EVAL_RUN_LEDGER: ledgerPath,
      };
      const result = await run([
        '--smoke', '--dataset', dataset(root), '--out', out, '--evidence', 'off',
        '--arms', 'replace,union,control', '--control-reason', 'offline smoke: no recorded run covers this fixture',
        '--router-model', 'stub-router', '--summary-model', 'stub-summary', '--router-base-url', stub.baseUrl,
        '--router-key-env', 'STUB_KEY', '--router-retries', '0',
        '--summary-base-url', summaries.baseUrl, '--summary-key-env', 'SUMMARY_STUB_KEY',
        '--answer-model', 'stub-reader', '--answer-base-url', stub.baseUrl, '--answer-key-env', 'STUB_KEY', '--judge-model', 'stub-judge',
      ], env);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);

      const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
      expect(Object.keys(report.arms)).toEqual(['replace', 'union', 'control']);
      for (const arm of ['replace', 'union', 'control']) {
        expect(report.arms[arm]).toMatchObject({ n: 1, correct: 1, errors: 0, evidenceAll: 1, evidenceCases: 1 });
      }
      expect(report.arms.replace.productOverrides).toEqual(expect.arrayContaining(['RENOR_SESSION_ROUTER=replace', 'RENOR_ROUTER_MODEL=stub-router', 'RENOR_ROUTER_SUMMARY_MODEL=stub-summary']));
      expect(report.arms.union.productOverrides).toContain('RENOR_SESSION_ROUTER=union');
      expect(report.arms.control.productOverrides.join()).not.toContain('RENOR_SESSION_ROUTER');
      expect(report.arms.control.routerCoverage).toBeNull();
      expect(report.pairedWithControl.replace).toMatchObject({ comparator: 'control', cases: 1, wins: 0, losses: 0, net: 0, p: 1, configurationDifferences: [] });

      // One router cache for the trial: the summary phase wrote every summary before any arm answered (the arms' own
      // index replays them), and the union arm asks the router the same question over the same notes (answer replayed).
      expect(report.summaryPhase).toMatchObject({ questions: 1, runs: 1, models: ['stub-summary'], summarized: 4, failed: 0, calls: 1 });
      expect(report.summaryPhase.byEndpoint).toEqual({ [summaries.baseUrl]: { questions: 1, calls: 1, summarized: 4, promptTokens: expect.any(Number), completionTokens: expect.any(Number) } });
      // Each invocation says what it ran against, and never a key.
      const runs = fs.readFileSync(path.join(out, 'trial-runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(runs).toEqual([expect.objectContaining({
        arms: 'replace,union,control', cases: '1', evidence: 'off', smoke: '1',
        controlReason: 'offline smoke: no recorded run covers this fixture',
        summaryModel: 'stub-summary', summaryEndpoint: summaries.baseUrl, routerModel: 'stub-router', routerEndpoint: stub.baseUrl,
        readerModel: 'stub-reader', readerEndpoint: stub.baseUrl, judgeModel: 'stub-judge', judgeEndpoint: stub.baseUrl,
        gitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      })]);
      expect(fs.readFileSync(path.join(out, 'trial-runs.jsonl'), 'utf8')).not.toMatch(/stub-key|summary-key/);
      expect(report.runs).toHaveLength(1);
      // Every arm is on the eval run ledger the caller named (src/eval/runLedger.ts; the trial's scrubbed environment
      // forwards RENOR_EVAL_RUN_LEDGER), and each fingerprint sees the router's settings: three arms, three
      // configurations, credentials and the cache path by presence only.
      const ledger = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as Array<{
        runner: string; fingerprint: string; outputDir: string; config: { productEnv: Record<string, string> };
      }>;
      expect(ledger.map(record => [record.runner, path.basename(record.outputDir)])).toEqual([
        ['longmemeval-product', 'replace'], ['longmemeval-product', 'union'], ['longmemeval-product', 'control'],
      ]);
      expect(new Set(ledger.map(record => record.fingerprint)).size).toBe(3);
      expect(ledger[0].config.productEnv).toMatchObject({
        RENOR_SESSION_ROUTER: 'replace', RENOR_ROUTER_MODEL: 'stub-router', RENOR_ROUTER_SUMMARY_MODEL: 'stub-summary',
        RENOR_ROUTER_BASE_URL: stub.baseUrl, RENOR_ROUTER_API_KEY: 'set', RENOR_ROUTER_CACHE: 'set',
      });
      expect(ledger[1].config.productEnv).toMatchObject({ RENOR_SESSION_ROUTER: 'union', RENOR_ROUTER_MODEL: 'stub-router' });
      expect(Object.keys(ledger[2].config.productEnv).filter(name => name.includes('ROUTER'))).toEqual([]);
      expect(fs.readFileSync(ledgerPath, 'utf8')).not.toMatch(/stub-key|summary-key/);
      expect(report.arms.replace.routerCoverage).toMatchObject({ cases: 1, routed: 1, skipped: {}, route: { answers: 1, liveCalls: 1 } });
      expect(report.arms.replace.routerCoverage.summaries).toMatchObject({ indexRuns: 1, notes: 4, summarized: 0, cached: 4, failed: 0, liveCalls: 0 });
      expect(report.arms.union.routerCoverage).toMatchObject({ cases: 1, routed: 1, route: { answers: 1, liveCalls: 0 } });
      expect(report.arms.union.routerCoverage.summaries).toMatchObject({ summarized: 0, cached: 4, liveCalls: 0 });
      // Summaries went to the summary endpoint only, routing to the router's only.
      expect(summaries.calls.map(call => call.kind)).toEqual(['summary']);
      expect(stub.calls.filter(call => call.kind === 'summary')).toHaveLength(0);
      expect(stub.calls.filter(call => call.kind === 'route')).toHaveLength(1);

      // The replace arm answered from the routed statements, not from the retrieved chunks.
      const replaced = JSON.parse(fs.readFileSync(path.join(out, 'replace', 'results.jsonl'), 'utf8').trim()) as { hits: Array<{ notePath: string; text: string }> };
      expect(replaced.hits).toHaveLength(1);
      expect(replaced.hits[0].notePath).toMatch(/^Sessions\/sess-cats-3-[0-9a-f]{10}\.md$/);
      expect(replaced.hits[0].text).toContain('I also adopted a second cat, Tofu');
      const control = JSON.parse(fs.readFileSync(path.join(out, 'control', 'results.jsonl'), 'utf8').trim()) as { hits: Array<{ notePath: string }> };
      expect(control.hits.length).toBeGreaterThan(1); // the retrieved window, from every session
      expect(fs.readFileSync(path.join(out, 'report.md'), 'utf8')).toContain('## Paired with `control`');
    } finally {
      await stub.close();
      await summaries.close();
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }, 300_000);
});
