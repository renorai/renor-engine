import express from 'express';
import crypto from 'crypto';
import path from 'path';
import Database from '../db/sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { z } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { openIndexDb } from '../db/client';
import { runMigrations } from '../db/schema';
import { removeDailyHeaderFacts } from '../indexer/pipeline';
import { clearReindexPending, removeRowsOutsideRoot, reindexPending } from '../indexer/outsideRoot';
import { remember, replayLedger, factsFor, listLifecycleSubjects, resolveLedgerPath, scopeFilterFor, LIFECYCLE_NOTE_PATH, LifecycleInputError, FIELD_LIMITS } from '../memory/lifecycle';
import { ensureFactTerms } from '../memory/factTerms';
import { namedConflicts, possibleDuplicates } from '../memory/factConflicts';
import { writerConflictLines } from '../memory/writerConflicts';
import { MAX_STATEMENT_LENGTH } from '../memory/limits';
import { cleanSource, headerSource, hiveIdentity, isImportSource, isReservedSource, productFromUserAgent, reservedCallerSource, reservedSourceIn } from '../memory/sourceName';
import { assertStorable, secretGuardEnabled } from '../extraction/secretGuard';
import { readWhatsNew, whatsNewPageFromEnv, WHATS_NEW_LIMIT } from '../memory/whatsNew';
import { HANDOFF_ARG_DESCRIPTIONS, HANDOFF_MAX_CHARS, HANDOFF_TOOL_DESCRIPTION, HANDOFF_TOOL_NAME, handoffNoteEnabled, runHandoffTool, startHandoffSweep } from '../memory/handoff';
import { askAgent, askAgentPerHour, answerRequest, closeRequest, listRequestsPage, noteKnownAgent } from '../memory/requests';
import { searchHistory, HistoryUnavailableError, HISTORY_DISCLAIMER } from './history';
import { DIRECTORY_DESCRIPTIONS, DIRECTORY_HIDDEN_TOOLS } from './directorySurface';
import { identityLine } from './identity';
import { SERVER_NAME, SERVER_VERSION, SERVER_ICONS } from './serverCard';
import { mapInvalidParams } from '../mcp/requestErrors';
import { OwnerOAuthProvider, ownerLoginRouter } from './auth';
import {
  attachEngine,
  engineIndex,
  engineIndexChanged,
  engineFinishIndexInBackground,
  hasIndexWorkToFinish,
  runningBackgroundIndex,
  engineRebuildEmbeddings,
  runningEmbeddingRebuild,
  engineLookupEntity,
  engineRememberNote,
  engineSearchMemory,
  engineSearchText,
  engineStatus,
  resolveEngineEvidence,
  resolveEngineDigests,
  type EngineDigests,
  type Engine,
  type IndexPass,
} from './engine';
import type { MvpConfig } from './config';
import { normalizeScope } from './scope';
import { identityKey } from '../retrieval/queryHelpers';
import { ledgerNoteMatcher, withoutLedgerMetadata } from '../retrieval/ledgerPresentation';
import type { EmbeddingProvider } from '../embeddings/types';
import { emitTelemetry, isPlatformInitialize, isRecallTool } from './telemetry';
import { ReadUsefulness, contextItems, searchItems, retrieveItems } from './readUsefulness';
import { instrumentMcpServer } from './posthogMcp';
import { countSchemaRejections } from './schemaRejections';
import { buildAgentContext, factQueryTerms, headingForReply, keywordOrMatch, scoreForReply, searchRelevance, searchTextFallbackEnabled } from './agentMemory';
import { indexNotice, withFactHits } from './factsLane';
import { claimsReservedEntrySource, markFactHits } from './factMarkers';
import { withHitDates } from './hitDates';
import { assertReplaceable, recordReplacement, replacementIndex, withReplacements } from '../memorymap/replacements';
import { CONTEXT_BUDGET_KEEPS_NEWEST, CONTEXT_RELEVANCE_GUIDANCE, CONTEXT_RELEVANCE_KEEPS_MATCH, SEARCH_RELEVANCE_GUIDANCE, contextRelevanceArmed } from './contextRelevance';
import { applyHitFloor, searchHitFloor } from './hitFloor';
import { answerCheckerFor, applyAnswerCheck } from './answerCheck';
import { readerLayoutEnabled, readerLayoutEnabledFor, readerLayoutPage, readerTimelineEnabled } from '../retrieval/readerLayout';
import { readerDurationNamed } from '../retrieval/questionSpan';
import { noteTurnsLoader, readerEventsEnabled, readerEventsNamed, turnScorer, vectorsMeanSomething } from '../retrieval/readerEvents';
import type { RetrievalProbe } from '../retrieval/semantic';
import { searchBestFirstEnabled } from '../retrieval/orchestrator';
import { readBuildIdentity } from '../buildIdentity';
import { learningObserver } from '../learning/tap';
import { RankingTrace, withRankingTrace } from '../retrieval/rankingTrace';
import { sharingHook } from '../sharing/examples';
import { SHARING_LEVELS } from '../sharing/fields';
import { chooseLevel, deleteAllShared } from '../sharing/send';
import { AGENT_LEVELS, SHARING_TOOL_DESCRIPTION, runSharingTool, type AskHuman } from '../sharing/agentTool';
import { AGENT_NOTICE_INSTRUCTION, showNotice } from '../sharing/notice';
import { contributorId, defaultInForce, effectiveLevel, ensureState, readConsent, trainingBearer } from '../sharing/state';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { LOCAL_API_HOSTNAMES } from '../api/apiAuth';
import { ensureOwnerOnlyFile, ensureOwnerOnlyMemoryDir } from './memoryDir';
import { previewImport, applyHostedImport, undoHostedImport, importPreviewSchema, importBatchSchema } from '../importing/hosted';
import { exportEverything, EXPORT_SECTIONS } from './exportAll';
import { DEFAULT_MAP_LIMIT, buildMemoryMap, findMemories, purgeRetired, readMemory, retireMemory, restoreMemory } from '../memorymap/memoryMap';
import { IdleMonitor } from './idle';
import { createDreamer, type Dreamer } from '../memory/dreamer/dreamer';
import { ACTIVITY_PATH, ActivityGauge } from './activity';
import { StoredSizeGauge, measureMarkdownBytes } from './storedSize';
import { escapeInvisibleControls, sanitizeErrorMessage } from './sanitize';
import { unstorableControls } from '../memory/controls';
import { labelMemoryText } from './hiddenSpans';
import { ConnectionAnnouncer, connectionStatusFromEnv, type ConnectionStatus } from './connectionStatus';
import { markErrorReason, markToolRefusal, refusal, refusalReason, toolRefusalOf, type ToolErrorReason } from '../toolRefusal';
import { CallPhases, isPhasedTool, markRetrieved } from '../callPhases';
import { requestTiming, serverTimingFor } from './serverTiming';
import { createLogger } from './log';
import { checkProfileTools, contextProfileFromEnv, LINE_TOOLS, renderLines, type ContextProfile } from './contextProfile';
import { renderToon } from './toonResponse';
import { OUT_ASK_AGENT, OUT_HANDOFF, OUT_HIT, OUT_LIST_REQUESTS, OUT_REQUEST, OUT_WHATS_NEW, pageOutputSchemasEnabled, toolCarriesStructured, toolOutputSchemasEnabled } from './outputSchemas';

const log = createLogger('engine');

/**
 * Single-user ChatGPT MVP remote MCP service.
 *
 * - Transport: Streamable HTTP (stateless), one of the two transports ChatGPT
 *   developer mode supports.
 * - Authorization: owner-only OAuth 2.1 via the SDK auth router (dynamic
 *   client registration + PKCE + token revocation) and a Bearer-token check on
 *   the MCP endpoint. Wrong/expired/revoked credentials never read or write.
 * - The legacy unauthenticated HTTP API (src/api/server.ts) is NOT mounted.
 * - Tools: lifecycle save/retrieve/export/search_history plus engine retrieval
 *   (remember, get_context, search_memory, search_text, lookup_entity,
 *   remember_note, index_memory, memory_status). Semantic search is optional (MVP_EMBEDDING_PROVIDER); mixing
 *   embedding dimensions with an existing index fails closed (ADR-0003).
 * - Every durable write goes through the repaired lifecycle (ledger-first,
 *   serialized, validated, honest receipts, restart replay), so persistence,
 *   correction and restart recovery inherit the Gate1A guarantees.
 */

/**
 * What search_memory says of the event lines, only where RENOR_READER_EVENTS is set to an on value (`1`, `true`, `yes`, `on`).
 * With it unset the lines still lead the page (the default) and say what they are in their own first words, but the tool list is
 * the one it was before the lines: the description stays under the 1,200 characters a directory client takes, and equal to the
 * gateway's server card.
 */
const EVENTS_HITS =
  ' When the question asks for the order or the date of something the user did, the first hit is a list of the user\'s own statements that match it, each under the day it is about, oldest first, and the excerpts stay in full below it (reason "events"). A question about a duration has no such list.';

/**
 * What search_memory says of the digest table, only where write-time digests are switched on (RENOR_DIGESTS), so a
 * workspace without them has the description it always had.
 */
const DIGEST_HITS =
  ' This workspace writes a dated digest of each saved note in the background: when the notes matched have digests, one table of dated items drawn from them leads the hits (after any evidence table), outside the rankedBy order and top_k, with reason "digest". It is read from stored digests, no model is called to make it, and a note saved a moment ago may not have its digest yet. Use the table when it holds the value needed, and the excerpts when it does not.';

/**
 * What search_memory says of the duration line, only where RENOR_READER_DURATION is set to an on value (`1`, `true`, `yes`, `on`)
 * and the reader layout it rides on is on. With it unset the line still leads the page (the default) and says what it is in its own
 * first words, but the tool list is the one it was before the line (under 1,200 characters, equal to the gateway's server card).
 */
const SPAN_HITS =
  ' When the question asks how many days, weeks or months lie between two events and the user wrote the date of each in their own words, the first hit is one short line that quotes those two dates and counts the days between them (reason "span"), outside the rankedBy order and top_k; the excerpts stay in full below it. It counts written dates only, never a session date.';

/**
 * What search_memory says of the current-value timeline, only where RENOR_READER_TIMELINE is on. Default off, so the
 * tool list a deployment ships is unchanged: the timeline hit (reason "timeline") exists only on that flag.
 */
const TIMELINE_HITS =
  ' When the question asks what a value is now, the first hit is a timeline of the user\'s own statements of that value, oldest first, the last line marked latest, and the excerpts stay in full below it (reason "timeline"). A question about a duration or an order has no timeline.';

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

/** How many memories a memory_map query returns unless asked for more, and the most any memory_map limit ever returns. */
const DEFAULT_LOOKUP_LIMIT = 10;
const MAX_LOOKUP_LIMIT = 200;

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

/**
 * search_memory's description names every evidence state. Bounded-wait evidence (RENOR_EVIDENCE_ASYNC, default off)
 * adds two, so they are described only where they can occur.
 */
const EVIDENCE_WAIT_STATES = ' This deployment waits for the evidence model only a bounded time, so two more states mean that this response alone has no table: "pending" (the extraction did not finish in time; it continues, and once its table is cached the same request over the same notes returns it) and "busy" (as many extractions were already waiting as the deployment allows, so none was started).';
const EVIDENCE_DAILY_CAP_STATE = ' This workspace has a daily allowance of evidence-model calls, so one more state means that this response alone has no table: "capped" (the allowance is used up until 00:00 UTC; retrieval is unaffected and the hits are the whole result).';

export { toolOutputSchemasEnabled };

/** A tool's registration with its outputSchema only when output schemas are on: off, the tool lists none, as before. */
function withOutputSchemaIf<T extends { outputSchema?: unknown }>(on: boolean, config: T): T {
  if (on || config.outputSchema === undefined) return config;
  const { outputSchema: _dropped, ...rest } = config;
  return rest as T;
}

/**
 * get_context carries structuredContent only when RENOR_PAGE_OUTPUT_SCHEMAS is on; then its bound covers the text block and
 * structuredContent repeats the same JSON, so a client that passes both to a model pays about twice the bound (measured on
 * #680: 703 tokens of text, 1,446 on the wire).
 */
export const OUTPUT_SCHEMA_BOUND_NOTE = ' With page output schemas on (RENOR_PAGE_OUTPUT_SCHEMAS), max_tokens bounds the text block; structuredContent carries the same JSON again.';

/**
 * Every tool answers in the same shape: its JSON on one line. Indentation is whitespace an agent pays for in tokens on
 * every call and reads nothing from; indented, a get_context answer was about a fifth larger.
 *
 * The text block is the JSON with its hidden characters written as \uXXXX escapes (escapeInvisibleControls), so no
 * client is handed one raw in text. With output schemas on (RENOR_TOOL_OUTPUT_SCHEMAS), `structuredContent` is exactly
 * JSON.parse of that text block: the decoded value, as any client that parses the text block reads it. Escaping is a
 * property of JSON text and is never applied to a decoded value, which would turn every newline, tab and emoji joiner
 * of a note into the literal text "\u000a" (review of #680, HIGH 1).
 */
function jsonResultOf(body: unknown, structured: boolean) {
  const text = escapeInvisibleControls(JSON.stringify(body));
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: JSON.parse(text) as Record<string, unknown> } : {}),
  };
}

/**
 * A refusal: the same JSON text a client already reads, as a plain isError result. A refusal carries no
 * structuredContent, since the output schema describes a tool's answer and a refusal is not one (the SDK does not
 * check an isError result against it either).
 */
function refusalResult(body: unknown) {
  return { content: [{ type: 'text' as const, text: escapeInvisibleControls(JSON.stringify(body)) }], isError: true };
}

/**
 * An optional argument that a client may send as JSON null, which is how some clients spell an argument they leave out:
 * null reads as omitted. Only the check of the value changes; the schema the tool lists is the wrapped one's.
 */
function nullAsOmitted<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema);
}

/**
 * An optional text argument a client may leave out in any of the ways clients do: omit it, send JSON null (strict
 * function-calling clients fill every property, and null is how they say "none"), or send an empty string. All three
 * read as omitted, so a save never needs the exact set of keys. Only the check of the value changes; the schema the
 * tool lists is the wrapped one's, a string.
 */
function omittedWhenBlank<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value), schema);
}

/** The user's time zone, as a client may know it; a note save is then filed under the user's day (memory/writer.ts). */
const TIMEZONE_ARG = omittedWhenBlank(z.string().min(1).max(64).optional()).describe(
  'Optional. The user\'s time zone: an IANA name ("America/Sao_Paulo") or a UTC offset ("-03:00"). A note is then filed under the user\'s own day and stamped with their local time; without it, under the UTC day and time. A fact keeps its exact moment either way.',
);

/**
 * Optional on every save. What the save builds on: notePaths or memory ids a read returned, or the subject of a fact it
 * returned. Renor uses it, with what the engine sees for itself, to tell whether reading helped; nothing breaks without it.
 */
const CITES_ARG = nullAsOmitted(z.array(z.string().min(1).max(1024)).max(20).optional()).describe(
  'Optional, never required. What this save builds on: the notePath (or memory id) of a note a read returned, or the subject of a fact it returned. Lets Renor tell that reading helped.',
);

/**
 * The earlier memory a plain-words save corrects. Optional: only for a correction of one specific note or log entry, whose
 * id memory_map (query) or an earlier save's receipt gives. See memorymap/replacements.ts.
 */
