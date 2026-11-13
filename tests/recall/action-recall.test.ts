import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { replyTokens } from '../../src/mvp/agentMemory';
import type { GetContextCaller } from '../../src/recall/autoRecall';
import {
  actionRecall, classifyAction, gateFirstTime, loadActionConfig, runActionHook, selectRules, type ActionRecallConfig,
} from '../../src/recall/actionRecall';
import { removeTempDirsAfterAll } from '../helpers/tmpCleanup';

removeTempDirsAfterAll();

/**
 * Pre-action recall (src/recall/actionRecall.ts): off does nothing, only gated actions are looked up, superseded rules
 * are hidden, at most three are shown newest first with dates, the budget holds, failures let the tool run, and the gate
 * denies once per action kind and then lets the retry through.
 */
const ON = { RENOR_ACTION_RECALL: '1', RENOR_AUTO_RECALL_TOKEN: 'test-token' };
const config = (extra: Partial<ActionRecallConfig> = {}): ActionRecallConfig => ({ ...loadActionConfig(ON), ...extra });
const MERGE = { tool_name: 'Bash', tool_input: { command: 'gh pr merge 42 --squash --match-head-commit abc' } };
const reply = (body: Record<string, unknown>) => JSON.stringify({ ok: true, ...body });
const OLD = 'Merge rule: the owner merges every pull request himself.';
const NEW = 'Merge rule: routine PRs are merged by the supervisor agent when checks are green and the review says MERGE; critical PRs need the owner.';
const RULES = reply({
  memories: [
    { text: `- (codex) ${NEW}`, session_date: '2026-10-11T10:00:00Z', score: 0.82 },
    { text: `- (claude-code) ${OLD}`, session_date: '2026-09-01T10:00:00Z', score: 0.84, replaced: { by: 'm2', at: '2026-10-11' } },
    { text: '- (cursor) Spending cap: at most 2 USD of model calls per task.', session_date: '2026-10-20T09:00:00Z', score: 0.61 },
    { text: '- (cursor) Never push to main; always open a PR.', session_date: '2026-09-23T09:00:00Z', score: 0.7 },
    { text: '- (cursor) The health check is /healthz.', session_date: '2026-10-21T09:00:00Z', score: 0.4 },
    { text: 'filler', matched: false, score: 0.99 },
  ],
  relevance: { relevant: true, similarity: 0.8 },
});
const stdin = (body: Record<string, unknown>, session = `s-${Math.random()}`) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, cwd: '/home/user/repo', ...body });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'renor-action-test-'));

describe('action recall: classification', () => {
  it.each([
    ['Bash', { command: 'gh pr merge 12 --squash' }, 'merge'],
    ['Bash', { command: 'git push origin main' }, 'merge'],
    ['Bash', { command: 'npm publish --access public' }, 'release'],
    ['Bash', { command: 'gh release create v1.2.0' }, 'release'],
    ['Bash', { command: 'npx wrangler pages deploy dist' }, 'deploy'],
    ['Bash', { command: 'supabase db push' }, 'deploy'],
    ['Shell', { command: 'kubectl apply -f prod.yaml' }, 'deploy'],
    ['Bash', { command: 'curl https://openrouter.ai/api/v1/chat/completions -d @req.json' }, 'spend'],
    ['AskUserQuestion', { questions: [{ question: 'Should I merge it?' }] }, 'ask-user'],
    ['mcp__github__merge_pull_request', { pull_number: 3 }, 'merge'],
    ['mcp__vercel__deploy_project', {}, 'deploy'],
    ['mcp__stripe__create_payment_link', {}, 'spend'],
  ])('%s %j is %s', (tool, input, kind) => {
    expect(classifyAction(tool, input)?.kind).toBe(kind);
  });

  it.each([
    ['Bash', { command: 'git status' }],
    ['Bash', { command: 'git push origin feat/x' }],
    ['Bash', { command: 'npm test' }],
    ['Read', { file_path: 'deploy.sh' }],
    ['mcp__renor__get_context', { query: 'merge rule' }],
    ['mcp__player__display_replay', {}],
  ])('%s %j is not gated, and is not looked up', async (tool, input) => {
    expect(classifyAction(tool, input)).toBeNull();
    const call = vi.fn<GetContextCaller>(async () => RULES);
    expect((await actionRecall(tool, input, config(), call)).reason).toBe('not-gated');
    expect(call).not.toHaveBeenCalled();
  });
});

