import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type Database from '../../db/sqlite';
import { createOllamaChat } from '../../evidence/ollamaChat';
import { createLogger } from '../../mvp/log';
import { EVIDENCE_REASONING_EFFORTS, type EvidenceChat, type EvidenceReasoningEffort } from '../../evidence/secondPass';
import { parseLedgerEvents, resolveLedgerPath } from '../lifecycle';
import { findCandidateClusters, MAX_CLUSTER_FACTS, type DreamerCluster } from './candidates';
import { adjudicate, PROMPT_VERSION, type Adjudication, type JudgedFact, type PairVerdict } from './adjudicate';
import { DEFAULT_BUDGET, DreamerBudget, meteredChat, type BudgetConfig } from './budget';
import type { ReviewMode } from './review';
import { applyWrites, planWrites, type AppliedWrite, type SkippedUpdate } from './apply';

/**
 * The dreamer (RENOR_CONSOLIDATE, default off): a background pass that finds current facts which may be one thing under
 * two names (candidates.ts), asks one model call per group whether a newer fact replaces an older one (adjudicate.ts),
 * and writes only the replacements, as ordinary supersedes with the reason and the events relied on (apply.ts).
 *
 * With the flag off nothing here is constructed: no timer, no table, no read, no write. The read path is the same either
 * way; the dreamer's effect shows only in the lifecycle (a superseded fact is no longer current).
 *
 * When it runs (copied from Honcho's policy, scaled down): after DREAM_AFTER_FACT_SAVES new fact saves, or after
 * DREAM_IDLE_MS without a save once there is something new, and never twice within DREAM_MIN_GAP_MS.
 */

const log = createLogger('dreamer');

export const DREAM_AFTER_FACT_SAVES = 20;
export const DREAM_IDLE_MS = 60 * 60_000;
export const DREAM_MIN_GAP_MS = 8 * 60 * 60_000;
/** How often the timer looks at whether a run is due. */
export const DREAM_POLL_MS = 60_000;

export const DEFAULT_MAX_TOKENS = 600;
export const DEFAULT_REASONING_EFFORT: EvidenceReasoningEffort = 'low';
/** OpenCode Go (the owner's subscription), the endpoint the dreamer was measured on. A key is still required: nothing is sent without one. */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
/** DeepSeek V4.1 Flash: 60 of 60 updates and 0 false supersedes on the 120-cluster test set, about 0.0002 USD a question. */
export const DEFAULT_MODEL = 'deepseek-v4.1-flash';
export const DEFAULT_REVIEW: ReviewMode = 'updates';

/** RENOR_CONSOLIDATE: on only for 1 / true / yes / on; unset and anything else is off. */
export function consolidateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env.RENOR_CONSOLIDATE);
}

