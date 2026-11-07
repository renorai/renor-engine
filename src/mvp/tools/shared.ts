/**
 * What the MVP server's tools share: the reply shapes, argument schemas, caller identity and refusal helpers that more than one
 * tool (or the HTTP app around them) uses. Moved here unchanged from server.ts when it was split into per-tool modules.
 */
import { createLogger } from '../log.js';
import * as z from 'zod';
import { SESSION_INDEX_METHOD, sessionIndexEnabled } from '../sessionIndex.js';
import { escapeInvisibleControls, sanitizeErrorMessage } from '../sanitize.js';
import { MAX_STATEMENT_LENGTH } from '../../memory/limits.js';
import { refusal, refusalReason, markErrorReason, markToolRefusal, type ToolErrorReason } from '../../toolRefusal.js';
import { reservedCallerSource, isReservedSource, hiveIdentity, reservedSourceIn, headerSource, productFromUserAgent } from '../../memory/sourceName.js';
import path from 'path';
import { claimsReservedEntrySource } from '../factMarkers.js';
import { authorityLabelsEnabled } from '../../memory/authority.js';
import { scoreForReply } from '../agentMemory.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { MvpConfig } from '../config.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { saveMomentMode } from '../saveMoment.js';
import { pinnedRulesEnabled } from '../pinnedRules.js';
import { ruleApprovalsEnabled } from '../ruleApprovals.js';
import { captureServerOn } from '../../extraction/captureModel.js';
import { identityKey } from '../../retrieval/queryHelpers.js';
import { type IndexPass, type Engine, type EngineDigests, engineIndexChanged } from '../engine.js';
import Database from '../../db/sqlite.js';
import { resolveLedgerPath, LifecycleInputError } from '../../memory/lifecycle.js';

export const log = createLogger('engine');

/** The hook's index request (sessionIndex.ts); not in tools/list. */
export const SessionIndexRequest = z.object({
  method: z.literal(SESSION_INDEX_METHOD),
  params: z.object({ max_tokens: z.number().int().min(128).max(4000).optional(), scope: z.string().max(200).optional() }).passthrough().optional(),
});

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
export const EVENTS_HITS =
  ' When the question asks for the order or the date of something the user did, the first hit is a list of the user\'s own statements that match it, each under the day it is about, oldest first, and the excerpts stay in full below it (reason "events"). A question about a duration has no such list.';

/**
 * What search_memory says of the digest table, only where write-time digests are switched on (RENOR_DIGESTS), so a
 * workspace without them has the description it always had.
 */
export const DIGEST_HITS =
  ' This workspace writes a dated digest of each saved note in the background: when the notes matched have digests, one table of dated items drawn from them leads the hits (after any evidence table), outside the rankedBy order and top_k, with reason "digest". It is read from stored digests, no model is called to make it, and a note saved a moment ago may not have its digest yet. Use the table when it holds the value needed, and the excerpts when it does not.';

/**
 * What search_memory says of the duration line, only where RENOR_READER_DURATION is set to an on value (`1`, `true`, `yes`, `on`)
 * and the reader layout it rides on is on. With it unset the line still leads the page (the default) and says what it is in its own
 * first words, but the tool list is the one it was before the line (under 1,200 characters, equal to the gateway's server card).
 */
export const SPAN_HITS =
  ' When the question asks how many days, weeks or months lie between two events and the user wrote the date of each in their own words, the first hit is one short line that quotes those two dates and counts the days between them (reason "span"), outside the rankedBy order and top_k; the excerpts stay in full below it. It counts written dates only, never a session date.';

/**
 * What search_memory says of the current-value timeline, only where RENOR_READER_TIMELINE is on. Default off, so the
 * tool list a deployment ships is unchanged: the timeline hit (reason "timeline") exists only on that flag.
 */
export const TIMELINE_HITS =
  ' When the question asks what a value is now, the first hit is a timeline of the user\'s own statements of that value, oldest first, the last line marked latest, and the excerpts stay in full below it (reason "timeline"). A question about a duration or an order has no timeline.';

/** How many memories a memory_map query returns unless asked for more, and the most any memory_map limit ever returns. */
export const DEFAULT_LOOKUP_LIMIT = 10;