describe('action recall: floor parsing agrees with per-prompt recall (review of #898)', () => {
  it.each([
    [undefined, undefined], ['', undefined], ['0', 0], ['0.6', 0.6],
    ['none', undefined], ['off', undefined], ['false', undefined], ['no', undefined], ['1.5', undefined], ['68', undefined], ['junk', undefined],
  ])('RENOR_AUTO_RECALL_MIN_SIMILARITY=%j gives floor %s', (raw, floor) => {
    expect(loadActionConfig({ ...ON, ...(raw === undefined ? {} : { RENOR_AUTO_RECALL_MIN_SIMILARITY: raw }) }).minSimilarity).toBe(floor);
  });

  it('names an unreadable value on stderr and lets the tool run', async () => {
    const warn = vi.fn();
    const out = await runActionHook(stdin(MERGE), { ...ON, RENOR_AUTO_RECALL_MIN_SIMILARITY: 'junk' }, { caller: async () => JSON.stringify({ ok: false }), stateDir: tmp(), warn });
    expect(out).toBe('');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/RENOR_AUTO_RECALL_MIN_SIMILARITY=junk/));
  });
});

describe('action recall: off and failures', () => {
  it('is off by default and asks nothing', async () => {
    const call = vi.fn<GetContextCaller>(async () => RULES);
    expect(loadActionConfig({}).actionEnabled).toBe(false);
    expect(await runActionHook(stdin(MERGE), { RENOR_AUTO_RECALL: '1', RENOR_AUTO_RECALL_TOKEN: 't' }, { caller: call })).toBe('');
    expect(await runActionHook(stdin(MERGE), {}, { caller: call, client: 'cursor' })).toBe('{"permission":"allow"}');
    expect(call).not.toHaveBeenCalled();
  });

  it('lets the tool run on an error, a malformed or refused reply, a timeout, or no key', async () => {
    const stateDir = tmp();
    for (const call of [
      async () => { throw new Error('ECONNREFUSED'); },
      async () => 'not json',
      async () => JSON.stringify({ ok: false }),
      (_a: unknown, signal: AbortSignal) => new Promise<string>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    ] as GetContextCaller[]) {
      const env = { ...ON, RENOR_AUTO_RECALL_TIMEOUT_MS: '150' };
      expect(await runActionHook(stdin(MERGE), env, { caller: call, stateDir })).toBe('');
      expect(await runActionHook(stdin(MERGE), env, { caller: call, client: 'cursor', stateDir })).toBe('{"permission":"allow"}');
    }
    expect(await runActionHook(stdin(MERGE), { RENOR_ACTION_RECALL: '1' }, { stateDir })).toBe('');
    expect(await runActionHook('garbage', ON, { client: 'cursor', stateDir })).toBe('{"permission":"allow"}');
  });

  it('applies a floor only when one is named, and then drops a reply without a similarity', () => {
    expect(loadActionConfig(ON).minSimilarity).toBeUndefined();
    expect(loadActionConfig({ ...ON, RENOR_AUTO_RECALL_MIN_SIMILARITY: '0.6' }).minSimilarity).toBe(0.6);
    const noSim = reply({ memories: [{ text: NEW, score: 0.9, session_date: '2026-10-11' }] });
    expect(selectRules(noSim, { maxRules: 3 }).reason).toBe('rules');
    expect(selectRules(noSim, { maxRules: 3, minSimilarity: 0.6 }).reason).toBe('no-similarity');
  });

  it('injects nothing the product judges unrelated', async () => {
    const r = await actionRecall('Bash', MERGE.tool_input, config(), async () => reply({ memories: [{ text: NEW }], relevance: { relevant: false } }));
    expect(r).toMatchObject({ context: null, reason: 'unrelated' });
  });
});

describe('action recall: which rules', () => {
  it('hides superseded and unmatched ones, keeps the best three, shows them newest first with dates', () => {
    const { rules } = selectRules(RULES, { maxRules: 3 });
    expect(rules.map(r => r.date)).toEqual(['2026-10-20', '2026-10-11', '2026-09-23']);
    // For a merge, only rules that name merging (or pull requests, or pushing to main) are eligible.
    expect(selectRules(RULES, { maxRules: 3 }, 'merge').rules.map(r => r.date)).toEqual(['2026-10-11', '2026-09-23']);
    expect(selectRules(RULES, { maxRules: 3 }, 'spend').rules.map(r => r.text)).toEqual(['- (cursor) Spending cap: at most 2 USD of model calls per task.']);
    const text = rules.map(r => r.text).join('\n');
    expect(text).toContain(NEW);
    expect(text).not.toContain(OLD);
    expect(text).not.toContain('filler');
    expect(text).not.toContain('healthz');
  });

  it('lists current facts first in the selection, with their date', () => {
    const { rules } = selectRules(reply({
      facts: [{ subject: 'merge', predicate: 'approver', object: 'supervisor agent', validFrom: '2026-10-11T00:00:00Z' }],
      memories: [{ text: 'a', score: 0.9, session_date: '2026-10-12' }, { text: 'b', score: 0.8, session_date: '2026-10-13' }, { text: 'c', score: 0.7, session_date: '2026-10-14' }],
    }), { maxRules: 3 });
    expect(rules.map(r => r.text)).toEqual(['b', 'a', 'merge approver: supervisor agent']);
  });

  it('keeps the block within the budget and sends the action in the query', async () => {
    const long = reply({ memories: Array.from({ length: 3 }, (_, i) => ({ text: `merge rule ${i} ${'must be followed carefully '.repeat(40)}`, score: 1 - i / 10, session_date: '2026-10-0' + (i + 1) })) });
    for (const maxTokens of [128, 250]) {
      let sent = '';
      const r = await actionRecall('Bash', MERGE.tool_input, config({ maxTokens }), async args => { sent = args.query; return long; });
      expect(replyTokens(r.context!)).toBeLessThanOrEqual(maxTokens);
      expect(sent).toContain('standing rule for merging');
      expect(sent).toContain('gh pr merge 42');
    }
  });
});

