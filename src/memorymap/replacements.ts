import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { DAILY_FILE_RE } from '../memory/dailyNote';
import { notePathMatchesScope, type NormalizedScope } from '../mvp/scope';
import { refusal } from '../toolRefusal';
import { headerSource, isReservedSource } from '../memory/sourceName';
import { createNoteTimeBound, resolveSessionDate } from '../retrieval/orchestrator';
import {
  NOFOLLOW, RETIRED_DIR, activeRetired, ensureRealDir, openConfined, parseEntries, parseMemoryId, readJournal, readPrefix,
  readMemory, resolveVaultFile, type MemoryMapContext,
} from './memoryMap';
import { REPLACED_FILE_NAME } from './replacedJournal';
import { nameIsOpenFile, nameKind } from '../memory/sameFile';

// ---------------------------------------------------------------------------
// Replacements: a correction that names the earlier memory it corrects.
//
// Agents already save corrections ("the export now includes daily entries"), but nothing linked one to the note it
// corrects, so a recall served the stale note as current (owner request 2026-10-12; two wrong answers the same day).
// `remember({statement, replaces: <id>})` saves the correction as usual and appends one record here. Nothing stored is
// touched: the earlier memory keeps its text, its place in search, its export, and stays retrievable. A read that returns it
// labels it replaced, points at the correction, and lays the correction out before it.
//
// The record lives beside the retirement journal (.trash/renor-retired/replaced.jsonl), not in the fact ledger: the
// ledger is replayed strictly at startup (an unknown event kind refuses to load), so a new kind there would stop an older
// engine release from starting on a workspace that holds one, and a replacement is no fact.
//
// A replacement is in effect while its correction is live. Retiring the correction (retire_memory) ends it; restoring the
// correction brings it back, with nothing else to undo. Corrections chain (A replaced by B, B by C): A reads as replaced by C.
// ---------------------------------------------------------------------------

const REPLACED_FILE = path.join(RETIRED_DIR, REPLACED_FILE_NAME);
/** The corrected text of a note a replacement pulls into a reply, by characters (an entry is whole). */
const NOTE_CORRECTION_CHARS = 1200;
const MAX_CHAIN = 64;

export interface ReplacementRecord {
  rid: string;
  /** The memory id (`note:` or `entry:`) that was corrected. */
  old: string;
  /** The correction's memory id (an `entry:`). */
  by: string;
  /** When the correction was saved. */
  at: string;
  /** Who saved the correction: the agent's name, as the correction's entry carries it. */
  source?: string;
  /**
   * The source the replaced memory was saved with (null: none recorded), taken when the link is recorded. Absent on a record
   * written before this field existed: its label then names the correction's source and says nothing about the other side.
   */
  oldSource?: string | null;
  /** True when the caller did not pass `replaces` and the engine inferred the link (RENOR_INFER_REPLACES); the audit list reads it. */
  inferred?: boolean;
}

/** What a read labels a replaced memory with. */
export interface ReplacedLabel {
  /** The memory id of the correction that replaces it (the newest of a chain). Read it with read_memory. */
  by: string;
  /** When that correction was saved. */
  at: string;
  /** Who saved the correction, so a reader can weigh one from another agent. Absent when the correction recorded none. */
  source?: string;
  /** Set when the correction's source differs from the replaced memory's source: says so plainly, and names that source. */
  note?: string;
  /** Set when the correction's source is a reserved identity (a record saved before the rule, or by hand): only a claim. */
  untrusted?: true;
}

export interface ReplacementIndex {
  readonly size: number;
  replacedBy(id: string): ReplacedLabel | undefined;
  /** The memories the correction `id` replaces directly, those not retired since. */
  replaces(id: string): string[];
  /** Whether following the replacements in effect from `from` reaches `target` (a new link `target` -> `from` would be a loop). */
  reaches(from: string, target: string): boolean;
  /** Vault-relative paths of the files any replaced memory or correction is in: a hit elsewhere needs no lookup. */
  readonly paths: ReadonlySet<string>;
}

const EMPTY: ReplacementIndex = { size: 0, replacedBy: () => undefined, replaces: () => [], reaches: () => false, paths: new Set() };

