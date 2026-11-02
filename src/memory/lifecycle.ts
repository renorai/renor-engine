import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import Database from '../db/sqlite';
import { lookupEntity, type EntityRowFilter } from '../retrieval/entityLookup';
import { identityKey, identityNames } from '../retrieval/queryHelpers';
import { normalizeScope, savedScopeMatches, savedScopeSqlPredicate, scopeSpellings, type NormalizedScope } from '../mvp/scope';
import { readUntilWrite } from '../db/readCache';
import { transactionOnce } from '../db/statements';
import { canonicalSubject, indexFactTerms, prepareOnce, statementTerms, unindexFactTerms } from './factTerms';
import { MAX_STATEMENT_LENGTH } from './limits';
import { appendConfined, createConfined, withConfinedFile } from './confinedWrite';
import { isBlankOrInvisible } from './invisibleText';
import { savedSource } from './sourceName';
import { displacementsAfter, hasOpenDisplacementBy, writerOf, type ClosedFact, type OpenDisplacement } from './writerConflicts';
import { syncDirectory, withAppendLock } from './durableAppend';
import { withDailyFileLock } from './writer';
import { assertStorable, secretGuardEnabled, SecretRefusedError } from '../extraction/secretGuard';
import { saveDecisionModel } from '../extraction/jevDecisionModel';
import type { DecisionModel } from '../extraction/decision-model';
import { markErrorReason, refusalReason, type ToolErrorReason } from '../toolRefusal';
import type { IndexOptions } from '../indexer/pipeline';
import { createLogger } from '../mvp/log';

const log = createLogger('engine');

// ---------------------------------------------------------------------------
// Lifecycle layer — the piece that turns OSM from an index into a memory.
//
// Design: every memory event is appended to a durable Markdown ledger in the
// vault FIRST (git-tracked, survives `rm index.db`), then applied to SQLite.
// On index/rebuild, the ledger is REPLAYED (idempotently, by event id) so the
// facts table is fully reconstructible. SQLite is a derived cache, never the
// source of truth.
//
// Temporal truth: facts carry valid_from/valid_to. supersede() closes the
// current fact (valid_to=now) and opens the new one. Current-only reads are
// the default; history remains answerable via asOf / includeHistory.
//
// Gate1A hardening (see docs/build-1/ADR-0002-gate-0.md B1–B5):
//  - Event identity, not (subject, predicate, object), is the uniqueness key.
//    A→B→A supersession is legal history: exactly one current fact per
//    (subject, predicate) is enforced by a partial unique index, and the
//    projection (close + insert + dedup receipt) is one SQLite transaction,
//    so a failed insert can never leave a half-applied supersession.
//  - Replay dedups byte-identical events (sha256 digest) and fails loudly on
//    a reused event id with a conflicting payload — never blanket conflict-ignore.
//  - remember() serializes decision + ledger append + projection within the
//    process (single-writer chain). Cross-process crash durability is Gate 1B.
//  - Strict input validation and strict ledger parsing: lifecycle fields may
//    not contain control characters, so a field value can never forge another
//    event block; malformed event blocks fail replay loudly instead of being
//    silently trusted or skipped.
//  - Lifecycle facts attach to a stable lifecycle-owned entity
//    (source_note '_mcp_'), never to a disposable note-derived entity, so note
//    reindexing cannot cascade-delete them and index/replay order cannot
//    change lifecycle identity.
// ---------------------------------------------------------------------------

export interface MemoryReceipt {
  ok: boolean;
  eventId: string;
  action: 'supersede' | 'store' | 'nochange';
  subject: string;
  predicate: string;
  closed: { factId: number; object: string; validTo: string } | null;
  /**
   * The second value the write closed, present only when its scope held two: values saved under two spellings of one
   * slug before a write closed across them. `closed` is the one the event names in closed_event, this is the one saved
   * under the write's own spelling.
   */
  alsoClosed?: { factId: number; object: string; validTo: string };
  created: { factId: number | null; object: string; validFrom: string } | null;
  ledger: string;
}

interface LedgerEvent {
  id: string;
  at: string;
  kind: string;
  subject: string;
  predicate: string;
  object: string;
  closedEvent: string | null;
  source: string;
  /** Product scope; missing/omit = global (legacy ledgers). */
  scope?: string;
  /** The user's own words this event came from. Optional: older ledgers have none. */
  statement?: string;
  /**
   * The writer the connection authenticated, written only where it is not the source (writerConflicts.ts). Absent: the
   * writer is the source, as in every ledger written before writers were recorded.
   */
  writer?: string;
  /** retire and restore only: the fact event they take out of recall or bring back. */
  target?: string;
  /** erase only: digest of the fact event before its content was scrubbed. */
  originalDigest?: string;
  /**
   * erase only: the fact events the erased fact had closed, and the time it closed them (its own original time). No content:
   * ids and a time. Without them a full rebuild would see nothing close those facts, and an older value would be current again.
   */
  closes?: string[];
  closedAt?: string;
}

/** Reserved synthetic note path owning lifecycle entities (never a real vault file). */
export const LIFECYCLE_NOTE_PATH = '_mcp_';
/** Default relative ledger path inside the vault. */
export const DEFAULT_LEDGER_REL = 'System/Memory Events Ledger.md';

const EVENT_ID_RE = /^mem_[A-Za-z0-9]+$/i;
const EVENT_HEADER_RE = /^## (mem_[A-Za-z0-9]+) · (.+?)[ \t]*$/i;
// A field value is the rest of its physical line, and lines are split on '\n' alone. dotAll, because
// `.` otherwise refuses U+2028/U+2029 (and a lone \r), which JavaScript calls line terminators and this
// ledger does not: one such character in a value used to make the whole ledger unreadable at startup.
const FIELD_RE = /^- ([A-Za-z][\w-]*): (.*)$/s;
const KNOWN_FIELDS = new Set(['kind', 'subject', 'predicate', 'object', 'closed_event', 'source', 'scope', 'statement', 'writer', 'target', 'original_digest', 'closes', 'closed_at']);
const REQUIRED_FIELDS = ['subject', 'predicate', 'object'] as const;
/**
 * retire takes one fact out of recall and restore brings it back (retireFact, restoreFact). Each names the fact's own
 * event as its target and repeats its subject and predicate so the ledger reads on its own, but never its value: the
 * value is in the target event already, and a second copy would be one more place a value someone asked to forget
 * is written.
 */
const RETIREMENT_KINDS = new Set(['retire', 'restore']);
const ERASE_KIND = 'erase';
const KNOWN_KINDS = new Set(['store', 'supersede', ...RETIREMENT_KINDS, ERASE_KIND]);
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
export const FIELD_LIMITS: Record<string, number> = { subject: 512, predicate: 256, object: 8192, source: 256, scope: 80, statement: MAX_STATEMENT_LENGTH, writer: 256 };

/**
 * Characters JSON.stringify leaves literal although a line-oriented reader may read them as a line
 * end or a control: DEL, the C1 controls (U+0085 NEXT LINE among them), U+2028 LINE SEPARATOR and
 * U+2029 PARAGRAPH SEPARATOR. JSON itself already escapes every C0 control and any unpaired surrogate.
 */
const JSON_LEAVES_LITERAL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/**
 * The user's statement is free text (newlines, '## mem_…', '- key: …' lines), and the ledger is
 * line-framed, so it is written as ONE JSON string literal and nothing else. The value starts with a
 * quote, so no statement can open a heading or a field line; between the quotes there is no control
 * character and no line or paragraph separator, so it is one line to every reader (this parser, an
 * editor, a script that splits on Unicode line rules). Every escape is plain JSON, so any JSON parser
 * reads the value back exactly, while text in any script stays readable and searchable as written.
 */
function encodeStatement(statement: string): string {
  return JSON.stringify(statement)
    .replace(JSON_LEAVES_LITERAL, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Strict on purpose: anything that is not exactly one JSON string literal is corruption. JSON allows
 * the separators the encoder now escapes to appear literal inside the quotes, so a ledger written
 * before they were escaped still reads back exactly.
 */
function decodeStatement(raw: string, id: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`ledger corruption in event ${id}: statement is not a JSON string literal`);
  }
  return value;
}

function newEventId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `mem_${t}${r}`.toUpperCase();
}

/**
 * A lifecycle field value was rejected by validation.
 *
 * On the write path every field is validated before the ledger is touched, so this class means
 * "the request was wrong", never "the process is unhealthy": a caller-side type/length/character
 * error must be answered 4xx by an HTTP surface, not 500. Reporting it as 500 misclassifies a
 * client bug as a server fault and pages whoever watches the error budget for a request nobody
 * can fix. Genuine engine faults — an unreadable ledger, a reused event id, a clock regression,
 * a ledger path that escapes the vault — keep throwing plain Errors and stay 5xx.
 *
 * The message text is unchanged except for naming the received type, so log greps and existing
 * assertions still match; only the class carries the new distinction.
 */
export class LifecycleInputError extends Error {
  readonly field: string;

  /**
   * The refusal code telemetry carries, from the closed set in src/toolRefusal.ts, is recorded out of band
   * (markErrorReason): the class gains no field, so its class, `name`, `message`, enumerable keys and
   * `instanceof` are exactly what they were before. The third argument is optional, so an error built
   * elsewhere keeps its two-argument shape.
   */
  constructor(field: string, message: string, reason?: ToolErrorReason) {
    super(message);
    this.name = 'LifecycleInputError';
    this.field = field;
    if (reason !== undefined) markErrorReason(this, reason);
  }
}

/**
 * A write that named the event it expected to close found a different current fact (or none). Nothing was written.
 * Only a caller that asks for the check (`expectCurrentEvent`) can get it: the dreamer, which decides on one reading of
 * the facts and must not overwrite what an agent saved meanwhile.
 */
export class StaleExpectationError extends Error {
  readonly expected: string | null;
  readonly found: string | null;

  constructor(expected: string | null, found: string | null) {
    super(`lifecycle write refused without publishing: the current fact is no longer the one the caller judged (expected event ${expected ?? 'none'}, found ${found ?? 'none'}). The ledger was not modified`);
    this.name = 'StaleExpectationError';
    this.expected = expected;
    this.found = found;
  }
}

/** The received type, spelled the way JSON Schema spells it, for error messages. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateField(field: string, value: unknown, required: boolean): string {
  if (typeof value !== 'string') throw new LifecycleInputError(field, `lifecycle ${field} must be a string (received ${describeType(value)})`, 'invalid_argument');
  if (required && value.trim() === '') throw new LifecycleInputError(field, `lifecycle ${field} must be a non-empty string`, 'invalid_argument');
  if (CONTROL_CHARS.test(value)) {
    throw new LifecycleInputError(field, `lifecycle ${field} contains control characters (newlines/tabs are rejected to keep ledger framing strict): ${JSON.stringify(value.slice(0, 40))}`, 'invalid_text');
  }
  const limit = FIELD_LIMITS[field];
  if (limit !== undefined && value.length > limit) {
    throw new LifecycleInputError(field, `lifecycle ${field} exceeds the maximum length of ${limit} (got ${value.length})`, 'field_too_long');
  }
  return value;
}

function validateLifecycleInput(args: { subject: string; predicate: string; object: string; source?: string; scope?: string; statement?: string }): void {
  validateField('subject', args.subject, true);
  validateField('predicate', args.predicate, true);
  validateField('object', args.object, true);
  if (args.source !== undefined) validateField('source', args.source, false);
  if (args.statement !== undefined) {
    // The user's own words are kept as given, so unlike the structured fields they may hold control
    // characters (the encoding makes them safe); only the type and the size are checked. The encoding
    // is the reason the control-character rule in memory/controls.ts does not apply here: a statement
    // is written as ONE JSON string literal, so every C0 control is escaped on disk and no statement
    // can break the ledger's framing — while the note writer, which stores text raw, does refuse them.
    if (typeof args.statement !== 'string') throw new LifecycleInputError('statement', `lifecycle statement must be a string (received ${describeType(args.statement)})`, 'invalid_argument');
    const limit = FIELD_LIMITS.statement;
    if (args.statement.length > limit) throw new LifecycleInputError('statement', `lifecycle statement exceeds the maximum length of ${limit} (got ${args.statement.length})`, 'field_too_long');
  }
  if (args.scope !== undefined) {
    // Normalize throws on invalid; re-label it as the caller error it is, so every rejection
    // from this function leaves as a LifecycleInputError and an HTTP surface can answer 4xx.
    // Also bound via FIELD_LIMITS via validateField on the normalized form.
    let n: string;
    try {
      n = normalizeScope(args.scope);
    } catch (err) {
      // normalizeScope names invalid_scope itself (src/mvp/scope.ts); the re-label keeps that code.
      throw new LifecycleInputError('scope', err instanceof Error ? err.message : String(err), refusalReason(err) ?? 'invalid_scope');
    }
    validateField('scope', n, false);
  }
}

// Write-only: replay runs validateField over every stored event, so a value written before this check must still load.
function refuseUnstorableFields(args: { subject: string; predicate: string; object: string }): void {
  for (const field of ['subject', 'predicate', 'object'] as const) {
    const value = args[field];
    if (isBlankOrInvisible(value)) throw new LifecycleInputError(field, `lifecycle ${field} must be a non-empty string`, 'invalid_argument');
    if (/\p{Cs}/u.test(value)) throw new LifecycleInputError(field, `lifecycle ${field} contains an unpaired UTF-16 surrogate, which cannot be stored as text`, 'invalid_text');
  }
}

/**
 * S1 canonical timestamp contract: ONE sortable format everywhere — the exact
 * UTC-ISO representation the writer emits (new Date().toISOString():
 * YYYY-MM-DDTHH:mm:ss.sssZ). With this single format, lexicographic string
 * order == instant order, so the apply/live string comparisons, the
 * reconciliation's instant comparisons and the SQL textual ordering behind
 * asOf/current reads all agree without any format migration or digest change
 * (canonical events keep byte-identical at strings, so digests are unchanged).
 * Other representations — e.g. '2026-09-08T23:30:00.000-01:00', which is a
 * LATER instant sorting EARLIER lexically — are an UNSUPPORTED legacy
 * representation, not a malicious input: the engine writer has never emitted
 * them, and they are rejected consistently, BEFORE any mutation, with a clear
 * message naming the event. Recovery is repairing the ledger entry.
 */
const CANONICAL_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function isCanonicalTimestamp(at: string): boolean {
  if (!CANONICAL_TS_RE.test(at)) return false;
  // Exact writer format: the string IS the canonical serialization of its instant.
  const d = new Date(at);
  return !Number.isNaN(d.getTime()) && d.toISOString() === at;
}

