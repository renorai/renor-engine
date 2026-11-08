import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { attachEngine, engineIndexChanged, engineRememberNote, engineSearchMemory, resolveEngineDigests, type Engine } from '../../src/mvp/engine';
import type { MvpConfig } from '../../src/mvp/config';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import type { EvidenceChat, EvidenceChatRequest } from '../../src/evidence/secondPass';
import { DigestCache } from '../../src/digests/digestCache';
import {
  DIGEST_DEBOUNCE_MS,
  DIGEST_MAX_FAILED_SWEEPS,
  DIGEST_MIN_INTERVAL_MS,
  DIGEST_RETRY_BASE_MS,
  DigestWorker,
  guardedDigestChat,
} from '../../src/digests/worker';
import { digestsEnabled, resolveDigestOptions, type DigestOptions } from '../../src/digests/digests';
import { stubDigestReply } from './stubDigestModel';
import { removeTestDir } from '../helpers/removeDb';

/**
 * The production path of write-time digests: the background worker, its retries, its cost guard, its pruning, and the
 * search that reads what it wrote. A manual clock and timers stand in for time; a stub stands in for the model. No
 * provider is called anywhere in this file.
 */

const tmpDirs: string[] = [];
const openDbs: Database.Database[] = [];
const workers: DigestWorker[] = [];
afterEach(async () => {
  // A worker's sweep uses the database: each ends before the database closes, and both before the folder goes.
  for (const w of workers.splice(0)) await w.close();
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) removeTestDir(dir);
});

class ManualClock {
  t = Date.UTC(2026, 9, 6, 12, 0, 0);
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private next = 1;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter(timer => timer.id !== handle);
  };
  get pending(): number { return this.timers.length; }
  /** Move time forward, firing each timer that falls due, in order, and letting what it started finish. */
  async advance(ms: number, worker?: DigestWorker): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter(timer => timer.id !== due.id);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await worker?.whenSwept();
    }
    this.t = target;
  }
}

interface Fixture {
  db: Database.Database;
  memoryDir: string;
  config: MvpConfig;
  engine: Engine;
  provider: EvalHashEmbeddingProvider;
  cachePath: string;
}

async function fixture(): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-worker-'));
  tmpDirs.push(root);
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const dbPath = path.join(root, 'state', 'index.db');
  const db = openDb(dbPath);
  openDbs.push(db);
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const config = { memoryDir, dbPath, ledgerRelPath: 'Memory/Ledger/Memory Events Ledger.md' } as unknown as MvpConfig;
  const engine = attachEngine(db, config, provider);
  return { db, memoryDir, config, engine, provider, cachePath: path.join(root, 'state', 'digest-cache.db') };
}

async function save(f: Fixture, text: string, scope?: string): Promise<void> {
  await engineRememberNote(f.config, `[Turn 1 User] ${text}`.replace('[Turn 1 User] ', ''), undefined, 'test', scope);
  await engineIndexChanged(f.db, f.config, f.engine);
}

function options(f: Fixture, over: Partial<DigestOptions> = {}, chat?: EvidenceChat): DigestOptions {
  return {
    model: 'stub-digest', effort: 'low', cachePath: f.cachePath, cacheOnly: false, tokens: 600, retries: 0,
    maxUsdPerDay: 0.5, priceInPerM: 0.225, priceOutPerM: 0.75, chat, ...over,
  };
}

type Stub = EvidenceChat & { calls: EvidenceChatRequest[]; failNext: number };
function stub(): Stub {
  const calls: EvidenceChatRequest[] = [];
  const chat = (async (request: EvidenceChatRequest) => {
    calls.push(request);
    if (chat.failNext > 0) {
      chat.failNext--;
      throw new Error('extractor provider returned 503');
    }
    const prompt = request.messages[request.messages.length - 1].content;
    // The stub's reply reads user lines of plain notes too: one item per non-empty line that starts with "I ".
    const content = /^\[Turn \d+ User\]/m.test(prompt) ? stubDigestReply(prompt) : plainReply(prompt);
    return { content, promptTokens: 1_000, completionTokens: 200, latencyMs: 3 };
  }) as Stub;
  chat.calls = calls;
  chat.failNext = 0;
  return chat;
}

