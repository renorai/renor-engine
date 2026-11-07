import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OwnerOAuthProvider, ownerLoginRouter } from './auth';
import Database from '../db/sqlite';
import { type Engine, type EngineDigests, attachEngine, engineRebuildEmbeddings, hasIndexWorkToFinish, engineFinishIndexInBackground, runningEmbeddingRebuild, runningBackgroundIndex, resolveEngineDigests, engineIndexChanged, engineRememberNote, engineIndex } from './engine';
import { IdleMonitor } from './idle';
import { reindexPending, removeRowsOutsideRoot, clearReindexPending } from '../indexer/outsideRoot';
import { type Dreamer, createDreamer } from '../memory/dreamer/dreamer';
import { toolOutputSchemasEnabled } from './outputSchemas';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { MvpConfig } from './config';
import { ReadUsefulness } from './readUsefulness';
import { type ConnectionStatus, connectionStatusFromEnv } from './connectionStatus';
import type { EmbeddingProvider } from '../embeddings/types';
import { ensureOwnerOnlyMemoryDir, ensureOwnerOnlyFile } from './memoryDir';
import { openIndexDb } from '../db/client';
import { resolveLedgerPath, replayLedger } from '../memory/lifecycle';
import { handoffNoteEnabled, startHandoffSweep } from '../memory/handoff';
import { runMigrations } from '../db/schema';
import { ensureFactTerms } from '../memory/factTerms';
import { ActivityGauge, ACTIVITY_PATH } from './activity';
import { StoredSizeGauge } from './storedSize';
import { removeDailyHeaderFacts } from '../indexer/pipeline';
import path from 'path';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { LOCAL_API_HOSTNAMES } from '../api/apiAuth';
import { readBuildIdentity } from '../buildIdentity';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { noteKnownAgent } from '../memory/requests';
import crypto from 'crypto';
import { createCaptureTurns, CAPTURE_SOURCE, captureRuleSaver, gatewaySecretMatches } from '../extraction/captureTurns';
import { ruleApprovalsEnabled, updateRuleApprovals } from './ruleApprovals';
import { serverTimingFor, requestTiming } from './serverTiming';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { isPlatformInitialize, emitTelemetry } from './telemetry';
import { sanitizeErrorMessage } from './sanitize';
import { createToolContext } from './tools/setup.js';
import { registerAllTools } from './tools/index.js';
import { finishToolSurface } from './tools/finalize.js';
import { log, headerText, trustedIdentity, agentOf, isDashboardCall, isDirectoryCall } from './tools/shared.js';
export { OUTPUT_SCHEMA_BOUND_NOTE, DASHBOARD_HEADER, DIRECTORY_HEADER, toolError, SEARCH_REFUSAL_REASONS } from './tools/shared.js';

export interface MvpApp {
  app: express.Express;
  server: McpServer;
  provider: OwnerOAuthProvider;
  db: Database.Database;
  engine: Engine;
  /**
   * Settles when the rebuild started at boot ends: the embeddings are whole (at once when they were); see
   * `engineRebuildEmbeddings`. One an import starts later is `runningEmbeddingRebuild(engine)`.
   */
  embeddingRebuild: Promise<void>;
  /** On-demand idle monitor; null unless RENOR_ON_DEMAND is on. */
  idle: IdleMonitor | null;
  /** Write-time digests (the options search reads them with, and the background worker); null unless RENOR_DIGESTS is on. */
  digests: EngineDigests | null;
  /**
   * The folder is owed an index pass: rows for files outside it were removed (it was moved or restored elsewhere), and no
   * pass has since finished without a failure, possibly by an earlier process that was cut short. startMvpService runs
   * that pass before the service listens.
   */
  reindexPending: boolean;
  /** The consolidation pass (memory/dreamer); null unless RENOR_CONSOLIDATE is on and a model is configured. */
  dreamer: Dreamer | null;
  close(): Promise<void>;
}

const MCP_PATH = '/mcp';

/**
 * A request body must be UTF-8. Node decodes an invalid byte as U+FFFD, and the tool would store that, so the
 * body is refused before it is parsed. The error carries a 400 status, which body-parser keeps.
 */
function requireUtf8Body(_req: express.Request, _res: express.Response, body: Buffer): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw Object.assign(new Error('request body is not valid UTF-8; nothing was run'), { status: 400, expose: true });
  }
}

/** True when any message is a tools/call that omitted `id`. An explicit `id: null` still has the key. */
function bodyHasToolsCallNotification(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    const record = message as Record<string, unknown>;
    return record.method === 'tools/call' && !Object.prototype.hasOwnProperty.call(record, 'id');
  });
}

/** Loopback-only build-identity probe for deploy verification (no credential); see the route below. */
const VERSION_PATH = '/version';

/**
 * Headers a reverse proxy adds when it forwards a request — Caddy's
 * `reverse_proxy` appends X-Forwarded-For/-Proto/-Host to every forwarded
 * request. This service never trusts these headers as identity input (they are
 * spoofable client input; the middleware in createMvpApp deletes them), so
 * their mere PRESENCE means the request reached the socket through a hop, not
 * from a local caller. Checked against req.rawHeaders, which that middleware
 * does not touch.
 */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
];

/** True for 127.0.0.0/8 (including IPv4-mapped ::ffff:127.0.0.1) and ::1. */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return normalized === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/** True when the Host header names the loopback interface rather than a public tenant host. */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const end = hostHeader.startsWith('[') ? hostHeader.indexOf(']') : -1;
  const host = end > 0 ? hostHeader.slice(1, end) : hostHeader.split(':')[0];
  return host === 'localhost' || isLoopbackAddress(host);
}

/**
 * Whether a request reached this process the way an operator doing deploy
 * verification over SSH does: through the loopback interface, without a proxy
 * hop, addressing the instance by its loopback name.
 *
 * All three have to hold, because the deployed topology puts a tenant-site
 * Caddy in front (`reverse_proxy 127.0.0.1:<port>`), so a public caller's
 * socket peer IS loopback — the peer check alone would not block it. What does
 * block it: that Caddy hop forwards the client's Host (a public tenant host)
 * and appends X-Forwarded-For, so the loopback-Host and no-forwarding-hop
 * checks both fail for anything arriving from the public path.
 */