/** Normalize any parseable ISO instant to the canonical format (query inputs only). */
// S1.1: datetime input must carry an explicit timezone (trailing Z or a
// numeric ±HH:MM offset). Timezone-less datetimes such as
// '2026-09-09T00:30:00' are parsed against the HOST timezone by Date, so the
// canonicalized instant silently depended on the host's TZ — ambiguous input
// is rejected clearly instead. Date-only 'YYYY-MM-DD' remains accepted: ISO
// 8601 defines date-only as UTC midnight, deterministically. Valid zoned
// instants normalize exactly as before.
const ZONED_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function toCanonicalInstant(value: string): string {
  if (typeof value !== 'string'
      || (!ZONED_INSTANT_RE.test(value) && !DATE_ONLY_RE.test(value))) {
    throw new Error(`invalid timestamp ${JSON.stringify(value)}: expected an ISO 8601 instant with an explicit timezone (e.g. 2026-09-09T00:30:00Z or 2026-09-09T00:30:00-03:00, or date-only YYYY-MM-DD which is UTC midnight); timezone-less datetimes are ambiguous and rejected`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid timestamp ${JSON.stringify(value)}: expected a parseable ISO 8601 instant`);
  }
  return d.toISOString();
}

function validateLedgerEvent(ev: LedgerEvent): void {
  if (!EVENT_ID_RE.test(ev.id)) throw new Error(`ledger event id "${ev.id}" is malformed`);
  if (!isCanonicalTimestamp(ev.at)) {
    throw new Error(`ledger event ${ev.id} has an unsupported timestamp representation ${JSON.stringify(ev.at)}: the canonical format emitted by the writer is exact UTC ISO (YYYY-MM-DDTHH:mm:ss.sssZ, e.g. 2026-09-09T00:00:00.000Z); repair the ledger entry`);
  }
  if (!KNOWN_KINDS.has(ev.kind)) throw new Error(`ledger corruption in event ${ev.id}: unknown kind "${ev.kind}"`);
  if (ev.kind === ERASE_KIND) {
    if (!/^[0-9a-f]{64}$/.test(ev.originalDigest ?? '')) throw new Error(`ledger corruption in event ${ev.id}: an erase tombstone needs the original event digest`);
    if (ev.subject || ev.predicate || ev.object || ev.statement !== undefined || ev.writer !== undefined || ev.target !== undefined || ev.closedEvent !== null || ev.source !== 'erased') {
      throw new Error(`ledger corruption in event ${ev.id}: an erase tombstone carries no memory content`);
    }
    // The closing link is ids and a time, both checked, so it cannot carry text either.
    if ((ev.closes === undefined) !== (ev.closedAt === undefined)) throw new Error(`ledger corruption in event ${ev.id}: an erase tombstone's closes and closed_at go together`);
    if (ev.closes !== undefined) {
      if (ev.closes.length === 0 || ev.closes.some(id => !/^MEM_[A-Z0-9]+$/.test(id))) throw new Error(`ledger corruption in event ${ev.id}: an erase tombstone closes event ids only`);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ev.closedAt!) || new Date(ev.closedAt!).toISOString() !== ev.closedAt) {
        throw new Error(`ledger corruption in event ${ev.id}: an erase tombstone's closed_at is not an exact UTC ISO time`);
      }
    }
    return;
  }
  const retirement = RETIREMENT_KINDS.has(ev.kind);
  validateField('subject', ev.subject, true);
  validateField('predicate', ev.predicate, true);
  // A retirement carries no value (RETIREMENT_KINDS); a fact event always does.
  if (retirement) {
    if (ev.object !== '') throw new Error(`ledger corruption in event ${ev.id}: a ${ev.kind} event carries no object`);
  } else {
    validateField('object', ev.object, true);
  }
  validateField('source', ev.source, false);
  if (ev.writer !== undefined) validateField('writer', ev.writer, true);
  if (retirement) {
    if (ev.target === undefined || !EVENT_ID_RE.test(ev.target)) {
      throw new Error(`ledger corruption in event ${ev.id}: a ${ev.kind} event needs the id of the fact event it ${ev.kind}s (target)`);
    }
    if (ev.closedEvent != null || ev.statement !== undefined) {
      throw new Error(`ledger corruption in event ${ev.id}: a ${ev.kind} event closes nothing and keeps no statement`);
    }
  } else if (ev.target !== undefined) {
    throw new Error(`ledger corruption in event ${ev.id}: only a retire or restore event names a target`);
  }
  if (ev.statement !== undefined) validateLifecycleInput({ subject: ev.subject, predicate: ev.predicate, object: ev.object, statement: ev.statement });
  if (ev.scope !== undefined && ev.scope !== null && ev.scope !== '') {
    const n = normalizeScope(ev.scope);
    validateField('scope', n, false);
    ev.scope = n;
  } else {
    ev.scope = 'global';
  }
  if (ev.closedEvent != null && !EVENT_ID_RE.test(ev.closedEvent)) {
    throw new Error(`ledger corruption in event ${ev.id}: malformed closed_event id "${ev.closedEvent}"`);
  }
}

function eventDigest(ev: LedgerEvent): string {
  if (ev.kind === ERASE_KIND) return ev.originalDigest!;
  const parts: string[] = [
    ev.id, ev.at, ev.kind, ev.subject, ev.predicate, ev.object, ev.closedEvent ?? '', ev.source ?? 'ledger',
  ];
  // Digest-stable for legacy/global: only append scope when non-global so existing
  // applied_ledger_events digests keep matching after migration 8.
  const scope = normalizeScope(ev.scope);
  if (scope !== 'global') parts.push(scope);
  // Same rule for the statement: absent => digest identical to pre-statement events.
  if (ev.statement !== undefined) parts.push(`statement:${ev.statement}`);
  if (ev.writer !== undefined) parts.push(`writer:${ev.writer}`);
  if (ev.target !== undefined) parts.push(`target:${ev.target}`);
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * S2 shared ledger path resolver, rooted at the VAULT ROOT and used by BOTH
 * append and replay (and the remember receipt). The old containment check
 * rooted its base at dirname(ledgerRelPath), so '../outside/ledger' passed a
 * check whose base was already outside the vault; replay had no confinement
 * at all. Confinement is lexical (path.resolve + path.relative) and happens
 * BEFORE any filesystem access — an escaping path never creates or reads
 * anything outside the vault. Absolute ledger paths are rejected fail-closed
 * (previously they silently double-joined through path.join). Normal relative
 * paths and the '.md'-suffix behavior are unchanged. This is NOT symlink or
 * concurrent-writer protection — hosted isolation remains Gate 1B scope.
 *
 * S2.1: escape detection matches an actual parent component ('..' exactly, or
 * '..' followed by a path separator) — NOT a mere '../..' string prefix, which
 * wrongly rejected harmless in-vault names like '..safe/ledger' or
 * '..ledger.md'. All traversal defenses are preserved: any resolved path
 * outside the vault root, and any absolute ledger path, still fails closed.
 */
export function resolveLedgerPath(vaultPath: string, ledgerRelPath: string): string {
  const root = path.resolve(vaultPath);
  let rel = ledgerRelPath;
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error(`ledger path escapes the vault root: ${JSON.stringify(ledgerRelPath)}`);
  }
  if (path.isAbsolute(rel)) {
    // The ledger is addressed RELATIVE to the vault; an absolute path is a
    // configuration error (previously it silently double-joined through
    // path.join) and is rejected fail-closed even if it points inside the vault.
    throw new Error(`absolute ledger path is not vault-relative: ${JSON.stringify(ledgerRelPath)}`);
  }
  // S2.1: check the ORIGINAL request before any '.md' suffix mangling — the
  // vault root itself ('.'/empty resolution) and any REAL parent component
  // ('..' exactly, or '..' + separator) fail closed here, so '..' can never
  // be laundered into a literal '..md' name by the suffix rule.
  const originalRelFromRoot = path.relative(root, path.resolve(root, rel));
  const originalEscapes = originalRelFromRoot === ''
    || originalRelFromRoot === '..'
    || originalRelFromRoot.startsWith('..' + path.sep)
    || path.isAbsolute(originalRelFromRoot);
  if (originalEscapes) {
    throw new Error(`ledger path escapes the vault root: ${JSON.stringify(ledgerRelPath)}`);
  }
  if (!rel.endsWith('.md')) rel += '.md';
  const resolved = path.resolve(root, rel);
  const relFromRoot = path.relative(root, resolved);
  const escapes = relFromRoot === ''
    || relFromRoot === '..'
    || relFromRoot.startsWith('..' + path.sep)
    || path.isAbsolute(relFromRoot);
  if (escapes) {
    throw new Error(`ledger path escapes the vault root: ${JSON.stringify(ledgerRelPath)}`);
  }
  return resolved;
}

export async function appendLedgerEvent(
  vaultPath: string, ledgerRelPath: string,
  ev: LedgerEvent,
): Promise<string> {
  validateLedgerEvent(ev);
  // An erasure is a rewrite of the whole ledger (eraseRetiredFact), never an append.
  if (ev.kind === ERASE_KIND) throw new Error(`ledger event ${ev.id}: an erase tombstone is written only by erasing a retired fact`);
  const resolved = resolveLedgerPath(vaultPath, ledgerRelPath);
  // Confined and durable in one append (confinedWrite.ts): a link, a hard link or a FIFO planted in the vault is refused,
  // never followed, and a failed write is cut back, so the ledger never keeps a fragment of an event whose save the caller
  // was told failed. A new ledger starts with its header.
  await appendConfined(vaultPath, path.relative(path.resolve(vaultPath), resolved), ledgerEventBlock(ev), LEDGER_HEADER);
  return resolved;
}

const LEDGER_HEADER = `---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Memory Events Ledger\n\nAppend-only durable record of memory events. Replayed on rebuild.\n`;

/** A field line a complete event may carry (writer output): a known key, `- key: value`. */
function isLedgerFieldLine(line: string): boolean {
  const m = FIELD_RE.exec(line.replace(/\r$/, ''));
  return m !== null && KNOWN_FIELDS.has(m[1]);
}

/**
 * Where the FINAL ledger event starts when a write cut it short, or -1 when the ledger ends in whole events. The writer
 * emits `- kind:` first and `- source:` last, so a final event that has a kind line but no terminated source line is
 * unterminated: a crash or a full disk left it short, whether it was cut mid-line (no final newline) or after a line
 * (missing its source). Such a block is well-formed up to the cut: its complete lines are a header and known fields, and
 * its partial last line is a header or field prefix. Anything else is not reported here, so the strict parser refuses
 * it. A final block with no kind line and a final newline (a legacy block replayed as store, or a malformed one) is left
 * exactly as it was. Ordinary prose after a complete event never matches.
 */
export function unterminatedFinalEventStart(text: string): number {
  const headers = [...text.matchAll(/^## mem_/gim)];
  if (headers.length === 0) return -1;
  const start = headers[headers.length - 1].index!;
  const block = text.slice(start);
  if (/^- source: [^\n]*\n/m.test(block)) return -1;
  const lines = block.split('\n');
  const partial = lines.pop()!; // what follows the last newline: '' when the event ends in one
  const hasKind = lines.some(line => /^- kind: /.test(line.replace(/\r$/, '')));
  // A header with no field line after it is a cut too: the writer writes kind on the line after the header.
  if (partial === '' && !hasKind && lines.length > 1) return -1;
  if (lines.length > 0) {
    if (!EVENT_HEADER_RE.test(lines[0].replace(/\r$/, ''))) return -1;
    if (!lines.slice(1).every(isLedgerFieldLine)) return -1;
    if (partial !== '' && partial !== '-' && !partial.startsWith('- ')) return -1;
  }
  return start;
}

/**
 * The state of the ledger's final event, from its BYTES: `torn` at `offset` when a write cut it short and the index has
 * not applied it (the bytes from `offset` are to be set aside); `known` when it looks cut but the index already holds it
 * (it was applied, so it was acknowledged, and a ledger edited to drop its last newline is still whole); `none` when the
 * ledger ends in whole events, or when the bytes are not exact UTF-8 before the cut (then nothing is cut and the strict
 * parser refuses). A cut can leave one multi-byte character half written at the very end, so the text is taken up to the
 * last complete character.
 */
type FinalEvent = { kind: 'none' } | { kind: 'known' } | { kind: 'torn'; offset: number };

function finalEventState(bytes: Buffer, isProjected: (eventId: string) => boolean): FinalEvent {
  const valid = utf8PrefixLength(bytes);
  const text = bytes.subarray(0, valid).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes.subarray(0, valid))) return { kind: 'none' };
  const start = unterminatedFinalEventStart(text);
  if (start < 0) return { kind: 'none' };
  const id = /^## (\S+)/.exec(text.slice(start))?.[1];
  if (id !== undefined && isProjected(id.toUpperCase())) return { kind: 'known' };
  return { kind: 'torn', offset: Buffer.byteLength(text.slice(0, start), 'utf8') };
}

/** How many leading bytes end on a complete UTF-8 character: a multi-byte character cut at the end is not counted. */
function utf8PrefixLength(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const b = bytes[bytes.length - back];
    if ((b & 0xc0) === 0x80) continue; // a continuation byte: its lead byte is further back
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/**
 * Moves an unterminated final event out of the ledger: its exact bytes go to `<ledger>.torn-<timestamp>` (created and synced
 * by createConfined), then the ledger is cut back to the last whole event (synced). Only that tail moves; every complete
 * event stays where it is. Both files are reached through confined handles (confinedWrite.ts), so a link planted at the
 * ledger, a hard link to it or a link on its directory is refused before anything is copied or cut. Refuses when the ledger
 * changed since it was read.
 */
async function moveTornTailAside(
  vaultPath: string, relFile: string, ledger: fs.FileHandle, bytes: Buffer, offset: number,
): Promise<void> {
  const tornBytes = bytes.subarray(offset);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let tornPath = '';
  for (let n = 0; ; n++) {
    try {
      tornPath = await createConfined(vaultPath, `${relFile}.torn-${stamp}${n ? `-${n}` : ''}`, tornBytes);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 99) throw err;
    }
  }
  // The cut is only right for the bytes it was decided on: a writer that appended since would lose its event.
  const now = (await ledger.stat()).size;
  if (now !== bytes.length) {
    throw new Error(`ledger ${path.resolve(vaultPath, relFile)} changed while its unterminated tail was being set aside (${bytes.length} -> ${now} bytes); not cut. Restart the engine.`);
  }
  await ledger.truncate(offset);
  await ledger.sync();
  log.error('ledger_tail_set_aside', {
    ledger: relFile,
    bytes: tornBytes.length,
    movedTo: path.relative(vaultPath, tornPath),
    detail: 'the final event was cut short (a crash or a full disk); every complete event was kept',
    remedy: 'a hand-written event never replayed: add its `- source:` line and a final newline (if it has none), append its bytes to the ledger and restart; a block still without that line is set aside again',
  });
}

/**
 * The ledger's text for replay, and whether its unterminated final event (if any) is one the index already holds. An
 * unterminated final event is set aside only when `setTornTailAside` is set (engine start-up): a live process that is still
 * appending (an import, a rebuild in another process) must never have its ledger cut from under it, so every other caller
 * refuses and leaves the bytes alone. The decision is taken again under the append lock and through a confined handle, because
 * an append may have finished since the first read, and a link planted at the ledger must be refused, not read or cut.
 */
async function readLedgerForReplay(
  vaultPath: string, filePath: string, isProjected: (eventId: string) => boolean, setTornTailAside: boolean,
): Promise<{ content: string; finalEventKnown: boolean }> {
  const bytes = await fs.readFile(filePath);
  const first = finalEventState(bytes, isProjected);
  if (first.kind !== 'torn' || !setTornTailAside) {
    return { content: bytes.toString('utf8'), finalEventKnown: first.kind === 'known' };
  }
  const relFile = path.relative(path.resolve(vaultPath), filePath);
  return withAppendLock(filePath, () => withConfinedFile(vaultPath, relFile, async ledger => {
    const again = await ledger.readFile();
    const now = finalEventState(again, isProjected);
    if (now.kind !== 'torn') return { content: again.toString('utf8'), finalEventKnown: now.kind === 'known' };
    await moveTornTailAside(vaultPath, relFile, ledger, again, now.offset);
    return { content: again.subarray(0, now.offset).toString('utf8'), finalEventKnown: false };
  }));
}