export const MAX_LOOKUP_LIMIT = 200;

/**
 * search_memory's description names every evidence state. Bounded-wait evidence (RENOR_EVIDENCE_ASYNC, default off)
 * adds two, so they are described only where they can occur.
 */
export const EVIDENCE_WAIT_STATES = ' This deployment waits for the evidence model only a bounded time, so two more states mean that this response alone has no table: "pending" (the extraction did not finish in time; it continues, and once its table is cached the same request over the same notes returns it) and "busy" (as many extractions were already waiting as the deployment allows, so none was started).';

export const EVIDENCE_DAILY_CAP_STATE = ' This workspace has a daily allowance of evidence-model calls, so one more state means that this response alone has no table: "capped" (the allowance is used up until 00:00 UTC; retrieval is unaffected and the hits are the whole result).';

/** A tool's registration with its outputSchema only when output schemas are on: off, the tool lists none, as before. */
export function withOutputSchemaIf<T extends { outputSchema?: unknown }>(on: boolean, config: T): T {
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
export function jsonResultOf(body: unknown, structured: boolean) {
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
export function refusalResult(body: unknown) {
  return { content: [{ type: 'text' as const, text: escapeInvisibleControls(JSON.stringify(body)) }], isError: true };
}

/**
 * An optional argument that a client may send as JSON null, which is how some clients spell an argument they leave out:
 * null reads as omitted. Only the check of the value changes; the schema the tool lists is the wrapped one's.
 */
export function nullAsOmitted<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema);
}

/**
 * An optional text argument a client may leave out in any of the ways clients do: omit it, send JSON null (strict
 * function-calling clients fill every property, and null is how they say "none"), or send an empty string. All three
 * read as omitted, so a save never needs the exact set of keys. Only the check of the value changes; the schema the
 * tool lists is the wrapped one's, a string.
 */
/** RENOR_BLANK_STATEMENT (default ON): off/0/false/no restores the schema minimum on `statement`. */
export function blankStatementFilled(): boolean {
  return !['off', '0', 'false', 'no'].includes((process.env.RENOR_BLANK_STATEMENT ?? '').trim().toLowerCase());
}

/** `statement` as advertised (minLength 1, bytes unchanged). With RENOR_BLANK_STATEMENT on, the empty string skips the minimum check and the handler fills or refuses it. */
export function statementSchema() {
  return z.string().check(z.minLength(1, { when: (payload: { value: unknown }) => typeof payload.value === 'string' && !(blankStatementFilled() && payload.value === '') } as Parameters<typeof z.minLength>[1]), z.maxLength(MAX_STATEMENT_LENGTH));
}

export function omittedWhenBlank<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value), schema);
}

/** The user's time zone, as a client may know it; a note save is then filed under the user's day (memory/writer.ts). */
export const TIMEZONE_ARG = omittedWhenBlank(z.string().min(1).max(64).optional()).describe(
  'Optional. The user\'s time zone: an IANA name ("America/Sao_Paulo") or a UTC offset ("-03:00"). A note is then filed under the user\'s own day and stamped with their local time; without it, under the UTC day and time. A fact keeps its exact moment either way.',
);

/**
 * Optional on every save. What the save builds on: notePaths or memory ids a read returned, or the subject of a fact it
 * returned. Renor uses it, with what the engine sees for itself, to tell whether reading helped; nothing breaks without it.
 */
export const CITES_ARG = nullAsOmitted(z.array(z.string().min(1).max(1024)).max(20).optional()).describe(
  'Optional, never required. What this save builds on: the notePath (or memory id) of a note a read returned, or the subject of a fact it returned. Lets Renor tell that reading helped.',
);

/**
 * The earlier memory a plain-words save corrects. Optional: only for a correction of one specific note or log entry, whose
 * id memory_map (query) or an earlier save's receipt gives. See memorymap/replacements.ts.
 */
export const REPLACES_ARG = omittedWhenBlank(z.string().max(1024).optional()).describe(
  'Optional. The id (entry:<path>#<hash> or note:<path>) of the earlier memory this save corrects, from memory_map with a query or an earlier save\'s receipt. Renor then marks that memory replaced and points to this one, so a later recall puts this first. Nothing is deleted: retire this save to undo it. For a fact, save it again with the same subject, predicate and scope instead.',
);

