import { closedLedgerEvents, resolveLedgerHits } from '../retrieval/ledgerLiveness';
import { isBlankOrInvisible } from '../memory/invisibleText';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import Database from '../db/sqlite';
import { readUntilWrite } from '../db/readCache';
import { prepareOnce } from '../db/statements';
import { VectorIndex, markVectorsUnfinished } from '../embeddings/vectorIndex';
import { embeddingSpace } from '../embeddings/space';
import { rebuildEmbeddings, embedMissingVectors, chunksWithoutVectors, sleep, type RebuildOptions } from '../embeddings/rebuild';
import { OpenAIEmbeddingProvider } from '../embeddings/openai';
import { LocalEmbeddingProvider } from '../embeddings/local';
import { VertexEmbeddingProvider } from '../embeddings/vertex';
import { poolFetch } from '../net/poolFetch';
import { recordPhase } from '../callPhases';
import { CachingEmbeddingProvider } from '../embeddings/caching';
import { InteractiveEmbeddingProvider } from '../embeddings/interactive';
import { CoalescingEmbeddingProvider } from '../embeddings/coalescing';
import { conversationNoteMatcher } from '../retrieval/readerLayout';
import { retrieveContext, createNoteDater, createNoteTimeBound, type HitOrder } from '../retrieval/orchestrator';
import { createLedgerEventClock } from '../retrieval/ledgerEventTime';
import type { ChunkScope, RetrievalProbe } from '../retrieval/semantic';
import { entityScopeFilter, liveEntityFilter, lookupEntity } from '../retrieval/entityLookup';
import { appendDailyEntry, entryClock } from '../memory/writer';
import { appendedEntryId } from '../memorymap/memoryMap';
import { indexFile, indexVault, NoteTooLargeError } from '../indexer/pipeline';
import { statVaultFiles, vaultIgnores, walkVaultStats, type VaultFileStat } from '../indexer/walker';
import { quoteFtsQuery, shownPage } from '../retrieval/queryHelpers';
import { keywordSearch } from '../retrieval/keyword';
import { selectNoteIdentityHits, NOTE_IDENTITY_EXTRA } from '../retrieval/noteIdentity';
import { isLedgerPreamble, keywordLedgerHits, ledgerNoteMatcher, presentLedgerEvents, type LedgerRecordCache } from '../retrieval/ledgerPresentation';
import type { EmbeddingProvider } from '../embeddings/types';
import type { MvpConfig } from './config';
import { dailyDirForScope, normalizeScope } from './scope';
import { DEFAULT_LEDGER_REL, resolveLedgerPath, scopeFilterFor } from '../memory/lifecycle';
import { countEntities, countInventory, type InventoryVault } from '../memory/inventory';
import { createReadScope } from './readScope';
import {
  attachSearchEvidence,
  prependEvidenceHit,
  productEvidenceReport,
  searchEvidenceEnabled,
  type ProductEvidenceAttachment,
} from '../evidence/attach';
import { createEvidenceExtractor, resolveEvidenceToolOptions, type EvidenceToolOptions } from '../evidence/options';
import { resolveEvidenceBackground } from '../evidence/background';
import { observeEnabled, searchObservations } from './observations';
import type { IdleMonitor } from './idle';
import type { EvidenceExtractor } from '../evidence/secondPass';
import { embeddingModelKey } from './contextRelevance';
import { sanitizeErrorMessage } from './sanitize';
import { digestItemsToHit, digestTable, leadingSummaryHits, resolveDigestOptions, type DigestOptions } from '../digests/digests';
import { DigestWorker } from '../digests/worker';
import { createLogger } from './log';

const log = createLogger('engine');

export interface Engine {
  provider: EmbeddingProvider | null;
  vectorIndex: VectorIndex | null;
  dims: number | null;
  /**
   * `<provider>:<model>:<dims>` of the embeddings in use, which is what the relevance bar is calibrated per
   * (`CALIBRATED_BARS`). Absent only when an injected provider declares no identity: it names no model, so no
   * bar can be resolved for it and the signal stays silent.
   */
  modelKey?: string;
  /**
   * What an agent's call may wait on the embedding service (see `resolveEmbedBudgets`); absent when it may wait as long
   * as the provider's retries take. Not about the provider's own speed: a call that cannot be answered in time is
   * answered without it, and what it could not embed is embedded later.
   */
  embedBudgets?: EmbedBudgets;
}

/**
 * How long an agent's call waits on the embedding service before it answers without it.
 *
 * `writeMs` is per request of 32 texts, for a save's index pass. A request to Vertex takes about a second for a full
 * batch of 32 texts, and a save embeds one to a few chunks, so a healthy service answers it well inside a second; 5 s is
 * five times that, long enough that a slow-but-working service is still waited for and short enough that an agent
 * is not made to wait on one that is not. `readMs` is for the one query a read embeds: 3 s, because a read has a keyword
 * fallback that answers well, and the agent is waiting on the whole reply, not only on this. While the service is
 * failing, only the first call of each cooldown pays these; the rest are told at once (InteractiveEmbeddingProvider).
 */
export interface EmbedBudgets {
  writeMs: number;
  readMs: number;
}

export const DEFAULT_EMBED_BUDGETS: EmbedBudgets = { writeMs: 5_000, readMs: 3_000 };

/**
 * `RENOR_EMBED_WRITE_BUDGET_MS` and `RENOR_EMBED_READ_BUDGET_MS` set the two budgets; `0` for either (or both) lets
 * that kind of call wait as long as the provider's retries take, which is what every call did before they existed.
 */
export function resolveEmbedBudgets(env: NodeJS.ProcessEnv = process.env): EmbedBudgets | undefined {
  const read = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || (value > 0 && value < 100) || value > 600_000) {
      throw new Error(`${name} must be 0 (no limit) or a number of milliseconds between 100 and 600000`);
    }
    return value;
  };
  const writeMs = read('RENOR_EMBED_WRITE_BUDGET_MS', DEFAULT_EMBED_BUDGETS.writeMs);
  const readMs = read('RENOR_EMBED_READ_BUDGET_MS', DEFAULT_EMBED_BUDGETS.readMs);
  return writeMs === 0 && readMs === 0 ? undefined : { writeMs: writeMs || Infinity, readMs: readMs || Infinity };
}

/** `provider` as one call that has a budget sees it: every call it makes ends within `budgetMs` (see EmbedOptions). */
function withBudget(provider: EmbeddingProvider, budgetMs: number | undefined): EmbeddingProvider {
  if (budgetMs === undefined || !Number.isFinite(budgetMs)) return provider;
  return {
    dimensions: provider.dimensions,
    identity: provider.identity,
    embed: texts => provider.embed(texts, { budgetMs }),
    embedQuery: text => provider.embedQuery ? provider.embedQuery(text, { budgetMs }) : provider.embed([text], { budgetMs }).then(vectors => vectors[0]),
  };
}

/** sqlite-vec table dimension, or null if the table does not exist. */
export function readEmbeddingTableDims(db: Database.Database): number | null {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_embeddings'`
  ).get() as { sql: string } | undefined;
  if (!row?.sql) return null;
  const m = row.sql.match(/FLOAT\[(\d+)\]/i);
  return m ? Number(m[1]) : null;
}

/**
 * Where a workspace keeps the vectors of the queries it has embedded: its own private state directory, the one
 * that holds the OAuth client registry (`MVP_AUTH_STATE_PATH`), which config validation keeps out of the memory
 * and history trees. So export, import and memory_status never see it, and it is one file per workspace.
 */
export function queryEmbeddingCachePath(config: Pick<MvpConfig, 'authStatePath'>): string {
  return path.join(path.dirname(config.authStatePath), 'query-embeddings.db');
}

/** Rows and vector bytes the read-path cache may hold: a few thousand distinct queries (3 KiB each at 768 dims). */
export const QUERY_CACHE_MAX_ENTRIES = 4096;
export const QUERY_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The vector of a query already asked costs no second provider call. It is a cache: if it cannot be opened, the
 * file is derived and is removed once and started again, and if it still cannot be opened the provider is
 * returned as it is.
 */