/** A plain note (a daily note has no turn structure): one item per line the user wrote ("I ..."). */
function plainReply(prompt: string): string {
  const notes: Array<{ id: string; items: Array<Record<string, string>> }> = [];
  for (const block of prompt.split(/^=== CONVERSATION id=/m).slice(1)) {
    const id = block.slice(0, block.indexOf(' '));
    const date = /date=(.*?) ===/.exec(block)?.[1] ?? '';
    const items = block.split('\n').filter(line => /\bI (bought|adopted|moved|booked|paid)/.test(line))
      .map(line => ({ item: line.replace(/^.*\(test\)\s*/, '').slice(0, 100), action: 'said', amount: '', date, turn: '' }));
    notes.push({ id, items });
  }
  return JSON.stringify({ notes });
}

function worker(f: Fixture, clock: ManualClock, opts: DigestOptions, extra: Partial<ConstructorParameters<typeof DigestWorker>[0]> = {}): DigestWorker {
  const w = new DigestWorker({
    db: f.db, config: { memoryDir: f.memoryDir, ledgerRelPath: f.config.ledgerRelPath }, options: opts, provider: f.provider,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0.5, log: () => undefined, ...extra,
  });
  workers.push(w);
  return w;
}

/** How many digests the workspace's cache holds. */
function digestCount(f: Fixture): number {
  const cache = new DigestCache(f.cachePath, { readonly: true });
  try {
    return (cache as unknown as { db: Database.Database }).db.prepare('SELECT COUNT(*) FROM note_digests').pluck().get() as number;
  } finally { cache.close(); }
}

