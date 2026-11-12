/**
 * What sharing sends, level by level. This file is the contract: the projector builds only these fields, the engine's
 * validator refuses anything else before a request is made, the ingestion endpoint (supabase/functions/sharing-ingest) holds
 * a copy of the same table and refuses what it does not list, and docs/TELEMETRY.md lists every name here (a test compares).
 *
 * Levels, in order of what leaves the machine:
 *   off      nothing is recorded for sharing and nothing is sent.
 *   signals  anonymous labelled numbers, computed inside the user's own data folder from the learning log. No text, no queries,
 *            no memory ids, no keys, no names, no paths.
 *   data     the signals, plus the text of the examples: the query behind a retrieval, the text of the memories it returned and
 *            of the statements that were saved. Only the user's explicit choice sends this.
 */

export const SHARING_LEVELS = ['off', 'signals', 'data'] as const;
export type SharingLevel = (typeof SHARING_LEVELS)[number];

export const SHARING_PROTOCOL = 1;

/** The version of the words the CLI shows before a user picks signals or data. A dashboard sends its own wording id. */
export const CLI_WORDING_VERSION = 'engine-cli-2026-10-29';

/**
 * The id of the words that describe the default (anonymous usage numbers on until the person turns them off): the words
 * `renor-engine telemetry status` and the service's start-up line show, and the wording a default batch names. A default is not
 * a choice, so it is stored as nothing more than this id. Change the words, change the id.
 */
export const DEFAULT_WORDING_VERSION = 'engine-default-2026-11-08';

/** The order of strength: off < signals < data. */
export function levelRank(level: SharingLevel): number {
  return SHARING_LEVELS.indexOf(level);
}

export function isSharingLevel(value: unknown): value is SharingLevel {
  return typeof value === 'string' && (SHARING_LEVELS as readonly string[]).includes(value);
}

/** The lower of two levels: how an override can only ever narrow what is shared. */
export function lowerLevel(a: SharingLevel, b: SharingLevel): SharingLevel {
  return levelRank(a) <= levelRank(b) ? a : b;
}

export const ROW_KINDS = ['retrieval-labelled/1', 'save-outcome/1', 'session-aggregate/1', 'install/1', 'heartbeat/1', 'funnel/1'] as const;
export type RowKind = (typeof ROW_KINDS)[number];

export type FieldType = 'string' | 'int' | 'number' | 'boolean';
export interface FieldSpec {
  type: FieldType;
  /** Null is a legal value (the engine did not know it). */
  nullable?: boolean;
  /** A closed set of strings, or a pattern the value must match. */
  oneOf?: readonly string[];
  pattern?: string;
  maxLength?: number;
  /** Sent only at this level or above. */
  level?: Exclude<SharingLevel, 'off'>;
  /**
   * The field may be absent: an engine released before it existed does not send it, and its rows are still accepted. This engine always
   * sends it (a test holds the projector to every listed field). Absent is read as "not known", like null.
   */
  optional?: boolean;
  /** A number's bucket (the coarse-values rule, below): every int or number field must declare one, and a value outside it is refused. */
  bucket?: NumberBucket;
}

/**
 * How coarse a number is. `range`: a whole number between min and max (a count or a position, capped). `pow2`: a power of two up to
 * max (a size class). `step`: a multiple of `step` between min and max (a score rounded to two places).
 */
export type NumberBucket =
  | { kind: 'range'; min: number; max: number }
  | { kind: 'pow2'; max: number }
  | { kind: 'step'; step: number; min: number; max: number };

/** Time, at most to the hour: `2026-10-21T14` (UTC). The only time pattern a shared field may use. */
export const HOUR_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}$';
/** A version, at most major.minor: `1.4`. The only version pattern a shared field may use (no patch, no build, no commit). */
export const MAJOR_MINOR_PATTERN = '^\\d{1,4}\\.\\d{1,4}$';
const HOUR = HOUR_PATTERN;

/**
 * The lanes a candidate can come from (its ranker trace's reason, without a `+…` qualifier). Anything else is sent as `other`: an
 * open label could carry what nobody listed.
 */
export const LANE_NAMES = [
  'semantic', 'fts', 'keyword', 'fact', 'graph', 'note-identity', 'timeline', 'events', 'span', 'session-expand', 'evidence-source', 'other',
] as const;
/** The rankers a retrieval can name. The shipped one is `baseline`; anything else is sent as `other`. */
export const RANKER_NAMES = ['baseline', 'other'] as const;
/**
 * The embedding models a row may name, as `provider:model:dims` (contextRelevance.ts embeddingModelKey): public models only. Any other
 * model (a local file, a fine-tune, a private deployment's name) is sent as null, because a rare name could single out its user.
 */
