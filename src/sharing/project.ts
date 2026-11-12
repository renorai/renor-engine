import type { LearningExport, LearningLog, SessionSpan } from '../learning/store';
import { embeddingFamily, latencyBucket, releaseOf, senderContext, type SenderContext } from './context';
import type { ExampleReader } from './examples';
import {
  APP_FAMILIES, COUNT_BUCKETS, DELAY_BUCKETS, LENGTH_BUCKETS, RETRIEVAL_TOOL_NAMES, SAVE_TOOL_NAMES, TOOL_PROFILES, coarsenRow,
  installAgeBucket, type InstallAge, type SharingLevel,
} from './fields';

/**
 * The join, done inside the user's own folder: the learning log says what was served, saved, cited and retired; this turns
 * it into finished, labelled rows. Only these rows can ever leave. They carry no key, no memory id, no query and no text
 * (text only at `data`, from the example store), and every time is coarsened to the hour.
 *
 * A row is sent only once its label is final: the window (default 24 hours) after the event has closed. Until then the event
 * waits, and the sender's watermark says how far it has got.
 */

export const LABEL_WINDOW_MS = 24 * 3_600_000;

export type Table = Record<string, unknown>;
export type ProjectedKind = 'retrieval' | 'save' | 'session';
export interface ProjectedRow {
  kind: ProjectedKind;
  /** Newest log time (ms) the row is built from: the sender's watermark moves to it. Never sent. */
  at: number;
  row: Record<string, unknown>;
}

export interface ProjectOptions {
  level: Exclude<SharingLevel, 'off'>;
  now: number;
  windowMs?: number;
  /** Rows with `at` at or below these are already sent. */
  watermarks: { retrieval: number; save: number; session: number };
  examples?: ExampleReader | null;
  /** Where this install runs (context.ts senderContext), stamped on every row. Default: a self-hosted install, read from this process. */
  context?: SenderContext;
  /**
   * When this install was first seen (ms, the start of its UTC day, kept in the sharing state): each row carries how old the install was at the
   * row's hour, as one of four ranges. Unset (a test, or a caller with no state), rows say null.
   */
  firstSeen?: number;
}

function ageAt(options: Pick<ProjectOptions, 'firstSeen'>, at: number): InstallAge | null {
  return options.firstSeen === undefined ? null : installAgeBucket(options.firstSeen, at);
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asBool = (value: unknown): boolean | null => (value === 1 || value === true ? true : value === 0 || value === false ? false : null);

/** `2026-10-21T14`: the hour a row happened in, in UTC. */
export function hourOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

function delayBucket(ms: number): (typeof DELAY_BUCKETS)[number] {
  if (ms < 60_000) return '<1m';
  if (ms < 600_000) return '<10m';
  if (ms < 3_600_000) return '<1h';
  if (ms < 86_400_000) return '<1d';
  return '>=1d';
}

function lengthBucket(ms: number): (typeof LENGTH_BUCKETS)[number] {
  if (ms < 60_000) return '<1m';
  if (ms < 600_000) return '<10m';
  if (ms < 3_600_000) return '<1h';
  if (ms < 21_600_000) return '<6h';
  return '>=6h';
}

function countBucket(n: number): (typeof COUNT_BUCKETS)[number] {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 3) return '2-3';
  if (n <= 7) return '4-7';
  return '8+';
}

/** The smallest power of two at or above `tokens`: a size class, not a size. */
function tokenBucket(tokens: number | null): number | null {
  if (tokens === null || tokens < 0) return null;
  let bucket = 1;
  while (bucket < tokens) bucket *= 2;
  return bucket;
}


/** A recorded value kept only when it is one of `list`; anything else (an older log's null, a value no list holds) is null. */
const closed = <T extends string>(value: unknown, list: readonly T[]): T | null =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null;

/**
 * The fields every row carries about where it was made (fields.ts CONTEXT_FIELDS): the sender's own (deployment, internal, os, node) and
 * the call's, as the log recorded them (app, release, profile). Each is read back through its closed list, so a row can only carry a
 * listed value or null, whatever the log holds.
 */
function contextOf(sender: SenderContext, recorded: { app?: unknown; release?: unknown; profile?: unknown }): Record<string, unknown> {
  return {
    deployment: sender.deployment,
    internal: sender.internal,
    release: releaseOf(asString(recorded.release)),
    app: closed(recorded.app, APP_FAMILIES),
    profile: closed(recorded.profile, TOOL_PROFILES),
    os: sender.os,
    node: sender.node,
  };
}