function withQueryCache(provider: EmbeddingProvider, config: MvpConfig, scope: string): EmbeddingProvider {
  const cachePath = queryEmbeddingCachePath(config);
  const open = () => new CachingEmbeddingProvider(provider, {
    cachePath,
    serving: true,
    scope,
    maxEntries: QUERY_CACHE_MAX_ENTRIES,
    maxBytes: QUERY_CACHE_MAX_BYTES,
  });
  try {
    return open();
  } catch {
    try {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(cachePath + suffix, { force: true });
      return open();
    } catch {
      return provider;
    }
  }
}

export function createEmbeddingProvider(
  config: MvpConfig,
  /** A test points the Vertex endpoint at a local stub and shortens its retry waits; production passes nothing. */
  vertexSeam?: Pick<NonNullable<ConstructorParameters<typeof VertexEmbeddingProvider>[0]>, 'baseUrl' | 'retry'>,
  /**
   * The service keeps its connection to the embedding service across the pauses between two reads, up to three minutes
   * (src/net/poolFetch.ts). A bench or a command that builds the stack for one run leaves it off: it makes its requests
   * back to back and gains nothing from a pool that would outlive it, and it keeps the plain `fetch` it was measured with.
   */
  pooled = false,
): EmbeddingProvider | null {
  if (config.embeddingProvider === 'none') return null;
  if (config.embeddingProvider === 'local') {
    return new LocalEmbeddingProvider(config.embeddingModel);
  }
  if (config.embeddingProvider === 'vertex') {
    // The provider's identity is its kind and model; the project and location it is served from are not in it. The
    // endpoint has no setting of its own (it is built from the location), so these two name it.
    const served = crypto.createHash('sha256').update(`${config.vertexProject ?? ''}\0${config.vertexLocation ?? ''}`).digest('hex').slice(0, 12);
    // The query cache is outermost: a query already asked is answered from it with the service down, and only a query
    // that must go to the service meets the interactive budget and the failure memory in front of it.
    // Document embeddings from concurrent index passes share requests (coalescing.ts): below the budget, so each caller's
    // budget still ends its own call, and above the service, so a request holds at most the usual four in flight.
    const vertex = new VertexEmbeddingProvider({
      keyFile: config.vertexKeyFile,
      project: config.vertexProject,
      location: config.vertexLocation,
      model: config.embeddingModel,
      dimensions: config.embeddingDims,
      ...vertexSeam,
      // An embedding is a pure function of its text, so a request whose idle connection the service closed meanwhile is sent again.
      // A connection it has to open for a read is told to that read's log line (callPhases.ts `connect`).
      ...(pooled ? { request: poolFetch({ retryOnReset: true, onConnect: ms => recordPhase('connect', ms) }) } : {}),
    });
    // The engine's own process fetches its first access token when it starts, in the background, so the first call after a
    // start (or after an idle exit) does not wait on Google's token exchange (vertex.ts warmToken).
    if (pooled) vertex.warmToken();
    return withQueryCache(new InteractiveEmbeddingProvider(new CoalescingEmbeddingProvider(vertex)), config, `p-${served}`);
  }
  const keys = (config.embeddingApiKey ?? '').split(',').map(k => k.trim()).filter(Boolean);
  return new OpenAIEmbeddingProvider(
    keys,
    config.embeddingModel,
    config.embeddingBaseURL,
    config.embeddingDims,
  );
}

export function attachEngine(
  db: Database.Database,
  config: MvpConfig,
  override?: EmbeddingProvider | null,
): Engine {
  const provider = override === undefined ? createEmbeddingProvider(config, undefined, true) : override;
  if (!provider) {
    // What this process saves gets no vector: an index that has a model's vectors is marked unfinished first.
    if (markVectorsUnfinished(db)) {
      log.info('embeddings_unconfigured', { detail: 'no embedding provider is configured: what is saved now gets no vector, so the index is marked unfinished; the next start with its model embeds those chunks before semantic search reads the index again' });
    }
    return { provider: null, vectorIndex: null, dims: readEmbeddingTableDims(db) };
  }

  const existing = readEmbeddingTableDims(db);
  if (existing !== null && existing !== provider.dimensions) {
    throw new Error(
      `Embedding dimension mismatch: index.db chunk_embeddings is FLOAT[${existing}] but the configured provider is ${provider.dimensions}-d. `
      + `Do not mix Voyage/e5/other models in one book (ADR-0003). Set MVP_EMBEDDING_DIMS and MVP_EMBEDDING_MODEL to match the index, or use a separate MVP_DB_PATH.`,
    );
  }
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  claimEmbeddingSpace(db, vectorIndex, provider);
  // A raised RENOR_VECTOR_MIRROR_MIB: the copy is read after startup, and no reply waits for it (see warmMirror).
  vectorIndex.warmMirrorInBackground();
  const modelKey = override === undefined
    ? embeddingModelKey(config.embeddingProvider, config.embeddingModel, config.embeddingDims)
    : injectedModelKey(provider);
  const embedBudgets = resolveEmbedBudgets();
  return {
    provider,
    vectorIndex,
    dims: provider.dimensions,
    ...(modelKey ? { modelKey } : {}),
    ...(embedBudgets ? { embedBudgets } : {}),
  };
}

/**
 * The model key of an injected provider, from the identity it declares and the size it embeds at: exactly what the
 * configured path composes, so a caller that brings its own provider (a bench, a test, an in-process harness) keeps
 * the calibrated relevance bar its model has instead of losing the verdict altogether. An injected provider that
 * declares no identity names no model, so it has no bar: `undefined`, and the signal stays silent rather than
 * guessing (the eval-hash stub is exactly this case — lexical vectors, and nothing calibrated to compare them to).
 */
function injectedModelKey(provider: EmbeddingProvider): string | undefined {
  const identity = provider.identity;
  return identity ? embeddingModelKey(identity.kind, identity.model, provider.dimensions) : undefined;
}

/**
 * Dimensions alone cannot tell two embedding models apart, so the index records the space its vectors are in
 * (provider, model, dimensions). A new index takes the configured model's space. An index whose vectors are in
 * another space, or in none anyone can vouch for (it holds vectors and records none: it was built before spaces
 * were recorded), is not named and is not read: search would compare numbers from different models. It is rebuilt
 * instead (`engineRebuildEmbeddings`, which the service starts), and until that finishes semantic search is off
 * (`semanticReady`). An index that holds chunks and no vector at all was written without an embedding provider (a
 * workspace that searched by keyword until now): it is named and marked unfinished, so the same background job
 * embeds every one of its chunks, once, before semantic search reads it. A provider that declares no identity claims
 * nothing, and nothing is held back for it.
 */
function claimEmbeddingSpace(db: Database.Database, vectorIndex: VectorIndex, provider: EmbeddingProvider): void {
  const wanted = embeddingSpace(provider);
  if (!wanted) return;
  const stored = vectorIndex.space();
  if (stored === wanted) return;
  if (stored === null && !vectorIndex.hasVectors()) {
    const chunks = db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number;
    if (chunks === 0) {
      vectorIndex.setSpace(wanted); // a new index: nothing to embed, so it is whole
      return;
    }
    vectorIndex.beginRebuild(wanted); // there is no vector to clear: this names the index and marks it unfinished
    log.info('embeddings_backfill', { chunks, model: wanted, detail: 'index.db holds no vectors (it was written without an embedding provider): every chunk is embedded in the background; until then semantic search is off and keyword search keeps working' });
    return;
  }
  log.warn('embeddings_model_mismatch', {
    stored: stored ?? 'unrecorded',
    model: wanted,
    detail: 'search cannot use vectors from another model: a rebuild embeds every chunk again, and until it finishes semantic search is off and keyword search keeps working',
  });
}

/**
 * Whether a semantic search may read this engine's index: every vector in it is in the configured model's space and
 * none is still to come. An index in another space, in none anyone can vouch for, or part way through a rebuild is
 * not read: search would compare numbers from different models, or find only part of the index. A provider that
 * declares no identity makes no claim, so it is never held back.
 */
export function semanticReady(engine: Engine): boolean {
  if (!engine.provider || !engine.vectorIndex) return false;
  const wanted = embeddingSpace(engine.provider);
  if (!wanted) return true;
  return engine.vectorIndex.space() === wanted && !engine.vectorIndex.rebuilding();
}

