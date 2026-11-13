import net from 'net';
import path from 'path';
import { learningSettings, type LearningSettings } from '../learning/settings';
import { sharingDirFor } from '../sharing/state';
import { compileCacheOverlap } from './compileCache';

/**
 * Single-user ChatGPT MVP configuration (MVP-CHATGPT.md scope).
 *
 * Exactly one owner and one dedicated NEW product memory directory. No
 * automatic import of personal vault/VPS data. The directory holds:
 *   - the canonical Markdown ledger (System/Memory Events Ledger.md),
 *   - a derived SQLite index under .memory-index/ (rebuildable, never the
 *     sole holder of accepted memories),
 * and is configured exclusively via environment variables — never hardcoded,
 * never a personal path.
 */
export interface MvpConfig {
  /** Dedicated owner memory directory (the "vault" for this MVP). */
  memoryDir: string;
  /** Derived SQLite index path inside the memory dir. */
  dbPath: string;
  /** Relative ledger path inside the memory dir. */
  ledgerRelPath: string;
  /** Public base URL of this service (issuer + resource identifier). */
  baseUrl: URL;
  /** HTTP port to listen on. */
  port: number;
  /**
   * Address to listen on (MVP_HOST). Loopback unless the operator names another IP literal, e.g. `0.0.0.0`
   * inside a container whose platform proxy is the only way in. Optional so hand-built test configs keep loopback.
   */
  host?: string;
  /**
   * Reverse proxies between the internet and this server (MVP_TRUST_PROXY_HOPS, default 0). At 0 a client is its socket
   * peer and every X-Forwarded-* header is dropped. At N the address the Nth proxy appended to X-Forwarded-For is the
   * client, so each remote client gets its own login and OAuth rate-limit bucket instead of all sharing the proxy's.
   */
  trustProxyHops?: number;
  /** The single owner identity that may authorize (login email). */
  ownerEmail: string;
  /** Owner login secret. Env-only; never stored in Git or the memory dir. */
  ownerPassword: string;
  /** Access token lifetime in seconds. */
  accessTokenTtlSeconds: number;
  /** Shared secret for /internal/gateway-token (gateway only). Empty = disabled. */
  gatewaySecret: string;
  /**
   * Owner-approved exact callback URIs for dynamic client registration.
   * DCR is DENY BY DEFAULT: empty list => no client may register. No
   * wildcards — only exact string matches (AUTH-B1).
   */
  allowedCallbackUris: string[];
  /** Failed-login attempts before lockout (AUTH-B3). */
  loginMaxFailures: number;
  /** Lockout window in ms (doubles per extra failure, capped) (AUTH-B3). */
  loginLockoutMs: number;
  /**
   * Explicit promoted-history directory (optional; enables search_history).
   * This is the additive directory the reviewed promotion command fills —
   * never a raw export, staging, or the vault at large. Null when unset.
   */
  historyDir: string | null;
  /**
   * Explicit private path of the persistent OAuth client registry
   * (CLIENT-PERSISTENCE). The file must live in an owner-only (0700)
   * directory OUTSIDE the memory and history trees so client secrets can
   * never surface in Markdown, exports, history, or Git. Validated and
   * strictly schema-checked at startup; corrupt state fails closed.
   */
  authStatePath: string;
  /**
   * MCP transport mode (SSE-CHATGPT). Default true = today's stateless
   * JSON responses (existing behavior, all tests). False = Streamable HTTP
   * with SSE responses: POST replies text/event-stream and GET /mcp opens
   * a standalone SSE stream via an in-process BOUNDED session registry —
   * required by clients (e.g. the ChatGPT connector) that reject JSON-only
   * MCP responses.
   */
  mcpJsonResponse: boolean;
  /** Max concurrent MCP sessions (SSE mode only; bounded store). */
  mcpMaxSessions: number;
  /** Idle-session eviction TTL in ms (SSE mode only). */
  mcpSessionTtlMs: number;
  /**
   * Embedding factory for semantic search / indexing (ADR-0003).
   * `none` (default): no provider; search_memory returns a structured error.
   * `local`: Xenova e5 (tests should stub; never mix into a Voyage book).
   * `openai`: OpenAI-compatible (Voyage, etc.) — for Voyage / OpenAI-shaped APIs.
   * `vertex`: Vertex AI gemini-embedding-001 (GCP credits; service-account key file).
   * Dimensions must match the sqlite-vec table; do not mix providers in one book.
   */
  embeddingProvider: 'none' | 'local' | 'openai' | 'vertex' | 'eval-hash';
  embeddingApiKey?: string;
  embeddingModel?: string;
  embeddingBaseURL?: string;
  embeddingDims?: number;
  /** Absolute path to Vertex service-account JSON (provider=vertex only). */
  vertexKeyFile?: string;
  /** GCP project id for Vertex (provider=vertex only). */
  vertexProject?: string;
  /** Vertex location, e.g. europe-west4 (provider=vertex only; required, no default). */
  vertexLocation?: string;
  /** Optional explicit SQLite path (reuse an existing index.db). Default: memoryDir/.memory-index/index.db */
  explicitDbPath: string | null;
  /**
   * On-demand idle exit (RENOR_ON_DEMAND=1): exit cleanly after this long with no work in
   * flight; the gateway starts the engine again on the next request. Null or absent = off,
   * the default: the engine runs until it is stopped.
   */
  idleExitMs?: number | null;
  /**
   * This workspace's own Node compile cache, when one is configured.
   *
   * Node's module compile cache is a WRITE, and a cold start that does not read one pays to
   * compile every module again (measured on an empty workspace: the o200k_base table alone is
   * ~205 ms, and the whole module-load phase ~930 ms). Each workspace must therefore own its
   * cache directory: workspaces run as separate OS accounts, so one shared directory would be a
   * cross-tenant write channel.
   *
   * NULL when unset, and a refusal is never fatal — this is a speed optimisation, not a
   * correctness input. A cache directory that is NOT disjoint from the memory, history or auth
   * trees is rejected outright rather than silently accepted, because those trees are the user's
   * data and Node's cache blobs do not belong in them.
   */
  compileCacheDir: string | null;
  /**
   * The learning log (RENOR_LEARNING_LOG and its two companions, src/learning/settings.ts). Off unless RENOR_LEARNING_LOG=1:
   * with it off no file is made and no call is recorded. Optional so a test may build a config without it.
   */
  learning?: LearningSettings;
  /**
   * The folder holding this workspace's choice to share learning data (src/sharing): its consent record and what the sender needs.
   * One per memory folder, so one per workspace. Nothing is written there until the owner chooses a level above off.
   */
  sharingDir?: string;
}