function isLocalDirectCall(req: express.Request): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  if (!isLoopbackHost(req.headers.host)) return false;
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (FORWARDING_HEADERS.includes(raw[i].toLowerCase())) return false;
  }
  return true;
}

export { toolOutputSchemasEnabled };

/** The SDK transport reads req.auth; Express does not declare that optional request field. */
interface McpRequest extends express.Request {
  auth?: AuthInfo;
}

/**
 * The tool profile a connection chose through its MCP URL (`?tools=coding`). The gateway reads that query value, allowlists
 * it and sets this header itself, dropping any copy the client sent; like DIRECTORY_HEADER it is trusted only behind the
 * gateway, and it only narrows the tools listed. Absent, or any other value, is the full set.
 */
export const TOOL_PROFILE_HEADER = 'x-renor-tool-profile';

function toolProfileOf(headers: Record<string, unknown> | undefined, config: MvpConfig): 'coding' | null {
  return Boolean(config.gatewaySecret) && headerText(headers, TOOL_PROFILE_HEADER) === 'coding' ? 'coding' : null;
}

/**
 * One MCP server, built from the per-tool modules in ./tools: setup.ts makes the server and the values every tool reads,
 * index.ts registers each tool in the order tools/list shows them, finalize.ts installs the tools/list and tools/call wrappers.
 * To change one tool, edit its file under ./tools.
 */
function buildMcpServer(db: Database.Database, config: MvpConfig, engine: Engine, idle: Pick<IdleMonitor, 'track'> | null, digests: EngineDigests | null, usefulness: ReadUsefulness, connection: ConnectionStatus | null, announceFirst: boolean, telemetrySession: string | null = null, dashboard = false, directory = false, dreamer: Dreamer | null = null, toolProfile: 'coding' | null = null): McpServer {
  const ctx = createToolContext(db, config, engine, idle, digests, usefulness, connection, announceFirst, telemetrySession, dashboard, directory, dreamer, toolProfile);
  registerAllTools(ctx);
  finishToolSurface(ctx);
  return ctx.server;
}