describe('the digest worker', () => {
  it('a save only sets a timer: notify returns at once, and no model is called until the debounce has passed', async () => {
    const f = await fixture();
    const clock = new ManualClock();
    const chat = stub();
    const w = worker(f, clock, options(f, {}, chat));
    await save(f, 'I bought a red bicycle yesterday.');
    w.notify();
    expect(chat.calls).toHaveLength(0);
    expect(w.status().state).toBe('scheduled');
    await clock.advance(DIGEST_DEBOUNCE_MS - 1, w);
    expect(chat.calls).toHaveLength(0);
    await clock.advance(1, w);
    expect(chat.calls).toHaveLength(1);
    expect(w.status()).toMatchObject({ state: 'idle', consecutiveFailures: 0 });
    expect(w.status().lastSweep).toMatchObject({ digested: 1, failed: 0 });
    // The save itself never waited: a model that never answers does not hold notify.
    const never = (() => new Promise<never>(() => undefined)) as unknown as EvidenceChat;
    const slow = worker(f, new ManualClock(), options(f, {}, never));
    const started = Date.now();
    slow.notify();
    expect(Date.now() - started).toBeLessThan(50);
    await slow.close();
  });

  it('batches saves: several saves inside the debounce are one sweep, and the next one waits out the minimum interval', async () => {
    const f = await fixture();
    const clock = new ManualClock();
    const chat = stub();
    const w = worker(f, clock, options(f, {}, chat));
    for (const text of ['I bought a lamp.', 'I adopted a dog.', 'I moved to Lisbon.']) {
      await save(f, text);
      w.notify();
    }
    expect(clock.pending).toBe(1);
    await clock.advance(DIGEST_DEBOUNCE_MS, w);
    expect(chat.calls).toHaveLength(1);
    // A save right after: it is not digested before the minimum interval since the last sweep has passed.
    await save(f, 'I booked a flight.');
    w.notify();
    await clock.advance(DIGEST_DEBOUNCE_MS, w);
    expect(chat.calls).toHaveLength(1);
    await clock.advance(DIGEST_MIN_INTERVAL_MS, w);
    expect(chat.calls).toHaveLength(2);
  });

  it('retries with a doubling backoff after provider failures, then recovers', async () => {
    const f = await fixture();
    const clock = new ManualClock();
    const chat = stub();
    chat.failNext = 3;
    const w = worker(f, clock, options(f, {}, chat));
    await save(f, 'I bought a red bicycle yesterday.');
    w.notify();
    await clock.advance(DIGEST_DEBOUNCE_MS, w);
    expect(w.status()).toMatchObject({ state: 'retrying', consecutiveFailures: 1 });
    // random() is 0.5, so the jitter factor is 1: the waits are exactly 30 s, 60 s, 120 s.
    await clock.advance(DIGEST_RETRY_BASE_MS - 1, w);
    expect(chat.calls).toHaveLength(1);
    await clock.advance(1, w);
    expect(chat.calls).toHaveLength(2);
    expect(w.status()).toMatchObject({ state: 'retrying', consecutiveFailures: 2 });
    await clock.advance(2 * DIGEST_RETRY_BASE_MS - 1, w);
    expect(chat.calls).toHaveLength(2);
    await clock.advance(1, w);
    expect(chat.calls).toHaveLength(3);
    expect(w.status()).toMatchObject({ state: 'retrying', consecutiveFailures: 3 });
    await clock.advance(4 * DIGEST_RETRY_BASE_MS, w);
    expect(chat.calls).toHaveLength(4);
    expect(w.status()).toMatchObject({ state: 'idle', consecutiveFailures: 0 });
    // The note has its digest now, and nothing is asked again.
    await clock.advance(10 * DIGEST_MIN_INTERVAL_MS, w);
    expect(chat.calls).toHaveLength(4);
  });

  it('stops after a run of failed sweeps and tries once more only when a save arrives', async () => {
    const f = await fixture();
    const clock = new ManualClock();
    const chat = stub();
    chat.failNext = 1_000;
    const w = worker(f, clock, options(f, {}, chat));
    await save(f, 'I bought a red bicycle yesterday.');
    w.notify();
    await clock.advance(DIGEST_DEBOUNCE_MS, w);
    for (let i = 0; i < DIGEST_MAX_FAILED_SWEEPS; i++) await clock.advance(10 * 60_000, w);
    expect(w.status().state).toBe('stopped');
    expect(w.status().reason).toContain('failed');
    const calls = chat.calls.length;
    await clock.advance(24 * 3_600_000, w);
    expect(chat.calls).toHaveLength(calls);
    await save(f, 'I adopted a dog.');
    w.notify();
    await clock.advance(DIGEST_DEBOUNCE_MS + DIGEST_MIN_INTERVAL_MS, w);
    expect(chat.calls.length).toBe(calls + 1);
    expect(w.status().state).toBe('stopped');
  });

  it('a cost guard holds the day: a call that could pass the budget is not made, and the next UTC day resumes', async () => {
    const f = await fixture();
    const clock = new ManualClock();
    const chat = stub();
    // The worst case of one call (its prompt plus the whole 8,000-token output) is about 0.006 USD: a 0.01 budget
    // admits one call, counts what it really cost (1,000 in, 200 out = 0.000375), and then admits no more than its room.
    const w = worker(f, clock, options(f, { maxUsdPerDay: 0.004 }, chat));
    await save(f, 'I bought a red bicycle yesterday.');
    w.notify();
    await clock.advance(DIGEST_DEBOUNCE_MS, w);
    expect(chat.calls).toHaveLength(0);
    expect(w.status().state).toBe('paused-budget');
    expect(w.status().reason).toContain('budget');
    // A save while paused does not call the model either.
    await save(f, 'I adopted a dog.');
    w.notify();
    await clock.advance(2 * DIGEST_MIN_INTERVAL_MS, w);
    expect(chat.calls).toHaveLength(0);
    // The next UTC day: the budget is a new one. (The guard here is per day, so raise nothing: the worst case still
    // does not fit 0.004, which is the point: a budget below one call's worst case never spends.)
    await clock.advance(24 * 3_600_000 + 120_000, w);
    expect(chat.calls).toHaveLength(0);
    expect(w.status().state).toBe('paused-budget');

    const g = await fixture();
    const clock2 = new ManualClock();
    const chat2 = stub();
    const w2 = worker(g, clock2, options(g, { maxUsdPerDay: 0.0063 }, chat2));
    await save(g, 'I bought a red bicycle yesterday.');
    w2.notify();
    await clock2.advance(DIGEST_DEBOUNCE_MS, w2);
    expect(chat2.calls).toHaveLength(1);
    expect(w2.status().spentTodayUsd).toBeCloseTo((1_000 * 0.225 + 200 * 0.75) / 1e6, 8);
    // 0.0063 minus the 0.000375 spent leaves less than one call's worst case (about 0.00608: a prompt and 8,000 output tokens): the second note waits for tomorrow.
    await save(g, 'I adopted a dog.');
    w2.notify();
    await clock2.advance(DIGEST_MIN_INTERVAL_MS + DIGEST_DEBOUNCE_MS, w2);
    expect(chat2.calls).toHaveLength(1);
    expect(w2.status().state).toBe('paused-budget');
    await clock2.advance(24 * 3_600_000, w2);
    expect(chat2.calls).toHaveLength(2);
    expect(w2.status().state).toBe('idle');
  });

  it('a budget hit pauses until the end of the day it was refused on, not of the day the sweep happens to end', async () => {
    const f = await fixture();
    const clock = new ManualClock();
    clock.t = Date.UTC(2026, 9, 6, 23, 59, 50);
    const base = stub();
    // A call billed at 0.0975 USD against a 0.1 USD day: the first batch (six notes) fits, the second (one note) is refused.
    const heavy: EvidenceChat = async request => ({ ...(await base(request)), promptTokens: 100_000, completionTokens: 100_000 });
    // The embedding pass that follows the refusal takes a minute, so the sweep ends after UTC midnight.
    let late = true;
    class EmbedsPastMidnight extends EvalHashEmbeddingProvider {
      override async embed(texts: string[]): Promise<number[][]> {
        if (late) {
          late = false;
          clock.t += 60_000;
        }
        return super.embed(texts);
      }
    }
    for (let day = 1; day <= 7; day++) await engineRememberNote(f.config, `I bought lamp number ${day}.`, `2026-09-0${day}`, 'test');
    await engineIndexChanged(f.db, f.config, f.engine);
    const w = worker(f, clock, options(f, { maxUsdPerDay: 0.1 }, heavy), { provider: new EmbedsPastMidnight() });
    await w.sweepNow();
    expect(base.calls).toHaveLength(1);
    expect(new Date(clock.now()).toISOString().slice(0, 10)).toBe('2026-10-07');
    expect(w.status().state).toBe('paused-budget');
    expect(digestCount(f)).toBe(6);
    // The day that was refused is over, so the budget is a new one: the seventh note is digested within the minutes a
    // sweep needs, not a day later.
    await clock.advance(2 * DIGEST_MIN_INTERVAL_MS, w);
    expect(base.calls).toHaveLength(2);
    expect(w.status()).toMatchObject({ state: 'idle', consecutiveFailures: 0 });
    expect(digestCount(f)).toBe(7);
  });

  it('records the spend of every call in the workspace\'s own cache, and counts a failed call at its prompt', async () => {
    const f = await fixture();
    const cache = new DigestCache(f.cachePath);
    const ok: EvidenceChat = async () => ({ content: '{}', promptTokens: 2_000, completionTokens: 500, latencyMs: 1 });
    const bad: EvidenceChat = async () => { throw new Error('timeout'); };
    const base = { cache, day: () => '2026-10-06', options: { maxUsdPerDay: 1, priceInPerM: 0.225, priceOutPerM: 0.75 }, onBudget: () => undefined };
    await guardedDigestChat({ ...base, chat: ok })({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0 });
    expect(cache.spentUsd('2026-10-06')).toBeCloseTo((2_000 * 0.225 + 500 * 0.75) / 1e6, 8);
    await expect(guardedDigestChat({ ...base, chat: bad })({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(3_000) }], temperature: 0 })).rejects.toThrow('timeout');
    expect(cache.spentUsd('2026-10-06')).toBeGreaterThan((2_000 * 0.225 + 500 * 0.75) / 1e6);
    expect(cache.spentUsd('2026-10-07')).toBe(0);
    cache.close();
  });

  it('removes the digest of text a note no longer holds: an edited note, and a note whose file is gone', async () => {
    const f = await fixture();
    const clock = new ManualClock();
    const chat = stub();
    const w = worker(f, clock, options(f, {}, chat));
    await save(f, 'I bought a red bicycle yesterday.');
    await w.sweepNow();
    const count = () => {
      const cache = new DigestCache(f.cachePath, { readonly: true });
      try {
        return (cache as unknown as { db: Database.Database }).db.prepare('SELECT COUNT(*) FROM note_digests').pluck().get() as number;
      } finally { cache.close(); }
    };
    expect(count()).toBe(1);
    // The note changes (an entry is added): the digest of the old text goes, the new text gets its own.
    await save(f, 'I adopted a dog.');
    await w.sweepNow();
    expect(count()).toBe(1);
    expect(w.status().lastSweep).toMatchObject({ pruned: 1, digested: 1 });
    // The note's file is gone (retired, moved): its digest is removed, and that is not a failure to retry.
    for (const file of fs.readdirSync(path.join(f.memoryDir, 'Memory', 'Daily'))) fs.rmSync(path.join(f.memoryDir, 'Memory', 'Daily', file));
    await w.sweepNow();
    expect(count()).toBe(0);
    expect(w.status()).toMatchObject({ state: 'idle', consecutiveFailures: 0 });
  });

  it('a note edited on disk and not re-indexed keeps its digest, as search keeps its old chunks, until the index sees the change', async () => {
    // A digest follows the index, not the file: it describes the text search can find. The stored text and the digest of
    // it both stay until a save, an import or `renor index` makes the index see the change (README, "Forgetting").
    const f = await fixture();
    const clock = new ManualClock();
    const w = worker(f, clock, options(f, {}, stub()));
    await save(f, 'I bought a red bicycle yesterday.');
    await w.sweepNow();
    expect(digestCount(f)).toBe(1);
    const dir = path.join(f.memoryDir, 'Memory', 'Daily');
    for (const name of fs.readdirSync(dir)) fs.appendFileSync(path.join(dir, name), '\n- [12:00] (test) I adopted a dog named Biscuit.\n');
    const seen = await engineSearchMemory(f.db, f.engine, f.memoryDir, 'dog named Biscuit', 8, undefined, undefined, false, f.config.ledgerRelPath);
    expect(JSON.stringify(seen.hits)).not.toContain('Biscuit');
    await w.sweepNow();
    expect(digestCount(f)).toBe(1);
    expect(w.status().lastSweep).toMatchObject({ pruned: 0, failed: 0 });
    // The index sees the change: the digest of the old text goes, and the new text gets its own.
    await engineIndexChanged(f.db, f.config, f.engine);
    await w.sweepNow();
    expect(w.status().lastSweep).toMatchObject({ pruned: 1, digested: 1, failed: 0 });
    expect(digestCount(f)).toBe(1);
  });

  it('does not start without a digest model or without embeddings, and says why', async () => {
    const f = await fixture();
    const clock = new ManualClock();
    const logs: string[] = [];
    const noModel = worker(f, clock, options(f), { log: line => logs.push(line) });
    noModel.start();
    noModel.notify();
    expect(noModel.status()).toMatchObject({ state: 'stopped' });
    expect(noModel.status().reason).toContain('no digest model');
    expect(clock.pending).toBe(0);
    const noEmbeddings = worker(f, clock, options(f, {}, stub()), { provider: null });
    noEmbeddings.notify();
    expect(noEmbeddings.status().reason).toContain('no embedding provider');
    expect(logs.join('\n')).not.toMatch(/Bearer|sk-/);
  });

  it('holds the sweep in the idle monitor, and shutdown waits for it', async () => {
    const f = await fixture();
    const clock = new ManualClock();
    const chat = stub();
    let tracked = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: EvidenceChat = async request => { await gate; return chat(request); };
    const w = worker(f, clock, options(f, {}, slow), { track: async work => { tracked++; return work(); } });
    await save(f, 'I bought a red bicycle yesterday.');
    w.notify();
    await clock.advance(DIGEST_DEBOUNCE_MS);
    expect(tracked).toBe(1);
    expect(w.status().state).toBe('running');
    let closed = false;
    const closing = w.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    expect(chat.calls).toHaveLength(1);
  });
});