const relOf = (id: string): string => {
  if (id.startsWith('note:')) return id.slice(5);
  const hashAt = id.lastIndexOf('#');
  return id.slice(6, hashAt);
};

/**
 * A source as a label or a link carries it: the daily-note header form (letters, digits, hyphens), cut to MAX_SOURCE_LENGTH.
 * Both sides are reduced the same way, so one agent spelled two ways is one source, and a source taken from a note's own front
 * matter is bounded and clean before any reply carries it (memory text can name anything there). Null when nothing is left.
 */
function sourceForLabel(source: string | null | undefined): string | null {
  if (typeof source !== 'string') return null;
  return headerSource(source) || null;
}

/**
 * The label for a memory replaced by `replaced`, whose newest correction is `correction` (the last link of its chain). The source
 * is the correction's; the note is added only when both sides' sources are recorded and differ, so a reader can weigh a correction
 * from another agent. A record without `oldSource` (written before it was kept) names no other side.
 */
function labelOf(replaced: ReplacementRecord, correction: ReplacementRecord): ReplacedLabel {
  const saver = sourceForLabel(correction.source);
  const label: ReplacedLabel = { by: correction.by, at: correction.at, ...(saver ? { source: saver } : {}), ...(isReservedSource(saver) ? { untrusted: true as const } : {}) };
  if (replaced.oldSource === undefined) return label;
  const from = sourceForLabel(replaced.oldSource);
  if (saver === from) return label;
  return { ...label, note: `the correction's source differs from the replaced memory's source (${from ?? 'none recorded'})` };
}

let cache: { key: string; records: ReplacementRecord[] } | undefined;

/**
 * Whether this workspace has ever recorded a replacement, answered at once (one stat, no await): a read of a workspace with none
 * goes on exactly as it did before replacements existed, with no extra turn of the event loop in its assembly.
 */
export function hasReplacements(memoryDir: string): boolean {
  try {
    return fsSync.lstatSync(path.join(memoryDir, REPLACED_FILE)).size > 0;
  } catch {
    return false;
  }
}

async function readRecords(ctx: MemoryMapContext): Promise<ReplacementRecord[]> {
  const rootReal = await fs.realpath(ctx.memoryDir);
  const file = path.join(rootReal, REPLACED_FILE);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const key = `${file}\0${stat.mtimeMs}\0${stat.size}\0${stat.ino}`;
  if (cache?.key === key) return cache.records;
  for (const dir of [path.join(rootReal, '.trash'), path.join(rootReal, RETIRED_DIR)]) {
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('the replacement journal is not inside the vault');
  }
  const handle = await openConfined(file);
  let raw: string;
  try {
    raw = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const records: ReplacementRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ReplacementRecord;
      if (typeof r.rid === 'string' && typeof r.old === 'string' && typeof r.by === 'string' && typeof r.at === 'string') records.push(r);
    } catch {
      // A torn final line (a crash mid-append) is skipped, never fatal.
    }
  }
  cache = { key, records };
  return records;
}

/** The replacements in effect: those whose correction is live (not retired), with each chain followed to its newest correction. */
export async function replacementIndex(ctx: MemoryMapContext): Promise<ReplacementIndex> {
  const records = await readRecords(ctx);
  if (records.length === 0) return EMPTY;
  const retired = new Set(activeRetired(await readJournal(ctx)).map(r => r.id));
  const direct = new Map<string, ReplacementRecord>();
  const byAll = new Map<string, string[]>();
  for (const r of records) {
    if (retired.has(r.by) || r.old === r.by) continue;
    const kept = direct.get(r.old);
    if (!kept || r.at >= kept.at) direct.set(r.old, r);
  }
  for (const r of direct.values()) if (!retired.has(r.old)) byAll.set(r.by, [...(byAll.get(r.by) ?? []), r.old]);
  if (direct.size === 0) return EMPTY;
  // The newest correction of a chain. A loop (or a chain longer than any real one) has no newest: it is read as not replaced,
  // never as replaced by itself or by a middle link.
  const head = (id: string): ReplacedLabel | undefined => {
    const first = direct.get(id);
    if (!first) return undefined;
    let at = first;
    const seen = new Set([id]);
    for (let hops = 0; ; hops++) {
      if (seen.has(at.by) || hops > MAX_CHAIN) return undefined;
      seen.add(at.by);
      const next = direct.get(at.by);
      if (!next) return labelOf(first, at);
      at = next;
    }
  };
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    for (let at: string | undefined = from; at !== undefined && !seen.has(at) && seen.size <= MAX_CHAIN; at = direct.get(at)?.by) {
      if (at === target) return true;
      seen.add(at);
    }
    return false;
  };
  const paths = new Set<string>();
  for (const r of direct.values()) { paths.add(relOf(r.old)); paths.add(relOf(r.by)); }
  return { size: direct.size, replacedBy: head, replaces: id => byAll.get(id) ?? [], reaches, paths };
}