export function createMvpApp(config: MvpConfig, engineOverride?: EmbeddingProvider | null): MvpApp {
  // Before anything is opened: the memory directory and the index are owner-only. A readable one is tightened (and said
  // once); one that cannot be, because someone else owns it, stops the start as an unsafe client store does. openIndexDb
  // opens through openDb, so a damaged index that is set aside and rebuilt is created owner-only as well.
  ensureOwnerOnlyMemoryDir(config.memoryDir);
  ensureOwnerOnlyFile(config.dbPath);
  const db = openIndexDb(config.dbPath, resolveLedgerPath(config.memoryDir, config.ledgerRelPath));
  // Expired handoff notes are deleted on a timer, not only when one is read (memory/handoff.ts). Off: nothing runs.
  const stopHandoffSweep = handoffNoteEnabled() ? startHandoffSweep(db) : null;
  runMigrations(db);
  // Facts saved before the term index existed, or by a release without it, are indexed before the first search.
  ensureFactTerms(db);
  // An index written for another folder (this one was moved or restored) names its notes by the old paths: those rows
  // go before anything reads the index, so no note is served from a place it no longer is. Fails the start if it cannot.
  const rowsOutsideRoot = removeRowsOutsideRoot(db, config.memoryDir).total;
  if (rowsOutsideRoot > 0) log.info('startup_rows_outside_root_removed', { rows: rowsOutsideRoot, detail: 'index rows for files outside the memory folder; the folder is indexed again before serving' });
  const pendingPass = reindexPending(db);

  const engine = attachEngine(db, config, engineOverride);
  // An index whose vectors are in another model's space, or in none anyone can vouch for, is cleared and embedded
  // again in the background, and one whose chunks have no vectors yet (it was written without a provider) is
  // completed the same way; semantic search is off until that is done (keyword search is not).
  const rebuild = engineRebuildEmbeddings(db, engine);
  // What an earlier process could not embed in time (its service was down when it was saved, or it exited first) is
  // finished now, in the background, once the service answers.
  if (hasIndexWorkToFinish(db, engine)) engineFinishIndexInBackground(db, config, engine);
  const provider = new OwnerOAuthProvider(config);
  const idle = config.idleExitMs ? new IdleMonitor(config.idleExitMs) : null;
  // What a release asks before it restarts this engine (GET /internal/activity): the work a restart would cut and when the
  // last of it ended. It tracks the same work the idle monitor does and passes it on, so every place that held the engine
  // awake goes through it; it also counts each MCP request until its response has ended (below) and the background jobs a
  // call starts and does not await (the embedding rebuild and the background index, while they are working).
  const activity = new ActivityGauge(idle, Date.now, () => [runningEmbeddingRebuild(engine), runningBackgroundIndex(db)]);
  // Markdown bytes: cached background measurements for reporting, fresh awaited walks for enforced write admission.
  // Both travel on the token mint the gateway already makes for every call. See storedSize.ts.
  const storedSize = new StoredSizeGauge(config.memoryDir);

  // Write-time digests: null unless RENOR_DIGESTS is on (it is off by default). The worker writes them after a save; it
  // starts here so notes an earlier run or an import left without one are caught up, and closes with the app.
  const digests = resolveEngineDigests(db, config, engine, activity);
  digests?.worker.start();
  const usefulness = new ReadUsefulness();
  const connection = connectionStatusFromEnv(process.env);
  // The consolidation pass (RENOR_CONSOLIDATE, default off): null, and nothing else changes, unless it is switched on.
  const dreamer = createDreamer(process.env, {
    db,
    vaultPath: config.memoryDir,
    ledgerRelPath: config.ledgerRelPath,
    index: () => engineIndexChanged(db, config, engine),
    hold: run => { activity.track(() => run).catch(() => undefined); },
  });

  const server = buildMcpServer(db, config, engine, activity, digests, usefulness, connection, false, null, false, false, dreamer);

  // An index an earlier build wrote holds the engine's own daily-note headers as facts, and a note that has not changed
  // is never rebuilt, so they are removed here, before anything is read. A failure must not keep a workspace from serving.
  try {
    const removed = removeDailyHeaderFacts(db);
    if (removed > 0) log.info('startup_header_facts_removed', { facts: removed, detail: 'daily-note header facts an earlier build indexed' });
  } catch (err) {
    log.error('startup_header_cleanup_failed', {}, err);
  }

  const app = express();
  // Express's default error page prints the stack, with absolute paths, unless the app is in production mode.
  app.set('env', 'production');
  // No `X-Powered-By: Express`: it names the stack to a scanner and serves no client, and the gateway
  // passes this engine's answers through to mcp.renor.cloud as they are (live-security F5).
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // TEMPORARY (CVE-2026-111497, Brotli decoder < 1.2.1; Node 22 still bundles 1.1.0): no request body is Brotli-decoded.
  // body-parser would inflate `Content-Encoding: br`, so it is refused before any parser sees it. gzip and deflate are unchanged.
  // Remove once a Node 22 release ships Brotli >= 1.2.1.
  app.use((req: express.Request, res: express.Response, next: () => void) => {
    if (/(^|[\s,])br(\s*;|[\s,]|$)/i.test(String(req.headers['content-encoding'] ?? ''))) {
      res.status(415).json({ error: 'unsupported_content_encoding', message: 'Content-Encoding br is not accepted. Send the body plain, gzip or deflate.' });
      return;
    }
    next();
  });

  // ACCESS LOG (diagnostics only): one metadata-only line per HTTP outcome
  // covering every status class, so server-side connector calls (ChatGPT)
  // become visible without any sensitive material. Fields: method, path
  // PREFIX, status, elapsed ms. NEVER bodies, query strings, Authorization
  // headers, codes, tickets, or secrets. The raw query is dropped for ALL
  // paths; /authorize additionally logs only an 8-char client_id prefix.
  const ACCESS_PATH_PREFIXES = ['/register', '/authorize', '/token', '/mvp-login', '/mcp', '/.well-known'];
  const SAFE_PREFIX_RE = /^[A-Za-z0-9_-]{1,8}$/;
  app.use((req: express.Request, res: express.Response, next: () => void) => {
    const startedAt = Date.now();
    // Parse NOW: express routers rewrite req.url while matching, so the
    // original path must be captured before routing begins.
    let pathname = '';
    let clientPrefix: string | undefined;
    try {
      const u = new URL(req.url, 'http://x');
      pathname = u.pathname;
      if (pathname === '/authorize') {
        const raw = u.searchParams.get('client_id') ?? '';
        if (SAFE_PREFIX_RE.test(raw.slice(0, 8))) clientPrefix = raw.slice(0, 8);
      }
    } catch {
      next();
      return; // malformed request line: nothing safe to log
    }
    let logged = false;
    const emit = (closedWithoutFinish: boolean): void => {
      if (logged) return;
      logged = true;
      if (!/^\/[A-Za-z0-9._~/-]*$/.test(pathname)) return; // avoid log injection
      const path =
        ACCESS_PATH_PREFIXES.find(p => pathname === p || pathname.startsWith(p + '/'))
        ?? (ACCESS_PATH_PREFIXES.find(p => pathname.startsWith(p)) ?? pathname);
      const fields: Record<string, string | number> = {
        method: req.method,
        path,
        status: res.statusCode || 0, // 0 = closed before any status was sent
        ms: Date.now() - startedAt,
        instance: (process.env.MVP_INSTANCE_ID ?? 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'unknown',
      };
      if (clientPrefix !== undefined) fields.client_prefix = clientPrefix;
      if (closedWithoutFinish) fields.outcome = 'closed'; // client abort / mid-stream disconnect
      log.info('http_access', fields);
    };
    res.on('finish', () => emit(false));
    res.on('close', () => emit(true)); // aborted or disconnected responses
    next();
  });

  // On-demand: count every request while it is open, refuse new ones once draining.
  // After the access log, so the draining 503s are logged like any other outcome.
  if (idle) app.use(idle.middleware);

  // The activity report counts a POST or DELETE on /mcp from its start until its HTTP response has finished or closed, not
  // until the tool handler returns: a streamed response can still be in delivery then, and a restart would truncate it. A GET
  // is the idle stream a connected agent keeps open, which is not work.
  app.use((req: express.Request, res: express.Response, next: () => void) => {
    if ((req.method === 'POST' || req.method === 'DELETE') && /^\/mcp\/?$/i.test(req.path)) activity.request(res);
    next();
  });

  // Proxy hygiene (FUNNEL): this service NEVER trusts X-Forwarded-* headers
  // (AUTH-B1 stance — they are spoofable client input). Public-test proxies
  // (e.g. the tailscale funnel) append X-Forwarded-For, which makes SDK
  // routes' express-rate-limit throw ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
  // (500s on /register, /token) behind them. Stripping the headers keeps the
  // long-standing no-trust stance and makes rate limiting key on the actual
  // socket peer, as before.
  // MVP_TRUST_PROXY_HOPS > 0 (a platform proxy in front, e.g. Fly, Render, Railway) trusts exactly that many hops: req.ip
  // becomes the address the nearest proxy appended, so each client has its own rate-limit bucket. Entries a client put
  // further left in X-Forwarded-For are never read. Only X-Forwarded-For is kept; the host, proto and port headers are still dropped.
  const trustProxyHops = config.trustProxyHops ?? 0;
  if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);
  app.use((req: express.Request, _res: express.Response, next: () => void) => {
    if (trustProxyHops === 0) delete req.headers['x-forwarded-for'];
    delete req.headers['x-forwarded-host'];
    delete req.headers['x-forwarded-proto'];
    delete req.headers['x-forwarded-port'];
    next();
  });

  // DNS-rebinding guard: a request whose Host is not this service's own name (MVP_BASE_URL) or a loopback name is
  // refused before any route runs. A browser page that rebinds its domain to 127.0.0.1 sends its own Host.
  // Skipped behind the gateway (MVP_GATEWAY_SECRET set): there the tenant's public Host arrives through Caddy by design.
  if (!config.gatewaySecret) app.use(hostHeaderValidation([config.baseUrl.hostname, ...LOCAL_API_HOSTNAMES]));

  // Build identity for deploy verification: which source commit is THIS tenant
  // engine running? No credential is required — the whole purpose is that the
  // operator can verify the deployed revision over SSH without one — but the
  // route is LOOPBACK-ONLY: a request that arrived from a proxy hop or from a
  // non-loopback peer or under a public Host gets the same 404 as any unknown
  // path. Version checks are a deploy instrument, not a product endpoint, so
  // they are not exposed on the public tenant hosts.
  //
  // It returns build metadata ONLY, read through the shared non-throwing helper
  // (src/buildIdentity.ts) that the librarian's GET /api/health also uses: no
  // tenant slug, no memory content, no filesystem or vault paths, no tokens, no
  // counts — and every value has been shape-validated there, so a manifest
  // populated from environment variables cannot reflect through it. `ok` marks
  // the probe itself, not the manifest: an unstamped deployment answers ok with
  // commit "unknown" (never a throw).
  app.get(VERSION_PATH, (req: express.Request, res: express.Response) => {
    // Revalidating probe: a cached answer would fake deploy parity, which is
    // the single thing this route exists to report truthfully.
    res.set('Cache-Control', 'no-store');
    if (!isLocalDirectCall(req)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ ok: true, ...readBuildIdentity() });
  });

  // What the release judge reads before it restarts this engine: how many tool calls are running and how long ago the
  // last one ended. Loopback-only like /version (a proxied or public caller gets the same 404 as any unknown path), no
  // credential, and counts only: no tool name, argument, tenant or path. An open MCP stream is not a tool call, so a
  // connected agent that is not calling anything does not show here.
  app.get(ACTIVITY_PATH, (req: express.Request, res: express.Response) => {
    res.set('Cache-Control', 'no-store');
    if (!isLocalDirectCall(req)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(activity.report());
  });

  // Dynamic client registration is for MCP clients, which are native programs and send no Origin. The SDK answers
  // /register with `Access-Control-Allow-Origin: *`, which lets any website register a client from the owner's browser
  // (and squat a client name for good, or burn the hourly limit). A request that names a foreign Origin is refused, and
  // no response from this route carries a CORS header, so a browser blocks the preflight and the page never sees an answer.
  const CORS_RESPONSE_HEADER = /^access-control-/i;
  app.use('/register', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== config.baseUrl.origin) {
      res.status(403).json({ error: 'forbidden_origin', error_description: 'client registration does not accept requests from a web page' });
      return;
    }
    const writeHead = res.writeHead;
    res.writeHead = function (this: typeof res, ...args: unknown[]) {
      for (const name of res.getHeaderNames()) if (CORS_RESPONSE_HEADER.test(name)) res.removeHeader(name);
      return (writeHead as (...a: unknown[]) => typeof res).apply(this, args);
    } as typeof res.writeHead;
    next();
  });

  // OAuth 2.1 authorization server endpoints (discovery, /authorize, /token,
  // /register, /revocation) — SDK-supported components.
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: config.baseUrl,
    baseUrl: config.baseUrl,
    scopesSupported: ['memory'],
    resourceServerUrl: new URL(MCP_PATH, config.baseUrl),
    resourceName: 'Memory Company (single-owner MVP)',
    // 0 = a confidential client's secret does not lapse after the SDK's 30 days; the persisted registry has no renewal.
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));
  // Owner login form submit.
  app.use('/mvp-login', ownerLoginRouter(provider, config));

  // MCP endpoint: Bearer-token verified before any tool access.
  // SSE-CHATGPT transport modes:
  //  - MVP_MCP_JSON=true (default): stateless JSON responses, exactly the
  //    behavior every existing test pins (no sessions, GET -> 404).
  //  - MVP_MCP_JSON=false: Streamable HTTP with SSE responses. POST replies
  //    text/event-stream and mints an in-process BOUNDED session
  //    (Mcp-Session-Id header); GET /mcp opens the standalone SSE stream on
  //    that session; DELETE terminates it. Sessions are in-memory only,
  //    capped (MVP_MCP_MAX_SESSIONS) and evicted after idle TTL
  //    (MVP_MCP_SESSION_TTL_MS). No platform, no persistence of sessions.
  //    The engine keeps nothing per session (the bearer is the credential), so
  //    a session it has lost costs a client nothing: a POST that names an id
  //    this process does not know (after a restart, a sleep, the TTL sweep or
  //    the cap) is served statelessly instead of answered 404, see
  //    serveForgottenSession. A session whose response is still open (its
  //    stream) is not swept at the TTL and is evicted last at the cap.
  type SseSession = {
    transport: StreamableHTTPServerTransport;
    lastActivity: number;
    /** Responses of this session still open: its standalone stream, or a POST still being answered. */
    open: number;
    /** JSON-RPC request ids (typed, as the SDK keys them) of the POSTs this session is still answering. */
    inFlight: Set<string>;
    /**
     * Whether the session was opened by a directory client (the gateway's x-renor-directory mark). Its tool surface is
     * built once, so a request whose mark differs is refused as an unknown session and the client opens a new one with
     * the right surface, instead of keeping the hive tools after signing in again as a directory client (or losing them
     * the other way round).
     */
    directory: boolean;
  };
  const sseSessions = new Map<string, SseSession>();
  // Ids a client ended with DELETE. The spec answers a terminated session with 404, so a POST that names one is refused
  // instead of served statelessly. Process-local and bounded: the oldest id goes first. After a restart the id is
  // forgotten like any other, and the stateless path serves it.
  const ENDED_SESSION_LIMIT = 1_000;
  const endedSessions = new Set<string>();
  const markSessionEnded = (sid: string): void => {
    endedSessions.delete(sid);
    endedSessions.add(sid);
    if (endedSessions.size > ENDED_SESSION_LIMIT) endedSessions.delete(endedSessions.values().next().value as string);
  };
  // Each authenticated connection name is recorded once, so ask_agent can
  // address it. A process remembers what it already wrote, so a name costs one insert per process, not one per call.
  const namesSeen = new Set<string>();
  const noteConnectionName = (raw: unknown): void => {
    const name = Array.isArray(raw) ? raw[0] : raw;
    // Already agentOf's answer, which applied the rule its connection's kind needs: only the exact rule is left to apply.
    const identity = typeof name === 'string' ? trustedIdentity(name, false) : 'unnamed';
    if (identity === 'unnamed' || namesSeen.has(identity)) return;
    try {
      noteKnownAgent(db, identity);
      namesSeen.add(identity);
    } catch {
      // Recording a name must never fail the call it came with.
    }
  };
  // The SDK's transport maps a request id to its response stream, one id to one stream. Two overlapping POSTs on a
  // session that carry the same id (a client that numbers each call from 1, or several callers behind one session)
  // overwrite each other's entry: one response is delivered, the other stream is never ended and the client waits
  // until its own timeout. Such a POST is served on a transport of its own, as a forgotten session's is.
  const requestIdKey = (m: unknown): string | null => {
    if (!m || typeof m !== 'object' || !('method' in m) || !('id' in m)) return null;
    const id = (m as { id: unknown }).id;
    return typeof id === 'string' || typeof id === 'number' ? `${typeof id}:${id}` : null;
  };
  const requestIdKeys = (body: unknown): string[] => (Array.isArray(body) ? body : [body])
    .map(requestIdKey).filter((k): k is string => k !== null);
  // One batch that repeats an id has the same fault inside a single transport: its responses share one slot, so the
  // client gets fewer answers than it sent requests. The first request of an id runs; each later one is answered with
  // an Invalid Request error that carries its id (JSON-RPC requires ids to be unique within a batch).
  const splitBatchDuplicates = (body: unknown): { kept: unknown[]; dropped: (string | number)[] } | null => {
    if (!Array.isArray(body)) return null;
    const seen = new Set<string>();
    const kept: unknown[] = [];
    const dropped: (string | number)[] = [];
    for (const m of body) {
      const key = requestIdKey(m);
      if (key !== null && seen.has(key)) dropped.push((m as { id: string | number }).id);
      else {
        if (key !== null) seen.add(key);
        kept.push(m);
      }
    }
    return dropped.length > 0 ? { kept, dropped } : null;
  };
  // Appends one error event per refused duplicate to the SSE stream the transport answers the kept requests on.
  const answerDroppedDuplicates = (res: express.Response, dropped: (string | number)[]): void => {
    const origEnd = res.end.bind(res) as (...args: unknown[]) => express.Response;
    res.end = ((...args: unknown[]) => {
      if (!res.writableEnded && /^text\/event-stream/.test(String(res.getHeader('content-type') ?? ''))) {
        for (const id of dropped) {
          const error = { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: duplicate request id in batch' } };
          res.write(`event: message\ndata: ${JSON.stringify(error)}\n\n`);
        }
      }
      return origEnd(...args);
    }) as typeof res.end;
  };
  // A client that repeats ids repeats them on every call, so the warning is limited to one line per session per minute;
  // the lines it withholds are counted on the next one. The table is bounded: the oldest session's entry goes first.
  const DUPLICATE_WARN_INTERVAL_MS = 60_000;
  const DUPLICATE_WARN_SESSIONS = 1000;
  const duplicateWarned = new Map<string, { at: number; suppressed: number }>();
  const warnDuplicateRequestId = (event: string, sid: unknown, now: number): void => {
    // The fact and a hash of the session only: never an id, a name or any content of the call.
    const session = crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 12);
    const seen = duplicateWarned.get(session);
    if (seen && now - seen.at < DUPLICATE_WARN_INTERVAL_MS) {
      seen.suppressed++;
      return;
    }
    duplicateWarned.delete(session);
    duplicateWarned.set(session, { at: now, suppressed: 0 });
    if (duplicateWarned.size > DUPLICATE_WARN_SESSIONS) duplicateWarned.delete(duplicateWarned.keys().next().value as string);
    log.warn(event, seen && seen.suppressed > 0 ? { session, suppressed: seen.suppressed } : { session });
  };
  const holdOpen = (entry: SseSession, res: express.Response): void => {
    if (res.destroyed) return; // the client is already gone: nothing is open
    entry.open++;
    res.once('close', () => { entry.open--; });
  };
  // TTL eviction runs on every MCP request (idle sessions die on their own),
  // except a session that still has a response open: its client is there.
  const evictExpiredSseSessions = (now: number): void => {
    for (const [id, entry] of sseSessions) {
      if (entry.open === 0 && now - entry.lastActivity > config.mcpSessionTtlMs) {
        sseSessions.delete(id);
        void entry.transport.close();
      }
    }
  };
  // Bound eviction runs ONLY when a NEW session is about to be minted: make
  // room by closing the least-recently-active sessions, those with no open
  // response first (a session with a stream goes only when every session has
  // one). (Evicting on every request would wrongly churn live sessions while
  // the map is at the cap.)
  const makeRoomForSseSession = (): void => {
    const held = (entry: SseSession): number => (entry.open > 0 ? 1 : 0);
    while (sseSessions.size >= config.mcpMaxSessions) {
      let victimId: string | null = null;
      let victim: SseSession | null = null;
      for (const [id, entry] of sseSessions) {
        if (victim === null || held(entry) < held(victim)
          || (held(entry) === held(victim) && entry.lastActivity < victim.lastActivity)) {
          victimId = id;
          victim = entry;
        }
      }
      if (victimId === null || victim === null) break;
      sseSessions.delete(victimId);
      void victim.transport.close();
    }
  };
  const requireBearer = async (req: McpRequest, res: express.Response): Promise<AuthInfo | null> => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"').status(401).json({
        jsonrpc: '2.0', error: { code: -32001, message: 'Missing or invalid Authorization bearer token' }, id: null,
      });
      return null;
    }
    try {
      const verified = await provider.verifyAccessToken(auth.slice('Bearer '.length).trim());
      // The SDK forwards req.auth to each call's authInfo, including SSE and forgotten sessions.
      // Resolve the name for THIS bearer on THIS request; a session id is never an identity.
      if (!config.gatewaySecret) {
        delete req.headers['x-renor-agent'];
        verified.extra = { ...verified.extra, connectionName: provider.hiveConnectionName(verified.clientId) };
      }
      req.auth = verified;
      return verified;
    } catch {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"').status(401).json({
        jsonrpc: '2.0', error: { code: -32001, message: 'Missing or invalid Authorization bearer token' }, id: null,
      });
      return null;
    }
  };
  const mcpSessionEntry = (req: express.Request, res: express.Response, now: number) => {
    const sid = req.headers['mcp-session-id'];
    if (typeof sid !== 'string' || sid.length === 0) {
      res.status(400).json({
        jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' }, id: null,
      });
      return null;
    }
    const entry = sseSessions.get(sid);
    if (!entry || entry.directory !== isDirectoryCall(req.headers, config)) {
      res.status(404).json({
        jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null,
      });
      return null;
    }
    entry.lastActivity = now;
    return entry;
  };
  // A POST that names a session this process does not know: the engine restarted or slept, the idle TTL swept the
  // session, or the cap evicted it. Nothing the engine does depends on the session (the bearer, verified before this,
  // is the credential), so the call is answered on a transport of its own instead of with a 404 that ends the
  // client's conversation. Nothing is registered, so this cannot grow the registry and the cap still holds. A GET
  // or DELETE for the same id stays a 404: the standalone stream is the one thing that needs the session, and the 404
  // is how a client learns it has none and opens a new one.
  const serveForgottenSession = async (req: express.Request, res: express.Response): Promise<void> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: this transport serves this one request
      enableJsonResponse: false,
    });
    const sessionServer = buildMcpServer(db, config, engine, activity, digests, usefulness, connection, false, null, isDashboardCall(req.headers, config), isDirectoryCall(req.headers, config), null, toolProfileOf(req.headers, config));
    res.once('close', () => { void transport.close(); void sessionServer.close(); });
    await sessionServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  // Trusted universal gateway → short-lived MCP bearer (users never see owner passwords).
  // LOOPBACK-ONLY, like /version: the gateway calls http://127.0.0.1:<port> directly, and whatever a
  // tenant-site Caddy forwards gets a 404 before the body is read or the secret compared. Without it,
  // a host whose Caddy block lacked the internal-path deny answered the internet: an unlimited oracle
  // for the one secret that mints a bearer for every tenant (live-security F3).
  app.post('/internal/gateway-token', (req: express.Request, res: express.Response, next: () => void) => {
    if (!isLocalDirectCall(req)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  }, express.json({ limit: '4kb' }), async (req, res) => {
    try {
      if (!config.gatewaySecret) {
        res.status(404).json({ error: 'gateway token disabled' });
        return;
      }
      const secret = String(req.headers['x-renor-gateway-secret'] ?? req.body?.secret ?? '');
      const tokens = provider.issueGatewayAccessToken(secret);
      // Beside the bearer, the bytes of Markdown this workspace stores, when known: the gateway records it for the
      // plan's storage meter. This route is loopback-only, so the figure never leaves the host's own gateway.
      const fresh = req.body?.fresh_storage === true;
      const storedBytes = fresh ? await storedSize.readFresh() : storedSize.read();
      res.json(storedBytes === null ? tokens : { ...tokens, stored_bytes: storedBytes, ...(fresh ? { stored_bytes_fresh: true } : {}) });
    } catch {
      res.status(401).json({ error: 'unauthorized' });
    }
  });

  app.post('/internal/gateway-rule-approval-token', (req: express.Request, res: express.Response, next: () => void) => {
    if (!isLocalDirectCall(req)) return void res.status(404).json({ error: 'not found' });
    next();
  }, express.json({ limit: '4kb' }), (req, res) => {
    try {
      if (!config.gatewaySecret) return void res.status(404).json({ error: 'gateway token disabled' });
      const secret = String(req.headers['x-renor-gateway-secret'] ?? req.body?.secret ?? '');
      res.json(provider.issueGatewayRuleApprovalToken(secret));
    } catch {
      res.status(401).json({ error: 'unauthorized' });
    }
  });

  // Server-side end-of-turn capture (captureTurns.ts), reached only through the gateway's POST /capture/turns: loopback
  // and the gateway secret, as the token routes above. Off (403, no model call) unless this workspace opted in.
  const captureTurns = createCaptureTurns({
    env: process.env,
    stateDir: path.dirname(config.authStatePath),
    saveNote: async (text, date) => { await engineRememberNote(config, text, date, CAPTURE_SOURCE); },
    saveRule: captureRuleSaver(db, config.memoryDir, config.ledgerRelPath),
  });
  app.post('/internal/capture-turns', (req: express.Request, res: express.Response, next: () => void) => {
    if (!isLocalDirectCall(req)) return void res.status(404).json({ error: 'not found' });
    next();
  }, express.json({ limit: '64kb' }), async (req, res) => {
    if (!config.gatewaySecret || !gatewaySecretMatches(String(req.headers['x-renor-gateway-secret'] ?? ''), config.gatewaySecret)) {
      return void res.status(401).json({ error: 'unauthorized' });
    }
    const answer = await captureTurns(req.body);
    res.status(answer.status).json(answer.body);
  });

  // The bearer check runs before the body is read, so an unauthenticated caller gets the same 401 whatever it sent,
  // a malformed or oversized body included. The parser runs for authenticated callers only, and its UTF-8 check
  // (requireUtf8Body) refuses a non-UTF-8 body as a JSON-RPC parse error before anything is run.
  const mcpBearer = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    const startedAt = performance.now();
    if (await requireBearer(req as McpRequest, res)) {
      (req as express.Request & { authMs?: number }).authMs = performance.now() - startedAt;
      next();
    }
  };
  const ownerRuleBearer = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return void res.status(401).json({ error: 'unauthorized' });
    try {
      const verified = await provider.verifyAccessToken(auth.slice(7).trim());
      if (verified.scopes.length !== 1 || verified.scopes[0] !== 'rules:approve') throw new Error('wrong scope');
      next();
    } catch { res.status(403).json({ error: 'owner_credential_required' }); }
  };
  app.post('/rules/approvals', ownerRuleBearer, express.json({ limit: '16kb', verify: requireUtf8Body }), (req, res) => {
    if (!ruleApprovalsEnabled()) return res.status(404).json({ error: 'not_found' });
    const action = req.body?.action;
    const keys = req.body?.rule_keys;
    if ((action !== 'approve' && action !== 'revoke') || !Array.isArray(keys) || keys.length === 0
      || keys.length > 100 || keys.some((key: unknown) => typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key))) {
      return res.status(400).json({ error: 'invalid_body', message: 'action must be approve or revoke and rule_keys must be 1-100 lowercase SHA-256 keys' });
    }
    let changed: number;
    try {
      changed = updateRuleApprovals(db, action, keys);
    } catch {
      return res.status(400).json({ error: 'invalid_body', message: action === 'approve'
        ? 'approve targets must be current standing rules saved with an event id'
        : 'revoke targets must be approved standing rules' });
    }
    return res.json({ ok: true, action, count: changed });
  });
  // An authenticated phased read reports its phases in Server-Timing (serverTiming.ts): the rest of its request runs in that
  // timing's async context, so the tool wrapper finds it. Every other request runs as it always did.
  const mcpServerTiming = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const timing = serverTimingFor(req, res, (req as McpRequest).auth);
    if (timing) requestTiming.run(timing, next);
    else next();
  };
  app.post(MCP_PATH, mcpBearer, express.json({ limit: '1mb', verify: requireUtf8Body }), mcpServerTiming, async (req: express.Request, res: express.Response) => {
    const authInfo = (req as McpRequest).auth as AuthInfo;
    if (!authInfo.scopes.includes('mcp') && !authInfo.scopes.includes('memory')) {
      return void res.status(403).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32001, message: 'MCP credential required' } });
    }
    // A tools/call that omits its id is a JSON-RPC notification. The SDK answers 202 and runs the tool when
    // that notification shares a batch with a real request. Refuse the whole body before any handler, so the
    // tool does not run. An explicit id of null is invalid JSON-RPC and is left to the SDK (-32700).
    if (bodyHasToolsCallNotification(req.body)) {
      res.status(200).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32601, message: 'tools/call requires a request id' },
      });
      return;
    }
    // A directory client is not a known agent: nothing can ask it, so its name is not recorded.
    if (!isDirectoryCall(req.headers, config)) noteConnectionName(agentOf({ authInfo, requestInfo: { headers: req.headers } }, config));
    try {
      if (config.mcpJsonResponse) {
        // Stateless streamable HTTP: one transport and one McpServer per request. The SDK binds a server to one
        // transport at a time, so a shared server answered an overlapping request with "Already connected" (500).
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless: one transport per request
          enableJsonResponse: true,
        });
        const requestServer = buildMcpServer(db, config, engine, activity, digests, usefulness, connection, false, null, isDashboardCall(req.headers, config), isDirectoryCall(req.headers, config), null, toolProfileOf(req.headers, config));
        res.on('close', () => { void transport.close(); void requestServer.close(); });
        await requestServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      // SSE session mode (bounded, in-process)
      const now = Date.now();
      const repeated = splitBatchDuplicates(req.body);
      if (repeated) {
        warnDuplicateRequestId('mcp_duplicate_request_id_in_batch', req.headers['mcp-session-id'] ?? '', now);
        req.body = repeated.kept;
        answerDroppedDuplicates(res, repeated.dropped);
      }
      evictExpiredSseSessions(now);
      const sid = req.headers['mcp-session-id'];
      const known = typeof sid === 'string' ? sseSessions.get(sid) : undefined;
      // A session opened under the other surface (see SseSession.directory) is unknown to this request: a 404 makes the
      // client start a new session, whose tools match the token it now holds.
      if (known && known.directory !== isDirectoryCall(req.headers, config)) {
        res.status(404).json({
          jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null,
        });
        return;
      }
      if (known) {
        known.lastActivity = now;
        const keys = requestIdKeys(req.body);
        if (keys.some((k) => known.inFlight.has(k))) {
          warnDuplicateRequestId('mcp_duplicate_request_id', sid, now);
          await serveForgottenSession(req, res);
          return;
        }
        keys.forEach((k) => known.inFlight.add(k));
        res.once('close', () => { keys.forEach((k) => known.inFlight.delete(k)); });
        holdOpen(known, res);
        await known.transport.handleRequest(req, res, req.body);
        return;
      }
      // Only an initialize request may mint a session, whatever id it still carries (an id this process lost).
      if (!isInitializeRequest(req.body)) {
        if (typeof sid === 'string' && endedSessions.has(sid)) {
          res.status(404).json({
            jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null,
          });
          return;
        }
        if (typeof sid === 'string' && sid.length > 0) {
          await serveForgottenSession(req, res);
          return;
        }
        res.status(400).json({
          jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' }, id: null,
        });
        return;
      }
      makeRoomForSseSession();
      const sessionId = crypto.randomBytes(32).toString('base64url');
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId, // fixed per-transport id (minted above)
        enableJsonResponse: false,            // SSE responses on POST
      });
      // one McpServer per session (the SDK binds one transport per Protocol). Its telemetry id is random and unrelated to the
      // session's bearer and transport id, so no log line can be matched to either. A platform session (the dashboard's own
      // calls, isPlatformInitialize) gets no id: it still counts as a connection, but it writes no first call and its mcp_init
      // carries no id for the recall share to join, so the share counts agents only.
      const telemetrySession = isPlatformInitialize(req.body) ? null : crypto.randomBytes(8).toString('hex');
      const sessionServer = buildMcpServer(db, config, engine, activity, digests, usefulness, connection, true, telemetrySession, isDashboardCall(req.headers, config), isDirectoryCall(req.headers, config), dreamer, toolProfileOf(req.headers, config));
      transport.onclose = () => {
        sseSessions.delete(sessionId);
        emitTelemetry({ event: 'session', kind: 'mcp_close' });
        void sessionServer.close();
      };
      const minted: SseSession = { transport, lastActivity: now, open: 0, inFlight: new Set(), directory: isDirectoryCall(req.headers, config) };
      sseSessions.set(sessionId, minted);
      holdOpen(minted, res);
      emitTelemetry({ event: 'session', kind: 'mcp_init', ...(telemetrySession ? { session: telemetrySession } : {}) });
      await sessionServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      res.status(500).json({
        jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null,
      });
    }
  });
  if (!config.mcpJsonResponse) {
    // GET /mcp: standalone SSE stream on an existing session (the SDK keeps
    // the stream open on the session's persistent transport; the 409 single-
    // stream rule and Accept validation are enforced by the SDK itself).
    app.get(MCP_PATH, async (req: express.Request, res: express.Response) => {
      if (!(await requireBearer(req, res))) return;
      evictExpiredSseSessions(Date.now());
      const entry = mcpSessionEntry(req, res, Date.now());
      if (!entry) return;
      holdOpen(entry, res);
      try {
        await entry.transport.handleRequest(req, res);
      } catch {
        if (!res.headersSent) res.status(500).end();
      }
    });
    // DELETE /mcp: explicit session termination (SDK closes the transport;
    // onclose removes it from the bounded registry).
    app.delete(MCP_PATH, async (req: express.Request, res: express.Response) => {
      if (!(await requireBearer(req, res))) return;
      evictExpiredSseSessions(Date.now());
      const entry = mcpSessionEntry(req, res, Date.now());
      if (!entry) return;
      const sid = req.headers['mcp-session-id'] as string;
      try {
        await entry.transport.handleRequest(req, res);
        if (res.statusCode === 200) markSessionEnded(sid);
      } catch {
        if (!res.headersSent) res.status(500).end();
      }
    });
  }

  // The last handler: a body the parser refuses, one over its limit, or a bug. It never renders a stack trace or a file
  // path (self-hosters do not set NODE_ENV=production, and an unauthenticated caller must not see either). The MCP route
  // gets a JSON-RPC body; the stack goes to the server's own log.
  app.use((err: { status?: unknown } | null | undefined, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const status = typeof err?.status === 'number' && Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const message = status === 400 ? 'Parse error'
      : status === 413 ? 'Request body too large'
        : status === 415 ? 'Unsupported media type'
          : status >= 500 ? 'Internal error' : 'Invalid Request';
    if (status >= 500) log.error('http_unhandled', { status }, err);
    if (req.path === MCP_PATH) {
      const code = status === 400 ? -32700 : status >= 500 ? -32603 : -32600;
      res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
      return;
    }
    res.status(status).json({ error: message });
  });

  // Idempotent: an idle exit and a SIGTERM can both ask for it.
  let closing: Promise<void> | null = null;
  const mcpApp: MvpApp = {
    app,
    server,
    provider,
    db,
    engine,
    embeddingRebuild: rebuild?.done ?? Promise.resolve(),
    idle,
    digests,
    reindexPending: pendingPass,
    dreamer,
    close: () => {
      closing ??= (async () => {
        // First: it is background work, and what it has started it finishes before the database closes.
        dreamer?.stop();
        await dreamer?.inFlight()?.catch(() => undefined);
        runningEmbeddingRebuild(engine)?.abort();
        runningBackgroundIndex(db)?.abort();
        // The digest worker uses the database too: its sweep in flight ends before the database closes.
        await digests?.worker.close();
        for (const [, entry] of sseSessions) void entry.transport.close();
        sseSessions.clear();
        await server.close();
        // A rebuild uses the database, so each one still running ends first, including one an import started meanwhile.
        for (let running = runningEmbeddingRebuild(engine); running; running = runningEmbeddingRebuild(engine)) {
          running.abort();
          await running.done;
        }
        // The background index uses the database too; a save that was still running may start another, so look again.
        for (let running = runningBackgroundIndex(db); running; running = runningBackgroundIndex(db)) {
          running.abort();
          await running.done;
        }
        stopHandoffSweep?.();
        db.close();
        // The query cache this process opened (an injected provider is its owner's to close).
        if (engineOverride === undefined) (engine.provider as { close?: () => void } | null)?.close?.();
      })();
      return closing;
    },
  };
  return mcpApp;
}

