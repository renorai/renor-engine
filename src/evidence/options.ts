import path from 'node:path';
import { createOllamaChat } from './ollamaChat';
import { ollamaKeysForEndpoint } from './keyPool';
import { EvidenceCache } from './evidenceCache';
import { EvidenceDailyBudget, optinEndpointAllowed, readOptinKey, resolveEvidenceOptin, dailyBudgetGate } from './optin';
import { resolveEvidenceMode, type EvidenceMode } from './gate';
import type { EvidenceBackground } from './background';
import {
  EVIDENCE_MODEL_DEFAULT,
  EVIDENCE_REASONING_EFFORTS,
  MAX_EVIDENCE_SESSIONS,
  EVIDENCE_SESSION_CHAR_CAP,
  EvidenceExtractor,
  type EvidenceChat,
  type EvidenceReasoningEffort,
  type EvidenceRequestBounds,
} from './secondPass';

/**
 * Product wiring for the evidence tool: env -> options. The chat client is
 * built only when keys exist; otherwise the tool degrades to hits-only with an
 * explicit reason instead of failing the MCP call.
 */
export interface EvidenceToolOptions {
  mode: EvidenceMode;
  model: string;
  maxSessions: number;
  charCap: number;
  cachePath?: string;
  chat?: EvidenceChat;
  /** Present only for a workspace that opted in (optin.ts): its model calls per UTC day. */
  dailyCap?: number;
  /** Present only when RENOR_EVIDENCE_MAX_TOKENS or RENOR_EVIDENCE_REASONING_EFFORT is set. */
  bounds?: EvidenceRequestBounds;
  /**
   * Bounded wait (RENOR_EVIDENCE_ASYNC, default off; see background.ts). Absent, a search waits for the extractor.
   * Only the MVP read tools set it: this resolver never does.
   */
  background?: EvidenceBackground;
}

/**
 * RENOR_EVIDENCE_MAX_TOKENS (a positive integer) and
 * RENOR_EVIDENCE_REASONING_EFFORT (none | minimal | low | medium | high).
 * Unset or blank means no bound, which is the shipped request. A value that
 * does not parse throws, like an invalid RENOR_EVIDENCE_MODE: an operator who
 * set a bound must not get an unbounded extractor because of a typo.
 */
export function resolveEvidenceBounds(env: NodeJS.ProcessEnv = process.env): EvidenceRequestBounds {
  const bounds: EvidenceRequestBounds = {};
  const maxTokens = (env.RENOR_EVIDENCE_MAX_TOKENS ?? '').trim();
  if (maxTokens !== '') {
    const value = Number(maxTokens);
    if (!/^[1-9][0-9]*$/.test(maxTokens) || !Number.isSafeInteger(value)) {
      throw new Error(`Invalid RENOR_EVIDENCE_MAX_TOKENS "${maxTokens}": must be a positive integer`);
    }
    bounds.maxTokens = value;
  }
  const effort = (env.RENOR_EVIDENCE_REASONING_EFFORT ?? '').trim().toLowerCase();
  if (effort !== '') {
    if (!(EVIDENCE_REASONING_EFFORTS as readonly string[]).includes(effort)) {
      throw new Error(`Invalid RENOR_EVIDENCE_REASONING_EFFORT "${effort}": must be ${EVIDENCE_REASONING_EFFORTS.join(' | ')}`);
    }
    bounds.reasoningEffort = effort as EvidenceReasoningEffort;
  }
  return bounds;
}

/**
 * The OpenAI-compatible provider the query-time model passes call: RENOR_EVIDENCE_BASE_URL (unset or blank: the
 * transport's Ollama Cloud default) and the key pool. Shared by the evidence pass and the session router
 * (src/router/sessionRouter.ts), so the two can never disagree about which keys exist, and the URL returned is the
 * one the Ollama keys were judged against. Values are never logged.
 */