export const KNOWN_EMBEDDING_MODELS = [
  'vertex:gemini-embedding-001:768', 'vertex:gemini-embedding-001:1536', 'vertex:gemini-embedding-001:3072',
  'openai:gemini-embedding-001:768',
  'openai:text-embedding-3-small:512', 'openai:text-embedding-3-small:1536',
  'openai:text-embedding-3-large:256', 'openai:text-embedding-3-large:1024', 'openai:text-embedding-3-large:3072',
  'openai:text-embedding-ada-002:1536',
  'openai:voyage-4-large:256', 'openai:voyage-4-large:512', 'openai:voyage-4-large:1024', 'openai:voyage-4-large:2048',
  'openai:voyage-3-large:1024', 'openai:voyage-3.5:1024', 'openai:voyage-3.5-lite:1024',
] as const;

/** The model identifier a signals row may carry, or null when the recorded value is anything else. */
export function modelIdentifier(value: string | null): string | null {
  return value !== null && (KNOWN_EMBEDDING_MODELS as readonly string[]).includes(value) ? value : null;
}

/** How long an install has existed (from the first-seen date it keeps locally), as of the row's hour. Null only from an engine before it. */
export const INSTALL_AGE_BUCKETS = ['<1w', '1-4w', '1-3m', '3m+'] as const;
export type InstallAge = (typeof INSTALL_AGE_BUCKETS)[number];
const DAY_MS = 86_400_000;
export function installAgeBucket(firstSeenMs: number, atMs: number): InstallAge {
  const days = Math.max(0, atMs - firstSeenMs) / DAY_MS;
  if (days < 7) return '<1w';
  if (days < 28) return '1-4w';
  if (days < 91) return '1-3m';
  return '3m+';
}
const installAge: FieldSpec = { type: 'string', nullable: true, oneOf: INSTALL_AGE_BUCKETS };

/** The most candidates, positions or served items a row carries; a larger count is sent as this. */
export const MAX_COUNT = 200;
/** The largest reply size class; a larger reply is sent as this. */
export const MAX_TOKEN_BUCKET = 65_536;
/** A score is sent to two decimal places, within ±SCORE_LIMIT. */
export const SCORE_STEP = 0.01;
export const SCORE_LIMIT = 100;
export const DELAY_BUCKETS = ['<1m', '<10m', '<1h', '<1d', '>=1d'] as const;
export const COUNT_BUCKETS = ['0', '1', '2-3', '4-7', '8+'] as const;
export const LENGTH_BUCKETS = ['<1m', '<10m', '<1h', '<6h', '>=6h'] as const;
export const RETRIEVAL_TOOL_NAMES = ['get_context', 'search_memory', 'retrieve_memory'] as const;
export const SAVE_TOOL_NAMES = ['remember', 'save_memory', 'remember_note'] as const;
export const CANDIDATE_KIND_NAMES = ['fact', 'note', 'unkeyed'] as const;
export const SAVE_ITEM_NAMES = ['fact', 'note', 'event', 'unkeyed'] as const;

// What every row says about where it was made (2026-11-08: the owner asked for as much as stays anonymous). Each is a closed list or a
// number: the list is the whole vocabulary, so a value names a family of installs, never one. A value outside a list is sent as `other`
// (or null where the field allows it), never as the value itself.
/** Renor's hosted service (the engine runs behind the gateway, MVP_GATEWAY_SECRET) or an install someone runs themselves. */
export const DEPLOYMENTS = ['cloud', 'self-hosted'] as const;
/** The AI application on the other end, reduced from the MCP client's declared name (sharing/context.ts appFamily). */
export const APP_FAMILIES = ['claude-code', 'cursor', 'codex', 'chatgpt', 'claude-ai', 'hermes', 'dsh', 'other'] as const;
/** The Node.js major of a self-hosted install, as a closed list (an odd, older or newer major is `other`); null on cloud. */
export const NODE_MAJORS = ['18', '20', '22', '24', 'other'] as const;
/** The tool set the connection was given (contextProfile.ts): every tool, the coding preset, the lean preset, or a named list. */
export const TOOL_PROFILES = ['full', 'coding', 'lean', 'custom'] as const;
/** The embedding provider family behind semantic search (mvp/config.ts embeddingProvider), `none` when retrieval is keyword only. */
export const EMBEDDING_FAMILIES = ['none', 'local', 'openai', 'vertex', 'other'] as const;
/** How the call arrived: over MCP (an AI application), or from the owner's dashboard (the platform reading for the owner). */
export const VIA_NAMES = ['mcp', 'dashboard'] as const;
/** How long the engine took to answer the call, as a class. */
export const LATENCY_BUCKETS = ['<50ms', '<200ms', '<1s', '<5s', '>=5s'] as const;

/** The longest text one example may carry, in characters. A longer text is cut at this length by the projector. */
export const MAX_EXAMPLE_TEXT = 2000;

// The usage rows (install/1, heartbeat/1, funnel/1, and the opt-out count): labels and buckets only. A label is a closed set or a short
// identifier pattern, so no text, name or path can pass; a count is a SIZE_BUCKET, never the number itself.
/** A day, `2026-11-06` (UTC): coarser than an hour, so it passes the coarse-values rule as a time. */
export const DAY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
const DAY = DAY_PATTERN;
/**
 * A random id made on the machine (16 random bytes, hex): the usage rows' install id, which is replaced with the contributor id every month
 * (state.ts monthlyRotation), and a funnel row's per-process session id. It carries nothing but itself, so the coarse-values rule allows it
 * as the one kind of identifier, and only with exactly this pattern.
 */
