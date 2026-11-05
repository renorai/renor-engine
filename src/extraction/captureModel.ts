import crypto from 'node:crypto';
import fs from 'node:fs';

export interface CaptureDiagnostics {
  upstream?: string;
  failure?: string;
  stop_reason?: string | null;
  parsed?: boolean;
  output_tokens?: number | null;
  text_blocks?: number;
  thinking_blocks?: number;
  observation_candidates?: number;
  rule_candidates?: number;
  observations?: number;
  rules?: number;
}

export const CAPTURE_MODEL_DEFAULT = 'claude-haiku-5-5';
/** Verify against the provider price page before changing models. USD per million tokens. */
export const ANTHROPIC_CAPTURE_PRICE_PER_MILLION: Readonly<Record<string, { input: number; output: number }>> = {
  // Anthropic list price for Claude Haiku 5.5, prompts up to 100,000 tokens (the price page; LEDGER.md agrees).
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
};
/**
 * Prompt-cache prices as multiples of the input price: a 5-minute cache write costs 1.25x, a cache read 0.1x. Verify against
 * the provider price page together with the table above. The reservation prices every input byte at the write multiplier,
 * the most a cached prefix can cost.
 */
export const CAPTURE_CACHE_WRITE_MULTIPLIER = 1.25;
export const CAPTURE_CACHE_READ_MULTIPLIER = 0.1;
export const CAPTURE_MAX_OUTPUT_TOKENS = 4096;
/** Default caps in US dollars. Per call: a single request above it is refused before it is made. Per day: the tenant's total. */
export const CAPTURE_MAX_USD_CALL_DEFAULT = 0.05;
export const CAPTURE_MAX_USD_DAY_DEFAULT = 0.5;
/** Bytes allowed for the request wrapper around the messages (the JSON envelope, the model fields). */
const REQUEST_OVERHEAD_BYTES = 256;

export const CAPTURE_SYSTEM_PROMPT = `You read a few turns between a user and an AI agent. Return ONLY JSON {"observations":[{"date":"YYYY-MM-DD","text":"...","kind":"decision|preference|fact|status|correction"}],"rules":[{"topic":"2-4 lowercase words","text":"..."}]}. At most 5 observations and 3 rules; each text is under 280 characters, in plain words, third person ("The user decided ..."). Convert relative dates to absolute using the date given. Keep only what would still matter next week. Return empty arrays when there is nothing durable. Never include secrets, code, tool output, the agent's own progress, or opinions of the agent. A rule is only a lasting instruction the user stated about how work should be done.`;

/** Added to the prompt only when RENOR_CAPTURE_PREFERENCE_LANE=1: preferences get their own observations (research lever, default off). */
export const CAPTURE_PREFERENCE_LANE_ADDENDUM = ` Preference lane: whenever the user states a personal preference, taste, habit or choice between options (even in passing), return it as its own observation with kind "preference", naming the thing it is about, and do not merge it into another observation.`;

/** The system prompt a capture call uses. With the lane flag off this is exactly CAPTURE_SYSTEM_PROMPT, byte for byte. */
export function captureSystemPrompt(env: NodeJS.ProcessEnv = process.env): string {
  return env.RENOR_CAPTURE_PREFERENCE_LANE === '1' ? CAPTURE_SYSTEM_PROMPT + CAPTURE_PREFERENCE_LANE_ADDENDUM : CAPTURE_SYSTEM_PROMPT;
}

export type CaptureObservation = { date: string; text: string; kind: 'decision' | 'preference' | 'fact' | 'status' | 'correction' };
export type CaptureRule = { topic: string; text: string };
/** `inTokens`, `outTokens` and `usd` are null when the provider's usage is missing or not a number: the cost is then unknown. */
export type CaptureResult = {
  observations: CaptureObservation[]; rules: CaptureRule[];
  inTokens: number | null; outTokens: number | null; cacheWriteTokens: number | null; cacheReadTokens: number | null; usd: number | null;
};
export type CapturePrice = { input: number; output: number };
export interface CaptureConfig { model: string; key: string; maxUsdCall: number; maxUsdDay: number }

function realDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function parseCaptureReply(
  text: string,
  diagnostics?: Pick<CaptureDiagnostics, 'observation_candidates' | 'rule_candidates'>,
  defaultDate?: string,
): Pick<CaptureResult, 'observations' | 'rules'> | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.observations) || !Array.isArray(v.rules) || v.observations.length > 5 || v.rules.length > 3) return null;
  if (diagnostics) {
    diagnostics.observation_candidates = v.observations.length;
    diagnostics.rule_candidates = v.rules.length;
  }
  const kinds = new Set(['decision', 'preference', 'fact', 'status', 'correction']);
  const observations = v.observations.filter((x): x is CaptureObservation => {
    if (!x || typeof x !== 'object') return false;
    const o = x as Record<string, unknown>;
    // A missing, null or empty date means the day of the request; a present but malformed date is still rejected.
    if (defaultDate !== undefined && (o.date === undefined || o.date === null || o.date === '')) o.date = defaultDate;
    return realDate(o.date) && typeof o.text === 'string' && o.text.length > 0 && o.text.length < 280 && kinds.has(String(o.kind));
  });
  const rules = v.rules.filter((x): x is CaptureRule => {
    if (!x || typeof x !== 'object') return false;
    const r = x as Record<string, unknown>;
    return typeof r.text === 'string' && r.text.length > 0 && r.text.length < 280
      && typeof r.topic === 'string' && /^[a-z]+(?: [a-z]+){1,3}$/.test(r.topic);
  });
  return { observations, rules };
}

/**
 * The workspace's capture settings, or null (capture off). Off unless the slug in RENOR_CAPTURE_SERVER_OPTIN equals MVP_INSTANCE_ID
 * and RENOR_CAPTURE_KEY_FILE names a readable key. Only the process environment and the host's files set these: no MCP tool,
 * gateway field or request body can reach them. Invalid caps switch capture off rather than falling back to a larger cap.
 */
export function captureServerConfig(env: NodeJS.ProcessEnv = process.env, opts: { quiet?: boolean } = {}): CaptureConfig | null {
  // quiet: a status read asks the same question as the route, so it must not log each refusal the route already logs.
  const say = (line: string): void => { if (!opts.quiet) process.stderr.write(line); };
  const workspace = (env.MVP_INSTANCE_ID ?? '').trim().toLowerCase();
  const opted = (env.RENOR_CAPTURE_SERVER_OPTIN ?? '').trim().toLowerCase();
  if (!opted || !workspace || opted !== workspace) {
    if (opted) say('[capture] RENOR_CAPTURE_SERVER_OPTIN does not match MVP_INSTANCE_ID: capture stays off\n');
    return null;
  }
  if (!env.RENOR_CAPTURE_KEY_FILE) {
    say('[capture] RENOR_CAPTURE_KEY_FILE is unset: capture stays off\n');
    return null;
  }
  let key = '';
  try { key = fs.readFileSync(env.RENOR_CAPTURE_KEY_FILE, 'utf8').trim(); } catch {
    say('[capture] RENOR_CAPTURE_KEY_FILE cannot be read: capture stays off\n');
    return null;
  }
  const maxUsdCall = env.RENOR_CAPTURE_MAX_USD_CALL === undefined ? CAPTURE_MAX_USD_CALL_DEFAULT : Number(env.RENOR_CAPTURE_MAX_USD_CALL);
  if (!Number.isFinite(maxUsdCall) || maxUsdCall < 0) {
    say('[capture] RENOR_CAPTURE_MAX_USD_CALL is invalid: capture stays off\n');
    return null;
  }
  const maxUsdDay = env.RENOR_CAPTURE_MAX_USD_DAY === undefined ? CAPTURE_MAX_USD_DAY_DEFAULT : Number(env.RENOR_CAPTURE_MAX_USD_DAY);
  if (!Number.isFinite(maxUsdDay) || maxUsdDay < 0) {
    say('[capture] RENOR_CAPTURE_MAX_USD_DAY is invalid: capture stays off\n');
    return null;
  }
  return { model: (env.RENOR_CAPTURE_MODEL || CAPTURE_MODEL_DEFAULT).trim(), key, maxUsdCall, maxUsdDay };
}

