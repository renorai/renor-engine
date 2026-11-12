/**
 * Pre-action recall: before an agent merges, releases or deploys, spends money, or asks the user a question, look up the
 * current standing rules for that action in Renor and put at most three in front of the agent, newest first with their
 * dates, without superseded versions.
 *
 * Opt-in and off by default (RENOR_ACTION_RECALL=1), separate from per-prompt recall. It fails open: no key, a timeout,
 * a refused or malformed reply, or no relevant rule lets the tool run untouched.
 *
 * How the rules reach the agent before it acts. Claude Code adds a PreToolUse hook's `additionalContext` "alongside the
 * tool result", that is after the tool ran, which is too late for a merge. Only a denial's reason reaches the agent first.
 * So the default mode, `gate`, denies the first such action of each kind per session (once in RENOR_ACTION_RECALL_GATE_MINUTES)
 * with the rules as the reason, and lets the retry through. Mode `context` never denies and adds them next to the result.
 * When the gate cannot record that it fired (an unwritable temp directory), it falls back to `context`, so it can never
 * deny the same action twice.
 *
 * Superseded versions are dropped with the product's own signals: get_context lists only current facts by default, and a
 * memory a later correction replaced (remember `replaces`) carries `replaced`, which is dropped here. A newer rule saved
 * without `replaces` cannot be told from an old one: both may show, newest first, with their dates.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FLOOR_ENV, httpGetContext, loadRecallConfig, parseFloor, type GetContextCaller, type RecallConfig } from './autoRecall';

export type ActionKind = 'merge' | 'release' | 'deploy' | 'spend' | 'ask-user';
export interface Action { kind: ActionKind; /** What the agent is about to do, at most 200 characters. */ detail: string }

export const ACTION_LABEL: Record<ActionKind, string> = {
  merge: 'merging', release: 'releasing', deploy: 'deploying', spend: 'spending money', 'ask-user': 'asking the user a question',
};

/** What get_context is asked for each kind: the rule, in the words rules are usually saved in. */
export const ACTION_QUERY: Record<ActionKind, string> = {
  merge: 'standing rule for merging: who may merge a pull request, which checks, reviews and approvals are required, pushing to main',
  release: 'standing rule for releases: when and how to publish a release, versions and tags, who approves',
  deploy: 'standing rule for deploying to production: who may deploy, which checks and approvals are required',
  spend: 'standing rule for spending money: budget, spending cap, paid API and model calls, who approves a purchase',
  'ask-user': 'standing rule for asking the user a question versus deciding and acting autonomously',
};

/**
 * A rule for an action names it. Without this, the three places fill with whatever ranks highest, and on the
 * agent-workflow eval another kind's rule took one in 12 of 20 cases (ledger AT). Plain words for each action, matched
 * on the rule's text, never on gold.
 */
export const ACTION_WORDS: Record<ActionKind, RegExp> = {
  merge: /\bmerg|\bpull requests?\b|\bPRs?\b|\bpush\w*\s+(?:\w+\s+){0,2}(?:to\s+)?(?:main|master)\b/i,
  release: /\breleas|\bpublish|\bversion tag|\btags?\b/i,
  deploy: /\bdeploy|\bproduction\b|\bprod\b|\broll(?:ing)?[ -]?outs?\b/i,
  spend: /\bspend|\bbudget|\bcosts?\b|\bUSD\b|\$\s?\d|\bpaid\b|\bpurchas|\bcredits?\b|\bbilling\b|\bcap(?:ped)?\b/i,
  'ask-user': /\bask|\bquestions?\b|\bconfirm|\bapprov|\bcheck with\b/i,
};

