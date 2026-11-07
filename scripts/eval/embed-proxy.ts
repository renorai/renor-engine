#!/usr/bin/env node
/**
 * OpenAI-compatible localhost embedding proxy for the product-path baseline.
 *
 * The shipped CLI's openai provider (src/embeddings/openai.ts) speaks plain
 * POST {baseURL}/embeddings with {model, input}. This proxy serves exactly
 * that shape on 127.0.0.1 and translates to the native Vertex predict path
 * (src/embeddings/vertex.ts), so the external-client product run can use real
 * gemini-embedding-001 vectors while reusing the research runs'
 * content-addressed cache (namespace vertex/gemini-embedding-001/768).
 *
 * Semantically invisible passthrough contract:
 *   - content-addressing is on exact (input text, model, dims);
 *   - upstream errors are forwarded with their status/message unchanged;
 *   - batch size behavior is preserved (the batch is forwarded as received);
 *   - vectors are never altered;
 *   - unknown model/dims combinations are refused explicitly, never
 *     re-dimensioned silently.
 *
 * Stats: an atomic JSON file records hit-rate split by component ("query"
 * inputs match /^Question date: /m, everything else is a "vault-chunk") so a
 * low aggregate hit rate is diagnosable as chunker divergence vs query-format
 * drift. Startup logs never contain API keys or input text.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { CachingEmbeddingProvider, resolveEmbeddingCachePath } from '../../src/embeddings/caching';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import type { EmbeddingProvider } from '../../src/embeddings/types';

const UPSTREAM_ENDPOINT = 'vertex-predict';
const PROXY_MODEL = 'gemini-embedding-001';
const PROXY_DIMS = 768;
/** The proxy namespace is pinned to the research runs' Vertex cache layout. */
const PROXY_NAMESPACE = `vertex/${PROXY_MODEL}/${PROXY_DIMS}`;
/** OpenAI model names accepted on the wire; all map to the pinned model. */
const ACCEPTED_MODELS = new Set([PROXY_MODEL, `models/${PROXY_MODEL}`]);

/** Anything the proxy can embed: the injectable seam for tests (stub upstream). */
export interface EmbeddingUpstream extends EmbeddingProvider {
  readonly model: string;
  /** Mirrors VertexEmbeddingProvider.usage; optional so stubs can omit it. */
  readonly usage?: { inputTokens: number };
}

export interface EmbedProxyOptions {
  port: number;
  statsPath: string;
  /** Cache DB path; defaults to resolveEmbeddingCachePath() (same DB as research runs). */
  cachePath?: string | null;
  /** Injectable upstream (tests: stub). Default: native VertexEmbeddingProvider. */
  upstream?: EmbeddingUpstream;
  /** Injectable live provider factory (tests: a fake Vertex). It is still behind the live guard; default: native VertexEmbeddingProvider. */
  liveProvider?: (dims: number) => EmbeddingProvider;
  /** Strict mode (authoritative runs): refuse requests that omit `dimensions` — by then any omission is a product regression signal, not a finding. */
  strictDimensions?: boolean;
}

export interface EmbedProxyStats {
  namespace: string;
  upstream: { endpoint: string; model: string; dims: number };
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  /**
   * What actually reached the upstream, beside the lookup counters above: a text repeated within a
   * request counts as a miss for each occurrence but is sent once, and a fully cached request sends nothing.
   * Calls are invocations of the upstream provider (a document batch, or a query).
   */
  upstreamTexts: number;
  upstreamCalls: number;
  vaultChunkHits: number;
  vaultChunkMisses: number;
  queryHits: number;
  queryMisses: number;
  inputTokens: number;
  errors: number;
  /** Requests served at the faithful omission default (3072) — any nonzero count means a client failed to send `dimensions` (broken-client signal). */
  omissionDefaultRequests: number;
  startedAt: string;
  lastAt: string | null;
}

interface EmbeddingsRequest {
  model?: unknown;
  input?: unknown;
  dimensions?: unknown;
  encoding_format?: unknown;
}

/** Advisory component classification: product-path queries are prefixed this way. */
export function classifyInput(text: string): 'query' | 'vault-chunk' {
  return /^Question date: /m.test(text) ? 'query' : 'vault-chunk';
}