/**
 * Whether the server capture arm would make paid calls: the same test the capture route applies (captureServerConfig, then a
 * priced model), with no logging. memory_status reports this, so it must agree with the route.
 */
export function captureServerOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = captureServerConfig(env, { quiet: true });
  return cfg !== null && ANTHROPIC_CAPTURE_PRICE_PER_MILLION[cfg.model] !== undefined;
}

/** The user turn sent to the model. Reserved and sent from the same string, so the cap bounds what is actually billed. */
export function captureUserContent(messages: ReadonlyArray<{ role: string; text: string; at: string | null }>): string {
  return JSON.stringify(messages);
}

/**
 * The most a call can cost, before it is made. Every UTF-8 byte of the request can be at most one input token (a byte-level
 * tokenizer never spends less than a byte per token), so bytes bound the input, each priced at the cache-write multiplier
 * (the dearest input price); the output is bounded by its cap.
 */
export function captureMaxUsd(content: string, price: CapturePrice): number {
  const inputBytes = Buffer.byteLength(captureSystemPrompt(), 'utf8') + Buffer.byteLength(content, 'utf8') + REQUEST_OVERHEAD_BYTES;
  return (inputBytes * price.input * CAPTURE_CACHE_WRITE_MULTIPLIER + CAPTURE_MAX_OUTPUT_TOKENS * price.output) / 1e6;
}