export { sanitizeErrorMessage };

/**
 * Startup for the MVP service: open the derived index, AWAIT the ledger replay
 * (fail closed on corruption — never serve stale/absent memories), then listen.
 *
 * With on-demand on, `idleExit` resolves once the engine has been idle for the
 * configured period and has stopped listening; the caller then closes and exits.
 */
export async function startMvpService(config: MvpConfig, engineOverride?: EmbeddingProvider | null): Promise<MvpApp & { httpServer: import('http').Server; idleExit: Promise<void> | null }> {
  const mvp = createMvpApp(config, engineOverride);
  let httpServer: import('http').Server;
  try {
    // Restart recovery: replay the authoritative ledger before readiness.
    // Start-up is the one place a torn final event is set aside: nothing else is appending to this ledger yet.
    await replayLedger(mvp.db, config.memoryDir, config.ledgerRelPath, { setTornTailAside: true });
    mvp.dreamer?.start();
    // The notes of a folder that moved were removed from the index with their old paths: they are indexed at their
    // current paths before the service listens, so the first answer has them. The mark is cleared only by a pass with no
    // failed file. A file whose embedding the provider still refuses after its retries counts as failed: it keeps its
    // chunks (keyword search finds them), stays unfinished, and the next start runs the pass again.
    if (mvp.reindexPending) {
      const pass = await engineIndex(mvp.db, config, mvp.engine);
      if (pass.errors === 0) clearReindexPending(mvp.db);
      else log.error('startup_index_incomplete', { failedFiles: pass.errors, detail: 'the next start runs the pass again' });
    }
    // Bind by listening, not by the callback Express gives: `app.listen` routes a bind failure to
    // that same callback as a success, so a promise waiting on it resolves with a server that never
    // listened — the caller is told it started while another process answers on the port. Owning
    // both events here makes a port that is taken a start failure, with the listen error intact.
    const srv = mvp.app.listen(config.port, config.host ?? '127.0.0.1');
    httpServer = await new Promise<import('http').Server>((resolve, reject) => {
      srv.once('listening', () => resolve(srv));
      srv.once('error', reject);
    });
  } catch (err) {
    // A start that failed owns nothing. `createMvpApp` already opened the database and may have started the
    // boot rebuild, and the caller never receives `mvp` — a rejection cannot be caught and retried on another
    // port without leaking them. Close them here, which also waits for the rebuild the way every close does,
    // then report why the start failed rather than a cleanup failure.
    await mvp.close().catch(() => {});
    throw err;
  }
  const idleExit = mvp.idle ? mvp.idle.start().then(() => stopListening(httpServer)) : null;
  return { ...mvp, httpServer, idleExit };
}

/**
 * Stops accepting connections and closes the open ones. Draining only begins with no
 * request in flight (every request is counted before any handler runs), so what is left
 * is idle keep-alive sockets or ones still sending headers: closing them cuts no work.
 */
function stopListening(httpServer: import('http').Server): Promise<void> {
  return new Promise((resolve) => {
    httpServer.close(() => resolve());
    httpServer.closeAllConnections();
  });
}

export const MVP_MCP_PATH = MCP_PATH;

export const MVP_VERSION_PATH = VERSION_PATH;