/** What a caller is told while semantic search is off for a rebuild. */
function rebuildNotice(db: Database.Database, engine: Engine): string {
  const chunks = (db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number);
  const left = engine.vectorIndex!.space() === embeddingSpace(engine.provider!) ? chunksWithoutVectors(db) : chunks;
  return `Semantic search is off while this workspace's embeddings are built with the configured model (${left} of ${chunks} chunks left). Keyword search works meanwhile.`;
}

/** Why something failed, on one line a client may be shown (host paths redacted). */
function failureReason(err: unknown, max: number): string {
  return sanitizeErrorMessage(err).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The last search by meaning that failed, per engine, until one succeeds: memory_status reports it, so a workspace whose
 * embedding service stopped answering is not reported healthy (it makes no embeddings call of its own).
 */
const semanticFailures = new WeakMap<Engine, { at: string; reason: string }>();

/** Whether keyword search can run: its index table exists. A damaged or half-migrated index file has none. */
export function keywordIndexReady(db: Database.Database): boolean {
  return prepareOnce(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'`).get() !== undefined;
}

/** What a caller is told when a search by meaning failed: why, and what still answers. */
function semanticFailureNotice(err: unknown): string {
  return `Semantic search is unavailable right now (${failureReason(err, 200)}), so nothing here was found by meaning; `
    + 'the saved facts and keyword search do not need it and still answer. The next request tries semantic search again.';
}

export interface EmbeddingRebuild {
  /** Settles when the index is whole or the rebuild was aborted; it never rejects. */
  done: Promise<void>;
  /** Stop between requests. The index stays unfinished and a later `engineRebuildEmbeddings` resumes it. */
  abort(): void;
  /** True while it only waits out a delay before its next attempt: nothing is being written, and a restart resumes it. */
  waiting(): boolean;
}

const embeddingRebuilds = new WeakMap<VectorIndex, EmbeddingRebuild>();

/**
 * Rebuild, in the background, every vector this engine's index holds with the configured model, when its index is
 * not whole in that model's space (see `semanticReady`), and record the space once it is. The clearing and naming
 * happen before this returns; the embedding happens after, a batch at a time. The index is whole only when every
 * chunk has a vector. A provider that is down, or a chunk it will not embed, interrupts the rebuild; it is resumed
 * after a wait that grows (30 s, doubling, up to 5 min), semantic search stays off, and the log says how many chunks
 * are left and which one was refused. So it ends only when the index is whole or `abort` is called. Returns null
 * when there is nothing to do; a rebuild already running for this index is returned rather than started twice.
 */
export function engineRebuildEmbeddings(
  db: Database.Database,
  engine: Engine,
  options: RebuildOptions & { outageDelayMs?: (outage: number) => number } = {},
): EmbeddingRebuild | null {
  const { provider, vectorIndex } = engine;
  if (!provider || !vectorIndex) return null;
  const space = embeddingSpace(provider);
  if (!space || semanticReady(engine)) return null;
  const running = embeddingRebuilds.get(vectorIndex);
  if (running) return running;

  const { outageDelayMs = (outage: number) => Math.min(300_000, 30_000 * 2 ** outage), ...rebuildOptions } = options;
  const controller = new AbortController();
  const startedAt = Date.now();
  let waiting = false;
  const wait = async (ms: number): Promise<void> => {
    waiting = true;
    try { await sleep(ms, controller.signal); } finally { waiting = false; }
  };
  const run = async (): Promise<void> => {
    const chunks = () => db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number;
    log.info('embedding_rebuild_started', { chunks: chunks(), model: space, detail: 'semantic search is off until it finishes' });
    for (let outage = 0; !controller.signal.aborted; outage++) {
      try {
        const result = await rebuildEmbeddings(db, vectorIndex, provider, space, { ...rebuildOptions, signal: controller.signal });
        if (result.done) {
          log.info('embedding_rebuild_finished', { ms: Date.now() - startedAt, detail: 'semantic search is on' });
          return;
        }
      } catch (err) {
        const delay = outageDelayMs(outage);
        log.error('embedding_rebuild_interrupted', { unembedded: chunksWithoutVectors(db), chunks: chunks(), retryInS: Math.round(delay / 1000), detail: 'semantic search stays off' }, err);
        await wait(delay);
      }
    }
  };
  // The clearing and naming run now, in the synchronous start of the first call, so the index is never left
  // looking whole while it holds another model's vectors.
  const rebuild: EmbeddingRebuild = {
    abort: () => controller.abort(),
    waiting: () => waiting,
    done: run().catch((err) => log.error('embedding_rebuild_failed', {}, err)).finally(() => embeddingRebuilds.delete(vectorIndex)),
  };
  embeddingRebuilds.set(vectorIndex, rebuild);
  return rebuild;
}

/** The rebuild `engineRebuildEmbeddings` started for this engine's index that has not ended yet, or null; starts none. */
export function runningEmbeddingRebuild(engine: Engine): EmbeddingRebuild | null {
  return (engine.vectorIndex && embeddingRebuilds.get(engine.vectorIndex)) ?? null;
}

/** A search shows the path of every hit it judges, and the notes it finds are the same ones read after read. */
const clientPaths = new Map<string, string>();
const MAX_CLIENT_PATHS = 4096;

export function clientPath(memoryDir: string, stored: string): string {
  // A relative path resolves against the working directory, so it is part of the key then, and only then (as in
  // path.resolve, which asks for it only when it has to).
  const key = path.isAbsolute(stored) && path.isAbsolute(memoryDir) ? `${memoryDir}\0${stored}` : `${process.cwd()}\0${memoryDir}\0${stored}`;
  let shown = clientPaths.get(key);
  if (shown === undefined) {
    const resolved = path.resolve(stored);
    const root = path.resolve(memoryDir);
    // A vault-relative path is shown with '/' on every platform: it is an id the client sends back and the form the tools
    // document, and on Windows path.relative separates with backslashes (#1563).
    shown = resolved === root || resolved.startsWith(root + path.sep) ? toSlashes(path.relative(root, resolved)) || stored : path.basename(stored);
    if (clientPaths.size >= MAX_CLIENT_PATHS) clientPaths.clear();
    clientPaths.set(key, shown);
  }
  return shown;
}

/** A native relative path with '/' separators (a no-op where '/' is the separator). */
function toSlashes(rel: string): string {
  return path.sep === '/' ? rel : rel.split(path.sep).join('/');
}

export function resolveEngineEvidence(
  config: Pick<MvpConfig, 'dbPath'>,
  env: NodeJS.ProcessEnv = process.env,
  idle: Pick<IdleMonitor, 'track'> | null = null,
): { options: EvidenceToolOptions; extractor: EvidenceExtractor | null } | undefined {
  if (!searchEvidenceEnabled(env)) return undefined;
  const options = resolveEvidenceToolOptions({ dbPath: config.dbPath }, env);
  // Bounded-wait evidence (RENOR_EVIDENCE_ASYNC, default off) is read here and nowhere else: a background extraction
  // needs a long-lived server to finish in, and the CLI, the benchmark's entry point, must always wait for its table.
  const background = resolveEvidenceBackground(env);
  if (background && idle) {
    background.hold = flight => {
      idle.track(() => flight).catch(() => undefined); // its failure is the flight's to report
    };
  }
  return { options: background ? { ...options, background } : options, extractor: createEvidenceExtractor(options) };
}

/**
 * Write-time digests on this workspace (RENOR_DIGESTS, off by default, so this is null unless the operator switched it on):
 * the options search reads them with, and the background worker that writes them after a save (src/digests/worker.ts).
 * Also null when the workspace has no embedding provider: a digest is read by meaning, so none is written.
 */
export interface EngineDigests {
  options: DigestOptions;
  worker: DigestWorker;
}

export function resolveEngineDigests(
  db: Database.Database,
  config: Pick<MvpConfig, 'dbPath' | 'memoryDir' | 'ledgerRelPath'>,
  engine: Engine,
  idle: Pick<IdleMonitor, 'track'> | null = null,
  env: NodeJS.ProcessEnv = process.env,
): EngineDigests | null {
  const options = resolveDigestOptions({ dbPath: config.dbPath }, env);
  if (!options) return null;
  if (!engine.provider) {
    log.info('digests_off', { detail: 'RENOR_DIGESTS is on, but this workspace has no embedding provider, so digests are off for it' });
    return null;
  }
  const worker = new DigestWorker({
    db,
    config: { memoryDir: config.memoryDir, ledgerRelPath: config.ledgerRelPath },
    options,
    provider: engine.provider,
    track: idle ? work => idle.track(work) : undefined,
  });
  log.info('digests_on', { model: options.model, maxUsdPerDay: options.maxUsdPerDay });
  return { options, worker };
}

/**
 * What search_memory answers on a workspace without semantic search. It searched nothing, and the error code
 * alone left the agent without a next step, so `note` names the search every workspace has.
 */
const SEMANTIC_UNAVAILABLE_NOTE =
  'This workspace has no semantic search, so nothing was searched by meaning. Use search_text instead: it matches exact words, so search one distinctive word (a name, a project, a term).';

function semanticUnavailable(): { ok: false; error: 'semantic-unavailable'; note: string; hits: [] } {
  return { ok: false, error: 'semantic-unavailable', note: SEMANTIC_UNAVAILABLE_NOTE, hits: [] };
}

function observationHits(db: Database.Database, workspace: string, query: string, limit: number, scope?: string): unknown[] {
  if (!observeEnabled() || isBlankOrInvisible(query) || !Number.isInteger(limit) || limit < 1) return [];
  try {
    const hits = searchObservations(db, workspace, query, Math.min(limit, 100), {}, scope);
    if (hits.length === 0) return [];
    return hits.filter(hit => {
      if (scope === undefined) return true;
      const raw = hit.cwd_scope;
      try { return normalizeScope(raw) === normalizeScope(scope); }
      catch { return false; }
    }).map(hit => ({
      notePath: hit.notePath,
      headingPath: hit.title,
      text: hit.text,
      score: hit.score,
      reason: hit.reason,
      source: hit.source,
      session_date: hit.session_date,
      id: hit.id,
    }));
  } catch {
    return [];
  }
}

function withObservationHits<T>(hits: T[], observations: unknown[], topK: number): Array<T | unknown> {
  if (observations.length === 0) return hits;
  const limit = Math.max(0, topK);
  if (hits.length === 0) return observations.slice(0, limit);
  // Keep the best explicit memory first, then give matching observations a small lane of their own. Appending before
  // cutting made that lane unreachable whenever ordinary memories filled the page. Keeping the lanes separate also
  // makes an explicit memory win score ties rather than letting transient observations displace it.
  const observationSlots = Math.min(2, observations.length, Math.max(0, limit - 1));
  return [...hits.slice(0, limit - observationSlots), ...observations.slice(0, observationSlots)];
}

export async function engineSearchMemory(
  db: Database.Database,
  engine: Engine,
  memoryDir: string,
  query: string,
  topK: number,
  scope?: string,
  evidence?: { options: EvidenceToolOptions; extractor: EvidenceExtractor | null },
  includeHistory = false,
  ledgerRelPath = DEFAULT_LEDGER_REL,
  /** Out-param for get_context: the query embedding and the best raw similarity among the returned (scoped, live) semantic hits. */
  probe?: RetrievalProbe,
  /** Write-time digests (RENOR_DIGESTS): when present, the digests of the window's notes lead the hits as one table. No model call. */
  digests?: EngineDigests | null,
  /** Per-read default: get_context passes 0; searches leave this unset for the default cap of 2. */
  noteCapWhenUnset?: number,
  /** Internal floor input: expose note similarities so the MCP search can filter its completed page. */
  showSimilarity = false,
  /** search_memory's reader layout (readerLayout.ts) needs each chunk's place in its note: the ids ride on the hits until it has used them. */
  withChunkIds = false,
  /** Original read scope before the caller normalizes an omitted scope to `global`. */
  observationScope = scope,
): Promise<{ ok: boolean; error?: string; notice?: string; rankedBy?: HitOrder; hits: unknown[]; scope?: string; evidence?: ProductEvidenceAttachment }> {
  // A query with no searchable characters can never truthfully match stored data. Refuse before
  // any embedding call (eval-hash or provider) so whitespace-only input yields no hits instead
  // of an arbitrary semantic match, matching search_history's blank-query handling.
  if (isBlankOrInvisible(query)) {
    return { ok: true, hits: [] };
  }
  const observed = () => observationHits(db, memoryDir, query, topK, observationScope);
  if (!engine.provider || !engine.vectorIndex) {
    return { ...semanticUnavailable(), hits: observed() };
  }
  // Never search a mixed or unfinished space: the caller falls back to keyword search and is told why.
  if (!semanticReady(engine)) {
    return { ok: false, error: 'semantic-rebuilding', notice: rebuildNotice(db, engine), hits: observed() };
  }
  const isLedger = ledgerNoteMatcher({ memoryDir, ledgerRelPath });
  // The query is embedded within the read budget: past it the search says so (below) and the caller answers from
  // the facts and keyword search, as it does for any failure of the provider.
  const provider = withBudget(engine.provider, engine.embedBudgets?.readMs);
  const vectorIndex = engine.vectorIndex;
  const asked: RetrievalProbe = probe ?? {};
  const scopeNorm = scopeFilterFor(scope);
  const inScope = scopeNorm ? createReadScope(db, scopeNorm) : null;
  // The scope is judged before the window is cut, so a scope whose memories rank below other scopes' still gets its
  // best ones (memory scout, finding 7: judged only after the cut, they were all gone); and again on what comes back.
  // Which chunks the scope holds is read from every chunk of the index (and the scope of every ledger event), so it is
  // read once and kept until something is written; reads that follow one another, as an agent's do, share it.
  const scoped: ChunkScope | undefined = inScope
    ? {
      shows: h => inScope.has(h, clientPath(memoryDir, h.notePath)),
      chunkIds: () => readUntilWrite(db, `scopedChunkIds\0${scopeNorm}\0${memoryDir}`, () => inScope.chunkIds(stored => clientPath(memoryDir, stored))),
    }
    : undefined;
  const search = () => retrieveContext(db, vectorIndex, provider, query, topK, [], {}, { includeHistory, isLedgerNote: isLedger, probe: asked, scope: scoped, noteCapWhenUnset });
  let result: Awaited<ReturnType<typeof search>>;
  try {
    result = await search();
    // What a save could not embed is embedded now, once the provider answers, and searched with the rest.
    if (await finishUnfinishedFiles(db, memoryDir, engine, provider, query, asked)) result = await search();
  } catch (err) {
    // Search by meaning failed: the embedding provider is down, or refuses the key or the quota (or the semantic lane
    // broke, which the log shows). The facts and keyword search do not need it, so a caller answers with those and
    // says why nothing was found by meaning, instead of failing whole.
    log.error('semantic_search_failed', {}, err);
    semanticFailures.set(engine, { at: new Date().toISOString(), reason: failureReason(err, 120) });
    return { ok: false, error: 'semantic-unavailable', notice: semanticFailureNotice(err), hits: observed() };
  }
  semanticFailures.delete(engine);
  // Scope must be enforced before any full-note hydration/evidence extraction.
  // Otherwise a scoped query could derive evidence from notes outside its scope
  // even if those ranked hits are filtered from the final response later.
  const scopedRetrievalHits = inScope
    ? inScope.hits(result.hits, h => clientPath(memoryDir, h.notePath))
    : result.hits;
  if (probe) {
    let top: (typeof scopedRetrievalHits)[number] | undefined;
    for (const h of scopedRetrievalHits) if (typeof h.similarity === 'number' && (top === undefined || h.similarity > top.similarity!)) top = h;
    probe.topSimilarity = top ? top.similarity! : null;
    // The same hit as the hits below show it: a ledger event as what it says (presentLedgerEvents judges each hit alone).
    const shown = top && presentLedgerEvents([top], isLedger)[0];
    probe.topHit = shown ? { notePath: clientPath(memoryDir, shown.notePath), headingPath: shown.headingPath, text: shown.text } : undefined;
    // Every returned semantic hit as the memories show it, with its raw cosine: a budget reads which of them are above the bar.
    probe.similarities = scopedRetrievalHits.flatMap(h => {
      const asShown = typeof h.similarity === 'number' ? presentLedgerEvents([h], isLedger)[0] : undefined;
      return asShown ? [{ notePath: clientPath(memoryDir, asShown.notePath), headingPath: asShown.headingPath, text: asShown.text, similarity: h.similarity! }] : [];
    });
  }
  const closedEvents = closedLedgerEvents(db);
  const noteDate = createNoteDater(db);
  // Without an evidence model no second pass runs, and nothing is said about one: on every search of such a workspace
  // (every hosted one) a report that nothing was missing told the agent nothing. With a model, every state is reported,
  // and so is the kill switch ("off").
  const attached = evidence?.extractor
    ? await attachSearchEvidence({
        // The ledger note holds every scope's events, so hydration drops other scopes' before closed ones.
        transformBody: text => resolveLedgerHits([{ text: inScope ? inScope.body(text) : text, reason: 'evidence-source' }], closedEvents, includeHistory)[0]?.text ?? '',
        query,
        // Evidence hydrates whole notes and prints one "Session dated" line above each: the note's date. A hit's own
        // date is its excerpt's, and one ledger event's would date every other event in the same body as well.
        hits: scopedRetrievalHits.map(h => ({ ...h, session_date: noteDate(h.notePath) })),
        vaultPath: memoryDir,
        options: evidence.options,
        extractor: evidence.extractor,
        enabled: true,
      })
    : evidence
      ? null
      : { hits: scopedRetrievalHits, evidence: { status: 'skipped' as const, reason: 'flag-off' as const } };
  const shown = presentLedgerEvents(scopedRetrievalHits, isLedger);
  // The evidence table, when there is one, leads the hits the agent is shown; they keep their own dates.
  let led = attached ? prependEvidenceHit(shown, attached.evidence) : shown;
  // The digest table follows it. Only notes of the window the scope already allowed are read, so a scoped read never sees
  // another scope's digests, and no model is called: it reads the digest cache and the query embedding the search made.
  if (digests) {
    try {
      const table = await digestTable({
        db, query, hits: scopedRetrievalHits, options: digests.options, provider, queryVector: asked.queryVector, isLedgerNote: isLedger,
      });
      if (table.items.length > 0) {
        const lead = leadingSummaryHits(led);
        led = [...led.slice(0, lead), digestItemsToHit(table.items), ...led.slice(lead)];
      }
    } catch (err) {
      // Optional augmentation: a fault here never fails the search.
      log.error('digests_read_failed', {}, err);
    }
  }
  const isConversation = withChunkIds ? conversationNoteMatcher(db) : () => false;
  const hits = led.map(h => ({
    notePath: clientPath(memoryDir, h.notePath),
    headingPath: h.headingPath,
    text: h.text,
    score: h.score,
    reason: h.reason,
    ...(h.session_date ? { session_date: h.session_date } : {}),
    // Only a conversation's chunks: the layout merges those and no others.
    ...(withChunkIds && 'chunkId' in h && typeof h.chunkId === 'number' && h.chunkId > 0 && isConversation(h.notePath) ? { chunkId: h.chunkId } : {}),
    // The author of a fact an identity question read: the reader's view marks it (mvp/factMarkers.ts).
    ...('author' in h && h.author !== undefined ? { author: h.author } : {}),
    // Raw cosine before boosts, rounded as in the checked floor arm. A ledger event is no note:
    // its chunk is event markup, and its cosine says little about what it holds (contextRelevance.ts).
    ...(showSimilarity && typeof h.similarity === 'number' && !isLedger(h.notePath) ? { similarity: Math.round(h.similarity * 1000) / 1000 } : {}),
  }));
  const withObservations = withObservationHits(hits, observed(), topK);
  return {
    ok: true,
    rankedBy: result.rankedBy,
    hits: withObservations,
    // Present whenever an evidence model is configured, and when the kill switch is off: `state` is how a caller tells
    // an intended "off" from a pass that failed or did not apply.
    ...(attached ? { evidence: productEvidenceReport(attached.evidence) } : {}),
    ...(scopeNorm ? { scope: scopeNorm } : {}),
  };
}

export function engineSearchText(db: Database.Database, memoryDir: string, query: string, topK: number, scope?: string, includeHistory = false, ledgerRelPath = DEFAULT_LEDGER_REL, ledgerRecords?: LedgerRecordCache, matchOverride?: string, stem = false, observationScope = scope) {
  const observed = () => observationHits(db, memoryDir, query, topK, observationScope);
  const fts = prepareOnce(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'`).get();
  if (!fts) {
    const found = observed();
    return found.length > 0 ? { ok: true, results: found } : { ok: false, error: 'fts-unavailable', results: [] as unknown[] };
  }
  // matchOverride (H11b): an FTS expression built by the caller (an OR over the question's content words); absent, the whole query as one phrase.
  const match = matchOverride ?? quoteFtsQuery(query);
  if (!match) return { ok: true, results: [] as unknown[] };
  const scopeNorm = scopeFilterFor(scope);
  const inScope = scopeNorm ? createReadScope(db, scopeNorm) : null;
  const isLedger = ledgerNoteMatcher({ memoryDir, ledgerRelPath });
  // A search may judge thousands of rows of one note (the ledger is one note), so each stored path is made the path a
  // client is shown once per search, not once per row.
  const shownPaths = new Map<string, string>();
  const shownPath = (stored: string): string => {
    let shown = shownPaths.get(stored);
    if (shown === undefined) shownPaths.set(stored, (shown = clientPath(memoryDir, stored)));
    return shown;
  };
  const toResult = (r: { notePath: string; headingPath: string; text: string; score: number; reason: string }) => ({
    notePath: shownPath(r.notePath),
    headingPath: r.headingPath,
    text: r.text,
    score: r.score,
    reason: r.reason,
  });
  const closedEvents = closedLedgerEvents(db);
  let prose: ReturnType<typeof toResult>[];
  try {
    // A row is shown when its event is live (liveness is resolved first), it is not the ledger's own markup, and the
    // scope read holds it. All three are judged before the page is cut, from a read that goes on until the page is full
    // or the index has no more rows: a closed event, a record of the ledger or another scope's row never takes a place
    // from a row that is shown, however many of them rank above it. The first read is the window of the best
    // `topK * 10` rows (at most 200) this search has always read.
    prose = shownPage(
      n => keywordSearch(db, match, n, stem),
      rows => {
        const live = keywordLedgerHits(resolveLedgerHits(
          rows.map(r => toResult({ ...r, score: Math.abs(r.score), reason: 'fts' })),
          closedEvents, includeHistory,
        ), isLedger, query, ledgerRecords);
        return inScope ? inScope.hits(live, r => r.notePath) : live;
      },
      topK,
      Math.min(topK * 10, 200),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const found = observed();
    return found.length > 0 ? { ok: true, results: found } : { ok: false, error: 'fts-query', detail: message.slice(0, 200), results: [] };
  }
  // Only the prose hits actually returned count as "already have"; scope is applied
  // before the identity limit.
  const have = new Set(prose.map(h => h.notePath));
  // The ledger is a note too (`ledger.md` names it), so its opening chunk obeys the same liveness and scope rules:
  // judged by the scope of the event it opens with, not by the ledger's path, and before the identity limit.
  const named = resolveLedgerHits(
    selectNoteIdentityHits(db, query, NOTE_IDENTITY_EXTRA, new Set(), (p, opening) => {
      const client = clientPath(memoryDir, p);
      return !have.has(client) && !isLedgerPreamble(opening, isLedger) && (!inScope || inScope.has(opening, client));
    }).map(toResult),
    closedEvents, includeHistory,
  );
  // An event is dated by when it was saved, as search_memory dates it: its time was in the record's heading alone, which
  // a client is not shown (ledgerPresentation.ts). Read from the stored record, before it is shown as the user's words,
  // which may hold a line that looks like a record's heading.
  const eventTime = createLedgerEventClock(db);
  const boundTime = createNoteTimeBound(db);
  const results = presentLedgerEvents([...prose, ...named].map(r => {
    const derived = isLedger(r.notePath) ? eventTime(r) : undefined;
    if (derived === undefined) return r;
    const session_date = boundTime(path.resolve(memoryDir, r.notePath), derived);
    return { ...r, session_date };
  }), isLedger, ledgerRecords);
  const withObservations = withObservationHits(results, observed(), topK);
  return {
    ok: true,
    results: withObservations,
    ...(scopeNorm ? { scope: scopeNorm } : {}),
  };
}

/**
 * What lookup_entity actually searches — all four mechanisms, in order, because
 * a narrower description would be a false contract: a term can resolve on a
 * substring of a canonical name or on a substring of a source note path, and
 * none of them see words inside note text.
 */
export const ENTITY_LOOKUP_SURFACE =
  'registered entities, matched in order by exact canonical name, frontmatter alias, substring of a canonical name, or substring of a source note path — never words inside note text';

export function engineLookupEntity(db: Database.Database, vault: InventoryVault, name: string, scope?: string) {
  const scopeNorm = scope === undefined ? undefined : normalizeScope(scope);
  // The scope constrains the SEARCH, not just the answer: the same restriction
  // narrows the candidate queries and the count, so a scoped lookup cannot
  // distinguish "no such entity" from "exists in another scope" — the two must
  // be byte-identical responses or the miss reason is a cross-scope oracle.
  // A note's entity is judged by its note's path, a remembered fact's subject by
  // the scopes its facts were saved in (entityScopeFilter), and with no scope while it has a fact (liveEntityFilter): a
  // subject whose every fact is retired is named nowhere.
  const filter = scopeNorm === undefined ? liveEntityFilter() : entityScopeFilter(scopeNorm);
  const row = lookupEntity(db, name, filter);
  const miss = () => {
    return {
      ok: true,
      entity: null,
      reason: 'no-entity-match',
      searched: ENTITY_LOOKUP_SURFACE,
      // Scoped to the same restriction as the lookup: never a workspace-wide
      // count handed to a caller that may only read one scope. The same count
      // memory_status reports, so the two never name different numbers.
      entitiesIndexed: countEntities(db, vault, filter),
      note: `Nothing in ${scopeNorm ?? 'this workspace'} is registered as an entity matching "${name}". lookup_entity searches ${ENTITY_LOOKUP_SURFACE}, so a word that appears only inside saved note text (a daily note, a saved fact body) is not an entity. Use search_text for that word, or search_memory for meaning where the workspace has semantic search.`,
      ...(scopeNorm === undefined ? {} : { scope: scopeNorm }),
    };
  };
  if (!row) return miss();
  const sourceNote = clientPath(vault.memoryDir, row.sourceNote);
  if (scopeNorm !== undefined) {
    return {
      ok: true,
      entity: { canonicalName: row.canonicalName, type: row.type, aliases: row.aliases, sourceNote },
      ...(scopeNorm === 'global' ? {} : { scope: scopeNorm }),
    };
  }
  return {
    ok: true,
    entity: {
      canonicalName: row.canonicalName,
      type: row.type,
      aliases: row.aliases,
      sourceNote,
    },
  };
}

/** The bytes of the workspace's events ledger, the file every remembered statement is written to; 0 while there is none. */
function ledgerBytes(vault: InventoryVault): number {
  try {
    return fs.statSync(resolveLedgerPath(vault.memoryDir, vault.ledgerRelPath)).size;
  } catch {
    return 0;
  }
}

export function engineStatus(db: Database.Database, engine: Engine, vault: InventoryVault) {
  const counts = countInventory(db, vault);
  // What cannot answer right now, said rather than left for the agent to infer from empty results. Absent when healthy.
  const failed = semanticFailures.get(engine);
  const degraded = {
    ...(keywordIndexReady(db) ? {} : { keyword: 'keyword search cannot run: its index is missing' }),
    ...(failed ? { semantic: `the last search by meaning failed at ${failed.at}: ${failed.reason}` } : {}),
  };
  return {
    ...counts,
    embeddingDims: engine.dims,
    // What the workspace stores, per tenant: its vectors, the bytes of its ledger, and the copy its searches read with the cap
    // that copy holds (vectorIndex.ts mirrorStats). A tenant near the cap is the one whose searches are about to leave the mirror.
    storage: {
      vectors: engine.vectorIndex ? engine.vectorIndex.storedCount() : 0,
      ledgerBytes: ledgerBytes(vault),
      ...(engine.vectorIndex ? { vectorMirror: engine.vectorIndex.mirrorStats() } : {}),
    },
    // Whether semantic search can answer now: false with no provider, and false until the embeddings are whole.
    semantic: semanticReady(engine),
    ...(engine.provider && engine.vectorIndex && !semanticReady(engine)
      ? { embeddingRebuild: { chunksLeft: engine.vectorIndex.space() === embeddingSpace(engine.provider) ? chunksWithoutVectors(db) : counts.chunks, chunks: counts.chunks } }
      : {}),
    // With an embedding provider, the chunks search by meaning cannot find, because they have no vector: a save whose
    // embedding failed (the next save, or a search, embeds them), notes an import wrote (the background job embeds
    // them), or a rebuild that is not done.
    ...(engine.vectorIndex ? { chunksWithoutVectors: chunksWithoutVectors(db) } : {}),
    ...(Object.keys(degraded).length > 0 ? { degraded } : {}),
  };
}

/** `interactive`: an agent is waiting on this pass, so embedding is held to the write budget (see EmbedBudgets). */
function indexOptionsFor(engine: Engine, interactive = false) {
  return engine.provider && engine.vectorIndex
    ? {
      embeddingProvider: engine.provider,
      vectorIndex: engine.vectorIndex,
      ...(interactive && engine.embedBudgets && Number.isFinite(engine.embedBudgets.writeMs) ? { embedBudgetMs: engine.embedBudgets.writeMs } : {}),
    }
    : {};
}

/**
 * Files an index pass has in flight at once. A file holds its slot while its embedding request is out, so the slot count is
 * how many requests an index pass can batch: with the coalescing provider (coalescing.ts) the requests stay at four in
 * flight whatever this is. Value set by the measurements in engine/docs/perf (see the note there).
 */
export const INDEX_FILE_CONCURRENCY = 48;

/**
 * `interactive`: an agent waits on this pass (the `index_memory` tool), so a file whose embedding the service will not give
 * within the write budget is left unfinished and the pass returns; a background job then embeds it
 * (`engineFinishIndexInBackground`), however long the service takes. Unset: the provider waits as long as its own retries take.
 */
export async function engineIndex(db: Database.Database, config: MvpConfig, engine: Engine, pass: { interactive?: boolean } = {}) {
  const stats = await indexVault(db, config.memoryDir, indexOptionsFor(engine, pass.interactive === true), INDEX_FILE_CONCURRENCY);
  if (stats.errors > 0 && pass.interactive) engineFinishIndexInBackground(db, config, engine);
  return stats;
}

/** What an index pass did: the files it read, the ones it indexed in full, and the ones it left unfinished. */
export interface IndexPass {
  total: number;
  indexed: number;
  /**
   * Files it could not index. The next save's pass tries them again, and so does a search for one whose embedding
   * failed (see finishUnfinishedFiles).
   */
  errors: number;
  /** Why the first of them failed, as a client may be told it (host paths redacted). */
  failure?: string;
  /** Checked files over the note size cap, which stay out of the index (paths below the memory folder). Absent when none. */
  tooLarge?: string[];
}

/**
 * What this process last reconciled each file with the index at: the file's stamp when `indexFile` last
 * succeeded on it. Kept per database, since another index has reconciled nothing.
 */
const reconciledStamps = new WeakMap<Database.Database, Map<string, string>>();
/** Per database: the stamp each note over the size cap had when it was last named, so it is said once per change and not on every save. */
const tooLargeStamps = new WeakMap<Database.Database, Map<string, string>>();
/**
 * Per database: the files a pass left unsettled, whose stamp this process does not record as reconciled (a file changed
 * within a clock tick of its scan, or whose pass failed or was not reached). A save checks them again, as a full scan
 * would, because it cannot tell from the files it wrote that they are done.
 */
const unsettledFiles = new WeakMap<Database.Database, Set<string>>();
/**
 * Per database: when this process last checked every file of the vault (a full pass). Until one has run, a save walks the
 * vault (the first pass in a process); after that a save walks it again once FULL_VAULT_CHECK_MS has passed.
 */
const walkedAt = new WeakMap<Database.Database, number>();
/**
 * How long note saves check only the files they wrote before every file of the vault is checked again. An edit made
 * outside the engine (in Obsidian, say) is therefore seen by a save once this long has passed since the last full check;
 * index_memory sees it at once.
 */
export const FULL_VAULT_CHECK_MS = 30_000;
/** Every stat field a change shows in. The change time is what catches a rewrite that puts the modification time back. */
const stampOf = (f: VaultFileStat) => `${f.mtimeMs}:${f.ctimeMs}:${f.size}:${f.ino}`;

/**
 * A timestamp is only as fine as the file system's clock tick (two seconds on the coarsest), so a file written,
 * scanned and written again within one tick, to the same size, carries the same stamp both times; the same goes
 * for a rewrite that puts the modification time back, within a tick of the first change. A file whose
 * modification or change time is this close to a scan is therefore not trusted by its stamp: the next scan
 * reads it again.
 */
export const TIMESTAMP_TICK_MS = 2_000;
const stampIsTrusted = (f: VaultFileStat, scanStart: number) =>
  Math.min(Math.abs(scanStart - f.mtimeMs), Math.abs(scanStart - f.ctimeMs)) >= TIMESTAMP_TICK_MS; // false for a failed stat (NaN)

/** Run `work` over `items`, `limit` at a time. */
async function inPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

/**
 * Bring the index up to date with the vault as a full `indexVault` would, reading only what changed. A file goes
 * through the same `indexFile` a full pass runs when the index has no finished row for it, or its stamp
 * (modification time, change time, size, inode) differs from the one recorded when this process last reconciled
 * it; an unchanged file costs a stat, not a read and a hash, and `indexFile` skips an unchanged file by its hash.
 *
 * Which files a pass checks depends on who runs it. A save passes `touched`, the files it wrote (the day's note, the
 * ledger): then only those, the files still owed (unsettled, see `unsettledFiles`) and the ones the index has no
 * finished row for are stat'ed, so the vault is not walked and no other note's path is loaded, and a save costs the
 * same however many notes and events the workspace holds. Without `touched` the vault is walked and every file
 * stat'ed: that is what a search that finishes a save's unfinished files and a background job run, and what starts
 * each process. A save walks it too when the last full check is FULL_VAULT_CHECK_MS or more old, so an edit, a new
 * file, a rename or a delete made outside the engine is seen by a save within that long (and at once by
 * `index_memory`, a full pass that reads every file). A file changed within a clock tick of its scan is not recorded
 * as reconciled (see TIMESTAMP_TICK_MS), so the next check reads it again. Like a full pass it leaves a deleted or
 * renamed-away file's rows in the index. The one change a stamp cannot show is a rewrite that leaves all four fields
 * as they were, which takes setting the system clock back.
 */
export async function engineIndexChanged(
  db: Database.Database,
  config: Pick<MvpConfig, 'memoryDir'>,
  engine: Engine,
  /** When the scan starts, on the clock the files' times are read against; a test passes a later one to age its files. */
  scanStart = Date.now(),
  /**
   * `interactive`: an agent waits on this pass (a save's, or a read that finishes what a save left), so a file whose
   * embedding the service will not give within the write budget is left unfinished and the pass returns; a background
   * job then embeds it (`engineFinishIndexInBackground`), however long the service takes.
   *
   * `touched`: the absolute paths of the files the calling save wrote. Given, the pass checks those and the files it
   * still owes, and walks no vault, unless the last full check is FULL_VAULT_CHECK_MS old or there has been none in this
   * process.
   */
  pass: { interactive?: boolean; touched?: string[] } = {},
): Promise<IndexPass> {
  const options = indexOptionsFor(engine, pass.interactive === true);
  let reconciled = reconciledStamps.get(db);
  if (!reconciled) {
    reconciled = new Map();
    reconciledStamps.set(db, reconciled);
  }
  const known = reconciled;
  let named = tooLargeStamps.get(db);
  if (!named) {
    named = new Map();
    tooLargeStamps.set(db, named);
  }
  const tooLarge = named;
  let unsettled = unsettledFiles.get(db);
  if (!unsettled) {
    unsettled = new Set();
    unsettledFiles.set(db, unsettled);
  }
  let candidates: VaultFileStat[];
  let isFinished: (file: string) => boolean;
  const now = Date.now();
  const lastCheck = walkedAt.get(db);
  const checkedRecently = lastCheck !== undefined && now >= lastCheck && now - lastCheck < FULL_VAULT_CHECK_MS;
  if (pass.touched !== undefined && checkedRecently) {
    // What the vault's rules leave out is never checked: the walk never reaches it, so neither does a save.
    const ignored = await vaultIgnores(config.memoryDir);
    const owed = [...pass.touched, ...unsettled];
    if ((prepareOnce(db, UNFINISHED_FILES).pluck().get() as number) > 0) {
      owed.push(...(prepareOnce(db, "SELECT path FROM notes WHERE note_hash = ''").pluck().all() as string[]));
    }
    candidates = statVaultFiles([...new Set(owed)].filter(file => !ignored(file)));
    // A file that is gone or ignored has nothing left to settle: a later pass finds nothing there either.
    const present = new Set(candidates.map(f => f.file));
    for (const file of unsettled) if (!present.has(file)) unsettled.delete(file);
    const hash = prepareOnce(db, "SELECT note_hash FROM notes WHERE path = ?").pluck();
    isFinished = (file) => {
      const h = hash.get(file);
      return typeof h === 'string' && h !== '';
    };
  } else {
    candidates = await walkVaultStats(config.memoryDir);
    const finished = new Set(db.prepare("SELECT path FROM notes WHERE note_hash != ''").pluck().all() as string[]);
    isFinished = (file) => finished.has(file);
    walkedAt.set(db, now);
    unsettled.clear(); // rebuilt below from every file's stamp
  }
  const changed = candidates.filter(f => tooLarge.get(f.file) !== stampOf(f) && (!isFinished(f.file) || known.get(f.file) !== stampOf(f)));
  let indexed = 0;
  let errors = 0;
  let failure: string | undefined;
  // Together: each file that embeds waits on the provider for a round trip, and a save that changed the
  // daily note and the ledger should wait for one round trip, not two.
  await inPool(changed, INDEX_FILE_CONCURRENCY, async (f) => {
    try {
      await indexFile(db, f.file, options);
      if (stampIsTrusted(f, scanStart)) known.set(f.file, stampOf(f));
      else known.delete(f.file);
      tooLarge.delete(f.file);
      indexed++;
    } catch (err) {
      if (err instanceof NoteTooLargeError) {
        // Not a failure to retry: it stays out of the index until the file changes, and is said once per change.
        known.delete(f.file);
        tooLarge.set(f.file, stampOf(f));
        log.warn('note_too_large', { file: path.relative(config.memoryDir, f.file) }, err);
        return;
      }
      known.delete(f.file);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      errors++;
      failure ??= failureReason(err, 300);
      log.error('index_file_failed', { file: path.relative(config.memoryDir, f.file) }, err);
    }
  });
  // Settle what was checked: a file whose stamp is recorded (or that is named too large for its stamp) is done; any
  // other is owed, and the next save checks it again.
  for (const f of candidates) {
    if (known.get(f.file) === stampOf(f) || tooLarge.get(f.file) === stampOf(f)) unsettled.delete(f.file);
    else unsettled.add(f.file);
  }
  // What the pass could not finish is not dropped: it is finished in the background, once the service answers.
  if (errors > 0 && pass.interactive) engineFinishIndexInBackground(db, config, engine);
  const overCap = candidates.filter(f => tooLarge.get(f.file) === stampOf(f)).map(f => path.relative(config.memoryDir, f.file));
  return { total: changed.length, indexed, errors, ...(failure === undefined ? {} : { failure }), ...(overCap.length > 0 ? { tooLarge: overCap } : {}) };
}

/**
 * The files whose last index pass did not finish: their embedding failed, so keyword search finds their chunks and
 * search by meaning does not, until a later pass embeds them (see indexFile). A partial index answers it (migration
 * 15), so asking costs those few rows, usually none, however many notes there are.
 */
export const UNFINISHED_FILES = "SELECT COUNT(*) FROM notes WHERE note_hash = ''";

/** After a search could not finish them, how long searches leave the unfinished files before trying again. */
export const UNFINISHED_RETRY_MS = 30_000;
/** Per index: the epoch ms before which a search does not try the unfinished files again. */
const unfinishedRetryAfter = new WeakMap<Database.Database, number>();

/**
 * Finish, for a search, the files a save left unfinished. A save whose embedding failed (the provider was down)
 * keeps its chunks, which keyword search finds, and leaves its file unfinished for a later pass to embed: the next
 * save's, or this one, which a search runs once the provider has embedded its query (`asked`: the search did, or, on
 * an index with no vector yet, which a search does not ask, it is asked here). So what was saved during an outage is
 * found by meaning as soon as the provider is back, not only after the next save; and a search waits on a provider
 * that is down no longer than for its own query, which then fails, so the search says semantic search failed rather
 * than that nothing matched. It is engineIndexChanged's full pass (no `touched`: every file is checked, as a save's first
 * pass in a process does). When it leaves a file unfinished although
 * the provider answers (a chunk it refuses), searches leave the files for UNFINISHED_RETRY_MS, so that costs a search a
 * provider call at most that often; saves go on retrying them as before. Throws only what embedding the query throws.
 * True when a file was finished, so the search runs again and finds its chunks.
 */
async function finishUnfinishedFiles(
  db: Database.Database,
  memoryDir: string,
  engine: Engine,
  /** The provider as a read sees it: its calls end within the read budget. */
  provider: EmbeddingProvider,
  query: string,
  asked: RetrievalProbe,
): Promise<boolean> {
  const unfinished = prepareOnce(db, UNFINISHED_FILES).pluck();
  const before = unfinished.get() as number;
  if (before === 0 || Date.now() < (unfinishedRetryAfter.get(db) ?? 0)) return false;
  // Asked here only to learn that it answers: the search that follows embeds the query and reports it as before.
  if (!asked.queryVector) await (provider.embedQuery ? provider.embedQuery(query) : provider.embed([query]));
  const finish = async (): Promise<boolean> => {
    try {
      await engineIndexChanged(db, { memoryDir }, engine, undefined, { interactive: true });
    } catch (err) {
      log.error('index_finish_failed', {}, err);
    }
    const after = unfinished.get() as number;
    if (after > 0) unfinishedRetryAfter.set(db, Date.now() + UNFINISHED_RETRY_MS);
    else unfinishedRetryAfter.delete(db);
    return after < before;
  };
  // The pass takes each file's lock, which a save that is embedding holds; a read does not wait for it beyond its own
  // budget. A pass that is still running then goes on without it, and the read is answered with what is indexed now.
  const budgetMs = engine.embedBudgets?.readMs;
  if (budgetMs === undefined || !Number.isFinite(budgetMs)) return finish();
  const running = finish();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), budgetMs); });
  try {
    const finished = await Promise.race([running, late]);
    if (!finished) unfinishedRetryAfter.set(db, Date.now() + UNFINISHED_RETRY_MS);
    return finished;
  } finally {
    clearTimeout(timer);
  }
}