/** How the call arrived (fields.ts VIA_NAMES): the log's actor `dashboard` is the dashboard, anything else came over MCP. */
const viaOf = (actor: unknown): 'mcp' | 'dashboard' => (actor === 'dashboard' ? 'dashboard' : 'mcp');

const senderOf = (options: ProjectOptions): SenderContext => options.context ?? senderContext(false);

interface Event {
  at: number;
  kind: 'retrieve' | 'cite' | 'supersede' | 'delete';
}

/** Events about a memory, by its key, in time order. */
function indexEvents(tables: LearningExport['tables']): { byMemory: Map<string, Event[]>; bySubject: Map<string, Event[]> } {
  const byMemory = new Map<string, Event[]>();
  const bySubject = new Map<string, Event[]>();
  const add = (map: Map<string, Event[]>, key: string | null, event: Event): void => {
    if (key === null) return;
    const list = map.get(key);
    if (list) list.push(event);
    else map.set(key, [event]);
  };
  for (const op of tables.memory_ops) {
    const at = asNumber(op.at);
    const kind = op.op;
    if (at === null) continue;
    const key = asString(op.memory_key);
    if (kind === 'retrieve') add(byMemory, key, { at, kind: 'retrieve' });
    else if (kind === 'delete') add(byMemory, key, { at, kind: 'delete' });
    else if (kind === 'supersede') {
      // A supersede changes the memory it replaces; it is also the save of the new value (its own key).
      add(byMemory, asString(op.replaced_key), { at, kind: 'supersede' });
      if (asString(op.replaced_key) !== key) add(byMemory, key, { at, kind: 'supersede' });
    }
  }
  for (const row of tables.feedback) {
    const at = asNumber(row.at);
    if (at === null) continue;
    add(byMemory, asString(row.memory_key), { at, kind: 'cite' });
    add(bySubject, asString(row.subject_key), { at, kind: 'cite' });
  }
  for (const list of [...byMemory.values(), ...bySubject.values()]) list.sort((a, b) => a.at - b.at);
  return { byMemory, bySubject };
}

interface Label {
  opened: boolean;
  cited: boolean;
  updated: boolean;
  retired: boolean;
  firstAt: number | null;
}

function labelOf(lists: Array<Event[] | undefined>, from: number, until: number, skipSupersedeAt: number | null = null): Label {
  const label: Label = { opened: false, cited: false, updated: false, retired: false, firstAt: null };
  for (const list of lists) {
    for (const event of list ?? []) {
      if (event.at <= from || event.at > until) continue;
      if (skipSupersedeAt !== null && event.kind === 'supersede' && event.at === skipSupersedeAt) continue;
      if (event.kind === 'retrieve') label.opened = true;
      else if (event.kind === 'cite') label.cited = true;
      else if (event.kind === 'supersede') label.updated = true;
      else label.retired = true;
      label.firstAt = label.firstAt === null ? event.at : Math.min(label.firstAt, event.at);
    }
  }
  return label;
}

/** A candidate the reply served (rank set). The log also keeps the ones the ranker scored and the reply did not serve: never shared. */
function servedRow(candidate: Table): boolean {
  return asNumber(candidate.rank) !== null;
}