/** Every record ever written for a correction, in effect or not (export keeps the link of a retired correction). */
export async function allReplacementRecords(ctx: MemoryMapContext): Promise<ReplacementRecord[]> {
  return readRecords(ctx);
}

/** The links the engine inferred (not passed by the caller), newest last: ids and dates only, no memory text. For the operator's audit. */
export async function inferredReplacements(ctx: MemoryMapContext): Promise<Array<{ old: string; by: string; at: string }>> {
  return (await readRecords(ctx)).filter(r => r.inferred === true).map(r => ({ old: r.old, by: r.by, at: r.at }));
}

/**
 * Refuse a replacement that cannot hold, before anything is saved: the memory must exist and be live, be a note or a
 * daily-log entry (a fact is corrected by saving it again with the same subject, predicate and scope), and be in the scope the
 * correction is saved to, so a correction never reaches into another scope's memories, nor a read of one scope into another's.
 */
export async function assertReplaceable(ctx: MemoryMapContext, id: string, scope: NormalizedScope): Promise<void> {
  if (typeof id === 'string' && id.startsWith('fact:')) {
    throw refusal('invalid_argument', 'a fact is corrected by saving it again with the same subject, predicate and scope, not with replaces');
  }
  parseMemoryId(id);
  const memory = (await readMemory(ctx, id)).memory;
  if (!notePathMatchesScope(memory.path, scope)) {
    throw refusal('invalid_argument', 'replaces names a memory of another scope: a correction replaces only memories of its own scope');
  }
}

/**
 * The source the memory `id` was saved with, in the label form (null: none recorded), or undefined when it cannot be read: the
 * link is kept without it. A note's source is its own front matter, so it is reduced here, before it is stored or compared.
 */
async function sourceOfMemory(ctx: MemoryMapContext, id: string): Promise<string | null | undefined> {
  try {
    return sourceForLabel((await readMemory(ctx, id)).memory.source);
  } catch {
    return undefined;
  }
}

/**
 * Record that `by` replaces `old`. Null, and nothing recorded, when that would make a loop: the save is the memory it replaces
 * (an identical line saved again in the same second is the same memory, since an id is the hash of the line), or is already
 * replaced by it, directly or down a chain.
 */
