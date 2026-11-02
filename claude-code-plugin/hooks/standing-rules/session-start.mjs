#!/usr/bin/env node
// Claude Code SessionStart hook (matchers startup, clear, compact): puts the standing rules the owner approved in front
// of the agent with no search query, and again after /clear and after compaction, which drop them from the context.
//
// Default OFF. It reads nothing and sends nothing unless RENOR_STANDING_RULES_HOOK=1 and a Renor connect token is set
// (RENOR_CONNECT_TOKEN, else RENOR_AUTO_RECALL_TOKEN, the key the recall hooks use). Claude Code passes both to hooks from
// the `env` block of ~/.claude/settings.json. Every failure is silent: no output, exit 0, so it never blocks a session
// start beyond its deadline. RENOR_HOOK_DEBUG=1 names the kind of failure on stderr, never remote text or the token.

import { pathToFileURL } from 'node:url';
import { standingRulesBlock, DEFAULT_MAX_TOKENS } from './standing-rules.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHttpClient, HookError } from './mcp-http.mjs';
import { approvalsPath, readApprovals } from './approvals.mjs';
import { captureEnvironment } from '../capture-config.mjs';
import { ensurePrivateDir, pinnedStateDir, prunePrivateDir, readPrivateFile, writePrivateFile } from './state.mjs';

export const DEFAULT_URL = 'https://mcp.renor.cloud/mcp';
export const DEFAULT_TIMEOUT_MS = 4000;
/** The session starts that lose what was in context. A resume or fork keeps the transcript, so the block is still there. */
export const SOURCES = new Set(['startup', 'clear', 'compact']);

/** The session index's JSON-RPC method; the same string as SESSION_INDEX_METHOD in src/mvp/sessionIndex.ts. */
export const SESSION_INDEX_METHOD = 'renor/session_index';

const on = value => ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());

/** The ids the index lists (`note:<path>`, `fact:<event id>`), in the forms recall's dedupe compares: a fact also by its bare event id. */
export function sessionIndexIds(text) {
  const ids = [];
  for (const line of String(text).split('\n')) {
    const m = /^- (?:\d{4}-\d{2}-\d{2} )?((?:note|fact):\S+)/.exec(line);
    if (!m) continue;
    ids.push(m[1]);
    if (m[1].startsWith('fact:')) ids.push(m[1].slice('fact:'.length));
  }
  return ids;
}

/** A session's state file name: a digest of its id, so the id itself is never a file name. */
export const sessionKey = id => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 32);

/** The index block as the agent sees it. Its memory-derived text is already inert (escaped) in the server's index. */
export const frameSessionIndex = text => `<renor-session-index>\n${text}\n</renor-session-index>`;

/** The output a session already got at its first start, or '' (none, not private, or not this hook's output). */
function readFrozen(file) {
  const out = readPrivateFile(file) ?? '';
  try {
    return JSON.parse(out)?.hookSpecificOutput?.hookEventName === 'SessionStart' ? out : '';
  } catch { return ''; }
}

/** The token the hooks use, from the environment ('' when none). */
export const tokenOf = env => String(env.RENOR_CONNECT_TOKEN ?? env.RENOR_AUTO_RECALL_TOKEN ?? '').trim();

/** What the hook would do with this environment: null when it is off or has no token. Nothing else is read when off. */
export function hookSettings(env = process.env) {
  if (!on(env.RENOR_STANDING_RULES_HOOK) && !on(env.RENOR_SESSION_INDEX)) return null;
  const token = tokenOf(env);
  if (!token) return null;
  const cap = Number(env.RENOR_STANDING_RULES_MAX_TOKENS);
  return {
    token,
    url: String(env.RENOR_MCP_URL ?? '').trim() || DEFAULT_URL,
    maxTokens: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    approvals: approvalsPath(env),
    trustAgents: String(env.RENOR_STANDING_RULES_TRUST ?? '').trim().toLowerCase() === 'agents',
    sessionIndex: on(env.RENOR_SESSION_INDEX),
  };
}

/** The one line debug mode writes: the failure's category, never its message unless it is a HookError's own. */
function debugLine(err, env) {
  const category = err instanceof HookError ? err.category : err?.message === 'timeout' ? 'timeout' : 'internal-error';
  const token = tokenOf(env);
  // A category holds no remote text; the token is cut out anyway, should one ever carry it.
  return `renor standing rules: ${token ? category.split(token).join('[token]') : category}\n`;
}