/** The one scope spelling every save and read takes. */
export const SCOPE_ARG = omittedWhenBlank(z.string().optional()).describe(
  '"global" (default) or project:<slug>, e.g. project:atlas.',
);

/** What a client is told a `source` is: the name of the app or agent saving, never a path (memory/sourceName.ts). */
export const SOURCE_ARG_DESCRIPTION = 'Name of the app or agent saving this, for example claude-code. Leave it out to use the connecting client. Never a file path or document name.';

/**
 * Shared pieces of the tools' declared output schemas (MCP `outputSchema`). Every hosted tool declares the object it
 * already returns: the SDK validates the result's `structuredContent` against it, and clients read that as the
 * structured result. A field a reply does not always carry is optional here, so a declared schema never refuses a
 * reply the tool already produced. Each top level is a loose object (additional properties allowed): a client that
 * validates against the schema it listed keeps accepting replies after a later release adds a field.
 */
/** An index pass a save or index run reports: rows walked, indexed, failed. */
export const OUT_INDEX_PASS = z.object({ total: z.number(), indexed: z.number(), errors: z.number(), failure: z.string().optional() }).optional();

/** The fact a save created: its id (null when it was already stored), its value and when it became valid. */
export const OUT_CREATED_FACT = z.object({ factId: z.number().nullable(), object: z.string(), validFrom: z.string() }).nullable().optional();

/** The fact a superseding save closed. */
export const OUT_CLOSED_FACT = z.object({ factId: z.number(), object: z.string(), validTo: z.string() }).nullable().optional();

/** A current value that may be the same fact under another name or scope (advisory, never merged). */
export const OUT_DUPLICATES = z.array(z.object({
  subject: z.string(), object: z.string(), scope: z.string(), validFrom: z.string(),
  source: z.string().optional(), untrusted: z.literal(true).optional(),
})).optional();

/** What a `replaces` link did: the correction recorded, or why none was made. */
export const OUT_REPLACEMENT = z.object({ id: z.string(), by: z.string() }).optional();

export const CALLER_SOURCE_ASCII = /^[A-Za-z0-9 _.:/@-]+$/;

/** A User-Agent product keeps its punctuation (cleanSource folds it) but may hold no character outside printable ASCII. */
export const USER_AGENT_PRODUCT_ASCII = /^[\x20-\x7e]+$/;

/** Validate an untrusted writer name and every spelling either writer can persist. */
export function callerSource(source: string): string {
  // Check what the caller actually supplied. Normalizing first would let fullwidth and other compatibility characters
  // become ASCII before this boundary and defeat the rule that typed writer names are plain ASCII.
  if (!CALLER_SOURCE_ASCII.test(source)) {
    throw refusal('invalid_argument', 'writer names must be plain ASCII (letters, digits, spaces, and - _ . : / @ only)');
  }
  const reserved = reservedCallerSource(source);
  if (reserved) throw refusal('invalid_argument', `source names a reserved identity (${reserved}); use an ordinary app or agent name, or leave source out`);
  return source;
}

export function markImportedOrigin<T extends { notePath?: unknown; path?: unknown; sourceNote?: unknown }>(item: T, pathKey: 'notePath' | 'path' | 'sourceNote'): T & { origin?: 'import' } {
  return String(item[pathKey] ?? '').startsWith('Imported/') ? { ...item, origin: 'import' as const } : item;
}

/**
 * A memory_map or read_memory memory as a read shows it: imported (origin), and a stored source that is a reserved identity
 * (an entry saved before the rule, or written into a file by hand) marked `untrusted`, a claim and not who saved it.
 */
export function markStoredMemory<T extends { path?: unknown; source?: unknown; untrusted?: true }>(item: T): T & { origin?: 'import'; untrusted?: true } {
  const marked = markImportedOrigin(item, 'path');
  return isReservedSource(marked.source) && marked.untrusted !== true ? { ...marked, untrusted: true as const } : marked;
}

/**
 * A search_memory or search_text hit as a read shows it: imported (origin), and `untrusted` when it is a daily-log chunk an
 * entry of which claims a reserved source (factMarkers.ts claimsReservedEntrySource), as get_context marks the same chunk.
 */
