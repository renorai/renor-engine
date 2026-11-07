import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from '../db/sqlite';
import type { EmbedOptions, EmbeddingIdentity, EmbeddingProvider } from './types';
import { noteQueryCache } from '../callPhases';

/**
 * Content-addressed embedding cache around another provider.
 *
 * Key = sha256(namespace + task-type + dimensions + text). The namespace is
 * 'kind/model/dims': the provider and model that produce the vectors, taken from
 * the provider's own `identity` (a caller may state one for a provider that cannot
 * declare it, and it must agree with a declared one), plus the provider's own
 * dimensions. No caller types a label, so two models can only share an entry by
 * declaring the same provider and model, and a namespace can never claim
 * dimensions the provider does not have. The same text under a different task type
 * (RETRIEVAL_QUERY vs RETRIEVAL_DOCUMENT) is cached separately, matching the
 * upstream API's semantics.
 *
 * Purpose: benchmark iteration. Re-running the same dataset must not re-pay
 * the embedding cost. A cache hit must return the exact vector the provider
 * produced, so runs stay byte-identical to an uncached run with the same
 * model.
 *
 * The same class serves the engine's hosted read path, where the cache must only ever help:
 *  - `maxEntries` / `maxBytes` bound the file (oldest-inserted rows are evicted first);
 *  - `serving` caches queries only and lets no cache fault fail or slow a call. It stores the
 *    numbers as the provider gave them (float64, not the benchmark cache's float32), so a repeated
 *    query gets bit for bit the vector the first one did and retrieval cannot tell a hit from a miss.
 * Neither is set for the benchmark callers, which keep their unbounded cache.
 */

export interface CacheStats {
  hits: number;
  misses: number;
}

/**
 * What actually reached the wrapped provider. Unlike lookup misses, which count every input
 * occurrence, a text repeated within a batch is sent once, and a batch that is entirely cached
 * sends nothing. `calls` are invocations of the provider (an embed batch, or a query); a
 * provider may split one invocation into several requests of its own.
 */
export interface SentStats {
  texts: number;
  calls: number;
}

/** What an embedding provider wrapper reports to the cache report. */
export interface EmbeddingCallStats extends CacheStats {
  /** False when no cache stood in front of the provider: every lookup was a live call. */
  cached: boolean;
  sent: SentStats;
}

const IDENTITY_KIND = /^[\w.-]{1,32}$/;
const IDENTITY_MODEL = /^[\w./:-]{1,80}$/;

function resolveIdentity(inner: EmbeddingProvider, stated: EmbeddingIdentity | undefined): EmbeddingIdentity {
  const declared = inner.identity;
  const identity = stated ?? declared;
  if (!identity) throw new Error('Embedding cache needs the identity of the provider and model: declare `identity` on the provider or pass options.identity');
  if (!IDENTITY_KIND.test(identity.kind) || !IDENTITY_MODEL.test(identity.model)) throw new Error('Invalid embedding identity');
  if (stated && declared && (stated.kind !== declared.kind || stated.model !== declared.model)) {
    throw new Error(`Embedding cache identity ${stated.kind}/${stated.model} contradicts the wrapped provider, which declares ${declared.kind}/${declared.model}`);
  }
  return identity;
}

const TASK_QUERY = 'RETRIEVAL_QUERY';
const TASK_DOCUMENT = 'RETRIEVAL_DOCUMENT';