/** A running `engineFinishIndexInBackground`. */
export interface BackgroundIndex {
  /** Settles when nothing is left to finish, or after `abort`; it never rejects. */
  done: Promise<void>;
  /** Stop between requests; what is left stays left, and the next save, read or start finishes it. */
  abort(): void;
  /** True while it only waits out a delay before its next attempt: nothing is being written, and a restart resumes it. */
  waiting(): boolean;
}

const backgroundIndexes = new WeakMap<Database.Database, BackgroundIndex>();

/** The first wait is short: a save that just failed is usually a service that is already back. */
export const BACKGROUND_INDEX_FIRST_DELAY_MS = 1_000;

/** After an attempt that failed: 30 s, doubling, up to 5 min (the wait a rebuild has). */
const backgroundIndexRetryDelayMs = (outage: number): number => Math.min(300_000, 30_000 * 2 ** outage);

/**
 * Finish, in the background, what a save could not: the chunks it kept for keyword search that have no vector, and the
 * files left unfinished for them. The embedding is the provider's patient one (its own retries and backoff, however long
 * they take) and holds no lock, so a service that is down costs only this task's time; the pass that follows takes each
 * file's lock for as long as it takes to record that its chunks have their vectors. When an attempt fails it waits
 * (30 s, doubling, up to 5 min) and tries again, so a failed index is queued and never dropped, and it ends only when
 * nothing is left or `abort` is called. A job already running for this index is returned rather than started twice.
 * An index whose vectors are not whole (a rebuild is embedding all of them) is left to that rebuild.
 */