function flag(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export interface DreamerModelConfig {
  baseUrl: string;
  keys: string[];
  model: string;
  maxTokens: number;
  reasoningEffort?: EvidenceReasoningEffort;
  /** The second look (review.ts); absent: none. */
  review?: ReviewMode;
  /** Judge and plan, write nothing. */
  dryRun: boolean;
  budget: BudgetConfig;
}

function positiveNumber(rawValue: string | undefined, name: string, fallback: number, allowZero = false): number {
  const raw = (rawValue ?? '').trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw new Error(`Invalid ${name} "${raw}": must be a ${allowZero ? 'non-negative' : 'positive'} number`);
  return value;
}

/**
 * The model the dreamer calls. A key is required (RENOR_CONSOLIDATE_API_KEY or RENOR_CONSOLIDATE_API_KEYS) and nothing is
 * sent without one; the rest has a default: RENOR_CONSOLIDATE_BASE_URL (an OpenAI-compatible endpoint; default OpenCode Go),
 * RENOR_CONSOLIDATE_MODEL (default deepseek-v4.1-flash), RENOR_CONSOLIDATE_MAX_TOKENS (600), RENOR_CONSOLIDATE_REASONING_EFFORT
 * (low), RENOR_CONSOLIDATE_REVIEW (off | uncertain | updates | both; default updates), RENOR_CONSOLIDATE_DRY_RUN (off),
 * RENOR_CONSOLIDATE_MAX_USD_PER_DAY (0.05) and the prices that cap is counted in (RENOR_CONSOLIDATE_PRICE_IN_PER_M 0.15,
 * RENOR_CONSOLIDATE_PRICE_OUT_PER_M 0.6). Deliberately separate from the evidence provider: switching the dreamer on must never
 * switch the read-time extractor on. A missing key returns why, and the dreamer stays off.
 */
export function resolveDreamerModel(env: NodeJS.ProcessEnv = process.env): DreamerModelConfig | { off: string } {
  // RENOR_CONSOLIDATE_OWN_HW (off by default, research lever own-hw-consolidate): the dreamer calls an open-weight model served
  // on our own hardware at RENOR_CONSOLIDATE_OWN_HW_BASE_URL (OpenAI-compatible, a key is optional), named by RENOR_CONSOLIDATE_MODEL,
  // priced at 0 unless the price variables say otherwise. Unset: nothing below changes.
  const ownHw = flag(env.RENOR_CONSOLIDATE_OWN_HW);
  const ownUrl = env.RENOR_CONSOLIDATE_OWN_HW_BASE_URL?.trim();
  if (ownHw && !ownUrl) return { off: 'RENOR_CONSOLIDATE_OWN_HW_BASE_URL is not set' };
  if (ownHw && !env.RENOR_CONSOLIDATE_MODEL?.trim()) return { off: 'RENOR_CONSOLIDATE_MODEL is not set (own hardware has no default model)' };
  const baseUrl = (ownHw ? ownUrl : env.RENOR_CONSOLIDATE_BASE_URL?.trim()) || DEFAULT_BASE_URL;
  const model = env.RENOR_CONSOLIDATE_MODEL?.trim() || DEFAULT_MODEL;
  let keys = [...(env.RENOR_CONSOLIDATE_API_KEYS ?? '').split(','), env.RENOR_CONSOLIDATE_API_KEY ?? ''].map(k => k.trim()).filter(Boolean);
  if (keys.length === 0 && ownHw) keys = ['local'];
  if (keys.length === 0) return { off: 'RENOR_CONSOLIDATE_API_KEY is not set' };
  const rawTokens = (env.RENOR_CONSOLIDATE_MAX_TOKENS ?? '').trim();
  if (rawTokens !== '' && !/^[1-9][0-9]*$/.test(rawTokens)) throw new Error(`Invalid RENOR_CONSOLIDATE_MAX_TOKENS "${rawTokens}": must be a positive integer`);
  const effort = (env.RENOR_CONSOLIDATE_REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT).trim().toLowerCase();
  if (!(EVIDENCE_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`Invalid RENOR_CONSOLIDATE_REASONING_EFFORT "${effort}": must be ${EVIDENCE_REASONING_EFFORTS.join(' | ')}`);
  }
  const rawReview = (env.RENOR_CONSOLIDATE_REVIEW ?? '').trim().toLowerCase();
  if (rawReview !== '' && rawReview !== 'off' && !['uncertain', 'updates', 'both'].includes(rawReview)) {
    throw new Error(`Invalid RENOR_CONSOLIDATE_REVIEW "${rawReview}": must be off | uncertain | updates | both`);
  }
  const review = rawReview === 'off' ? undefined : (rawReview === '' ? DEFAULT_REVIEW : rawReview as ReviewMode);
  return {
    baseUrl, keys, model, maxTokens: rawTokens === '' ? DEFAULT_MAX_TOKENS : Number(rawTokens), reasoningEffort: effort as EvidenceReasoningEffort,
    ...(review ? { review } : {}),
    dryRun: flag(env.RENOR_CONSOLIDATE_DRY_RUN),
    budget: {
      maxUsdPerDay: positiveNumber(env.RENOR_CONSOLIDATE_MAX_USD_PER_DAY, 'RENOR_CONSOLIDATE_MAX_USD_PER_DAY', DEFAULT_BUDGET.maxUsdPerDay),
      priceInPerM: positiveNumber(env.RENOR_CONSOLIDATE_PRICE_IN_PER_M, 'RENOR_CONSOLIDATE_PRICE_IN_PER_M', ownHw ? 0 : DEFAULT_BUDGET.priceInPerM, true),
      priceOutPerM: positiveNumber(env.RENOR_CONSOLIDATE_PRICE_OUT_PER_M, 'RENOR_CONSOLIDATE_PRICE_OUT_PER_M', ownHw ? 0 : DEFAULT_BUDGET.priceOutPerM, true),
    },
  };
}

/** Whether a run is due, from the counts the dreamer keeps. Pure, so the policy is testable without a clock. */
export function dreamDue(state: { savesSinceRun: number; lastSaveAt: number | null; lastRunAt: number | null; now: number }): boolean {
  if (state.savesSinceRun < 1) return false;
  if (state.lastRunAt !== null && state.now - state.lastRunAt < DREAM_MIN_GAP_MS) return false;
  if (state.savesSinceRun >= DREAM_AFTER_FACT_SAVES) return true;
  return state.lastSaveAt !== null && state.now - state.lastSaveAt >= DREAM_IDLE_MS;
}

// ---------------------------------------------------------------------------------------------------- what is remembered

/**
 * Two keys in one lazily created table, in the derived index (never the ledger): when the last run was, and which groups
 * have been judged. A group is identified by the ledger events of its facts, which never change, so a group that gains
 * or loses a fact (or has one corrected) is a new group, and one nothing touched is not asked about again.
 */
function state(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS dreamer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return {
    get: (key: string): string | undefined => (db.prepare('SELECT value FROM dreamer_state WHERE key = ?').get(key) as { value: string } | undefined)?.value,
    set: (key: string, value: string): void => { db.prepare('INSERT OR REPLACE INTO dreamer_state (key, value) VALUES (?, ?)').run(key, value); },
  };
}

export function clusterFingerprint(cluster: DreamerCluster): string {
  return crypto.createHash('sha256').update(`${cluster.kind}\n${cluster.facts.map(fact => fact.eventId).join('\n')}`).digest('hex');
}

const judgedKey = (cluster: DreamerCluster) => `judged:${PROMPT_VERSION}:${clusterFingerprint(cluster)}`;

// ---------------------------------------------------------------------------------------------------- one run

export interface ClusterReport {
  kind: DreamerCluster['kind'];
  fingerprint: string;
  facts: Array<{ id: number; eventId: string; subject: string; predicate: string; object: string; scope: string; validFrom: string; source: string }>;
  /** How this group was settled. */
  outcome: 'judged' | 'known' | 'too-large' | 'call-failed' | 'not-writable';
  adjudication?: Adjudication;
  written: AppliedWrite[];
  /** The writes a dry run would have made (empty otherwise). */
  planned?: Array<{ older: string; newer: string; scope: string; subject: string; predicate: string; value: string; reason: string }>;
  skipped: SkippedUpdate[];
}

export interface DreamerRunReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  candidates: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  clusters: ClusterReport[];
  /** The day's cost cap was reached: the groups not yet judged are asked on a later run. */
  capReached?: boolean;
  /** USD spent today (UTC) on this workspace's dreamer calls, after the run. */
  spentTodayUsd?: number;
  /** Errors that stopped the run before it judged anything. */
  error?: string;
}