export class CachingEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  readonly identity: EmbeddingIdentity;
  /** Lookups: one hit or miss per input occurrence. What the provider received is `sent`. */
  readonly stats: CacheStats = { hits: 0, misses: 0 };
  readonly sent: SentStats = { texts: 0, calls: 0 };
  private readonly inner: EmbeddingProvider & { embedQuery?(text: string, options?: EmbedOptions): Promise<number[]> };
  private readonly db: Database.Database;
  private readonly namespace: string;
  private readonly insert: Database.Statement;
  private readonly lookup: Database.Statement;
  private readonly oldest: Database.Statement;
  private readonly remove: Database.Statement;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly serving: boolean;
  /** Rows and vector bytes held, kept in step with the file so a write does not scan it. */
  private entries = 0;
  private bytes = 0;
  /** Serving mode only: set by the first cache fault, after which every call goes straight to the provider. */
  private disabled = false;

  constructor(inner: EmbeddingProvider, options: {
    cachePath: string;
    /** For a provider that cannot declare its own identity; it must agree with one that does. */
    identity?: EmbeddingIdentity;
    /**
     * Opt-in. Where the provider is served from, for what its identity (kind and model) does not say, such as the
     * project and location of a hosted endpoint; it joins the namespace, so a vector cached under another scope is
     * a miss. Unset (the benchmark callers): the namespace is unchanged.
     */
    scope?: string;
    /** Opt-in bound on the rows held (all namespaces). Past it, the oldest-inserted rows are evicted. Unset: unbounded. */
    maxEntries?: number;
    /** Opt-in bound on the vector bytes held (all namespaces), evicted the same way. Unset: unbounded. */
    maxBytes?: number;
    /**
     * The engine's read path. Queries are cached and documents are not (`embed` passes straight through); a cache
     * fault of any kind (cannot open, locked, read-only, corrupt) is swallowed and switches the cache off for the
     * process, so a call is never failed or slowed beyond what the bare provider costs; and vectors are stored as
     * float64, so a hit returns exactly the numbers the provider gave on the miss.
     */
    serving?: boolean;
  }) {
    if ('namespace' in options) {
      throw new Error('CachingEmbeddingProvider no longer takes a namespace: the identity of the provider and model pins the cache (declare `identity` on the provider, or pass options.identity)');
    }
    this.inner = inner as CachingEmbeddingProvider['inner'];
    this.dimensions = inner.dimensions;
    this.identity = resolveIdentity(inner, options.identity);
    if (options.scope !== undefined && !/^[\w.-]{1,32}$/.test(options.scope)) throw new Error('Invalid cache scope');
    this.namespace = `${this.identity.kind}/${this.identity.model}/${inner.dimensions}${options.scope ? `/${options.scope}` : ''}`;
    if (!/^[\w./:-]{4,120}$/.test(this.namespace)) throw new Error('Invalid cache namespace');
    for (const [name, limit] of [['maxEntries', options.maxEntries], ['maxBytes', options.maxBytes]] as const) {
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`${name} must be a positive integer`);
    }
    this.maxEntries = options.maxEntries ?? Infinity;
    this.maxBytes = options.maxBytes ?? Infinity;
    this.serving = options.serving === true;
    fs.mkdirSync(path.dirname(options.cachePath), { recursive: true });
    this.db = new Database(options.cachePath);
    try {
      this.db.pragma('journal_mode = WAL');
      // A serving read waits a moment for a lock, not ten seconds: past that the provider is the faster answer.
      this.db.pragma(`busy_timeout = ${this.serving ? 100 : 10000}`);
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS embeddings (
           key TEXT PRIMARY KEY,
           dims INTEGER NOT NULL,
           vec BLOB NOT NULL,
           namespace TEXT NOT NULL,
           created_at TEXT NOT NULL
         )`,
      );
      this.lookup = this.db.prepare('SELECT vec, dims FROM embeddings WHERE key = ? AND namespace = ?');
      this.insert = this.db.prepare('INSERT OR IGNORE INTO embeddings (key, dims, vec, namespace, created_at) VALUES (?, ?, ?, ?, ?)');
      // rowid is insertion order (nothing but the oldest row is ever deleted), so eviction is deterministic.
      this.oldest = this.db.prepare('SELECT rowid AS id, LENGTH(vec) AS n FROM embeddings ORDER BY rowid LIMIT 32');
      this.remove = this.db.prepare('DELETE FROM embeddings WHERE rowid = ?');
      if (this.bounded) {
        const held = this.db.prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(LENGTH(vec)), 0) AS bytes FROM embeddings').get() as { entries: number; bytes: number };
        this.entries = held.entries;
        this.bytes = held.bytes;
        this.evict();
      }
    } catch (err) {
      // A cache file that is not a database fails here; the caller then removes it and starts again (withQueryCache), and
      // Windows refuses to remove a file SQLite still holds open (EBUSY, #1563). Close it first, on every platform.
      this.db.close();
      throw err;
    }
  }

  private get bounded(): boolean {
    return this.maxEntries !== Infinity || this.maxBytes !== Infinity;
  }

  private evict(): void {
    while (this.entries > this.maxEntries || this.bytes > this.maxBytes) {
      const rows = this.oldest.all() as Array<{ id: number; n: number }>;
      if (rows.length === 0) { this.entries = 0; this.bytes = 0; return; }
      for (const row of rows) {
        if (this.entries <= this.maxEntries && this.bytes <= this.maxBytes) return;
        this.remove.run(row.id);
        this.entries -= 1;
        this.bytes -= row.n;
      }
    }
  }

  /** Serving mode: a cache fault ends the cache for this process and the call carries on without it. */
  private guard<T>(work: () => T, fallback: T): T {
    if (!this.serving) return work();
    if (this.disabled) return fallback;
    try {
      return work();
    } catch {
      this.disabled = true;
      try { this.db.close(); } catch { /* already unusable */ }
      return fallback;
    }
  }

  private key(text: string, taskType: string): string {
    // A serving entry holds float64, a benchmark entry float32: they never share a key.
    return crypto.createHash('sha256')
      .update(`${this.namespace}\0${taskType}\0${this.dimensions}\0${text}${this.serving ? '\0f64' : ''}`)
      .digest('hex');
  }

  private read(text: string, taskType: string): number[] | null {
    const row = this.lookup.get(this.key(text, taskType), this.namespace) as { vec: Buffer; dims: number } | undefined;
    if (!row) return null;
    if (row.dims !== this.dimensions) return null; // impossible unless the store was corrupted
    const width = this.serving ? 8 : 4;
    if (row.vec.byteLength !== this.dimensions * width) return null;
    // Copied out first: a Buffer from the driver is not guaranteed to start on an aligned boundary.
    const bytes = row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength);
    return Array.from(this.serving ? new Float64Array(bytes) : new Float32Array(bytes));
  }

  private write(text: string, taskType: string, vector: number[]): void {
    if (vector.length !== this.dimensions) throw new Error('Cached vector has wrong dimensionality');
    const buf = Buffer.from((this.serving ? new Float64Array(vector) : new Float32Array(vector)).buffer);
    const { changes } = this.insert.run(this.key(text, taskType), this.dimensions, buf, this.namespace, new Date().toISOString());
    if (changes > 0 && this.bounded) {
      this.entries += 1;
      this.bytes += buf.length;
      this.evict();
    }
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.serving) return this.inner.embed(texts, options); // documents are not cached on the read path
    const out: number[][] = [];
    const misses = new Map<string, number[]>();
    texts.forEach((text, index) => {
      const cached = this.read(text, TASK_DOCUMENT);
      if (cached) { this.stats.hits += 1; out[index] = cached; }
      else {
        this.stats.misses += 1;
        const indexes = misses.get(text);
        if (indexes) indexes.push(index);
        else misses.set(text, [index]);
      }
    });
    if (misses.size > 0) {
      const uniqueTexts = [...misses.keys()];
      this.sent.calls += 1;
      this.sent.texts += uniqueTexts.length;
      const fresh = await this.inner.embed(uniqueTexts, options);
      if (fresh.length !== uniqueTexts.length) throw new Error('Inner provider returned wrong vector count');
      uniqueTexts.forEach((text, i) => {
        this.write(text, TASK_DOCUMENT, fresh[i]);
        for (const index of misses.get(text)!) out[index] = fresh[i];
      });
    }
    return out;
  }

  async embedQuery(text: string, options?: EmbedOptions): Promise<number[]> {
    const cached = this.guard(() => this.read(text, TASK_QUERY), null);
    if (cached) { this.stats.hits += 1; noteQueryCache(true); return cached; }
    this.stats.misses += 1;
    noteQueryCache(false);
    this.sent.calls += 1;
    this.sent.texts += 1;
    // Providers without a query task type (OpenAI-compatible, hash) are queried
    // through embed(), exactly as retrieval/semantic.ts does when uncached.
    const vector = this.inner.embedQuery
      ? await this.inner.embedQuery(text, options)
      : (await this.inner.embed([text], options))[0];
    if (!this.serving) this.write(text, TASK_QUERY, vector);
    else this.guard(() => this.write(text, TASK_QUERY, vector), undefined);
    return vector;
  }

  get callStats(): EmbeddingCallStats {
    return { hits: this.stats.hits, misses: this.stats.misses, cached: true, sent: { ...this.sent } };
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  describe(): Record<string, unknown> {
    const inner = (this.inner as { describe?: () => Record<string, unknown> }).describe?.() ?? {};
    return { ...inner, cache: { namespace: this.namespace, hits: this.stats.hits, misses: this.stats.misses } };
  }
}

/**
 * Stands in for the cache when it is off, so the texts a run sends to its provider are
 * still counted: an uncached run must not be reported as free.
 */
export class CountingEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  readonly identity?: EmbeddingIdentity;
  readonly sent: SentStats = { texts: 0, calls: 0 };
  private readonly inner: EmbeddingProvider;

  constructor(inner: EmbeddingProvider) {
    this.inner = inner;
    this.dimensions = inner.dimensions;
    this.identity = inner.identity;
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    // An empty batch is no provider call, exactly as in CachingEmbeddingProvider.embed: the counter and the real
    // call boundary agree (every shipped provider already returns [] for it without a request).
    if (texts.length === 0) return [];
    this.sent.calls += 1;
    this.sent.texts += texts.length;
    return this.inner.embed(texts, options);
  }

  async embedQuery(text: string, options?: EmbedOptions): Promise<number[]> {
    this.sent.calls += 1;
    this.sent.texts += 1;
    // Providers without a query task type are queried through embed(), exactly as retrieval/semantic.ts does.
    return this.inner.embedQuery ? this.inner.embedQuery(text, options) : (await this.inner.embed([text], options))[0];
  }

  /** Nothing is looked up, so every text sent is a miss and none is a hit. */
  get callStats(): EmbeddingCallStats {
    return { hits: 0, misses: this.sent.texts, cached: false, sent: { ...this.sent } };
  }
}

/** A run's embedding figures for the cache report: cache counters, or the count of texts sent when no cache stood in front. */
export function embeddingCallStats(provider: EmbeddingProvider): EmbeddingCallStats | undefined {
  return provider instanceof CachingEmbeddingProvider || provider instanceof CountingEmbeddingProvider ? provider.callStats : undefined;
}

/** Resolve the cache setting from the environment. Returns null when disabled. */
export function resolveEmbeddingCachePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.RENOR_EVAL_EMBED_CACHE;
  if (raw === 'off' || raw === '0') return null;
  if (!raw || raw === 'on') {
    return path.join(process.env.HOME ?? '.', '.local', 'share', 'renor', 'embed-cache.db');
  }
  return path.resolve(raw);
}

/** Cached row count per namespace (a missing DB is an empty cache). */
export function describeEmbeddingCache(cachePath: string): Array<{ namespace: string; rows: number }> {
  if (!fs.existsSync(cachePath)) return [];
  const db = new Database(cachePath, { readonly: true });
  try {
    return db.prepare('SELECT namespace, COUNT(*) AS rows FROM embeddings GROUP BY namespace ORDER BY namespace').all() as Array<{ namespace: string; rows: number }>;
  } finally {
    db.close();
  }
}

/**
 * Invalidate cached vectors by namespace (kind/model/dims), or everything with
 * an explicit `all`. An empty filter is refused so a typo never wipes a paid cache.
 */
export function invalidateEmbeddingCache(cachePath: string, filter: { namespace?: string; all?: boolean }): number {
  if (!filter.namespace && !filter.all) throw new Error('invalidateEmbeddingCache: pass a namespace or all: true');
  if (!fs.existsSync(cachePath)) return 0;
  const db = new Database(cachePath);
  try {
    db.pragma('busy_timeout = 10000');
    return filter.namespace
      ? db.prepare('DELETE FROM embeddings WHERE namespace = ?').run(filter.namespace).changes
      : db.prepare('DELETE FROM embeddings').run().changes;
  } finally {
    db.close();
  }
}

/** Read existing benchmark Vertex vectors without creating a cache or supplying an upstream. */
export class CacheOnlyVertex implements EmbeddingProvider {
  readonly dimensions = 768;
  readonly identity = { kind: 'vertex', model: 'gemini-embedding-001' };
  readonly stats = { hits: 0, misses: 0, upstreamTexts: 0 };
  private readonly db: Database.Database;
  constructor(file: string) { this.db = new Database(file, { readonly: true, fileMustExist: true }); }
  private read(text: string, task: string): number[] {
    const namespace = 'vertex/gemini-embedding-001/768';
    const key = crypto.createHash('sha256').update(`${namespace}\0${task}\0${this.dimensions}\0${text}`).digest('hex');
    const row = this.db.prepare('SELECT vec, dims FROM embeddings WHERE key = ? AND namespace = ?').get(key, namespace) as { vec: Buffer; dims: number } | undefined;
    if (!row || row.dims !== 768 || row.vec.length !== 768 * 4) {
      this.stats.misses++;
      throw new Error(`cache-only Vertex miss: task=${task} textSHA256=${crypto.createHash('sha256').update(text).digest('hex')}`);
    }
    this.stats.hits++;
    const bytes = row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength);
    return Array.from(new Float32Array(bytes));
  }
  async embed(texts: string[]): Promise<number[][]> { return texts.map(text => this.read(text, 'RETRIEVAL_DOCUMENT')); }
  async embedQuery(text: string): Promise<number[]> { return this.read(text, 'RETRIEVAL_QUERY'); }
  close(): void { this.db.close(); }
}

/**
 * Writes the cache rows whose key is in `keys` to `outFile`, in the cache's own table, so one batch's rows can be copied off
 * a machine on their own (scripts/eval/gcp/durable-batches.sh). By key, not by insertion order: a batch rerun after a crash
 * finds its rows already cached and still exports all of them, never an empty file. Written to a temporary file and renamed,
 * so a crash leaves the previous `outFile` whole. Returns how many rows.
 */
export function exportRowsByKey(cachePath: string, keys: readonly string[], outFile: string): number {
  const tmp = `${outFile}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  const db = new Database(tmp);
  let copied = 0;
  try {
    db.exec(
      `CREATE TABLE embeddings (
         key TEXT PRIMARY KEY,
         dims INTEGER NOT NULL,
         vec BLOB NOT NULL,
         namespace TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
    );
    if (fs.existsSync(cachePath) && keys.length > 0) {
      db.prepare('ATTACH DATABASE ? AS src').run(cachePath);
      const insert = db.prepare(
        'INSERT OR IGNORE INTO embeddings (key, dims, vec, namespace, created_at) SELECT key, dims, vec, namespace, created_at FROM src.embeddings WHERE key = ?',
      );
      db.transaction(() => {
        for (const key of keys) copied += insert.run(key).changes;
      })();
      db.exec('DETACH DATABASE src');
    }
  } finally {
    db.close();
  }
  fs.renameSync(tmp, outFile);
  return copied;
}