export function resolveEvidenceProvider(env: NodeJS.ProcessEnv = process.env): { baseUrl?: string; keys: string[] } {
  // Blank is the default endpoint (Ollama Cloud), like an unset variable.
  const baseUrl = env.RENOR_EVIDENCE_BASE_URL?.trim() || undefined;
  const keys = [
    ...(env.RENOR_EVIDENCE_API_KEYS ?? '').split(','),
    env.RENOR_EVIDENCE_API_KEY ?? '',
    // The Ollama pool is collected by the shared helper, never re-listed here:
    // this module used to name `OLLAMA_CLOUD_KEY_1..3` while the write-path
    // extractor named six, so with the first three keys at their monthly
    // ceiling the evidence layer vanished for 77 of 500 cases with no signal in
    // the manifest (issue #222). One list, two readers. And only for an Ollama
    // Cloud endpoint: another provider never receives an Ollama key.
    ...ollamaKeysForEndpoint(baseUrl, env).keys,
  ].map(k => k.trim()).filter(Boolean);
  return { baseUrl, keys };
}

/** Model asked of the own-hardware server when RENOR_EVIDENCE_OWN_HW_MODEL is unset: a 7-14B open-weight instruct model. */
export const OWN_HW_EVIDENCE_MODEL_DEFAULT = 'qwen2.5:14b-instruct';

/**
 * RENOR_EVIDENCE_OWN_HW_URL (default off: unset or blank): run the evidence extractor on a self-hosted OpenAI-compatible
 * server (Ollama, vLLM) instead of the hosted model. RENOR_EVIDENCE_OWN_HW_MODEL names the model. Returns null when off,
 * which leaves the resolver exactly as it was. A malformed URL throws, like an invalid RENOR_EVIDENCE_MODE.
 */
export function resolveOwnHwEvidence(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; model: string } | null {
  const raw = (env.RENOR_EVIDENCE_OWN_HW_URL ?? '').trim();
  if (raw === '') return null;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid RENOR_EVIDENCE_OWN_HW_URL: must be an http(s) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid RENOR_EVIDENCE_OWN_HW_URL: must be an http(s) URL');
  return { baseUrl: raw, model: (env.RENOR_EVIDENCE_OWN_HW_MODEL ?? '').trim() || OWN_HW_EVIDENCE_MODEL_DEFAULT };
}

/** Where the evidence pass caches, and where an opted-in workspace's daily allowance is counted: RENOR_EVIDENCE_CACHE, else beside the index. */
export function evidenceCachePath(config: { dbPath: string }, env: NodeJS.ProcessEnv = process.env): string {
  return env.RENOR_EVIDENCE_CACHE?.trim() || path.join(path.dirname(config.dbPath), 'evidence-cache.db');
}

/**
 * The evidence pass's model and transport. A workspace that opted in (RENOR_EVIDENCE_OPTIN, see optin.ts) reaches Ollama
 * Cloud with the key file's key alone, on gemma4:31b, and spends its daily allowance per HTTP attempt; otherwise the
 * configured endpoint and keys (resolveEvidenceProvider) with RENOR_EVIDENCE_MODEL. No chat when no key is configured.
 * `transport` bounds each call; unset, the transport's own defaults. Another reader of notes at query time (the answer
 * check, mvp/answerCheck.ts) builds its chat here, so it sends them only where the evidence pass would.
 */