export const RANDOM_ID_PATTERN = '^[0-9a-f]{32}$';
const INSTALL_ID = RANDOM_ID_PATTERN;

/** A version cut to major.minor (`1.4.3`, `v1.4`, `0.9.1-beta.2` give `1.4`, `1.4`, `0.9`); null when it does not start like a version. */
export function majorMinor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^v?([0-9]{1,4})(?:\.([0-9]{1,4}))?/.exec(value.trim());
  return match === null ? null : `${Number(match[1])}.${Number(match[2] ?? 0)}`;
}

/**
 * The tools a heartbeat may name: the engine's own MCP tools (and the names the usage counter knows from other transports). Any other name is
 * sent as `other`.
 */
export const TOOL_NAMES = [
  'answer_request', 'apply_import', 'ask_agent', 'close_request', 'delete_retired_memory', 'export_memory', 'get_context', 'index_memory',
  'list_requests', 'lookup_entity', 'memory_map', 'memory_status', 'preview_import', 'read_memory', 'remember', 'remember_note',
  'restore_memory', 'retire_memory', 'retrieve_memory', 'save_memory', 'search_history', 'search_memory', 'search_text', 'sharing_level',
  'sharing_settings', 'undo_import', 'whats_new', 'remember_fact', 'note', 'search', 'keyword', 'evidence', 'facts', 'entity', 'other',
] as const;
/**
 * The failure classes a heartbeat may name: JavaScript's and the engine's own error classes, SQLite's and Node's error codes, and MCP's.
 * Any other class or code is sent as `other`: a free label could carry what nobody listed.
 */
export const ERROR_CLASSES = [
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError', 'TimeoutError', 'McpError', 'ZodError', 'SqliteError',
  'ClientRegistryError', 'DigestBudgetError', 'DreamerCapError', 'EmbeddingUnavailableError', 'EvidenceCapError', 'EvidenceReplyError',
  'ExtractorParseError', 'HistoryUnavailableError', 'ImportRefusedError', 'ImportStorageLimitError', 'LegacyIdentityAmbiguityError',
  'LifecycleInputError', 'NoteTooLargeError', 'ProvenanceError', 'RouterParseError', 'RunRefusedError', 'SecretRefusedError',
  'StaleExpectationError', 'StatusError',
  'SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CORRUPT', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_CANTOPEN', 'SQLITE_READONLY',
  'SQLITE_CONSTRAINT', 'SQLITE_NOMEM', 'SQLITE_INTERRUPT',
  'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'ERR_INVALID_ARG_TYPE',
  'invalid_argument', 'not_found', 'forbidden', 'unauthorized', 'internal', 'timeout', 'rate_limited', 'too_large', 'conflict', 'other',
] as const;
/** The listed label for a tool or failure class, else `other`. */
export function listedOrOther<T extends readonly string[]>(list: T, value: string): T[number] {
  return (list as readonly string[]).includes(value) ? value : 'other';
}
/** Counts as a range, never exact: 0, 1-9, 10-99, 100-999, 1000-9999, 10000+. */
export const SIZE_BUCKETS = ['0', '1-9', '10-99', '100-999', '1000-9999', '10000+'] as const;
export const OS_FAMILIES = ['linux', 'darwin', 'win32', 'freebsd', 'openbsd', 'other'] as const;
export const ARCHES = ['x64', 'arm64', 'arm', 'ia32', 'other'] as const;
export const TRANSPORTS = ['stdio', 'http'] as const;
export const EMBEDDING_MODES = ['none', 'local', 'openai', 'vertex', 'other'] as const;
export const RERANKERS = ['off', 'query-words'] as const;
export const INDEX_LABELS = ['keyword', 'hybrid'] as const;
export const FUNNEL_STEPS = ['installed', 'notice_shown', 'first_save', 'first_recall', 'first_recall_used'] as const;
/**
 * The MCP clients a heartbeat may name (`clientInfo.name`, matched as a label): a closed list, so a client that declares a person's or a
 * machine's name in its clientInfo is sent as `other`, never as itself.
 */
export const MCP_CLIENTS = [
  'claude-code', 'claude-ai', 'claude-desktop', 'chatgpt', 'openai-mcp', 'codex', 'cursor', 'windsurf', 'vscode', 'visual-studio-code',
  'zed', 'cline', 'roo-code', 'continue', 'goose', 'gemini-cli', 'opencode', 'warp', 'jetbrains', 'lm-studio', 'librechat',
  'mcp-inspector', 'hermes', 'renor', 'other',
] as const;
export const OPT_OUT_VIA = ['command', 'agent', 'env', 'setup', 'dashboard', 'other'] as const;
/** The latency ranges of one tool's calls, each field the count of calls in that range (as a SIZE_BUCKET). */
export const LATENCY_FIELDS = ['lt50ms_bucket', 'lt200ms_bucket', 'lt1s_bucket', 'lt5s_bucket', 'ge5s_bucket'] as const;
/** The most entries a heartbeat's `tools` and `errors` may hold. The engine folds the rest into `other`. */
export const MAX_TOOL_ENTRIES = 64;
export const MAX_ERROR_ENTRIES = 16;