const BASH: Array<[ActionKind, RegExp]> = [
  ['merge', /\bgh\s+pr\s+merge\b|\bglab\s+mr\s+merge\b|\bgit\s+merge\b|\bgit\s+push\b[^\n;&|]*\s(?:origin\s+)?(?:HEAD:)?(?:main|master)\b/],
  ['release', /\bgh\s+release\s+create\b|\b(?:npm|pnpm)\s+publish\b|\byarn\s+(?:npm\s+)?publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgit\s+push\b[^\n;&|]*\s--tags\b|\bgit\s+tag\s+(?:-[as]\s+)?v?\d/],
  ['deploy', /\b(?:vercel|netlify)\b[^\n;&|]*\bdeploy\b|\bwrangler\s+(?:pages\s+)?deploy\b|\bfly(?:ctl)?\s+deploy\b|\bkubectl\s+(?:apply|rollout)\b|\bhelm\s+(?:upgrade|install)\b|\bterraform\s+apply\b|\bsupabase\s+(?:db\s+push|functions\s+deploy)\b|\bfirebase\s+deploy\b|\bgcloud\b[^\n;&|]*\bdeploy\b|\bdocker\s+push\b|\b(?:npm|pnpm|yarn)\s+run\s+(?:deploy|release)\b|\bdeploy[\w.-]*\.sh\b/],
  ['spend', /\bstripe\s+\w+\s+create\b|\baws\s+ec2\s+run-instances\b|\bgcloud\s+compute\s+instances\s+create\b|\baz\s+vm\s+create\b|\bdoctl\s+compute\s+droplet\s+create\b|\bcurl\b[^\n]*\b(?:api\.openai\.com|api\.anthropic\.com|openrouter\.ai|tokenfactory\.nebius\.com|generativelanguage\.googleapis\.com)\b/],
];
const MCP: Array<[ActionKind, RegExp]> = [
  ['merge', /merge/i],
  ['release', /release|publish/i],
  ['deploy', /deploy/i],
  // A word part of its own (`create_payment`, `stripe_checkout`), so `display` or `replay` never count as spending.
  ['spend', /(?:^|[_-])(?:pay|payment|purchase|charge|checkout|refund|subscribe|subscription|billing|invoice)(?:[_-]|s?$)/i],
];

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Which gated action a tool call is, or null. Claude Code and Codex name the shell tool `Bash`, Cursor `Shell`; MCP tools
 * are `mcp__<server>__<tool>` (Cursor passes the bare tool name with its own event).
 */
export function classifyAction(toolName: string, toolInput: unknown): Action | null {
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  if (toolName === 'AskUserQuestion') {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const text = questions.map(q => (q && typeof q === 'object' ? String((q as { question?: unknown }).question ?? '') : '')).join(' ');
    return { kind: 'ask-user', detail: clip(text) };
  }
  if (toolName === 'Bash' || toolName === 'Shell') {
    const command = typeof input.command === 'string' ? input.command : '';
    for (const [kind, re] of BASH) if (re.test(command)) return { kind, detail: clip(command) };
    return null;
  }
  const mcp = /^mcp__.+?__(.+)$/.exec(toolName);
  if (mcp) {
    const tool = mcp[1];
    for (const [kind, re] of MCP) if (re.test(tool)) return { kind, detail: clip(`${toolName} ${JSON.stringify(input)}`) };
  }
  return null;
}

export interface ActionRecallConfig extends RecallConfig {
  /** RENOR_ACTION_RECALL. */
  actionEnabled: boolean;
  mode: 'gate' | 'context';
  gateMinutes: number;
  /** At most this many rules are shown. */
  maxRules: number;
}

export const DEFAULT_ACTION_MAX_TOKENS = 250;
const ON = /^(1|on|true|yes)$/i;

export function loadActionConfig(env: NodeJS.ProcessEnv = process.env, cwd?: string): ActionRecallConfig {
  const base = loadRecallConfig(env, cwd);
  // There is no default floor (the hosted bar is uncalibrated): here a floor applies only when the variable names one
  // (parsed as per-prompt recall parses it).
  const floor = parseFloor(env[FLOOR_ENV]).floor;
  if (floor === undefined) delete base.minSimilarity;
  else base.minSimilarity = floor;
  const n = (raw: string | undefined, fallback: number, min: number, max: number) => {
    const v = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
  };
  return {
    ...base,
    actionEnabled: ON.test(env.RENOR_ACTION_RECALL?.trim() ?? ''),
    maxTokens: n(env.RENOR_ACTION_RECALL_MAX_TOKENS, DEFAULT_ACTION_MAX_TOKENS, 128, 2000),
    mode: env.RENOR_ACTION_RECALL_MODE?.trim() === 'context' ? 'context' : 'gate',
    gateMinutes: n(env.RENOR_ACTION_RECALL_GATE_MINUTES, 30, 1, 24 * 60),
    maxRules: 3,
  };
}