export function resolveEvidenceChat(
  config: { dbPath: string },
  env: NodeJS.ProcessEnv = process.env,
  transport: { timeoutMs?: number; maxRetries?: number } = {},
): { model: string; chat?: EvidenceChat; optin: ReturnType<typeof resolveEvidenceOptin> } {
  const optin = resolveEvidenceOptin(env);
  const { baseUrl, keys } = resolveEvidenceProvider(env);
  const bounds = {
    ...(transport.timeoutMs !== undefined ? { timeoutMs: transport.timeoutMs } : {}),
    ...(transport.maxRetries !== undefined ? { maxRetries: transport.maxRetries } : {}),
  };
  let chat: EvidenceChat | undefined;
  const ownHw = optin ? null : resolveOwnHwEvidence(env);
  if (ownHw) {
    // Own hardware (RENOR_EVIDENCE_OWN_HW_URL): a self-hosted OpenAI-compatible server that needs no key, so no turn leaves
    // Renor. The placeholder is sent as a bearer token the server ignores; it is never a provider key.
    chat = createOllamaChat({ baseUrl: ownHw.baseUrl, keys: ['own-hw'], ...bounds });
  } else if (optin) {
    const optinKey = optinEndpointAllowed(baseUrl) ? readOptinKey(optin.keyFile) : null;
    if (optinKey) {
      const dailyCap = optin.dailyCap;
      const cachePath = evidenceCachePath(config, env);
      // The allowance is spent per HTTP attempt (a retried 429 or 5xx is another request to the provider), so it
      // sits inside the transport rather than around it.
      chat = createOllamaChat({
        keys: [optinKey],
        beforeAttempt: dailyBudgetGate(() => new EvidenceDailyBudget(cachePath, dailyCap)),
        ...bounds,
      });
    }
  } else if (keys.length > 0) {
    chat = createOllamaChat({ baseUrl, keys, ...bounds });
  }
  // The opt-in is the gemma4:31b decision: a stray RENOR_EVIDENCE_MODEL does not change what the privacy page names.
  const model = optin ? EVIDENCE_MODEL_DEFAULT : ownHw ? ownHw.model : env.RENOR_EVIDENCE_MODEL?.trim() || EVIDENCE_MODEL_DEFAULT;
  return { model, ...(chat ? { chat } : {}), optin };
}

export function resolveEvidenceToolOptions(
  config: { dbPath: string },
  env: NodeJS.ProcessEnv = process.env,
): EvidenceToolOptions {
  const mode = resolveEvidenceMode(env);
  const cachePath = evidenceCachePath(config, env);
  const bounds = resolveEvidenceBounds(env);
  // The model, the transport and the opt-in (key file, endpoint, gemma4:31b, daily allowance): resolveEvidenceChat.
  const { model, chat, optin } = resolveEvidenceChat(config, env);
  // Coverage knob (RENOR_EVIDENCE_SESSIONS). Default 20 matches the
  // promotion-grade full-500 arm. One model call per uncached search,
  // regardless of session count; explicit values remain bounded.
  // A value that floors below 1 is treated as UNSET, not as "0 sessions". A
  // fractional setting is finite and positive, so a bare `> 0` test let it
  // through and `Math.floor` turned it into 0 — and 0 is not a silent no-op:
  // `loadEvidenceSessionsFromVault` rejects it (`maxSessions must be > 0`),
  // which the `evidence` MCP tool surfaces as a thrown error and the search path
  // swallows as `extractor-error`. Floor first, then require >= 1.
  const requested = Number(env.RENOR_EVIDENCE_SESSIONS ?? '');
  const requestedSessions = Number.isFinite(requested) ? Math.floor(requested) : Number.NaN;
  const maxSessions = Number.isFinite(requestedSessions) && requestedSessions >= 1
    ? Math.min(requestedSessions, 50)
    : MAX_EVIDENCE_SESSIONS;
  return {
    mode,
    model,
    maxSessions,
    charCap: EVIDENCE_SESSION_CHAR_CAP,
    cachePath,
    ...(chat ? { chat } : {}),
    ...(optin ? { dailyCap: optin.dailyCap } : {}),
    ...(bounds.maxTokens !== undefined || bounds.reasoningEffort !== undefined ? { bounds } : {}),
  };
}

export function createEvidenceExtractor(evidence: EvidenceToolOptions): EvidenceExtractor | null {
  if (!evidence.chat) return null;
  let cache: EvidenceCache | null = null;
  if (evidence.cachePath) {
    try {
      cache = new EvidenceCache(evidence.cachePath);
    } catch (err) {
      process.stderr.write(`[evidence] cache unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return new EvidenceExtractor({ chat: evidence.chat, cache, model: evidence.model, bounds: evidence.bounds });
}