export function engineFinishIndexInBackground(
  db: Database.Database,
  config: Pick<MvpConfig, 'memoryDir'>,
  engine: Engine,
  options: { firstDelayMs?: number; retryDelayMs?: (outage: number) => number } = {},
): BackgroundIndex | null {
  const { provider, vectorIndex } = engine;
  if (!provider || !vectorIndex) return null;
  const running = backgroundIndexes.get(db);
  if (running) return running;
  const { firstDelayMs = BACKGROUND_INDEX_FIRST_DELAY_MS, retryDelayMs = backgroundIndexRetryDelayMs } = options;
  const controller = new AbortController();
  const unfinished = prepareOnce(db, UNFINISHED_FILES).pluck();
  let waiting = false;
  const wait = async (ms: number): Promise<void> => {
    waiting = true;
    try { await sleep(ms, controller.signal); } finally { waiting = false; }
  };
  const run = async (): Promise<void> => {
    await wait(firstDelayMs);
    for (let outage = 0; !controller.signal.aborted; outage++) {
      try {
        if (semanticReady(engine)) {
          await embedMissingVectors(db, vectorIndex, provider, { signal: controller.signal });
          if (controller.signal.aborted) return;
          // Their vectors are in: this records it, and embeds only what a save has changed since (within the write budget).
          await engineIndexChanged(db, config, engine, undefined, { interactive: true });
          if ((unfinished.get() as number) === 0 && chunksWithoutVectors(db) === 0) {
            if (outage > 0) log.info('embeddings_recovered', { detail: 'the embedding service answers again; what was saved while it did not is findable by meaning now' });
            return;
          }
        } else if (!vectorIndex.rebuilding()) {
          return; // another model's space: a rebuild is the only thing that can make it whole, and it is not this job's
        }
        throw new Error('the index is not finished yet');
      } catch (err) {
        if (controller.signal.aborted) return;
        const delay = retryDelayMs(outage);
        log.error('background_index_retry', { unembedded: chunksWithoutVectors(db), retryInS: Math.round(delay / 1000) }, err);
        await wait(delay);
      }
    }
  };
  const job: BackgroundIndex = {
    abort: () => controller.abort(),
    waiting: () => waiting,
    done: run().catch((err) => log.error('background_index_failed', {}, err)).finally(() => {
      if (backgroundIndexes.get(db) === job) backgroundIndexes.delete(db);
    }),
  };
  backgroundIndexes.set(db, job);
  return job;
}