const sizeBucket: FieldSpec = { type: 'string', oneOf: SIZE_BUCKETS };
const sizeBucketOrNull: FieldSpec = { type: 'string', nullable: true, oneOf: SIZE_BUCKETS };
/** The environment an install and a heartbeat both describe. */
const ENVIRONMENT_FIELDS: Record<string, FieldSpec> = {
  install_id: { type: 'string', pattern: INSTALL_ID },
  // The engine's version, major.minor only (`1.4`); null when unknown. No patch, no build, no commit: a rare build could single out its user.
  version: { type: 'string', nullable: true, pattern: MAJOR_MINOR_PATTERN },
  node_major: { type: 'int', bucket: { kind: 'range', min: 0, max: 99 } },
  os: { type: 'string', oneOf: OS_FAMILIES },
  arch: { type: 'string', oneOf: ARCHES },
  ci: { type: 'boolean' },
  // true when the engine ran as Renor's own (CONTEXT_FIELDS.internal); optional because an older engine leaves it out.
  internal: { type: 'boolean', optional: true },
  transport: { type: 'string', oneOf: TRANSPORTS },
};

/** One entry of a heartbeat's `tools`: a tool's calls that day and how long they took. */
export const TOOL_ENTRY_FIELDS: Record<string, FieldSpec> = {
  tool: { type: 'string', oneOf: TOOL_NAMES },
  calls_bucket: sizeBucket,
  lt50ms_bucket: sizeBucket,
  lt200ms_bucket: sizeBucket,
  lt1s_bucket: sizeBucket,
  lt5s_bucket: sizeBucket,
  ge5s_bucket: sizeBucket,
};
/** One entry of a heartbeat's `errors`: a failure's class (a code or a class name, never a message) and how often it happened that day. */
export const ERROR_ENTRY_FIELDS: Record<string, FieldSpec> = {
  class: { type: 'string', oneOf: ERROR_CLASSES },
  count_bucket: sizeBucket,
};

const bool: FieldSpec = { type: 'boolean' };
const boolOrNull: FieldSpec = { type: 'boolean', nullable: true };
// The engine's released version is sent as major.minor only (MAJOR_MINOR_PATTERN, the coarse-values rule); a pre-release or a fork's own tag
// is sent as null, because such a value can be rare enough to point at one install.

/**
 * The fields every row kind carries about where it was made. All optional at the endpoint (an older engine leaves them out); this engine
 * always sends them. `internal` is true when the engine ran as Renor's own (RENOR_SHARING_INTERNAL=1, or a CI or test runner's marker):
 * those rows are kept apart from real usage and never counted as a user's.
 */
export const CONTEXT_FIELDS: Record<string, FieldSpec> = {
  deployment: { type: 'string', oneOf: DEPLOYMENTS, optional: true },
  internal: { type: 'boolean', optional: true },
  release: { type: 'string', nullable: true, pattern: MAJOR_MINOR_PATTERN, optional: true },
  app: { type: 'string', nullable: true, oneOf: APP_FAMILIES, optional: true },
  profile: { type: 'string', nullable: true, oneOf: TOOL_PROFILES, optional: true },
  os: { type: 'string', nullable: true, oneOf: OS_FAMILIES, optional: true },
  node: { type: 'string', nullable: true, oneOf: NODE_MAJORS, optional: true },
};

/** Fields of one entry of `candidates` in a retrieval-labelled row. */
export const CANDIDATE_FIELDS: Record<string, FieldSpec> = {
  rank: { type: 'int', bucket: { kind: 'range', min: 0, max: MAX_COUNT } },
  kind: { type: 'string', oneOf: CANDIDATE_KIND_NAMES },
  lane: { type: 'string', nullable: true, oneOf: LANE_NAMES },
  score: { type: 'number', nullable: true, bucket: { kind: 'step', step: SCORE_STEP, min: -SCORE_LIMIT, max: SCORE_LIMIT } },
  matched: boolOrNull,
  current: boolOrNull,
  opened: boolOrNull,
  cited: boolOrNull,
  updated: boolOrNull,
  retired: boolOrNull,
  delay_bucket: { type: 'string', nullable: true, oneOf: DELAY_BUCKETS },
  text: { type: 'string', nullable: true, maxLength: MAX_EXAMPLE_TEXT, level: 'data' },
};

