import type { EvidenceChat } from '../../evidence/secondPass';

/**
 * The dreamer's cost cap, per workspace and per UTC day. A call is priced from the provider's token usage at the configured
 * list price (RENOR_CONSOLIDATE_PRICE_IN_PER_M / _OUT_PER_M); before every call its worst case (the prompt, estimated at 3.2
 * characters a token, and the output ceiling) is checked against what is left of the day, and a call that could pass the cap is
 * refused and never made. The spend is kept in the workspace's own derived index (the same table as the dreamer's other state),
 * so a restart does not hand the day back. A group the cap kept the dreamer from judging is not remembered as judged: the next
 * day asks it.
 *
 * A refused second look leaves an `uncertain` pair `uncertain` and turns an `updates` into `uncertain` (review.ts), so the cap
 * can only make the dreamer write less.
 */

export interface BudgetConfig {
  /** USD per UTC day for this workspace. */
  maxUsdPerDay: number;
  /** USD per million prompt tokens. */
  priceInPerM: number;
  /** USD per million completion tokens (reasoning included). */
  priceOutPerM: number;
}

/** DeepSeek V4.1 Flash on OpenCode Go, rounded up from the list cost the provider reports per call (0.143 and 0.592 USD per million). */
export const DEFAULT_BUDGET: BudgetConfig = { maxUsdPerDay: 0.05, priceInPerM: 0.15, priceOutPerM: 0.6 };

export class DreamerCapError extends Error {
  constructor(message = 'the dreamer\'s cost cap for today is reached') {
    super(message);
    this.name = 'DreamerCapError';
  }
}

export interface KeyValueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const CHARS_PER_TOKEN = 3.2;

export class DreamerBudget {
  constructor(private readonly store: KeyValueStore, readonly config: BudgetConfig, private readonly now: () => number = Date.now) {}

  private key(): string {
    return `spend:${utcDay(this.now())}`;
  }

  /** USD spent today. */
  spentToday(): number {
    const raw = Number(this.store.get(this.key()));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /** The most a call can cost: its prompt and its output ceiling. */
  worstCase(promptChars: number, maxTokens: number): number {
    const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN) + 16;
    return (promptTokens * this.config.priceInPerM + maxTokens * this.config.priceOutPerM) / 1e6;
  }

  canAfford(usd: number): boolean {
    return this.spentToday() + usd <= this.config.maxUsdPerDay;
  }

  /** Charge a call's worst case before it is made. */
  reserve(usd: number): void {
    this.store.set(this.key(), String(this.spentToday() + usd));
  }

  /**
   * Replace a reservation with the real charge: the usage when the provider reported any, else `fallbackUsd`.
   */
  settle(reserved: number, usage: { promptTokens?: number; completionTokens?: number }, fallbackUsd: number): void {
    const cost = usage.promptTokens === undefined && usage.completionTokens === undefined
      ? fallbackUsd
      : ((usage.promptTokens ?? 0) * this.config.priceInPerM + (usage.completionTokens ?? 0) * this.config.priceOutPerM) / 1e6;
    this.store.set(this.key(), String(Math.max(0, this.spentToday() - reserved) + cost));
  }

  /** Add what a call cost, from its usage; `fallbackUsd` stands in when the provider reported none. */
  record(usage: { promptTokens?: number; completionTokens?: number }, fallbackUsd: number): number {
    const cost = usage.promptTokens === undefined && usage.completionTokens === undefined
      ? fallbackUsd
      : ((usage.promptTokens ?? 0) * this.config.priceInPerM + (usage.completionTokens ?? 0) * this.config.priceOutPerM) / 1e6;
    this.store.set(this.key(), String(this.spentToday() + cost));
    return cost;
  }
}

/** The transport's own errors (provider status, missing content): anything else (a timeout, a dropped socket) may have been billed. */
const isProviderError = (err: unknown): boolean => err instanceof Error && /^extractor provider (returned|response)/.test(err.message);

/** A chat that checks the cap before each call and charges its usage after. `onCap` is told when a call was refused. */
export function meteredChat(chat: EvidenceChat, budget: DreamerBudget, onCap: () => void): EvidenceChat {
  return async request => {
    const chars = request.messages.reduce((n, m) => n + m.content.length, 0);
    const worst = budget.worstCase(chars, request.max_tokens ?? 8192);
    if (!budget.canAfford(worst)) {
      onCap();
      throw new DreamerCapError();
    }
    // Reserve the worst case durably before the first byte leaves, so a call that fails or is cut off still counts.
    budget.reserve(worst);
    try {
      const response = await chat(request);
      budget.settle(worst, response, worst);
      return response;
    } catch (err) {
      const e = err as { billedUsage?: { promptTokens?: number; completionTokens?: number }; billingAmbiguous?: boolean };
      // Billed usage the provider reported is charged as reported; a failure that may have been billed unseen keeps the whole
      // reservation; a rejection that cannot have been billed gives it back.
      if (e?.billingAmbiguous === true || !isProviderError(err)) budget.settle(worst, {}, worst);
      else if (e?.billedUsage) budget.settle(worst, e.billedUsage, 0);
      else budget.settle(worst, {}, 0);
      throw err;
    }
  };
}