export function markStoredHit<T extends { notePath?: unknown; text?: unknown; untrusted?: true }>(hit: T): T & { origin?: 'import'; untrusted?: true } {
  const marked = markImportedOrigin(hit, 'notePath');
  return marked.untrusted !== true && claimsReservedEntrySource(marked.notePath, marked.text) ? { ...marked, untrusted: true as const } : marked;
}

/**
 * A search_memory or search_text hit as the engine returns it (engineSearchMemory / engineSearchText type them `unknown`):
 * the fields the marking, the facts lane and the page read.
 */
export type SearchHit = { authority?: string; notePath: string; chunkId?: number; headingPath?: string; text: string; score?: number; reason?: string; author?: string | null; untrusted?: true };

/** A hit's score as an agent is shown it: six decimals. The 17 digits of a double cost about 4 tokens a hit and say nothing the order does not. */
export function shortScore<T extends { score?: unknown }>(hit: T): T {
  return typeof hit.score === 'number' ? { ...hit, score: scoreForReply(hit.score) } : hit;
}

/** What a tool call can tell about the request it came in on: the headers the transport saw (lower-case names). */
export type CallExtra = { requestInfo?: { headers?: Record<string, unknown> }; authInfo?: AuthInfo };

/** A request header's first value, when it is a string. */
export function headerText(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** The gateway header, or the OAuth client's rendered name. Never a client-sent header on self-hosted HTTP. */
export function trustedAgentRaw(extra: CallExtra | undefined, config: MvpConfig): string | undefined {
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
export function trustedIdentity(raw: string, clientChosen: boolean): string {
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
export function sourceOf(sent: string | undefined, extra: CallExtra | undefined, config: MvpConfig): string | undefined {
  const source = sourceOfRaw(sent, extra, config);
  // With authority labels on, `owner` is the dashboard's connect-token name. No other call may write under it, whatever it
  // typed, sent as a User-Agent or named its connection (a key or OAuth client_name that normalises to it).
  if (authorityLabelsEnabled() && source === 'dashboard-inventory-read' && !isDashboardCall(extra?.requestInfo?.headers, config)) return 'unnamed';
  return source;
}

function sourceOfRaw(sent: string | undefined, extra: CallExtra | undefined, config: MvpConfig): string | undefined {
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
export function agentOf(extra: CallExtra | undefined, config: MvpConfig): string {
  const raw = trustedAgentRaw(extra, config);
  if (typeof raw !== 'string' || raw.trim() === '') return 'unnamed';
  return trustedIdentity(raw, !config.gatewaySecret);
}

/** Nameless connections must not share a feed, mark or inbox. */
export function hiveAgentOf(extra: CallExtra | undefined, tool: string, config: MvpConfig): string {
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

export function isDashboardCall(headers: Record<string, unknown> | undefined, config: MvpConfig): boolean {
  return Boolean(config.gatewaySecret) && headerText(headers, DASHBOARD_HEADER) === '1';
}

/**
 * The gateway's mark on a call from a directory client: a claude.ai or chatgpt.com connector, whose token the gateway marks
 * (oauth.ts DIRECTORY_TOKEN_MARK). Like DASHBOARD_HEADER it is trusted only behind the gateway, and it only narrows the tools
 * listed (no hive tool); it changes nothing a call may do.
 */
export const DIRECTORY_HEADER = 'x-renor-directory';

export function isDirectoryCall(headers: Record<string, unknown> | undefined, config: MvpConfig): boolean {
  return Boolean(config.gatewaySecret) && headerText(headers, DIRECTORY_HEADER) === '1';
}

/**
 * What a directory client is told about the memory. It says nothing about call order or behaviour: the directory rules forbid
 * that for other tools. Named agent keys keep the instructions built below.
 */
export const DIRECTORY_INSTRUCTIONS = 'Renor single-owner memory: the owner\'s own saved memory, kept in their private workspace. get_context returns the current facts and the saved memories that match a request. remember saves one statement, or a value with its subject, predicate and object.';

/** A tool's config with its title copied into annotations.title, where the Claude directory reads a display name from. */
export function withAnnotationTitle<C extends { title?: unknown; annotations?: Record<string, unknown> }>(config: C): C {
  if (typeof config?.title !== 'string' || config.annotations?.title !== undefined) return config;
  return { ...config, annotations: { ...config.annotations, title: config.title } };
}

/**
 * The tools only the dashboard may list or run: one erases retired memories for good, the other reads and sets the workspace's
 * choice to share learning data. Each registerTool call below spells its name as a literal, because the docs binding and the
 * hosted-tool tests read the registry off the literal call sites; if the two ever differ, registeredToolEntry throws when an
 * agent's server is built.
 */
export const OWNER_ONLY_TOOLS = ['delete_retired_memory', 'sharing_settings'] as const;

/** The tools agents use to reach each other. A directory client is offered none of them; registeredToolEntry throws if one is renamed. */
export const HIVE_TOOLS = ['whats_new', 'ask_agent', 'list_requests', 'answer_request', 'close_request'];

/**
 * The entry the SDK lists and runs a tool from. It is the object registerTool returned unless something replaced it:
 * @posthog/mcp, which wraps every server of a workspace that has RENOR_POSTHOG_KEY (posthogMcp.ts), swaps the registry for a
 * proxy that stores a COPY of each tool, and from then on the returned handle's disable() and `enabled` change nothing the SDK reads.
 */
export function registeredToolEntry(server: McpServer, name: string): { enabled: boolean } {
  const entry = (server as unknown as { _registeredTools?: Record<string, { enabled: boolean } | undefined> })._registeredTools?.[name];
  if (!entry) throw new Error(`${name} is missing from the SDK's tool registry`);
  return entry;
}

/** Builds a fresh McpServer with all MVP tools registered. The SDK
 * binds one transport per Protocol instance, so SSE sessions each get
 * their own server (bounded, in-process); JSON mode shares one.
 */
/** A capture feature flag read from the environment: 1, true, yes or on. */
export function envFlagOn(name: string): boolean {
  return /^(1|true|yes|on)$/i.test((process.env[name] ?? '').trim());
}

/** Whether any capture feature is on: memory_status advertises capture_features only then (flag-off output stays as it was). */
export function captureFlagsOn(): boolean {
  return saveMomentMode() !== 'off' || envFlagOn('RENOR_STATUS_LEDGER') || pinnedRulesEnabled()
    || ruleApprovalsEnabled() || sessionIndexEnabled() || captureServerOn();
}

export function editDistance(a: string, b: string): number {
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
export const MAX_SUBJECT_CHARS = 512;

export const SUBJECT_WORD_BREAK = /[^\p{L}\p{N}]+/u;

/**
 * Up to 5 known subjects the caller plausibly meant, closest first. A subject that the query names, that
 * contains the query, or that shares a word with it always qualifies; anything else must be a typo (a
 * normalized edit distance of at most 0.4). Names shorter than 3 characters are never matched by containment.
 */
export function closestSubjects(query: string, subjects: string[]): string[] {
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

/**
 * What a save's receipt says when the index pass after it left a file unfinished (its embedding failed): the pass's
 * counts, a warning, and why. The memory is saved, and keyword search finds it; search by meaning does once the next
 * save, or a search, finishes the file.
 */
export function unfinishedPass(pass: IndexPass) {
  const { failure, ...index } = pass;
  return { index, warning: 'memory-saved-but-index-refresh-failed', ...(failure === undefined ? {} : { detail: failure }) };
}

/**
 * What a note save's receipt says of the index pass run right after it (remember in note mode, remember_note): the
 * day's note the save wrote and the ledger are checked, so search finds the line at once, and a pass that failed is
 * said, and why. The note is saved either way.
 */
export async function indexSavedNote(db: Database.Database, config: MvpConfig, engine: Engine, digests: EngineDigests | null = null, noteFile: string) {
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
export function oneLineHint(err: unknown): unknown {
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
export function searchResult(body: { ok: boolean; error?: string }, result: unknown, structured: boolean) {
  if (body.ok) return { ...jsonResultOf(result, structured), isError: false };
  return markToolRefusal(refusalResult(result), SEARCH_REFUSAL_REASONS[String(body.error)] ?? 'refused');
}