/**
 * The hook's stdout for one SessionStart input, or '' for none. `deps.client` replaces the HTTP client and
 * `deps.approvals` the owner's approval set (tests, or a sibling hook that composes this block into its own
 * SessionStart output), and `deps.stateDir` the per-user private directory for per-session state (default: pinnedStateDir,
 * see state.mjs). With the index on, a session's first output is kept there and re-emitted for every later start of that
 * session; without a private, owner-only directory the index is not requested at all. Never throws.
 */
export async function sessionStartOutput(input, env = process.env, deps = {}) {
  try {
    if (!SOURCES.has(input?.source)) return '';
    const settings = hookSettings(env);
    if (!settings && !deps.client) return '';
    const stateDir = deps.stateDir ?? pinnedStateDir(env);
    const name = typeof input?.session_id === 'string' && input.session_id ? sessionKey(input.session_id) : '';
    const privateState = name !== '' && ensurePrivateDir(stateDir);
    if (privateState) prunePrivateDir(stateDir, new Set([`${name}.json`, `${name}.frozen.json`]));
    // With the index on, a session's first start is its only server call for the index: a later start in the same session re-emits that output.
    // A session with an id but no private directory gets no index, so nothing it could freeze is ever left unprotected.
    const sessionIndexOn = (settings?.sessionIndex ?? deps.sessionIndex ?? false) && (privateState || name === '');
    const frozenFile = sessionIndexOn && privateState ? path.join(stateDir, `${name}.frozen.json`) : '';
    const frozen = frozenFile ? readFrozen(frozenFile) : '';
    if (frozen) return frozen;
    const signal = AbortSignal.timeout(settings?.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const client = deps.client ?? createHttpClient({ url: settings.url, token: settings.token, signal, fetchImpl: deps.fetch });
    const approvals = deps.approvals ?? readApprovals(settings?.approvals ?? approvalsPath(env));
    const deadline = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new HookError('timeout')), { once: true }));
    const { block, rules } = await Promise.race([
      standingRulesBlock(client, {
        maxTokens: settings?.maxTokens ?? deps.maxTokens ?? DEFAULT_MAX_TOKENS,
        approvals,
        trustAgents: settings?.trustAgents ?? deps.trustAgents ?? false,
      }),
      deadline,
    ]);
    let additionalContext = block;
    let indexIds = [];
    let indexed = false;
    if (sessionIndexOn) {
      try {
        // The hook is the only caller, once per session: the server builds the index at this one instant.
        const reply = await Promise.race([client.callMethod(SESSION_INDEX_METHOD, { max_tokens: 2500 }), deadline]);
        if (typeof reply?.text === 'string' && reply.text.trim()) {
          additionalContext = additionalContext ? `${additionalContext}\n\n${frameSessionIndex(reply.text)}` : frameSessionIndex(reply.text);
          indexIds = sessionIndexIds(reply.text);
          indexed = true;
        }
      } catch { /* the approved standing-rules block remains useful on an index failure */ }
    }
    if (!additionalContext) return '';
    // Automatic recall runs in another process. Mark exactly what this SessionStart injected so it does not repeat it.
    if (privateState) {
      try {
        const identities = [
          ...rules.map(rule => rule.eventId ?? rule.id ?? `${rule.predicate}\u0000${rule.object}`),
          ...indexIds,
        ];
        writePrivateFile(stateDir, path.join(stateDir, `${name}.json`), JSON.stringify(identities));
      } catch { /* deduplication failure must never block SessionStart */ }
    }
    const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } });
    // Kept for the session's later starts (resume, clear, compact): owner-only, written whole, no token in it.
    if (indexed && frozenFile) {
      try { writePrivateFile(stateDir, frozenFile, out); } catch { /* a failed write only means the next start asks the server again */ }
    }
    return out;
  } catch (err) {
    if (on(env.RENOR_HOOK_DEBUG)) process.stderr.write(debugLine(err, env));
    return '';
  }
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const loaded = captureEnvironment();
  if (loaded.skip) process.exit(0);
  let input = {};
  try { input = JSON.parse(await readStdin()); } catch { /* no input: nothing to do */ }
  const out = await sessionStartOutput(input, loaded.env);
  if (out) process.stdout.write(out);
  process.exit(0);
}