const REPLACES_ARG = omittedWhenBlank(z.string().max(1024).optional()).describe(
  'Optional. The id (entry:<path>#<hash> or note:<path>) of the earlier memory this save corrects, from memory_map with a query or an earlier save\'s receipt. Renor then marks that memory replaced and points to this one, so a later recall puts this first. Nothing is deleted: retire this save to undo it. For a fact, save it again with the same subject, predicate and scope instead.',
);

/** The one scope spelling every save and read takes. */
const SCOPE_ARG = omittedWhenBlank(z.string().optional()).describe(
  '"global" (default) or project:<slug>, e.g. project:atlas.',
);

/** What a client is told a `source` is: the name of the app or agent saving, never a path (memory/sourceName.ts). */
const SOURCE_ARG_DESCRIPTION = 'Name of the app or agent saving this, for example claude-code. Leave it out to use the connecting client. Never a file path or document name.';

/**
 * Shared pieces of the tools' declared output schemas (MCP `outputSchema`). Every hosted tool declares the object it
 * already returns: the SDK validates the result's `structuredContent` against it, and clients read that as the
 * structured result. A field a reply does not always carry is optional here, so a declared schema never refuses a
 * reply the tool already produced. Each top level is a loose object (additional properties allowed): a client that
 * validates against the schema it listed keeps accepting replies after a later release adds a field.
 */
/** An index pass a save or index run reports: rows walked, indexed, failed. */
const OUT_INDEX_PASS = z.object({ total: z.number(), indexed: z.number(), errors: z.number(), failure: z.string().optional() }).optional();
/** The fact a save created: its id (null when it was already stored), its value and when it became valid. */
const OUT_CREATED_FACT = z.object({ factId: z.number().nullable(), object: z.string(), validFrom: z.string() }).nullable().optional();
/** The fact a superseding save closed. */
const OUT_CLOSED_FACT = z.object({ factId: z.number(), object: z.string(), validTo: z.string() }).nullable().optional();
/** A current value that may be the same fact under another name or scope (advisory, never merged). */
const OUT_DUPLICATES = z.array(z.object({
  subject: z.string(), object: z.string(), scope: z.string(), validFrom: z.string(),
  source: z.string().optional(), untrusted: z.literal(true).optional(),
})).optional();
/** What a `replaces` link did: the correction recorded, or why none was made. */
const OUT_REPLACEMENT = z.object({ id: z.string(), by: z.string() }).optional();
const CALLER_SOURCE_ASCII = /^[A-Za-z0-9 _.:/@-]+$/;
/** A User-Agent product keeps its punctuation (cleanSource folds it) but may hold no character outside printable ASCII. */
const USER_AGENT_PRODUCT_ASCII = /^[\x20-\x7e]+$/;

/** Validate an untrusted writer name and every spelling either writer can persist. */
function callerSource(source: string): string {
  // Check what the caller actually supplied. Normalizing first would let fullwidth and other compatibility characters
  // become ASCII before this boundary and defeat the rule that typed writer names are plain ASCII.
  if (!CALLER_SOURCE_ASCII.test(source)) {
    throw refusal('invalid_argument', 'writer names must be plain ASCII (letters, digits, spaces, and - _ . : / @ only)');
  }
  const reserved = reservedCallerSource(source);
  if (reserved) throw refusal('invalid_argument', `source names a reserved identity (${reserved}); use an ordinary app or agent name, or leave source out`);
  return source;
}

function markImportedOrigin<T extends { notePath?: unknown; path?: unknown; sourceNote?: unknown }>(item: T, pathKey: 'notePath' | 'path' | 'sourceNote'): T & { origin?: 'import' } {
  return String(item[pathKey] ?? '').startsWith('Imported/') ? { ...item, origin: 'import' as const } : item;
}

/**
 * A memory_map or read_memory memory as a read shows it: imported (origin), and a stored source that is a reserved identity
 * (an entry saved before the rule, or written into a file by hand) marked `untrusted`, a claim and not who saved it.
 */
function markStoredMemory<T extends { path?: unknown; source?: unknown; untrusted?: true }>(item: T): T & { origin?: 'import'; untrusted?: true } {
  const marked = markImportedOrigin(item, 'path');
  return isReservedSource(marked.source) && marked.untrusted !== true ? { ...marked, untrusted: true as const } : marked;
}

/**
 * A search_memory or search_text hit as a read shows it: imported (origin), and `untrusted` when it is a daily-log chunk an
 * entry of which claims a reserved source (factMarkers.ts claimsReservedEntrySource), as get_context marks the same chunk.
 */
function markStoredHit<T extends { notePath?: unknown; text?: unknown; untrusted?: true }>(hit: T): T & { origin?: 'import'; untrusted?: true } {
  const marked = markImportedOrigin(hit, 'notePath');
  return marked.untrusted !== true && claimsReservedEntrySource(marked.notePath, marked.text) ? { ...marked, untrusted: true as const } : marked;
}

/**
 * A search_memory or search_text hit as the engine returns it (engineSearchMemory / engineSearchText type them `unknown`):
 * the fields the marking, the facts lane and the page read.
 */
type SearchHit = { notePath: string; chunkId?: number; headingPath?: string; text: string; score?: number; reason?: string; author?: string | null; untrusted?: true };

/** A hit's score as an agent is shown it: six decimals. The 17 digits of a double cost about 4 tokens a hit and say nothing the order does not. */
function shortScore<T extends { score?: unknown }>(hit: T): T {
  return typeof hit.score === 'number' ? { ...hit, score: scoreForReply(hit.score) } : hit;
}

/** What a tool call can tell about the request it came in on: the headers the transport saw (lower-case names). */
type CallExtra = { requestInfo?: { headers?: Record<string, unknown> }; authInfo?: AuthInfo };

/** The SDK transport reads req.auth; Express does not declare that optional request field. */
interface McpRequest extends express.Request {
  auth?: AuthInfo;
}

