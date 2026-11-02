/**
 * The engine's half of server-side end-of-turn capture (POST /internal/capture-turns, reached through the gateway's
 * POST /capture/turns). Off unless the workspace opted in (captureModel.ts: RENOR_CAPTURE_SERVER_OPTIN, RENOR_CAPTURE_KEY_FILE);
 * without it nothing is parsed further and no model call is made.
 *
 * Per request, in order: opt-in check (403 capture_not_enabled) → strict body check (400) → secret screen over every turn
 * (a turn with a secret is dropped whole; a scanner failure answers 503 before anything else) → model and cool-down checks →
 * per-call cap and daily cap, both on a conservative maximum cost, reserved under a lock before the call (429) → one model call
 * → settle the reservation to the call's real cost (or keep it whole when the usage is unknown) → save what passes.
 *
 *   observations  saved as dated notes through the normal note writer (source `capture-server`), so the secret guard
 *                 (appendDailyEntry) applies. One whose text repeats one of the last 200 captured saves is skipped
 *                 (equal, or token overlap of at least 0.8 of the longer text). A text the scanner flags is not saved.
 *   rules         saved as new pending `standing rule` facts, only while rule approvals are on (RENOR_RULE_APPROVALS). A
 *                 topic that already has a current fact is skipped: a capture never supersedes or retires an existing fact.
 *
 * What it never does: write the delta. Nothing it receives is stored, logged or echoed; the reply is counts only, and
 * every error answer is a fixed code. A failure, timeout, bad reply or unknown usage saves nothing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from '../db/sqlite';
import { remember, StaleExpectationError } from '../memory/lifecycle';
import { ruleApprovalsEnabled } from '../mvp/ruleApprovals';
import { scanSecrets } from './secretScanner';
import {
  ANTHROPIC_CAPTURE_PRICE_PER_MILLION, captureConfigDigest, captureMaxUsd, captureServerConfig, captureUserContent, extractCapture,
  type CaptureConfig, type CapturePrice,
} from './captureModel';

export const CAPTURE_SOURCE = 'capture-server';
export const CAPTURE_WRITER = 'renor-capture-server';
export const CAPTURE_CLIENT = 'claude-code-hook/1';
/** After a failed call, capture answers 503 for this long, so an outage costs one call, not one per turn. */
export const CAPTURE_COOLDOWN_MS = 30_000;
const DEDUPE_WINDOW = 200;
const DEDUPE_OVERLAP = 0.8;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 2000;
const MAX_DELTA_CHARS = 12000;
/** A lock older than this was left by a process that died; it is taken over. The lock is held for milliseconds. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;

export interface CaptureTurnsDeps {
  env: NodeJS.ProcessEnv;
  /** Where the per-tenant daily total and the per-call ledger live (the auth state directory, never the memory directory). */
  stateDir: string;
  saveNote(text: string, date: string): Promise<void>;
  /** Resolves true when the rule was written as a new pending fact, false when its topic already had a current fact. */
  saveRule(topic: string, text: string): Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface CaptureTurnsAnswer { status: number; body: Record<string, unknown> }

interface Delta { session: string; turn_index: number; messages: Array<{ role: 'user' | 'assistant'; text: string; at: string | null }> }
interface Spend { day: string; usd: number }
type Admission = 'admitted' | 'over' | 'busy';

const normalise = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Strict shape check: what the hook sends, and nothing else. */
export function parseDelta(body: unknown): Delta | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.client !== CAPTURE_CLIENT) return null;
  if (typeof b.session !== 'string' || !/^[0-9a-f]{12}$/.test(b.session)) return null;
  if (!Number.isSafeInteger(b.turn_index) || (b.turn_index as number) < 0) return null;
  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > MAX_MESSAGES) return null;
  let total = 0;
  const messages: Delta['messages'] = [];
  for (const m of b.messages) {
    if (!m || typeof m !== 'object') return null;
    const x = m as Record<string, unknown>;
    if (x.role !== 'user' && x.role !== 'assistant') return null;
    if (typeof x.text !== 'string' || x.text.length < 1 || x.text.length > MAX_MESSAGE_CHARS) return null;
    if (x.at !== null && typeof x.at !== 'string') return null;
    total += x.text.length;
    messages.push({ role: x.role, text: x.text, at: x.at as string | null });
  }
  if (total > MAX_DELTA_CHARS) return null;
  return { session: b.session, turn_index: b.turn_index as number, messages };
}