/** Remove private rewrite files left by a process that died before replacing the ledger. */
async function removeStaleEraseTemps(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.erase-`;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(names
    .filter(name => name.startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(name.slice(prefix.length)))
    .map(name => fs.rm(path.join(dir, name), { force: true })));
}

/**
 * Strict line-oriented parser for the ledger format. Returns the events in
 * append order. Throws (never silently skips) on event-shaped corruption:
 * malformed headers, malformed/unknown/duplicate fields, missing required
 * fields, unknown kinds, invalid timestamps. Ordinary Markdown prose (the
 * frontmatter header, human sections) outside event blocks is tolerated.
 */
export function parseLedgerEvents(content: string, options: { finalEventKnown?: boolean } = {}): LedgerEvent[] {
  // A cut final event is refused, never read as whole: its last field (the object of a fact) may be a prefix of the value.
  // Engine start-up sets such a tail aside before it parses (readLedgerForReplay); any other caller refuses.
  if (options.finalEventKnown !== true && unterminatedFinalEventStart(content) >= 0) {
    throw new Error('ledger corruption: its final event is unterminated (a write was cut short by a crash or a full disk); the next engine start sets that tail aside');
  }
  const events: LedgerEvent[] = [];
  // Line-ending tolerance: a hand-edited CRLF ledger is valid content with a
  // Windows editor's line endings, not corruption. Normalize \r\n to \n BEFORE
  // splitting so field values never carry a stray trailing \r. Lone \r inside
  // a line remains a control character and still fails loudly.
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('## ')) { i++; continue; }
    const m = EVENT_HEADER_RE.exec(line);
    if (!m) {
      if (/^## mem_/i.test(line)) {
        throw new Error(`ledger corruption at line ${i + 1}: malformed event header: ${JSON.stringify(line)}`);
      }
      i++; continue; // ordinary Markdown heading — not a lifecycle event
    }
    const id = m[1].toUpperCase();
    const at = m[2].trim();
    if (!Number.isFinite(Date.parse(at))) {
      throw new Error(`ledger corruption in event ${id} (line ${i + 1}): invalid timestamp ${JSON.stringify(at)}`);
    }
    i++;
    const fields: Record<string, string> = {};
    while (i < lines.length && lines[i].startsWith('- ')) {
      const fm = FIELD_RE.exec(lines[i]);
      if (!fm) throw new Error(`ledger corruption in event ${id} at line ${i + 1}: malformed field line ${JSON.stringify(lines[i])}`);
      const key = fm[1];
      if (!KNOWN_FIELDS.has(key)) throw new Error(`ledger corruption in event ${id} at line ${i + 1}: unknown field "${key}"`);
      if (Object.prototype.hasOwnProperty.call(fields, key)) throw new Error(`ledger corruption in event ${id} at line ${i + 1}: duplicate field "${key}"`);
      fields[key] = fm[2];
      i++;
    }
    const kind = fields.kind ?? 'store';
    for (const req of REQUIRED_FIELDS) {
      if (kind === ERASE_KIND) continue;
      if (req === 'object' && RETIREMENT_KINDS.has(kind)) continue; // a retirement carries no value
      if (fields[req] === undefined || fields[req] === '') {
        throw new Error(`ledger corruption in event ${id}: missing required field "${req}"`);
      }
    }
    const ev: LedgerEvent = {
      id, at,
      ...(fields.statement !== undefined ? { statement: decodeStatement(fields.statement, id) } : {}),
      ...(fields.target !== undefined ? { target: fields.target } : {}),
      ...(fields.original_digest !== undefined ? { originalDigest: fields.original_digest } : {}),
      ...(fields.closes !== undefined ? { closes: fields.closes.split(',').map(part => part.trim().toUpperCase()) } : {}),
      ...(fields.closed_at !== undefined ? { closedAt: fields.closed_at } : {}),
      kind,
      subject: fields.subject,
      predicate: fields.predicate,
      object: fields.object ?? '',
      closedEvent: fields.closed_event ?? null,
      source: fields.source ?? 'ledger',
      scope: fields.scope ? normalizeScope(fields.scope) : 'global',
      ...(fields.writer !== undefined ? { writer: fields.writer } : {}),
    };
    validateLedgerEvent(ev); // bounds, kind, id/timestamp/closed_event shape
    events.push(ev);
  }
  return events;
}

/**
 * A subject whose identity key matches SEVERAL lifecycle entities and whose open
 * current facts disagree. Two spellings of one person (`José` and `JOSÉ`, or an NFC
 * and an NFD form) could be split by a pre-fix write path, and there is no unique
 * index on `entities` and no merge path, so nothing at the DB level forbids it.
 *
 * On the live write path there is no canonical order to consult (row ids are
 * disposable cache artifacts, never consulted), so picking one entity would silently
 * decide which of two conflicting values is current. Fail closed instead.
 *
 * Recovery is documented, not guessed: replaying the canonical ledger in order into a
 * fresh index reconciles duplicate identities by event position (the later event
 * wins), which is exactly the fix's behavior on a rebuild. Stored rows and histories
 * are never deleted or rewritten by this error.
 */
export class LegacyIdentityAmbiguityError extends Error {
  readonly subject: string;
  readonly entityIds: number[];
  readonly canonicalNames: string[];
  readonly streams: string[];

  constructor(args: { subject: string; entities: LifecycleEntityMatch[]; streams: string[] }) {
    super(
      `legacy identity ambiguity for subject ${JSON.stringify(args.subject)}: `
      + `${args.entities.length} lifecycle entities share one identity `
      + `(${args.entities.map(e => `#${e.id} ${JSON.stringify(e.canonicalName)}`).join(', ')}) `
      + `and their current facts disagree on ${args.streams.join(', ')}. `
      + 'Refusing to guess which value is current; nothing was written. '
      + 'Recovery: rebuild the index from the canonical ledger (an in-order replay reconciles the duplicate identities by event position).',
    );
    this.name = 'LegacyIdentityAmbiguityError';
    this.subject = args.subject;
    this.entityIds = args.entities.map(e => e.id);
    this.canonicalNames = args.entities.map(e => e.canonicalName);
    this.streams = args.streams;
  }
}

interface LifecycleEntityMatch { id: number; canonicalName: string }
type ReplayEntityIndex = Map<string, LifecycleEntityMatch[]>;

/** One replay-local scan; buckets retain the legacy lowest-row-id ordering. */
function replayEntityIndex(db: Database.Database): ReplayEntityIndex {
  const index: ReplayEntityIndex = new Map();
  const rows = prepareOnce(db, 
    `SELECT id, canonical_name FROM entities WHERE source_note = ? ORDER BY id`
  ).all(LIFECYCLE_NOTE_PATH) as Array<{ id: number; canonical_name: string }>;
  for (const row of rows) addEntityToIndex(index, row);
  return index;
}

function addEntityToIndex(index: ReplayEntityIndex, row: { id: number; canonical_name: string }): void {
  const key = identityKey(row.canonical_name);
  const matches = index.get(key) ?? [];
  matches.push({ id: row.id, canonicalName: row.canonical_name });
  index.set(key, matches);
}

/**
 * Per database, for the reads and writes outside a replay: the same index, with how many lifecycle entities there
 * were and the newest one's id when it was read. Lifecycle entity rows are only ever added, under ids that only grow
 * (AUTOINCREMENT), and never renamed, so those two numbers say whether the table still holds what the index was read
 * from: rows added since are read and added to it (by id, so each bucket keeps its lowest-id-first order), and any
 * other change (a row gone) reads the table again. Only committed rows are read into it, so inside a transaction it
 * is used only while it is current, and the table is scanned instead, as before.
 */
const liveEntityIndexes = new WeakMap<Database.Database, { count: number; newest: number; index: ReplayEntityIndex }>();

function liveEntityIndex(db: Database.Database): ReplayEntityIndex | null {
  const { count, newest } = prepareOnce(
    db, `SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS newest FROM entities WHERE source_note = ?`,
  ).get(LIFECYCLE_NOTE_PATH) as { count: number; newest: number };
  const cached = liveEntityIndexes.get(db);
  if (cached && cached.count === count && cached.newest === newest) return cached.index;
  if (db.inTransaction) return null;
  if (cached && count > cached.count && newest > cached.newest) {
    const added = prepareOnce(
      db, `SELECT id, canonical_name FROM entities WHERE source_note = ? AND id > ? ORDER BY id`,
    ).all(LIFECYCLE_NOTE_PATH, cached.newest) as Array<{ id: number; canonical_name: string }>;
    if (cached.count + added.length === count) {
      for (const row of added) addEntityToIndex(cached.index, row);
      cached.count = count;
      cached.newest = newest;
      return cached.index;
    }
  }
  const index = replayEntityIndex(db);
  liveEntityIndexes.set(db, { count, newest, index });
  return index;
}

/**
 * Lifecycle-owned entities whose identity key matches `subject`, ordered by row id.
 *
 * `identityKey` is the single subject-identity primitive (NFC + case fold, explicit
 * aliases unified), so the lifecycle no longer needs SQL `COLLATE NOCASE` — which
 * folds ASCII A–Z only and therefore split `José`/`JOSÉ`, `Пётр`/`пётр` and every
 * NFC/NFD pair into two entities with two open currents. The comparison happens in JS
 * BEFORE the query result is used, so a normalization form can never leak into the
 * equality test. The fold is not expressible in SQLite without ICU, so the
 * matches come from an index keyed by identity: replay builds one for itself, and
 * live reads and writes keep one per database (liveEntityIndex), instead of folding
 * every `_mcp_` entity's name on every save.
 */
function lifecycleEntityMatches(db: Database.Database, subject: string, index?: ReplayEntityIndex): LifecycleEntityMatch[] {
  const key = identityKey(subject);
  if (index) return index.get(key) ?? [];
  const live = liveEntityIndex(db);
  if (live) return live.get(key) ?? [];
  const rows = prepareOnce(db, 
    `SELECT id, canonical_name FROM entities WHERE source_note = ? ORDER BY id`
  ).all(LIFECYCLE_NOTE_PATH) as Array<{ id: number; canonical_name: string }>;
  return rows
    .filter(row => identityKey(row.canonical_name) === key)
    .map(row => ({ id: row.id, canonicalName: row.canonical_name }));
}

/** Streams (`predicate @ scope`) where the matched entities' open currents disagree. */
function conflictingLegacyStreams(db: Database.Database, entities: LifecycleEntityMatch[]): string[] {
  if (entities.length < 2) return [];
  const placeholders = entities.map(() => '?').join(',');
  const rows = prepareOnce(db, 
    `SELECT predicate, COALESCE(scope, 'global') AS scope, object_text
       FROM facts WHERE subject_entity_id IN (${placeholders}) AND valid_to IS NULL`
  ).all(...entities.map(e => e.id)) as Array<{ predicate: string; scope: string; object_text: string }>;
  const values = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.predicate}\u0000${row.scope}`;
    const set = values.get(key) ?? new Set<string>();
    set.add(row.object_text);
    values.set(key, set);
  }
  return [...values.entries()]
    .filter(([, objects]) => objects.size > 1)
    .map(([key]) => {
      const [predicate, scope] = key.split('\u0000');
      return `${predicate} @ ${scope}`;
    });
}

/**
 * Resolve the lifecycle-owned entity for a subject (source_note '_mcp_').
 *
 * `preferEntityId` is used by the already-projected replay branch: the event's own
 * projected owner is canonical for that event, so reconciliation targets it instead of
 * re-deciding identity (which would either re-open the split or refuse a replay the
 * service needs at startup). `strict` is used by the live write path, which fails
 * closed on a conflicting legacy split before anything is published.
 */
function resolveLifecycleEntity(
  db: Database.Database,
  subject: string,
  at: string,
  create: boolean,
  opts: { preferEntityId?: number; strict?: boolean; index?: ReplayEntityIndex } = {},
): number | null {
  const matches = lifecycleEntityMatches(db, subject, opts.index);
  if (matches.length > 0) {
    if (opts.preferEntityId !== undefined && matches.some(m => m.id === opts.preferEntityId)) {
      return opts.preferEntityId;
    }
    if (matches.length === 1) return matches[0].id;
    if (opts.strict) {
      const streams = conflictingLegacyStreams(db, matches);
      if (streams.length > 0) throw new LegacyIdentityAmbiguityError({ subject, entities: matches, streams });
    }
    // Several entities, no conflicting current value: deterministic lowest id, so a
    // repeat write/replay never alternates between identities. Nothing is deleted.
    return matches[0].id;
  }
  if (!create) return null;
  prepareOnce(db, 
    `INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES (?, 'Memory Lifecycle', 'system', ?, ?, '{}')`
  ).run(LIFECYCLE_NOTE_PATH, LIFECYCLE_NOTE_PATH, at);
  const id = (prepareOnce(db, 
    `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', ?, '[]', ?, 1.0, ?) RETURNING id`
  ).get(subject, LIFECYCLE_NOTE_PATH, at) as { id: number }).id;
  // New rows have increasing ids, and an empty bucket is the only creation
  // path. On any failed event replay throws and discards this local index;
  // rolled-back ids can never escape into a later replay/live write.
  opts.index?.set(identityKey(subject), [{ id, canonicalName: subject }]);
  return id;
}

function currentFact(db: Database.Database, entityId: number, predicate: string, scope: string = 'global') {
  return prepareOnce(db, 
    `SELECT id, object_text, event_id, valid_from, scope, author FROM facts
     WHERE subject_entity_id = ? AND predicate = ? AND scope = ? AND valid_to IS NULL
     ORDER BY valid_from DESC, id DESC LIMIT 1`
  ).get(entityId, predicate, scope) as { id: number; object_text: string; event_id: string | null; valid_from: string; scope: string; author: string | null } | undefined;
}

/**
 * One lifecycle stream per scope: a named scope is its slug (scopeSpellings), so the stream of (entity, predicate) in
 * `scope` is its facts under every spelling of the slug, and a write closes the stream's current value whatever
 * spelling either was saved with. These are that stream's current facts, newest first: one, or two when values were
 * saved under two spellings before writes closed across them (each spelling holds at most one, idx_facts_current).
 */
function streamCurrentFacts(db: Database.Database, entityId: number, predicate: string, scope: NormalizedScope) {
  return scopeSpellings(scope)
    .map(spelling => currentFact(db, entityId, predicate, spelling))
    .filter((row): row is NonNullable<typeof row> => row !== undefined)
    .sort((a, b) => (a.valid_from === b.valid_from ? b.id - a.id : a.valid_from < b.valid_from ? 1 : -1));
}

/**
 * The fact an event closes under the other spelling of its slug: the one its closed_event names, when that is the
 * current value of the same entity and predicate saved under another spelling of the event's scope. A write closes
 * across spellings only by naming the fact it closes, and before it did, closed_event only ever named the current
 * value under the event's own spelling, so a ledger written then replays exactly as it did: values saved under two
 * spellings stay current, and a read names them as a conflict until a write closes them.
 */
function currentFactClosedAcrossSpellings(db: Database.Database, ev: LedgerEvent, entityId: number, scope: NormalizedScope) {
  if (!ev.closedEvent) return undefined;
  const named = prepareOnce(db, 
    `SELECT id, object_text, event_id, valid_from, scope, author FROM facts
     WHERE event_id = ? AND subject_entity_id = ? AND predicate = ? AND valid_to IS NULL`
  ).get(ev.closedEvent.toUpperCase(), entityId, ev.predicate) as { id: number; object_text: string; event_id: string | null; valid_from: string; scope: string; author: string | null } | undefined;
  return named && named.scope !== scope && savedScopeMatches(named.scope, scope) ? named : undefined;
}

/**
 * Re-home an already-projected legacy canonical fact from a disposable
 * note-derived entity onto the stable lifecycle-owned entity (Astra A2 /
 * Kimi R2, Kimi K9). The row keeps its event_id, timestamps and history —
 * only ownership moves, and nothing is dropped or duplicated.
 *
 * Constraint-safe ordering (K9): idx_facts_current is a PARTIAL unique index
 * and fires per STATEMENT. The naive move-then-close sequence made the moved
 * row a second open current for one statement and threw UNIQUE before the
 * reconciliation close could run, bricking upgrade replay on mixed-owner
 * states. Instead, the winner is decided BEFORE any move and the statements
 * are ordered so no intermediate state ever has two open currents:
 *
 *   - no competing lifecycle current, or the moving row is historical
 *       -> plain move (never enters the partial index scope as a second open row);
 *   - the existing lifecycle current is the canonical winner -> the moving
 *     row is closed AND moved in ONE statement (valid_to set in the same
 *     UPDATE, so the index never sees it as an open duplicate);
 *   - the moving row is the canonical winner -> competing lifecycle currents
 *     are closed first, then the row moves in as the only open current.
 *
 * Winner rule (K12): the CANONICAL LEDGER position of each row's event decides
 * — the event that appears later in the ledger wins, exactly matching what a
 * fresh in-order replay would produce. SQLite row ids are disposable cache
 * artifacts (insertion order of a legacy projection) and are NEVER consulted.
 * A competing open row with an event_id that is ABSENT from the ledger is an
 * index-vs-ledger contradiction: it fails explicitly rather than being ordered
 * by guesswork. A NULL-event row (base vault_store_fact wrote those, bypassing
 * the ledger) is non-canonical by construction and never wins against a
 * ledger event. Residual interval flags are canonicalized afterwards by
 * reconcileStreamCurrent, so this function only has to make the MOVE safe.
 */