/** A digest of the settings a paid call runs under (no key, no text): what the call ledger records before each call. */
export function captureConfigDigest(config: Pick<CaptureConfig, 'model' | 'maxUsdCall' | 'maxUsdDay'>, price: CapturePrice | undefined): string {
  const canonical = JSON.stringify({
    model: config.model,
    price,
    maxUsdCall: config.maxUsdCall,
    maxUsdDay: config.maxUsdDay,
    max_tokens: CAPTURE_MAX_OUTPUT_TOKENS,
    output_config: captureOutputConfig(config.model),
    system: crypto.createHash('sha256').update(captureSystemPrompt(), 'utf8').digest('hex'),
    cache: 'ephemeral',
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// Haiku 5.5 defaults to medium effort; structured extraction needs JSON, not a reasoning budget.
function captureOutputConfig(model: string): { effort: 'low' } | undefined {
  return /^claude-haiku-5-5(?:-|$)/.test(model) ? { effort: 'low' } : undefined;
}

const finiteTokens = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * The one place an Anthropic Messages request body is built. Claude 5.x models reject `temperature` (HTTP 400 "temperature is
 * deprecated for this model"), so it is sent only to older models that still take it; today the capture call needs none.
 */
export function anthropicRequestBody(
  model: string,
  body: Record<string, unknown>,
  temperature?: number,
): Record<string, unknown> {
  const takesTemperature = temperature !== undefined && !/^claude-[a-z]+-5(?:[-.]|$)/.test(model);
  return { model, ...body, ...(takesTemperature ? { temperature } : {}) };
}

/** Status, error type and message of a failed upstream call (no key, no request text), bounded and scrubbed of anything key-shaped. */
export async function describeUpstreamError(response: Response): Promise<string> {
  let type = '';
  let message = '';
  try {
    const parsed = JSON.parse(await response.text()) as { error?: unknown };
    const e = parsed.error;
    if (typeof e === 'string') message = e;
    else if (e && typeof e === 'object') {
      const o = e as { type?: unknown; message?: unknown };
      if (typeof o.type === 'string') type = o.type;
      if (typeof o.message === 'string') message = o.message;
    }
  } catch { /* an unreadable body leaves only the status */ }
  const text = [String(response.status), type, message].filter(Boolean).join(' ').replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  return text.slice(0, 300);
}

export async function extractCapture(
  messages: Array<{ role: string; text: string; at: string | null }>,
  config: { model: string; key: string },
  fetchImpl: typeof fetch = fetch,
  diagnostics: CaptureDiagnostics = {},
  defaultDate?: string,
): Promise<CaptureResult | null> {
  Object.assign(diagnostics, { stop_reason: null, parsed: false, output_tokens: null });
  const fail = (reason: string): null => { diagnostics.failure = reason; return null; };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': config.key, 'anthropic-version': '2023-06-01' },
      // The stable part (the system prompt) comes first and carries the cache breakpoint; the turn text is the only variable
      // part and comes after it, so the cached prefix is the same bytes on every call.
      body: JSON.stringify(anthropicRequestBody(config.model, {
        max_tokens: CAPTURE_MAX_OUTPUT_TOKENS,
        output_config: captureOutputConfig(config.model),
        system: [{ type: 'text', text: captureSystemPrompt(), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: captureUserContent(messages) }],
      })),
    });
    if (!response.ok) {
      diagnostics.upstream = await describeUpstreamError(response);
      return fail('upstream_error');
    }
    const body = await response.json() as { stop_reason?: unknown; content?: Array<{ type?: string; text?: string }>; usage?: Record<string, unknown> };
    const stopReasons = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded'];
    diagnostics.stop_reason = typeof body.stop_reason === 'string' && stopReasons.includes(body.stop_reason) ? body.stop_reason : null;
    diagnostics.output_tokens = finiteTokens(body.usage?.output_tokens);
    const content = Array.isArray(body.content) ? body.content : [];
    diagnostics.text_blocks = content.filter(x => x?.type === 'text').length;
    diagnostics.thinking_blocks = content.filter(x => x?.type === 'thinking' || x?.type === 'redacted_thinking').length;
    const raw = content.filter(x => x?.type === 'text').map(x => typeof x.text === 'string' ? x.text : '').join('');
    const parsed = parseCaptureReply(raw, diagnostics, defaultDate);
    diagnostics.parsed = parsed !== null;
    if (body.stop_reason === 'max_tokens' || body.stop_reason === 'model_context_window_exceeded') return fail('truncated_output');
    if (body.stop_reason === 'refusal' || body.stop_reason === 'pause_turn' || body.stop_reason === 'tool_use') return fail('incomplete_output');
    if (!raw.trim()) return fail('missing_text');
    if (!parsed) return fail('invalid_json');
    Object.assign(diagnostics, {
      observations: parsed.observations.length, rules: parsed.rules.length,
    });
    const inTokens = finiteTokens(body.usage?.input_tokens);
    const outTokens = finiteTokens(body.usage?.output_tokens);
    const cacheWriteTokens = finiteTokens(body.usage?.cache_creation_input_tokens);
    const cacheReadTokens = finiteTokens(body.usage?.cache_read_input_tokens);
    const price = ANTHROPIC_CAPTURE_PRICE_PER_MILLION[config.model];
    // Usage that is missing or malformed (any of the four counts) leaves the cost unknown (usd null): the caller keeps the
    // full reservation and saves nothing. input_tokens excludes cached tokens, so the three input kinds are priced apart.
    const known = inTokens !== null && outTokens !== null && cacheWriteTokens !== null && cacheReadTokens !== null;
    const usd = price && known
      ? (inTokens * price.input + cacheWriteTokens * price.input * CAPTURE_CACHE_WRITE_MULTIPLIER
        + cacheReadTokens * price.input * CAPTURE_CACHE_READ_MULTIPLIER + outTokens * price.output) / 1e6
      : null;
    return { ...parsed, inTokens, outTokens, cacheWriteTokens, cacheReadTokens, usd };
  } catch {
    return fail(controller.signal.aborted ? 'timeout' : 'request_failed');
  } finally {
    clearTimeout(timer);
  }
}