/** Top-level fields of each row kind. `kind` is in every row and names the row's version. */
export const ROW_FIELDS: Record<RowKind, Record<string, FieldSpec>> = {
  'retrieval-labelled/1': {
    kind: { type: 'string', oneOf: ['retrieval-labelled/1'] },
    hour: { type: 'string', pattern: HOUR },
    tool: { type: 'string', oneOf: RETRIEVAL_TOOL_NAMES },
    install_age: installAge,
    ranker: { type: 'string', oneOf: RANKER_NAMES },
    model: { type: 'string', nullable: true, oneOf: KNOWN_EMBEDDING_MODELS },
    retrieval: { type: 'string', nullable: true, oneOf: ['facts', 'hybrid', 'semantic', 'keyword'] },
    served: { type: 'int', bucket: { kind: 'range', min: 0, max: MAX_COUNT } },
    reply_tokens_bucket: { type: 'int', nullable: true, bucket: { kind: 'pow2', max: MAX_TOKEN_BUCKET } },
    relevant: boolOrNull,
    truncated: boolOrNull,
    ...CONTEXT_FIELDS,
    semantic: { type: 'boolean', nullable: true, optional: true },
    embedding: { type: 'string', nullable: true, oneOf: EMBEDDING_FAMILIES, optional: true },
    via: { type: 'string', oneOf: VIA_NAMES, optional: true },
    latency_bucket: { type: 'string', nullable: true, oneOf: LATENCY_BUCKETS, optional: true },
    scored: { type: 'int', nullable: true, optional: true, bucket: { kind: 'range', min: 0, max: MAX_COUNT } },
    lean: { type: 'boolean', nullable: true, optional: true },
    query: { type: 'string', nullable: true, maxLength: MAX_EXAMPLE_TEXT, level: 'data' },
    // candidates is an array of objects; it is checked against CANDIDATE_FIELDS.
  },
  'save-outcome/1': {
    kind: { type: 'string', oneOf: ['save-outcome/1'] },
    hour: { type: 'string', pattern: HOUR },
    install_age: installAge,
    tool: { type: 'string', oneOf: SAVE_TOOL_NAMES },
    op: { type: 'string', oneOf: ['create', 'supersede'] },
    item: { type: 'string', oneOf: SAVE_ITEM_NAMES },
    has_cites: bool,
    reads_bucket: { type: 'string', oneOf: COUNT_BUCKETS },
    opened: bool,
    cited: bool,
    superseded: bool,
    retired: bool,
    ...CONTEXT_FIELDS,
    via: { type: 'string', oneOf: VIA_NAMES, optional: true },
    latency_bucket: { type: 'string', nullable: true, oneOf: LATENCY_BUCKETS, optional: true },
    text: { type: 'string', nullable: true, maxLength: MAX_EXAMPLE_TEXT, level: 'data' },
  },
  'session-aggregate/1': {
    kind: { type: 'string', oneOf: ['session-aggregate/1'] },
    hour: { type: 'string', pattern: HOUR },
    install_age: installAge,
    length_bucket: { type: 'string', oneOf: LENGTH_BUCKETS },
    reads_bucket: { type: 'string', oneOf: COUNT_BUCKETS },
    saves_bucket: { type: 'string', oneOf: COUNT_BUCKETS },
    empty_reads_bucket: { type: 'string', oneOf: COUNT_BUCKETS },
    first_call: { type: 'string', oneOf: [...RETRIEVAL_TOOL_NAMES, ...SAVE_TOOL_NAMES, 'other'] },
    opens_bucket: { type: 'string', oneOf: COUNT_BUCKETS, optional: true },
    ...CONTEXT_FIELDS,
  },
  'install/1': {
    kind: { type: 'string', oneOf: ['install/1'] },
    hour: { type: 'string', pattern: HOUR },
    install_age: installAge,
    ...ENVIRONMENT_FIELDS,
  },
  'heartbeat/1': {
    kind: { type: 'string', oneOf: ['heartbeat/1'] },
    // The day the heartbeat covers, as its first hour (`2026-11-06T00`): one heartbeat per active day.
    hour: { type: 'string', pattern: HOUR },
    install_age: installAge,
    ...ENVIRONMENT_FIELDS,
    client_name: { type: 'string', nullable: true, oneOf: MCP_CLIENTS },
    client_version: { type: 'string', nullable: true, pattern: MAJOR_MINOR_PATTERN },
    embedding: { type: 'string', nullable: true, oneOf: EMBEDDING_MODES },
    model: { type: 'string', nullable: true, oneOf: KNOWN_EMBEDDING_MODELS },
    reranker: { type: 'string', nullable: true, oneOf: RERANKERS },
    index: { type: 'string', nullable: true, oneOf: INDEX_LABELS },
    memories_bucket: sizeBucketOrNull,
    notes_bucket: sizeBucketOrNull,
    facts_bucket: sizeBucketOrNull,
    // tools and errors are arrays of objects; they are checked against TOOL_ENTRY_FIELDS and ERROR_ENTRY_FIELDS.
  },
  'funnel/1': {
    kind: { type: 'string', oneOf: ['funnel/1'] },
    hour: { type: 'string', pattern: HOUR },
    install_age: installAge,
    session: { type: 'string', pattern: INSTALL_ID },
    step: { type: 'string', oneOf: FUNNEL_STEPS },
    internal: { type: 'boolean', optional: true },
  },
};

/**
 * What Renor adds to every stored row at ingest, never sent by an install (a row that carries it is refused as an unlisted field): the
 * request's country, its 2-letter ISO code from the platform's geo header, or null. The address itself is never stored.
 */
export const INGEST_FIELDS = ['country'] as const;