function rehomeLifecycleFact(db: Database.Database, ev: LedgerEvent, factId: number, positions: Map<string, number>, lifecycleId: number): void {
  const tx = db.transaction(() => {
    const moving = prepareOnce(db, 'SELECT id, valid_from, valid_to FROM facts WHERE id = ?').get(factId) as { id: number; valid_from: string; valid_to: string | null };
    const existing = currentFact(db, lifecycleId, ev.predicate, normalizeScope(ev.scope));
    if (existing && moving.valid_to === null) {
      const movingPos = requireLedgerPosition(positions, ev.id);
      let movingWins: boolean;
      if (existing.event_id == null) {
        // Non-event-backed row: never canonical against a ledger event.
        movingWins = true;
      } else {
        const existingPos = requireLedgerPosition(positions, existing.event_id);
        movingWins = movingPos > existingPos; // later canonical event wins (row ids never consulted)
      }
      if (movingWins) {
        // Close the competing lifecycle current(s) BEFORE the move, so the
        // moving row is never a second open current. The valid_to value here
        // is provisional; reconcileStreamCurrent canonicalizes it afterwards.
        prepareOnce(db, 
          `UPDATE facts SET valid_to = ?, updated_at = ? WHERE subject_entity_id = ? AND predicate = ? AND scope = ? AND valid_to IS NULL AND id != ?`
        ).run(moving.valid_from, moving.valid_from, lifecycleId, ev.predicate, normalizeScope(ev.scope), moving.id);
        prepareOnce(db, 'UPDATE facts SET subject_entity_id = ? WHERE id = ?').run(lifecycleId, factId);
      } else {
        // The existing lifecycle current wins canonically: close AND move the
        // row in one statement. With valid_to set in the same UPDATE, the
        // partial index (valid_to IS NULL) never sees the moved row as open.
        prepareOnce(db, 'UPDATE facts SET subject_entity_id = ?, valid_to = ?, updated_at = ? WHERE id = ?')
          .run(lifecycleId, existing.valid_from, existing.valid_from, factId);
      }
    } else {
      // No competing open current, or the moving row is historical: a plain
      // move cannot violate the partial index.
      prepareOnce(db, 'UPDATE facts SET subject_entity_id = ? WHERE id = ?').run(lifecycleId, factId);
    }
  });
  tx();
}

