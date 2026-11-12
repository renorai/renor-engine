#!/usr/bin/env node
/**
 * Search recall (experiment): before an agent searches or reads, look up what Renor holds that matches that search and
 * hand at most a few lines back, so the reminder arrives at the moment of the action instead of relying on a written
 * rule. A Claude Code PreToolUse hook for Grep, Glob and Read. Only the benchmark's `renor-pretool` arm
 * (scripts/eval/agent-tasks) wires it; nothing in the product, the plugin or the CLI does, and it is off unless
 * RENOR_SEARCH_RECALL=1.
 *
 * It reuses automatic recall's code: the same get_context caller (httpGetContext), reply gates and memory lines
 * (replyLines), and the same untrusted-data boundary and budget fit (fitBlock), so what it injects is wrapped exactly as
 * #897 wraps a prompt's recall. It differs in three ways: the query is the tool's own pattern or path (a PreToolUse event
 * carries no prompt, and a hook cannot see the session's task: its stdin names only a transcript file, which a print-mode
 * session with --no-session-persistence never writes); the budget is small (RENOR_SEARCH_RECALL_MAX_TOKENS, 150 by
 * default, label included); and a memory is shown once per session, never again, however many searches follow.
 *
 * How it reaches the agent: Claude Code adds a PreToolUse hook's `additionalContext` alongside the tool's result
 * (actionRecall.ts, header), so the lines are in the agent's context when it reads what the search found.
 *
 * Fails open like the other hooks: no token, no session id, a timeout, a refused or malformed reply, a state directory it
 * cannot write (it cannot know what it showed, so it shows nothing), or nothing new to say yields no context and exit 0.
 * Node built-ins and ./autoRecall only, so the compiled pair can be shipped as a hook.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitBlock, httpGetContext, loadRecallConfig, parseFloor, replyLines, FLOOR_ENV, type GetContextCaller, type RecallConfig } from './autoRecall';

export const SEARCH_TOOLS = ['Grep', 'Glob', 'Read'] as const;
export const DEFAULT_SEARCH_MAX_TOKENS = 150;
const ON = /^(1|on|true|yes)$/i;
const QUERY_MAX_CHARS = 1000;

export interface SearchRecallConfig extends RecallConfig {
  /** RENOR_SEARCH_RECALL. */
  searchEnabled: boolean;
  /** Where the memories already shown are marked, one file each. */
  stateDir: string;
}

/**
 * The endpoint, token, scope and limits are automatic recall's (RENOR_AUTO_RECALL_URL, _TOKEN, _SCOPE, _TIMEOUT_MS), so one
 * set of credentials serves both; the switch and the budget are this hook's own. No default floor exists (the hosted bar is uncalibrated); a floor applies here only when RENOR_AUTO_RECALL_MIN_SIMILARITY names one.
 */
