import { modelTakesTemperature } from '../extraction/captureModel';
import type { EvidenceChat, EvidenceChatRequest, EvidenceChatResponse } from './secondPass';

/**
 * Ollama-compatible chat client for the evidence extractor.
 *
 * Mirrors the eval extractor's call shape (temperature 0, JSON-by-instruction,
 * 180s timeout, retry with exponential backoff). Keys rotate round-robin so a
 * single throttled free-tier key cannot stall the call.
 */
export interface OllamaChatOptions {
  baseUrl?: string;
  keys: string[];
  timeoutMs?: number;
  maxRetries?: number;
  /** Base of the exponential backoff between attempts, in ms (default 1000). */
  backoffMs?: number;
  /**
   * Called before every HTTP attempt, the first and each retry. It may throw to stop the call: the error is
   * thrown to the caller as it is, and no further attempt is made. The per-workspace daily allowance spends here,
   * so a retried 429 or 5xx counts as the request it is.
   */
  beforeAttempt?: () => void;
  /** Extra request headers (a provider that routes by a session id). Absent: the request is the same bytes as before. */
  headers?: Record<string, string>;
}

/** The endpoint called when no base URL is given: Ollama Cloud. */
export const DEFAULT_CHAT_BASE_URL = 'https://ollama.com/v1';

/** Tokens a provider billed on attempts that returned no usable answer. */
export interface BilledUsage { promptTokens?: number; completionTokens?: number }
/** A failed call's error, carrying what the provider billed for it (see the dreamer's cost cap). */
export type BilledError = Error & { billedUsage?: BilledUsage; billingAmbiguous?: boolean };

export function createOllamaChat(opts: OllamaChatOptions): EvidenceChat {
  const baseUrl = (opts.baseUrl ?? DEFAULT_CHAT_BASE_URL).replace(/\/+$/, '');
  const keys = opts.keys.filter(k => k && k.trim());
  if (keys.length === 0) throw new Error('createOllamaChat requires at least one API key');
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const maxRetries = opts.maxRetries ?? 3;
  const backoffMs = opts.backoffMs ?? 1000;
  let counter = 0;

  return async (request: EvidenceChatRequest): Promise<EvidenceChatResponse> => {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      // Claude 5.x rejects `temperature` (HTTP 400), so no caller of this shared transport can send it to one.
      ...(modelTakesTemperature(request.model) ? { temperature: request.temperature } : {}),
      // Only when the caller asked for JSON mode. Evidence calls omit it.
      ...(request.response_format ? { response_format: request.response_format } : {}),
      // Only when the caller set a bound, so an unbounded request is the same bytes: the session router always sets
      // a ceiling, the evidence pass only when the operator set one (RENOR_EVIDENCE_MAX_TOKENS /
      // RENOR_EVIDENCE_REASONING_EFFORT), the extractors never.
      ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}),
      ...(request.reasoning_effort !== undefined ? { reasoning_effort: request.reasoning_effort } : {}),
    });
    let lastError: Error | undefined;
    // Usage the provider reported on attempts that were billed but returned nothing usable, and whether any attempt may have
    // been billed without a report (timeout, 5xx, network). The dreamer's cost cap charges both.
    const billed: BilledUsage = {};
    let ambiguous = false;
    const fail = (err: Error): never => {
      if (billed.promptTokens !== undefined || billed.completionTokens !== undefined) (err as BilledError).billedUsage = { ...billed };
      if (ambiguous) (err as BilledError).billingAmbiguous = true;
      throw err;
    };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      opts.beforeAttempt?.();
      let retryable = true;
      const key = keys[counter++ % keys.length];
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...opts.headers },
          body,
          signal: controller.signal,
        });
        if (resp.status === 429 || resp.status >= 500) {
          lastError = new Error(`extractor provider returned ${resp.status}`);
          if (resp.status >= 500) ambiguous = true;
          await resp.text().catch(() => '');
          throw lastError;
        }
        if (!resp.ok) {
          // 4xx other than 429 is the provider rejecting this request.
          // Retrying it only spends the key pool and the backoff.
          retryable = false;
          lastError = new Error(`extractor provider returned ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
          throw lastError;
        }
        const data = await resp.json() as {
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const content = data.choices?.[0]?.message?.content;
        const finishReason = data.choices?.[0]?.finish_reason;
        if (typeof content !== 'string') {
          if (data.usage) {
            billed.promptTokens = (billed.promptTokens ?? 0) + (data.usage.prompt_tokens ?? 0);
            billed.completionTokens = (billed.completionTokens ?? 0) + (data.usage.completion_tokens ?? 0);
          } else ambiguous = true;
          // `length` here is a reasoning model that spent its whole budget thinking.
          throw new Error(`extractor provider response missing choices[0].message.content${typeof finishReason === 'string' ? ` (finish_reason=${finishReason})` : ''}`);
        }
        const earlier = billed.promptTokens !== undefined || billed.completionTokens !== undefined;
        return {
          content,
          promptTokens: earlier ? (billed.promptTokens ?? 0) + (data.usage?.prompt_tokens ?? 0) : data.usage?.prompt_tokens,
          completionTokens: earlier ? (billed.completionTokens ?? 0) + (data.usage?.completion_tokens ?? 0) : data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
          latencyMs: Date.now() - started,
          ...(typeof finishReason === 'string' ? { finishReason } : {}),
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!(err instanceof Error && /^extractor provider (returned|response)/.test(err.message))) ambiguous = true;
        if (!retryable || attempt >= maxRetries) break;
        await new Promise(resolve => setTimeout(resolve, 2 ** attempt * backoffMs));
      } finally {
        clearTimeout(timer);
      }
    }
    return fail(lastError ?? new Error('extractor call failed'));
  };
}