describe('digests on the read path', () => {
  async function ready(f: Fixture): Promise<{ digests: NonNullable<ReturnType<typeof resolveEngineDigests>>; chat: Stub }> {
    const chat = stub();
    const env = { RENOR_DIGESTS: '1', RENOR_DIGEST_MODEL: 'stub-digest', RENOR_DIGEST_CACHE: f.cachePath } as NodeJS.ProcessEnv;
    const resolved = resolveEngineDigests(f.db, f.config, f.engine, null, env)!;
    expect(resolved).not.toBeNull();
    const options = { ...resolved.options, chat };
    const real = new DigestWorker({ db: f.db, config: { memoryDir: f.memoryDir, ledgerRelPath: f.config.ledgerRelPath }, options, provider: f.provider, log: () => undefined });
    workers.push(real);
    await real.sweepNow();
    return { digests: { options, worker: real }, chat };
  }

  it('off by default: nothing is resolved, and search_memory answers with no digest hit', async () => {
    const f = await fixture();
    expect(digestsEnabled({})).toBe(false);
    expect(resolveEngineDigests(f.db, f.config, f.engine, null, {})).toBeNull();
    await save(f, 'I bought a red bicycle yesterday.');
    const body = await engineSearchMemory(f.db, f.engine, f.memoryDir, 'red bicycle', 8, undefined, undefined, false, f.config.ledgerRelPath);
    expect(body.ok).toBe(true);
    expect((body.hits as Array<{ reason: string }>).some(hit => hit.reason === 'digest')).toBe(false);
  });

  it('on: a digest table leads the hits, from stored digests, with no model call at search time', async () => {
    const f = await fixture();
    await save(f, 'I bought a red bicycle yesterday.');
    await save(f, 'I adopted a dog named Biscuit.');
    const { digests, chat } = await ready(f);
    const callsBefore = chat.calls.length;
    const body = await engineSearchMemory(f.db, f.engine, f.memoryDir, 'bicycle', 8, undefined, undefined, false, f.config.ledgerRelPath, undefined, digests);
    expect(chat.calls).toHaveLength(callsBefore);
    const hits = body.hits as Array<{ reason: string; notePath: string; text: string }>;
    // The path a client is shown: a synthetic hit has no note, so it is its basename, as the evidence table's is.
    expect(hits[0]).toMatchObject({ reason: 'digest', notePath: 'digest' });
    expect(hits[0].text).toContain('bicycle');
    expect(hits.filter(hit => hit.reason === 'digest')).toHaveLength(1);
  });

  it('a scoped read sees only the digests of its own scope', async () => {
    const f = await fixture();
    await save(f, 'I bought a red bicycle for the alpha project.', 'project:alpha');
    await save(f, 'I bought a secret submarine for the beta project.', 'project:beta');
    const { digests } = await ready(f);
    const alpha = await engineSearchMemory(f.db, f.engine, f.memoryDir, 'what did I buy', 8, 'project:alpha', undefined, false, f.config.ledgerRelPath, undefined, digests);
    const text = JSON.stringify(alpha.hits);
    expect(text).toContain('bicycle');
    expect(text).not.toContain('submarine');
    const beta = await engineSearchMemory(f.db, f.engine, f.memoryDir, 'what did I buy', 8, 'project:beta', undefined, false, f.config.ledgerRelPath, undefined, digests);
    expect(JSON.stringify(beta.hits)).not.toContain('bicycle');
  });
});

describe('the setting', () => {
  it('one switch turns it on or off, a typo is refused, and the guard values are checked', () => {
    expect(digestsEnabled({ RENOR_DIGESTS: 'on' })).toBe(true);
    expect(digestsEnabled({ RENOR_DIGESTS: 'off' })).toBe(false);
    expect(() => digestsEnabled({ RENOR_DIGESTS: 'yes please' })).toThrow(/Invalid RENOR_DIGESTS/);
    const config = { dbPath: '/tmp/x/index.db' };
    expect(resolveDigestOptions(config, { RENOR_DIGESTS: '1' })).toMatchObject({ maxUsdPerDay: 0.5, priceInPerM: 0.225, priceOutPerM: 0.75 });
    expect(resolveDigestOptions(config, { RENOR_DIGESTS: '1', RENOR_DIGEST_MAX_USD_PER_DAY: '2' })).toMatchObject({ maxUsdPerDay: 2 });
    for (const bad of ['0', '-1', 'free']) {
      expect(() => resolveDigestOptions(config, { RENOR_DIGESTS: '1', RENOR_DIGEST_MAX_USD_PER_DAY: bad })).toThrow(/RENOR_DIGEST_MAX_USD_PER_DAY/);
    }
  });
});