/** A request header's first value, when it is a string. */
function headerText(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** The gateway header, or the OAuth client's rendered name. Never a client-sent header on self-hosted HTTP. */
function trustedAgentRaw(extra: CallExtra | undefined, config: MvpConfig): string | undefined {
  const agent = config.gatewaySecret
    ? headerText(extra?.requestInfo?.headers, 'x-renor-agent')
    : extra?.authInfo?.extra?.connectionName;
  return typeof agent === 'string' ? agent : undefined;
}

/**
 * The hive identity of a trusted connection name, or "unnamed". A name that is a reserved identity is no name, so its saves
 * cannot read as `owner` or `system`, as a typed source or a User-Agent cannot. `clientChosen` is a self-hosted OAuth
 * client_name, which the client registers itself: it is held to the caller rule (a reserved first word, digit look-alikes).
 * A gateway key's name is the owner's, chosen in the dashboard: only an exact reserved identity is refused, so `Developer
 * Laptop` or `Renor CLI` keeps its name. A hosted OAuth sign-in is `OAuth-<client>`, which never is one.
 */
function trustedIdentity(raw: string, clientChosen: boolean): string {
  const identity = hiveIdentity(raw);
  if (identity === null) return 'unnamed';
  return (clientChosen ? reservedCallerSource(identity) : reservedSourceIn(identity)) !== null ? 'unnamed' : identity;
}

/**
 * The source a hosted write stores. The connection's name (`x-renor-agent` behind the gateway, the
 * verified OAuth client's name on self-hosted) as its hive identity, or "unnamed" when that connection
 * has no name a header can render — an unnamed connection never takes a name the client typed;
 * otherwise the one the client sent when it names someone; otherwise the product in the User-Agent
 * (`claude-code/2.1.289` is `claude-code`), so an agent never has to pass one;
 * otherwise undefined, which leaves the tool's own default. A source with no letter or digit in it (blank, a bare path,
 * punctuation) names no one (memory/sourceName.ts).
 */
function sourceOf(sent: string | undefined, extra: CallExtra | undefined, config: MvpConfig): string | undefined {
  // The gateway sets this from the connection key's name and overwrites a client-sent copy, so on a named
  // connection it is the author: a `source` the client types cannot write as another agent.
  // A present name that canonicalizes to no identity (punctuation-only, or `unnamed`) cannot take a typed source.
  const raw = trustedAgentRaw(extra, config);
  if (typeof raw === 'string' && raw.trim() !== '') return trustedIdentity(raw, !config.gatewaySecret);
  // Self-hosted always resolves a name for the verified client (the sign-in middleware sets the key, even
  // when the stored name renders empty). That connection is unnamed, and an unnamed connection cannot
  // choose an author, exactly as an unnamed stdio connection cannot.
  if (!config.gatewaySecret && extra?.authInfo?.extra && 'connectionName' in extra.authInfo.extra) return 'unnamed';
  if (sent !== undefined) {
    const normalized = callerSource(sent);
    if (headerSource(normalized) !== '') return normalized;
  }
  // The User-Agent is the client's own text, never checked, so it takes the same ASCII-only and reserved-identity tests as a typed source (punctuation is still folded by cleanSource, not refused).
  // A reserved product (`system/1.0`, `owner/2 (x)`, `https:system`) or a non-ASCII one (a lookalike such as `SYSTEΜ/1.0`) falls back
  // to the tool's default instead of storing it.
  const product = productFromUserAgent(extra?.requestInfo?.headers?.['user-agent']);
  return product !== undefined && USER_AGENT_PRODUCT_ASCII.test(product) && reservedCallerSource(product) === null ? product : undefined;
}

/**
 * Hosted names come only from the trusted gateway. Self-hosted names come only from
 * the persisted OAuth client selected by the verified bearer, never a client header.
 * The hive name is the header form, the same string stdio publishes.
 */
function agentOf(extra: CallExtra | undefined, config: MvpConfig): string {
  const raw = trustedAgentRaw(extra, config);
  if (typeof raw !== 'string' || raw.trim() === '') return 'unnamed';
  return trustedIdentity(raw, !config.gatewaySecret);
}

/** Nameless connections must not share a feed, mark or inbox. */
function hiveAgentOf(extra: CallExtra | undefined, tool: string, config: MvpConfig): string {
  const agent = agentOf(extra, config);
  if (agent === 'unnamed') {
    const fix = config.gatewaySecret
      ? 'give this connection a name in the dashboard (any name works, emoji and non-Latin names included), then reconnect'
      : 'register an OAuth client with a client_name for this agent, authorize it with the owner, then reconnect';
    throw new Error(`${tool} is refused: this connection has no name, and the hive tools (whats_new, ask_agent, list_requests, answer_request, close_request) tell agents apart by that name only. To fix it, ${fix}.`);
  }
  return agent;
}

/**
 * The gateway's mark on a call the platform made for the signed-in owner (the dashboard's internal connection key),
 * never an agent's. The gateway deletes a client-sent copy and sets it only for an internal key, so it is trusted only
 * behind the gateway (gatewaySecret); an engine reached without one never treats a call as the dashboard's.
 */
export const DASHBOARD_HEADER = 'x-renor-internal';

function isDashboardCall(headers: Record<string, unknown> | undefined, config: MvpConfig): boolean {
  return Boolean(config.gatewaySecret) && headerText(headers, DASHBOARD_HEADER) === '1';
}

/**
 * The gateway's mark on a call from a directory client: a claude.ai or chatgpt.com connector, whose token the gateway marks
 * (oauth.ts DIRECTORY_TOKEN_MARK). Like DASHBOARD_HEADER it is trusted only behind the gateway, and it only narrows the tools
 * listed (no hive tool); it changes nothing a call may do.
 */
export const DIRECTORY_HEADER = 'x-renor-directory';
function isDirectoryCall(headers: Record<string, unknown> | undefined, config: MvpConfig): boolean {
  return Boolean(config.gatewaySecret) && headerText(headers, DIRECTORY_HEADER) === '1';
}

/**
 * What a directory client is told about the memory. It says nothing about call order or behaviour: the directory rules forbid
 * that for other tools. Named agent keys keep the instructions built below.
 */
const DIRECTORY_INSTRUCTIONS = 'Renor single-owner memory: the owner\'s own saved memory, kept in their private workspace. get_context returns the current facts and the saved memories that match a request. remember saves one statement, or a value with its subject, predicate and object.';

/** A tool's config with its title copied into annotations.title, where the Claude directory reads a display name from. */
function withAnnotationTitle<C extends { title?: unknown; annotations?: Record<string, unknown> }>(config: C): C {
  if (typeof config?.title !== 'string' || config.annotations?.title !== undefined) return config;
  return { ...config, annotations: { ...config.annotations, title: config.title } };
}

/**
 * The tools only the dashboard may list or run: one erases retired memories for good, the other reads and sets the workspace's
 * choice to share learning data. Each registerTool call below spells its name as a literal, because the docs binding and the
 * hosted-tool tests read the registry off the literal call sites; if the two ever differ, registeredToolEntry throws when an
 * agent's server is built.
 */
const OWNER_ONLY_TOOLS = ['delete_retired_memory', 'sharing_settings'] as const;

/** The tools agents use to reach each other. A directory client is offered none of them; registeredToolEntry throws if one is renamed. */
const HIVE_TOOLS = ['whats_new', 'ask_agent', 'list_requests', 'answer_request', 'close_request'];

/**
 * The entry the SDK lists and runs a tool from. It is the object registerTool returned unless something replaced it:
 * @posthog/mcp, which wraps every server of a workspace that has RENOR_POSTHOG_KEY (posthogMcp.ts), swaps the registry for a
 * proxy that stores a COPY of each tool, and from then on the returned handle's disable() and `enabled` change nothing the SDK reads.
 */
function registeredToolEntry(server: McpServer, name: string): { enabled: boolean } {
  const entry = (server as unknown as { _registeredTools?: Record<string, { enabled: boolean } | undefined> })._registeredTools?.[name];
  if (!entry) throw new Error(`${name} is missing from the SDK's tool registry`);
  return entry;
}

/** Builds a fresh McpServer with all MVP tools registered. The SDK
 * binds one transport per Protocol instance, so SSE sessions each get
 * their own server (bounded, in-process); JSON mode shares one.
 */
function buildMcpServer(db: Database.Database, config: MvpConfig, engine: Engine, idle: Pick<IdleMonitor, 'track'> | null, digests: EngineDigests | null, usefulness: ReadUsefulness, connection: ConnectionStatus | null, announceFirst: boolean, telemetrySession: string | null = null, dashboard = false, directory = false, dreamer: Dreamer | null = null): McpServer {
  // RENOR_TOOL_OUTPUT_SCHEMAS, read once for this server: its tools list an outputSchema exactly when its answers carry
  // structuredContent.
  const withSchemas = toolOutputSchemasEnabled();
  const pageSchemas = withSchemas && pageOutputSchemasEnabled();
  const jsonResult = (body: unknown) => jsonResultOf(body, withSchemas);
  // Which Renor this is, on the first reply of a session and on every error (connectionStatus.ts); nothing in a workspace
  // that is not hosted. A server that serves no session of its own (the stateless one, or one built for a session this
  // process forgot) has no first reply to announce on.
  const announcer = new ConnectionAnnouncer(connection, announceFirst);
  const evidence = resolveEngineEvidence(config, process.env, idle);
  // RENOR_ANSWER_CHECK (default off): null unless armed and the evidence pass has a key; then a relevant verdict a model
  // reads as unanswered turns false. One per app, so every session shares its answers.
  const answerChecker = answerCheckerFor(config, process.env);
  // The reading agent's name as a save records it (remember's cleanSource and default), so its own facts carry no source.
  const readerOf = (extra: CallExtra | undefined): string => cleanSource(sourceOf(undefined, extra, config) ?? '') || 'agent';
  // Only told to agents while get_context can actually return the signal.
  const relevanceGuidance = contextRelevanceArmed(engine) ? CONTEXT_RELEVANCE_GUIDANCE : '';
  const relevanceKeepsMatch = relevanceGuidance ? CONTEXT_RELEVANCE_KEEPS_MATCH : '';
  const budgetKeepsNewest = relevanceGuidance ? CONTEXT_BUDGET_KEEPS_NEWEST : ''; // where there is a bar, the budget reads it
  // RENOR_MCP_* (contextProfile.ts, every lever off by default): a benchmark arm's tool subset, descriptions, instructions and
  // reply shape. A directory client keeps the surface the directory rules fix.
  const profile: ContextProfile = directory ? {} : contextProfileFromEnv();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, icons: SERVER_ICONS },
    { instructions: directory ? DIRECTORY_INSTRUCTIONS : profile.instructions ?? ('Renor single-owner memory. At the start of every task, call whats_new before anything else. Open requests addressed to you are first in that reply; answering or closing one records the reply and never runs anything by itself. For substantive user requests, call get_context with the current request before answering so relevant prior context can follow the user across agents. '
      + 'Call it again before you decide something an earlier session may have settled and before you review another agent\'s work, with that choice or topic as the query: reading once at the start is not enough. '
      + 'To save anything, call remember with one argument, statement: the thing to remember, in plain words. When the user says to remember or save something, they mean this tool, not your own memory. '
      + 'Renor is the place for the why, next to your board or tracker, not a copy of it: when you save on your own, save decisions with their reason, root causes and corrections, not status, progress or event logs. '
      + 'Cite an earlier entry by its subject or task instead of restating it, and save nothing that only repeats one. '
      + 'Only for a value that stays current until it changes (a city, a database, a deadline, a preference), also pass subject, predicate and object together, never guessed: saving the same subject, predicate and scope again replaces the value and keeps the old one in history. save_memory is that structured form alone; remember_note appends a line to a day\'s log.' + relevanceGuidance) },
  );
  // PostHog MCP Analytics: per-server (SSE builds a fresh McpServer per session).
  instrumentMcpServer(server);
  // Only the server of one SSE session is handed a telemetrySession: the JSON-mode server is shared by every client, so
  // "its first call" would be the first call of the process, not of a session. The flag is per server, so per session.
  let sessionCalled = false;
  // A session's first tool call, whatever its outcome and whether the schema refused it or a handler ran (telemetry.ts
  // `first_call`): the one signal for the recall share.
  const noteFirstCall = (tool: string): void => {
    if (telemetrySession === null || sessionCalled) return;
    sessionCalled = true;
    emitTelemetry({ event: 'first_call', tool, recall: isRecallTool(tool), session: telemetrySession });
  };
  // A call the tool's input schema refuses never reaches tracedTool below: count it here (schemaRejections.ts).
  countSchemaRejections(server, noteFirstCall);
  // The errors the SDK answers itself (a call its input schema refuses, an unknown tool, a handler that threw) never pass
  // through tracedTool either; they are built by one method, and carry the connection status like every other error.
  const sdkErrors = server as unknown as { createToolError?: (message: string) => { content?: unknown; isError?: boolean } };
  const createToolError = sdkErrors.createToolError;
  if (typeof createToolError === 'function') {
    sdkErrors.createToolError = (message: string) => announcer.decorate(createToolError.call(server, message), false);
  }

  function toolResultOk(result: { isError?: boolean } | null | undefined): boolean {
    return !(result && result.isError);
  }

  // The learning log (RENOR_LEARNING_LOG, src/learning): null unless it is on, and then one record per successful call of the
  // tools it covers. The observer reads the reply before it is decorated and never changes it.
  const learner = learningObserver(config.learning, {
    actor: dashboard ? 'dashboard' : 'agent',
    session: telemetrySession,
    model: () => engine.modelKey ?? null,
    agent: extra => agentOf(extra as CallExtra | undefined, config),
    // The owner's choice to share, read at each call: recording turns on when they choose a level and off when they choose off.
    sharing: config.sharingDir === undefined ? undefined : sharingHook(config.sharingDir),
  });

  // The first-run sharing notice: the first tool reply this self-hosted install gives an agent carries one extra text block the agent relays
  // to the user (src/sharing/notice.ts). The default way to run (MVP_MCP_JSON=true) is stateless, so there is no session to take a first reply
  // of: the install's record decides, and the notice goes on the first reply after it was due. Once per install and recorded; never on a
  // hosted workspace, for the dashboard, or after any choice. A notice that cannot be worked out never fails the call.
  const withSharingNotice = <T extends { content?: unknown }>(result: T): T => {
    if (dashboard || config.sharingDir === undefined || !Array.isArray(result?.content)) return result;
    let notice: string | null = null;
    try {
      showNotice(config.sharingDir, 'agent', line => { notice = line; });
    } catch {
      return result;
    }
    if (notice === null) return result;
    return { ...result, content: [...result.content, { type: 'text', text: JSON.stringify({ renor_sharing_notice: notice, instruction: AGENT_NOTICE_INSTRUCTION }) }] };
  };

  /** Privacy-safe: tool name / ok / ms and, on a refusal, its code from the closed set — never args or memory content. */
  function tracedTool<H extends (...args: never[]) => CallToolResult | Promise<CallToolResult>>(tool: string, handler: H): H {
    // On-demand: a running tool call (a write, an index job) holds the engine awake
    // even after its client disconnects.
    const run = idle ? (...args: Parameters<H>) => idle.track(async () => handler(...args)) : handler;
    const traced = async (...args: Parameters<H>) => {
      const started = Date.now();
      const startedAt = performance.now();
      const first = announcer.takeFirst();
      noteFirstCall(tool);
      // The two reads also say where their time went (callPhases.ts), on this same line; every other tool is as it was.
      const phases = isPhasedTool(tool) ? new CallPhases() : undefined;
      const phasesOf = () => {
        const report = phases?.report();
        return report && Object.keys(report).length > 0 ? { phases: report } : {};
      };
      try {
        // The ranker's terms are collected only when this call's record will be written: the learning log is on, or the sharing
        // choice is above off (rankingTrace.ts). Otherwise no scope is opened and the ranking runs as it did before the trace.
        const trace = learner?.recordsNext() ? new RankingTrace(config.memoryDir) : undefined;
        const invoke = () => (phases ? phases.run(() => run(...args)) : run(...args));
        const result = await (trace ? withRankingTrace(trace, invoke) : invoke());
        const ok = toolResultOk(result);
        // The request's Server-Timing (serverTiming.ts) reads the phases here, when the call is done: numbers only.
        const timing = requestTiming.getStore();
        if (timing && phases) timing.tool = { totalMs: performance.now() - startedAt, phases: phases.report(), cache: phases.queryCacheStatus() };
        learner?.observe(tool, args[0], result, ok, Date.now() - started, args[1], trace);
        emitTelemetry({
          event: 'tool_use',
          tool,
          ok,
          ms: Date.now() - started,
          // error_kind is unchanged (dashboards read it); error_reason is what the refusal was: the code the
          // refusal site named, or the generic `refused` for one that has no better code in the closed set.
          ...(ok ? {} : { error_kind: 'other' as const, error_reason: toolRefusalOf(result) ?? 'refused' as const }),
          ...phasesOf(),
        });
        return withSharingNotice(announcer.decorate(result, first));
      } catch (err) {
        emitTelemetry({
          event: 'tool_use',
          tool,
          ok: false,
          ms: Date.now() - started,
          error_kind: 'internal',
          error_reason: 'internal',
          ...phasesOf(),
        });
        throw err;
      }
    };
    // Same arguments and the same result, awaited: the SDK awaits a tool's result whether or not the handler is async.
    return traced as unknown as H;
  }

  /**
   * A note save's row in write_events, which whats_new and memory_map's events read (delete_retired_memory takes it out
   * again by path and this excerpt). Both note saves write it: remember with only a statement, and remember_note. The
   * line keeps the engine's own default source; only the feed's author falls back to unnamed. Best effort: the note is
   * already on disk, so a failure here must not answer an error the agent would retry into a duplicate line.
   */
  function recordNoteSave(file: string, text: string, source: string | undefined, scope: string): void {
    try {
      db.prepare('INSERT INTO write_events (note_path, action, summary, created_at, author, scope) VALUES (?, ?, ?, ?, ?, ?)')
        .run(file, 'note', text.slice(0, 240), new Date().toISOString(), source ?? 'unnamed', scope);
    } catch (err) {
      log.error('whats_new_row_failed', { detail: 'the note save was written' }, err);
    }
  }

  const registerTool = server.registerTool.bind(server) as typeof server.registerTool;
  // The title also goes into annotations.title: the Claude directory reads a tool's display name from there and flags every tool
  // without one.
  // A page-returning tool (PAGE_TOOLS) lists no schema and carries no structuredContent unless RENOR_PAGE_OUTPUT_SCHEMAS is on.
  const tracedRegisterTool: typeof server.registerTool = (name, config, cb) => {
    const carries = toolCarriesStructured(name);
    const traced = tracedTool(name, cb) as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>;
    const answer = carries ? traced : async (...a: unknown[]) => {
      const { structuredContent: _repeat, ...text } = await traced(...a);
      return text;
    };
    return registerTool(name, withAnnotationTitle(withOutputSchemaIf(carries, config)), answer as unknown as typeof cb);
  };
  server.registerTool = tracedRegisterTool;

  server.registerTool('remember', {
    title: 'Remember something naturally',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Save something to memory: pass `statement`, in plain words, and nothing else. Do not save passwords, API keys or tokens. Example: remember({"statement": "We moved the Fjord database to SQLite because it needs no server."}). It is stored whole and indexed at once, so get_context finds it right away; the receipt\'s id is what read_memory and retire_memory take. `scope` ("project:<slug>") keeps it with one project. '
      + 'Only for a value that stays current until it changes (a city, a project\'s database, a deadline, a preference), also pass subject, predicate and object together: "subject": "Fjord", "predicate": "database", "object": "SQLite". Saving the same subject, predicate and scope again replaces the value: the old one leaves current reads and stays in history. A save by a different agent than the one that saved the current value is shown in reads as a CONFLICT line until that agent saves it again (see save_memory). Spell them the same every time. Decisions, events and notes need none of the three: leave them out, never guess them. '
      + `The same statement for the same fact again changes nothing. A statement over ${MAX_STATEMENT_LENGTH} characters is refused, never cut, in either form. Saved on its own as a note, one that is not valid Unicode or holds a control character (U+0000 to U+001F except tab, newline and carriage return, or U+007F) is refused and nothing is written; with subject, predicate and object it is saved as a fact with its control characters escaped in the ledger, and only those three fields refuse them. A fact receipt may list possibleDuplicates (the same predicate under a name one word longer or shorter, or in another scope): nothing is merged; to correct one, save again with its subject and scope. A save is compared within the scope it names.`
      + ' To correct one specific earlier note or log entry (not a fact), also pass `replaces`, its id (from memory_map with a query, or an earlier save\'s receipt): that memory is then marked replaced, with a pointer to this save, in every recall, and this save is listed before it. Nothing is deleted; retire_memory on this save undoes it, and the receipt says `replaced` (or `replacesIgnored` when linking would make a loop, as when the save is the same line as the memory it replaces). '
      + 'Sent with subject, predicate and object as well, replaces naming a note or entry makes the save that plain-words correction (`factFieldsIgnored`), and replaces naming a fact is dropped while the fact is saved (`replacesIgnored`).',
    inputSchema: {
      statement: z.string().min(1).max(MAX_STATEMENT_LENGTH).describe('The thing to remember, in plain words.'),
      subject: omittedWhenBlank(z.string().optional()).describe('With predicate and object: who or what the value is about, e.g. "Fjord".'),
      predicate: omittedWhenBlank(z.string().optional()).describe('With subject and object: the attribute, snake_case, spelled the same every time, e.g. "database".'),
      object: omittedWhenBlank(z.string().optional()).describe('With subject and predicate: the current value, on one line, e.g. "SQLite".'),
      source: omittedWhenBlank(z.string().optional()).describe(SOURCE_ARG_DESCRIPTION),
      scope: SCOPE_ARG,
      timezone: TIMEZONE_ARG,
      cites: CITES_ARG,
      replaces: REPLACES_ARG,
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      mode: z.enum(['fact', 'note']),
      statement: z.string(),
      action: z.enum(['store', 'supersede', 'nochange']).optional(),
      eventId: z.string().optional(),
      subject: z.string().optional(),
      predicate: z.string().optional(),
      closed: OUT_CLOSED_FACT,
      alsoClosed: OUT_CLOSED_FACT,
      created: OUT_CREATED_FACT,
      scope: z.string().optional(),
      possibleDuplicates: OUT_DUPLICATES,
      possibleDuplicatesTotal: z.number().optional(),
      file: z.string().optional(),
      id: z.string().optional(),
      replaced: OUT_REPLACEMENT,
      replacesIgnored: z.string().optional(),
      indexed: z.boolean().optional(),
      index: OUT_INDEX_PASS,
      warning: z.string().optional(),
      detail: z.string().optional(),
    }),
  }, async (args, extra) => {
    try {
      const structured = [args.subject, args.predicate, args.object];
      const present = structured.filter(v => typeof v === 'string' && v.trim().length > 0).length;
      if (present !== 0 && present !== 3) {
        throw refusal('invalid_argument', 'remember requires subject, predicate, and object together, or none of them: to save plain words pass only statement');
      }

      // A client may send a value's subject, predicate and object together with replaces. One of the two is kept rather than the
      // call refused, so the save lands on the first try: replaces naming a fact is dropped (a fact is corrected by saving it
      // again, which this save does), and replaces naming a note or log entry wins (the save becomes a plain-words correction
      // of it, which is the only way that note is marked replaced). The receipt says which.
      let replaces = args.replaces;
      let asFact = present === 3;
      let adjusted: Record<string, string> = {};
      if (replaces !== undefined && asFact) {
        if (replaces.startsWith('fact:')) {
          replaces = undefined;
          adjusted = { replacesIgnored: 'replaces named a fact: a fact is corrected by saving it again with the same subject, predicate and scope, which this save did' };
        } else {
          asFact = false;
          adjusted = { factFieldsIgnored: 'replaces named a note or log entry, so this save is a plain-words correction of it; subject, predicate and object were not saved as a fact' };
        }
      }
      if (replaces !== undefined) await assertReplaceable(mapContext(), replaces, normalizeScope(args.scope));

      if (asFact) {
        const receipt = await remember(db, config.memoryDir, config.ledgerRelPath, {
          subject: args.subject!,
          predicate: args.predicate!,
          object: args.object!,
          source: sourceOf(args.source, extra, config),
          writer: agentOf(extra, config),
          scope: args.scope,
          statement: args.statement,
        });
        usefulness.cited(args.cites);
        if (receipt.action !== 'nochange') usefulness.updated(receipt.subject, receipt.predicate);
        // The ledger holds the user's own words now, so index it: recall by
        // their phrasing (semantic or keyword) then reaches the fact. The fact
        // is already durable, so a failed refresh must not fail the receipt; the
        // receipt says it failed, and why.
        // Only the ledger, which this save appended to, is checked: its new event is what changed, so a save costs the
        // same however many events and notes the workspace holds. The vault is walked only once every
        // FULL_VAULT_CHECK_MS (see engineIndexChanged).
        let refresh: Record<string, unknown> = {};
        if (receipt.action !== 'nochange') {
          dreamer?.noteFactSave();
          try {
            const pass = await engineIndexChanged(db, config, engine, undefined, {
              interactive: true,
              touched: [resolveLedgerPath(config.memoryDir, config.ledgerRelPath)],
            });
            if (pass.errors > 0) refresh = unfinishedPass(pass);
          } catch {
            refresh = { warning: 'memory-saved-but-index-refresh-failed' };
          }
        }
        // Other current facts that may be this one under another name or scope (memory/factConflicts.ts). Advisory:
        // the fact is saved whatever this read does, so its failure leaves the hint out instead of failing the save.
        let duplicates: ReturnType<typeof possibleDuplicates> = { values: [], total: 0 };
        try {
          duplicates = possibleDuplicates(db, receipt, receipt.created?.factId ?? null, scopeFilterFor(args.scope), readerOf(extra));
        } catch { /* no hint */ }
        return jsonResult({
          ok: receipt.ok,
          mode: 'fact',
          statement: args.statement,
          action: receipt.action,
          eventId: receipt.eventId,
          subject: receipt.subject,
          predicate: receipt.predicate,
          closed: receipt.closed,
          ...(receipt.alsoClosed ? { alsoClosed: receipt.alsoClosed } : {}),
          created: receipt.created,
          scope: normalizeScope(args.scope),
          ...(duplicates.values.length > 0 ? { possibleDuplicates: duplicates.values } : {}),
          ...(duplicates.total > duplicates.values.length ? { possibleDuplicatesTotal: duplicates.total } : {}),
          ...adjusted,
          ...refresh,
        });
      }

      const source = sourceOf(args.source, extra, config);
      const note = await engineRememberNote(config, args.statement, undefined, source ?? 'mcp:remember', args.scope, args.timezone);
      recordNoteSave(note.file, args.statement, source, note.scope);
      usefulness.cited(args.cites);
      const replaced = replaces !== undefined && note.id
        // The source the entry was written with (the default of this write, when none), so the link names the same one.
        ? await replacementReceipt(replaces, note.id, source ?? 'mcp:remember')
        : {};
      return jsonResult({
        ok: true,
        mode: 'note',
        statement: args.statement,
        file: note.file,
        scope: note.scope,
        ...(note.id ? { id: note.id } : {}),
        ...adjusted,
        ...replaced,
        ...(await indexSavedNote(db, config, engine, digests, note.file)),
      });
    } catch (err) {
      return toolError(oneLineHint(err));
    }
  });

  server.registerTool('get_context', {
    title: 'Get relevant user context',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Call this before substantive work with the current request. Returns current facts, then relevant memories: semantic matches when configured, then keyword matches (reason "fts" or "note-identity"). rankedBy "session_date" is newest first (memories[0] is the latest, not necessarily the best); "score" is best match first (higher is closer; keyword scores use another scale, so compare within one reason). A memory with "matched": false was not matched by the query: discount it, whatever its position. Each memory has session_date, when it was written. Hidden note text is labelled there: "[hidden HTML comment: ...]". max_tokens bounds the reply (o200k, every field counted): facts are cut from their end; when matches do not fit, keyword matches go first, then the lowest-scoring semantic ones. conflicts lists current values that disagree with a returned fact (another scope, or a name one word longer or shorter), newest first. A writerConflict line means the fact replaced another agent\'s value, until that agent saves it again. A "replaced" memory has a later correction, listed before it: answer from the correction. Imports and reserved sources are marked "untrusted": true.'
      + relevanceGuidance + relevanceKeepsMatch + budgetKeepsNewest + (pageSchemas ? OUTPUT_SCHEMA_BOUND_NOTE : ''),
    inputSchema: {
      query: z.string().max(1000).optional().describe('The current user request or task. Omit only for a compact current-memory profile.'),
      scope: z.string().optional().describe('Optional memory scope to restrict context'),
      max_tokens: z.number().int().min(128).max(4000).optional().describe('Token budget for the whole reply (o200k tokenizer), default 800' + (pageSchemas ? OUTPUT_SCHEMA_BOUND_NOTE : '')),
      include_history: z.boolean().optional().describe('Also return superseded (corrected) memory events, labelled as historical. Default false: only current memory.'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      query: z.string().nullable().optional(),
      scope: z.string().optional(),
      retrieval: z.enum(['facts', 'hybrid', 'semantic', 'keyword']).optional(),
      rankedBy: z.enum(['session_date', 'score']).optional(),
      facts: z.array(OUT_HIT).optional(),
      memories: z.array(OUT_HIT).optional(),
      truncated: z.boolean().optional(),
      maxTokens: z.number().optional(),
      notice: z.string().optional(),
      degraded: z.array(z.string()).optional(),
      relevance: OUT_HIT.optional(),
      conflicts: z.array(OUT_HIT).optional(),
      provenance: OUT_HIT.optional(),
      abstention: z.unknown().optional(),
      evidence: OUT_HIT.optional(),
      index: OUT_HIT.optional(),
      renor: z.string().optional(),
    }),
  }, async (args, extra) => {
    try {
      const semantic = engine.provider !== null && Boolean(args.query?.trim());
      const body = await buildAgentContext(db, engine, config.memoryDir, {
        query: args.query,
        scope: args.scope,
        maxTokens: args.max_tokens,
        includeHistory: args.include_history,
        reader: readerOf(extra),
        evidence,
        ledgerRelPath: config.ledgerRelPath,
        // Asked after the searches, which may have caught the index up; inside max_tokens like the rest of the reply.
        // Which Renor answered: inside max_tokens with the rest of the trailer.
        trailer: () => ({ ...indexNotice(db, semantic, config, args.scope), renor: identityLine(extra?.requestInfo?.headers) }),
      });
      const checked = await applyAnswerCheck(body as unknown as Record<string, unknown>, args.query, answerChecker, (body as { maxTokens?: number }).maxTokens);
      usefulness.measure('get_context', () => contextItems(checked));
      return jsonResult(checked);
    } catch (err) {
      return toolError(err);
    }
  });


  server.registerTool('save_memory', {
    title: 'Save (or correct) a memory',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Structured save only: one fact as subject, predicate and object, e.g. save_memory({"subject": "Fjord", "predicate": "database", "object": "SQLite"}). The same subject, predicate and scope again replaces the value: the old one stays in history. A save by a different agent than the one that saved the current value still replaces it, but the replaced value is then shown in reads as a CONFLICT line (its writer and date) until that agent saves this subject and predicate again. The writer is the connection\'s authenticated agent name, never the source you pass. The receipt says store, supersede or nochange, and may list possibleDuplicates (see remember). All three fields are required and no sentence of yours is kept: to save plain words, or a fact with your words, call remember.',
    inputSchema: {
      // Optional in the schema so a call that lacks them reaches the handler and is told what to do (a plain save belongs
      // to remember), instead of the SDK's raw validation error. The handler still requires all three.
      subject: omittedWhenBlank(z.string().optional()).describe('Who/what the fact is about, e.g. "user"'),
      predicate: omittedWhenBlank(z.string().optional()).describe('The relationship, e.g. "works_at"'),
      object: omittedWhenBlank(z.string().optional()).describe('The value, e.g. "Memory Company"'),
      source: omittedWhenBlank(z.string().optional()).describe(SOURCE_ARG_DESCRIPTION),
      scope: SCOPE_ARG,
      cites: CITES_ARG,
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      action: z.enum(['store', 'supersede', 'nochange']),
      eventId: z.string(),
      subject: z.string(),
      predicate: z.string(),
      closed: OUT_CLOSED_FACT,
      alsoClosed: OUT_CLOSED_FACT,
      created: OUT_CREATED_FACT,
      possibleDuplicates: OUT_DUPLICATES,
      possibleDuplicatesTotal: z.number().optional(),
      ledger: z.string(),
    }),
  }, async (args, extra) => {
    try {
      const { subject, predicate, object } = args;
      if (subject === undefined || predicate === undefined || object === undefined) {
        const missing = (['subject', 'predicate', 'object'] as const).filter(name => args[name] === undefined);
        throw refusal('missing_argument', `save_memory saves one fact and needs subject, predicate and object (missing: ${missing.join(', ')}). To save plain words, call remember with only statement, e.g. remember({"statement": "We moved the Fjord database to SQLite."}).`);
      }
      const receipt = await remember(db, config.memoryDir, config.ledgerRelPath, {
        subject,
        predicate,
        object,
        source: sourceOf(args.source, extra, config),
        writer: agentOf(extra, config),
        scope: args.scope,
      });
      usefulness.cited(args.cites);
      if (receipt.action !== 'nochange') usefulness.updated(receipt.subject, receipt.predicate);
      // The same advisory hint `remember` gives a fact receipt (memory/factConflicts.ts): the fact is saved whatever
      // this read does, so its failure leaves the hint out instead of failing the save.
      let duplicates: ReturnType<typeof possibleDuplicates> = { values: [], total: 0 };
      try {
        duplicates = possibleDuplicates(db, receipt, receipt.created?.factId ?? null, scopeFilterFor(args.scope), readerOf(extra));
      } catch { /* no hint */ }
      if (receipt.action !== 'nochange') dreamer?.noteFactSave();
      return jsonResult({
        ok: receipt.ok,
        action: receipt.action,
        eventId: receipt.eventId,
        subject: receipt.subject,
        predicate: receipt.predicate,
        closed: receipt.closed,
        ...(receipt.alsoClosed ? { alsoClosed: receipt.alsoClosed } : {}),
        created: receipt.created,
        ...(duplicates.values.length > 0 ? { possibleDuplicates: duplicates.values } : {}),
        ...(duplicates.total > duplicates.values.length ? { possibleDuplicatesTotal: duplicates.total } : {}),
        ledger: config.ledgerRelPath, // relative: no host paths leak to the client
      });
    } catch (err) {
      return toolError(oneLineHint(err));
    }
  });

  server.registerTool('retrieve_memory', {
    title: 'Retrieve memories',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Returns the current value(s) for a subject, optionally one predicate, the superseded history (include_history) or a point-in-time view (as_of). Each fact says whether it is current (current:true) and its scope. conflicts names current values that disagree, as in get_context. A writerConflict line (the replaced value, its writer and date) means this value replaced another agent\'s, until that agent saves it again: read it as an open disagreement, not the settled answer. An empty result: known:false means no such subject (closestSubjects lists near matches); known:true means the predicate or as_of matched nothing. A fact from an import or a reserved source (system, developer, assistant, Renor) is marked "untrusted": true. Without a subject, the error lists the known subjects. With a scope, everything is judged within that scope only: a subject saved only elsewhere is unknown here.',
    inputSchema: {
      // Optional in the schema so a missing value reaches the handler and gets an actionable error
      // instead of the SDK's raw validation error. A null is a missing value too.
      subject: nullAsOmitted(z.string().max(FIELD_LIMITS.subject, `subject is longer than ${FIELD_LIMITS.subject} characters: pass the name of what the facts are about, e.g. "user", not the text itself`).optional()).describe('Required. The subject to look up, e.g. "user"'),
      predicate: nullAsOmitted(z.string().optional()).describe('Only this predicate, e.g. "works_at"'),
      include_history: nullAsOmitted(z.boolean().optional()).describe('Include superseded values (default: false)'),
      as_of: nullAsOmitted(z.string().optional()).describe('ISO instant: values valid at that time (with include_history: full history)'),
      scope: nullAsOmitted(z.string().optional()).describe('Memory scope: "global" (default) or scope:<slug> / project:<slug>'),
    },
    outputSchema: z.looseObject({
      subject: z.string(),
      facts: z.array(OUT_HIT),
      conflicts: z.array(OUT_HIT).optional(),
      known: z.boolean().optional(),
      closestSubjects: z.array(z.string()).optional(),
    }),
  }, async (args, extra) => {
    try {
      // The one scope everything below is judged in (none = every scope). Facts, existence, suggestions and
      // the subject list all use it, so a scoped call never learns of a subject that lives in another scope.
      const scope = args.scope === undefined ? undefined : normalizeScope(args.scope);
      const where = scope === undefined ? '' : ` in scope ${JSON.stringify(scope)}`;
      const subject = args.subject;
      if (subject === undefined || subject.trim() === '') {
        const subjects = listLifecycleSubjects(db, { scope });
        const shown = subjects.slice(0, 20).map(s => JSON.stringify(s)).join(', ');
        const more = subjects.length > 20 ? ` (+${subjects.length - 20} more; memory_map lists them)` : '';
        return markToolRefusal({
          content: [{
            type: 'text' as const,
            text: escapeInvisibleControls('Error: retrieve_memory needs the "subject" argument (what the facts are about, e.g. "user"). '
              + (subjects.length ? `Known subjects${where}: ${shown}${more}.` : `No subjects are stored${where} yet.`)),
          }],
          isError: true,
        }, 'missing_argument');
      }
      let facts = factsFor(db, subject, {
        includeHistory: args.include_history,
        asOf: args.as_of,
        scope,
      });
      if (args.predicate) facts = facts.filter(f => f.predicate === args.predicate);
      // The values another writer replaced that stay open against a current value (memory/writerConflicts.ts). A point-in-time
      // view is not about now, so only a read of the current values carries them.
      const displaced = args.as_of === undefined
        ? writerConflictLines(db, facts.map(f => (f.valid_to == null ? f.event_id : null)))
        : new Map<string, string>();
      const rows = facts.map(f => ({
        predicate: f.predicate,
        object: f.object_text,
        current: f.valid_to == null,
        scope: f.scope ?? 'global',
        validFrom: f.valid_from,
        validTo: f.valid_to,
        eventId: f.event_id,
        ...(typeof f.author === 'string' && f.author !== '' ? { source: f.author } : {}),
        // An import's text came from a file, not from the user's own statement, and a reserved source is only a claim (one
        // stored before the rule): both marked the way other untrusted text is.
        ...(isImportSource(f.author) || isReservedSource(f.author) ? { untrusted: true as const } : {}),
        ...(f.valid_to == null && f.event_id !== null && displaced.has(f.event_id) ? { writerConflict: displaced.get(f.event_id) } : {}),
      }));
      const body: Record<string, unknown> = { subject, facts: rows };
      // Current values that disagree with another current value of the same predicate under this subject in another
      // scope, or under a related name (memory/factConflicts.ts). A point-in-time view (as_of) is not about now.
      if (args.as_of === undefined) {
        const live = facts.filter(f => f.valid_to == null && f.source_path === LIFECYCLE_NOTE_PATH);
        const conflicts = namedConflicts(db, live.map(f => ({ subject, predicate: f.predicate })), scope ?? null, readerOf(extra));
        if (conflicts.length > 0) body.conflicts = conflicts;
      }
      if (rows.length === 0) {
        // Empty is ambiguous: say whether the subject exists at all, under any predicate or time, within the
        // same scope. Asked of factsFor itself so it resolves the name exactly as the read above did (including
        // its partial and path matches); the subject list below is only for suggestions, never for this answer.
        const known = factsFor(db, subject, { includeHistory: true, scope }).length > 0;
        body.known = known;
        if (!known) body.closestSubjects = closestSubjects(subject, listLifecycleSubjects(db, { scope }));
      }
      usefulness.measure('retrieve_memory', () => retrieveItems(db, facts));
      return jsonResult(body);
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('export_memory', {
    title: 'Export everything this workspace holds',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Returns everything the workspace holds, as portable Markdown (format renor-export/v1): the fact ledger exactly as stored (every fact with its subject, predicate, object, your words, source, scope, timestamps and event id, retired ones included), every daily-log entry (remember, remember_note) with its timestamp, source and scope, every other note (imports and your own notes) in full with its metadata, and everything retired and not restored (notes, entries, facts) with when it was retired. '
      + 'The reply is two blocks: a JSON manifest (counts per kind for a whole export, the sections it carries, whether it is complete) and the document. A workspace too large for one reply is paged, never cut: while the manifest says truncated, or has nextSection/nextItem, call again with section (ledger, daily-entries, notes, retired) and offset (the item to continue from) until neither is set. '
      + 'Not exported, and listed by kind in the manifest\'s notExported: the search index and embeddings (rebuilt from this), agent requests, import receipts, activity, agent connection state, the promoted history directory, and non-Markdown files.',
    inputSchema: {
      section: nullAsOmitted(z.enum(EXPORT_SECTIONS).optional()).describe('Continue with this section only (from the manifest\'s nextSection)'),
      offset: nullAsOmitted(z.number().int().min(0).optional()).describe('The item of that section to continue from (from the manifest\'s nextItem); default 0'),
    },
    outputSchema: z.looseObject({
      file: z.string(),
      format: z.string(),
      formatVersion: z.string(),
      bytes: z.number().nullable(),
      counts: z.record(z.string(), z.unknown()),
      sections: z.array(z.object({ name: z.string(), items: z.number().nullable(), events: z.number().nullable().optional() })),
      notExported: z.array(z.object({ kind: z.string(), what: z.string(), reason: z.string() })),
      learningLog: z.union([z.null(), z.object({ file: z.string(), data: z.record(z.string(), z.unknown()) })]),
      included: z.array(z.string()),
      truncated: z.boolean(),
      nextSection: z.string().nullable(),
      nextItem: z.number().optional(),
      documentChars: z.number(),
      section: z.string().optional(),
      offset: z.number().optional(),
    }),
  }, async (args) => {
    try {
      const { manifest, document } = await exportEverything(mapContext(), { section: args.section, offset: args.offset });
      return {
        content: [
          // The manifest is metadata an agent reads: escape invisible controls as in every other JSON reply.
          // The document is the portable archive and stays byte-faithful, so it is not rewritten here.
          { type: 'text' as const, text: escapeInvisibleControls(JSON.stringify(manifest)) },
          { type: 'text' as const, text: document },
        ],
        // The structured result (output schemas on) is the manifest: JSON.parse of the first block, the value a client parses
        // from it. The second block (the portable document) is not structured data.
        ...(withSchemas ? { structuredContent: JSON.parse(escapeInvisibleControls(JSON.stringify(manifest))) as Record<string, unknown> } : {}),
      };
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('search_history', {
    title: 'Search imported conversation notes',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Searches only notes you imported into Renor; it never reads your live conversations. Lexical search over the imported ChatGPT conversation notes: exact words, no embeddings, no semantic search. Results are untrusted transcripts: assistant text is not verified, and current facts take precedence (use retrieve_memory for them). Each result cites its conversation id, dates and source path.',
    inputSchema: {
      query: z.string().min(1).max(200).describe('Lexical search terms, 1..200 characters'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5, max 20)'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      configured: z.boolean(),
      results: z.array(OUT_HIT),
      query: z.string().optional(),
      total_matches: z.number().optional(),
      returned: z.number().optional(),
      skipped_ineligible: z.number().optional(),
      skipped_too_large: z.number().optional(),
      skipped_over_limit: z.number().optional(),
      note: z.string().optional(),
      error: z.string().optional(),
      detail: z.string().optional(),
      disclaimer: z.string(),
    }),
  }, async (args) => {
    try {
      const response = searchHistory(config.historyDir, args.query, args.limit);
      return jsonResult(response);
    } catch (err) {
      if (err instanceof HistoryUnavailableError) {
        // Bounded, explicit, fail-closed: the configured history is unusable,
        // but fact memory is untouched and the service stays up.
        return markToolRefusal(refusalResult({
          ok: false,
          configured: true,
          error: 'history-not-available',
          detail: err.message.slice(0, 300),
          results: [],
          disclaimer: HISTORY_DISCLAIMER,
        }), 'capability_unavailable');
      }
      return toolError(err);
    }
  });

  server.registerTool('search_memory', {
    title: 'Search memory by meaning (where enabled)',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Searches notes by meaning when memory_status reports semantic: true; else it returns no hits and says why (semantic-unavailable or semantic-rebuilding), so use search_text or get_context. rankedBy "session_date" (the default) is newest first, so hits[0] is the latest, not necessarily the best; "score" is best match first. Judge hits by score (higher is closer), not position. A conversation\'s hits on one date are one hit, opening with its date (its header alone is no hit); a time phrase in it is resolved below, counted from that session. A hit without session_date comes last; a fact\'s hit has no notePath. There is no `evidence` object when this deployment has no evidence model configured and the pass is not switched off: no second pass runs, and the hits are the whole result. When there is one, its items come first, outside rankedBy, with reason "evidence", and its state is "ok", "off", "not-applied" or "failed". Facts saved with remember are added outside rankedBy, within top_k; a writerConflict line on one means it replaced another agent\'s value. index.stale: the semantic index lags saved facts. A "replaced" hit\'s correction is listed before it (by: its id, source: who saved it).' + (evidence?.options.background ? EVIDENCE_WAIT_STATES : '') + (evidence?.options.dailyCap !== undefined ? EVIDENCE_DAILY_CAP_STATE : '') + (digests ? DIGEST_HITS : '') + (readerLayoutEnabled() && readerDurationNamed() ? SPAN_HITS : '') + (readerEventsNamed() ? EVENTS_HITS : '') + (readerTimelineEnabled() ? TIMELINE_HITS : '') + (relevanceGuidance ? SEARCH_RELEVANCE_GUIDANCE : ''),
    inputSchema: {
      query: z.string().min(1).max(500).describe('Natural language query'),
      top_k: z.number().int().min(1).max(50).optional().describe('Max matches (default 20), not counting the short statements the session expansion adds to them'),
      scope: z.string().optional().describe('Memory scope: "global" (default) or scope:<slug> / project:<slug>'),
      include_history: z.boolean().optional().describe('Also return superseded (corrected) memory events, labelled as historical. Default false: only current memory.'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      hits: z.array(OUT_HIT),
      error: z.string().optional(),
      notice: z.string().optional(),
      note: z.string().optional(),
      rankedBy: z.enum(['session_date', 'score']).optional(),
      scope: z.string().optional(),
      evidence: OUT_HIT.optional(),
      index: OUT_HIT.optional(),
      relevance: OUT_HIT.optional(),
      floor: z.object({ similarity: z.number(), withheld: z.number() }).optional(),
    }),
  }, async (args, extra) => {
    try {
      const topK = args.top_k ?? 20;
      const floor = searchHitFloor(engine.modelKey);
      const probe: RetrievalProbe = {};
      const laidOut = readerLayoutEnabledFor(args.query);
      const body = await engineSearchMemory(db, engine, config.memoryDir, args.query, topK, args.scope, evidence, args.include_history === true, config.ledgerRelPath, probe, digests, undefined, floor > 0, laidOut, searchBestFirstEnabled());
      let result: Record<string, unknown> = body;
      if (body.ok) {
        // Who saved each fact among the hits, marked before anything reads them (the verdict, the page, the floor).
        markFactHits(db, body.hits as SearchHit[], readerOf(extra), ledgerNoteMatcher(config));
        // Judged over the index's own hits, before the facts lane adds any, with top_k: the fact the verdict is judged
        // on is then listed by that lane when the page has room for it, so a relevant verdict always names a match the
        // response holds, and names it in relevance.fact when top_k leaves no room (agentMemory.ts).
        const verdict = searchRelevance(db, engine, config.memoryDir, {
          query: args.query, scope: args.scope, includeHistory: args.include_history === true, ledgerRelPath: config.ledgerRelPath,
        }, probe, body.hits as Array<{ notePath: string; headingPath?: string; text: string }>, topK);
        const hits = withFactHits(db, config, body.hits as SearchHit[], { query: args.query, scope: args.scope, match: 'any', limit: topK, dated: true, reader: readerOf(extra) }, verdict.listFact ? [verdict.listFact] : []);
        markRetrieved(); // the matches and the facts are in hand: what follows builds the reply
        // Filter the completed page without backfilling. If the operator raises the floor above the relevance
        // bar and removes the closest chunk, withhold its verdict: the unchanged tool guidance promises the match.
        const floored = floor === 0 ? null : applyHitFloor(hits, floor);
        const page = floored ? floored.hits : hits;
        let shownVerdict = verdict;
        // At the model's calibrated floor a relevant closest match already clears the floor, so the normal path
        // needs no second fact-lane assessment. Only a floor above its reported cosine could have removed it.
        if (floored && floored.withheld > 0 && verdict.relevance?.relevant
          && (verdict.relevance.similarity === null || floor > verdict.relevance.similarity)) {
          const filteredVerdict = searchRelevance(db, engine, config.memoryDir, {
            query: args.query, scope: args.scope, includeHistory: args.include_history === true, ledgerRelPath: config.ledgerRelPath,
          }, probe, page as Array<{ notePath: string; headingPath?: string; text: string }>, topK);
          // Only a removed chunk loses its verdict. A fact already listed or named must stay as it was: freed slots
          // are not backfilled, so re-judging with that extra room must not drop relevance.fact for an unlisted fact.
          if (!filteredVerdict.relevance) shownVerdict = {};
        }
        // The event of a fact is read from the ledger's heading, which is taken off below.
        const layout = readerLayoutPage(body.rankedBy, (await withReplacements(mapContext(), withoutLedgerMetadata(page, ledgerNoteMatcher(config)), { limit: Math.max(page.length, topK) })).map(labelMemoryText), ledgerNoteMatcher(config), { query: args.query, turnsOf: readerEventsEnabled() ? noteTurnsLoader(db) : undefined, scoreTurns: readerEventsEnabled() && vectorsMeanSomething(engine.provider?.identity?.kind) && probe.queryVector && engine.vectorIndex ? turnScorer(engine.vectorIndex, probe.queryVector) : undefined }, laidOut);
        result = {
          ...body,
          // With RENOR_READER_ORDER=relevance a page of conversations comes best match first (readerLayout.ts), and says so.
          rankedBy: layout.rankedBy,
          hits: layout.hits.map(markStoredHit).map(shortScore).map(headingForReply),
          ...indexNotice(db, true, config, args.scope),
          ...(shownVerdict.relevance ? { relevance: shownVerdict.relevance } : {}),
          ...(floored ? { floor: { similarity: floor, withheld: floored.withheld } } : {}),
        };
        result = await applyAnswerCheck(result, args.query, answerChecker);
        // What the read served is the page the caller is shown, floor included: a hit the floor left out was not served, and
        // a page it left empty served nothing, whatever the verdict judged over every hit.
        usefulness.measure('search_memory', () => {
          const served = searchItems(db, ledgerNoteMatcher(config), page, result.relevance);
          return floored && served.items.length === 0 ? { ...served, relevant: false } : served;
        });
      }
      return searchResult(body, result, withSchemas);
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('search_text', {
    title: 'Search memory by keywords',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'BM25/FTS keyword search over indexed note chunks: the query is one exact phrase, and OR, AND, NEAR and * are plain words, not operators. No embedding call. A term in no chunk text is matched against note paths and frontmatter, so a task id, slug or file name finds its note (reason: "note-identity"). Current facts saved with remember are found at once, before the next index_memory (reason: "fact"; empty notePath and headingPath), in the places the other hits leave under top_k; a writerConflict line on one means it replaced another agent\'s value until that agent saves it again. Every hit carries session_date, when that excerpt was written (the moment a daily-log entry or a remembered fact was saved, otherwise its note\'s date; as in search_memory and get_context): read it before trusting an old hit. A hit with `replaced` ({by, at, source, note?}) was corrected by a later save, listed before it; `source` says who saved it. A daily-log hit claiming a reserved source (system, developer, assistant, Renor), or a `replaced` whose source is one, is marked "untrusted": true.',
    inputSchema: {
      // A control character (NUL above all) has no place in words to search for: SQLite answers it with its own error text.
      query: z.string().min(1).max(200).superRefine((query, ctx) => {
        const codes = unstorableControls(query);
        if (codes.length > 0) ctx.addIssue({ code: 'custom', message: `query contains control characters (${codes.join(', ')}): remove them and search again` });
      }).describe('Words to find, matched as one exact phrase: OR, AND, NEAR and * are plain words, not operators'),
      top_k: z.number().int().min(1).max(50).optional().describe('Max hits (default 20)'),
      scope: z.string().optional().describe('Memory scope: "global" (default) or scope:<slug> / project:<slug>'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      results: z.array(OUT_HIT),
      error: z.string().optional(),
      detail: z.string().optional(),
      scope: z.string().optional(),
    }),
  }, async (args, extra) => {
    try {
      const topK = args.top_k ?? 20;
      const exact = engineSearchText(db, config.memoryDir, args.query, topK, args.scope, false, config.ledgerRelPath);
      // H12 (RENOR_SEARCH_TEXT_FALLBACK=1, default off): when the exact phrase finds nothing, the words are searched with OR and
      // the reply says so (`fallback`). A reply that has hits is never changed. Pre-registered: data/renor-goal-better-temporal-2/prereg/H11b-H18-H12.md.
      const body = searchTextFallbackEnabled() && exact.ok && (exact.results as unknown[]).length === 0
        ? (() => {
          const any = engineSearchText(db, config.memoryDir, args.query, topK, args.scope, false, config.ledgerRelPath, undefined, keywordOrMatch(args.query));
          return any.ok && (any.results as unknown[]).length > 0 ? { ...any, fallback: 'any-word' } : exact;
        })()
        : exact;
      if (body.ok) markFactHits(db, body.results as SearchHit[], readerOf(extra), ledgerNoteMatcher(config));
      const result = body.ok
        ? {
            ...body,
            // An added correction takes the place of a hit, so the page is no longer than top_k (or than it was, if it was longer).
            results: (await (async (dated) => withReplacements(mapContext(), dated, { limit: Math.max(dated.length, topK) }))(await withHitDates(db, config.memoryDir, withoutLedgerMetadata(
              withFactHits(db, config, body.results as SearchHit[], { query: args.query, scope: args.scope, match: 'all', limit: topK, dated: true, reader: readerOf(extra) }),
              ledgerNoteMatcher(config),
            )))).map(markStoredHit),
          }
        : body;
      return searchResult(body, result, withSchemas);
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('lookup_entity', {
    title: 'Look up an entity',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Find a person/project/concept by name or alias, without embeddings. Matches in order: exact canonical name, frontmatter alias, substring of a canonical name, substring of a source note path — never words inside note text, so a word only inside a saved note is not an entity. A miss returns reason "no-entity-match", the entity count and the tool that would find the word. With scope, the search and the count are restricted to it, so "no such entity" and "exists in another scope" answer the same. An imported note\'s entity carries origin: "import".',
    inputSchema: {
      name: z.string().min(1).max(200).describe('Entity name or alias'),
      scope: z.string().optional().describe('Memory scope: "global" (default) or scope:<slug> / project:<slug>; restricts to entities whose source note belongs to the scope'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      entity: z.union([OUT_HIT, z.null()]).optional(),
      reason: z.string().optional(),
      searched: z.string().optional(),
      entitiesIndexed: z.number().optional(),
      note: z.string().optional(),
      scope: z.string().optional(),
    }),
  }, async (args) => {
    try {
      const body = engineLookupEntity(db, config, args.name, args.scope);
      // The entity of an imported note says so, as every read of that note does.
      return jsonResult(body.entity ? { ...body, entity: markImportedOrigin(body.entity, 'sourceNote') } : body);
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('remember_note', {
    title: 'Append a daily note',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Appends one line to a day\'s log: `text` is the line, e.g. remember_note({"text": "Ran the nightly build; two flaky tests in the importer."}). Do not save passwords, API keys or tokens. Timestamped, filed under today or `date`, and indexed at once, so search finds it before any index_memory (the receipt\'s indexed says whether that worked; if not, the line is still saved and keyword search finds it). '
      + 'The receipt\'s id is what read_memory, retire_memory and restore_memory take. A line over 4,000 characters, one that is not valid Unicode, or one holding a control character (U+0000 to U+001F except tab, newline and carriage return, or U+007F) is refused, never cut, and nothing is written. `remember` saves a statement on its own the same way and is the default; use this when the line belongs to another day. `replaces` (the id of an earlier note or entry this line corrects) works as in remember.',
    inputSchema: {
      text: z.string().min(1).max(MAX_STATEMENT_LENGTH).describe('The line to log, in plain words.'),
      date: omittedWhenBlank(z.string().optional()).describe('YYYY-MM-DD (default today: in timezone when it is given, else in UTC)'),
      source: omittedWhenBlank(z.string().optional()).describe(SOURCE_ARG_DESCRIPTION),
      scope: SCOPE_ARG,
      timezone: TIMEZONE_ARG,
      cites: CITES_ARG,
      replaces: REPLACES_ARG,
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      file: z.string(),
      scope: z.string(),
      id: z.string().optional(),
      replaced: OUT_REPLACEMENT,
      replacesIgnored: z.string().optional(),
      indexed: z.boolean().optional(),
      index: OUT_INDEX_PASS,
      warning: z.string().optional(),
      detail: z.string().optional(),
    }),
  }, async (args, extra) => {
    try {
      const source = sourceOf(args.source, extra, config);
      if (args.replaces !== undefined) await assertReplaceable(mapContext(), args.replaces, normalizeScope(args.scope));
      const body = await engineRememberNote(config, args.text, args.date, source, args.scope, args.timezone);
      recordNoteSave(body.file, args.text, source, body.scope);
      usefulness.cited(args.cites);
      const replaced = args.replaces !== undefined && body.id
        // The source the entry was written with (engineRememberNote's default when none), so the link names the same one.
        ? await replacementReceipt(args.replaces, body.id, source ?? 'mcp')
        : {};
      return jsonResult({ ...body, ...replaced, ...(await indexSavedNote(db, config, engine, digests, body.file)) });
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('index_memory', {
    title: 'Index the memory folder',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Walks the workspace\'s Markdown notes into the search index (chunks, keyword index, entities). If an embedding provider is configured, stamps new and changed notes with it; the provider must match the existing index dimensions. Run it when search_memory or get_context report index.stale; saved facts are keyword-searchable without it. It does not wait for a slow or refusing embedding service: such files are reported (warning "index-unfinished") and finished in the background.',
    inputSchema: {},
    outputSchema: z.looseObject({
      ok: z.boolean(),
      total: z.number(),
      indexed: z.number(),
      errors: z.number(),
      skippedNonUtf8Names: z.array(z.string()).optional(),
      skippedTooLarge: z.array(z.string()).optional(),
      failure: z.string().optional(),
      warning: z.string().optional(),
      detail: z.string().optional(),
    }),
  }, async () => {
    try {
      const stats = await engineIndex(db, config, engine, { interactive: true });
      digests?.worker.notify();
      // A file the embedding service would not take in time is saved and found by keyword; a background job embeds it.
      return jsonResult({
        ok: true,
        ...stats,
        ...(stats.errors > 0
          ? { warning: 'index-unfinished', detail: `${stats.errors} file(s) are indexed for keyword search but not yet for search by meaning: the embedding service did not answer in time, and they are being finished in the background (memory_status shows chunksWithoutVectors until they are).` }
          : {}),
      });
    } catch (err) {
      return toolError(err);
    }
  });

  const mapContext = () => ({
    db,
    memoryDir: config.memoryDir,
    ledgerRelPath: config.ledgerRelPath,
    indexOptions: engine.provider && engine.vectorIndex
      ? { embeddingProvider: engine.provider, vectorIndex: engine.vectorIndex }
      : {},
    // Where the evidence pass caches (evidence/options.ts), also when it is switched off now: rows written while it was on
    // still hold text a permanent deletion must take.
    evidenceCachePath: evidence?.options.cachePath
      ?? (process.env.RENOR_EVIDENCE_CACHE?.trim() || path.join(path.dirname(config.dbPath), 'evidence-cache.db')),
  });
  // The part of a save's receipt that says what `replaces` did: the link, or why none was made (a loop is never recorded).
  const replacementReceipt = async (old: string, by: string, source?: string): Promise<Record<string, unknown>> => {
    const record = await recordReplacement(mapContext(), old, by, source);
    return record
      ? { replaced: { id: record.old, by: record.by } }
      : { replacesIgnored: 'nothing was linked: this save is the memory it replaces, or is already replaced by it, and a replacement loop would hide both' };
  };
  const memoryIdSchema = z.string().min(1).max(1024).describe('A memory id (note:<path> or entry:<path>#<hash>) from memory_map; memory_map with a query finds one by its words without loading the whole map');
  // A fact is retired and restored by its event: retire_memory and restore_memory take `fact:<eventId>` too.
  const retirableIdSchema = z.string().min(1).max(1024).describe('A memory id (note:<path>, entry:<path>#<hash> or fact:<eventId>) from memory_map; memory_map with a query finds one by its words without loading the whole map');

  server.registerTool('preview_import', {
    title: 'Preview a Markdown vault batch',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Dry run for an agent-led import of notes into Imported/<label>/. The server cannot read your disk: read each file yourself and send its text as files: [{ relativePath, markdown }], relativePath being the path inside the folder you import (notes/idea.md: / separators, no leading / or ./ or ..). Only .md files: save a ChatGPT or Claude memory list, JSON or other text as Markdown first and leave attachments out. Names starting with "." are skipped. Returns counts, conflicts (a different file already at the destination is kept, not overwritten; use a new label to import a changed copy), skipped files with reasons, and an expiring batchId; writes no memory. Max 100 files, 64 KiB/file and 128 KiB per call including paths; for more, call again per group. Up to 8 previews can wait at once: apply one, or wait 15 minutes. Refuses unsafe or oversize inputs. Selection: include/exclude path prefixes. stage: false only checks (no batchId, nothing held). Show preview before apply_import.',
    inputSchema: importPreviewSchema,
    outputSchema: z.looseObject({
      ok: z.boolean(),
      namespace: z.string(),
      counts: z.record(z.string(), z.unknown()),
      conflicts: z.array(z.string()),
      unchanged: z.number(),
      toWrite: z.number(),
      skipped: z.array(OUT_HIT),
      limits: OUT_HIT,
      staged: z.boolean().optional(),
      batchId: z.string().optional(),
      expiresAt: z.string().optional(),
      secretGuard: OUT_HIT.optional(),
      unchangedPaths: z.array(z.string()).optional(),
    }),
  }, async (args) => {
    try { return jsonResult(await previewImport(mapContext(), args)); }
    catch (err) { return toolError(err); }
  });
  const storageLimitOf = (headers: unknown): number | undefined => {
    if (!headers || typeof headers !== 'object') return undefined;
    const raw = (headers as Record<string, unknown>)['x-renor-storage-limit'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const parsed = typeof value === 'string' ? Number(value) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };

  server.registerTool('apply_import', {
    title: 'Apply a previewed Markdown batch',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Apply preview_import batchId within 15 minutes (same tenant process). Additive: preserves existing different files and reports conflicts. Immediately keyword searchable; on a workspace with semantic search the new notes are then embedded in the background (memory_status says semantic: false until they are). No fact extraction. Returns batchId for undo_import; retries are idempotent.',
    inputSchema: importBatchSchema,
    outputSchema: z.looseObject({
      ok: z.boolean(),
      batchId: z.string(),
      namespace: z.string().optional(),
      notesWritten: z.number().optional(),
      notesUnchanged: z.number().optional(),
      notesConflicting: z.number().optional(),
      conflicts: z.array(z.string()).optional(),
      eventsAppended: z.number().optional(),
      eventsAlreadyPresent: z.number().optional(),
      ledgerReplayed: z.number().optional(),
      indexRows: OUT_HIT.optional(),
      destination: z.union([OUT_HIT, z.null()]).optional(),
      recall: z.string().optional(),
    }),
  }, async ({ batchId }, extra) => {
    try { return jsonResult(await applyHostedImport(mapContext(), batchId, storageLimitOf(extra?.requestInfo?.headers))); }
    catch (err) { return toolError(err); }
    // The import wrote its chunks without vectors and marked the index unfinished (so does a run that failed after its
    // commit): the background job embeds them, once, now. It returns null when there is nothing to embed.
    finally {
      // Digests are written for the imported notes once the index holds them whole (a note is listed only when finished).
      const rebuilding = engineRebuildEmbeddings(db, engine);
      if (digests) void (rebuilding?.done ?? Promise.resolve()).then(() => digests.worker.notify());
    }
  });
  server.registerTool('undo_import', {
    title: 'Undo one vault import batch',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Undo this batch\'s claim on imported notes. A created note stays live while a later batch still asserts the same bytes; undoing the last such batch retires it. Preserves pre-existing files, conflicts and later edits; reports preserved paths and the re-assertion reason. Uses existing retirement journal and trash. Batch receipts persist across restarts and are tenant-local.',
    inputSchema: importBatchSchema,
    outputSchema: z.looseObject({
      ok: z.boolean(),
      batchId: z.string(),
      retired: z.number().optional(),
      preserved: z.array(z.string()).optional(),
      preservedReasons: z.record(z.string(), z.string()).optional(),
      alreadyUndone: z.boolean().optional(),
    }),
  }, async ({ batchId }) => {
    try { return jsonResult(await undoHostedImport(mapContext(), batchId)); }
    catch (err) { return toolError(err); }
  });

  server.registerTool('memory_map', {
    title: 'Map everything this workspace holds',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Read-only overview for browsing, not for answering questions (use get_context for that): every memory (notes and daily-log entries), the things lifecycle facts are about, topics (tags), lifecycle facts with full history, grounded links between them (tag, wikilink, literal name mention, fact naming another thing), recent write events, and retired memories. A writerConflict line on a current fact means it replaced another agent\'s value until that agent saves it again. An imported memory carries origin: "import"; one whose stored source is a reserved identity (system, developer, assistant, Renor) is marked "untrusted": true. '
      + `limit bounds every list (memories, things, facts, links, events, retired), newest first (things by their newest fact; links shared across kinds): default ${DEFAULT_MAP_LIMIT}, at most ${MAX_LOOKUP_LIMIT}. total gives each list's size and truncated says which were cut; raise limit, or pass query. `
      + 'To find one memory to read, retire or restore, pass query (words it contains, e.g. "landlord"), and scope for one scope only: only memories and retired memories with one of the words are returned, rarest words first, then newest, up to limit. A note save returns the id of what it saved, so forgetting it needs no lookup.',
    inputSchema: {
      query: z.string().min(1).max(500).optional().describe('Words the memory contains. Matched at the start of words in each memory\'s text, title and path.'),
      scope: z.string().optional().describe('With query only: look in this memory scope ("global", or scope:<slug> / project:<slug>, which name the same folder for notes).'),
      limit: z.number().int().min(1).max(MAX_LOOKUP_LIMIT).optional().describe(`At most this many of each list the map shows (memories, things, facts, links, events, retired). Without a query, default ${DEFAULT_MAP_LIMIT}. With a query it bounds the memories and retired memories found, default ${DEFAULT_LOOKUP_LIMIT}.`),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      generatedAt: z.string().optional(),
      limit: z.number().optional(),
      query: z.string().optional(),
      scope: z.string().optional(),
      memories: z.array(OUT_HIT).optional(),
      things: z.array(OUT_HIT).optional(),
      topics: z.array(OUT_HIT).optional(),
      facts: z.array(OUT_HIT).optional(),
      links: z.array(OUT_HIT).optional(),
      events: z.array(OUT_HIT).optional(),
      retired: z.array(OUT_HIT).optional(),
      total: z.record(z.string(), z.number()).optional(),
      truncated: z.record(z.string(), z.boolean()).optional(),
    }),
  }, async (args) => {
    try {
      if (args.query === undefined) {
        // The whole map holds things, facts, links and events too, and none of them is cut by scope: ignoring it would
        // answer for every scope.
        if (args.scope !== undefined) throw refusal('invalid_argument', 'memory_map takes a scope only with a query (words the memories contain): the whole map is not cut by scope');
        const map = await buildMemoryMap(mapContext(), { limit: args.limit });
        return jsonResult({ ...map, memories: map.memories.map(markStoredMemory) });
      }
      // Read the way the facts lane reads a query: stop words count only when nothing else is left.
      const terms = factQueryTerms(args.query);
      if (terms.length === 0) throw refusal('invalid_argument', 'query has no word to look for (two or more letters or digits)');
      const scope = args.scope === undefined ? undefined : normalizeScope(args.scope);
      const found = await findMemories(mapContext(), { query: args.query, terms, limit: args.limit ?? DEFAULT_LOOKUP_LIMIT, scope });
      return jsonResult({ ...found, memories: found.memories.map(markStoredMemory) });
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('read_memory', {
    title: 'Read one memory in full',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Returns one memory from memory_map by id: its full text, note metadata (status, tags, dates) and facts extracted from it. memory.session_date is when it was written, the date get_context and search_memory give the same text (memory.at is the entry\'s moment or the note\'s last write). An imported memory carries origin: "import"; a reserved stored source (system, developer, assistant, Renor) is marked "untrusted": true.',
    inputSchema: { id: memoryIdSchema },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      memory: OUT_HIT.optional(),
      text: z.string().optional(),
      textTruncated: z.boolean().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      facts: z.array(OUT_HIT).optional(),
      replaced: OUT_HIT.optional(),
      replaces: z.array(z.string()).optional(),
    }),
  }, async (args) => {
    try {
      const memory = await readMemory(mapContext(), args.id);
      usefulness.readInFull(args.id);
      const index = await replacementIndex(mapContext());
      const replaced = index.replacedBy(args.id);
      const replaces = index.replaces(args.id);
      const labelled = labelMemoryText(memory);
      return jsonResult({
        ...labelled,
        memory: markStoredMemory(labelled.memory),
        ...(replaced ? { replaced } : {}),
        ...(replaces.length > 0 ? { replaces } : {}),
      });
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('retire_memory', {
    title: 'Retire a memory (reversible)',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Takes one memory out of recall without deleting it: a note file moves to the retired area, a daily-log entry moves out of its file, a fact leaves every read, and all leave search immediately. Use only when the owner asks to forget something; the receipt of the save that wrote it, or memory_map with a query (words of that memory), gives its id. restore_memory undoes it. A wrong fact is corrected with remember, not retired; a wrong or outdated note is corrected with remember and replaces. Retiring a correction undoes its replaces: the memory it replaced reads as current again.',
    inputSchema: { id: retirableIdSchema },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      id: z.string(),
      action: z.enum(['retired', 'restored']),
      title: z.string(),
      at: z.string(),
      eventId: z.string().optional(),
      current: z.boolean().optional(),
    }),
  }, async (args, extra) => {
    try {
      return jsonResult(await retireMemory({ ...mapContext(), source: sourceOf(undefined, extra, config) }, args.id));
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('restore_memory', {
    title: 'Restore a retired memory',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Puts a retired memory back exactly as it was and re-indexes it. Refuses to overwrite a file that now occupies the same path.',
    inputSchema: { id: retirableIdSchema },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      id: z.string(),
      action: z.enum(['retired', 'restored']),
      title: z.string(),
      at: z.string(),
      eventId: z.string().optional(),
      current: z.boolean().optional(),
    }),
  }, async (args, extra) => {
    try {
      const storageLimit = storageLimitOf(extra?.requestInfo?.headers);
      return jsonResult(await restoreMemory(
        { ...mapContext(), source: sourceOf(undefined, extra, config) },
        args.id,
        storageLimit === undefined ? {} : { validateAfterWrite: async () => {
          const bytes = await measureMarkdownBytes(config.memoryDir);
          if (bytes > storageLimit) {
            throw refusal('storage_limit', `Renor: this write would need ${bytes.toLocaleString('en-US')} bytes of Markdown storage and would not fit; the storage limit is ${storageLimit.toLocaleString('en-US')} bytes. This memory write was not run.`);
          }
        } },
      ));
    } catch (err) {
      return toolError(err);
    }
  });

  // Only for the owner, from the dashboard. Irreversible, so an agent never holds it: retire_memory is how an agent forgets, and
  // the owner decides what is erased. Only the gateway can set the mark this reads, and it sets it only for the dashboard's own
  // short-lived read key; it strips a client-sent copy (apps/gateway/src/dashboard-mark.ts). Three layers, none relying on another:
  //   1. tools/list (installed once every tool is registered) drops the tool from its answer unless the request being answered carries
  //      the mark. An SSE session keeps one server, so what was decided when it was built would keep listing the tool after the mark was gone;
  //   2. a server built without the mark has the tool disabled in the SDK's registry, so a call is refused before it reaches the handler;
  //   3. the handler below refuses a call whose own request carries no mark, which is what a session built with the mark answers.
  // (1) and (2) act on the registry's entry and on the answer, never on the handle registerTool returns: in a workspace that reports to
  // PostHog (RENOR_POSTHOG_KEY), @posthog/mcp stores a copy of the tool and that handle no longer reaches the SDK
  // (tests/review/delete-retired-instrumented.test.ts).
  server.registerTool('delete_retired_memory', {
    title: 'Permanently delete retired memories (owner only)',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Permanently deletes a retired memory (id from memory_map.retired), or every listed retired memory (id: "all"; with ids, only those ids). Cannot be undone. A live memory is retired first.',
    inputSchema: {
      id: z.string().min(1).max(64).describe('A retired memory id from memory_map.retired, or "all"'),
      ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_LOOKUP_LIMIT).optional().describe('With id "all": only these retired memory ids (what the owner saw listed)'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      action: z.enum(['deleted']),
      ids: z.array(z.string()),
      freedBytes: z.number(),
      at: z.string(),
    }),
  }, async (args, extra) => {
    try {
      if (!isDashboardCall(extra?.requestInfo?.headers, config)) {
        throw refusal('invalid_argument', 'delete_retired_memory is only available to the owner, from the Renor dashboard');
      }
      return jsonResult(await purgeRetired({ ...mapContext(), source: 'dashboard' }, args.id, args.ids));
    } catch (err) {
      return toolError(err);
    }
  });
  if (!dashboard) registeredToolEntry(server, 'delete_retired_memory').enabled = false;

  // Only for the owner, from the dashboard: the workspace's choice to share learning data with Renor (src/sharing). The consent
  // record the owner's click writes in the control plane (set_learning_consent) is the proof; THIS is what the tenant obeys, so the
  // dashboard calls it right after the record is written, and recording and sending start or stop on the next call. It guards
  // itself exactly as delete_retired_memory does, and for an agent it is neither listed nor callable.
  server.registerTool('sharing_settings', {
    title: 'Learning-data sharing choice (owner only)',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: 'Reads, sets or deletes this workspace\'s choice to share learning data with Renor. action "get" returns the choice; "set" needs level (off, signals or data) and, for signals or data, adult: true and the notice_version the owner saw; "delete" asks Renor to delete what it holds for this workspace and removes the local sharing files. Off is the default.',
    inputSchema: {
      action: z.enum(['get', 'set', 'delete']).describe('get, set or delete'),
      level: z.enum(SHARING_LEVELS).optional().describe('With set: off, signals or data'),
      notice_version: z.string().min(1).max(80).optional().describe('With set: the id of the words the owner saw'),
      adult: z.boolean().optional().describe('With set to signals or data: the owner confirmed they are 18 or older'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      action: z.enum(['get', 'set', 'delete']),
      level: z.enum(SHARING_LEVELS),
      effective: z.enum(SHARING_LEVELS),
      byDefault: z.boolean(),
      changedAt: z.string().nullable(),
      noticeVersion: z.string().nullable(),
      remoteDeleted: z.boolean().nullable(),
      trainingContributorId: z.string().nullable(),
    }),
  }, async (args, extra) => {
    try {
      if (!isDashboardCall(extra?.requestInfo?.headers, config)) {
        throw refusal('invalid_argument', 'sharing_settings is only available to the owner, from the Renor dashboard');
      }
      const dir = config.sharingDir;
      if (dir === undefined) throw refusal('invalid_argument', 'sharing is not configured on this server');
      let remoteDeleted: boolean | null = null;
      if (args.action === 'set') {
        if (args.level === undefined) throw refusal('invalid_argument', 'set needs level');
        if (args.level !== 'off' && (args.adult !== true || args.notice_version === undefined)) {
          throw refusal('invalid_argument', 'sharing signals or data needs adult: true and the notice_version the owner saw');
        }
        const result = await chooseLevel({
          dir, level: args.level, wording: args.notice_version ?? 'dashboard', adult: args.adult === true, source: 'dashboard', hosted: true,
        });
        remoteDeleted = result.remoteDeleted;
      } else if (args.action === 'delete') {
        const result = await deleteAllShared({ dir, hosted: true });
        remoteDeleted = result.remote.requested ? result.remote.ok : null;
      }
      const record = readConsent(dir);
      // The name the control plane ties to this workspace, so the endpoint can check the owner's switch before it stores a row of text for
      // training. It names the TRAINING contributor only, and only while the text switch is on: the usage numbers go out under another id
      // that is never told to the platform and never tied to a workspace.
      const training = record !== null && record.level === 'data' && record.adult;
      return jsonResult({
        ok: true,
        action: args.action,
        trainingContributorId: training ? contributorId(trainingBearer(ensureState(dir).secret)) : null,
        // An earlier explicit Off that the text switch was toggled on and off over reads as `signals` (the switch off), as the platform's record says;
        // the engine keeps the numbers off (ConsentRecord.numbersOff).
        level: record?.numbersOff === true && record.level === 'off' ? 'signals' : (record?.level ?? 'off'),
        effective: effectiveLevel(dir),
        // True while nobody has chosen and the default is what is in force (src/sharing/state.ts defaultInForce).
        byDefault: defaultInForce(dir),
        changedAt: record?.changedAt ?? null,
        noticeVersion: record?.wording ?? null,
        remoteDeleted,
      });
    } catch (err) {
      return toolError(err);
    }
  });
  if (!dashboard) registeredToolEntry(server, 'sharing_settings').enabled = false;

  // For the user's agent: read or LOWER what this Renor shares with Renor, when the user asks in plain words (src/sharing/agentTool.ts).
  // It never raises: that needs the user's own yes. Back to anonymous numbers the engine asks for through the user's client (elicitation) when it can;
  // the memory text is only ever a terminal's yes, because a client application can answer a question without the user.
  server.registerTool('sharing_level', {
    title: 'What Renor shares to improve (off, anonymous, everything)',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: SHARING_TOOL_DESCRIPTION,
    inputSchema: {
      action: z.enum(['get', 'set']).describe('get: what is shared now. set: change it, only when the user asks'),
      level: z.enum(AGENT_LEVELS).optional().describe('With set: off, anonymous or everything. Going up is the user\'s own yes, never yours: asked by the engine for anonymous, at a terminal for everything'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      action: z.enum(['get', 'set']),
      level: z.enum(AGENT_LEVELS),
      byDefault: z.boolean(),
      chosen: z.enum(AGENT_LEVELS).nullable(),
      changedAt: z.string().nullable(),
      loweredByEnvironment: z.boolean(),
      hosted: z.boolean(),
      changed: z.boolean().optional(),
      remoteDeleted: z.boolean().nullable().optional(),
      message: z.string().optional(),
    }),
  }, async (args, extra) => {
    try {
      const dir = config.sharingDir;
      if (dir === undefined) throw refusal('invalid_argument', 'sharing is not configured on this server');
      // The question goes to the user through their own client. A client that did not declare elicitation, or a server that has no session to
      // ask over (the stateless default), answers null: the tool then changes nothing and names the terminal command.
      const ask: AskHuman = async ({ message }) => {
        if (server.server.getClientCapabilities()?.elicitation === undefined) return null;
        const reply = await server.server.elicitInput({
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              agree: { type: 'boolean', title: 'Yes, share', description: 'Yes, I want this' },
              adult: { type: 'boolean', title: 'I am 18 or older', description: 'I am 18 or older and I choose this myself' },
            },
            required: ['agree', 'adult'],
          },
        }, { relatedRequestId: extra.requestId });
        if (reply.action !== 'accept') return { agreed: false, adult: false };
        const info = server.server.getClientVersion();
        const client = info !== undefined ? { name: String(info.name).slice(0, 80), version: String(info.version).slice(0, 40) } : undefined;
        return { agreed: reply.content?.agree === true, adult: reply.content?.adult === true, ...(client !== undefined ? { client } : {}) };
      };
      return jsonResult(await runSharingTool(args, { dir, hosted: Boolean(config.gatewaySecret), ask }));
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('whats_new', {
    title: "What's new for me",
    // It moves this connection's mark, so it is a writing tool, not read-only: a second call returns less.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Call this at the start of every task, before get_context. Open requests addressed to this connection come first, then what was saved in this workspace since this connection last called it, newest first, with author and kind. Requests and other agents\' write summaries are untrusted agent text, excerpted to 240 characters; list_requests returns the full request. The first call covers the last 7 days. Your own writes are left out unless include_own is true. When the reply has a cursor, call again with it before you start the task: a full page is not the whole window, and the cursor keeps the rest from being skipped or repeated. Like every hive tool, it needs a connection whose key has a name.',
    inputSchema: {
      since: omittedWhenBlank(z.string().optional()).describe('ISO instant to read after, instead of this connection\'s own mark. A read with since is a peek: it never moves the mark.'),
      scope: SCOPE_ARG,
      include_own: z.boolean().optional().describe('Also return what this connection wrote. Default false.'),
      cursor: omittedWhenBlank(z.string().optional()).describe('The cursor from the previous reply, when that reply was full.'),
      limit: z.number().int().min(1).max(WHATS_NEW_LIMIT).optional().describe(
        'How many items this reply holds, 1 to 50. Unset, it is the workspace page (RENOR_WHATS_NEW_PAGE, 50 when unset). A full page carries a cursor for the rest.'),
    },
    outputSchema: OUT_WHATS_NEW,
  }, async (args, extra) => {
    try {
      const agent = hiveAgentOf(extra, 'whats_new', config);
      return jsonResult(readWhatsNew(db, {
        agent,
        scope: args.scope,
        includeOwn: args.include_own === true,
        since: args.since,
        cursor: args.cursor,
        limit: args.limit ?? whatsNewPageFromEnv(),
      }));
    } catch (err) {
      return toolError(err);
    }
  });

  // The handoff note (memory/handoff.ts): published only with RENOR_HANDOFF_NOTE on, so the default tool list is unchanged.
  if (handoffNoteEnabled()) server.registerTool(HANDOFF_TOOL_NAME, {
    title: 'Handoff note for this branch',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: HANDOFF_TOOL_DESCRIPTION,
    inputSchema: {
      action: z.enum(['read', 'write']).describe(HANDOFF_ARG_DESCRIPTIONS.action),
      repo: z.string().min(1).max(1000).describe(HANDOFF_ARG_DESCRIPTIONS.repo),
      branch: z.string().min(1).max(1000).describe(HANDOFF_ARG_DESCRIPTIONS.branch),
      note: omittedWhenBlank(z.string().max(HANDOFF_MAX_CHARS * 2).optional()).describe(HANDOFF_ARG_DESCRIPTIONS.note),
    },
    outputSchema: OUT_HANDOFF,
  }, async (args, extra) => {
    try {
      return jsonResult(await runHandoffTool(db, args, agentOf(extra, config)));
    } catch (err) {
      return toolError(err);
    }
  });


  server.registerTool('ask_agent', {
    title: 'Ask another agent',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Records a request for another agent in this workspace. It does not run a tool, write a memory, or wake that agent. They see it at the start of their next task, in whats_new, and they answer only if their own rules say to. `to` must be the name on a connection key that has connected to this workspace; unnamed cannot be asked. One connection can record 30 requests an hour by default; past that it is refused with the time it can ask again.',
    inputSchema: {
      to: z.string().min(1).max(80).describe('The agent the request is for, the name on their connection key.'),
      request: z.string().min(1).max(MAX_STATEMENT_LENGTH).describe('What you are asking, in plain words.'),
      scope: SCOPE_ARG,
    },
    outputSchema: OUT_ASK_AGENT,
  }, async (args, extra) => {
    try {
      const from = hiveAgentOf(extra, 'ask_agent', config);
      // The workspace's secret policy covers the request channel as it covers a save: the addressee name is stored too.
      if (secretGuardEnabled()) await assertStorable([{ field: 'to', text: args.to }, { field: 'request', text: args.request }]);
      return jsonResult(askAgent(db, { from, to: args.to, request: args.request, scope: args.scope, knownOnly: true, perHour: askAgentPerHour() }));
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('list_requests', {
    title: 'List requests',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Lists requests this connection is a party to, newest first, at most 20; more_requests counts the older ones and more_requests_hint says how to list them (before=<id of the last one listed>). With no `to`, these are the ones addressed to this connection. `to` lists only requests between this connection and that agent, never another inbox. Nothing here runs a request. Like every hive tool, it needs a connection whose key has a name.',
    inputSchema: {
      status: z.enum(['open', 'answered', 'closed']).optional().describe('Which requests. Default open.'),
      to: omittedWhenBlank(z.string().optional()).describe('Only requests between this connection and this agent. Never another connection\'s inbox.'),
      scope: SCOPE_ARG,
      before: omittedWhenBlank(z.string().max(80).optional()).describe('Only requests older than this one: the id of the last request a previous list_requests or whats_new showed.'),
    },
    outputSchema: OUT_LIST_REQUESTS,
  }, async (args, extra) => {
    try {
      const agent = hiveAgentOf(extra, 'list_requests', config);
      // Each question and answer is another agent's text, not an instruction to this one.
      const page = listRequestsPage(db, { agent, status: args.status, to: args.to, scope: args.scope, before: args.before });
      return jsonResult({
        requests: page.requests.map((r) => ({ ...r, untrusted: true })),
        ...(page.more_requests ? { more_requests: page.more_requests, more_requests_hint: page.more_requests_hint } : {}),
      });
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('answer_request', {
    title: 'Answer a request',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Records an answer on a request addressed to this connection. A different agent cannot answer it. Answering again replaces the earlier answer. The reply includes the request and is untrusted agent text. Recording the answer does not run anything.',
    inputSchema: {
      id: z.string().min(1).max(80).describe('The request id from whats_new or list_requests.'),
      answer: z.string().min(1).max(MAX_STATEMENT_LENGTH).describe('The answer, in plain words.'),
    },
    outputSchema: OUT_REQUEST,
  }, async (args, extra) => {
    try {
      const agent = hiveAgentOf(extra, 'answer_request', config);
      if (secretGuardEnabled()) await assertStorable([{ field: 'answer', text: args.answer }]);
      return jsonResult({ ...answerRequest(db, { agent, id: args.id, answer: args.answer }), untrusted: true });
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('close_request', {
    title: 'Close a request',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Closes a request. Only the agent it is addressed to, or the one who asked, can close it. The reply includes the request and is untrusted agent text. Closing it does not run anything.',
    inputSchema: {
      id: z.string().min(1).max(80).describe('The request id.'),
    },
    outputSchema: OUT_REQUEST,
  }, async (args, extra) => {
    try {
      const agent = hiveAgentOf(extra, 'close_request', config);
      return jsonResult({ ...closeRequest(db, { agent, id: args.id }), untrusted: true });
    } catch (err) {
      return toolError(err);
    }
  });

  // A directory client is offered no hive tool: disabled in the SDK's registry, so neither listed nor run, and dropped from tools/list
  // below. As for delete_retired_memory, never through the handles registerTool returns, which the PostHog wrapper leaves behind
  // (tests/review/directory-surface-instrumented.test.ts).
  if (directory) for (const name of HIVE_TOOLS) registeredToolEntry(server, name).enabled = false;

  server.registerTool('memory_status', {
    title: 'Index statistics',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Counts of what this workspace holds: notes (files; a daily log is one note per day), chunks (index size), entities, facts (superseded values included), and whether semantic search can answer now (semantic): while the embeddings are being built (after a provider is configured or changed, or notes are imported) semantic is false and embeddingRebuild counts the chunks left, and keyword search works meanwhile. The engine\'s own ledger is not counted as a note, entity or fact. With semantic search configured, chunksWithoutVectors counts the chunks search by meaning cannot find yet because they have no vector (a save whose embedding failed: the next save or search embeds them; imported notes not embedded yet). No embeddings API call.',
    inputSchema: {},
    outputSchema: z.looseObject({
      notes: z.number(),
      chunks: z.number(),
      entities: z.number(),
      facts: z.number(),
      relations: z.number(),
      embeddingDims: z.number().nullable(),
      semantic: z.boolean(),
      embeddingRebuild: z.object({ chunksLeft: z.number(), chunks: z.number() }).optional(),
      chunksWithoutVectors: z.number().optional(),
      storage: z.looseObject({
        vectors: z.number(),
        ledgerBytes: z.number(),
        vectorMirror: z.looseObject({
          copy: z.enum(['f32', 'none']), rows: z.number(), bytes: z.number(), capBytes: z.number(), overCapSearches: z.number(),
          simd: z.boolean(),
        }).optional(),
      }).optional(),
      degraded: z.object({ keyword: z.string().optional(), semantic: z.string().optional() }).optional(),
      renor: z.string(),
      digests: OUT_HIT.optional(),
    }),
  }, async (_args, extra) => {
    try {
      const body = { ...engineStatus(db, engine, config), renor: identityLine(extra?.requestInfo?.headers) };
      // Present only where write-time digests are switched on, so a workspace without them reports what it always did.
      return jsonResult(digests ? { ...body, digests: digests.worker.status() } : body);
    } catch (err) {
      return toolError(err);
    }
  });

  // Nor the tools directorySurface.ts keeps from a directory client: disabled the same way, once every one of them is registered.
  if (directory) for (const name of DIRECTORY_HIDDEN_TOOLS) registeredToolEntry(server, name).enabled = false;

  // The profile's tool subset: the others are disabled in the SDK's registry, so neither listed nor run.
  if (profile.tools || profile.descriptions) {
    const registered = Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {});
    checkProfileTools(profile, registered);
    if (profile.tools) for (const name of registered) if (!profile.tools.has(name)) registeredToolEntry(server, name).enabled = false;
  }

  // Every tool is registered above; the SDK's own handlers (initialize included) are mapped in the same pass.
  mapInvalidParams(server.server);
  // Layer 1 above: the owner-only tool is in the answer only when this request carries the mark. It is decided on the answer, after the
  // SDK and whatever wraps it have built the list: a flag flipped around this call would be put back before PostHog's listing wrapper,
  // which awaits first, reached the SDK. The hive tools leave the answer the same way for a directory client.
  const listHandlers = (server.server as unknown as {
    _requestHandlers: Map<string, (request: unknown, extra: CallExtra) => unknown>;
  })._requestHandlers;
  const listTools = listHandlers.get('tools/list');
  if (!listTools) throw new Error('tools/list handler missing');
  listHandlers.set('tools/list', async (request, extra) => {
    const answer = await listTools(request, extra) as { tools?: Array<{ name?: unknown; description?: unknown }> };
    const headers = extra?.requestInfo?.headers;
    const forDirectory = directory || isDirectoryCall(headers, config);
    const hidden = new Set<unknown>();
    if (!isDashboardCall(headers, config)) for (const name of OWNER_ONLY_TOOLS) hidden.add(name);
    if (forDirectory) for (const name of [...HIVE_TOOLS, ...DIRECTORY_HIDDEN_TOOLS]) hidden.add(name);
    if (hidden.size === 0 && !forDirectory && !profile.descriptions) return answer;
    // An answer this cannot read is not passed on unfiltered.
    if (!Array.isArray(answer?.tools)) throw new Error('tools/list answered without a tools array');
    const tools = answer.tools.filter((tool) => !hidden.has(tool.name));
    // A directory client reads descriptions that say what a tool does, with no instruction to the model (directorySurface.ts).
    return {
      ...answer,
      tools: forDirectory
        ? tools.map((tool) => {
          const own = typeof tool.name === 'string' ? DIRECTORY_DESCRIPTIONS[tool.name] : undefined;
          const description = own && pageSchemas && tool.name === 'get_context' ? own + OUTPUT_SCHEMA_BOUND_NOTE : own;
          return description ? { ...tool, description } : tool;
        })
        : profile.descriptions
          ? tools.map((tool) => {
            const own = typeof tool.name === 'string' ? profile.descriptions![tool.name] : undefined;
            return own ? { ...tool, description: own } : tool;
          })
          : tools,
    };
  });
  // The profile's reply shape: a read's text block as lines (renderLines); structuredContent, where there is one, is unchanged.
  if (profile.response === 'lines') {
    const callTool = listHandlers.get('tools/call');
    if (!callTool) throw new Error('tools/call handler missing');
    listHandlers.set('tools/call', async (request, extra) => {
      const result = await callTool(request, extra) as CallToolResult;
      const name = (request as { params?: { name?: unknown } }).params?.name;
      if (typeof name !== 'string' || !LINE_TOOLS.has(name) || result?.isError || !Array.isArray(result?.content)) return result;
      return { ...result, content: result.content.map((c, i) => (i === 0 && c.type === 'text' ? { ...c, text: renderLines(c.text) } : c)) };
    });
  } else if (profile.response === 'toon') {
    const callTool = listHandlers.get('tools/call');
    if (!callTool) throw new Error('tools/call handler missing');
    listHandlers.set('tools/call', async (request, extra) => {
      const result = await callTool(request, extra) as CallToolResult;
      const name = (request as { params?: { name?: unknown } }).params?.name;
      if (name !== 'search_memory' || result?.isError || result.content?.[0]?.type !== 'text') return result;
      try {
        const text = await renderToon(result.content[0].text);
        return { ...result, content: [{ ...result.content[0], text }, ...result.content.slice(1)] };
      } catch {
        return refusalResult({
          ok: false, error: 'toon-encoding-unsupported',
          note: 'This reply cannot be safely encoded as TOON. Use the default JSON response profile.',
        });
      }
    });
  }
  return server;
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
    const sessionServer = buildMcpServer(db, config, engine, activity, digests, usefulness, connection, false, null, isDashboardCall(req.headers, config), isDirectoryCall(req.headers, config));
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
  // An authenticated phased read reports its phases in Server-Timing (serverTiming.ts): the rest of its request runs in that
  // timing's async context, so the tool wrapper finds it. Every other request runs as it always did.
  const mcpServerTiming = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const timing = serverTimingFor(req, res, (req as McpRequest).auth);
    if (timing) requestTiming.run(timing, next);
    else next();
  };
  app.post(MCP_PATH, mcpBearer, express.json({ limit: '1mb', verify: requireUtf8Body }), mcpServerTiming, async (req: express.Request, res: express.Response) => {
    const authInfo = (req as McpRequest).auth as AuthInfo;
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
        const requestServer = buildMcpServer(db, config, engine, activity, digests, usefulness, connection, false, null, isDashboardCall(req.headers, config), isDirectoryCall(req.headers, config));
        res.on('close', () => { void transport.close(); void requestServer.close(); });
        await requestServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      // SSE session mode (bounded, in-process)
      const now = Date.now();
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
      const sessionServer = buildMcpServer(db, config, engine, activity, digests, usefulness, connection, true, telemetrySession, isDashboardCall(req.headers, config), isDirectoryCall(req.headers, config), dreamer);
      transport.onclose = () => {
        sseSessions.delete(sessionId);
        emitTelemetry({ event: 'session', kind: 'mcp_close' });
        void sessionServer.close();
      };
      const minted: SseSession = { transport, lastActivity: now, open: 0, directory: isDirectoryCall(req.headers, config) };
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

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// The longest subject lifecycle ever stores (FIELD_LIMITS.subject). A longer query is cut to this: the edit
// distance below is quadratic, so one oversized argument would otherwise stall the whole single-threaded service.
const MAX_SUBJECT_CHARS = 512;
const SUBJECT_WORD_BREAK = /[^\p{L}\p{N}]+/u;

/**
 * Up to 5 known subjects the caller plausibly meant, closest first. A subject that the query names, that
 * contains the query, or that shares a word with it always qualifies; anything else must be a typo (a
 * normalized edit distance of at most 0.4). Names shorter than 3 characters are never matched by containment.
 */
function closestSubjects(query: string, subjects: string[]): string[] {
  const q = identityKey(query.slice(0, MAX_SUBJECT_CHARS));
  const queryWords = new Set(q.split(SUBJECT_WORD_BREAK).filter(w => w.length >= 3));
  const close: Array<{ name: string; score: number }> = [];
  for (const name of subjects) {
    const n = identityKey(name);
    const longest = Math.max(q.length, n.length);
    const related = (n.length >= 3 && q.includes(n)) || (q.length >= 3 && n.includes(q))
      || n.split(SUBJECT_WORD_BREAK).some(w => queryWords.has(w));
    // The distance is at least the length difference, so an unrelated name that far away cannot qualify.
    if (!related && Math.abs(q.length - n.length) / longest > 0.4) continue;
    const dist = editDistance(q, n) / longest;
    const score = related ? dist * 0.4 : dist;
    if (score <= 0.4) close.push({ name, score });
  }
  return close.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, 5).map(c => c.name);
}

export { sanitizeErrorMessage };

/**
 * What a save's receipt says when the index pass after it left a file unfinished (its embedding failed): the pass's
 * counts, a warning, and why. The memory is saved, and keyword search finds it; search by meaning does once the next
 * save, or a search, finishes the file.
 */
function unfinishedPass(pass: IndexPass) {
  const { failure, ...index } = pass;
  return { index, warning: 'memory-saved-but-index-refresh-failed', ...(failure === undefined ? {} : { detail: failure }) };
}

/**
 * What a note save's receipt says of the index pass run right after it (remember in note mode, remember_note): the
 * day's note the save wrote and the ledger are checked, so search finds the line at once, and a pass that failed is
 * said, and why. The note is saved either way.
 */
async function indexSavedNote(db: Database.Database, config: MvpConfig, engine: Engine, digests: EngineDigests | null = null, noteFile: string) {
  try {
    const touched = [path.join(config.memoryDir, noteFile), resolveLedgerPath(config.memoryDir, config.ledgerRelPath)];
    const pass = await engineIndexChanged(db, config, engine, undefined, { interactive: true, touched });
    // The digest of what was just saved is written in the background (a timer; the save does not wait for it).
    digests?.worker.notify();
    return { indexed: pass.errors === 0, ...(pass.errors === 0 ? { index: pass } : unfinishedPass(pass)) };
  } catch (indexErr) {
    const detail = indexErr instanceof Error ? indexErr.message : String(indexErr);
    return { indexed: false, warning: 'memory-saved-but-index-refresh-failed', detail: detail.slice(0, 300) };
  }
}

/**
 * The ledger keeps each structured field on one line and refuses a line break in it, which an agent that put a longer
 * value there cannot act on. The rule and its message are the lifecycle's; this says where the longer text goes.
 */
function oneLineHint(err: unknown): unknown {
  if (err instanceof LifecycleInputError && ['subject', 'predicate', 'object'].includes(err.field) && /control characters/.test(err.message)) {
    // The re-labelled message is the lifecycle's plus where the longer text goes; the refusal code the
    // lifecycle named (invalid_text) is carried out of band, so the re-label does not lose it and the error
    // stays a plain Error (same class, name and keys as before this vocabulary existed).
    const hinted = new Error(`${err.message}. Keep ${err.field} to one line: longer text belongs in the statement of a remember call.`);
    const reason = refusalReason(err);
    return reason === undefined ? hinted : markErrorReason(hinted, reason);
  }
  return err;
}

export function toolError(err: unknown) {
  const message = sanitizeErrorMessage(err);
  // Privacy-safe: bounded message, no stack, no host paths. A message can echo a stored value back
  // (e.g. the field a save refused), so invisible controls are escaped here too.
  return markToolRefusal({
    content: [{ type: 'text' as const, text: escapeInvisibleControls(`Error: ${message.slice(0, 400)}`) }],
    isError: true,
  }, refusalReason(err) ?? 'refused');
}

/**
 * Why a search answered without searching: its own `error` field, named once, so the code telemetry carries
 * says which of the four it was (a workspace with no embeddings, one mid-rebuild, one with no keyword index,
 * and a query the index could not read) instead of one `other`.
 */
export const SEARCH_REFUSAL_REASONS: Record<string, ToolErrorReason> = {
  'semantic-unavailable': 'capability_unavailable',
  'semantic-rebuilding': 'capability_rebuilding',
  'fts-unavailable': 'capability_unavailable',
  'fts-query': 'invalid_query',
};

/** A search reply: ok as the search answered it, and its refusal code beside it when it did not search. */
function searchResult(body: { ok: boolean; error?: string }, result: unknown, structured: boolean) {
  if (body.ok) return { ...jsonResultOf(result, structured), isError: false };
  return markToolRefusal(refusalResult(result), SEARCH_REFUSAL_REASONS[String(body.error)] ?? 'refused');
}


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