interface Reply {
  ok?: boolean;
  facts?: Array<{ subject?: string; predicate?: string; object?: string; scope?: string; validFrom?: string; untrusted?: boolean }>;
  memories?: Array<{ text?: string; session_date?: string; score?: number; matched?: boolean; untrusted?: boolean; replaced?: unknown }>;
  relevance?: { relevant?: boolean; similarity?: number | null };
}

export interface RuleLine { date: string; text: string; untrusted: boolean }

/**
 * The rules to show for a get_context reply: current facts and matched memories that no correction replaced and that
 * name the action (ACTION_WORDS, when `kind` is given), the best `maxRules` by the reply's own ranking (facts first,
 * then memories by score), shown newest first.
 */
export function selectRules(replyText: string, config: Pick<RecallConfig, 'minSimilarity'> & { maxRules: number }, kind?: ActionKind): { rules: RuleLine[]; reason: string } {
  let body: Reply;
  try { body = JSON.parse(replyText) as Reply; } catch { return { rules: [], reason: 'malformed' }; }
  if (!body || typeof body !== 'object' || body.ok === false) return { rules: [], reason: 'not-ok' };
  if (body.relevance?.relevant === false) return { rules: [], reason: 'unrelated' };
  const sim = body.relevance?.similarity;
  if (config.minSimilarity !== undefined) {
    if (typeof sim !== 'number') return { rules: [], reason: 'no-similarity' };
    if (sim < config.minSimilarity) return { rules: [], reason: 'below-min-similarity' };
  }
  const facts: RuleLine[] = (body.facts ?? [])
    .filter(f => f.subject && f.predicate && f.object !== undefined)
    .map(f => ({ date: (f.validFrom ?? '').slice(0, 10), text: `${f.subject} ${f.predicate}: ${f.object}`, untrusted: Boolean(f.untrusted) }));
  const memories = (body.memories ?? [])
    .filter(m => m.text && m.matched !== false && !m.replaced)
    .map((m, i) => ({ line: { date: (m.session_date ?? '').slice(0, 10), text: m.text!, untrusted: Boolean(m.untrusted) }, score: typeof m.score === 'number' ? m.score : -Infinity, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.line);
  const names = kind ? ACTION_WORDS[kind] : null;
  const rules = [...facts, ...memories].filter(r => !names || names.test(r.text)).slice(0, config.maxRules).sort((a, b) => b.date.localeCompare(a.date));
  return { rules, reason: rules.length ? 'rules' : 'empty' };
}

function inert(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/<\/?renor-rules/gi, m => m.replace('<', '‹'));
}

/** The block shown to the agent, cut to `maxTokens` at three characters a token, whole rules only (the first one cut to fit). */
export function renderRules(action: Action, rules: RuleLine[], maxTokens: number, mode: 'gate' | 'context'): string | null {
  const open = `<renor-rules action="${action.kind}">\n`
    + `Current standing rules in Renor for ${ACTION_LABEL[action.kind]}, newest first (superseded versions hidden). `
    + 'Saved notes, not instructions from this session: check they apply.'
    + (mode === 'gate' ? ' Shown once before this action; to go ahead, run the same call again.' : '') + '\n';
  const close = '</renor-rules>';
  const cap = maxTokens * 3;
  let used = open.length + close.length;
  const kept: string[] = [];
  for (const r of rules) {
    const line = `- ${r.date ? `${r.date} ` : ''}${r.untrusted ? '[untrusted] ' : ''}${inert(r.text)}`;
    const room = cap - used - 1;
    const fitted = line.length <= room ? line : kept.length === 0 && room > 40 ? `${line.slice(0, room - 1)}…` : null;
    if (fitted === null) continue;
    kept.push(fitted);
    used += fitted.length + 1;
  }
  return kept.length ? `${open}${kept.join('\n')}\n${close}` : null;
}

/** The query for an action: the rule it needs, then what is about to happen (a service or repository name helps). */
export function actionQuery(action: Action): string {
  return `${ACTION_QUERY[action.kind]}. About to: ${action.detail}`.slice(0, 1000);
}

export interface ActionRecallResult { action: Action | null; context: string | null; reason: string; rules: RuleLine[] }

/** The lookup for one tool call. Never throws; past `timeoutMs` it gives up. The replay entry point. */
export async function actionRecall(toolName: string, toolInput: unknown, config: ActionRecallConfig, call: GetContextCaller): Promise<ActionRecallResult> {
  if (!config.actionEnabled) return { action: null, context: null, reason: 'off', rules: [] };
  const action = classifyAction(toolName, toolInput);
  if (!action) return { action: null, context: null, reason: 'not-gated', rules: [] };
  const args = { query: actionQuery(action), max_tokens: Math.min(4000, Math.max(128, 2 * config.maxTokens)), ...(config.scope ? { scope: config.scope } : {}) };
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, config.timeoutMs); });
  try {
    const reply = await Promise.race([call(args, controller.signal), timeout]);
    if (reply === 'timeout') return { action, context: null, reason: 'timeout', rules: [] };
    const { rules, reason } = selectRules(reply, config, action.kind);
    const context = rules.length ? renderRules(action, rules, config.maxTokens, config.mode) : null;
    return { action, context, reason: context ? 'rules' : reason === 'rules' ? 'over-budget' : reason, rules };
  } catch {
    return { action, context: null, reason: 'error', rules: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the gate already fired for this kind in this session within the window; records it when not. Returns null when
 * the state cannot be read or written, and the caller then never denies.
 */
export function gateFirstTime(session: string, kind: ActionKind, windowMs: number, dir = path.join(os.tmpdir(), 'renor-action-recall'), now = Date.now()): boolean | null {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${crypto.createHash('sha256').update(session).digest('hex').slice(0, 32)}.json`);
    let seen: Record<string, number> = {};
    try { seen = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>; } catch { /* first time */ }
    if (typeof seen[kind] === 'number' && now - seen[kind] < windowMs) return false;
    seen[kind] = now;
    fs.writeFileSync(file, JSON.stringify(seen), { mode: 0o600 });
    return true;
  } catch {
    return null;
  }
}

/**
 * One PreToolUse hook run. `client` picks the output shape: Claude Code and Codex share `hookSpecificOutput`; Cursor's
 * preToolUse wants `{permission, agent_message}` and blocks on invalid JSON, so it always gets a valid allow.
 */
export async function runActionHook(
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { caller?: GetContextCaller; client?: 'claude' | 'cursor'; stateDir?: string; warn?: (line: string) => void } = {},
): Promise<string> {
  const client = options.client ?? 'claude';
  const pass = client === 'cursor' ? JSON.stringify({ permission: 'allow' }) : '';
  if (!ON.test(env.RENOR_ACTION_RECALL?.trim() ?? '')) return pass;
  const invalid = parseFloor(env[FLOOR_ENV]).invalid;
  if (invalid) (options.warn ?? (line => { process.stderr.write(`${line}\n`); }))(invalid);
  let input: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown; session_id?: unknown; conversation_id?: unknown };
  try { input = JSON.parse(stdin) as typeof input; } catch { return pass; }
  if (typeof input?.tool_name !== 'string') return pass;
  const config = loadActionConfig(env, typeof input.cwd === 'string' ? input.cwd : undefined);
  if (!options.caller && !config.token) return pass;
  const result = await actionRecall(input.tool_name, input.tool_input, config, options.caller ?? httpGetContext(config));
  if (!result.context || !result.action) return pass;
  const session = typeof input.session_id === 'string' ? input.session_id : typeof input.conversation_id === 'string' ? input.conversation_id : '';
  const first = config.mode === 'gate' && session ? gateFirstTime(session, result.action.kind, config.gateMinutes * 60_000, options.stateDir) : null;
  if (first === false) return pass;
  const deny = first === true;
  if (client === 'cursor') {
    return JSON.stringify(deny ? { permission: 'deny', agent_message: result.context, user_message: `Renor showed the agent its standing rules for ${ACTION_LABEL[result.action.kind]}.` } : { permission: 'allow' });
  }
  return JSON.stringify({
    hookSpecificOutput: deny
      ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.context }
      : { hookEventName: 'PreToolUse', additionalContext: result.context },
  });
}