describe('action recall: delivery', () => {
  it('gate: denies the first merge of a session with the rules as the reason, then lets the retry through', async () => {
    const stateDir = tmp();
    const call = async () => RULES;
    const first = JSON.parse(await runActionHook(stdin(MERGE, 'sess-1'), ON, { caller: call, stateDir })).hookSpecificOutput;
    expect(first.permissionDecision).toBe('deny');
    expect(first.permissionDecisionReason).toMatch(/^<renor-rules action="merge">/);
    expect(first.permissionDecisionReason).toContain(NEW);
    expect(first.permissionDecisionReason).toContain('run the same call again');
    expect(await runActionHook(stdin(MERGE, 'sess-1'), ON, { caller: call, stateDir })).toBe('');
    // Another kind, or another session, is gated on its own.
    const deploy = stdin({ tool_name: 'Bash', tool_input: { command: 'supabase db push' } }, 'sess-1');
    const deployRules = async () => reply({ memories: [{ text: 'Production deploys need the owner\'s explicit go.', score: 0.8, session_date: '2026-10-01' }] });
    expect(JSON.parse(await runActionHook(deploy, ON, { caller: deployRules, stateDir })).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(JSON.parse(await runActionHook(stdin(MERGE, 'sess-2'), ON, { caller: call, stateDir })).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('gate: fires again after the window, and never denies when it cannot record that it fired', () => {
    const stateDir = tmp();
    expect(gateFirstTime('s', 'merge', 60_000, stateDir, 1_000)).toBe(true);
    expect(gateFirstTime('s', 'merge', 60_000, stateDir, 30_000)).toBe(false);
    expect(gateFirstTime('s', 'merge', 60_000, stateDir, 70_000)).toBe(true);
    const blocked = path.join(stateDir, 'file');
    fs.writeFileSync(blocked, '');
    expect(gateFirstTime('s', 'merge', 60_000, path.join(blocked, 'sub'))).toBeNull();
  });

  it('gate falls back to context when the state cannot be written', async () => {
    const blocked = path.join(tmp(), 'file');
    fs.writeFileSync(blocked, '');
    const out = JSON.parse(await runActionHook(stdin(MERGE), ON, { caller: async () => RULES, stateDir: path.join(blocked, 'sub') })).hookSpecificOutput;
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toContain(NEW);
  });

  it('context mode never denies', async () => {
    const out = JSON.parse(await runActionHook(stdin(MERGE), { ...ON, RENOR_ACTION_RECALL_MODE: 'context' }, { caller: async () => RULES, stateDir: tmp() })).hookSpecificOutput;
    expect(out).toEqual({ hookEventName: 'PreToolUse', additionalContext: expect.stringContaining(NEW) });
  });

  it('cursor: denies once with agent_message, then allows', async () => {
    const stateDir = tmp();
    const input = JSON.stringify({ conversation_id: 'c1', tool_name: 'Shell', tool_input: { command: 'gh pr merge 7' } });
    const first = JSON.parse(await runActionHook(input, ON, { caller: async () => RULES, client: 'cursor', stateDir }));
    expect(first.permission).toBe('deny');
    expect(first.agent_message).toContain(NEW);
    expect(await runActionHook(input, ON, { caller: async () => RULES, client: 'cursor', stateDir })).toBe('{"permission":"allow"}');
  });

  it('the hook process routes PreToolUse to action recall and exits 0 silently when it is off', () => {
    const file = path.join(__dirname, '../../src/recall/autoRecall.ts');
    const run = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', file, ...args], {
      input: stdin(MERGE), env: { ...process.env, RENOR_AUTO_RECALL: '', RENOR_ACTION_RECALL: '', ...env }, encoding: 'utf8', timeout: 30_000,
    });
    const off = run([], {});
    expect([off.status, off.stdout]).toEqual([0, '']);
    expect(run(['--cursor'], {}).stdout).toBe('{"permission":"allow"}');
    // On, with an unreachable endpoint: the tool runs.
    const down = run([], { RENOR_ACTION_RECALL: '1', RENOR_AUTO_RECALL_TOKEN: 't', RENOR_AUTO_RECALL_URL: 'http://127.0.0.1:9/mcp', RENOR_AUTO_RECALL_TIMEOUT_MS: '500' });
    expect([down.status, down.stdout]).toEqual([0, '']);
  });
});