export interface DreamerDeps {
  db: Database.Database;
  vaultPath: string;
  ledgerRelPath: string;
  chat: EvidenceChat;
  model: string;
  maxTokens: number;
  reasoningEffort?: EvidenceReasoningEffort;
  /** One more call for the pairs the mode names (review.ts). */
  review?: ReviewMode;
  /**
   * Ask the model about `predicate` groups too (two predicates of one thing, one naming the other's value). Default off: such a
   * group is named and never written (apply.ts), so the call could change nothing. On the one real workspace this was measured on, 150 of 154 groups were of
   * this kind.
   */
  judgePredicateGroups?: boolean;
  /**
   * Judge and plan, write nothing: no supersede, no table, no index pass, no remembered group. The report says what a real
   * run would have written (`planned`). For a first look at a workspace the dreamer has never run on.
   */
  dryRun?: boolean;
  /** The cost cap (budget.ts); default DEFAULT_BUDGET. */
  budget?: BudgetConfig;
  /** Index what a run appended to the ledger, as a fact save does (the memories then show the new events). */
  index?: () => Promise<unknown>;
  /** Hold the process awake while a run is in the air (on-demand engines exit when idle). */
  hold?: (run: Promise<unknown>) => void;
  now?: () => number;
}

const describeFact = (fact: JudgedFact) => ({
  id: fact.id, eventId: fact.eventId, subject: fact.subject, predicate: fact.predicate, object: fact.object,
  scope: fact.scope, validFrom: fact.validFrom, source: fact.source,
});

export class Dreamer {
  private readonly negativeCache = new Map<string, string>();
  private running: Promise<DreamerRunReport> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private savesSinceRun = 0;
  private lastSaveAt: number | null = null;
  private last: DreamerRunReport | null = null;
  /** A dry run touches nothing, not even the dreamer's own table: its memory (what it has judged, the day's spend) lives in the process. */
  private readonly dryMemory = new Map<string, string>();

  constructor(private readonly deps: DreamerDeps) {}

  private memory(): { get(key: string): string | undefined; set(key: string, value: string): void } {
    if (this.deps.dryRun === true) return { get: key => this.dryMemory.get(key), set: (key, value) => { this.dryMemory.set(key, value); } };
    return state(this.deps.db);
  }