/** The job `engineFinishIndexInBackground` started for this index that has not ended yet, or null; starts none. */
export function runningBackgroundIndex(db: Database.Database): BackgroundIndex | null {
  return backgroundIndexes.get(db) ?? null;
}

/**
 * Whether anything is waiting for the embedding service: a file left unfinished, or a chunk with no vector in an index
 * that is otherwise whole. Asked at start, so what an earlier process (or an idle exit) left is finished.
 */
export function hasIndexWorkToFinish(db: Database.Database, engine: Engine): boolean {
  if (!engine.provider || !engine.vectorIndex || !semanticReady(engine)) return false;
  return (prepareOnce(db, UNFINISHED_FILES).pluck().get() as number) > 0 || chunksWithoutVectors(db) > 0;
}

export async function engineRememberNote(
  config: MvpConfig,
  text: string,
  date?: string,
  source?: string,
  scope?: string,
  /** The user's time zone, when the client names it: the note is then filed under their day, at their time. */
  timeZone?: string,
) {
  // One reading of the clock gives the entry both its day and its time.
  const clock = entryClock(new Date(), timeZone);
  const day = date ?? clock.date;
  const dir = dailyDirForScope(normalizeScope(scope));
  const written = await appendDailyEntry(
    config.memoryDir,
    day,
    { text, source: source ?? 'mcp' },
    dir,
    clock,
  );
  const file = clientPath(config.memoryDir, written.filePath);
  // The id that reads, retires or restores this entry (memory_map's), so forgetting it needs no lookup (live dogfood
  // 2026-10-03, D12).
  const id = appendedEntryId(file.split(path.sep).join('/'), written.entry);
  return { ok: true, file, scope: normalizeScope(scope), ...(id ? { id } : {}) };
}