/** Row kinds that carry a `candidates` array. */
export const KINDS_WITH_CANDIDATES: readonly RowKind[] = ['retrieval-labelled/1'];

/** The array fields of each row kind: the fields of one entry, and the most entries the array may hold. */
export const ARRAY_FIELDS: Partial<Record<RowKind, Record<string, { fields: Record<string, FieldSpec>; max: number }>>> = {
  'retrieval-labelled/1': { candidates: { fields: CANDIDATE_FIELDS, max: 200 } },
  'heartbeat/1': { tools: { fields: TOOL_ENTRY_FIELDS, max: MAX_TOOL_ENTRIES }, errors: { fields: ERROR_ENTRY_FIELDS, max: MAX_ERROR_ENTRIES } },
};

/** Fields of the batch envelope the engine sends (not rows). */
export const BATCH_FIELDS = ['protocol', 'action', 'batch_id', 'level', 'wording', 'rows'] as const;
export const DELETE_FIELDS = ['protocol', 'action'] as const;
/** An install asks Renor for its credential: nothing but the protocol and the action (no data, no identifier). */
export const REGISTER_FIELDS = ['protocol', 'action'] as const;
/**
 * A self-hosted install's batch also carries its consent record, the evidence of the choice it sends under: the version of the
 * record, the level chosen (at least the batch's), when it was chosen, the wording seen, and the 18-or-older confirmation.
 * A hosted workspace's consent is the platform's own record, so its batch has none.
 */
export const CONSENT_FIELD = 'consent';
export const CONSENT_FIELDS = ['version', 'level', 'changed_at', 'wording', 'adult'] as const;
export const SELF_HOSTED_BATCH_FIELDS = [...BATCH_FIELDS, CONSENT_FIELD] as const;
/**
 * A batch sent under the default carries `default: true` instead of a consent record: the person has not chosen, so there is no
 * record to carry, and the level is always `signals`. It is a third shape, never combined with `consent`, so a batch of an
 * explicit choice is exactly what it was before the default existed.
 */
export const DEFAULT_FIELD = 'default';
export const DEFAULT_BATCH_FIELDS = [...BATCH_FIELDS, DEFAULT_FIELD] as const;
/** The endpoint's refusals after which the same rows must never be sent again (send.ts stops instead of retrying). */
export const TERMINAL_REFUSALS = ['sharing_closed', 'consent_off', 'consent_required'] as const;

/** Every field name a level may send, for the documentation check. `signals` is a subset of `data`. */
export function fieldsAtLevel(level: Exclude<SharingLevel, 'off'>): string[] {
  const names = new Set<string>();
  const allowed = (spec: FieldSpec): boolean => spec.level === undefined || levelRank(spec.level) <= levelRank(level);
  for (const kind of ROW_KINDS) {
    for (const [name, spec] of Object.entries(ROW_FIELDS[kind])) if (allowed(spec)) names.add(`${kind}.${name}`);
  }
  for (const kind of ROW_KINDS) {
    for (const [array, entry] of Object.entries(ARRAY_FIELDS[kind] ?? {})) {
      for (const [name, spec] of Object.entries(entry.fields)) if (allowed(spec)) names.add(`${kind}.${array}.${name}`);
    }
  }
  return [...names].sort();
}

export class RowError extends Error {}

/** Whether a number is a value its bucket allows. */
export function inBucket(bucket: NumberBucket, value: number): boolean {
  switch (bucket.kind) {
    case 'range':
      return Number.isInteger(value) && value >= bucket.min && value <= bucket.max;
    case 'pow2':
      return Number.isInteger(value) && value >= 1 && value <= bucket.max && (value & (value - 1)) === 0;
    case 'step': {
      if (value < bucket.min || value > bucket.max) return false;
      const steps = value / bucket.step;
      return Math.abs(steps - Math.round(steps)) < 1e-6;
    }
  }
}

/**
 * The coarse-values rule, as a check on the contract itself (owner decision, 2026-11-08): no field, alone or with others, may be fine
 * enough to single out a person. Every field a signals row carries must be one of:
 *   a flag (boolean);
 *   a closed set of strings (oneOf);
 *   a time at most to the hour (exactly HOUR_PATTERN, or DAY_PATTERN);
 *   the one identifier: a random id made on the machine (exactly RANDOM_ID_PATTERN), replaced every month or every process;
 *   a version at most major.minor (exactly MAJOR_MINOR_PATTERN);
 *   a bucketed number (an int or number with a declared `bucket`).
 * The text fields are the one exception, and only at `data` (text for training, which only the person's explicit choice sends).
 * Returns the fields that break it, with why; empty when the contract keeps it. A test holds it empty, and a new field must pass it.
 */