  /** The last run's report (what it judged, wrote or would have written), or null before the first. */
  lastReport(): DreamerRunReport | null {
    return this.last;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** A fact was saved (by an agent). The dreamer counts them; it never reads their content here. */
  noteFactSave(): void {
    this.savesSinceRun += 1;
    this.lastSaveAt = this.now();
  }

  /** Look at the clock every DREAM_POLL_MS and run when one is due. The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      let lastRunAt: number;
      try {
        lastRunAt = Number(this.memory().get('lastRunAt') ?? NaN);
      } catch {
        return; // the database is closed or locked: not now
      }
      if (!dreamDue({ savesSinceRun: this.savesSinceRun, lastSaveAt: this.lastSaveAt, lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : null, now: this.now() })) return;
      this.runNow().then(
        report => logRun(report, this.deps.dryRun === true),
        err => log.error('run_failed', {}, err),
      );
    }, DREAM_POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run now. A run already in the air is joined, not started twice. */
  runNow(): Promise<DreamerRunReport> {
    if (!this.running) {
      const run = this.run().finally(() => { this.running = null; });
      this.running = run;
      this.deps.hold?.(run);
    }
    return this.running;
  }

  /** The run in the air, or null: whoever closes the database waits for it. */
  inFlight(): Promise<unknown> | null {
    return this.running;
  }

  private async run(): Promise<DreamerRunReport> {
    const { db, vaultPath, ledgerRelPath } = this.deps;
    const started = this.now();
    const report: DreamerRunReport = {
      startedAt: new Date(started).toISOString(), finishedAt: '', durationMs: 0, candidates: 0, calls: 0, promptTokens: 0, completionTokens: 0, clusters: [],
    };
    const finish = (): DreamerRunReport => {
      report.finishedAt = new Date(this.now()).toISOString();
      report.durationMs = this.now() - started;
      if (capReached) report.capReached = true;
      try { report.spentTodayUsd = Math.round(budget.spentToday() * 1e6) / 1e6; } catch { /* the database is closed */ }
      this.last = report;
      return report;
    };
    const dry = this.deps.dryRun === true;
    const memory = this.memory();
    const budget = new DreamerBudget(memory, this.deps.budget ?? DEFAULT_BUDGET, () => this.now());
    let capReached = false;
    const chat = meteredChat(this.deps.chat, budget, () => { capReached = true; });
    const provenance = { promptVersion: PROMPT_VERSION, model: this.deps.model };
    const savesAtStart = this.savesSinceRun;

    let events: Map<string, { statement?: string; source: string }>;
    try {
      const text = await fs.readFile(resolveLedgerPath(vaultPath, ledgerRelPath), 'utf8');
      events = new Map(parseLedgerEvents(text).map(ev => [ev.id, { statement: ev.statement, source: ev.source }]));
    } catch (err) {
      report.error = `ledger unreadable: ${err instanceof Error ? err.message : String(err)}`;
      return finish();
    }

    const clusters = findCandidateClusters(db);
    report.candidates = clusters.length;
    let anyFailed = false;
    for (const cluster of clusters) {
      const fingerprint = clusterFingerprint(cluster);
      const facts: JudgedFact[] = cluster.facts.map(fact => ({ ...fact, source: events.get(fact.eventId)?.source ?? 'unknown', statement: events.get(fact.eventId)?.statement }));
      const entry: ClusterReport = { kind: cluster.kind, fingerprint, facts: facts.map(describeFact), outcome: 'judged', written: [], skipped: [] };
      report.clusters.push(entry);
      if (cluster.facts.length > MAX_CLUSTER_FACTS) { entry.outcome = 'too-large'; continue; }
      if (cluster.kind === 'predicate' && this.deps.judgePredicateGroups !== true) { entry.outcome = 'not-writable'; continue; }
      if (memory.get(judgedKey(cluster)) !== undefined) { entry.outcome = 'known'; continue; }
      // A cost cap reached stops the run here: this group and the ones after it are asked on a later run (not remembered as judged).
      if (capReached) { entry.outcome = 'call-failed'; continue; }

      const adjudication = await adjudicate({
        chat, model: this.deps.model, maxTokens: this.deps.maxTokens, reasoningEffort: this.deps.reasoningEffort, review: this.deps.review, negativeCache: this.negativeCache,
      }, facts);
      entry.adjudication = adjudication;
      if (adjudication.usage) {
        report.calls += 1;
        report.promptTokens += adjudication.usage.promptTokens ?? 0;
        report.completionTokens += adjudication.usage.completionTokens ?? 0;
      }
      for (const { look } of adjudication.reviews ?? []) {
        if (!look.usage) continue;
        report.calls += 1;
        report.promptTokens += look.usage.promptTokens ?? 0;
        report.completionTokens += look.usage.completionTokens ?? 0;
      }
      if (adjudication.retry) {
        // The call itself failed (a provider that is down or throttling): this group is asked again on the next run.
        entry.outcome = 'call-failed';
        anyFailed = true;
        continue;
      }
      const agreed = (adjudication.reviews ?? []).some(r => r.final === 'updates' && r.first === 'updates' && r.look.failure === undefined);
      const plan = planWrites(cluster.kind, facts, adjudication.pairs, { ...provenance, ...(agreed && this.deps.review ? { secondLook: 'agreed' } : {}) });
      entry.skipped = plan.skipped;
      if (dry) {
        entry.planned = plan.writes.map(w => ({ older: w.older.eventId, newer: w.newer.eventId, scope: w.older.scope, subject: w.older.subject, predicate: w.older.predicate, value: w.newer.object, reason: w.reason }));
      } else {
        entry.written = await applyWrites({ db, vaultPath, ledgerRelPath }, plan.writes);
      }
      // Settled for this group as it stands; a write that was refused because the fact changed makes a new group anyway.
      memory.set(judgedKey(cluster), JSON.stringify({ at: new Date(this.now()).toISOString(), pairs: summarize(adjudication.pairs), written: entry.written.filter(w => w.receipt).length }));
    }

    if (report.clusters.some(c => c.written.some(w => w.receipt))) {
      try {
        await this.deps.index?.();
      } catch (err) {
        log.error('index_after_run_failed', {}, err);
      }
    }
    memory.set('lastRunAt', String(this.now()));
    // Saves that arrived during the run count toward the next one; a run that could not reach the model leaves its work due.
    this.savesSinceRun = anyFailed ? Math.max(1, this.savesSinceRun - savesAtStart) : Math.max(0, this.savesSinceRun - savesAtStart);
    return finish();
  }
}

const summarize = (pairs: PairVerdict[]) => pairs.map(p => `${p.older}->${p.newer}:${p.verdict}`);

/** One line per run for the log, and in a dry run one more per planned write: names and event ids, never a value. */
function logRun(report: DreamerRunReport, dry: boolean): void {
  const writes = report.clusters.reduce((n, c) => n + c.written.filter(w => w.receipt).length, 0);
  const planned = report.clusters.flatMap(c => c.planned ?? []);
  log.info(dry ? 'dry_run' : 'run', {
    groups: report.candidates, calls: report.calls, ...(dry ? { plannedWrites: planned.length } : { writes }),
    spentTodayUsd: report.spentTodayUsd, capReached: report.capReached === true, durationMs: report.durationMs,
  });
  for (const w of planned) {
    log.info('dry_run_planned_write', { olderEvent: w.older, newerEvent: w.newer, subject: w.subject, predicate: w.predicate, scope: w.scope });
  }
}

/**
 * The dreamer for a service, or null: off (the flag) or not configured (no model). Off constructs nothing and reads
 * nothing but the flag. When on but incomplete, the service starts without it and the log says why, once.
 */
export function createDreamer(
  env: NodeJS.ProcessEnv,
  deps: Omit<DreamerDeps, 'chat' | 'model' | 'maxTokens' | 'reasoningEffort' | 'review' | 'dryRun' | 'budget'>,
  chatOverride?: EvidenceChat,
): Dreamer | null {
  if (!consolidateEnabled(env)) return null;
  const model = resolveDreamerModel(env);
  if ('off' in model) {
    log.info('off', { reason: model.off });
    return null;
  }
  return new Dreamer({
    ...deps,
    chat: chatOverride ?? createOllamaChat({ baseUrl: model.baseUrl, keys: model.keys, headers: providerHeaders(model.baseUrl) }),
    model: model.model,
    maxTokens: model.maxTokens,
    reasoningEffort: model.reasoningEffort,
    review: model.review,
    dryRun: model.dryRun,
    budget: model.budget,
  });
}

/** OpenCode Go answers a request with no session id `MissingSessionID`; one id for the life of the process is what it asks for. */
const OPENCODE_SESSION = crypto.randomUUID();
export function providerHeaders(baseUrl: string): Record<string, string> {
  try {
    return new URL(baseUrl).hostname === 'opencode.ai' ? { 'x-opencode-session': OPENCODE_SESSION } : {};
  } catch {
    return {};
  }
}