/** Atomic stats write: temp file + rename, so readers never see a partial file. */
function writeStatsFile(statsPath: string, stats: EmbedProxyStats): void {
  const tmp = `${statsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(stats, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statsPath);
}

export interface EmbedProxy {
  /** HTTP server (listen via start()). */
  server: http.Server;
  /** Binds to the configured port (or an ephemeral port when port is 0). */
  start(): Promise<number>;
  close(): Promise<void>;
  /** Final stats write (idempotent; also called after every request). */
  flushStats(): void;
  readonly stats: EmbedProxyStats;
}

/** Live-call guard: a live call needs H10_VERTEX_LIVE=1, and the proxy stops at H10_VERTEX_CALL_CAP (default 2,500) live calls. */
export const LIVE_CALL_CAP_DEFAULT = 2500;
export function liveCallCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.H10_VERTEX_CALL_CAP ?? '').trim();
  if (raw === '') return LIVE_CALL_CAP_DEFAULT;
  if (!/^\d+$/.test(raw)) throw new Error(`embed-proxy: H10_VERTEX_CALL_CAP must be a whole number, got ${JSON.stringify(raw)}`);
  return Number(raw);
}
export function liveCallsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.H10_VERTEX_LIVE ?? '').trim() === '1';
}
/** One admission budget, shared by every guarded wrapper of a proxy so the cap is proxy-wide, not per dimension. */
export interface LiveCallBudget { admit(): void }
export function liveCallBudget(env: NodeJS.ProcessEnv = process.env): LiveCallBudget {
  const cap = liveCallCap(env);
  let calls = 0;
  return {
    admit(): void {
      if (!liveCallsAllowed(env)) throw new Error('embed-proxy: cache-only (H10_VERTEX_LIVE is not 1): a cache miss is refused, nothing is billed');
      if (calls >= cap) throw new Error(`embed-proxy: live call cap reached (${calls} >= ${cap}); refusing further billed calls`);
      calls += 1;
    },
  };
}
export function guardedUpstream(inner: EmbeddingProvider, isStub: boolean, env: NodeJS.ProcessEnv = process.env, budget?: LiveCallBudget): EmbeddingProvider {
  if (isStub) return inner; // tests: a stub makes no billed call
  const admit = (budget ?? liveCallBudget(env)).admit;
  const wrapper = {
    dimensions: inner.dimensions,
    identity: inner.identity,
    embed: async (texts: string[], options?: unknown) => { admit(); return inner.embed(texts, options as never); },
    embedQuery: inner.embedQuery ? async (text: string, options?: unknown) => { admit(); return inner.embedQuery!(text, options as never); } : undefined,
  } as unknown as EmbeddingProvider;
  // Forward the provider's live usage (it is mutated in place), never a copy taken at construction.
  Object.defineProperty(wrapper, 'usage', { get: () => (inner as { usage?: unknown }).usage, enumerable: true });
  return wrapper;
}

/**
 * Build the proxy. `options.upstream` is injectable so tests can exercise the
 * translation/caching/stats layers without touching Vertex; production uses
 * the default native Vertex provider (constructed lazily inside start(),
 * because an import must not require Vertex credentials).
 */
export function createEmbedProxy(options: EmbedProxyOptions): EmbedProxy {
  const stats: EmbedProxyStats = {
    namespace: PROXY_NAMESPACE,
    upstream: { endpoint: UPSTREAM_ENDPOINT, model: PROXY_MODEL, dims: PROXY_DIMS },
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    upstreamTexts: 0,
    upstreamCalls: 0,
    vaultChunkHits: 0,
    vaultChunkMisses: 0,
    queryHits: 0,
    queryMisses: 0,
    inputTokens: 0,
    errors: 0,
    omissionDefaultRequests: 0,
    startedAt: new Date().toISOString(),
    lastAt: null,
  };

  // Per-dims layers: 768 is the warm production namespace (research cache);
  // 3072 is the faithful omission default so broken clients fail loudly
  // exactly as they would against real Google — never silently forgiven.
  const layers = new Map<number, CachingEmbeddingProvider>();
  const stubUpstream: EmbeddingUpstream | null = options.upstream ?? null;
  const liveBudget = liveCallBudget();
  function cacheLayer(dims: number): CachingEmbeddingProvider {
    const existing = layers.get(dims);
    if (existing) return existing;
    const liveUpstream: EmbeddingProvider = stubUpstream
      ? stubUpstream
      : (options.liveProvider ? options.liveProvider(dims) : new VertexEmbeddingProvider({ model: PROXY_MODEL, dimensions: dims }));
    // H10 guard (firstmate inbox 044): every live call is refused unless H10_VERTEX_LIVE=1, and the proxy itself
    // stops at H10_VERTEX_CALL_CAP live calls (default 2,500). A cache miss in cache-only mode is an error, not a bill.
    const layerUpstream: EmbeddingProvider = guardedUpstream(liveUpstream, stubUpstream !== null, process.env, liveBudget);
    upstreamInstances.add(layerUpstream);
    const resolvedCachePath = options.cachePath !== undefined ? options.cachePath : resolveEmbeddingCachePath();
    if (!resolvedCachePath) throw new Error('embed-proxy: embedding cache is disabled (RENOR_EVAL_EMBED_CACHE=off); refusing to serve without a cache');
    // The warm 768 namespace writes into the paid research cache artifact;
    // every other dims layer gets an isolated scratch DB so omission-default
    // (or foreign-dims) vectors can NEVER pollute the paid cache.
    const layerCachePath = dims === 768 ? resolvedCachePath : `${resolvedCachePath}.omission-${dims}`;
    const layer = new CachingEmbeddingProvider(layerUpstream, {
      cachePath: layerCachePath,
      // Pinned to the research runs' layout (namespace vertex/<model>/<dims>): 768 is the warm
      // research cache; 3072 is cold and only ever reached by clients that failed to send
      // `dimensions`. The cache checks this against the real Vertex upstream, which declares
      // the same identity; a stub upstream that cannot declare one relies on it.
      identity: { kind: 'vertex', model: PROXY_MODEL },
    });
    layers.set(dims, layer);
    return layer;
  }

  // Unique upstream instances (stub is shared across layers; production gets
  // one VertexEmbeddingProvider per dims layer) — token accounting dedupes by instance.
  const upstreamInstances = new Set<EmbeddingProvider>();
  function totalUpstreamTokens(): number {
    let tokens = 0;
    for (const instance of upstreamInstances) {
      const usage = (instance as { usage?: { inputTokens: number } }).usage;
      if (usage) tokens += usage.inputTokens;
    }
    return tokens;
  }

  /** Sum what every dims layer has sent upstream; called whenever the stats are about to be written. */
  function refreshUpstreamCounters(): void {
    stats.upstreamTexts = 0;
    stats.upstreamCalls = 0;
    // Recorded for the manifest: whether live (billed) calls were allowed for this proxy, and its cap.
    (stats as unknown as Record<string, unknown>).vertexLive = liveCallsAllowed();
    (stats as unknown as Record<string, unknown>).liveCallCap = liveCallCap();
    for (const layer of layers.values()) {
      stats.upstreamTexts += layer.sent.texts;
      stats.upstreamCalls += layer.sent.calls;
    }
  }

  function statsSnapshot(dims: number): { hits: number; misses: number; tokens: number } {
    const layer = layers.get(dims);
    return {
      hits: layer?.stats.hits ?? 0,
      misses: layer?.stats.misses ?? 0,
      tokens: totalUpstreamTokens(),
    };
  }

  function jsonError(res: http.ServerResponse, status: number, message: string): void {
    stats.errors += 1;
    stats.lastAt = new Date().toISOString();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message, type: 'embed_proxy_error', code: status } }));
    // Refusals are errors too: the stats file must reflect them immediately.
    try {
      writeStatsFile(options.statsPath, stats);
    } catch {
      // never fail the HTTP response over a stats write
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !/^\/(v1\/)?embeddings$/.test(req.url ?? '')) {
      jsonError(res, 404, `embed-proxy: only POST /v1/embeddings is served (got ${req.method} ${req.url})`);
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      void (async () => {
        let parsed: EmbeddingsRequest;
        try {
          parsed = JSON.parse(body) as EmbeddingsRequest;
        } catch {
          jsonError(res, 400, 'embed-proxy: request body is not valid JSON');
          return;
        }
        const model = typeof parsed.model === 'string' ? parsed.model : null;
        if (!model || !ACCEPTED_MODELS.has(model)) {
          jsonError(res, 400, `embed-proxy: unsupported model ${JSON.stringify(model)}; this proxy maps exactly ${PROXY_MODEL} (namespace ${PROXY_NAMESPACE})`);
          return;
        }
        const requestedDims = parsed.dimensions === undefined
          ? 3072 // faithful: real Google's omission default, verified live 2026-09-21 — never forgive a missing `dimensions`
          : Number(parsed.dimensions);
        if (parsed.dimensions !== undefined && !Number.isInteger(requestedDims)) {
          jsonError(res, 400, `embed-proxy: dimensions must be an integer (got ${JSON.stringify(parsed.dimensions)})`);
          return;
        }
        if (requestedDims !== 768 && requestedDims !== 3072) {
          jsonError(res, 400, `embed-proxy: unsupported dimensions ${JSON.stringify(parsed.dimensions)} — this proxy provisions the warm 768 namespace and the faithful omission default 3072 (real Google accepts 768/1536/3072; 1536 is not provisioned)`);
          return;
        }
        if (parsed.dimensions === undefined) stats.omissionDefaultRequests += 1;
        if (parsed.dimensions === undefined && options.strictDimensions) {
          jsonError(res, 400, 'embed-proxy: strict-dimensions mode (authoritative run): request omitted `dimensions` — the product must send its configured dims; omission here is a regression, not a finding');
          return;
        }
        const before = statsSnapshot(requestedDims);
        // Fidelity: mirror the real endpoint exactly. Google's OpenAI-compat
        // /embeddings returns a JSON float array when encoding_format is OMITTED
        // and base64 when requested; the openai SDK sends 'base64' explicitly by
        // default. Verified live 2026-09-21 (omitted→list, base64→str).
        if (parsed.encoding_format !== undefined && parsed.encoding_format !== 'base64' && parsed.encoding_format !== 'float') {
          jsonError(res, 400, `embed-proxy: unsupported encoding_format ${JSON.stringify(parsed.encoding_format)}; only 'base64' and 'float' are served`);
          return;
        }
        const encodingFormat: 'base64' | 'float' = parsed.encoding_format === 'base64' ? 'base64' : 'float';
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        if (inputs.length === 0 || inputs.some(t => typeof t !== 'string')) {
          jsonError(res, 400, 'embed-proxy: input must be a string or a non-empty array of strings');
          return;
        }
        const texts = inputs as string[];
        try {
          const cache = cacheLayer(requestedDims);
          // Component-split routing: query-classified inputs go through
          // embedQuery (RETRIEVAL_QUERY task type), vault chunks through embed
          // (RETRIEVAL_DOCUMENT) — the exact task-type layout of the research
          // runs, so prior cache entries are hits. Order is preserved.
          const chunkIndexes: number[] = [];
          const queryIndexes: number[] = [];
          texts.forEach((text, index) => (classifyInput(text) === 'query' ? queryIndexes : chunkIndexes).push(index));
          const vectors: number[][] = new Array(texts.length);
          const markSplit = (before: { hits: number; misses: number }, kind: 'query' | 'vault-chunk'): void => {
            const after = { hits: cache.stats.hits, misses: cache.stats.misses };
            const hits = after.hits - before.hits;
            const misses = after.misses - before.misses;
            if (kind === 'query') { stats.queryHits += hits; stats.queryMisses += misses; }
            else { stats.vaultChunkHits += hits; stats.vaultChunkMisses += misses; }
            stats.cacheHits += hits;
            stats.cacheMisses += misses;
          };
          if (chunkIndexes.length > 0) {
            const chunkBefore = statsSnapshot(requestedDims);
            const chunkVectors = await cache.embed(chunkIndexes.map(i => texts[i]));
            chunkIndexes.forEach((originalIndex, i) => { vectors[originalIndex] = chunkVectors[i]; });
            markSplit(chunkBefore, 'vault-chunk');
          }
          for (const queryIndex of queryIndexes) {
            const queryBefore = statsSnapshot(requestedDims);
            vectors[queryIndex] = await cache.embedQuery(texts[queryIndex]);
            markSplit(queryBefore, 'query');
          }
          const tokensAfter = totalUpstreamTokens();
          const requestTokens = Math.max(0, tokensAfter - before.tokens);
          stats.requests += 1;
          stats.inputTokens += requestTokens;
          stats.lastAt = new Date().toISOString();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            object: 'list',
            data: vectors.map((embedding, index) => ({
              object: 'embedding',
              index,
              embedding: encodingFormat === 'base64'
                ? Buffer.from(new Float32Array(embedding).buffer).toString('base64')
                : embedding,
            })),
            model,
            usage: { prompt_tokens: requestTokens, total_tokens: requestTokens },
          }));
        } catch (error) {
          // Forward upstream failures with their status when the provider
          // carries one; the message body is forwarded unchanged.
          const status = (error as { status?: number }).status;
          const upstreamStatus = typeof status === 'number' && status >= 400 && status < 600 ? status : 502;
          stats.errors += 1;
          stats.lastAt = new Date().toISOString();
          res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: 'upstream_error' } }));
        } finally {
          refreshUpstreamCounters(); // a failed upstream call was still made, so this runs on every outcome
          writeStatsFile(options.statsPath, stats);
        }
      })();
    });
  }

  return {
    server,
    start(): Promise<number> {
      return new Promise((resolve, reject) => {
        // Upstream providers are constructed lazily per dims layer on first
        // request (cacheLayer) — an import or start() must not require Vertex
        // credentials; upstream failures surface through the forwarded-error path.
        server.once('error', reject);
        server.listen(options.port, '127.0.0.1', () => {
          const address = server.address();
          const boundPort = typeof address === 'object' && address ? address.port : options.port;
          process.stderr.write(`[embed-proxy] listening on 127.0.0.1:${boundPort} namespace=${PROXY_NAMESPACE} upstream=${UPSTREAM_ENDPOINT} model=${PROXY_MODEL} dims=${PROXY_DIMS}\n`);
          resolve(boundPort);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close(() => {
          try {
            for (const layer of layers.values()) layer.close();
            layers.clear();
            writeStatsFile(options.statsPath, stats);
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    },
    flushStats(): void {
      writeStatsFile(options.statsPath, stats);
    },
    stats,
  };
}

// ─── CLI entry ───

interface ProxyArgv {
  port: string;
  statsPath: string;
  cacheDb?: string;
  strictDimensions?: boolean;
}

function parseProxyArgs(userArgv: string[]): ProxyArgv {
  const program = new Command()
    .name('embed-proxy')
    .requiredOption('--port <n>', 'localhost port to listen on (0 = ephemeral)')
    .requiredOption('--stats-path <path>', 'atomic JSON stats file, rewritten after every request batch')
    .option('--cache-db <path>', 'content-addressed embedding cache DB (default: resolveEmbeddingCachePath)')
    .option('--strict-dimensions', 'authoritative-run mode: refuse requests that omit `dimensions` (any omission is a product regression signal by then)');
  program.parse(userArgv, { from: 'user' });
  return program.opts() as ProxyArgv;
}

async function main(): Promise<void> {
  const opts = parseProxyArgs(process.argv.slice(2));
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
  fs.mkdirSync(path.dirname(path.resolve(opts.statsPath)), { recursive: true });
  const proxy = createEmbedProxy({
    port,
    statsPath: path.resolve(opts.statsPath),
    cachePath: opts.cacheDb ? path.resolve(opts.cacheDb) : undefined,
    strictDimensions: opts.strictDimensions === true,
  });
  await proxy.start();
  const shutdown = (): void => {
    proxy.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run main() only when executed directly as a script; importers (tests) get
// the exported factory without side effects.
const invokedDirectly = process.argv[1]?.endsWith('embed-proxy.ts') === true;
if (invokedDirectly) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}