/** The gateway's secret, compared in constant time over digests (so the length does not leak). */
export function gatewaySecretMatches(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest();
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.max(a.size, b.size, 1);
}

/**
 * Drops every turn the canonical secret scanner flags, whole. It throws when the scanner throws: the caller answers 503, so
 * a broken scanner sends nothing.
 */
export function screenTurns<T extends { text: string }>(messages: readonly T[]): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const message of messages) {
    if (scanSecrets(message.text) !== null) dropped++;
    else kept.push(message);
  }
  return { kept, dropped };
}

function readSpend(file: string, day: string): Spend {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Spend;
    if (value.day === day && Number.isFinite(value.usd) && value.usd >= 0) return value;
  } catch { /* no total yet, or an unreadable one: start the day at zero */ }
  return { day, usd: 0 };
}

function writeSpend(file: string, value: Spend): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

/**
 * Runs `fn` while holding an exclusive lock file, so two processes sharing the state directory cannot both read the same total
 * and both pass the cap. Undefined when the lock stayed busy for LOCK_WAIT_MS (the caller fails closed).
 */
function withLock<T>(file: string, fn: () => T): T | undefined {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch { /* the holder released it between the two calls */ }
      if (Date.now() > deadline) return undefined;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    try {
      return fn();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }
}

/** Adds the reservation to the day's total when it fits under the daily cap. */
function reserveSpend(file: string, day: string, reserve: number, capDay: number): Admission {
  return withLock(file, (): Admission => {
    const before = readSpend(file, day);
    if (before.usd + reserve > capDay) return 'over';
    writeSpend(file, { day, usd: before.usd + reserve });
    return 'admitted';
  }) ?? 'busy';
}

/** Replaces the reservation with the call's charge. Returns false when the lock stayed busy: the reservation then stands. */
function settleSpend(file: string, day: string, reserve: number, charged: number): boolean {
  return withLock(file, () => {
    const settled = readSpend(file, day);
    writeSpend(file, { day, usd: Math.max(0, settled.usd - reserve + charged) });
    return true;
  }) ?? false;
}

/** One line per model call, written before the call and again after it: numbers and labels only. */
function appendCall(file: string, row: Record<string, number | string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, { mode: 0o600 });
}

/**
 * Writes one captured rule as a new pending `standing rule` fact. `expectCurrentEvent: null` makes the write conditional on the
 * topic having no current fact, so an existing rule (approved or pending) is never superseded or retired by a capture.
 */
export function captureRuleSaver(db: Database.Database, memoryDir: string, ledgerRelPath: string): (topic: string, text: string) => Promise<boolean> {
  return async (topic, text) => {
    try {
      await remember(db, memoryDir, ledgerRelPath, {
        subject: 'standing rule', predicate: topic, object: text, source: CAPTURE_SOURCE, writer: CAPTURE_WRITER, expectCurrentEvent: null,
      });
      return true;
    } catch (err) {
      if (err instanceof StaleExpectationError) return false;
      throw err;
    }
  };
}