function retrievalRows(log: LearningExport, options: ProjectOptions, windowMs: number): ProjectedRow[] {
  const { tables } = log;
  const events = indexEvents(tables);
  const cutoff = options.now - windowMs;
  const sender = senderOf(options);
  const candidatesBy = new Map<number, Table[]>();
  // The pool each read was cut from, when the export holds the unserved candidates too (exportLog); exportServedWindow counts it itself.
  const scoredBy = new Map<number, number>();
  for (const candidate of tables.candidates) {
    const id = asNumber(candidate.retrieval_id);
    if (id !== null) scoredBy.set(id, (scoredBy.get(id) ?? 0) + 1);
    if (id === null || !servedRow(candidate)) continue;
    const list = candidatesBy.get(id);
    if (list) list.push(candidate);
    else candidatesBy.set(id, [candidate]);
  }
  const rows: ProjectedRow[] = [];
  const retrievals = [...tables.retrievals].sort((a, b) => (asNumber(a.at) ?? 0) - (asNumber(b.at) ?? 0) || (asNumber(a.id) ?? 0) - (asNumber(b.id) ?? 0));
  for (const retrieval of retrievals) {
    const at = asNumber(retrieval.at);
    const id = asNumber(retrieval.id);
    const tool = asString(retrieval.tool);
    if (at === null || id === null || tool === null || !(RETRIEVAL_TOOL_NAMES as readonly string[]).includes(tool)) continue;
    if (at <= options.watermarks.retrieval || at > cutoff) continue;
    const queryKey = asString(retrieval.query_key);
    const candidates = (candidatesBy.get(id) ?? []).slice(0, 200).map(candidate => {
      const kind = asString(candidate.kind) ?? 'unkeyed';
      const memoryKey = asString(candidate.memory_key);
      const joinable = memoryKey !== null && kind !== 'unkeyed';
      const label = joinable
        ? labelOf(
          [events.byMemory.get(memoryKey), kind === 'fact' ? events.bySubject.get(asString(candidate.subject_key) ?? '') : undefined],
          at, at + windowMs)
        : null;
      const out: Record<string, unknown> = {
        rank: asNumber(candidate.rank) ?? 0,
        kind,
        lane: asString(candidate.reason),
        score: asNumber(candidate.score),
        matched: asBool(candidate.matched),
        current: asBool(candidate.current),
        opened: label === null ? null : label.opened,
        cited: label === null ? null : label.cited,
        updated: label === null ? null : label.updated,
        retired: label === null ? null : label.retired,
        delay_bucket: label === null || label.firstAt === null ? null : delayBucket(label.firstAt - at),
      };
      if (options.level === 'data') out.text = memoryKey === null ? null : options.examples?.memory(memoryKey) ?? null;
      return out;
    });
    const row: Record<string, unknown> = {
      kind: 'retrieval-labelled/1',
      hour: hourOf(at),
      install_age: ageAt(options, at),
      tool,
      ranker: asString(retrieval.ranker) ?? 'baseline',
      model: asString(retrieval.model),
      retrieval: asString(retrieval.retrieval),
      served: asNumber(retrieval.served) ?? candidates.length,
      reply_tokens_bucket: tokenBucket(asNumber(retrieval.reply_tokens)),
      relevant: asBool(retrieval.relevant),
      truncated: asBool(retrieval.truncated),
      ...contextOf(sender, retrieval),
      // Semantic search was on for this read when it recorded an embedding model; the family only, never the model's name.
      semantic: asString(retrieval.model) !== null,
      embedding: embeddingFamily(asString(retrieval.model)),
      via: viaOf(retrieval.actor),
      latency_bucket: latencyBucket(asNumber(retrieval.ms)),
      scored: asNumber(retrieval.scored) ?? scoredBy.get(id) ?? 0,
      lean: asBool(retrieval.lean_items),
      candidates,
    };
    if (options.level === 'data') row.query = queryKey === null ? null : options.examples?.query(queryKey) ?? null;
    // The coarse-values rule (fields.ts coarsenRow): lanes, ranker and model to their closed sets, scores to two places, counts capped.
    rows.push({ kind: 'retrieval', at, row: coarsenRow(row) as Record<string, unknown> });
  }
  return rows;
}