export const DEFAULT_LEDGER_REL = 'System/Memory Events Ledger.md';

/** Values printed in the documentation (and the commonest guesses): anyone who has read the README can sign in with them. */
const KNOWN_WEAK_OWNER_PASSWORDS = new Set([
  'replace-this-password', 'choose-a-long-secret', '<owner-secret>', 'owner-secret', 'your-password-here',
  'password', 'password1', 'password123', '12345678', '123456789', 'qwertyui', 'qwerty123', 'changeme', 'change-me', 'letmein1',
]);

function weakOwnerPasswordReason(password: string): string | null {
  const lower = password.toLowerCase();
  if (KNOWN_WEAK_OWNER_PASSWORDS.has(lower)) return 'it is an example value from the documentation or a very common password';
  if (new Set(lower).size === 1) return 'it is one character repeated';
  return null;
}

function requiredEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required configuration ${name}: ${hint}`);
  }
  return value.trim();
}

/**
 * Where this workspace keeps its Node compile cache.
 *
 * Three properties, each a correctness property rather than taste:
 *
 *  - INSIDE this workspace's own state tree, named explicitly: provision-renor-tenant.sh writes
 *    `/var/lib/renor/<slug>/cache/compile` into every env file, and that whole tree is the unit's
 *    only ReadWritePaths entry. There is NO derived default (null when unset): a path worked out
 *    from the memory directory can land in a shared place such as /tmp/cache/compile.
 *  - NEVER inside a data tree. The memory directory is indexed and exported, the history directory
 *    is promoted transcripts, and the auth path holds client secrets; Node's compiled-code blobs
 *    belong in none of them. Overlap in EITHER direction throws.
 *  - NEVER shared. Overlap is checked against THIS workspace's trees, but a path pointing into a
 *    sibling workspace is not detectable from inside this process — so the provisioner derives
 *    the path per workspace instead of reading a shared configuration value, and refuses an env
 *    file that names anything else.
 */
function resolveCompileCacheDir(
  memoryDir: string,
  historyDir: string | null,
  authStatePath: string,
): string | null {
  const raw = (process.env.MVP_COMPILE_CACHE_DIR ?? '').trim();
  if (raw === '') return null;
  const dir = path.resolve(raw);
  const refusal = compileCacheOverlap(dir, { memoryDir, historyDir, authStatePath });
  if (refusal !== null) throw new Error(refusal);
  return dir;
}

export function loadMvpConfig(): MvpConfig {
  const memoryDir = requiredEnv(
    'MVP_MEMORY_DIR',
    'dedicated owner memory directory for this product (create a NEW folder, e.g. ~/memory-company-data)',
  );
  const port = Number(process.env.MVP_PORT ?? 3471);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('MVP_PORT must be an integer between 1 and 65535');
  }
  const host = (process.env.MVP_HOST ?? '').trim() || '127.0.0.1';
  if (net.isIP(host) === 0) {
    throw new Error(`MVP_HOST must be an IP address such as 127.0.0.1 or 0.0.0.0, not ${host}`);
  }
  const baseUrlRaw = requiredEnv(
    'MVP_BASE_URL',
    'the externally reachable base URL of this service, e.g. http://localhost:3471 for local tests or your public https URL for ChatGPT',
  );
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    throw new Error(`MVP_BASE_URL is not a valid URL: ${baseUrlRaw}`);
  }
  if (baseUrl.hash || baseUrl.search) {
    throw new Error('MVP_BASE_URL must not contain a query or fragment');
  }
  // A public bind serves the owner's password and tokens to whoever can reach it, so it needs https in front. A base
  // URL that names this machine (http://localhost:3471 for a published container port) is not reachable from outside.
  const loopbackHost = host === '::1' || host.startsWith('127.');
  const loopbackBase = baseUrl.hostname === 'localhost' || baseUrl.hostname === '[::1]' || /^127\./.test(baseUrl.hostname);
  if (!loopbackHost && baseUrl.protocol !== 'https:' && !loopbackBase) {
    throw new Error(
      `MVP_HOST=${host} listens beyond this machine, so MVP_BASE_URL must be an https:// URL (got ${baseUrl.origin}). `
      + 'Put a TLS proxy in front and set MVP_BASE_URL to its address, or leave MVP_HOST on 127.0.0.1.',
    );
  }
  const trustProxyHops = Number((process.env.MVP_TRUST_PROXY_HOPS ?? '0').trim() || 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
    throw new Error('MVP_TRUST_PROXY_HOPS must be an integer between 0 and 5');
  }
  // Trusting a hop makes the Nth address from the right the client. On a public bind with fewer real proxies than
  // claimed (a client reaching the port directly, or a misconfigured platform), the client writes that address and walks
  // around the per-client login limit; above 1 the same is true even behind one proxy. Either is a deliberate act.
  if (trustProxyHops > 0 && (!loopbackHost || trustProxyHops > 1) && process.env.MVP_TRUST_PROXY_HOPS_ACK_SPOOFING !== '1') {
    throw new Error(
      `MVP_TRUST_PROXY_HOPS=${trustProxyHops} on ${loopbackHost ? 'a loopback' : 'a public'} bind lets a client choose its own address if fewer proxies are really in front, and so evade the login limit. `
      + 'Set it only to the real number of proxies in front, and set MVP_TRUST_PROXY_HOPS_ACK_SPOOFING=1 to confirm.',
    );
  }
  // Owner identity: the ONLY account that can complete authorization.
  const ownerEmail = requiredEnv(
    'MVP_OWNER_EMAIL',
    'the single owner login email; no other identity may authorize',
  ).toLowerCase();
  const ownerPassword = requiredEnv(
    'MVP_OWNER_PASSWORD',
    'the owner login secret (env-only; never commit it to Git or write it into the memory directory)',
  );
  if (ownerPassword.length < 8) {
    throw new Error('MVP_OWNER_PASSWORD must be at least 8 characters');
  }
  // The README's example is public: anyone who can reach the login page signs in with it, so refuse to start on it.
  const weakReason = weakOwnerPasswordReason(ownerPassword);
  if (weakReason) {
    throw new Error(`MVP_OWNER_PASSWORD is too weak: ${weakReason}. Choose your own secret, for example: export MVP_OWNER_PASSWORD="$(openssl rand -base64 18)"`);
  }
  const accessTokenTtlSeconds = Number(process.env.MVP_ACCESS_TOKEN_TTL_SECONDS ?? 3600);
  if (!Number.isFinite(accessTokenTtlSeconds) || accessTokenTtlSeconds < 60) {
    throw new Error('MVP_ACCESS_TOKEN_TTL_SECONDS must be at least 60');
  }
  // AUTH-B1: exact callback-URI allowlist for DCR. Deny by default: unset or
  // empty means NO client may register until the owner names exact callbacks.
  const allowedCallbackUris = (process.env.MVP_ALLOWED_CALLBACK_URIS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  for (const uri of allowedCallbackUris) {
    try {
      new URL(uri);
    } catch {
      throw new Error(`MVP_ALLOWED_CALLBACK_URIS contains an invalid URL: ${uri}`);
    }
    if (/[\s]/.test(uri)) {
      throw new Error('MVP_ALLOWED_CALLBACK_URIS entries must be exact URIs without whitespace');
    }
  }
  // AUTH-B3: bounded failed-login limiter knobs (operator-tunable, sane defaults).
  const loginMaxFailures = Number(process.env.MVP_LOGIN_MAX_FAILURES ?? 5);
  if (!Number.isInteger(loginMaxFailures) || loginMaxFailures < 1 || loginMaxFailures > 100) {
    throw new Error('MVP_LOGIN_MAX_FAILURES must be an integer between 1 and 100');
  }
  const loginLockoutMs = Number(process.env.MVP_LOGIN_LOCKOUT_MS ?? 30_000);
  if (!Number.isInteger(loginLockoutMs) || loginLockoutMs < 1 || loginLockoutMs > 3_600_000) {
    throw new Error('MVP_LOGIN_LOCKOUT_MS must be an integer between 1 and 3600000');
  }
  const memoryDirResolved = path.resolve(memoryDir);
  // CLIENT-PERSISTENCE: explicit private OAuth client-registry path. The
  // registry holds registered client metadata (incl. client secrets), so it
  // must live outside the memory and history trees in both directions.
  const authStatePathRaw = requiredEnv(
    'MVP_AUTH_STATE_PATH',
    'private path of the persistent OAuth client registry, e.g. /path/to/private-runtime/auth/clients.json '
    + '(file inside a NEW owner-only 0700 directory OUTSIDE the memory/history/export directories; never in Git)',
  );
  const authStatePath = path.resolve(authStatePathRaw);
  // SSE-CHATGPT: transport mode. Default stays JSON (stateless) — the exact
  // behavior every existing test pins. 'false'/'0' opts into SSE responses.
  const gatewaySecret = (process.env.MVP_GATEWAY_SECRET ?? '').trim();
  const mcpJsonRaw = (process.env.MVP_MCP_JSON ?? 'true').trim().toLowerCase();
  if (mcpJsonRaw !== 'true' && mcpJsonRaw !== 'false' && mcpJsonRaw !== '1' && mcpJsonRaw !== '0') {
    throw new Error('MVP_MCP_JSON must be true or false');
  }
  const mcpJsonResponse = mcpJsonRaw === 'true' || mcpJsonRaw === '1';
  const mcpMaxSessions = Number(process.env.MVP_MCP_MAX_SESSIONS ?? 100);
  // Each retained session holds a full MCP server (about 0.3 MB measured), so the ceiling is 1,000: 10,000 would
  // extrapolate to roughly 3 GB of heap, past Node's default limit.
  if (!Number.isInteger(mcpMaxSessions) || mcpMaxSessions < 1) {
    throw new Error('MVP_MCP_MAX_SESSIONS must be an integer of at least 1');
  }
  if (mcpMaxSessions > 1_000) {
    throw new Error(`MVP_MCP_MAX_SESSIONS is ${mcpMaxSessions}; the largest accepted value is 1000 (each session costs about 0.3 MB of heap)`);
  }
  const mcpSessionTtlMs = Number(process.env.MVP_MCP_SESSION_TTL_MS ?? 3_600_000);
  if (!Number.isInteger(mcpSessionTtlMs) || mcpSessionTtlMs < 1_000 || mcpSessionTtlMs > 86_400_000) {
    throw new Error('MVP_MCP_SESSION_TTL_MS must be an integer between 1000 and 86400000');
  }
  const embeddingRaw = (process.env.MVP_EMBEDDING_PROVIDER ?? process.env.EMBEDDING_PROVIDER ?? 'none').trim().toLowerCase();
  // The replay harness only (scripts/eval/replay-sweep): RENOR_REPLAY_HASH_EMBEDDINGS=1 replaces `none` with the offline
  // lexical-hash stand-in so the semantic path can be replayed for structure, tokens and latency. It makes no quality
  // claim, and a production or hosted process refuses it.
  const replayHash = (process.env.RENOR_REPLAY_HASH_EMBEDDINGS ?? '').trim() === '1';
  if (replayHash) {
    if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production' || gatewaySecret || (process.env.MVP_INSTANCE_ID ?? '').trim()) {
      throw new Error('RENOR_REPLAY_HASH_EMBEDDINGS is for the replay harness only; it is refused when NODE_ENV=production or a hosted setting (MVP_GATEWAY_SECRET, MVP_INSTANCE_ID) is present');
    }
    if (embeddingRaw !== 'none') throw new Error('RENOR_REPLAY_HASH_EMBEDDINGS=1 needs MVP_EMBEDDING_PROVIDER unset or none');
  }
  if (embeddingRaw !== 'none' && embeddingRaw !== 'local' && embeddingRaw !== 'openai' && embeddingRaw !== 'vertex') {
    throw new Error('MVP_EMBEDDING_PROVIDER must be none, local, openai, or vertex');
  }
  const embeddingProvider = (replayHash ? 'eval-hash' : embeddingRaw) as MvpConfig['embeddingProvider'];
  let embeddingApiKey: string | undefined;
  let embeddingModel: string | undefined;
  let embeddingBaseURL: string | undefined;
  let embeddingDims: number | undefined;
  let vertexKeyFile: string | undefined;
  let vertexProject: string | undefined;
  let vertexLocation: string | undefined;
  if (embeddingProvider === 'openai') {
    const key = (process.env.MVP_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim();
    if (!key) throw new Error('MVP_EMBEDDING_API_KEY (or OPENAI_API_KEY) is required when MVP_EMBEDDING_PROVIDER=openai');
    embeddingApiKey = key;
    embeddingModel = (process.env.MVP_EMBEDDING_MODEL ?? process.env.EMBEDDING_MODEL ?? 'voyage-4-large').trim();
    embeddingBaseURL = (process.env.MVP_EMBEDDING_BASE_URL ?? process.env.EMBEDDING_BASE_URL ?? 'https://api.voyageai.com/v1').trim();
    const dimsRaw = process.env.MVP_EMBEDDING_DIMS ?? process.env.EMBEDDING_DIMS ?? '1024';
    embeddingDims = Number(dimsRaw);
    if (!Number.isInteger(embeddingDims) || embeddingDims < 8 || embeddingDims > 8192) {
      throw new Error('MVP_EMBEDDING_DIMS must be an integer between 8 and 8192');
    }
  } else if (embeddingProvider === 'vertex') {
    const keyFile = (
      process.env.MVP_VERTEX_KEY_FILE
      ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
      ?? process.env.RENOR_EVAL_VERTEX_KEY_FILE
      ?? ''
    ).trim();
    if (!keyFile) {
      throw new Error('MVP_VERTEX_KEY_FILE (or GOOGLE_APPLICATION_CREDENTIALS) is required when MVP_EMBEDDING_PROVIDER=vertex');
    }
    vertexKeyFile = path.resolve(keyFile);
    vertexProject = (
      process.env.MVP_VERTEX_PROJECT
      ?? process.env.RENOR_EVAL_VERTEX_PROJECT
      ?? ''
    ).trim();
    if (!/^[a-z0-9-]+$/.test(vertexProject)) {
      throw new Error('MVP_VERTEX_PROJECT (or RENOR_EVAL_VERTEX_PROJECT) is required when MVP_EMBEDDING_PROVIDER=vertex');
    }
    vertexLocation = (
      process.env.MVP_VERTEX_LOCATION
      ?? process.env.RENOR_EVAL_VERTEX_LOCATION
      ?? ''
    ).trim();
    if (!vertexLocation) {
      throw new Error('MVP_VERTEX_LOCATION (or RENOR_EVAL_VERTEX_LOCATION) is required when MVP_EMBEDDING_PROVIDER=vertex');
    }
    if (!/^[a-z0-9-]+$/.test(vertexLocation)) {
      throw new Error('MVP_VERTEX_LOCATION must be a valid GCP location like europe-west4');
    }
    embeddingModel = (process.env.MVP_EMBEDDING_MODEL ?? process.env.EMBEDDING_MODEL ?? process.env.RENOR_EVAL_MODEL ?? 'gemini-embedding-001').trim();
    const dimsRaw = process.env.MVP_EMBEDDING_DIMS ?? process.env.EMBEDDING_DIMS ?? process.env.RENOR_EVAL_EMBEDDING_DIMS ?? '768';
    embeddingDims = Number(dimsRaw);
    if (!Number.isInteger(embeddingDims) || ![768, 1536, 3072].includes(embeddingDims)) {
      throw new Error('MVP_EMBEDDING_DIMS for vertex must be 768, 1536, or 3072');
    }
  } else if (embeddingProvider === 'local') {
    embeddingModel = (process.env.MVP_EMBEDDING_MODEL ?? process.env.EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-base').trim();
    const dimsRaw = process.env.MVP_EMBEDDING_DIMS ?? process.env.EMBEDDING_DIMS;
    if (dimsRaw) {
      embeddingDims = Number(dimsRaw);
      if (!Number.isInteger(embeddingDims) || embeddingDims < 8 || embeddingDims > 8192) {
        throw new Error('MVP_EMBEDDING_DIMS must be an integer between 8 and 8192');
      }
    }
  }
  let explicitDbPath: string | null = null;
  const rawDb = process.env.MVP_DB_PATH;
  if (rawDb && rawDb.trim() !== '') {
    explicitDbPath = path.resolve(rawDb.trim());
    if (explicitDbPath.endsWith('.md')) {
      throw new Error('MVP_DB_PATH must not be a Markdown file');
    }
  }
  // On-demand (RENOR_ON_DEMAND): the one switch, off unless explicitly on. Only enable it
  // for a workspace whose clients reach it through the gateway, with the gateway's own
  // RENOR_ON_DEMAND on: nothing else starts a sleeping engine.
  const onDemandRaw = (process.env.RENOR_ON_DEMAND ?? '').trim().toLowerCase();
  if (!['', '0', 'false', '1', 'true'].includes(onDemandRaw)) {
    throw new Error('RENOR_ON_DEMAND must be 1/true or 0/false');
  }
  let idleExitMs: number | null = null;
  if (onDemandRaw === '1' || onDemandRaw === 'true') {
    const idleSeconds = Number(process.env.RENOR_ON_DEMAND_IDLE_SECONDS ?? 600);
    if (!Number.isInteger(idleSeconds) || idleSeconds < 1 || idleSeconds > 86_400) {
      throw new Error('RENOR_ON_DEMAND_IDLE_SECONDS must be an integer between 1 and 86400');
    }
    idleExitMs = idleSeconds * 1000;
  }
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep);
  if (overlaps(authStatePath, memoryDirResolved)) {
    throw new Error('MVP_AUTH_STATE_PATH must not be inside the fact memory directory (MVP_MEMORY_DIR)');
  }
  if (authStatePath.endsWith('.md')) {
    throw new Error('MVP_AUTH_STATE_PATH must not be a Markdown file');
  }
  // Promoted-history directory: optional, explicit, and strictly disjoint
  // from the fact memory directory (no overlap in either direction).
  let historyDir: string | null = null;
  const rawHistoryDir = process.env.MVP_HISTORY_DIR;
  if (rawHistoryDir && rawHistoryDir.trim() !== '') {
    historyDir = path.resolve(rawHistoryDir.trim());
    const inside = (a: string, b: string) => a !== b && b.startsWith(a + path.sep);
    if (historyDir === memoryDirResolved
        || inside(historyDir, memoryDirResolved)
        || inside(memoryDirResolved, historyDir)) {
      throw new Error('MVP_HISTORY_DIR must not be equal to or overlap the fact memory directory (MVP_MEMORY_DIR)');
    }
    if (overlaps(authStatePath, historyDir) || overlaps(historyDir, authStatePath)) {
      throw new Error('MVP_AUTH_STATE_PATH must not be equal to or overlap the promoted history directory (MVP_HISTORY_DIR)');
    }
  }
  // This workspace's own compile cache. A wrong location is REFUSED, not repaired: silently
  // relocating it would hide the misconfiguration that, in a shared directory, is precisely the
  // cross-tenant write this exists to prevent.
  const compileCacheDir = resolveCompileCacheDir(memoryDirResolved, historyDir, authStatePath);
  return {
    memoryDir: memoryDirResolved,
    dbPath: explicitDbPath ?? path.join(path.resolve(memoryDir), '.memory-index', 'index.db'),
    ledgerRelPath: process.env.MVP_LEDGER_REL ?? DEFAULT_LEDGER_REL,
    baseUrl,
    port,
    host,
    trustProxyHops,
    ownerEmail,
    ownerPassword,
    accessTokenTtlSeconds,
    gatewaySecret,
    allowedCallbackUris,
    loginMaxFailures,
    loginLockoutMs,
    historyDir,
    authStatePath,
    mcpJsonResponse,
    mcpMaxSessions,
    mcpSessionTtlMs,
    embeddingProvider,
    embeddingApiKey,
    embeddingModel,
    embeddingBaseURL,
    embeddingDims,
    vertexKeyFile,
    vertexProject,
    vertexLocation,
    explicitDbPath,
    idleExitMs,
    compileCacheDir,
    learning: learningSettings(memoryDirResolved),
    sharingDir: sharingDirFor(memoryDirResolved),
  };
}