export function loadSearchConfig(env: NodeJS.ProcessEnv = process.env, cwd?: string): SearchRecallConfig {
  const base = loadRecallConfig(env, cwd);
  const floor = parseFloor(env[FLOOR_ENV]).floor;
  if (floor === undefined) delete base.minSimilarity; else base.minSimilarity = floor;
  const raw = env.RENOR_SEARCH_RECALL_MAX_TOKENS?.trim();
  const n = raw ? Number(raw) : NaN;
  return {
    ...base,
    searchEnabled: ON.test(env.RENOR_SEARCH_RECALL?.trim() ?? ''),
    maxTokens: Number.isFinite(n) ? Math.min(1000, Math.max(100, Math.round(n))) : DEFAULT_SEARCH_MAX_TOKENS,
    stateDir: env.RENOR_SEARCH_RECALL_STATE_DIR?.trim() || path.join(os.tmpdir(), 'renor-search-recall'),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A path as the agent sees it inside its workspace: relative to the working directory when it lies under it. */
function relative(p: string, cwd: string | undefined): string {
  if (cwd && p.startsWith(cwd.endsWith(path.sep) ? cwd : cwd + path.sep)) return p.slice(cwd.length).replace(/^[\\/]+/, '');
  return p;
}

/** What to ask Renor for a search: the tool's own words, or null when it has none worth a lookup. */
export function searchQuery(toolName: string, toolInput: unknown, cwd?: string): string | null {
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  let parts: string[];
  if (toolName === 'Grep') parts = [str(input.pattern), str(input.glob), str(input.type), relative(str(input.path), cwd)];
  else if (toolName === 'Glob') parts = [str(input.pattern), relative(str(input.path), cwd)];
  else if (toolName === 'Read') parts = [relative(str(input.file_path), cwd)];
  else return null;
  const query = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX_CHARS);
  // A pattern such as `*` or `a.b` says nothing to look up.
  return /[\p{L}\p{N}]{3}/u.test(query) ? query : null;
}

const digest = (text: string, len: number) => crypto.createHash('sha256').update(text).digest('hex').slice(0, len);
const markFile = (dir: string, session: string, line: string) => path.join(dir, `${digest(session, 16)}-${digest(line, 24)}.seen`);

function shown(dir: string, session: string, line: string): boolean {
  try { return fs.existsSync(markFile(dir, session, line)); } catch { return true; }
}

/** True for the one caller that marks `line` shown in this session (an exclusive create, so parallel searches never both claim it). */
function claim(dir: string, session: string, line: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(markFile(dir, session, line), '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export interface SearchRecallResult {
  context: string | null;
  /** `injected`, or why nothing was: off, not-searched, no-query, no-session, no-token, timeout, error, the reply's own reason, all-seen, over-budget. */
  reason: string;
  /** What was sent to get_context, when anything was. */
  args?: { query: string; max_tokens: number; scope?: string };
  /** The lines shown, as they appear in the block. */
  items: string[];
}

/** The lookup for one tool call. Never throws; past `timeoutMs` it gives up. The replay entry point. */
export async function searchRecall(
  toolName: string, toolInput: unknown, session: string, cwd: string | undefined, config: SearchRecallConfig, call: GetContextCaller,
): Promise<SearchRecallResult> {
  const none = (reason: string, args?: SearchRecallResult['args']): SearchRecallResult => ({ context: null, reason, items: [], ...(args ? { args } : {}) });
  if (!config.searchEnabled) return none('off');
  if (!(SEARCH_TOOLS as readonly string[]).includes(toolName)) return none('not-searched');
  // Without a session there is no telling what was already shown: show nothing rather than repeat.
  if (!session) return none('no-session');
  const query = searchQuery(toolName, toolInput, cwd);
  if (!query) return none('no-query');
  const args = { query, max_tokens: Math.min(4000, Math.max(128, 2 * config.maxTokens)), ...(config.scope ? { scope: config.scope } : {}) };
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, config.timeoutMs); });
  try {
    const reply = await Promise.race([call(args, controller.signal), timeout]);
    if (reply === 'timeout') return none('timeout', args);
    const { lines, reason } = replyLines(reply, config);
    if (lines.length === 0) return none(reason, args);
    const fresh = lines.filter(line => !shown(config.stateDir, session, line));
    if (fresh.length === 0) return none('all-seen', args);
    const fit = fitBlock(fresh, config.maxTokens);
    if (!fit) return none('over-budget', args);
    const claimed = fit.indices.map(i => fresh[i]).filter(line => claim(config.stateDir, session, line));
    // Nothing was claimed: the state directory cannot be written, or a parallel search just showed the same lines.
    if (claimed.length === 0) return none('all-seen', args);
    const block = claimed.length === fit.indices.length ? fit : fitBlock(claimed, config.maxTokens);
    return block ? { context: block.context, reason: 'injected', args, items: block.items } : none('over-budget', args);
  } catch {
    return none('error', args);
  } finally {
    clearTimeout(timer);
  }
}

/** One PreToolUse hook run: the hook's stdin JSON in, its stdout out ('' adds nothing). Off, it reads nothing. */
export async function runSearchHook(stdin: string, env: NodeJS.ProcessEnv = process.env, options: { caller?: GetContextCaller } = {}): Promise<string> {
  if (!ON.test(env.RENOR_SEARCH_RECALL?.trim() ?? '')) return '';
  let input: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown; session_id?: unknown };
  try { input = JSON.parse(stdin) as typeof input; } catch { return ''; }
  if (typeof input?.tool_name !== 'string') return '';
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const config = loadSearchConfig(env, cwd);
  if (!options.caller && !config.token) return '';
  const result = await searchRecall(input.tool_name, input.tool_input, typeof input.session_id === 'string' ? input.session_id : '', cwd, config, options.caller ?? httpGetContext(config));
  if (!result.context) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: result.context } });
}

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

if (require.main === module) {
  (ON.test(process.env.RENOR_SEARCH_RECALL?.trim() ?? '') ? readStdin() : Promise.resolve(''))
    .then(stdin => (stdin ? runSearchHook(stdin) : ''))
    .catch(() => '')
    .then(out => { if (out) process.stdout.write(out); })
    .finally(() => process.exit(0));
}