export function coarseViolations(
  rows: Record<string, Record<string, FieldSpec>> = ROW_FIELDS,
  arrays: Partial<Record<string, Record<string, { fields: Record<string, FieldSpec> }>>> = ARRAY_FIELDS,
  others: Record<string, Record<string, FieldSpec>> = { [OPT_OUT_KIND]: OPT_OUT_FIELDS },
): string[] {
  const out: string[] = [];
  const check = (name: string, spec: FieldSpec): void => {
    if (spec.level === 'data') return;
    switch (spec.type) {
      case 'boolean':
        return;
      case 'string':
        if (spec.oneOf !== undefined) {
          if (spec.oneOf.length === 0) out.push(`${name}: an empty closed set`);
          return;
        }
        if (spec.pattern === HOUR_PATTERN || spec.pattern === DAY_PATTERN || spec.pattern === MAJOR_MINOR_PATTERN) return;
        // The one identifier allowed: a random id made on the machine, which says nothing but itself (RANDOM_ID_PATTERN).
        if (spec.pattern === RANDOM_ID_PATTERN) return;
        out.push(`${name}: a string that is neither a closed set, an hour or day, a major.minor version nor a random id`);
        return;
      case 'int':
      case 'number':
        if (spec.bucket === undefined) out.push(`${name}: a number with no bucket`);
        else if (spec.type === 'number' && spec.bucket.kind !== 'step') out.push(`${name}: a fractional number must be bucketed by a step`);
        return;
    }
  };
  for (const [kind, specs] of Object.entries(rows)) for (const [name, spec] of Object.entries(specs)) check(`${kind}.${name}`, spec);
  for (const [kind, byArray] of Object.entries(arrays)) {
    for (const [array, entry] of Object.entries(byArray ?? {})) {
      for (const [name, spec] of Object.entries(entry.fields)) check(`${kind}.${array}.${name}`, spec);
    }
  }
  for (const [kind, specs] of Object.entries(others)) for (const [name, spec] of Object.entries(specs)) check(`${kind}.${name}`, spec);
  return out;
}

/**
 * A row made as coarse as the contract says, from what an engine built before the rule (2026-11-08) may still send: the ingest function
 * applies it before validating, so an older engine's rows are stored coarse instead of being refused, and the engine's projector applies it
 * too, so one function decides. It drops `build` (a commit, finer than a major.minor version), names an unlisted ranker, lane or model as
 * `other` (or null; a lane joined from several is null), rounds a score to two places, caps counts and sizes, and marks a missing install age as unknown (null). It changes
 * nothing it does not recognise: anything else is left for validateRow to refuse.
 */
/** coarsenRow for an install or heartbeat row: no commit, versions to major.minor, Node's major capped, tools, failures and model listed. */
function coarsenUsage(out: Record<string, unknown>): Record<string, unknown> {
  delete out.build;
  if (typeof out.version === 'string') out.version = majorMinor(out.version);
  if (typeof out.node_major === 'number' && Number.isInteger(out.node_major)) out.node_major = Math.min(99, Math.max(0, out.node_major));
  if (out.kind !== 'heartbeat/1') return out;
  if (typeof out.client_version === 'string') out.client_version = majorMinor(out.client_version);
  if (typeof out.model === 'string') out.model = modelIdentifier(out.model);
  const relabel = (entries: unknown, field: string, list: readonly string[]): unknown => (Array.isArray(entries)
    ? entries.map(entry => (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && typeof (entry as Record<string, unknown>)[field] === 'string'
      ? { ...(entry as Record<string, unknown>), [field]: listedOrOther(list, (entry as Record<string, string>)[field]!) }
      : entry))
    : entries);
  out.tools = relabel(out.tools, 'tool', TOOL_NAMES);
  out.errors = relabel(out.errors, 'class', ERROR_CLASSES);
  return out;
}

export function coarsenRow(row: unknown): unknown {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  const kind = out.kind;
  if (typeof kind !== 'string' || !(ROW_KINDS as readonly string[]).includes(kind)) return out;
  // Only a kind whose table lists the field gets it (a row kind added later decides for itself).
  const listsAge = Object.prototype.hasOwnProperty.call(ROW_FIELDS[kind as RowKind], 'install_age');
  if (listsAge && !Object.prototype.hasOwnProperty.call(out, 'install_age')) out.install_age = null;
  if (kind === 'install/1' || kind === 'heartbeat/1') return coarsenUsage(out);
  if (kind !== 'retrieval-labelled/1') return out;
  delete out.build;
  const cap = (value: unknown): unknown =>
    typeof value === 'number' && Number.isInteger(value) ? Math.min(MAX_COUNT, Math.max(0, value)) : value;
  if (typeof out.ranker === 'string' && !(RANKER_NAMES as readonly string[]).includes(out.ranker)) out.ranker = 'other';
  if (typeof out.model === 'string') out.model = modelIdentifier(out.model);
  out.served = cap(out.served);
  if (Object.prototype.hasOwnProperty.call(out, 'scored')) out.scored = cap(out.scored);
  const tokens = out.reply_tokens_bucket;
  if (typeof tokens === 'number' && Number.isInteger(tokens)) {
    let bucket = 1;
    while (bucket < tokens && bucket < MAX_TOKEN_BUCKET) bucket *= 2;
    out.reply_tokens_bucket = bucket;
  }
  if (Array.isArray(out.candidates)) {
    out.candidates = out.candidates.map(candidate => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return candidate;
      const c: Record<string, unknown> = { ...(candidate as Record<string, unknown>) };
      c.rank = cap(c.rank);
      if (typeof c.lane === 'string') {
        // Several lanes joined (`semantic+content+recency`) are no one lane: null, as the projector has sent them since #1537.
        c.lane = c.lane.includes('+') ? null : (LANE_NAMES as readonly string[]).includes(c.lane) ? c.lane : 'other';
      }
      if (typeof c.score === 'number' && Number.isFinite(c.score)) {
        c.score = Math.round(Math.min(SCORE_LIMIT, Math.max(-SCORE_LIMIT, c.score)) / SCORE_STEP) / Math.round(1 / SCORE_STEP);
      }
      return c;
    });
  }
  return out;
}