function saveRows(log: LearningExport, options: ProjectOptions, windowMs: number): ProjectedRow[] {
  const { tables } = log;
  const events = indexEvents(tables);
  const cutoff = options.now - windowMs;
  // How many times each memory was served after a given time: candidates by key, with the retrieval's time.
  const retrievalAt = new Map<number, number>();
  for (const retrieval of tables.retrievals) {
    const id = asNumber(retrieval.id);
    const at = asNumber(retrieval.at);
    if (id !== null && at !== null) retrievalAt.set(id, at);
  }
  const sender = senderOf(options);
  const servedBy = new Map<string, number[]>();
  for (const candidate of tables.candidates) {
    const key = asString(candidate.memory_key);
    const id = asNumber(candidate.retrieval_id);
    const at = id === null ? undefined : retrievalAt.get(id);
    if (key === null || at === undefined || !servedRow(candidate)) continue;
    const list = servedBy.get(key);
    if (list) list.push(at);
    else servedBy.set(key, [at]);
  }
  const rows: ProjectedRow[] = [];
  const ops = [...tables.memory_ops].sort((a, b) => (asNumber(a.at) ?? 0) - (asNumber(b.at) ?? 0) || (asNumber(a.id) ?? 0) - (asNumber(b.id) ?? 0));
  for (const op of ops) {
    const at = asNumber(op.at);
    const tool = asString(op.tool);
    const kind = asString(op.op);
    if (at === null || tool === null || !(SAVE_TOOL_NAMES as readonly string[]).includes(tool)) continue;
    if (kind !== 'create' && kind !== 'supersede') continue;
    if (at <= options.watermarks.save || at > cutoff) continue;
    const memoryKey = asString(op.memory_key);
    const item = asString(op.kind) ?? 'unkeyed';
    const joinable = memoryKey !== null && item !== 'unkeyed';
    const label = joinable
      ? labelOf([events.byMemory.get(memoryKey), item === 'fact' ? events.bySubject.get(asString(op.subject_key) ?? '') : undefined],
        at, at + windowMs, at)
      : labelOf([], at, at + windowMs);
    const reads = joinable ? (servedBy.get(memoryKey) ?? []).filter(time => time > at && time <= at + windowMs).length : 0;
    const hasCites = tables.feedback.some(cite => cite.tool === tool && asNumber(cite.observed) !== 0 && Math.abs((asNumber(cite.at) ?? Number.NaN) - at) <= 2000
      && cite.agent_key === op.agent_key && cite.session_key === op.session_key);
    const row: Record<string, unknown> = {
      kind: 'save-outcome/1',
      hour: hourOf(at),
      install_age: ageAt(options, at),
      tool,
      op: kind,
      item,
      has_cites: hasCites,
      reads_bucket: countBucket(reads),
      opened: label.opened,
      cited: label.cited,
      superseded: label.updated,
      retired: label.retired,
      ...contextOf(sender, op),
      via: viaOf(op.actor),
      latency_bucket: latencyBucket(asNumber(op.ms)),
    };
    if (options.level === 'data') row.text = memoryKey === null ? null : options.examples?.memory(memoryKey) ?? null;
    rows.push({ kind: 'save', at, row });
  }
  return rows;
}

function sessionRows(log: LearningExport, options: ProjectOptions, windowMs: number): ProjectedRow[] {
  const { tables } = log;
  const cutoff = options.now - windowMs;
  const sender = senderOf(options);
  const sessions = new Map<string, Seen>();
  const touch = (key: string | null, at: number | null, tool: string | null, event: Table, apply: (seen: Seen) => void): void => {
    if (key === null || at === null || tool === null) return;
    const recorded = { app: asString(event.app), release: asString(event.release), profile: asString(event.profile) };
    let seen = sessions.get(key);
    if (!seen) {
      seen = { first: at, last: at, tool, reads: 0, saves: 0, empty: 0, opens: 0, ...recorded };
      sessions.set(key, seen);
    }
    if (at < seen.first) {
      seen.first = at;
      seen.tool = tool;
      Object.assign(seen, recorded);
    }
    seen.last = Math.max(seen.last, at);
    apply(seen);
  };
  for (const retrieval of tables.retrievals) {
    touch(asString(retrieval.session_key), asNumber(retrieval.at), asString(retrieval.tool), retrieval, seen => {
      seen.reads += 1;
      if ((asNumber(retrieval.served) ?? 0) === 0) seen.empty += 1;
    });
  }
  for (const op of tables.memory_ops) {
    const tool = asString(op.tool);
    touch(asString(op.session_key), asNumber(op.at), tool, op, seen => {
      if (tool !== null && (SAVE_TOOL_NAMES as readonly string[]).includes(tool) && (op.op === 'create' || op.op === 'supersede')) seen.saves += 1;
      if (tool === 'read_memory') seen.opens += 1;
    });
  }
  const rows: ProjectedRow[] = [];
  for (const seen of [...sessions.values()].sort((a, b) => a.last - b.last)) {
    if (seen.last <= options.watermarks.session || seen.last > cutoff) continue;
    rows.push(sessionRow(seen, sender, options));
  }
  return rows;
}

/** One session as the projection sums it: its span, its counts, and the context of its earliest event. */
interface Seen {
  first: number; last: number; tool: string; reads: number; saves: number; empty: number; opens: number;
  app: string | null; release: string | null; profile: string | null;
}

