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
export const DEFAULT_WORDING_VERSION = 'engine-default-2026-10-28';

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

export const ROW_KINDS = ['retrieval-labelled/1', 'save-outcome/1', 'session-aggregate/1'] as const;
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
}

const HOUR = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}$';
const LANE = '^[a-z][a-z0-9-]{0,31}$';
const BUILD = '^[0-9a-f]{7,40}$';
// The embedding model as `provider:model:dims` (contextRelevance.ts embeddingModelKey): a model identifier only, so no '/',
// '\\', space or other path or name character can pass. A local model named by a path or `org/name` is sent as null.
const MODEL = '^[a-z][a-z0-9-]{0,15}:[A-Za-z0-9._-]{1,64}:[0-9]{0,6}$';

/** The model identifier a signals row may carry, or null when the recorded value is anything else. */
export function modelIdentifier(value: string | null): string | null {
  return value !== null && new RegExp(MODEL).test(value) ? value : null;
}
export const DELAY_BUCKETS = ['<1m', '<10m', '<1h', '<1d', '>=1d'] as const;
export const COUNT_BUCKETS = ['0', '1', '2-3', '4-7', '8+'] as const;
export const LENGTH_BUCKETS = ['<1m', '<10m', '<1h', '<6h', '>=6h'] as const;
export const RETRIEVAL_TOOL_NAMES = ['get_context', 'search_memory', 'retrieve_memory'] as const;
export const SAVE_TOOL_NAMES = ['remember', 'save_memory', 'remember_note'] as const;
export const CANDIDATE_KIND_NAMES = ['fact', 'note', 'unkeyed'] as const;
export const SAVE_ITEM_NAMES = ['fact', 'note', 'event', 'unkeyed'] as const;

/** The longest text one example may carry, in characters. A longer text is cut at this length by the projector. */
export const MAX_EXAMPLE_TEXT = 2000;

const bool: FieldSpec = { type: 'boolean' };
const boolOrNull: FieldSpec = { type: 'boolean', nullable: true };

/** Fields of one entry of `candidates` in a retrieval-labelled row. */
export const CANDIDATE_FIELDS: Record<string, FieldSpec> = {
  rank: { type: 'int' },
  kind: { type: 'string', oneOf: CANDIDATE_KIND_NAMES },
  lane: { type: 'string', nullable: true, pattern: LANE },
  score: { type: 'number', nullable: true },
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
    ranker: { type: 'string', pattern: LANE },
    build: { type: 'string', nullable: true, pattern: BUILD },
    model: { type: 'string', nullable: true, pattern: MODEL },
    retrieval: { type: 'string', nullable: true, oneOf: ['facts', 'hybrid', 'semantic', 'keyword'] },
    served: { type: 'int' },
    reply_tokens_bucket: { type: 'int', nullable: true },
    relevant: boolOrNull,
    truncated: boolOrNull,
    query: { type: 'string', nullable: true, maxLength: MAX_EXAMPLE_TEXT, level: 'data' },
    // candidates is an array of objects; it is checked against CANDIDATE_FIELDS.
  },
  'save-outcome/1': {
    kind: { type: 'string', oneOf: ['save-outcome/1'] },
    hour: { type: 'string', pattern: HOUR },
    tool: { type: 'string', oneOf: SAVE_TOOL_NAMES },
    op: { type: 'string', oneOf: ['create', 'supersede'] },
    item: { type: 'string', oneOf: SAVE_ITEM_NAMES },
    has_cites: bool,
    reads_bucket: { type: 'string', oneOf: COUNT_BUCKETS },
    opened: bool,
    cited: bool,
    superseded: bool,
    retired: bool,
    text: { type: 'string', nullable: true, maxLength: MAX_EXAMPLE_TEXT, level: 'data' },
  },
  'session-aggregate/1': {
    kind: { type: 'string', oneOf: ['session-aggregate/1'] },
    hour: { type: 'string', pattern: HOUR },
    length_bucket: { type: 'string', oneOf: LENGTH_BUCKETS },
    reads_bucket: { type: 'string', oneOf: COUNT_BUCKETS },
    saves_bucket: { type: 'string', oneOf: COUNT_BUCKETS },
    empty_reads_bucket: { type: 'string', oneOf: COUNT_BUCKETS },
    first_call: { type: 'string', oneOf: [...RETRIEVAL_TOOL_NAMES, ...SAVE_TOOL_NAMES, 'other'] },
  },
};

/** Row kinds that carry a `candidates` array. */
export const KINDS_WITH_CANDIDATES: readonly RowKind[] = ['retrieval-labelled/1'];

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
  for (const [name, spec] of Object.entries(CANDIDATE_FIELDS)) if (allowed(spec)) names.add(`retrieval-labelled/1.candidates.${name}`);
  return [...names].sort();
}

export class RowError extends Error {}

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
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new RowError(`${path} must be a finite number`);
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
    const spec = specs[name];
    if (spec === undefined) throw new RowError(`${path}.${name} is not a listed field`);
    if (spec.level !== undefined && levelRank(spec.level) > levelRank(level)) {
      throw new RowError(`${path}.${name} is not shared at level ${level}`);
    }
  }
  for (const [name, spec] of Object.entries(specs)) {
    if (skip.includes(name)) continue;
    if (spec.level !== undefined && levelRank(spec.level) > levelRank(level)) continue;
    if (spec.level !== undefined && !(name in record)) continue; // a text field may be absent
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
  const withCandidates = (KINDS_WITH_CANDIDATES as readonly string[]).includes(kind);
  checkObject(kind, specs, row, level, withCandidates ? ['candidates'] : []);
  if (withCandidates) {
    const candidates = (row as Record<string, unknown>).candidates;
    if (!Array.isArray(candidates)) throw new RowError(`${kind}.candidates must be an array`);
    if (candidates.length > 200) throw new RowError(`${kind}.candidates has more than 200 entries`);
    candidates.forEach((candidate, index) => checkObject(`${kind}.candidates[${index}]`, CANDIDATE_FIELDS, candidate, level));
  }
}

/** Largest batch: rows per request. The endpoint enforces the same. */
export const MAX_ROWS_PER_BATCH = 200;