export function createCaptureTurns(deps: CaptureTurnsDeps): (body: unknown) => Promise<CaptureTurnsAnswer> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const spendFile = path.join(deps.stateDir, 'capture-spend.json');
  const callsFile = path.join(deps.stateDir, 'capture-calls.jsonl');
  let cooldownUntil = 0;
  const recent: Array<{ key: string; tokens: Set<string> }> = [];

  const isDuplicate = (key: string): boolean => {
    const tokens = new Set(key.split(' ').filter(Boolean));
    return recent.some(r => r.key === key || overlap(r.tokens, tokens) >= DEDUPE_OVERLAP);
  };
  const remembered = (key: string): void => {
    recent.push({ key, tokens: new Set(key.split(' ').filter(Boolean)) });
    if (recent.length > DEDUPE_WINDOW) recent.shift();
  };

  return async function handle(body: unknown): Promise<CaptureTurnsAnswer> {
    try {
      const cfg: CaptureConfig | null = captureServerConfig(deps.env);
      if (!cfg) return { status: 403, body: { error: 'capture_not_enabled' } };
      const delta = parseDelta(body);
      if (!delta) return { status: 400, body: { error: 'invalid_body' } };

      // Screened before any spend, log or provider call. Only the count of turns held back is logged, never their text.
      let screened: { kept: Delta['messages']; dropped: number };
      try {
        screened = screenTurns(delta.messages);
      } catch {
        return { status: 503, body: { error: 'scanner_unavailable' } };
      }
      if (screened.dropped > 0) log(`[capture] ${screened.dropped} turn(s) held back by the secret scanner: not sent`);
      if (screened.kept.length === 0) return { status: 200, body: { ok: true, saved: 0, pending_rules: 0 } };
      const messages = screened.kept;

      const price: CapturePrice | undefined = ANTHROPIC_CAPTURE_PRICE_PER_MILLION[cfg.model];
      if (!price) return { status: 503, body: { error: 'model_price_unknown' } };
      if (now() < cooldownUntil) return { status: 503, body: { error: 'cooling_down' } };

      const day = new Date(now()).toISOString().slice(0, 10);
      const chars = messages.reduce((n, m) => n + m.text.length, 0);
      const reserve = captureMaxUsd(captureUserContent(messages), price);
      if (reserve > cfg.maxUsdCall) {
        log('[capture] per-call cap reached: the call was not made');
        return { status: 429, body: { error: 'capture_call_cap' } };
      }
      const admission = reserveSpend(spendFile, day, reserve, cfg.maxUsdDay);
      if (admission === 'busy') return { status: 503, body: { error: 'capture_busy' } };
      if (admission === 'over') {
        log('[capture] daily cap reached: the call was not made');
        return { status: 429, body: { error: 'capture_budget' } };
      }
      // The reservation is on record before the call, so a call that dies midway still shows up here.
      appendCall(callsFile, {
        event: 'reserved', config: captureConfigDigest(cfg, price), reserve_usd: reserve, cap_call_usd: cfg.maxUsdCall, cap_day_usd: cfg.maxUsdDay,
        messages: messages.length, chars,
      });

      const result = await extractCapture(messages, cfg, deps.fetchImpl);
      // Settle to the real charge when the usage is known and within the reservation; otherwise the whole reservation stands.
      const charged = result?.usd ?? reserve;
      const usageKnown = result !== null && result.usd !== null;
      settleSpend(spendFile, day, reserve, charged);
      appendCall(callsFile, {
        event: 'settled', ok: result ? 1 : 0, usage_known: usageKnown ? 1 : 0,
        in_tokens: result?.inTokens ?? 0, out_tokens: result?.outTokens ?? 0,
        cache_write_tokens: result?.cacheWriteTokens ?? 0, cache_read_tokens: result?.cacheReadTokens ?? 0,
        usd_est: charged, messages: messages.length, chars,
      });
      if (!result) {
        cooldownUntil = now() + CAPTURE_COOLDOWN_MS;
        return { status: 502, body: { error: 'model_unavailable' } };
      }
      if (result.usd === null) return { status: 502, body: { error: 'usage_unknown' } };
      if (result.usd > reserve) return { status: 502, body: { error: 'cost_over_reserve' } };

      let saved = 0;
      for (const observation of result.observations) {
        const key = normalise(observation.text);
        if (!key || isDuplicate(key)) continue;
        // The model's output is screened again before it is written.
        if (scanSecrets(observation.text) !== null) continue;
        try {
          await deps.saveNote(observation.text, observation.date);
          remembered(key);
          saved++;
        } catch { /* refused by the secret guard, or not written: nothing of it is kept */ }
      }

      let pending = 0;
      if (ruleApprovalsEnabled(deps.env)) {
        for (const rule of result.rules) {
          if (scanSecrets(rule.text) !== null || scanSecrets(rule.topic) !== null) continue;
          try {
            if (await deps.saveRule(rule.topic.replace(/ /g, '_'), rule.text)) pending++;
          } catch { /* refused or not written */ }
        }
      }
      return { status: 200, body: { ok: true, saved, pending_rules: pending } };
    } catch {
      return { status: 500, body: { error: 'capture_failed' } };
    }
  };
}