export async function recordReplacement(ctx: MemoryMapContext, old: string, by: string, source?: string, inferred = false): Promise<ReplacementRecord | null> {
  const existing = (await readRecords(ctx)).find(r => r.old === old && r.by === by);
  if (existing) return existing;
  if (old === by || (await replacementIndex(ctx)).reaches(by, old)) return null;
  const oldSource = await sourceOfMemory(ctx, old);
  const saver = sourceForLabel(source);
  const record: ReplacementRecord = {
    rid: `replaced:${crypto.randomBytes(8).toString('hex')}`, old, by, at: new Date().toISOString(), ...(saver ? { source: saver } : {}),
    ...(oldSource !== undefined ? { oldSource } : {}),
    ...(inferred ? { inferred: true } : {}),
  };
  const dir = await ensureRealDir(await fs.realpath(ctx.memoryDir), RETIRED_DIR);
  // O_NONBLOCK and the single-name check: the same rules as the retirement journal (appendJournal), so neither a FIFO nor a
  // hard link under this name is written through.
  const replacedFile = path.join(dir, path.basename(REPLACED_FILE));
  // Windows has no O_NOFOLLOW and follows even a dangling link under O_CREAT: a link at the name is refused before the open (#1563).
  if ((await nameKind(replacedFile)) === 'other') throw new Error(`refusing to write ${JSON.stringify(REPLACED_FILE_NAME)}: it is not a regular file with a single name`);
  const handle = await fs.open(replacedFile, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !(await nameIsOpenFile(handle, replacedFile))) throw new Error(`refusing to write ${JSON.stringify(REPLACED_FILE_NAME)}: it is not a regular file with a single name`);
    // A crash can leave a torn last line; start on a fresh line so this record is never glued to it.
    const size = stat.size;
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    await handle.appendFile(`${prefix}${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  cache = undefined;
  return record;
}

// ------------------------------- reads ---------------------------------------

interface HitLike {
  notePath: string;
  headingPath?: string;
  text: string;
  score?: number;
  reason?: string;
  session_date?: string;
}

/** The memory ids a hit is: the note, or the daily-log entries whose text holds it. A fact or a ledger statement is none. */
async function hitIds(ctx: MemoryMapContext, index: ReplacementIndex, hit: HitLike, entries: Map<string, Promise<ReturnType<typeof parseEntries>['blocks']>>): Promise<string[]> {
  if (hit.notePath === '' || !index.paths.has(hit.notePath)) return [];
  if (!DAILY_FILE_RE.test(hit.notePath)) return [`note:${hit.notePath}`];
  let blocks = entries.get(hit.notePath);
  if (!blocks) {
    blocks = (async () => {
      try {
        const file = await resolveVaultFile(ctx, hit.notePath, true);
        const read = await readPrefix(file.real, 8 * 1024 * 1024);
        return read ? parseEntries(file.rel, read.text).blocks : [];
      } catch {
        return []; // gone since it was indexed: the hit stays what it was
      }
    })();
    entries.set(hit.notePath, blocks);
  }
  const text = hit.text.trim();
  return (await blocks).filter(b => b.raw.trim() === text || b.text.trim() === text || b.raw.includes(text)).map(b => b.id);
}

/** A correction that was not among the hits, as a hit: an entry whole, a note by its first characters. */
async function correctionHit(ctx: MemoryMapContext, id: string): Promise<HitLike | null> {
  try {
    const { memory, text } = await readMemory(ctx, id);
    const body = memory.kind === 'entry' ? text : text.slice(0, NOTE_CORRECTION_CHARS);
    const raw = memory.kind === 'entry' ? await entryRaw(ctx, id) : null;
    const bound = createNoteTimeBound(ctx.db);
    const indexed = path.resolve(ctx.memoryDir, memory.path);
    const date = memory.session_date ?? (memory.kind === 'entry' ? bound(indexed, memory.at) : resolveSessionDate(undefined, memory.at));
    return {
      notePath: memory.path,
      headingPath: DAILY_FILE_RE.exec(memory.path)?.[2] ?? '',
      text: raw ?? body,
      ...(date ? { session_date: date } : {}),
    };
  } catch {
    return null;
  }
}

async function entryRaw(ctx: MemoryMapContext, id: string): Promise<string | null> {
  const { rel } = parseMemoryId(id);
  const file = await resolveVaultFile(ctx, rel, true);
  const read = await readPrefix(file.real, 8 * 1024 * 1024);
  return read ? parseEntries(file.rel, read.text).blocks.find(b => b.id === id)?.raw ?? null : null;
}

export type WithReplaced<T> = T & { replaced?: ReplacedLabel };

/** A replaced hit and the correction a reply lists for it. */
export interface ReplacementPair<T> {
  replaced: WithReplaced<T>;
  correction: T;
}

/**
 * Lay a reply's hits out for the replacements in effect: a hit that is a replaced memory gets `replaced` (its label) and
 * follows its correction, and a correction the read did not return is added before the first memory it replaces, with that
 * memory's score and reason "replacement", so an agent that recalls a stale note is handed the fix with it. Nothing is dropped
 * for it and no text changes. `pairs` receives each replaced hit with the correction listed for it, for a caller that budgets
 * (get_context). `limit` is the most hits the reply may hold: an added correction takes the place of the last hit that is
 * neither a replaced memory nor a correction, so a page never grows past its top_k (and a limit too small for the pair lists the
 * correction and leaves the replaced memory out). A reply none of whose hits is involved is
 * returned as it was, and a workspace with no replacement pays one stat.
 */
export async function withReplacements<T extends HitLike>(
  ctx: MemoryMapContext,
  hits: T[],
  options: { pairs?: Array<ReplacementPair<T>>; limit?: number } = {},
): Promise<Array<WithReplaced<T>>> {
  if (!hasReplacements(ctx.memoryDir)) return hits;
  const index = await replacementIndex(ctx);
  if (index.size === 0 || !hits.some(h => index.paths.has(h.notePath))) return hits;
  const entries = new Map<string, Promise<ReturnType<typeof parseEntries>['blocks']>>();
  const ids = await Promise.all(hits.map(h => hitIds(ctx, index, h, entries)));
  const labels = ids.map(own => {
    const labelled = own.map(id => index.replacedBy(id));
    return own.length > 0 && labelled.every(l => l !== undefined) ? labelled[0] : undefined;
  });
  const correctionAt = new Map<string, number>(); // correction id -> position of the hit that is it
  ids.forEach((own, i) => { if (labels[i] === undefined) for (const id of own) correctionAt.set(id, i); });
  if (labels.every(l => l === undefined)) return hits;

  const out: Array<WithReplaced<T>> = [];
  const waiting = new Map<string, Array<WithReplaced<T>>>(); // replaced hits held until their correction is out
  const flush = (hitIds: string[]) => {
    for (const id of hitIds) {
      for (const held of waiting.get(id) ?? []) out.push(held);
      waiting.delete(id);
    }
  };
  const added = new Map<string, WithReplaced<T> | null>(); // correction id -> the hit added for it (null: unreadable)
  const involved = new Set<WithReplaced<T>>();
  const paired: Array<{ replaced: WithReplaced<T>; by: string }> = [];
  for (let i = 0; i < hits.length; i++) {
    const label = labels[i];
    if (label === undefined) {
      out.push(hits[i]);
      flush(ids[i]);
      continue;
    }
    const replaced = { ...hits[i], replaced: label } as WithReplaced<T>;
    involved.add(replaced);
    paired.push({ replaced, by: label.by });
    if (correctionAt.has(label.by)) {
      // The correction is among the hits: before this one if it came first, else this one waits for it.
      if (correctionAt.get(label.by)! < i) out.push(replaced);
      else waiting.set(label.by, [...(waiting.get(label.by) ?? []), replaced]);
      continue;
    }
    if (!added.has(label.by)) {
      const fix = await correctionHit(ctx, label.by);
      const hit = fix ? { ...fix, ...(hits[i].score !== undefined ? { score: hits[i].score } : {}), reason: 'replacement' } as unknown as WithReplaced<T> : null;
      added.set(label.by, hit);
      if (hit) { out.push(hit); involved.add(hit); }
    }
    out.push(replaced);
  }
  for (const held of waiting.values()) out.push(...held);
  for (const { by } of paired) if (correctionAt.has(by)) involved.add(hits[correctionAt.get(by)!] as WithReplaced<T>);
  if (options.pairs) {
    for (const { replaced, by } of paired) {
      const correction = added.get(by) ?? (correctionAt.has(by) ? hits[correctionAt.get(by)!] : null);
      if (correction) options.pairs.push({ replaced, correction });
    }
  }
  const limit = options.limit;
  if (limit !== undefined) {
    while (out.length > limit) {
      let at = -1;
      for (let i = out.length - 1; i >= 0; i--) if (!involved.has(out[i])) { at = i; break; }
      // Nothing else left to give up: a top_k too small for the pair lists the correction and leaves the replaced memory out.
      if (at < 0) for (let i = out.length - 1; i >= 0 && at < 0; i--) if (out[i].replaced !== undefined) at = i;
      if (at < 0) break;
      out.splice(at, 1);
    }
  }
  return out;
}
