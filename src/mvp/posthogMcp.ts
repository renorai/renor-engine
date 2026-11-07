import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PostHog } from 'posthog-node';
import { createHash } from 'node:crypto';
import { telemetryInstanceId } from './telemetry';

/** Shape of the payload passed to @posthog/mcp beforeSend (not re-exported by the package). */
export type McpAnalyticsCaptureEvent = {
  distinct_id: string;
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  type: 'capture';
};

/**
 * PostHog MCP Analytics (@posthog/mcp) for the production MVP server.
 *
 * Privacy defaults match Renor's contract: never capture tool args, results,
 * memory content, queries, or model/conversation text. Instrumentation is a
 * no-op when RENOR_POSTHOG_KEY is missing or RENOR_TELEMETRY_DISABLED=true.
 */

const DEFAULT_HOST = 'https://us.i.posthog.com';

// The two packages are ~130 modules and ~110 ms of a cold start (measured with scripts/bench/cold-start.ts), and a
// workspace without RENOR_POSTHOG_KEY, or with remote telemetry off, never calls into them (instrumentMcpServer returns
// first). They are loaded here, on the first call that needs them, which is the same moment a configured workspace
// loaded them before: createMvpApp builds its first server before the service listens.
const loadPosthogNode = (): typeof import('posthog-node') => require('posthog-node');
const loadPosthogMcp = (): typeof import('@posthog/mcp') => require('@posthog/mcp');

/**
 * The properties an @posthog/mcp event may keep, and nothing else: a property nobody listed is dropped, so a field a later
 * release of the library adds never leaves the process unreviewed. Each one is a value the SERVER decides (its own tool
 * and server names), a number or a boolean, or a closed set. What an MCP client declares about itself (clientInfo.name,
 * its version, its user agent) is the client's own free text and can be a person's name or email, so it never leaves as
 * written: the name is reduced to a client family below and the rest is dropped.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const KEEP_IF: Record<string, (value: unknown) => boolean> = {
  $mcp_tool_name: (v) => typeof v === 'string' && IDENTIFIER.test(v),
  $mcp_is_error: (v) => typeof v === 'boolean',
  $mcp_duration_ms: (v) => typeof v === 'number' && Number.isFinite(v),
  $mcp_server_name: (v) => typeof v === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v),
  $mcp_server_version: (v) => typeof v === 'string' && /^\d+(\.\d+){0,3}$/.test(v),
  $mcp_protocol_version: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  $mcp_listed_tool_names: (v) => Array.isArray(v) && v.length <= 64 && v.every((n) => typeof n === 'string' && IDENTIFIER.test(n)),
  $mcp_source: (v) => v === 'posthog_mcp_analytics',
  $process_person_profile: (v) => v === false,
  service: (v) => v === 'renor-core',
  $groups: (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const entries = Object.entries(v);
    return entries.length === 1 && entries[0][0] === 'tenant' && typeof entries[0][1] === 'string' && /^[0-9a-f]{24}$/.test(entries[0][1]);
  },
};

/**
 * The client families `$mcp_client_name` may say, matched on the start of the lowercased name. Anything else, a person's
 * name or email included, is `other`; a name that is not a string is dropped.
 */
const CLIENT_FAMILIES = [
  'claude-code', 'claude-ai', 'claude', 'codex', 'cursor', 'windsurf', 'vscode', 'visual-studio-code', 'zed', 'cline',
  'roo-code', 'continue', 'gemini', 'chatgpt', 'openai', 'goose', 'opencode', 'jetbrains', 'warp', 'amp', 'kiro',
  'mcp-remote', 'mcp-inspector', 'renor-dashboard',
] as const;

export function clientFamily(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const lower = name.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return CLIENT_FAMILIES.find((family) => lower === family || lower.startsWith(`${family}-`) || lower.startsWith(`${family}/`)) ?? 'other';
}