/** Later of two timestamps by instant comparison (raw strings preserved). */
function maxInstant(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Canonical position of a ledger event, or an explicit refusal to guess. */
function requireLedgerPosition(positions: Map<string, number>, eventId: string): number {
  const pos = positions.get(eventId);
  if (pos === undefined) {
    throw new Error(`index holds a lifecycle fact for event ${eventId} which is absent from the ledger; refusing to guess canonical order — restore the ledger or deliberately rebuild the derived index`);
  }
  return pos;
}

/**
 * Canonical stream reconciliation (K12): recompute the current/valid_to chain
 * for every event-backed lifecycle fact of (lifecycle entity, predicate) from
 * the CANONICAL ledger positions, exactly mirroring what a fresh in-order
 * replay produces — the event that appears latest in the ledger is the
 * current fact; each earlier event's row is closed at its canonical
 * successor's valid_from (never before its own valid_from, so no negative
 * intervals). Stale winner flags left behind by earlier candidate reconciliations
 * (including migration 6's interim duplicate repair, which cannot read the
 * ledger) are repaired here, before readiness. Non-event-backed open rows are
 * non-canonical (base vault_store_fact bypassed the ledger): they are closed
 * at the start of the canonical record and KEPT in history — never dropped.
 * Event-backed rows whose event is absent from the ledger are an
 * index-vs-ledger contradiction and fail explicitly. Unrelated (non '_mcp_')
 * facts are not touched. Idempotent: re-running produces no further writes.
 *
 * The stream is the scope's slug (streamCurrentFacts): the rows of every
 * spelling are replayed together, in ledger order, as applyEvent applies them.
 * Each event closes the current row of its own spelling and the row its
 * closed_event names under another spelling (currentFactClosedAcrossSpellings;
 * `closedBy` holds each event's closed_event). Without such a link the
 * spellings never touch, so each spelling's chain is exactly the per-spelling
 * chain this function computed before scopes were one slug.
 */
/**
 * What an erased fact closed, by its event id: from its tombstone's closing link, or from the link erased_facts kept when a
 * lost rename left its content event in the ledger. Ids and a time only.
 */
type ErasedClosers = Map<string, { closes: string[]; closedAt: string }>;

function reconcileStreamCurrent(db: Database.Database, lifecycleId: number, predicate: string, positions: Map<string, number>, scope: NormalizedScope = 'global', closedBy: Map<string, string> = new Map(), closers: ErasedClosers = new Map()): void {
  transactionOnce(db, reconcileStreamCurrentBody)(lifecycleId, predicate, positions, scope, closedBy, closers);
}

/** The body of reconcileStreamCurrent's transaction: a module-level function so replay wraps it once per connection (transactionOnce). */
function reconcileStreamCurrentBody(db: Database.Database, lifecycleId: number, predicate: string, positions: Map<string, number>, scope: NormalizedScope, closedBy: Map<string, string>, closers: ErasedClosers): void {
  const inStream = savedScopeSqlPredicate(scope, 'scope');
  // A retired fact keeps its place in the stream (retireFact): it is hidden, not undone, so the value it closed stays
  // closed and the value saved after it closes it, exactly as if it had never been retired.
  const rows = prepareOnce(db, 
    `SELECT id, event_id, valid_from, valid_to, scope, 0 AS retired FROM facts
     WHERE subject_entity_id = ? AND predicate = ? AND ${inStream.sql} AND source_path = '_mcp_'
     UNION ALL
     SELECT id, event_id, valid_from, valid_to, scope, 1 AS retired FROM retired_facts
     WHERE subject_entity_id = ? AND predicate = ? AND ${inStream.sql}`
  ).all(lifecycleId, predicate, ...inStream.params, lifecycleId, predicate, ...inStream.params) as Array<{ id: number; event_id: string | null; valid_from: string; valid_to: string | null; scope: string; retired: 0 | 1 }>;
  const table = (row: { retired: 0 | 1 }) => (row.retired ? 'retired_facts' : 'facts');
  const canonical: Array<{ id: number; event_id: string; valid_from: string; valid_to: string | null; scope: string; retired: 0 | 1; pos: number }> = [];
  for (const r of rows) {
    if (r.event_id == null) continue;
    canonical.push({ ...r, event_id: r.event_id, pos: requireLedgerPosition(positions, r.event_id) });
  }
  canonical.sort((a, b) => a.pos - b.pos);
  // The replay, in ledger order: the current row of each spelling, and the valid_to each closed row gets.
  // Full equivalence with a fresh replay (K12): the fresh-apply path rejects
  // an event whose time precedes the current fact it would close; the same
  // rule applies to an already-projected chain, so an invalid ledger is
  // rejected by BOTH upgrade replay and fresh rebuild, never repaired into
  // a state a fresh replay could not produce. (Equal timestamps are legal.)
  const current = new Map<string, (typeof canonical)[number]>();
  const closeAt = new Map<number, string>();
  // An erased fact has no row any more, but at its place in the ledger it still closes what it closed, at its own time, as a
  // fresh replay of its tombstone does (applyEvent); it never becomes current itself.
  const inChain = new Set(canonical.map(row => row.event_id));
  const links = [...closers]
    .filter(([id, link]) => positions.has(id) && link.closes.some(closed => inChain.has(closed)))
    .map(([id, link]) => ({ pos: positions.get(id)!, ...link }));
  const steps = [...canonical.map(row => ({ pos: row.pos, row })), ...links.map(link => ({ pos: link.pos, link }))]
    .sort((x, y) => x.pos - y.pos);
  for (const step of steps) {
    if ('link' in step) {
      for (const [spelling, open] of [...current]) {
        if (!step.link.closes.includes(open.event_id)) continue;
        closeAt.set(open.id, maxInstant(step.link.closedAt, open.valid_from));
        current.delete(spelling);
      }
      continue;
    }
    const row = step.row;
    const named = closedBy.get(row.event_id);
    const across = named === undefined ? undefined
      : [...current.values()].find(r => r.scope !== row.scope && r.event_id === named);
    for (const closed of [current.get(row.scope), across]) {
      if (!closed) continue;
      if (Date.parse(row.valid_from) < Date.parse(closed.valid_from)) {
        throw new Error(`ledger event ${row.event_id} (${row.valid_from}) is older than the current fact for the same subject+predicate (valid_from ${closed.valid_from}, event ${closed.event_id}); refusing to apply out-of-order`);
      }
      closeAt.set(closed.id, maxInstant(row.valid_from, closed.valid_from));
      current.delete(closed.scope);
    }
    current.set(row.scope, row);
  }
  // Pass 1 (constraint-safe): apply all NON-NULL valid_to targets first, so
  // at most one open row per spelling remains before the NULL (current) updates.
  for (const row of canonical) {
    const want = closeAt.get(row.id);
    if (want !== undefined && (row.valid_to ?? null) !== want) {
      prepareOnce(db, `UPDATE ${table(row)} SET valid_to = ?, updated_at = ? WHERE id = ?`).run(want, want, row.id);
    }
  }
  for (const spelling of scopeSpellings(scope)) {
    const chain = canonical.filter(row => row.scope === spelling);
    if (chain.length === 0) continue;
    const last = current.get(spelling);
    if (last && last.valid_to !== null) {
      prepareOnce(db, `UPDATE ${table(last)} SET valid_to = NULL, updated_at = ? WHERE id = ?`).run(last.valid_from, last.id);
    }
    // Non-event-backed open rows never stay current against canonical events.
    const firstCanonicalFrom = chain[0].valid_from;
    for (const r of rows) {
      if (r.scope === spelling && r.event_id == null && r.valid_to === null) {
        const want = maxInstant(firstCanonicalFrom, r.valid_from);
        prepareOnce(db, 'UPDATE facts SET valid_to = ?, updated_at = ? WHERE id = ?').run(want, want, r.id);
      }
    }
  }
}

/**
 * The transaction applyEvent runs for an event that is already projected: re-home a fact still attached to a disposable entity,
 * then reconcile its stream. A module-level function so replay wraps it once per connection (transactionOnce).
 */
function reconcileProjectedEvent(db: Database.Database, ev: LedgerEvent, factId: number, rehome: boolean, positions: Map<string, number>, lifecycleId: number, closedBy: Map<string, string> | undefined, closers: ErasedClosers | undefined): void {
  if (rehome) {
    rehomeLifecycleFact(db, ev, factId, positions, lifecycleId);
  }
  // Do not preserve stale winner/valid_to flags merely because the event
  // is already projected: recompute the chain from canonical ledger order
  // so the upgraded cache is equivalent to a fresh replay of the ledger.
  reconcileStreamCurrent(db, lifecycleId, ev.predicate, positions, normalizeScope(ev.scope), closedBy, closers);
}

/**
 * Apply one memory event to SQLite inside a single transaction:
 * dedup check → entity resolution → close current → insert fact → receipt.
 * Idempotent by event id + digest; a reused id with a conflicting payload is
 * explicit corruption; a failed insert can never leave a partial supersession.
 */
function applyEvent(db: Database.Database, ev: LedgerEvent, positions?: Map<string, number>, index?: ReplayEntityIndex, closedBy?: Map<string, string>, closers?: ErasedClosers): { applied: boolean; factId: number | null } {
  validateLedgerEvent(ev);
  const digest = eventDigest(ev);

  const seen = prepareOnce(db, 'SELECT digest FROM applied_ledger_events WHERE event_id = ?').get(ev.id) as { digest: string } | undefined;
  if (seen && seen.digest !== digest) {
    throw new Error(`ledger event id ${ev.id} was reused with a conflicting payload; refusing to apply (corruption)`);
  }

  if (ev.kind === ERASE_KIND) {
    db.transaction(() => {
      const entityIds = db.prepare('SELECT subject_entity_id FROM facts WHERE event_id = ? UNION SELECT subject_entity_id FROM retired_facts WHERE event_id = ?')
        .pluck().all(ev.id, ev.id) as number[];
      const ids = db.prepare('SELECT id FROM facts WHERE event_id = ? UNION SELECT id FROM retired_facts WHERE event_id = ?')
        .all(ev.id, ev.id) as Array<{ id: number }>;
      // The erased value can also live on in the writer conflicts (writerConflicts.ts): a later fact that replaced it keeps
      // it as an open displacement, carried forward by its writer's next saves. Drop those and the erased fact's own row.
      const gone = db.prepare('SELECT object_text, valid_from, author FROM facts WHERE event_id = ? UNION SELECT object_text, valid_from, author FROM retired_facts WHERE event_id = ?')
        .get(ev.id, ev.id) as { object_text: string; valid_from: string; author: string | null } | undefined;
      if (gone) {
        const goneWriter = writerOf(db, ev.id, gone.author).writer;
        const rows = db.prepare(`SELECT event_id, displaced FROM fact_writers WHERE displaced <> '[]'`).all() as Array<{ event_id: string; displaced: string }>;
        for (const row of rows) {
          const displaced = JSON.parse(row.displaced) as OpenDisplacement[];
          const kept = displaced.filter(d => !(d.object === gone.object_text && d.validFrom === gone.valid_from && d.writer === goneWriter));
          if (kept.length !== displaced.length) db.prepare('UPDATE fact_writers SET displaced = ? WHERE event_id = ?').run(JSON.stringify(kept), row.event_id);
        }
      }
      db.prepare('DELETE FROM fact_writers WHERE event_id = ?').run(ev.id);
      for (const row of ids) db.prepare('DELETE FROM fact_terms WHERE fact_id = ?').run(row.id);
      db.prepare('DELETE FROM facts WHERE event_id = ?').run(ev.id);
      db.prepare('DELETE FROM retired_facts WHERE event_id = ?').run(ev.id);
      db.prepare('DELETE FROM fact_retirements WHERE target = ?').run(ev.id);
      db.prepare(`DELETE FROM write_events WHERE note_path = '_memory_ledger_' AND action IN ('retire', 'restore')
        AND json_valid(summary) AND json_extract(summary, '$.id') = ?`).run(`fact:${ev.id}`);
      for (const entityId of entityIds) {
        const used = db.prepare('SELECT 1 FROM facts WHERE subject_entity_id = ? UNION SELECT 1 FROM retired_facts WHERE subject_entity_id = ? LIMIT 1').get(entityId, entityId);
        if (!used) db.prepare(`DELETE FROM entities WHERE id = ? AND source_note = '_mcp_'`).run(entityId);
      }
      // What the erased fact closed stays closed: on a rebuild nothing else in the ledger closes it any more. A fact still open
      // here (a fresh replay) is closed at the erased fact's own time; one already closed, or gone, is left as it is.
      if (ev.closes !== undefined) {
        for (const closed of ev.closes) {
          for (const table of ['facts', 'retired_facts']) {
            db.prepare(`UPDATE ${table} SET valid_to = ?, updated_at = ? WHERE event_id = ? AND valid_to IS NULL`).run(ev.closedAt, ev.closedAt, closed);
          }
        }
      }
      // Store the old digest under the old id: verification still detects a changed pre-erasure event, while no payload remains.
      db.prepare('INSERT OR REPLACE INTO applied_ledger_events (event_id, digest, applied_at) VALUES (?, ?, ?)')
        .run(ev.id, ev.originalDigest, ev.at);
      // A tombstone without a closing link (written before there was one) keeps a link already recorded here.
      db.prepare(`INSERT INTO erased_facts (event_id, original_digest, erased_at, closes, closed_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET original_digest = excluded.original_digest, erased_at = excluded.erased_at,
          closes = COALESCE(excluded.closes, erased_facts.closes), closed_at = COALESCE(excluded.closed_at, erased_facts.closed_at)`)
        .run(ev.id, ev.originalDigest, ev.at, ev.closes !== undefined ? ev.closes.join(',') : null, ev.closedAt ?? null);
    })();
    return { applied: seen === undefined, factId: null };
  }

  // An erased fact's own event, or a retirement of it, that turns up again (a stale copy, a restored fragment): its digest
  // is the one the tombstone kept, so the check above passes, and the missing-fact repair below would project it again.
  // Erasure is final: skip it, whichever came first in this ledger.
  if (prepareOnce(db, 'SELECT 1 FROM erased_facts WHERE event_id IN (?, ?)').get(ev.id, ev.target?.toUpperCase() ?? ev.id)) {
    return { applied: false, factId: null };
  }

  if (RETIREMENT_KINDS.has(ev.kind)) {
    applyRetirement(db, ev, digest, seen !== undefined);
    return { applied: seen === undefined, factId: null };
  }

  // A retired fact is projected too: its row waits in retired_facts.
  const liveRow = prepareOnce(db, 'SELECT id, subject_entity_id FROM facts WHERE event_id = ?').get(ev.id) as { id: number; subject_entity_id: number } | undefined;
  const factRow = liveRow
    ?? prepareOnce(db, 'SELECT id, subject_entity_id FROM retired_facts WHERE event_id = ?').get(ev.id) as { id: number; subject_entity_id: number } | undefined;
  if (factRow) {
    // Event already projected — but a pre-Gate1A index can hold this canonical
    // fact attached to a DISPOSABLE note-derived entity (the base engine
    // resolved subjects via generic lookupEntity). Re-home it onto the stable
    // lifecycle-owned entity BEFORE readiness and later writes, or note
    // reindexing would cascade-delete it (Astra A2 / Kimi R2 loss window).
    // K12: reconciliation of the already-projected stream is CANONICAL — it
    // needs the ledger event positions and refuses to guess without them
    // (this branch is unreachable from the live write path, whose event ids
    // are always fresh).
    if (!positions) {
      throw new Error(`canonical ledger order is unavailable while reconciling already-projected event ${ev.id}; refusing to guess — reconciliation requires replay context`);
    }
    const lifecycleId = resolveLifecycleEntity(db, ev.subject, ev.at, true, { preferEntityId: factRow.subject_entity_id, index }) as number;
    const owner = prepareOnce(db, 'SELECT source_note FROM entities WHERE id = ?').get(factRow.subject_entity_id) as { source_note: string } | undefined;
    // Re-home and stream reconciliation are ONE atomic unit (nested
    // transactions become savepoints): a rejected ledger (out-of-order chain,
    // absent-from-ledger contradiction) rolls the reconciliation back and
    // leaves the cache exactly as it was held — never partially reconciled.
    transactionOnce(db, reconcileProjectedEvent)(ev, factRow.id, liveRow !== undefined && owner?.source_note !== LIFECYCLE_NOTE_PATH, positions, lifecycleId, closedBy, closers);
    // If it predates the digest table (migration 6), backfill the digest so
    // future replays can tell identical dedup from conflicts (the legacy
    // payload itself can no longer be verified).
    if (!seen) {
      prepareOnce(db, 'INSERT OR IGNORE INTO applied_ledger_events (event_id, digest, applied_at) VALUES (?, ?, ?)')
        .run(ev.id, digest, new Date().toISOString());
    }
    return { applied: false, factId: null }; // byte-identical event already committed — safe dedup
  }
  // If a digest row exists but the fact is missing, the index lost the
  // projection (e.g. a partial wipe): re-apply — replay repairs the index.

  const tx = db.transaction(() => {
    // create=true always resolves or creates — never null here.
    const entityId = resolveLifecycleEntity(db, ev.subject, ev.at, true, { index }) as number;
    const closedFactIds: number[] = [];
    // The value this write replaces (the newest one it closes): the writer displacements it leaves open are read from it.
    let replaced: ClosedFact | null = null;
    // The current fact under the event's own spelling, then the one it names under the other spelling of its slug.
    const scope = normalizeScope(ev.scope);
    for (const cur of [currentFact(db, entityId, ev.predicate, scope), currentFactClosedAcrossSpellings(db, ev, entityId, scope)]) {
      if (!cur) continue;
      // Monotonicity validation: an event older than the current fact it would
      // close is arbitrary corrupt ordering — fail loudly, never silently
      // last-write-wins mask it. (Equal timestamps are legal: base-engine race
      // chains share millisecond timestamps.)
      if (ev.at < cur.valid_from) {
        throw new Error(`ledger event ${ev.id} (${ev.at}) is older than the current fact for the same subject+predicate (valid_from ${cur.valid_from}, fact id ${cur.id}); refusing to apply out-of-order`);
      }
      // K12 (replay context only): a current row whose event id is absent from
      // the ledger is an index-vs-ledger contradiction — closing it silently
      // would order canonical truth by guesswork. Fail explicitly instead.
      // (The live write path passes no positions and keeps its existing
      // behavior; the next replay of the ledger fails closed on the same row.)
      if (positions && cur.event_id != null && !positions.has(cur.event_id)) {
        requireLedgerPosition(positions, cur.event_id); // throws the explicit contradiction error
      }
      // Explicit reconciliation policy: 'supersede' closes the current fact by
      // intent. A 'store' finding an open current is NOT normal modern flow —
      // remember() writes supersede whenever it can see the current value —
      // so it can only arise from pre-Gate1A legacy chains: base-engine B2
      // races appended concurrent kind:store events, and the legacy cascade
      // loss window (Kimi R4) let a user-repair store be appended while the
      // prior projection was invisible. The prior fact is CLOSED (timestamped
      // with this event's time) and full history is preserved — nothing is
      // dropped or duplicated, and the digest/id conflict checks above still
      // fail loudly on contradictory reuse.
      prepareOnce(db, `UPDATE facts SET valid_to = ?, updated_at = ? WHERE id = ?`).run(ev.at, ev.at, cur.id);
      closedFactIds.push(cur.id);
      if (replaced === null || cur.valid_from > replaced.validFrom) {
        replaced = { eventId: cur.event_id, object: cur.object_text, validFrom: cur.valid_from, source: cur.author };
      }
    }
    // A retired value that was current under this spelling is closed as if it had never been retired
    // (reconcileStreamCurrent replays it the same way), so restoring it later brings it back as history.
    // The stream is the scope's slug, not one spelling of it (scopeSpellings): a value retired under scope:alpha is
    // closed by a save under project:alpha too, or the retired one stays open and a later restore leaves two currents.
    for (const hidden of streamOpenRetiredFacts(db, entityId, ev.predicate, scope)) {
      if (ev.at < hidden.valid_from) {
        throw new Error(`ledger event ${ev.id} (${ev.at}) is older than the retired fact it would close (valid_from ${hidden.valid_from}, event ${hidden.event_id}); refusing to apply out-of-order`);
      }
      prepareOnce(db, 'UPDATE retired_facts SET valid_to = ?, updated_at = ? WHERE id = ?').run(ev.at, ev.at, hidden.id);
    }
    const row = prepareOnce(db, 
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id, scope, author, statement_words)
       VALUES (?, ?, ?, '_mcp_', 1.0, ?, NULL, ?, ?, ?, ?, ?) RETURNING id`
    ).get(entityId, ev.predicate, ev.object, ev.at, ev.at, ev.id, scope, ev.source, statementTerms(ev.statement)) as { id: number };
    // Who saved it, and the writer displacements it leaves open (writerConflicts.ts); a replay writes the same row.
    const writer = ev.writer ?? ev.source;
    prepareOnce(db, 'INSERT OR REPLACE INTO fact_writers (event_id, writer, displaced) VALUES (?, ?, ?)')
      .run(ev.id, writer, JSON.stringify(displacementsAfter(db, replaced, { eventId: ev.id, writer, object: ev.object })));
    // Searchable by its words from the moment it exists: the index row is written by this transaction,
    // under the subject name a read shows (the entity's, which may be an earlier spelling of ev.subject).
    indexFactTerms(db, row.id, scope, { subject: canonicalSubject(db, entityId), predicate: ev.predicate, object: ev.object });
    prepareOnce(db, `INSERT INTO write_events (note_path, action, summary, created_at, author, scope) VALUES ('_memory_ledger_', ?, ?, ?, ?, ?)`)
      .run(ev.kind, `${ev.subject} ${ev.predicate} → ${ev.object}${closedFactIds.length ? ` (closed fact${closedFactIds.length > 1 ? 's' : ''} ${closedFactIds.join(', ')})` : ''}`, ev.at, ev.source, ev.scope ?? 'global');
    prepareOnce(db, 'INSERT OR REPLACE INTO applied_ledger_events (event_id, digest, applied_at) VALUES (?, ?, ?)')
      .run(ev.id, digest, ev.at);
    return row.id;
  });
  const factId = tx() as number;
  return { applied: true, factId };
}

/** The retired fact that was the current value of a stream spelling when it was retired, if one still is. */
function openRetiredFact(db: Database.Database, entityId: number, predicate: string, scope: string) {
  return prepareOnce(db, 
    `SELECT id, event_id, valid_from, object_text, scope FROM retired_facts
     WHERE subject_entity_id = ? AND predicate = ? AND scope = ? AND valid_to IS NULL
     ORDER BY valid_from DESC, id DESC LIMIT 1`
  ).get(entityId, predicate, scope) as { id: number; event_id: string; valid_from: string; object_text: string; scope: string } | undefined;
}

/**
 * The retired facts that were the current value of a stream spelling when they were retired, one per spelling at most,
 * newest first. The stream is the scope's slug (scopeSpellings): a save closes the retired current whatever spelling it
 * was retired under, exactly as it closes the live current across spellings (streamCurrentFacts). Closing it at save
 * time is what lets a later restore bring it back as history instead of as a second current value.
 */
function streamOpenRetiredFacts(db: Database.Database, entityId: number, predicate: string, scope: NormalizedScope) {
  return scopeSpellings(scope)
    .map(spelling => openRetiredFact(db, entityId, predicate, spelling))
    .filter((row): row is NonNullable<typeof row> => row !== undefined)
    .sort((a, b) => (a.valid_from === b.valid_from ? b.id - a.id : a.valid_from < b.valid_from ? 1 : -1));
}

const FACT_COLUMNS = 'id, subject_entity_id, predicate, object_text, confidence, valid_from, valid_to, updated_at, event_id, scope, author, statement_words';
interface FactRow {
  id: number; subject_entity_id: number; predicate: string; object_text: string; confidence: number;
  valid_from: string; valid_to: string | null; updated_at: string; event_id: string; scope: string;
  author: string | null; statement_words: string | null;
}

/**
 * Moves a lifecycle fact's row out of `facts`, id and all, into retired_facts: no read of `facts` (current values,
 * history, as_of, search, the facts lane, memory_map, the subject lists) returns it after this, with nothing to filter.
 * False when no such row is in `facts` (it is already retired, or no fact has that event).
 */
function moveFactOut(db: Database.Database, eventId: string, retire: LedgerEvent): boolean {
  const row = prepareOnce(db, `SELECT ${FACT_COLUMNS} FROM facts WHERE event_id = ? AND source_path = ?`)
    .get(eventId, LIFECYCLE_NOTE_PATH) as FactRow | undefined;
  if (!row) return false;
  prepareOnce(db, 
    `INSERT INTO retired_facts (${FACT_COLUMNS}, retire_event_id, retired_at, retired_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.subject_entity_id, row.predicate, row.object_text, row.confidence, row.valid_from, row.valid_to,
    row.updated_at, row.event_id, row.scope, row.author, row.statement_words, retire.id, retire.at, retire.source);
  unindexFactTerms(db, row.id, row.scope, { subject: canonicalSubject(db, row.subject_entity_id), predicate: row.predicate, object: row.object_text });
  prepareOnce(db, 'DELETE FROM facts WHERE id = ?').run(row.id);
  return true;
}

/**
 * A restatement can supersede an identical value only because it kept different user words. When that current
 * restatement is retired, reopen the exact value it directly replaced. Different values remain historical: retiring a
 * correction is not itself another correction. This projection is derived from the save chain, so replay makes the
 * same choice without adding a second value to the retire event.
 */
function reviveIdenticalPredecessor(db: Database.Database, eventId: string): void {
  const retired = prepareOnce(db, `SELECT ${FACT_COLUMNS} FROM retired_facts WHERE event_id = ?`).get(eventId) as FactRow | undefined;
  if (!retired || retired.valid_to !== null) return; // Retiring history never changes the current value.
  const inStream = savedScopeSqlPredicate(normalizeScope(retired.scope), 'scope');
  const prior = prepareOnce(db, 
    `SELECT ${FACT_COLUMNS} FROM facts
      WHERE subject_entity_id = ? AND predicate = ? AND object_text = ? AND valid_to = ?
        AND source_path = ? AND ${inStream.sql}
      ORDER BY valid_from DESC, id DESC LIMIT 1`
  ).get(retired.subject_entity_id, retired.predicate, retired.object_text, retired.valid_from,
    LIFECYCLE_NOTE_PATH, ...inStream.params) as FactRow | undefined;
  if (!prior) return;
  prepareOnce(db, 'UPDATE facts SET valid_to = NULL, updated_at = ? WHERE id = ?').run(retired.updated_at, prior.id);
}

/** Puts a retired fact's row back into `facts` as it was. False when it is not retired. */
function moveFactBack(db: Database.Database, eventId: string): boolean {
  const row = prepareOnce(db, `SELECT ${FACT_COLUMNS}, retired_at FROM retired_facts WHERE event_id = ?`).get(eventId) as (FactRow & { retired_at: string }) | undefined;
  if (!row) return false;
  let validTo = row.valid_to;
  if (validTo === null) {
    // A later value anywhere in the same stream closes the retired one when it is saved (applyEvent), so this finds one
    // only in an index written otherwise; it is resolved the same way, the later value staying current. The stream is
    // the scope's slug, not one spelling of it (scopeSpellings): a value saved under project:alpha replaces a value
    // retired under scope:alpha, so looking only at the row's own spelling left two current values in one stream.
    const open = streamCurrentFacts(db, row.subject_entity_id, row.predicate, normalizeScope(row.scope))[0];
    if (open) {
      if (open.object_text === row.object_text && open.valid_from < row.valid_from) {
        // The older identical value was revived when this restatement was retired. Restoring the restatement keeps it
        // as history instead of manufacturing a second current value or replacing the explicitly revived one.
        validTo = row.retired_at;
      } else if (open.valid_from < row.valid_from) {
        throw new Error(`cannot restore fact event ${eventId}: the current value (event ${open.event_id}) is older than it; rebuild the index from the ledger`);
      }
      else validTo = open.valid_from;
    }
  }
  prepareOnce(db, 
    `INSERT INTO facts (${FACT_COLUMNS}, source_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.subject_entity_id, row.predicate, row.object_text, row.confidence, row.valid_from, validTo,
    validTo === row.valid_to ? row.updated_at : validTo, row.event_id, row.scope, row.author, row.statement_words, LIFECYCLE_NOTE_PATH);
  indexFactTerms(db, row.id, row.scope, { subject: canonicalSubject(db, row.subject_entity_id), predicate: row.predicate, object: row.object_text });
  prepareOnce(db, 'DELETE FROM retired_facts WHERE id = ?').run(row.id);
  return true;
}

/**
 * Applies a retire or restore event. Every one is listed in fact_retirements, so a search never shows its ledger text.
 * A replay leaves the ones it already applied to settleRetirements, which sets each fact to the state its LAST
 * retirement event left it in; anything else moves the fact now. Moving a fact that is already where the event puts
 * it changes nothing (a retry, or a replay over an index that already holds it); a target that is no fact is
 * corruption.
 */
function applyRetirement(db: Database.Database, ev: LedgerEvent, digest: string, alreadyApplied: boolean): void {
  const target = ev.target!.toUpperCase();
  db.transaction(() => {
    prepareOnce(db, 'INSERT OR IGNORE INTO fact_retirements (event_id, kind, target, at, source) VALUES (?, ?, ?, ?, ?)')
      .run(ev.id, ev.kind, target, ev.at, ev.source);
    if (alreadyApplied) return;
    const moved = ev.kind === 'retire' ? moveFactOut(db, target, ev) : moveFactBack(db, target);
    if (ev.kind === 'retire') reviveIdenticalPredecessor(db, target);
    const already = ev.kind === 'retire'
      ? prepareOnce(db, 'SELECT 1 FROM retired_facts WHERE event_id = ?').get(target)
      : prepareOnce(db, 'SELECT 1 FROM facts WHERE event_id = ?').get(target);
    if (!moved && !already) throw new Error(`ledger corruption in event ${ev.id}: its target ${target} is no saved fact`);
    // The value stays out of the log, as it stays out of the event: memory_map lists this event.
    prepareOnce(db, 'INSERT INTO write_events (note_path, action, summary, created_at, author, scope) VALUES (?, ?, ?, ?, ?, ?)')
      .run('_memory_ledger_', ev.kind, JSON.stringify({ id: `fact:${target}`, title: `${ev.subject} ${ev.predicate}` }), ev.at, ev.source, ev.scope ?? 'global');
    prepareOnce(db, 'INSERT OR REPLACE INTO applied_ledger_events (event_id, digest, applied_at) VALUES (?, ?, ?)')
      .run(ev.id, digest, ev.at);
  })();
}

/**
 * After a replay: each fact the ledger retired or restored is where its last such event left it, and a fact retired in
 * the index that the ledger never retired (its event was removed by hand) is back. Facts move whole, so the chain a
 * replay just reconciled stays as it is.
 */
function settleRetirements(db: Database.Database, events: LedgerEvent[]): void {
  const last = new Map<string, LedgerEvent>();
  for (const ev of events) if (RETIREMENT_KINDS.has(ev.kind)) last.set(ev.target!.toUpperCase(), ev);
  const retired = prepareOnce(db, 'SELECT event_id FROM retired_facts').all() as Array<{ event_id: string }>;
  db.transaction(() => {
    for (const [target, ev] of last) {
      if (ev.kind === 'retire') {
        moveFactOut(db, target, ev);
        reviveIdenticalPredecessor(db, target);
      }
      else moveFactBack(db, target);
    }
    for (const { event_id } of retired) if (!last.has(event_id)) moveFactBack(db, event_id);
  })();
}

/** Replay the ledger into facts. Idempotent by event id + digest. Throws on corruption. */
export async function replayLedger(
  db: Database.Database, vaultPath: string, ledgerRelPath: string,
  options: { setTornTailAside?: boolean } = {},
): Promise<number> {
  const filePath = resolveLedgerPath(vaultPath, ledgerRelPath); // shared confinement, before any read
  if (options.setTornTailAside === true) await removeStaleEraseTemps(filePath);
  let content: string;
  let finalEventKnown = false;
  try {
    ({ content, finalEventKnown } = await readLedgerForReplay(
      vaultPath,
      filePath,
      eventId => prepareOnce(db, 'SELECT 1 FROM applied_ledger_events WHERE event_id = ?').get(eventId) !== undefined,
      options.setTornTailAside === true,
    ));
  } catch (caught) {
    const err = caught as NodeJS.ErrnoException | null | undefined;
    if (err?.code === 'ENOENT') {
      // Only an absent ledger means "known-new empty vault: nothing recorded yet".
      // If the index already projects canonical events, the authoritative ledger
      // is GONE — silently treating that as an empty vault would let startup go
      // ready on a stale index whose source of truth no longer exists (and the
      // next rebuild would wipe every canonical fact). Fail closed instead;
      // recovery is restoring the ledger or deliberately wiping the derived
      // index.
      // ALL reliable evidence of prior canonical projection counts (Kimi K10 /
      // Astra A3.1): digest rows, event_id-backed facts (a base-v5 DB carries
      // these with an empty digest table — digests are only backfilled BY a
      // successful replay, which needs the ledger), and lifecycle write_events.
      const projected =
        (prepareOnce(db, 'SELECT COUNT(*) c FROM applied_ledger_events').get() as { c: number }).c
        + (prepareOnce(db, 'SELECT COUNT(*) c FROM facts WHERE event_id IS NOT NULL').get() as { c: number }).c
        + (prepareOnce(db, `SELECT COUNT(*) c FROM write_events WHERE note_path = '_memory_ledger_'`).get() as { c: number }).c;
      if (projected > 0) {
        throw new Error(`ledger file is missing at ${filePath} but ${projected} canonical event(s) are already projected in the index; refusing to treat this as an empty vault — restore the ledger or deliberately rebuild from scratch`);
      }
      return 0;
    }
    // EISDIR / EACCES / EIO / anything else is a real I/O failure: block
    // readiness (B7 fail-closed), never "replayed 0 events".
    throw new Error(`ledger read failed (${err?.code ?? 'unknown'}) at ${filePath}: ${err?.message ?? err}`);
  }
  let applied = 0;
  const events = parseLedgerEvents(content, { finalEventKnown });
  // Canonical append order of the ledger (K12): the ONLY ordering input for
  // reconciliation of already-projected streams. Byte-identical duplicate ids
  // dedup and conflicting reuse throws in applyEvent; the first occurrence
  // fixes each event's canonical position.
  const positions = new Map<string, number>();
  // Each event's closed_event: reconciling a stream replays the facts closed across spellings (reconcileStreamCurrent).
  const closedBy = new Map<string, string>();
  // What each erased fact closed (reconcileStreamCurrent): its tombstone's link, or, when a lost rename left its content event
  // in the ledger, the link the index kept for it.
  const closers: ErasedClosers = new Map();
  for (let i = 0; i < events.length; i++) {
    if (positions.has(events[i].id)) continue;
    positions.set(events[i].id, i);
    const closed = events[i].closedEvent;
    if (closed) closedBy.set(events[i].id, closed.toUpperCase());
    if (events[i].kind === ERASE_KIND && events[i].closes !== undefined) closers.set(events[i].id, { closes: events[i].closes!, closedAt: events[i].closedAt! });
    // A retirement names a fact event written before it.
    const target = events[i].target?.toUpperCase();
    if (target !== undefined) {
      const at = positions.get(target);
      if (at === undefined || RETIREMENT_KINDS.has(events[at].kind) || events[at].kind === ERASE_KIND) {
        throw new Error(`ledger corruption in event ${events[i].id}: its target ${target} is no fact event before it in the ledger`);
      }
    }
  }
  for (const kept of prepareOnce(db, 'SELECT event_id, closes, closed_at FROM erased_facts WHERE closes IS NOT NULL AND closed_at IS NOT NULL').all() as Array<{ event_id: string; closes: string; closed_at: string }>) {
    if (positions.has(kept.event_id) && !closers.has(kept.event_id)) closers.set(kept.event_id, { closes: kept.closes.split(','), closedAt: kept.closed_at });
  }

  // GLOBAL preflight (K13): every event-backed canonical projection in the
  // index must be explainable by the COMPLETE parsed ledger — not just the
  // streams this replay happens to touch. The stream-scoped refusal (re-home
  // competition, per-stream reconcile) cannot see a stream whose ONLY event
  // was removed from the ledger; such an orphaned row would survive as a
  // served current fact with false ledger provenance, silently diverging from
  // a clean rebuild of the identical ledger. Fail closed BEFORE any cache
  // mutation, with the same explicit contradiction error as the stream-scoped
  // checks. Unrelated (non '_mcp_') and NULL-event rows are not touched; no
  // history is dropped or invented — the operator restores the ledger or
  // deliberately rebuilds the derived index.
  const projectedIds = prepareOnce(db, 
    `SELECT DISTINCT event_id FROM facts WHERE event_id IS NOT NULL AND source_path = '_mcp_'
     UNION SELECT event_id FROM retired_facts`
  ).all() as Array<{ event_id: string }>;
  const orphaned = projectedIds
    .map(r => r.event_id)
    .filter(id => !positions.has(id.toUpperCase()));
  if (orphaned.length > 0) {
    const shown = orphaned.slice(0, 3).join(', ');
    throw new Error(`index holds lifecycle facts for ${orphaned.length} event(s) absent from the ledger (${shown}${orphaned.length > 3 ? ', …' : ''}); refusing to guess canonical order — restore the ledger or deliberately rebuild the derived index`);
  }

  const index = replayEntityIndex(db);
  for (const ev of events) {
    if (applyEvent(db, ev, positions, index, closedBy, closers).applied) applied++;
  }
  settleRetirements(db, events);
  backfillStatementWords(db, events);
  return applied;
}

const STATEMENT_WORDS_BACKFILL = 'statement_words_backfilled';

/**
 * Facts saved before migration 25 have no `statement_words`, and replay skips their events (applied_ledger_events holds
 * them), so the words are derived here once per database from the ledger event that saved each fact. This writes derived
 * index rows only; the ledger is read, never written. Facts saved without a statement stay null.
 */
function backfillStatementWords(db: Database.Database, events: LedgerEvent[]): void {
  if (prepareOnce(db, 'SELECT 1 FROM index_state WHERE key = ?').get(STATEMENT_WORDS_BACKFILL) !== undefined) return;
  const live = prepareOnce(db, 'UPDATE facts SET statement_words = ? WHERE event_id = ? AND statement_words IS NULL');
  const retired = prepareOnce(db, 'UPDATE retired_facts SET statement_words = ? WHERE event_id = ? AND statement_words IS NULL');
  for (const ev of events) {
    const words = statementTerms(ev.statement);
    if (words === null) continue;
    live.run(words, ev.id);
    retired.run(words, ev.id);
  }
  prepareOnce(db, 'INSERT OR REPLACE INTO index_state (key, value) VALUES (?, ?)').run(STATEMENT_WORDS_BACKFILL, '1');
}

// In-process single-writer chain: serializes the full lifecycle decision +
// ledger append + projection so concurrent remember() calls for the same (or
// any) subject+predicate cannot interleave. Cross-process/crash durability
// (OS-level writer lock, fsync barriers) is deliberately Gate 1B scope.
let writeChain: Promise<unknown> = Promise.resolve();
function serializeLifecycleWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeChain.then(fn, fn);
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}

/** The principal write verb. Ledger-first, then SQLite. Idempotent on identical current value. */
export async function remember(db: Database.Database, vaultPath: string, ledgerRelPath: string, args: {
  subject: string; predicate: string; object: string; source?: string; scope?: string; statement?: string;
  /** The authenticated writer of the save (mvp/server.ts `agentOf`); absent, the writer is the source. */
  writer?: string;
  /**
   * Write only if the current fact of this subject, predicate and scope was written by this event (null: only if there
   * is none). Otherwise nothing is written and StaleExpectationError is thrown. Absent: no check, as every caller does.
   */
  expectCurrentEvent?: string | null;
  /** Events whose values the write copies: each must still be a live current fact, else StaleExpectationError. Absent: no check. */
  expectLiveEvents?: string[];
}): Promise<MemoryReceipt> {
  return serializeLifecycleWrite(() => rememberCritical(db, vaultPath, ledgerRelPath, args));
}

// A ledger larger than this is read and parsed whole on every repeat check, and nothing about it is kept.
const MAX_REPEAT_LEDGER_BYTES = 256 * 1024;

/**
 * The ledger's events by id, kept for the repeat check while the ledger is small enough (MAX_REPEAT_LEDGER_BYTES). The
 * first `length` bytes of the ledger, whose SHA-256 is `digest`, are the bytes `events` was parsed from.
 */
interface RepeatIndex {
  file: string;
  length: number;
  digest: string;
  events: Map<string, LedgerEvent>;
}
let repeatIndex: RepeatIndex | undefined;

const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

/** Keeps `events` as the index of the ledger's bytes, when a later append can be parsed on its own (the bytes end in a line break). */
function keepRepeatIndex(file: string, content: Buffer, events: Map<string, LedgerEvent>): void {
  const endsInLine = content.byteLength === 0 || content[content.byteLength - 1] === 0x0a;
  repeatIndex = endsInLine ? { file, length: content.byteLength, digest: sha256(content), events } : undefined;
}

/**
 * The first event with this id, as parseLedgerEvents over the whole ledger would give it. When the ledger still starts with
 * the bytes it was parsed from, a write has only appended whole events since, so only those are parsed. Any other change,
 * and any error in the appended part, parses the whole ledger, which raises what it always raised.
 */
function ledgerEventNamed(file: string, content: Buffer, id: string): LedgerEvent | undefined {
  if (content.byteLength > MAX_REPEAT_LEDGER_BYTES) {
    repeatIndex = undefined;
    return parseLedgerEvents(content.toString('utf8')).find(e => e.id === id);
  }
  const held = repeatIndex;
  if (held && held.file === file && held.length <= content.byteLength && sha256(content.subarray(0, held.length)) === held.digest) {
    if (held.length === content.byteLength) return held.events.get(id);
    const appended = content.subarray(held.length).toString('utf8');
    // The appended part must hold an event header, and must not open with a field line, which would belong to the last
    // event already held. Then it parses exactly as it would at the end of the whole ledger.
    if (/^## mem_/im.test(appended) && !appended.startsWith('- ')) {
      try {
        const events = held.events;
        for (const e of parseLedgerEvents(appended)) if (!events.has(e.id)) events.set(e.id, e);
        keepRepeatIndex(file, content, events);
        return events.get(id);
      } catch {
        // Parsed whole below, so the error is the one the whole ledger gives.
      }
    }
  }
  const events = new Map<string, LedgerEvent>();
  for (const e of parseLedgerEvents(content.toString('utf8'))) if (!events.has(e.id)) events.set(e.id, e);
  keepRepeatIndex(file, content, events);
  return events.get(id);
}

/**
 * Does this write repeat the event behind the current fact, in everything the caller supplied?
 *
 * A caller that supplies the user's words must repeat them exactly as the current event holds them:
 * the same statement, and the subject spelled the same. The entity lookup that found the current fact
 * folds case and Unicode form, so on its own it would take `exactsubject` for a repeat of
 * `ExactSubject` and the new spelling would never reach the ledger. A different sentence or spelling
 * for the same value is still the user's own input, so it is written as a new event.
 *
 * A write without a statement (save_memory) has no words to keep and dedupes on the value alone.
 * When the event cannot be read (a legacy fact written without one, an absent ledger) nothing can be
 * confirmed, so the write goes ahead rather than assuming it is a repeat.
 */
async function repeatsCurrentEvent(
  vaultPath: string, ledgerRelPath: string, eventId: string | null, args: { subject: string; statement?: string },
): Promise<boolean> {
  if (args.statement === undefined) return true;
  if (!eventId) return false;
  const file = resolveLedgerPath(vaultPath, ledgerRelPath);
  let content: Buffer;
  try {
    content = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw err;
  }
  // Always read first: the bytes say whether the events held from the last check are still the ledger's.
  const event = ledgerEventNamed(file, content, eventId.toUpperCase());
  return event !== undefined && event.subject === args.subject && event.statement === args.statement;
}

/**
 * RENOR_SECRET_GUARD (default ON): refuse a write whose text looks like a secret, before the ledger or the
 * index is touched. The subject, predicate and object are scanned as one line, "subject predicate: object",
 * because a credential is usually stated across them (predicate wifi_password, object the password) and
 * neither field carries the cue on its own.
 */
async function refuseSecrets(
  args: { subject: string; predicate: string; object: string; source?: string; statement?: string },
  contentModel: DecisionModel | null = null,
): Promise<void> {
  try {
    await assertStorable([
      { field: 'statement', text: args.statement },
      { field: 'subject, predicate and object', text: `${args.subject} ${args.predicate}: ${args.object}` },
      { field: 'source', text: args.source, nameOnly: true },
    ], 'save', contentModel);
  } catch (err) {
    // A refusal is the caller's input, like every rejection above it, so it leaves as a LifecycleInputError (4xx).
    // A guard that could not decide is not: it stays the plain Error it is.
    if (err instanceof SecretRefusedError && err.reason !== 'unavailable') throw new LifecycleInputError(err.field, err.message);
    throw err;
  }
}

async function rememberCritical(db: Database.Database, vaultPath: string, ledgerRelPath: string, sent: {
  subject: string; predicate: string; object: string; source?: string; scope?: string; statement?: string; writer?: string;
  expectCurrentEvent?: string | null;
  expectLiveEvents?: string[];
}): Promise<MemoryReceipt> {
  // What is stored is the source's name, not what was sent (sourceName.ts): a path or a URL is cut down to what it ends in,
  // a long name is cut and control characters are dropped, before anything is judged, so the checks below and the secret
  // guard see the form that is stored and neither a long path nor a stray newline loses the whole save. A source with no
  // name left in it (blank, or only separators or controls) is stored as the default, like one that was not sent. A source
  // that is not a string is left for validateField. The import prefix is an import's alone (savedSource).
  const args = typeof sent.source === 'string' ? { ...sent, source: savedSource(sent.source) } : sent;
  validateLifecycleInput(args);
  refuseUnstorableFields(args);
  // Only a save sends text to the opted-in workspace's second opinion (jevDecisionModel.ts); a restore re-checks text already stored.
  if (secretGuardEnabled()) await refuseSecrets(args, saveDecisionModel());
  const at = new Date().toISOString();
  const scope = normalizeScope(args.scope);
  // The source the event stores, and the writer the save is recorded under: the authenticated identity when the caller
  // passed one, else the source itself. The event names the writer only where it differs from the source.
  const source = args.source || 'agent';
  const writer = args.writer ?? source;

  // Current-value decision is made against the lifecycle-owned entity only,
  // so a same-named disposable note entity can never influence or inherit it.
  // Strict identity: a legacy split whose open currents disagree fails closed HERE,
  // before the ledger append below, so the canonical bytes stay untouched.
  const entityId = resolveLifecycleEntity(db, args.subject, at, false, { strict: true });
  // The current value of the scope's stream, whatever spelling of the scope it was saved with (streamCurrentFacts).
  const currents = entityId ? streamCurrentFacts(db, entityId, args.predicate, scope) : [];
  if (args.expectCurrentEvent !== undefined) {
    const held = currents.find(c => c.scope === scope) ?? currents[0];
    if ((held?.event_id ?? null) !== args.expectCurrentEvent) throw new StaleExpectationError(args.expectCurrentEvent, held?.event_id ?? null);
  }
  // Every other event the caller relied on must still be a live, current fact: one retired, erased or replaced while
  // the caller was deciding is gone from `facts` or closed, and its value must not be copied.
  for (const eventId of args.expectLiveEvents ?? []) {
    const live = prepareOnce(db, 'SELECT 1 FROM facts WHERE event_id = ? AND valid_to IS NULL').get(eventId);
    if (!live) throw new StaleExpectationError(eventId, null);
  }

  // nochange only when nothing the caller said is new: the scope holds this value and no other AND, when they
  // supply the user's words, the same subject spelling and statement as the current event (see repeatsCurrentEvent).
  // A writer that owes a confirmation (its value was replaced) is recorded even when it repeats the current value: that
  // save is the confirmation, and only the ledger keeps it.
  if (currents.length > 0 && currents.every(c => c.object_text === args.object)
      && !(currents[0].event_id !== null && hasOpenDisplacementBy(db, currents[0].event_id, writer))
      && await repeatsCurrentEvent(vaultPath, ledgerRelPath, currents[0].event_id, args)) {
    return { ok: true, eventId: 'none', action: 'nochange', subject: args.subject, predicate: args.predicate, closed: null,
      created: { factId: currents[0].id, object: args.object, validFrom: 'existing' }, ledger: resolveLedgerPath(vaultPath, ledgerRelPath) };
  }

  // What the write closes, as applyEvent closes it: the current value saved under the write's own spelling, and the
  // one saved under the other spelling of the slug, which the event names in closed_event (a value with no event,
  // written before the ledger, cannot be named: it stays current beside the new one, and a read names the conflict).
  // A retired value keeps its place in the stream, so the write closes the retired current of either spelling too; only
  // the one under the OTHER spelling is named in closed_event, because reconcileStreamCurrent closes the own-spelling
  // one by order but cannot close a cross-spelling one without the name. The own-spelling retired value stays unnamed
  // (the write is a 'store' when no live value was replaced), exactly as it was before scopes became one slug.
  const own = currents.find(c => c.scope === scope);
  const across = currents.find(c => c.scope !== scope && c.event_id != null);
  const hiddens = entityId ? streamOpenRetiredFacts(db, entityId, args.predicate, scope) : [];
  const named = across ?? hiddens.find(h => h.scope !== scope) ?? own;

  // Pre-publish monotonicity validation (Kimi K11): the SAME rule the replay
  // enforces, but checked BEFORE the ledger append. Without this, a transient
  // backward clock step (NTP correction, manual clock change) made the live
  // write throw AFTER the append — leaving the self-rejected event in the
  // ledger and poisoning every future replay/rebuild/startup with the
  // identical error. A write that would be rejected must never reach the
  // ledger: the canonical bytes stay byte-identical on rejection.
  // A retired value that was current under the write's spelling is closed by it too (applyEvent), by the same rule,
  // and the stream is the scope's slug, so the retired current of either spelling is checked (streamOpenRetiredFacts).
  // The refusal lasts while the clock stays behind the newest of them, so it names that instant: the wait the user has.
  const behind = [own, across, ...hiddens].filter((c) => c !== undefined && at < c.valid_from);
  if (behind.length > 0) {
    const wait = behind.reduce((latest, c) => (c!.valid_from > latest!.valid_from ? c : latest))!;
    throw new Error(`lifecycle write rejected without publishing: event time ${at} is older than the current fact (valid_from ${wait.valid_from}, fact id ${wait.id}) for the same subject+predicate. Writes are accepted again once the clock reaches ${wait.valid_from}. The ledger was not modified`);
  }

  const id = newEventId();
  const kind = named ? 'supersede' : 'store';
  const ev: LedgerEvent = {
    id, at, kind,
    subject: args.subject, predicate: args.predicate, object: args.object,
    closedEvent: named?.event_id ?? null,
    source,
    scope,
    ...(args.statement !== undefined ? { statement: args.statement } : {}),
    ...(writer !== source ? { writer } : {}),
  };
  // Durable first: if the SQLite apply fails, the event is still in the ledger
  // and the next replay repairs the index. The apply itself is one transaction,
  // so it either fully lands or leaves no partial supersession behind.
  const ledger = await appendLedgerEvent(vaultPath, ledgerRelPath, ev);
  const { factId } = applyEvent(db, ev);
  return {
    ok: true, eventId: id, action: kind, subject: args.subject, predicate: args.predicate,
    closed: named ? { factId: named.id, object: named.object_text, validTo: at } : null,
    ...(across && own ? { alsoClosed: { factId: own.id, object: own.object_text, validTo: at } } : {}),
    created: { factId, object: args.object, validFrom: at }, ledger,
  };
}

/** One event as the ledger stores it: what an append writes, and what an erasure's rewrite writes for every event it keeps. */
function ledgerEventBlock(ev: LedgerEvent): string {
  const lines = [`\n## ${ev.id} · ${ev.at}`, `- kind: ${ev.kind}`];
  if (ev.kind === ERASE_KIND) {
    const closing = ev.closes !== undefined ? [`- closes: ${ev.closes.join(', ')}`, `- closed_at: ${ev.closedAt}`] : [];
    return [...lines, `- original_digest: ${ev.originalDigest}`, ...closing, '- source: erased', ''].join('\n');
  }
  lines.push(`- subject: ${ev.subject}`, `- predicate: ${ev.predicate}`);
  if (ev.target !== undefined) lines.push(`- target: ${ev.target}`); else lines.push(`- object: ${ev.object}`);
  if (ev.closedEvent) lines.push(`- closed_event: ${ev.closedEvent}`);
  const scope = normalizeScope(ev.scope);
  if (scope !== 'global') lines.push(`- scope: ${scope}`);
  if (ev.statement !== undefined) lines.push(`- statement: ${encodeStatement(ev.statement)}`);
  if (ev.writer !== undefined) lines.push(`- writer: ${ev.writer}`);
  lines.push(`- source: ${ev.source}`, '');
  return lines.join('\n');
}

export interface FactErasureReceipt { ok: true; action: 'deleted'; ids: string[]; freedBytes: 0; at: string }

/** Atomically replace a retired fact and its retire/restore events with one content-free, digest-bearing tombstone. */
export async function eraseRetiredFact(
  db: Database.Database, vaultPath: string, ledgerRelPath: string, id: string,
  vectorIndex: IndexOptions['vectorIndex'] | undefined,
): Promise<FactErasureReceipt> {
  return serializeLifecycleWrite(async () => {
    const target = factEventId(id);
    if (target === null) throw new LifecycleInputError('id', 'a live memory is retired first; pass a retired fact id', 'invalid_argument');
    const row = db.prepare(`SELECT r.subject_entity_id FROM retired_facts r WHERE r.event_id = ?`).get(target) as
      { subject_entity_id: number } | undefined;
    const erased = db.prepare('SELECT original_digest, erased_at, closes FROM erased_facts WHERE event_id = ?').get(target) as
      { original_digest: string; erased_at: string; closes: string | null } | undefined;
    if (!row && !erased) {
      if (db.prepare('SELECT 1 FROM facts WHERE event_id = ?').get(target)) throw new LifecycleInputError('id', 'that fact is still live; retire it before deleting it permanently', 'invalid_argument');
      throw new LifecycleInputError('id', 'no retired fact has that id', 'memory_not_found');
    }
    const file = resolveLedgerPath(vaultPath, ledgerRelPath);
    const rel = path.relative(path.resolve(vaultPath), file);
    // The append lock keeps every ledger writer out; the per-file lock the indexer holds for a whole pass (indexFile) keeps
    // out an index pass that read the ledger before this rewrite and would otherwise commit its chunks after the derived
    // note is dropped below, putting the erased text back into search. Always in this order: the indexer takes no append lock.
    return withAppendLock(file, () => withDailyFileLock(file, async () => {
      const events = parseLedgerEvents(await fs.readFile(file, 'utf8'));
      const original = events.find(ev => ev.id === target);
      if (original?.kind === ERASE_KIND || (!original && erased)) {
        // The ledger already holds the tombstone (a retry, or a crash after the rename): settle the projection and the audit.
        const at = original?.at ?? erased!.erased_at;
        const ledgerChunkIds = ledgerChunks(db, file, rel);
        db.transaction(() => {
          db.prepare('DELETE FROM notes WHERE path IN (?, ?)').run(file, rel);
          if (original) applyEvent(db, original);
          const audit = db.prepare(`SELECT 1 FROM write_events WHERE note_path = '_retired_' AND action = 'delete' AND summary = 'deleted permanently: 1 fact' AND created_at = ?`).get(at);
          if (!audit) db.prepare(`INSERT INTO write_events (note_path, action, summary, created_at) VALUES ('_retired_', 'delete', 'deleted permanently: 1 fact', ?)`).run(at);
        })();
        for (const chunkId of ledgerChunkIds) vectorIndex?.delete(chunkId);
        return { ok: true, action: 'deleted', ids: [`fact:${target}`], freedBytes: 0, at };
      }
      if (!original || RETIREMENT_KINDS.has(original.kind)) throw new Error(`ledger corruption: retired fact ${target} has no content-bearing event`);
      // The index says the fact was erased, yet the ledger still holds it: the rename was lost (a power loss after the index
      // committed, before the directory reached the disk). Redo the rewrite with the erasure's own digest and time.
      if (erased && eventDigest(original) !== erased.original_digest) {
        throw new Error(`ledger corruption: erased fact ${target} is back in the ledger with a different payload`);
      }
      const at = erased?.erased_at ?? new Date().toISOString();
      const subjectEntityId = row?.subject_entity_id ?? resolveLifecycleEntity(db, original.subject, original.at, false);
      // A redo after a lost rename reuses the link the first erasure recorded: a restart in between replays the old ledger
      // without the erased fact and may have reopened what it closed, so the facts tables alone no longer show it.
      const closes = [...new Set([...(erased?.closes ? erased.closes.split(',') : []), ...factsClosedBy(db, original, subjectEntityId)])].sort();
      const tombstone: LedgerEvent = {
        id: target, at, kind: ERASE_KIND, subject: '', predicate: '', object: '', closedEvent: null, source: 'erased',
        originalDigest: eventDigest(original),
        ...(closes.length > 0 ? { closes, closedAt: original.at } : {}),
      };
      const kept = events.filter(ev => !(RETIREMENT_KINDS.has(ev.kind) && ev.target?.toUpperCase() === target)).map(ev => ev.id === target ? tombstone : ev);
      // Activity is derived, so scrub it before the canonical commit. A crash here still has the complete retired fact
      // in its ledger/table; replay does not depend on activity rows. Nothing content-bearing remains after the rename.
      const erasedEvents = events.filter(ev => ev.id === target || (RETIREMENT_KINDS.has(ev.kind) && ev.target?.toUpperCase() === target));
      const activityRows = db.prepare(`SELECT id, summary FROM write_events
        WHERE note_path = '_memory_ledger_' AND action = ? AND created_at = ?
          AND (author IS NULL OR author = ?) AND (scope IS NULL OR scope = ?)`);
      const deleteActivity = db.prepare('DELETE FROM write_events WHERE id = ?');
      db.transaction(() => {
        for (const ev of erasedEvents) {
          const expected = ev.target !== undefined
            ? JSON.stringify({ id: `fact:${ev.target.toUpperCase()}`, title: `${ev.subject} ${ev.predicate}` })
            : `${ev.subject} ${ev.predicate} → ${ev.object}`;
          const rows = activityRows.all(ev.kind, ev.at, ev.source, ev.scope ?? 'global') as Array<{ id: number; summary: string }>;
          for (const activity of rows) {
            // The erased event's own line, or that line with the facts it closed: never another line of the same length.
            const suffix = activity.summary.slice(expected.length);
            const isWriterSummary = activity.summary === expected
              || (activity.summary.startsWith(expected) && /^ \(closed facts? [0-9]+(?:, [0-9]+)*\)$/.test(suffix));
            if (isWriterSummary) deleteActivity.run(activity.id);
          }
        }
      })();
      const tmp = await createConfined(vaultPath, `${rel}.erase-${crypto.randomUUID()}.tmp`, Buffer.from(LEDGER_HEADER + kept.map(ledgerEventBlock).join(''), 'utf8'));
      try { await fs.rename(tmp, file); } catch (err) { await fs.rm(tmp, { force: true }); throw err; }
      // The rename is the commit point, so it reaches the disk before the index records the erasure as done: otherwise a power
      // loss could leave the old ledger, with the erased content, under an index that says it is gone.
      await syncDirectory(path.dirname(file));
      const ledgerChunkIds = ledgerChunks(db, file, rel);
      db.transaction(() => {
        // The Markdown index may have chunked the old ledger bytes. Drop that derived note atomically; the watcher may
        // index the content-free tombstone later, but no read can serve a stale subject/value chunk meanwhile.
        db.prepare('DELETE FROM notes WHERE path IN (?, ?)').run(file, rel);
        applyEvent(db, tombstone);
        const audit = db.prepare(`SELECT 1 FROM write_events WHERE note_path = '_retired_' AND action = 'delete' AND summary = 'deleted permanently: 1 fact' AND created_at = ?`).get(at);
        if (!audit) db.prepare(`INSERT INTO write_events (note_path, action, summary, created_at) VALUES ('_retired_', 'delete', 'deleted permanently: 1 fact', ?)`).run(at);
      })();
      for (const chunkId of ledgerChunkIds) vectorIndex?.delete(chunkId);
      return { ok: true, action: 'deleted', ids: [`fact:${target}`], freedBytes: 0, at };
    }));
  });
}

/**
 * The fact events `ev` closed when it was saved, read from the index: the ones on its subject, predicate and scope whose value
 * ended at its own time, and the one its closed_event names. Ids only; they go in its erasure tombstone.
 */
function factsClosedBy(db: Database.Database, ev: LedgerEvent, subjectEntityId: number | null): string[] {
  const query = (table: string) => `SELECT event_id FROM ${table} WHERE event_id IS NOT NULL AND event_id <> ? AND valid_to = ?
    AND ((subject_entity_id = ? AND predicate = ? AND scope = ?) OR event_id = ?)`;
  const args = [ev.id, ev.at, subjectEntityId ?? -1, ev.predicate, normalizeScope(ev.scope), ev.closedEvent?.toUpperCase() ?? ''];
  const ids = new Set<string>();
  for (const table of ['facts', 'retired_facts']) {
    for (const closed of db.prepare(query(table)).pluck().all(...args) as string[]) ids.add(closed.toUpperCase());
  }
  return [...ids].sort();
}

function ledgerChunks(db: Database.Database, absolute: string, relative: string): number[] {
  return (db.prepare('SELECT id FROM chunks WHERE note_path IN (?, ?)').all(absolute, relative) as Array<{ id: number }>).map(chunk => chunk.id);
}

/** What retire_memory and restore_memory answer for a fact (memorymap/memoryMap.ts gives the same shape for notes). */
export interface FactRetirementReceipt {
  ok: true;
  /** The fact's id: `fact:` and the event that saved it. */
  id: string;
  action: 'retired' | 'restored';
  title: string;
  at: string;
  /** The ledger event that recorded this retire or restore. */
  eventId: string;
  /** Whether the fact is (retire: was) its predicate's current value. */
  current: boolean;
}

const FACT_ID_RE = /^fact:(mem_[A-Za-z0-9]+)$/i;

/** The event id in a fact id (`fact:MEM_…`), or null for any other memory id. */
export function factEventId(id: string): string | null {
  return FACT_ID_RE.exec(id)?.[1].toUpperCase() ?? null;
}

function factTitle(subject: string, predicate: string, object: string): string {
  return `${subject} ${predicate}: ${object}`;
}

/**
 * Takes one saved fact out of recall, reversibly: a retire event goes into the ledger (who asked, when, and which fact),
 * then the fact's row leaves `facts` (moveFactOut). The ledger keeps the fact's own event, so its history is never lost
 * and restoreFact brings it back. Retiring the current value revives only the directly replaced value when its object is
 * identical (a differently worded restatement); a genuinely different replaced value stays historical.
 */
export async function retireFact(db: Database.Database, vaultPath: string, ledgerRelPath: string, id: string, source?: string): Promise<FactRetirementReceipt> {
  return serializeLifecycleWrite(async () => {
    const target = factEventId(id);
    if (target === null) throw new LifecycleInputError('id', `not a fact id: ${JSON.stringify(id)} (a fact's id is fact: and its eventId)`, 'invalid_argument');
    const row = prepareOnce(db, 
      `SELECT f.predicate, f.object_text, f.valid_to, f.scope, e.canonical_name AS subject, e.source_note
         FROM facts f JOIN entities e ON e.id = f.subject_entity_id
        WHERE f.event_id = ? AND f.source_path = ?`
    ).get(target, LIFECYCLE_NOTE_PATH) as { predicate: string; object_text: string; valid_to: string | null; scope: string; subject: string; source_note: string } | undefined;
    if (!row) {
      if (prepareOnce(db, 'SELECT 1 FROM retired_facts WHERE event_id = ?').get(target)) {
        throw new LifecycleInputError('id', 'that fact is already retired (restore_memory brings it back)', 'memory_already_retired');
      }
      throw new LifecycleInputError('id', 'no saved fact has that id', 'memory_not_found');
    }
    // A startup replay moves every lifecycle fact onto its lifecycle subject, so this only refuses a fact that has not been.
    if (row.source_note !== LIFECYCLE_NOTE_PATH) throw new Error(`fact ${target} is not attached to its lifecycle subject yet; restart the engine to replay the ledger first`);
    const ev: LedgerEvent = {
      id: newEventId(), at: new Date().toISOString(), kind: 'retire',
      subject: row.subject, predicate: row.predicate, object: '', closedEvent: null,
      source: (source === undefined ? '' : savedSource(source)) || 'agent', scope: row.scope, target,
    };
    await appendLedgerEvent(vaultPath, ledgerRelPath, ev);
    applyEvent(db, ev);
    return { ok: true, id: `fact:${target}`, action: 'retired', title: factTitle(row.subject, row.predicate, row.object_text), at: ev.at, eventId: ev.id, current: row.valid_to === null };
  });
}

/**
 * Brings a retired fact back exactly as it was: the same row, value and dates. It is the current value again unless a
 * value saved for the same subject, predicate and scope after it replaced it, as that save would have replaced it had it
 * never been retired; it is then history. RENOR_SECRET_GUARD (default ON) screens it as a save.
 */
export async function restoreFact(
  db: Database.Database, vaultPath: string, ledgerRelPath: string, id: string, source?: string,
  validateAfterWrite?: () => void | Promise<void>,
): Promise<FactRetirementReceipt> {
  return serializeLifecycleWrite(async () => {
    const target = factEventId(id);
    if (target === null) throw new LifecycleInputError('id', `not a fact id: ${JSON.stringify(id)} (a fact's id is fact: and its eventId)`, 'invalid_argument');
    if (prepareOnce(db, 'SELECT 1 FROM erased_facts WHERE event_id = ?').get(target)) {
      throw new LifecycleInputError('id', 'that fact was permanently erased and cannot be restored', 'memory_not_found');
    }
    const row = prepareOnce(db, 
      `SELECT r.predicate, r.object_text, r.scope, e.canonical_name AS subject
         FROM retired_facts r JOIN entities e ON e.id = r.subject_entity_id WHERE r.event_id = ?`
    ).get(target) as { predicate: string; object_text: string; scope: string; subject: string } | undefined;
    if (!row) {
      if (prepareOnce(db, 'SELECT 1 FROM facts WHERE event_id = ?').get(target)) throw new LifecycleInputError('id', 'that fact is not retired', 'memory_not_found');
      throw new LifecycleInputError('id', 'no retired fact has that id', 'memory_not_found');
    }
    if (secretGuardEnabled()) await refuseSecrets({ subject: row.subject, predicate: row.predicate, object: row.object_text });
    const ev: LedgerEvent = {
      id: newEventId(), at: new Date().toISOString(), kind: 'restore',
      subject: row.subject, predicate: row.predicate, object: '', closedEvent: null,
      source: (source === undefined ? '' : savedSource(source)) || 'agent', scope: row.scope, target,
    };
    const ledgerPath = resolveLedgerPath(vaultPath, ledgerRelPath);
    const priorBytes = await fs.stat(ledgerPath).then((stat) => stat.size, () => 0);
    await appendLedgerEvent(vaultPath, ledgerRelPath, ev);
    db.exec('SAVEPOINT restore_storage_limit');
    try {
      applyEvent(db, ev);
      await validateAfterWrite?.();
      db.exec('RELEASE SAVEPOINT restore_storage_limit');
    } catch (err) {
      db.exec('ROLLBACK TO SAVEPOINT restore_storage_limit; RELEASE SAVEPOINT restore_storage_limit');
      await fs.truncate(ledgerPath, priorBytes);
      throw err;
    }
    const back = prepareOnce(db, 'SELECT valid_to FROM facts WHERE event_id = ?').get(target) as { valid_to: string | null };
    return { ok: true, id: `fact:${target}`, action: 'restored', title: factTitle(row.subject, row.predicate, row.object_text), at: ev.at, eventId: ev.id, current: back.valid_to === null };
  });
}

/** A retired fact as memory_map lists it: its value, and when and by whom it was retired. */
export interface RetiredFact {
  id: string;
  eventId: string;
  subject: string;
  predicate: string;
  object: string;
  scope: string;
  title: string;
  validFrom: string;
  retiredAt: string;
  retiredBy: string;
}

/** Every retired fact, newest retirement first. */
export function listRetiredFacts(db: Database.Database): RetiredFact[] {
  const rows = prepareOnce(db, 
    `SELECT r.event_id, e.canonical_name AS subject, r.predicate, r.object_text, r.scope, r.valid_from, r.retired_at, r.retired_by
       FROM retired_facts r JOIN entities e ON e.id = r.subject_entity_id
      ORDER BY r.retired_at DESC, r.id DESC`
  ).all() as Array<{ event_id: string; subject: string; predicate: string; object_text: string; scope: string; valid_from: string; retired_at: string; retired_by: string }>;
  return rows.map(r => ({
    id: `fact:${r.event_id}`, eventId: r.event_id, subject: r.subject, predicate: r.predicate, object: r.object_text,
    scope: r.scope, title: factTitle(r.subject, r.predicate, r.object_text), validFrom: r.valid_from,
    retiredAt: r.retired_at, retiredBy: r.retired_by,
  }));
}

/**
 * The one scope a read is restricted to: the explicit scope, normalized (an empty one means global), or
 * null for every scope. Every read path derives its filter here, so none can answer for a wider scope than
 * it was asked about.
 */
export function scopeFilterFor(scope: string | undefined): NormalizedScope | null {
  return scope !== undefined ? normalizeScope(scope) : null;
}

/**
 * Names of the subjects that lifecycle facts are about (current or superseded), alphabetical. Given a scope,
 * only subjects that have a fact in that scope (any spelling of it, savedScopeSqlPredicate): a scoped read must
 * not learn of subjects that live elsewhere.
 */
export function listLifecycleSubjects(db: Database.Database, opts: { scope?: string } = {}): string[] {
  const scope = scopeFilterFor(opts.scope);
  const inScope = scope === null ? null : savedScopeSqlPredicate(scope, 'f.scope');
  const rows = prepareOnce(db, 
    `SELECT DISTINCT e.canonical_name AS name FROM entities e
      WHERE e.source_note = ?
        AND EXISTS (SELECT 1 FROM facts f WHERE f.subject_entity_id = e.id${inScope ? ` AND ${inScope.sql}` : ''})
      ORDER BY e.canonical_name COLLATE NOCASE`
  ).all(LIFECYCLE_NOTE_PATH, ...(inScope?.params ?? [])) as Array<{ name: string }>;
  return rows.map(r => r.name);
}

// A partial or path match on a lifecycle row names another subject: only the identity match in factsFor may name one.
const NOT_LIFECYCLE_ENTITY: EntityRowFilter = { sql: 'entities.source_note IS NOT ?', params: [LIFECYCLE_NOTE_PATH] };

/**
 * The newest workspace observation in the scope being read. Lifecycle writes keep their stamps in facts and
 * retired_facts; note indexing keeps its clock in note_index_clock, independently of rows that reindexing or
 * retirement can delete. Their maximum survives retire/restore and backward-clock reindexing, including a
 * workspace with no lifecycle writes. Index observations are not content dates: a future-dated note still keeps
 * its valid_from/valid_to window. The migration seeds existing indexes from the indexer's updated_at stamps.
 * Read once until the next database write, including a write by another connection (readUntilWrite).
 */
function workspaceReadInstant(db: Database.Database, scope: NormalizedScope | null): string | null {
  const cacheKey = `workspace-read-instant${scope === null ? '' : `:${scope}`}`;
  return readUntilWrite(db, cacheKey, () => {
    const inScope = scope === null ? null : savedScopeSqlPredicate(scope, 'scope');
    // Each observation source carries its own scope predicate and parameter spellings.
    const scopeSql = inScope ? ` AND ${inScope.sql}` : '';
    const scopeParams = inScope ? inScope.params : [];
    return (prepareOnce(db, 
      `SELECT MAX(newest) AS newest FROM (`
      + ` SELECT valid_from AS newest FROM facts WHERE source_path = ?${scopeSql}`
      + ` UNION ALL`
      + ` SELECT valid_from AS newest FROM retired_facts${inScope ? ` WHERE ${inScope.sql}` : ''}`
      + ` UNION ALL`
      + ` SELECT observed_at AS newest FROM note_index_clock${inScope ? ` WHERE ${inScope.sql}` : ''}`
      + `)`
    ).get(LIFECYCLE_NOTE_PATH, ...scopeParams, ...scopeParams, ...scopeParams) as { newest: string | null } | undefined)?.newest ?? null;
  });
}

/**
 * The instant a note-derived fact is judged at by the default read: the wall clock, or the newest workspace observation
 * when that is newer. The workspace has already observed that instant, so the read judges the content-date window
 * at the observation rather than losing the note to a regressed machine clock (workspaceReadInstant).
 */
function noteReadInstant(db: Database.Database, scope: NormalizedScope | null): string {
  const at = new Date().toISOString();
  const newest = workspaceReadInstant(db, scope);
  return newest !== null && newest > at ? newest : at;
}

/**
 * The default read's currency rule, keyed on the row's origin. A lifecycle fact
 * (source_path '_mcp_') is current exactly when it is open — the same rule the
 * write path uses (streamCurrentFacts), so reads and writes agree after a
 * backward clock step. A note-derived fact keeps its content-date window: a
 * date in the future still means "not yet", but the window is bounded below by
 * the newest workspace observation (workspaceReadInstant), so a machine clock that
 * stepped backwards cannot hide a note the vault already holds.
 * Two `?` parameters, the read instant, are the note-derived window bounds.
 */
const DEFAULT_CURRENT_SQL =
  `((source_path = '${LIFECYCLE_NOTE_PATH}' AND valid_to IS NULL)`
  + ` OR ((source_path IS NULL OR source_path <> '${LIFECYCLE_NOTE_PATH}')`
  + ` AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)))`;

/**
 * Current facts only by default; asOf gives point-in-time; includeHistory gives
 * everything. The default read judges a lifecycle fact by open rows (see
 * DEFAULT_CURRENT_SQL), so a backward clock step cannot hide the current value;
 * a note-derived fact is judged at the wall clock clamped up to the newest
 * workspace observation (workspaceReadInstant), so the same step cannot hide it
 * either; asOf keeps the exact point-in-time window. Lifecycle-owned facts are
 * authoritative: if a lifecycle entity exists for the name, its facts are
 * returned; otherwise the generic (possibly note-derived) entity lookup is used.
 *
 * When a name still matches SEVERAL lifecycle entities (a split a pre-fix write path
 * could create, which nothing reconciles in place), facts from ALL of them are
 * returned. A read must not throw — a startup or dashboard read would become an outage
 * — and it must not hide half the memory behind a silent pick, so the ambiguity is
 * disclosed instead. New writes refuse the same state (LegacyIdentityAmbiguityError).
 */
/** A `facts` table row as `SELECT *` returns it (columns: db/migrations.ts); factsFor selects by subject, so it has one. */
export interface StoredFactRow {
  id: number; subject_entity_id: number; predicate: string; object_text: string | null; object_entity_id: number | null;
  source_path: string; source_chunk_id: number | null; confidence: number; valid_from: string; valid_to: string | null;
  updated_at: string; event_id: string | null; scope: string; author: string | null; statement_words: string | null;
}

export function factsFor(db: Database.Database, entityName: string, opts: { asOf?: string; includeHistory?: boolean; scope?: string } = {}): StoredFactRow[] {
  let entityIds: number[] = [];
  for (const alias of identityNames(entityName)) {
    entityIds = lifecycleEntityMatches(db, alias).map(match => match.id);
    if (entityIds.length > 0) break;
  }
  if (entityIds.length === 0) {
    const entity = lookupEntity(db, entityName, NOT_LIFECYCLE_ENTITY);
    if (!entity) return [];
    entityIds = [entity.id];
  }
  const placeholders = entityIds.map(() => '?').join(',');
  // Without scope: return across all scopes (current MVP read behavior).
  // With scope: filter to that normalized scope, under any spelling of it (savedScopeSqlPredicate).
  const scopeFilter = scopeFilterFor(opts.scope);
  const inScope = scopeFilter ? savedScopeSqlPredicate(scopeFilter, 'scope') : null;
  if (opts.includeHistory) {
    if (inScope) {
      return db.prepare(`SELECT * FROM facts WHERE subject_entity_id IN (${placeholders}) AND ${inScope.sql} ORDER BY valid_from DESC, id DESC`).all(...entityIds, ...inScope.params) as StoredFactRow[];
    }
    return db.prepare(`SELECT * FROM facts WHERE subject_entity_id IN (${placeholders}) ORDER BY valid_from DESC, id DESC`).all(...entityIds) as StoredFactRow[];
  }
  // S1: asOf is an INSTANT. It is normalized to the canonical format so the
  // SQL textual comparison is exactly the instant comparison for every
  // supported input (including offsets); garbage fails with a clear error
  // instead of a silently wrong answer. An explicit point-in-time read keeps
  // the window unchanged: it asks what was true AT that instant, not what is
  // true now.
  if (opts.asOf !== undefined) {
    const t = toCanonicalInstant(opts.asOf);
    if (inScope) {
      return prepareOnce(db, 
        `SELECT * FROM facts WHERE subject_entity_id IN (${placeholders}) AND ${inScope.sql} AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from DESC, id DESC`
      ).all(...entityIds, ...inScope.params, t, t) as StoredFactRow[];
    }
    return prepareOnce(db, 
      `SELECT * FROM facts WHERE subject_entity_id IN (${placeholders}) AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from DESC, id DESC`
    ).all(...entityIds, t, t) as StoredFactRow[];
  }
  // The default read judges a lifecycle fact (source_path '_mcp_') the way the
  // write path does (streamCurrentFacts): current exactly when it is open, so a
  // backward clock step can never hide the value the user already gave — the
  // repeat-twice failure. Note-derived facts keep their content-date window — a
  // future date still means "not yet" — bounded below by the newest workspace
  // observation, so the same step cannot hide a note the vault already holds either.
  const readInstant = noteReadInstant(db, scopeFilter);
  if (inScope) {
    return prepareOnce(db, 
      `SELECT * FROM facts WHERE subject_entity_id IN (${placeholders}) AND ${inScope.sql} AND ${DEFAULT_CURRENT_SQL} ORDER BY valid_from DESC, id DESC`
    ).all(...entityIds, ...inScope.params, readInstant, readInstant) as StoredFactRow[];
  }
  return prepareOnce(db, 
    `SELECT * FROM facts WHERE subject_entity_id IN (${placeholders}) AND ${DEFAULT_CURRENT_SQL} ORDER BY valid_from DESC, id DESC`
  ).all(...entityIds, readInstant, readInstant) as StoredFactRow[];
}