function checkValue(path: string, spec: FieldSpec, value: unknown): void {
  if (value === null) {
    if (spec.nullable) return;
    throw new RowError(`${path} must not be null`);
  }
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') throw new RowError(`${path} must be a string`);
      if (spec.oneOf && !spec.oneOf.includes(value)) throw new RowError(`${path} is not one of the listed values`);
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) throw new RowError(`${path} does not match its pattern`);
      if (spec.maxLength !== undefined && value.length > spec.maxLength) throw new RowError(`${path} is longer than ${spec.maxLength}`);
      return;
    }
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new RowError(`${path} must be an integer`);
      if (spec.bucket !== undefined && !inBucket(spec.bucket, value)) throw new RowError(`${path} is finer or wider than its bucket`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new RowError(`${path} must be a finite number`);
      if (spec.bucket !== undefined && !inBucket(spec.bucket, value)) throw new RowError(`${path} is finer or wider than its bucket`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw new RowError(`${path} must be a boolean`);
      return;
  }
}

function checkObject(path: string, specs: Record<string, FieldSpec>, value: unknown, level: Exclude<SharingLevel, 'off'>, skip: readonly string[] = []): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RowError(`${path} must be an object`);
  const record = value as Record<string, unknown>;
  for (const name of Object.keys(record)) {
    if (skip.includes(name)) continue;
    // Own properties only: `constructor`, `toString` or an own `__proto__` key must not be read off Object.prototype as a listed field.
    const spec = Object.prototype.hasOwnProperty.call(specs, name) ? specs[name] : undefined;
    if (spec === undefined) throw new RowError(`${path}.${name} is not a listed field`);
    if (spec.level !== undefined && levelRank(spec.level) > levelRank(level)) {
      throw new RowError(`${path}.${name} is not shared at level ${level}`);
    }
  }
  for (const [name, spec] of Object.entries(specs)) {
    if (skip.includes(name)) continue;
    if (spec.level !== undefined && levelRank(spec.level) > levelRank(level)) continue;
    if (spec.level !== undefined && !(name in record)) continue; // a text field may be absent
    if (spec.optional === true && !(name in record)) continue; // an older engine's row
    if (!(name in record)) throw new RowError(`${path}.${name} is missing`);
    checkValue(`${path}.${name}`, spec, record[name]);
  }
}

/** Throws a RowError unless the row holds exactly the listed fields for its kind, with the listed value shapes, at `level`. */
export function validateRow(row: unknown, level: Exclude<SharingLevel, 'off'>): void {
  if (typeof row !== 'object' || row === null) throw new RowError('a row must be an object');
  const kind = (row as Record<string, unknown>).kind;
  if (typeof kind !== 'string' || !(ROW_KINDS as readonly string[]).includes(kind)) throw new RowError('kind is not a listed row kind');
  const specs = ROW_FIELDS[kind as RowKind];
  const arrays = ARRAY_FIELDS[kind as RowKind] ?? {};
  checkObject(kind, specs, row, level, Object.keys(arrays));
  for (const [name, entry] of Object.entries(arrays)) {
    const items = (row as Record<string, unknown>)[name];
    if (!Array.isArray(items)) throw new RowError(`${kind}.${name} must be an array`);
    if (items.length > entry.max) throw new RowError(`${kind}.${name} has more than ${entry.max} entries`);
    items.forEach((item, index) => checkObject(`${kind}.${name}[${index}]`, entry.fields, item, level));
  }
}

/**
 * The opt-out count: one row, sent when sharing is turned off, with no bearer and no identifier of any kind (no install id, no session, no
 * contributor). Its own request, `{ protocol, action: "opt-out", row }`, never a batch, so it can never be joined to the rows sent before it.
 */
export const OPT_OUT_KIND = 'opt-out/1';
export const OPT_OUT_FIELDS: Record<string, FieldSpec> = {
  kind: { type: 'string', oneOf: [OPT_OUT_KIND] },
  day: { type: 'string', pattern: DAY },
  via: { type: 'string', oneOf: OPT_OUT_VIA },
};
export const OPT_OUT_REQUEST_FIELDS = ['protocol', 'action', 'row'] as const;

/** Throws a RowError unless `row` is exactly an opt-out row. */
export function validateOptOut(row: unknown): void {
  checkObject(OPT_OUT_KIND, OPT_OUT_FIELDS, row, 'signals');
}

/** Largest batch: rows per request. The endpoint enforces the same. */
export const MAX_ROWS_PER_BATCH = 200;