function sessionRow(seen: Seen, sender: SenderContext, options: Pick<ProjectOptions, 'firstSeen'>): ProjectedRow {
  const firstCall = (RETRIEVAL_TOOL_NAMES as readonly string[]).includes(seen.tool) || (SAVE_TOOL_NAMES as readonly string[]).includes(seen.tool)
    ? seen.tool
    : 'other';
  return {
    kind: 'session',
    at: seen.last,
    row: {
      kind: 'session-aggregate/1',
      hour: hourOf(seen.first),
      install_age: ageAt(options, seen.first),
      length_bucket: lengthBucket(seen.last - seen.first),
      reads_bucket: countBucket(seen.reads),
      saves_bucket: countBucket(seen.saves),
      empty_reads_bucket: countBucket(seen.empty),
      first_call: firstCall,
      opens_bucket: countBucket(seen.opens),
      ...contextOf(sender, seen),
    },
  };
}

/** The finished rows the log holds that are final and not yet sent, oldest first within each kind. */
export function projectRows(log: LearningExport, options: ProjectOptions): ProjectedRow[] {
  const windowMs = options.windowMs ?? LABEL_WINDOW_MS;
  return [...retrievalRows(log, options, windowMs), ...saveRows(log, options, windowMs), ...sessionRows(log, options, windowMs)];
}

/** How many rows of each table one slice of projectFromLog reads as its subject rows (it also reads one label window after them). */
export const SLICE_ROWS = 500;
/** How far before a save a cite still counts as that save's (saveRows `has_cites`). */
const CITE_SKEW_MS = 2_000;

/**
 * One slice's rows of one kind. Its own function, so the slice's tables are garbage once it returns: a generator suspended at a
 * `yield` keeps its locals alive, and the tables are most of what a slice holds.
 */
function projectSlice(
  log: LearningLog, build: typeof retrievalRows, kind: 'retrieval' | 'save', after: number, until: number, options: ProjectOptions, windowMs: number,
): ProjectedRow[] {
  // Everything a row in (after, until] can be built from: its cites up to CITE_SKEW_MS before it, and its label window after it.
  const slice = log.exportServedWindow(after - CITE_SKEW_MS, until + Math.max(windowMs, CITE_SKEW_MS));
  // `now` = until + window makes the projection's own cut-off `until`; the watermark `after` is the slice's start.
  return build(slice, { ...options, now: until + windowMs, watermarks: { ...options.watermarks, [kind]: after } }, windowMs);
}

/**
 * projectRows without the whole log: the same rows, in the same order within each kind, read from the log a time slice at a
 * time. A slice is at most about SLICE_ROWS rows of each table, plus the label window after it (the events that label them), and
 * only the served candidates; sessions are summed by SQLite. What one slice holds is bounded by the slice and one label window of
 * activity, never by the size of the log, its retention or how far behind the watermarks are. Each yield is one slice's rows:
 * the caller sends them and moves the watermark before the next slice is read.
 */
export function* projectFromLog(
  source: LearningLog | (() => LearningLog), options: ProjectOptions & { sliceRows?: number },
): Generator<ProjectedRow[]> {
  // Given a way to open the log, each slice opens it and closes it before its rows are handed on, so no handle is held while the
  // caller sends them. Given an open log, it is only read.
  const read = <T>(fn: (log: LearningLog) => T): T => {
    if (typeof source !== 'function') return fn(source);
    const log = source();
    try {
      return fn(log);
    } finally {
      log.close();
    }
  };
  const windowMs = options.windowMs ?? LABEL_WINDOW_MS;
  const limit = Math.max(1, options.sliceRows ?? SLICE_ROWS);
  const cutoff = options.now - windowMs;
  const kinds: Array<{ kind: 'retrieval' | 'save'; build: typeof retrievalRows }> = [
    { kind: 'retrieval', build: retrievalRows },
    { kind: 'save', build: saveRows },
  ];
  for (const { kind, build } of kinds) {
    let after = options.watermarks[kind];
    while (after < cutoff) {
      const until = read(log => log.sliceEnd(after, cutoff, limit));
      yield read(log => projectSlice(log, build, kind, after, until, options, windowMs));
      after = until;
    }
  }
  let after = options.watermarks.session;
  while (after < cutoff) {
    const spans = read(log => log.sessionSpans(after, cutoff, SAVE_TOOL_NAMES, limit));
    if (spans.length === 0) break;
    const sender = senderOf(options);
    yield spans.map((span: SessionSpan) => sessionRow({ ...span, tool: span.first_tool, opens: span.opens ?? 0 }, sender, options));
    after = spans[spans.length - 1]!.last;
  }
}