let client: PostHog | null | undefined;
let shutdownHookInstalled = false;

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function remoteDisabled(): boolean {
  return env('RENOR_TELEMETRY_DISABLED').toLowerCase() === 'true';
}

function pseudonymousDistinctId(instance: string): string {
  const salt = env('RENOR_TELEMETRY_HASH_SALT');
  return createHash('sha256')
    .update(`renor-telemetry:\0${salt}\0${instance}`)
    .digest('hex')
    .slice(0, 24);
}

/** Testable privacy filter: keeps only the properties KEEP_IF lists, and the client name as its family. */
export function redactMcpAnalyticsEvent(
  event: McpAnalyticsCaptureEvent,
): McpAnalyticsCaptureEvent | null {
  if (!event || typeof event !== 'object') return null;
  // Exception siblings can embed stack/message text — drop entirely.
  if (event.event === '$exception') return null;

  const given = event.properties ?? {};
  const properties: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(KEEP_IF)) {
    if (Object.prototype.hasOwnProperty.call(given, key) && check(given[key])) properties[key] = given[key];
  }
  const family = clientFamily(given.$mcp_client_name);
  if (family !== undefined) properties.$mcp_client_name = family;

  return {
    distinct_id: event.distinct_id,
    event: event.event,
    timestamp: event.timestamp,
    type: 'capture',
    properties,
  };
}

function getOrCreateClient(): PostHog | null {
  if (client !== undefined) return client;
  if (remoteDisabled()) {
    client = null;
    return null;
  }
  const apiKey = env('RENOR_POSTHOG_KEY');
  if (!apiKey) {
    client = null;
    return null;
  }
  const host = env('RENOR_POSTHOG_HOST') || DEFAULT_HOST;
  try {
    client = new (loadPosthogNode().PostHog)(apiKey, {
      host,
      // Privacy: do not capture IP / personal profiles by default.
      disableGeoip: true,
    });
  } catch {
    client = null;
  }
  return client;
}

function installShutdownHook(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  // Best-effort: cli.ts also awaits shutdownPosthogMcp on SIGINT/SIGTERM.
  // This covers process paths that skip the CLI handler.
  const onSignal = () => {
    void shutdownPosthogMcp();
  };
  process.once('beforeExit', onSignal);
}

/**
 * Instrument one McpServer instance (call inside buildMcpServer — SSE builds
 * a fresh server per session). No-ops when PostHog is disabled/unconfigured.
 */
export function instrumentMcpServer(server: McpServer): void {
  try {
    const posthog = getOrCreateClient();
    if (!posthog) return;

    const tenant = telemetryInstanceId();
    const distinctId = pseudonymousDistinctId(tenant);

    loadPosthogMcp().instrument(server, posthog, {
      context: false,
      enableConversationId: false,
      captureModel: false,
      enableExceptionAutocapture: false,
      identify: async () => ({
        distinctId,
        // The workspace as PostHog's `tenant` group, filed under the same salted hash as the distinct id and
        // never under the slug: a slug made before opaque workspace names is the owner's email local part.
        groups: tenant && tenant !== 'unknown' ? { tenant: distinctId } : undefined,
        properties: {
          service: 'renor-core',
          $process_person_profile: false,
        },
      }),
      eventProperties: async () => ({
        service: 'renor-core',
        $process_person_profile: false,
      }),
      beforeSend: redactMcpAnalyticsEvent,
      logger: () => {
        // STDIO-safe: discard SDK warnings (HTTP MVP uses stderr only if needed).
      },
    });
    installShutdownHook();
  } catch {
    // Observability must never break the product.
  }
}

/** Flush + stop the shared posthog-node client (SIGINT/SIGTERM). */
export async function shutdownPosthogMcp(): Promise<void> {
  const current = client;
  client = null;
  if (!current) return;
  try {
    await current.shutdown();
  } catch {
    // ignore
  }
}

/** Test helper: reset singleton between hermetic tests. */
export function resetPosthogMcpForTests(): void {
  client = undefined;
  shutdownHookInstalled = false;
}
