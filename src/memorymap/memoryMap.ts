import fs, { type FileHandle } from 'fs/promises';
import { statSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { hashContent } from '../indexer/hasher';
import type Database from '../db/sqlite';
import { parseNote } from '../indexer/parser';
import { isIgnoredByVault } from '../indexer/walker';
import { indexFile, type IndexOptions } from '../indexer/pipeline';
import { eraseRetiredFact, factEventId, listRetiredFacts, resolveLedgerPath, restoreFact, retireFact, type FactRetirementReceipt } from '../memory/lifecycle';
import { writerConflictLines } from '../memory/writerConflicts';
import { DAILY_FILE_RE, ENTRY_LINE_RE, decodeEntryLine, engineDailyHeader, entryInstant, isEmptyEngineDailyNote, parseEntryHeader, type EntryHeader } from '../memory/dailyNote';
import { withDailyFileLock } from '../memory/writer';
import { notePathMatchesScope, savedScopeMatches, type NormalizedScope } from '../mvp/scope';
import { assertStorable, refuseUnchecked, secretGuardEnabled } from '../extraction/secretGuard';
import { refusal } from '../toolRefusal';
import { dropEvidenceForStems } from '../evidence/evidenceCache';
import { forgetImportedNotes } from '../importing/forgetImported';
import { forgetReplacementsOf } from './replacedJournal';
import { clampSessionDate, createNoteTimeBound, resolveSessionDate } from '../retrieval/orchestrator';

// ---------------------------------------------------------------------------
// Memory map: a read model of everything one workspace holds, shaped for a
// human to browse (the dashboard's graph + reader), plus reversible retirement.
//
// It is derived only from what the engine already stores — note files on disk,
// the notes/facts/entities tables and write_events. Nothing is inferred by a
// model: a link exists because a wikilink, a tag or a literal name mention says
// so, and every link carries which of those it is.
//
// Units a person thinks of as "a memory":
//   - note  : one Markdown file (imported notes, remember_note files, …);
//   - entry : one entry of a daily log (Memory/**/Daily/YYYY-MM-DD.md), which is
//             where the unstructured `remember` path appends. An entry is its
//             timestamped line plus any continuation lines a multi-line
//             statement wrote below it.
// Lifecycle facts (the canonical ledger) are listed separately with their full
// history. A fact is retired through the ledger (memory/lifecycle.ts, retireFact):
// retire_memory and restore_memory take its id, `fact:` and its event id, and
// hand it there.
//
// Retirement is a move, never a delete. Every retirement is journalled BEFORE
// the move, so an interrupted one is either still in place (and the journal
// record is void) or moved (and the record restores it):
//   - a note file moves under `.trash/renor-retired/files/`;
//   - an entry is cut out of its daily file by an atomic rewrite, under the
//     same per-file lock every daily-file writer takes, and its exact bytes live
//     in the journal.
// `.trash/` is ignored by the indexer, so retired text leaves retrieval, and
// restore puts the exact bytes back and re-indexes them.
//
// Why move bytes rather than mark them: retrieval does not only read the index —
// the evidence pass hydrates whole note files from disk — so a "retired" line
// left inside a daily log could still reach an agent's context. Moving it out of
// the file is the only guarantee that holds for every reader.
//
// Identical entries in one daily log (the same statement saved twice) are one
// memory: they share an id, and retiring it removes every copy.
//
// Confinement: ids address vault-relative Markdown paths only. No component may
// be hidden ('.'-prefixed: .trash, .obsidian, the index), no component may be a
// symlink, the real path must stay inside the vault's real path, and the fact
// ledger is never addressable as a memory. Reads open with O_NOFOLLOW and check
// the opened inode against the path. Threat model: the vault is written only by
// this engine; these checks are defence in depth against a mis-provisioned vault
// (a stray symlink), not a sandbox against a concurrent local attacker, who would
// already own the files.
// ---------------------------------------------------------------------------

const LIFECYCLE_NOTE_PATH = '_mcp_';
/** Frontmatter keys the indexer turns into note facts; they are note metadata, not knowledge. */
const METADATA_PREDICATES = new Set(['owner', 'status', 'updated', 'tags']);
/** The front-matter keys read_memory returns as `metadata` (MemoryDetail). Any other key is not copied. */
const METADATA_KEYS = new Set(['title', 'status', 'owner', 'updated', 'tags']);
export const RETIRED_DIR = path.join('.trash', 'renor-retired');
const RETIRED_FILES_DIR = path.join(RETIRED_DIR, 'files');
const RETIRED_INDEX = path.join(RETIRED_DIR, 'retired.jsonl');

const MAX_MEMORIES = 2000;
/** Notes considered per map (newest first); bounds work before the memory cap applies. */
const MAX_NOTES_SCANNED = 5000;
/** Newest entries kept per daily log. */
const MAX_ENTRIES_PER_DAY = 500;
const MAX_THINGS = 2000;
const MAX_FACTS = 5000;
const MAX_LINKS = 20000;
const MAX_EVENTS = 1000;
const MAX_RETIRED_LISTED = 500;
/**
 * Items per list when a caller names no limit (memory_map's first call): small enough for one tool result on a large
 * workspace, and the reply says how many more exist.
 */
export const DEFAULT_MAP_LIMIT = 20;
/** Bytes read per note for the map (excerpt + mention matching). */
const MAP_READ_BYTES = 64 * 1024;
/** Bytes read for one memory in full. */
const READ_BYTES = 512 * 1024;
/** A daily file larger than this is not rewritten (retire/restore refuse instead of truncating). */
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;
const EXCERPT_CHARS = 280;
const MAX_READ_CHARS = 40_000;
const MIN_MENTION_CHARS = 3;

export interface MemoryMapContext {
  db: Database.Database;
  memoryDir: string;
  ledgerRelPath: string;
  /** Who is asking, for the ledger's record of a fact's retire or restore. */
  source?: string;
  indexOptions: IndexOptions;
  /** The evidence pass's cache, whose rows a permanent deletion drops when they read a deleted memory's file. */
  evidenceCachePath?: string;
}

export type MemoryKind = 'note' | 'entry';

export interface MapMemory {
  id: string;
  kind: MemoryKind;
  /** Vault-relative path of the file holding it. */
  path: string;
  title: string;
  /** ISO time: the entry's own timestamp, capped at its note's write time, or the note's last modification. */
  at: string;
  /**
   * When the memory was written, as get_context and search_memory date the same text: the entry's own moment, or the note's
   * front-matter session_date or date, capped at its write time, else that time (readMemory only; absent when unknown).
   */
  session_date?: string;
  /** Who wrote it, when the source records it (daily entries carry their source tag). */
  source: string | null;
  tags: string[];
  status: string | null;
  excerpt: string;
}

export interface MapThing {
  id: string;
  name: string;
  /** Current (open) facts about it. */
  currentFacts: number;
}

export interface MapFact {
  id: number;
  thingId: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: string;
  validTo: string | null;
  scope: string;
  /** The event that saved it: `fact:` and this is what retire_memory takes. Null for a fact saved before the ledger. */
  eventId: string | null;
  /** Set on a current fact that replaced a value another writer saved, until that writer saves it again (memory/writerConflicts.ts). */
  writerConflict?: string;
}

export type MapLinkKind = 'tag' | 'mention' | 'wikilink' | 'fact';

export interface MapLink {
  source: string;
  target: string;
  kind: MapLinkKind;
  /** The relation for a `fact` link (its predicate). */
  label?: string;
}

export interface MapEvent {
  at: string;
  action: string;
  /** For retire/restore: the memory id. */
  memoryId: string | null;
  summary: string | null;
  /** Who did it, when the event recorded an author. */
  source?: string | null;
}

export interface MemoryMap {
  ok: true;
  generatedAt: string;
  /** The limit this reply was cut to, per list. */
  limit: number;
  memories: MapMemory[];
  things: MapThing[];
  topics: Array<{ id: string; name: string; memories: number }>;
  facts: MapFact[];
  links: MapLink[];
  events: MapEvent[];
  /** `id` is the retirement's own id (what restore_memory takes); `memoryId` is the memory's. */
  /** `savedAt` is when a retired daily-log entry was originally saved (its own timestamp). */
  /** A retired fact's `path` is the ledger's, and its `id` and `memoryId` are both the fact's id. */
  retired: Array<{ id: string; memoryId: string; kind: MemoryKind | 'fact'; path: string; title: string; retiredAt: string; savedAt?: string }>;
  /** How many of each list the map holds (up to its own caps), before `limit` cut it to the reply. */
  total: { memories: number; things: number; facts: number; links: number; events: number; retired: number };
  /** True when the list holds more than the reply shows. */
  truncated: { memories: boolean; things: boolean; facts: boolean; links: boolean; events: boolean; retired: boolean };
}

// ------------------------------- paths --------------------------------------

function toRel(memoryDir: string, stored: string): string | null {
  const root = path.resolve(memoryDir);
  const resolved = path.resolve(root, stored);
  const rel = path.relative(root, resolved);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * When a daily entry was saved, as retrieval dates it: the instant its header records, capped at its note's write time
 * (createNoteTimeBound, the bound get_context and search_memory use), so a self-chosen file date cannot list an entry
 * above what was written after it. Without a readable bound, the write time itself is the answer.
 */
function entryAt(
  bound: ReturnType<typeof createNoteTimeBound>, notePath: string, day: string, header: Pick<EntryHeader, 'time' | 'offset'>, writtenAt: string,
): string {
  return bound(notePath, entryInstant(day, header)) ?? writtenAt;
}

function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

interface VaultFile {
  /** Vault-relative, '/'-separated. */
  rel: string;
  /** The path under the configured memory dir, as the index stores it. */
  indexed: string;
  /** The real on-disk path (no symlink anywhere below the vault root). */
  real: string;
}

/** Lexical checks shared by every addressed path. */
function lexicalRel(rel: string): string {
  if (typeof rel !== 'string' || rel.trim() === '' || path.isAbsolute(rel) || rel.includes('\0') || rel.includes('\\')) {
    throw refusal('unsafe_path', 'memory path must be a vault-relative path');
  }
  const parts = rel.split('/');
  if (parts.some((p) => p === '..')) throw refusal('unsafe_path', 'memory path escapes the memory directory');
  if (parts.some((p) => p === '' || p === '.')) throw refusal('unsafe_path', 'memory path must be a vault-relative path');
  if (parts.some((p) => p.startsWith('.'))) throw refusal('unsafe_path', 'memory path points into a hidden or system directory');
  if (!rel.endsWith('.md')) throw refusal('invalid_argument', 'memory path must be a Markdown file');
  return parts.join('/');
}

/**
 * Resolve a vault-relative path and prove it is confined: every existing component below the vault
 * root is a real directory (no symlink), the file itself is not a symlink, and the real path is
 * inside the vault's real path. `mustExist: false` allows a missing file (restore) but still checks
 * every directory that exists.
 */
export async function resolveVaultFile(ctx: MemoryMapContext, rel: string, mustExist: boolean): Promise<VaultFile> {
  const clean = lexicalRel(rel);
  const rootReal = await fs.realpath(ctx.memoryDir);
  const parts = clean.split('/');
  let cursor = rootReal;
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let st;
    try {
      st = await fs.lstat(cursor);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (mustExist) throw refusal('memory_not_found', 'memory not found (it may have been retired)');
        break; // nothing below exists; nothing below can be a symlink yet
      }
      throw err;
    }
    if (st.isSymbolicLink()) throw refusal('unsafe_path', 'memory path goes through a symbolic link');
    if (i < parts.length - 1 && !st.isDirectory()) throw refusal('memory_not_found', 'memory not found');
    if (i === parts.length - 1 && !st.isFile()) throw refusal('unsafe_path', 'memory path is not a file');
  }
  const real = path.join(rootReal, ...parts);
  if (!within(rootReal, real)) throw refusal('unsafe_path', 'memory path escapes the memory directory');
  const file: VaultFile = { rel: clean, indexed: path.resolve(ctx.memoryDir, ...parts), real };
  if (await isLedgerFile(ctx, file)) throw refusal('invalid_argument', 'the fact ledger is not a memory; read facts through memory_map');
  return file;
}

/**
 * A file the owner left out of memory (.semanticignore, node_modules, ...) is not found by search, so it is not read or moved
 * by its id either. Only read and retire ask: restore and reconcile must still reach a note that was retired before the
 * owner added the rule.
 */
async function assertNotExcluded(ctx: MemoryMapContext, file: VaultFile): Promise<void> {
  if (await isIgnoredByVault(ctx.memoryDir, file.rel)) throw refusal('memory_not_found', 'memory not found');
}

async function isLedgerFile(ctx: MemoryMapContext, file: VaultFile): Promise<boolean> {
  let ledger: string;
  try {
    ledger = resolveLedgerPath(ctx.memoryDir, ctx.ledgerRelPath);
  } catch {
    return false;
  }
  if (path.resolve(ledger) === path.resolve(file.indexed)) return true;
  try {
    return (await fs.realpath(ledger)) === file.real;
  } catch {
    return false;
  }
}

function isLedgerIndexed(ctx: MemoryMapContext, indexed: string): boolean {
  try {
    return path.resolve(indexed) === resolveLedgerPath(ctx.memoryDir, ctx.ledgerRelPath);
  } catch {
    return false;
  }
}

// ------------------------------- daily entries ------------------------------

export interface EntryBlock {
  /** Line ranges [start, end) of every copy of this entry in the file. */
  ranges: Array<[number, number]>;
  /** The exact bytes of the entry (its lines joined with '\n'). */
  raw: string;
  time: string;
  /** The offset of the clock `time` is on, when the header names one (dailyNote.ts). */
  offset?: string;
  source: string;
  text: string;
  id: string;
}

function entryId(rel: string, raw: string): string {
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `entry:${rel}#${digest}`;
}

/** A blank line is layout: spaces, tabs and carriage returns. Any other character on a line is the user's. */
const BLANK_LINE_RE = /^[ \t\r]*$/;

/**
 * Split a daily file into entries: a timestamped line plus the continuation lines below it (a
 * multi-line statement). Identical entries (same time, source and text) are one memory with every
 * copy's line range, so an id never moves from one copy to another.
 *
 * `raw` is the entry as stored (it is the id, and the block retire and restore move); `text` is the
 * statement as it was said: in an entry the writer marked, its escape on a continuation line is undone here
 * (dailyNote.ts), and an entry without the mark reads back exactly as stored. A carriage return is content,
 * not a line ending to drop.
 */
export function parseEntries(rel: string, content: string): { lines: string[]; blocks: EntryBlock[] } {
  const lines = content.split('\n');
  const starts: number[] = [];
  // An entry starts at column 0. A look-alike behind a backslash (the writer's escape for the user's words)
  // or behind an indent is a continuation.
  lines.forEach((l, i) => {
    if (ENTRY_LINE_RE.test(l)) starts.push(i);
  });
  const byRaw = new Map<string, EntryBlock>();
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    // Trailing blank lines are layout, not part of the entry.
    let last = end;
    while (last > start + 1 && BLANK_LINE_RE.test(lines[last - 1])) last--;
    const raw = lines.slice(start, last).join('\n');
    const existing = byRaw.get(raw);
    if (existing) {
      existing.ranges.push([start, last]);
      return;
    }
    const header = parseEntryHeader(lines[start])!;
    const rest = lines.slice(start + 1, last);
    const continuation = (header.escaped ? rest.map(decodeEntryLine) : rest).join('\n');
    byRaw.set(raw, {
      ranges: [[start, last]], raw, time: header.time, ...(header.offset ? { offset: header.offset } : {}), source: header.source,
      text: continuation ? `${header.text}\n${continuation}` : header.text,
      id: entryId(rel, raw),
    });
  });
  return { lines, blocks: [...byRaw.values()] };
}

/**
 * The id the map gives an entry a writer has just appended (`entry`, as appendDailyEntry wrote it) to the daily log at
 * vault-relative `rel`. The entry is read the way the map reads the file, so the two cannot differ: it runs to the next
 * entry (the next append) less its trailing blank lines. Null when `rel` is no daily log or `entry` no entry.
 */
export function appendedEntryId(rel: string, entry: string): string | null {
  if (!DAILY_FILE_RE.test(rel)) return null;
  return parseEntries(rel, entry).blocks[0]?.id ?? null;
}

function withoutRanges(lines: string[], ranges: Array<[number, number]>): string[] {
  const drop = new Set<number>();
  for (const [a, b] of ranges) for (let i = a; i < b; i++) drop.add(i);
  return lines.filter((_, i) => !drop.has(i));
}

/** The entries just before and just after a block, which parseEntries returns in file order. */
function entryNeighbours(blocks: EntryBlock[], block: EntryBlock): { prevId?: string; nextId?: string } {
  const i = blocks.indexOf(block);
  return {
    ...(i > 0 ? { prevId: blocks[i - 1].id } : {}),
    ...(i >= 0 && i + 1 < blocks.length ? { nextId: blocks[i + 1].id } : {}),
  };
}

/**
 * The line a restored entry goes back to, or null for the end of the file. It goes beside the neighbours it had when it
 * was retired (the entry after it, else the one before it) while the log still agrees with time there: no entry in front
 * of the place is later than it, and none at the place is earlier. Otherwise, before the first entry later than it.
 */
function restoreLine(blocks: EntryBlock[], record: RetiredRecord, time: string): number | null {
  const startOf = (b: EntryBlock) => Math.min(...b.ranges.map(([a]) => a));
  const endOf = (b: EntryBlock) => Math.max(...b.ranges.map(([, b2]) => b2));
  const next = blocks.find((b) => b.id === record.nextId);
  const prev = blocks.find((b) => b.id === record.prevId);
  const beside = next ? startOf(next) : prev ? endOf(prev) : null;
  if (beside !== null) {
    const before = blocks.filter((b) => startOf(b) < beside).pop();
    const after = blocks.find((b) => startOf(b) >= beside);
    if ((!before || before.time <= time) && (!after || after.time >= time)) return beside;
  }
  const later = blocks.find((b) => b.time > time);
  return later ? startOf(later) : null;
}

export function parseMemoryId(id: string): { kind: MemoryKind; rel: string } {
  if (typeof id !== 'string') throw refusal('invalid_argument', 'memory id must be a string');
  if (id.startsWith('note:')) return { kind: 'note', rel: id.slice(5) };
  if (id.startsWith('entry:')) {
    const hashAt = id.lastIndexOf('#');
    if (hashAt <= 6 || !/^[0-9a-f]{16}$/.test(id.slice(hashAt + 1))) throw refusal('invalid_argument', 'malformed entry id');
    return { kind: 'entry', rel: id.slice(6, hashAt) };
  }
  throw refusal('invalid_argument', 'unknown memory id kind');
}

// ------------------------------- helpers ------------------------------------

function collapse(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function tagsOf(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(list.map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Literal, case-insensitive, whole-word mention test. */
function mentionMatcher(name: string): RegExp | null {
  const n = name.trim();
  if (n.length < MIN_MENTION_CHARS) return null;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(n)}($|[^\\p{L}\\p{N}_])`, 'iu');
}

export const NOFOLLOW = fs.constants?.O_NOFOLLOW ?? 0;

/** Open a confined file for reading: never through a final symlink, and only the inode at `real`. */
export async function openConfined(real: string): Promise<FileHandle> {
  // O_NONBLOCK: opening a FIFO for reading waits for a writer; with it the open returns and the isFile check below refuses.
  const handle = await fs.open(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW);
  try {
    const [opened, there] = await Promise.all([handle.stat(), fs.lstat(real)]);
    if (!opened.isFile() || opened.ino !== there.ino || opened.dev !== there.dev) {
      throw new Error('memory path changed while it was being read');
    }
    return handle;
  } catch (err) {
    await handle.close();
    throw err;
  }
}

export async function readPrefix(real: string, bytes: number): Promise<{ text: string; truncated: boolean } | null> {
  let handle: FileHandle;
  try {
    handle = await openConfined(real);
  } catch {
    return null;
  }
  try {
    const size = (await handle.stat()).size;
    const buf = Buffer.alloc(Math.min(size, bytes));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: size > bytes };
  } finally {
    await handle.close();
  }
}

/** Whole-file read for a rewrite; refuses rather than silently truncating. */
export async function readWhole(real: string): Promise<string> {
  const handle = await openConfined(real);
  try {
    if ((await handle.stat()).size > MAX_REWRITE_BYTES) {
      throw new Error('this daily log is too large to edit safely; nothing was changed');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * A note file read in full so the secret guard (RENOR_SECRET_GUARD) can screen it before it is moved. A file too
 * large to hold is refused, as the guard does whenever it cannot check.
 */
async function readToScreen(real: string, action: 'retire' | 'restore'): Promise<string> {
  const handle = await openConfined(real);
  try {
    if ((await handle.stat()).size > MAX_REWRITE_BYTES) refuseUnchecked('memory', action);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Make sure a vault-relative directory exists as real directories all the way down (creating what
 * is missing) and return its real path. Refuses a symlink at any level, so neither the journal nor
 * a retired file can be written outside the vault through one.
 */
export async function ensureRealDir(rootReal: string, relDir: string): Promise<string> {
  let cursor = rootReal;
  for (const part of relDir.split(/[\\/]/).filter((p) => p && p !== '.')) {
    cursor = path.join(cursor, part);
    try {
      await fs.mkdir(cursor, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const st = await fs.lstat(cursor);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing to use ${relDir}: it is not a plain directory inside the vault`);
  }
  return cursor;
}

/** Replace a file's content atomically: a crash leaves either the old or the new bytes, never a mix. */
async function atomicWrite(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let mode: number | undefined;
  try {
    mode = (await fs.stat(abs)).mode & 0o777;
  } catch {
    mode = undefined;
  }
  const handle = await fs.open(tmp, 'wx', mode ?? 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export interface RetiredRecord {
  /** This retirement's own id (one memory can be retired, come back, and be retired again). */
  rid: string;
  /** The memory id. */
  id: string;
  kind: MemoryKind;
  path: string;
  title: string;
  retiredAt: string;
  /** entry: the exact bytes of the entry, and how many copies were removed. */
  block?: string;
  copies?: number;
  /** entry: the ids of the entries that stood just before and just after it when it was retired (where restore puts it back). */
  prevId?: string;
  nextId?: string;
  /**
   * entry: what was left of its daily log, when this was the log's last entry and the log went with it (its header:
   * the engine's front matter and the day's heading). Restore writes it back above the entry.
   */
  remainder?: string;
  /** note: where the file was moved, vault-relative. */
  storedAt?: string;
  restoredAt?: string;
  /** Set when a retirement was found not to have completed; the memory never left. */
  voided?: boolean;
  /**
   * Set on the one record a permanent deletion leaves in place of a retirement's records (purgeRetired): the rid, the
   * kind and the time, never the id, path, title or text. It also says `voided`, so an engine from before this field
   * reads it as an ended retirement and never lists it.
   */
  purgedAt?: string;
}

export async function readJournal(ctx: MemoryMapContext): Promise<RetiredRecord[]> {
  const rootReal = await fs.realpath(ctx.memoryDir);
  let raw: string;
  try {
    // Confined like every other read: never through a symlinked .trash or journal.
    for (const dir of [path.join(rootReal, '.trash'), path.join(rootReal, RETIRED_DIR)]) {
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('the retired-memory journal is not inside the vault');
    }
    const handle = await openConfined(path.join(rootReal, RETIRED_INDEX));
    try {
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: RetiredRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RetiredRecord);
    } catch {
      // A torn final line (crash mid-append) is skipped, never fatal.
    }
  }
  return out;
}

/** Retirements still in effect (the latest record per retirement wins; a restore or a void ends it). */
export function activeRetired(records: RetiredRecord[]): RetiredRecord[] {
  const latest = new Map<string, RetiredRecord>();
  for (const r of records) if (typeof r.rid === 'string') latest.set(r.rid, r);
  return [...latest.values()].filter((r) => !r.restoredAt && !r.voided && !r.purgedAt);
}

async function appendJournal(ctx: MemoryMapContext, record: RetiredRecord): Promise<void> {
  const dir = await ensureRealDir(await fs.realpath(ctx.memoryDir), RETIRED_DIR);
  const file = path.join(dir, path.basename(RETIRED_INDEX));
  // O_NONBLOCK: a FIFO planted under the journal's name is an error here, never a wait.
  const handle = await fs.open(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`refusing to write ${JSON.stringify(RETIRED_INDEX)}: it is not a regular file with a single name`);
    // A crash can leave a torn last line; start on a fresh line so this record is never glued to it.
    const size = stat.size;
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    await handle.appendFile(prefix + JSON.stringify(record) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Retire/restore events carry the memory id and its title as JSON in `summary`. */
function recordEvent(db: Database.Database, rel: string, action: 'retire' | 'restore', id: string, title: string): void {
  db.prepare('INSERT INTO write_events (note_path, action, summary, created_at) VALUES (?, ?, ?, ?)')
    .run(rel, action, JSON.stringify({ id, title }), new Date().toISOString());
}

function parseEventRef(summary: string | null): { id: string | null; title: string | null } {
  try {
    const v = JSON.parse(summary ?? '') as { id?: unknown; title?: unknown };
    return { id: typeof v.id === 'string' ? v.id : null, title: typeof v.title === 'string' ? v.title : null };
  } catch {
    return { id: null, title: summary };
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------- map ----------------------------------------

interface NoteRow { path: string; title: string; modified_at: string; frontmatter_json: string }

interface Collected {
  /** Newest first. */
  memories: MapMemory[];
  truncated: boolean;
  /** The text each memory is matched and mentioned by: an entry's statement, a note's title and body. */
  text: Map<string, string>;
  wikilinks: Map<string, string[]>;
  /** Every memory read, kept or not: what is still live (without `keep`, exactly the memories collected). */
  seen: Set<string>;
}

/**
 * Whether a daily log is too large to be read whole, so a read of it would be cut and the map marked truncated. A note
 * a lookup does not read is still counted by this, through the same confinement a read applies.
 */
async function readsWhole(ctx: MemoryMapContext, stored: string): Promise<boolean> {
  // Most daily logs are far below the size, so the confinement check runs only for the few that could be cut.
  try {
    if (statSync(path.resolve(ctx.memoryDir, stored)).size <= MAX_REWRITE_BYTES) return false;
  } catch {
    return false;
  }
  try {
    const file = await resolveVaultFile(ctx, stored, true);
    return (await fs.stat(file.real)).size > MAX_REWRITE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Whether a note's file has changed since it was indexed: its text may then hold words the index does not. A synchronous
 * stat: one per note, and a queued async call per note cost about 2 s on a loaded host where the stats themselves take 50 ms.
 */
function changedSinceIndexed(memoryDir: string, n: NoteRow): boolean {
  try {
    return statSync(path.resolve(memoryDir, n.path)).mtime.toISOString() !== n.modified_at;
  } catch {
    return true;
  }
}

/**
 * The notes with a chunk the predicate accepts, read from the index's chunk text. A note's chunks are its body cut at line
 * breaks (a word never spans one), so a word the note's body holds is in one chunk, at the same place in its line. It
 * can therefore only be a candidate here, never a verdict: keep still decides on the file's own text.
 */
function notesWithIndexedText(db: Database.Database, hasWord: (text: string) => boolean): Set<string> {
  const out = new Set<string>();
  const rows = db.prepare('SELECT note_path, text FROM chunks').iterate() as Iterable<{ note_path: string; text: string }>;
  for (const row of rows) {
    if (!out.has(row.note_path) && hasWord(row.text)) out.add(row.note_path);
  }
  return out;
}

/**
 * The daily logs that hold a retired entry. Their entries are read whole, because a retirement counts only once its entry
 * is gone from its log.
 */
async function retiredEntryFiles(ctx: MemoryMapContext): Promise<Set<string>> {
  return new Set(activeRetired(await readJournal(ctx)).filter((r) => r.kind === 'entry').map((r) => r.path));
}

/**
 * Every memory a person can open, newest first: each note file and each entry of a daily log. With `keep`, only the
 * memories it keeps are collected, the cap counts those alone, and a daily log's every entry is considered rather than
 * its newest ones, so a lookup reaches any memory the scan reads.
 */
async function collectMemories(
  ctx: MemoryMapContext,
  keep?: (memory: MapMemory, text: string) => boolean,
  mayMatch?: (note: NoteRow) => Promise<boolean>,
): Promise<Collected> {
  const { db, memoryDir } = ctx;
  const notes = db.prepare(
    `SELECT path, title, modified_at, frontmatter_json FROM notes ORDER BY modified_at DESC LIMIT ?`,
  ).all(MAX_NOTES_SCANNED + 1) as NoteRow[];

  const memories: MapMemory[] = [];
  const text = new Map<string, string>();
  const wikilinks = new Map<string, string[]>();
  const seen = new Set<string>();
  const bound = createNoteTimeBound(db);
  let truncated = notes.length > MAX_NOTES_SCANNED;
  const add = (memory: MapMemory, said: string): boolean => {
    seen.add(memory.id);
    if (keep && !keep(memory, said)) return false;
    memories.push(memory);
    text.set(memory.id, said);
    return true;
  };

  for (const n of notes.slice(0, MAX_NOTES_SCANNED)) {
    if (memories.length >= MAX_MEMORIES) {
      truncated = true;
      break;
    }
    if (n.path === LIFECYCLE_NOTE_PATH || isLedgerIndexed(ctx, n.path)) continue;
    const stored = toRel(memoryDir, n.path);
    if (!stored) continue;
    // A note that cannot match is not read at all: keep would refuse every memory in it.
    if (mayMatch && !(await mayMatch(n))) {
      if (DAILY_FILE_RE.test(stored) && (await readsWhole(ctx, stored))) truncated = true;
      continue;
    }
    // The same confinement as read/retire: a note reached through a symlink, a hidden directory or
    // an alias of the ledger is not listed.
    let file: VaultFile;
    try {
      file = await resolveVaultFile(ctx, stored, true);
    } catch {
      continue;
    }
    const rel = file.rel;
    const daily = DAILY_FILE_RE.exec(rel);
    const read = await readPrefix(file.real, daily ? MAX_REWRITE_BYTES : MAP_READ_BYTES);
    if (read === null) continue; // indexed but gone from disk: not a memory a person can open
    let fm: Record<string, unknown> = {};
    try { fm = JSON.parse(n.frontmatter_json) as Record<string, unknown>; } catch { /* keep {} */ }

    if (daily) {
      const { blocks } = parseEntries(rel, read.text);
      const dated = blocks.map((b) => ({ b, at: entryAt(bound, n.path, daily[2], b, n.modified_at) }));
      const newest = keep ? dated : [...dated].sort((x, y) => y.at.localeCompare(x.at)).slice(0, MAX_ENTRIES_PER_DAY);
      if (newest.length < blocks.length) truncated = true;
      // An entry past the cap was still read, so it is live: a retirement of it that never completed is not listed.
      for (const b of blocks) seen.add(b.id);
      for (const { b, at } of newest) {
        add({
          id: b.id, kind: 'entry', path: rel,
          title: collapse(b.text, 90),
          at,
          source: b.source || null,
          tags: [], status: null,
          excerpt: collapse(b.text, EXCERPT_CHARS),
        }, b.text);
      }
      if (read.truncated) truncated = true;
      continue;
    }
    const parsed = parseNote(n.path, read.text);
    const id = `note:${rel}`;
    const kept = add({
      id, kind: 'note', path: rel,
      title: n.title,
      at: n.modified_at,
      source: typeof fm.source === 'string' ? fm.source : null,
      tags: tagsOf(fm),
      status: typeof fm.status === 'string' ? fm.status : null,
      excerpt: collapse(parsed.body.replace(/^#\s+.*$/m, ''), EXCERPT_CHARS),
    }, `${n.title}\n${parsed.body}`);
    if (kept) wikilinks.set(id, parsed.wikilinks);
  }

  memories.sort((a, b) => b.at.localeCompare(a.at));
  return { memories, truncated, text, wikilinks, seen };
}

type RetiredMemory = MemoryMap['retired'][number];

interface Retirement {
  memory: RetiredMemory;
  /** A retired entry's text, which the journal keeps; a note's is in its stored copy instead. */
  text: string;
  /** Where a retired note's copy is stored, vault-relative: read only by a lookup, which matches its body. */
  storedAt?: string;
  /** A retired fact's scope (a note's is its path). */
  scope?: string;
}

/**
 * Retirements that completed, newest first (a note's file is in the retired area; an entry is no longer among `live`).
 * An interrupted one is still a live memory and is not listed twice.
 */
async function completedRetirements(ctx: MemoryMapContext, live: Set<string>): Promise<Retirement[]> {
  const rootReal = await fs.realpath(ctx.memoryDir);
  const out: Retirement[] = [];
  for (const r of activeRetired(await readJournal(ctx)).reverse()) {
    const completed = r.kind === 'entry'
      ? !live.has(r.id)
      : Boolean(r.storedAt) && (await exists(path.join(rootReal, ...r.storedAt!.split('/'))));
    if (!completed) continue;
    const day = DAILY_FILE_RE.exec(r.path)?.[2];
    const header = r.block ? parseEntryHeader(r.block.split('\n')[0]) : null;
    out.push({
      memory: {
        id: r.rid, memoryId: r.id, kind: r.kind, path: r.path, title: r.title, retiredAt: r.retiredAt,
        // A retired entry's file is gone, so no note row bounds it; it was saved before it was retired, so that time caps it.
        ...(r.kind === 'entry' && day && header ? { savedAt: clampSessionDate(entryInstant(day, header), r.retiredAt) ?? r.retiredAt } : {}),
      },
      text: r.block ?? '',
      ...(r.kind === 'note' && r.storedAt ? { storedAt: r.storedAt } : {}),
    });
  }
  const facts: Retirement[] = listRetiredFacts(ctx.db).map((f) => ({
    memory: { id: f.id, memoryId: f.id, kind: 'fact', path: ctx.ledgerRelPath, title: f.title, retiredAt: f.retiredAt },
    text: f.title,
    scope: f.scope,
  }));
  // Both lists are newest first; the sort is stable.
  return [...out, ...facts].sort((a, b) => b.memory.retiredAt.localeCompare(a.memory.retiredAt));
}

/**
 * The body of a retired note's stored copy, for a lookup to match. Only a copy inside the retired area, reached through
 * real directories, is read (the checks restore makes before it moves the copy back), and as much of it as the map
 * reads of a live note.
 */
async function retiredNoteBody(rootReal: string, storedAt: string): Promise<string> {
  const stored = path.join(rootReal, ...storedAt.split('/'));
  if (!within(path.join(rootReal, RETIRED_FILES_DIR), stored)) return '';
  try {
    if ((await fs.realpath(path.dirname(stored))) !== path.dirname(stored)) return '';
  } catch {
    return '';
  }
  const read = await readPrefix(stored, MAP_READ_BYTES);
  return read === null ? '' : parseNote(stored, read.text).body;
}

export interface MemoryMapOptions {
  /**
   * At most this many of each list (memories, things, facts, links, events, retired), newest first; things come by their
   * newest fact, so the facts listed name things listed. Links are shared out across their kinds and drawn only between
   * what the reply lists. Default DEFAULT_MAP_LIMIT.
   */
  limit?: number;
}

export async function buildMemoryMap(ctx: MemoryMapContext, options: MemoryMapOptions = {}): Promise<MemoryMap> {
  const { db } = ctx;
  const cap = options.limit ?? DEFAULT_MAP_LIMIT;
  const collected = await collectMemories(ctx);
  const memories = collected.memories;
  const mentionText = collected.text;
  const wikilinksOf = collected.wikilinks;

  const shown = memories.slice(0, cap);
  const truncatedMemories = collected.truncated || memories.length > cap;

  // Wikilink targets: an exact vault path wins; a bare name or title links only when unambiguous across the whole vault.
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const m of memories) {
    if (m.kind !== 'note') continue;
    byPath.set(m.path.replace(/\.md$/i, '').toLowerCase(), m.id);
    for (const key of new Set([path.posix.basename(m.path, '.md').toLowerCase(), m.title.toLowerCase()])) {
      byName.set(key, [...(byName.get(key) ?? []), m.id]);
    }
  }
  const resolveWikilink = (target: string): string | null => {
    const t = target.trim().replace(/\.md$/i, '').toLowerCase();
    if (byPath.has(t)) return byPath.get(t)!;
    if (t.includes('/')) return null; // a path that names no note is not guessed from its basename
    const candidates = byName.get(t) ?? [];
    return candidates.length === 1 ? candidates[0] : null;
  };

  // Things: the subjects of lifecycle (ledger) facts, by their newest fact in the same order the facts list uses. So the
  // newest `limit` facts always name things the reply lists: a thing with a newer fact ranks above it.
  const thingRows = db.prepare(
    `SELECT e.id, e.canonical_name AS name,
            SUM(CASE WHEN f.valid_to IS NULL THEN 1 ELSE 0 END) AS current,
            (SELECT g.valid_from FROM facts g WHERE g.subject_entity_id = e.id AND g.source_path = ?
              ORDER BY g.valid_from DESC, g.id DESC LIMIT 1) AS newest_from,
            (SELECT g.id FROM facts g WHERE g.subject_entity_id = e.id AND g.source_path = ?
              ORDER BY g.valid_from DESC, g.id DESC LIMIT 1) AS newest_id
       FROM entities e JOIN facts f ON f.subject_entity_id = e.id AND f.source_path = ?
      WHERE e.source_note = ?
      GROUP BY e.id ORDER BY newest_from DESC, newest_id DESC, e.canonical_name LIMIT ?`,
  ).all(LIFECYCLE_NOTE_PATH, LIFECYCLE_NOTE_PATH, LIFECYCLE_NOTE_PATH, LIFECYCLE_NOTE_PATH, MAX_THINGS + 1) as Array<{ id: number; name: string; current: number }>;
  const truncatedThings = thingRows.length > MAX_THINGS;
  const allThings: MapThing[] = thingRows.slice(0, MAX_THINGS).map((t) => ({ id: `thing:${t.id}`, name: t.name, currentFacts: t.current }));
  const things = allThings.slice(0, cap);

  // Facts: every lifecycle fact of a ledger thing, newest first. Not cut to the listed things: each fact names its subject.
  const factRows = db.prepare(
    `SELECT f.id, f.subject_entity_id AS sid, e.canonical_name AS subject, f.predicate, f.object_text AS object,
            f.valid_from, f.valid_to, f.scope, f.event_id
       FROM facts f JOIN entities e ON e.id = f.subject_entity_id
      WHERE f.source_path = ? AND e.source_note = ?
      ORDER BY f.valid_from DESC, f.id DESC LIMIT ?`,
  ).all(LIFECYCLE_NOTE_PATH, LIFECYCLE_NOTE_PATH, MAX_FACTS + 1) as Array<{ id: number; sid: number; subject: string; predicate: string; object: string | null; valid_from: string; valid_to: string | null; scope: string; event_id: string | null }>;
  const allFacts: MapFact[] = factRows.slice(0, MAX_FACTS).map((f) => ({
    id: f.id, thingId: `thing:${f.sid}`, subject: f.subject, predicate: f.predicate,
    object: f.object ?? '', validFrom: f.valid_from, validTo: f.valid_to, scope: f.scope, eventId: f.event_id,
  }));
  // A fact's object is shown as an excerpt (the link search below reads the whole object): a map is for browsing, and
  // get_context returns the fact in full. A current fact that replaced another writer's value carries its conflict line.
  const disputes = writerConflictLines(db, allFacts.slice(0, cap).map((f) => (f.validTo === null ? f.eventId : null)));
  const facts: MapFact[] = allFacts.slice(0, cap).map((f) => {
    const line = f.validTo === null && f.eventId !== null ? disputes.get(f.eventId) : undefined;
    return { ...f, object: collapse(f.object, EXCERPT_CHARS), ...(line === undefined ? {} : { writerConflict: line }) };
  });
  const truncatedFacts = factRows.length > MAX_FACTS || allFacts.length > cap;

  // Links over the whole map, then only those between what the reply lists (no link points at a missing node). Each kind
  // has its own bucket and its own build cap, so a vault with many tags cannot starve the mention and fact links; the
  // total counts every link the map holds, so `truncated` says more exist even when the listed nodes have few.
  // `seq` is the order the links were found in: the reply lists the links it keeps in that order.
  const linksByKind: Record<MapLinkKind, Array<{ seq: number; link: MapLink }>> = { tag: [], wikilink: [], mention: [], fact: [] };
  let linkSeq = 0;
  let truncatedLinks = false;
  const push = (l: MapLink) => {
    const bucket = linksByKind[l.kind];
    if (bucket.length >= MAX_LINKS) {
      truncatedLinks = true;
      return false;
    }
    bucket.push({ seq: linkSeq++, link: l });
    return true;
  };
  const topicCount = new Map<string, number>();
  for (const m of shown) {
    for (const t of m.tags) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
  }
  for (const m of memories) {
    for (const t of m.tags) push({ source: m.id, target: `topic:${t}`, kind: 'tag' });
    for (const w of wikilinksOf.get(m.id) ?? []) {
      const target = resolveWikilink(w);
      if (target && target !== m.id) push({ source: m.id, target, kind: 'wikilink' });
    }
  }
  const matchers = allThings
    .map((t) => ({
      id: t.id, re: mentionMatcher(t.name),
      // For ASCII names, absence of the folded literal proves absence of a /iu match.
      // Non-ASCII names still use the regex alone (Unicode folding is not lowercasing).
      literal: /^[\x00-\x7f]+$/.test(t.name.trim()) ? t.name.trim().toLowerCase() : null,
    }))
    .filter((t): t is { id: string; re: RegExp; literal: string | null } => t.re !== null);
  const hasLiteral = matchers.some((t) => t.literal !== null);
  // Long s and Kelvin sign are the only non-ASCII letters /iu folds to ASCII. Lowercasing
  // handles Kelvin; long s needs an explicit fold. The regex still decides boundaries.
  const fold = (text: string) => hasLiteral ? text.toLowerCase().replace(/\u017f/g, 's') : '';
  outer: for (const m of memories) {
    const text = mentionText.get(m.id) ?? '';
    const folded = fold(text);
    for (const t of matchers) {
      if (t.literal !== null && !folded.includes(t.literal)) continue;
      if (t.re.test(text) && !push({ source: m.id, target: t.id, kind: 'mention' })) break outer;
    }
  }
  const seenFactLink = new Set<string>();
  outerFacts: for (const f of allFacts) {
    if (f.validTo !== null) continue;
    const folded = fold(f.object);
    for (const t of matchers) {
      if (t.id === f.thingId || (t.literal !== null && !folded.includes(t.literal)) || !t.re.test(f.object)) continue;
      const key = `${f.thingId}|${t.id}|${f.predicate}`;
      if (seenFactLink.has(key)) continue;
      seenFactLink.add(key);
      if (!push({ source: f.thingId, target: t.id, kind: 'fact', label: f.predicate })) break outerFacts;
    }
  }
  const topics = [...topicCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ id: `topic:${name}`, name, memories: count }));

  // Events: what the engine itself recorded, newest first. The save of a fact that is retired now is left out, as the
  // fact is: its summary names the value, at the fact's own time.
  const eventRows = db.prepare(
    `SELECT note_path, action, summary, created_at, author FROM write_events w
      WHERE NOT (w.note_path = '_memory_ledger_' AND w.action IN ('store', 'supersede') AND EXISTS (
        SELECT 1 FROM retired_facts r WHERE r.valid_from = w.created_at AND instr(w.summary, ' ' || r.predicate || ' → ' || r.object_text) > 0))
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(MAX_EVENTS + 1) as Array<{ note_path: string; action: string; summary: string | null; created_at: string; author: string | null }>;
  const allEvents: MapEvent[] = eventRows.slice(0, MAX_EVENTS).map((e) => {
    if (e.action === 'retire' || e.action === 'restore') {
      const ref = parseEventRef(e.summary);
      return { at: e.created_at, action: e.action, memoryId: ref.id, summary: ref.title, ...(e.author ? { source: e.author } : {}) };
    }
    return { at: e.created_at, action: e.action, memoryId: null, summary: e.summary, ...(e.author ? { source: e.author } : {}) };
  });
  const events = allEvents.slice(0, cap).map((e) => ({ ...e, summary: e.summary === null ? null : collapse(e.summary, EXCERPT_CHARS) }));

  // Retired: only retirements that completed, newest first.
  const retiredAll = (await completedRetirements(ctx, collected.seen)).map((r) => r.memory);
  const retired = retiredAll.slice(0, Math.min(MAX_RETIRED_LISTED, cap));
  // A link joins two nodes the reply lists: a memory or a topic of a listed memory, or a listed thing.
  const listed = new Set<string>([...shown.map((m) => m.id), ...things.map((t) => t.id), ...topics.map((t) => t.id)]);
  // The reply's links are shared out across the kinds, one each in turn, so every kind that exists keeps its share of
  // `limit` (a kind with fewer links gives its turns to the others). The reply never holds more than `limit` links.
  const kindOrder: MapLinkKind[] = ['tag', 'wikilink', 'mention', 'fact'];
  const shownByKind = kindOrder.map((k) => linksByKind[k].filter(({ link: l }) => listed.has(l.source) && listed.has(l.target)));
  const kept: Array<{ seq: number; link: MapLink }> = [];
  for (let turn = 0; kept.length < cap; turn++) {
    const picks = shownByKind.flatMap((bucket) => (turn < bucket.length ? [bucket[turn]] : []));
    if (picks.length === 0) break;
    kept.push(...picks.slice(0, cap - kept.length));
  }
  const links = kept.sort((a, b) => a.seq - b.seq).map((k) => k.link);
  const totalLinks = kindOrder.reduce((sum, k) => sum + linksByKind[k].length, 0);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    limit: cap,
    memories: shown,
    things,
    topics,
    facts,
    links,
    events,
    retired,
    total: {
      memories: memories.length,
      things: allThings.length,
      facts: allFacts.length,
      links: totalLinks,
      events: allEvents.length,
      retired: retiredAll.length,
    },
    truncated: {
      memories: truncatedMemories,
      things: truncatedThings || allThings.length > cap,
      facts: truncatedFacts,
      links: truncatedLinks || totalLinks > links.length,
      events: eventRows.length > MAX_EVENTS || allEvents.length > cap,
      retired: retiredAll.length > retired.length,
    },
  };
}

export interface MemoryLookup {
  ok: true;
  generatedAt: string;
  query: string;
  /** The scope looked in, when the lookup named one. */
  scope?: NormalizedScope;
  /** The memories found, best first (see `findMemories`). */
  memories: MapMemory[];
  /** Retired memories found the same way: `id` is what restore_memory takes. */
  retired: MemoryMap['retired'];
  /** More were found than `limit`, or the scan stopped at its cap and may have missed some. */
  truncated: { memories: boolean; retired: boolean };
}

/**
 * The memories a few words find, so one can be read, retired or restored without loading the whole map: every memory
 * whose path, title or text has a word starting with one of `terms` (lowercase words, as `atoms` gives them), and every
 * retired memory whose path, title or stored text has one (an entry's text from the journal, a note's from its copy in
 * the retired area). A term matches at the start of a word, so "rent" finds
 * "rented" but not "current". A term counts for more the fewer memories have it, so the memory that has the rare word
 * of "the note about my landlord" comes before the many that only say "note"; equal ones stay newest first. At most
 * `limit` of each. With `scope`, only the memories in that scope (by path, the rule every note read follows) are looked
 * at, before the cap: the lookup used to look everywhere, and finding one memory to forget cost a lookup of the whole
 * workspace (live dogfood, 2026-10-03, D12).
 */
export async function findMemories(
  ctx: MemoryMapContext,
  args: { query: string; terms: string[]; limit: number; scope?: NormalizedScope },
): Promise<MemoryLookup> {
  const inScope = (rel: string) => args.scope === undefined || notePathMatchesScope(rel, args.scope);
  const patterns = [...new Set(args.terms)].map((t) => new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escapeRe(t)}`, 'u'));
  const termsIn = (...parts: string[]): number[] => {
    const text = parts.join('\n').toLowerCase();
    return patterns.flatMap((re, i) => (re.test(text) ? [i] : []));
  };
  /** Each found item first by the summed rarity of the terms it has; the sort is stable, so the given order breaks ties. */
  const best = <T>(found: Array<{ item: T; terms: number[] }>): T[] => {
    const holders = patterns.map((_, i) => found.filter((f) => f.terms.includes(i)).length);
    const weight = (terms: number[]) => terms.reduce((sum, i) => sum + 1 / holders[i], 0);
    return found.map((f) => ({ item: f.item, w: weight(f.terms) })).sort((a, b) => b.w - a.w).map((f) => f.item);
  };

  const matched = new Map<string, number[]>();
  // Only the notes that can hold one of the words are read: the index names them, and a note whose file changed since
  // it was indexed is read anyway. A retired entry's daily log is always read, as its liveness is decided by reading it.
  const retiredDays = await retiredEntryFiles(ctx);
  const indexed = notesWithIndexedText(ctx.db, (text) => termsIn(text).length > 0);
  const collected = await collectMemories(ctx, (m, text) => {
    if (!inScope(m.path)) return false;
    const terms = termsIn(m.path, m.title, text);
    if (terms.length > 0) matched.set(m.id, terms);
    return terms.length > 0;
  }, async (n) => {
    // The index keeps each note under its absolute path; the journal and the scope use the vault-relative one.
    const rel = toRel(ctx.memoryDir, n.path) ?? '';
    if (retiredDays.has(rel)) return true;
    if (!inScope(rel)) return false;
    return termsIn(rel, n.title).length > 0 || indexed.has(n.path) || changedSinceIndexed(ctx.memoryDir, n);
  });
  const memories = best(collected.memories.map((m) => ({ item: m, terms: matched.get(m.id)! })));
  const rootReal = await fs.realpath(ctx.memoryDir);
  const foundRetired: Array<{ item: RetiredMemory; terms: number[] }> = [];
  for (const r of await completedRetirements(ctx, collected.seen)) {
    if (r.scope !== undefined ? args.scope !== undefined && !savedScopeMatches(r.scope, args.scope) : !inScope(r.memory.path)) continue;
    const terms = termsIn(r.memory.path, r.memory.title, r.storedAt ? await retiredNoteBody(rootReal, r.storedAt) : r.text);
    if (terms.length > 0) foundRetired.push({ item: r.memory, terms });
  }
  const retired = best(foundRetired);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    query: args.query,
    ...(args.scope === undefined ? {} : { scope: args.scope }),
    memories: memories.slice(0, args.limit),
    retired: retired.slice(0, args.limit),
    truncated: { memories: collected.truncated || memories.length > args.limit, retired: retired.length > args.limit },
  };
}

// ------------------------------- read ---------------------------------------

export interface MemoryDetail {
  ok: true;
  memory: MapMemory;
  /** Full text (capped), without frontmatter. */
  text: string;
  textTruncated: boolean;
  /** Note metadata from frontmatter: title, status, owner, updated, tags only (METADATA_KEYS) — not facts. */
  metadata: Record<string, string>;
  /** Facts the indexer extracted from this note (model extraction lane), when any. */
  facts: Array<{ predicate: string; object: string; validFrom: string; validTo: string | null }>;
}

export async function readMemory(ctx: MemoryMapContext, id: string): Promise<MemoryDetail> {
  const ref = parseMemoryId(id);
  const file = await resolveVaultFile(ctx, ref.rel, true);
  await assertNotExcluded(ctx, file);

  if (ref.kind === 'entry') {
    const daily = DAILY_FILE_RE.exec(file.rel);
    if (!daily) throw refusal('memory_not_found', 'memory not found');
    const block = parseEntries(file.rel, await readWhole(file.real)).blocks.find((b) => b.id === id);
    if (!block) throw refusal('memory_not_found', 'memory not found (it may have been retired)');
    // The same bound the list shows the entry with: its note's indexed write time (main's createNoteTimeBound).
    const written = (ctx.db.prepare('SELECT modified_at FROM notes WHERE path = ?').get(file.indexed) as { modified_at: string } | undefined)?.modified_at
      ?? (await fs.stat(file.real)).mtime.toISOString();
    const dated = createNoteTimeBound(ctx.db)(file.indexed, entryInstant(daily[2], block));
    return {
      ok: true,
      memory: {
        id, kind: 'entry', path: file.rel, title: collapse(block.text, 90), at: dated ?? written,
        ...(dated ? { session_date: dated } : {}),
        source: block.source || null, tags: [], status: null, excerpt: collapse(block.text, EXCERPT_CHARS),
      },
      text: block.text.slice(0, MAX_READ_CHARS),
      textTruncated: block.text.length > MAX_READ_CHARS,
      metadata: {},
      facts: [],
    };
  }

  const read = await readPrefix(file.real, READ_BYTES);
  if (read === null) throw refusal('memory_not_found', 'memory not found (it may have been retired)');
  const parsed = parseNote(file.indexed, read.text);
  const row = ctx.db.prepare('SELECT title, modified_at, frontmatter_json FROM notes WHERE path = ?').get(file.indexed) as
    { title: string; modified_at: string; frontmatter_json: string } | undefined;
  const dated = row ? resolveSessionDate(row.frontmatter_json, row.modified_at) : undefined;
  // Only the documented keys are copied. A front-matter key the type does not name stays in the note and the export.
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.frontmatter)) {
    if (!METADATA_KEYS.has(k) || v === null || v === undefined) continue;
    metadata[k] = Array.isArray(v) ? v.map(String).join(', ') : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  }
  const factRows = ctx.db.prepare(
    `SELECT predicate, object_text AS object, valid_from, valid_to FROM facts WHERE source_path = ? ORDER BY id`,
  ).all(file.indexed) as Array<{ predicate: string; object: string | null; valid_from: string; valid_to: string | null }>;
  const body = parsed.body;
  return {
    ok: true,
    memory: {
      // A note not indexed yet is dated by its file, as an entry is above.
      id, kind: 'note', path: file.rel, title: row?.title ?? parsed.title, at: row?.modified_at ?? (await fs.stat(file.real)).mtime.toISOString(),
      ...(dated ? { session_date: dated } : {}),
      source: typeof parsed.frontmatter.source === 'string' ? parsed.frontmatter.source : null,
      tags: tagsOf(parsed.frontmatter),
      status: typeof parsed.frontmatter.status === 'string' ? parsed.frontmatter.status : null,
      excerpt: collapse(body, EXCERPT_CHARS),
    },
    text: body.slice(0, MAX_READ_CHARS),
    textTruncated: body.length > MAX_READ_CHARS || read.truncated,
    metadata,
    facts: factRows
      .filter((f) => !METADATA_PREDICATES.has(f.predicate))
      .map((f) => ({ predicate: f.predicate, object: f.object ?? '', validFrom: f.valid_from, validTo: f.valid_to })),
  };
}

// ------------------------------- retire / restore ---------------------------

let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn, fn);
  chain = result.then(() => undefined, () => undefined);
  return result;
}

/** Remove a note's derived rows (chunks, FTS, entities, structured rows cascade) and its vectors. */
function dropNoteFromIndex(ctx: MemoryMapContext, indexed: string): void {
  const chunkIds = (ctx.db.prepare('SELECT id FROM chunks WHERE note_path = ?').all(indexed) as Array<{ id: number }>).map((r) => r.id);
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM facts WHERE source_path = ?').run(indexed);
    ctx.db.prepare('DELETE FROM relations WHERE source_note = ?').run(indexed);
    ctx.db.prepare('DELETE FROM notes WHERE path = ?').run(indexed);
  })();
  for (const id of chunkIds) ctx.indexOptions.vectorIndex?.delete(id);
}

/**
 * Settle retirements and restores an earlier crash interrupted, so the journal, the files and the
 * index agree again:
 *  - note, file never moved (no stored copy, original present): void the record and re-index the
 *    note (its index rows may already have been dropped);
 *  - note, moved but index rows survived: drop them;
 *  - note, restored on disk but the journal not yet told (original present, stored copy gone):
 *    covered by the first case;
 *  - entry still in its file: void the record (the retirement never happened, or it was restored);
 *  - entry gone from its file: re-index the file, so a crash between the rewrite and the index
 *    update never leaves retired text searchable.
 */
async function reconcile(ctx: MemoryMapContext): Promise<void> {
  const rootReal = await fs.realpath(ctx.memoryDir);
  const journal = await readJournal(ctx);
  await removePurgedCopies(rootReal, journal);
  for (const r of activeRetired(journal)) {
    let file: VaultFile;
    try {
      file = await resolveVaultFile(ctx, r.path, false);
    } catch {
      continue; // a record that no longer resolves safely is left alone, never acted on
    }
    if (r.kind === 'note') {
      const stored = r.storedAt ? path.join(rootReal, ...r.storedAt.split('/')) : null;
      const storedThere = stored ? await exists(stored) : false;
      const originalThere = await exists(file.real);
      if (!storedThere && originalThere) {
        // Index first: if it fails, the record stays open and the next attempt repairs it again.
        await indexFile(ctx.db, file.indexed, ctx.indexOptions);
        await appendJournal(ctx, voidRecord(r));
      } else if (storedThere && !originalThere) {
        if (ctx.db.prepare('SELECT 1 FROM notes WHERE path = ?').get(file.indexed)) dropNoteFromIndex(ctx, file.indexed);
      }
      continue;
    }
    if (!(await exists(file.real))) continue;
    const present = await withDailyFileLock(file.indexed, async () =>
      parseEntries(file.rel, await readWhole(file.real)).blocks.some((b) => b.id === r.id));
    await indexFile(ctx.db, file.indexed, ctx.indexOptions);
    if (present) await appendJournal(ctx, voidRecord(r));
  }
}

export interface RetireReceipt {
  ok: true;
  id: string;
  action: 'retired' | 'restored';
  title: string;
  at: string;
}

/**
 * The record that ends an interrupted retirement. It is never read for its text, so while the secret guard is on
 * it does not carry a second copy of the block, which may be what the guard would have refused to retire.
 */
function voidRecord(r: RetiredRecord): RetiredRecord {
  const voided: RetiredRecord = { ...r, voided: true };
  if (secretGuardEnabled()) delete voided.block;
  return voided;
}

function newRid(): string {
  return `retired:${crypto.randomBytes(8).toString('hex')}`;
}

export function retireMemory(ctx: MemoryMapContext, id: string, expectedHash?: string): Promise<RetireReceipt | FactRetirementReceipt> {
  if (factEventId(id) !== null) return retireFact(ctx.db, ctx.memoryDir, ctx.ledgerRelPath, id, ctx.source);
  return serialize(async () => {
    await reconcile(ctx);
    const ref = parseMemoryId(id);
    const file = await resolveVaultFile(ctx, ref.rel, true);
    await assertNotExcluded(ctx, file);
    const rootReal = await fs.realpath(ctx.memoryDir);
    const at = new Date().toISOString();
    const rid = newRid();

    if (ref.kind === 'entry') {
      if (!DAILY_FILE_RE.test(file.rel)) throw refusal('memory_not_found', 'memory not found');
      const { title, emptied } = await withDailyFileLock(file.indexed, async () => {
        const { lines, blocks } = parseEntries(file.rel, await readWhole(file.real));
        const block = blocks.find((b) => b.id === id);
        if (!block) throw refusal('memory_not_found', 'memory not found (it may already be retired)');
        const entryTitle = collapse(block.text, 90);
        // RENOR_SECRET_GUARD (default ON): retiring copies the block into the journal, so a block the scanner flags
        // is not retired, and nothing has been written yet.
        if (secretGuardEnabled()) {
          await assertStorable([{ field: 'memory', text: block.raw }, { field: 'title', text: entryTitle }], 'retire');
        }
        const rest = withoutRanges(lines, block.ranges).join('\n');
        // The log's last entry takes the log with it. What is left is the engine's own header: no memory, yet it stayed
        // indexed as a note, an entity and a chunk, and with no entry in it no id could retire it (live dogfood,
        // 2026-10-03, D11). Its bytes go into the record, which restore writes back.
        const lastEntry = isEmptyEngineDailyNote(file.rel, rest);
        // Journal first: a crash before the rewrite leaves the entry in place and the record void.
        await appendJournal(ctx, {
          rid, id, kind: 'entry', path: file.rel, title: entryTitle, retiredAt: at, block: block.raw, copies: block.ranges.length,
          ...entryNeighbours(blocks, block),
          ...(lastEntry ? { remainder: rest } : {}),
        });
        if (lastEntry) {
          // Out of the index first, as a retired note is: a crash before the file goes leaves the entry in place, and
          // reconcile voids the record and indexes the file again.
          dropNoteFromIndex(ctx, file.indexed);
          await fs.unlink(file.real);
        } else {
          await atomicWrite(file.real, rest);
        }
        return { title: entryTitle, emptied: lastEntry };
      });
      if (!emptied) await indexFile(ctx.db, file.indexed, ctx.indexOptions);
      recordEvent(ctx.db, file.rel, 'retire', id, title);
      return { ok: true, id, action: 'retired', title, at };
    }

    const title = (ctx.db.prepare('SELECT title FROM notes WHERE path = ?').get(file.indexed) as { title: string } | undefined)?.title
      ?? parseNote(file.indexed, (await readPrefix(file.real, MAP_READ_BYTES))?.text ?? '').title;
    // RENOR_SECRET_GUARD (default ON): the same rule for a whole note, before the retired directory exists.
    if (secretGuardEnabled()) {
      await assertStorable([{ field: 'memory', text: await readToScreen(file.real, 'retire') }, { field: 'title', text: title }], 'retire');
    }
    // Each retirement gets its own stored copy, so retiring a later note at the same path never
    // hides an earlier one.
    const storedRel = path.posix.join(RETIRED_FILES_DIR.split(path.sep).join('/'), `${rid.slice('retired:'.length)}`, file.rel);
    const storedDir = await ensureRealDir(rootReal, path.posix.dirname(storedRel));
    const storedReal = path.join(storedDir, path.posix.basename(storedRel));
    // Journal first, then leave retrieval, then move: an interruption anywhere leaves a state
    // reconcile() settles, never a memory nobody can restore.
    await appendJournal(ctx, { rid, id, kind: 'note', path: file.rel, title, retiredAt: at, storedAt: storedRel });
    // Under the file's lock, so an index pass already reading this note finishes before the drop,
    // and one that starts after finds the file gone instead of re-adding it.
    await withDailyFileLock(file.indexed, async () => {
      if (expectedHash !== undefined && hashContent(await readWhole(file.real)) !== expectedHash) {
        // This retirement never took ownership: close its journal entry, preserving the edit.
        await appendJournal(ctx, { rid, id, kind: 'note', path: file.rel, title, retiredAt: at, storedAt: storedRel, voided: true });
        throw new Error('imported note changed; preserved');
      }
      dropNoteFromIndex(ctx, file.indexed);
      await fs.rename(file.real, storedReal);
    });
    recordEvent(ctx.db, file.rel, 'retire', id, title);
    return { ok: true, id, action: 'retired', title, at };
  });
}

/**
 * Restore by the retirement's id (from memory_map.retired) or by the memory id when exactly one
 * retirement of it is in effect. Idempotent: a restore whose bytes are already back (a retry after
 * an interruption) completes the journal and re-indexes instead of failing.
 */
export function restoreMemory(
  ctx: MemoryMapContext,
  id: string,
  options: { validateAfterWrite?: () => void | Promise<void> } = {},
): Promise<RetireReceipt | FactRetirementReceipt> {
  if (factEventId(id) !== null) return restoreFact(ctx.db, ctx.memoryDir, ctx.ledgerRelPath, id, ctx.source, options.validateAfterWrite);
  return serialize(async () => {
    const before = await readJournal(ctx);
    const pick = (records: RetiredRecord[]) => {
      const active = activeRetired(records);
      if (id.startsWith('retired:')) return active.find((r) => r.rid === id) ?? null;
      parseMemoryId(id);
      const forMemory = active.filter((r) => r.id === id);
      if (forMemory.length > 1) throw refusal('memory_already_retired', 'this memory was retired more than once; restore one retirement by its id from memory_map');
      return forMemory[0] ?? null;
    };
    const wanted = pick(before);
    await reconcile(ctx);
    const record = pick(await readJournal(ctx));
    if (!record) {
      // Settled by reconcile because its bytes were already back: that is a completed restore.
      if (wanted) return { ok: true, id: wanted.id, action: 'restored', title: wanted.title, at: new Date().toISOString() };
      throw refusal('memory_not_found', 'no retired memory with that id');
    }
    const file = await resolveVaultFile(ctx, record.path, false);
    const rootReal = await fs.realpath(ctx.memoryDir);
    const at = new Date().toISOString();

    let rollback: (() => Promise<void>) | undefined;
    if (record.kind === 'entry') {
      const day = DAILY_FILE_RE.exec(record.path)?.[2];
      // The block is stored exactly as it was in the file. Not trimmed: a statement that opens with a line break
      // has an entry line that ends in the separator space, and trimming it made the entry impossible to restore.
      if (!record.block || !day || !ENTRY_LINE_RE.test(record.block.split('\n')[0])) throw new Error('retired entry record is incomplete');
      // RENOR_SECRET_GUARD (default ON): restoring puts the text back into live memory, so it is screened like a save.
      if (secretGuardEnabled()) {
        await assertStorable([{ field: 'memory', text: record.block }, { field: 'title', text: record.title }], 'restore');
      }
      await ensureRealDir(rootReal, path.posix.dirname(record.path));
      await withDailyFileLock(file.indexed, async () => {
        let existing: string | null = null;
        try {
          existing = await readWhole(file.real);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        const copies = Array.from({ length: Math.max(1, record.copies ?? 1) }, () => record.block!).join('\n');
        rollback = existing === null
          ? async () => { await fs.rm(file.real, { force: true }); }
          : async () => { await atomicWrite(file.real, existing!); };
        if (existing !== null) {
          const { lines, blocks } = parseEntries(record.path, existing);
          if (blocks.some((b) => b.id === record.id)) return; // already back
          // Back to its place in the day, not the end of the file: a restore at the end put an earlier entry after later ones.
          const line = restoreLine(blocks, record, parseEntryHeader(record.block!.split('\n')[0])?.time ?? '');
          if (line !== null) {
            lines.splice(line, 0, ...copies.split('\n'));
            await atomicWrite(file.real, lines.join('\n'));
            return;
          }
        }
        const base = existing ?? record.remainder ?? engineDailyHeader(day);
        await atomicWrite(file.real, `${base.replace(/\n*$/, '')}\n${copies}`);
      });
    } else {
      if (!record.storedAt) throw new Error('retired note record is incomplete');
      const storedDir = path.join(rootReal, ...path.posix.dirname(record.storedAt).split('/'));
      if (!within(path.join(rootReal, RETIRED_FILES_DIR), path.join(storedDir, 'x')) || (await fs.realpath(storedDir)) !== storedDir) {
        throw refusal('unsafe_path', 'retired note record points outside the retired directory');
      }
      const storedReal = path.join(storedDir, path.posix.basename(record.storedAt));
      if (await exists(file.real)) throw refusal('restore_conflict', 'a memory already exists at that path; restore would overwrite it');
      if (secretGuardEnabled()) {
        await assertStorable([{ field: 'memory', text: await readToScreen(storedReal, 'restore') }, { field: 'title', text: record.title }], 'restore');
      }
      const targetDir = await ensureRealDir(rootReal, path.posix.dirname(record.path));
      const targetReal = path.join(targetDir, path.posix.basename(record.path));
      await fs.rename(storedReal, targetReal);
      rollback = async () => { await fs.rename(targetReal, storedReal); };
    }
    try {
      await options.validateAfterWrite?.();
    } catch (err) {
      await rollback?.();
      throw err;
    }
    // Index before the journal says "restored": if indexing fails, the record stays active and a
    // retry completes the restore (see the idempotent path above).
    await indexFile(ctx.db, file.indexed, ctx.indexOptions);
    await appendJournal(ctx, { ...record, restoredAt: at });
    recordEvent(ctx.db, record.path, 'restore', record.id, record.title);
    return { ok: true, id: record.id, action: 'restored', title: record.title, at };
  });
}

// ------------------------------- permanent deletion -------------------------

export interface PurgeReceipt {
  ok: true;
  action: 'deleted';
  /** The retirement ids deleted (what memory_map.retired listed as `id`). */
  ids: string[];
  /** Bytes of Markdown that no longer count toward storage: the retired notes' stored copies. */
  freedBytes: number;
  at: string;
}

/** The directory holding one retirement's stored copy: `.trash/renor-retired/files/<rid without its prefix>`. */
function storedCopyDir(rootReal: string, rid: string): string | null {
  const hex = rid.startsWith('retired:') ? rid.slice('retired:'.length) : '';
  if (!/^[0-9a-f]{16}$/.test(hex)) return null;
  return path.join(rootReal, RETIRED_FILES_DIR, hex);
}

/**
 * Remove the stored copy of every retirement the journal says was deleted. The journal is rewritten before any copy is
 * removed (purgeRetired), so a crash between the two leaves a copy no record points to: this finds it by the rid the
 * deletion's record keeps, and removes it. Only a plain directory inside the retired area is removed, never through a
 * link.
 */
async function removePurgedCopies(rootReal: string, journal: RetiredRecord[]): Promise<void> {
  for (const r of journal) {
    if (!r.purgedAt || r.kind !== 'note') continue;
    const dir = storedCopyDir(rootReal, r.rid);
    if (!dir) continue;
    let st;
    try {
      st = await fs.lstat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (!st.isDirectory() || (await fs.realpath(path.dirname(dir))) !== path.dirname(dir)) continue;
    // fs.rm removes a link inside the tree, never what it points to.
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Bytes of regular files below `dir`, never through a link (what the storage gauge counts of a stored copy). */
async function bytesBelow(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await bytesBelow(abs);
    else if (entry.isFile() && entry.name.endsWith('.md')) total += (await fs.lstat(abs)).size;
  }
  return total;
}

/**
 * Permanently delete retired notes and daily-log entries: `target` is one retirement's id from memory_map.retired
 * (`retired:<hex>`), or `all` for every retired note and entry. With `all`, `only` (retirement ids, as the owner saw them)
 * limits the deletion to those, so a retirement made after the owner's list was read is not deleted unseen. A live memory
 * has no retirement id, so it can never be deleted in one step: it is retired first. A retired fact is kept in the fact
 * ledger, which is replayed to rebuild the index. A bare `all` keeps retired facts; a fact is erased only when its
 * `fact:` id is targeted directly or included in `only`.
 *
 * What goes: a note's stored copy (so its bytes stop counting toward storage), an entry's text in the journal, every
 * journal record of the memory's earlier retirements that carried its text, the retire, restore and note events that
 * name it, cached evidence read from its file, a note's path in the import journal (.renor-imports), and every replacement
 * record that names it (replaced.jsonl). The search index
 * lost the memory when it was retired. What stays: one journal record per deletion (rid, kind, time) and one write event
 * (how many, of which kind), neither with an id, a path, a title or any text.
 *
 * Crash safety: events, cached evidence, import-journal entries and replacement records are dropped first (a crash then leaves
 * the memory retired and restorable, without its event titles, its undo entry or its replacement link); the journal rewrite is atomic and is the moment of
 * deletion (from then on nothing lists or restores it); a stored copy left behind by a crash after it is removed by the
 * next retire, restore or delete (removePurgedCopies), and until then it counts toward storage but nothing reads it.
 */
/**
 * A fact erased for good, and the evidence cached from the ledger that held it: the evidence pass reads the ledger whole, so
 * its extractions can carry the erased value (the same as a daily log's, below). Dropped after the rewrite, so an extraction
 * that follows reads the tombstone; a retry of an erasure that already happened drops them again.
 */
async function eraseFact(ctx: MemoryMapContext, id: string): Promise<PurgeReceipt> {
  const receipt = await eraseRetiredFact(ctx.db, ctx.memoryDir, ctx.ledgerRelPath, id, ctx.indexOptions.vectorIndex);
  if (ctx.evidenceCachePath) {
    const ledger = resolveLedgerPath(ctx.memoryDir, ctx.ledgerRelPath);
    dropEvidenceForStems(ctx.evidenceCachePath, [ledger, path.relative(path.resolve(ctx.memoryDir), ledger)]);
  }
  return receipt;
}

/**
 * What a permanent deletion removed, named by what the learning log keyed it under (src/learning/tap.ts). The receipt cannot say:
 * its ids are `retired:<random>` for a note or entry, and the journal keeps no path once the memory is purged, so this is read
 * before the erase. It never leaves the process: `purgeRetired` hands it to the caller's `onErased` and puts it in no reply.
 */
export type ErasedLink =
  | { kind: 'note'; path: string }
  | { kind: 'fact'; eventId: string; scope: string; subject: string; predicate: string };

function factLink(ctx: MemoryMapContext, id: string): ErasedLink[] {
  const f = listRetiredFacts(ctx.db).find((row) => row.id === id);
  return f ? [{ kind: 'fact', eventId: f.eventId, scope: f.scope, subject: f.subject, predicate: f.predicate }] : [];
}

function reportErased(onErased: ((links: ErasedLink[]) => void) | undefined, links: ErasedLink[]): void {
  if (!onErased || links.length === 0) return;
  try {
    onErased(links);
  } catch {
    // The deletion has happened; a log that could not follow must not fail it.
  }
}

export async function purgeRetired(ctx: MemoryMapContext, target: string, only?: readonly string[],
  onErased?: (links: ErasedLink[]) => void): Promise<PurgeReceipt> {
  if (factEventId(target) !== null) {
    const links = factLink(ctx, target);
    const receipt = await eraseFact(ctx, target);
    reportErased(onErased, links);
    return receipt;
  }
  if (target !== 'all' && !target.startsWith('retired:')) {
    throw refusal('invalid_argument', 'pass the id of a retired memory from memory_map.retired (retired:<id>) or "all"; a live memory is retired first');
  }
  if (only !== undefined && target !== 'all') {
    throw refusal('invalid_argument', 'a list of ids goes with "all" only: one id deletes one memory');
  }
  return serialize(async () => {
    await reconcile(ctx);
    const rootReal = await fs.realpath(ctx.memoryDir);
    const journal = await readJournal(ctx);
    const live = (await collectMemories(ctx)).seen;
    const completed = await completedRetirements(ctx, live);
    const listed = only === undefined ? null : new Set(only);
    const chosen = target === 'all'
      ? completed.filter((r) => listed === null ? r.memory.kind !== 'fact' : listed.has(r.memory.id))
      : completed.filter((r) => r.memory.id === target);
    if (target !== 'all' && chosen.length === 0) throw refusal('memory_not_found', 'no retired note or entry with that id');
    const at = new Date().toISOString();
    if (chosen.length === 0) return { ok: true, action: 'deleted', ids: [], freedBytes: 0, at };

    const facts = chosen.filter((r) => r.memory.kind === 'fact');
    const files = chosen.filter((r) => r.memory.kind !== 'fact');
    const erasedFacts = [] as string[];
    const links: ErasedLink[] = [];
    for (const fact of facts) {
      links.push(...factLink(ctx, fact.memory.id));
      const erased = await eraseFact(ctx, fact.memory.id);
      erasedFacts.push(...erased.ids);
    }
    if (files.length === 0) {
      reportErased(onErased, links);
      return { ok: true, action: 'deleted', ids: erasedFacts, freedBytes: 0, at };
    }

    const rids = new Set(files.map((r) => r.memory.id));
    const memoryIds = new Set(files.map((r) => r.memory.memoryId));
    const byRid = new Map(activeRetired(journal).map((r) => [r.rid, r]));
    let freedBytes = 0;
    for (const rid of rids) {
      const dir = byRid.get(rid)?.kind === 'note' ? storedCopyDir(rootReal, rid) : null;
      if (dir) freedBytes += await bytesBelow(dir);
    }

    // 1. Events, cached evidence, import-journal entries and replacement records that carry its text or path. Idempotent, so a retry after a
    // crash repeats them harmlessly.
    const stems = new Set<string>();
    await forgetImportedNotes(ctx.memoryDir, new Set(files.filter((r) => r.memory.kind === 'note').map((r) => r.memory.path)));
    await forgetReplacementsOf(path.join(rootReal, RETIRED_DIR), new Set(files.map((r) => r.memory.memoryId).filter((id): id is string => typeof id === 'string')));
    ctx.db.transaction(() => {
      const named = ctx.db.prepare(
        `DELETE FROM write_events WHERE action IN ('retire', 'restore') AND json_valid(summary) AND json_extract(summary, '$.id') = ?`,
      );
      const noted = ctx.db.prepare(`DELETE FROM write_events WHERE action = 'note' AND note_path IN (?, ?) AND summary = ?`);
      for (const memoryId of memoryIds) named.run(memoryId);
      for (const r of files) {
        const rel = r.memory.path;
        stems.add(rel);
        stems.add(path.resolve(ctx.memoryDir, ...rel.split('/')));
        if (r.memory.kind !== 'entry') continue;
        const record = byRid.get(r.memory.id);
        const text = record?.block ? parseEntries(rel, record.block).blocks[0]?.text : undefined;
        if (text !== undefined) noted.run(rel, rel.split('/').join(path.sep), text.slice(0, 240));
      }
    })();
    // A daily log is read whole by the evidence pass, so its live entries' extractions go too; the cache asks again.
    if (ctx.evidenceCachePath) dropEvidenceForStems(ctx.evidenceCachePath, [...stems]);

    // 2. The journal, rewritten atomically: the moment of deletion. Every record of a chosen retirement goes, and so does
    // every ended retirement of the same memory (a restore or a void kept the entry's text); other retirements still in
    // effect stay, so a memory retired twice keeps its other retirement.
    const kept = journal.filter((r) => !rids.has(r.rid) && !(memoryIds.has(r.id) && !byRid.has(r.rid)));
    const tombstones: RetiredRecord[] = [...rids].map((rid) => ({
      rid, kind: byRid.get(rid)!.kind, purgedAt: at, voided: true,
    }) as RetiredRecord);
    const dir = await ensureRealDir(rootReal, RETIRED_DIR);
    const file = path.join(dir, path.basename(RETIRED_INDEX));
    const st = await fs.lstat(file);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`refusing to rewrite ${JSON.stringify(RETIRED_INDEX)}: it is not a regular file with a single name`);
    await atomicWrite(file, [...kept, ...tombstones].map((r) => JSON.stringify(r) + '\n').join(''));

    // 3. The stored copies. A crash before this leaves them to removePurgedCopies.
    await removePurgedCopies(rootReal, tombstones);

    // 4. The visible audit line: what kind and how many, nothing else.
    const notes = tombstones.filter((r) => r.kind === 'note').length;
    const entries = tombstones.length - notes;
    const counted = [notes ? `${notes} note${notes === 1 ? '' : 's'}` : '', entries ? `${entries} entr${entries === 1 ? 'y' : 'ies'}` : '']
      .filter(Boolean).join(' and ');
    ctx.db.prepare('INSERT INTO write_events (note_path, action, summary, created_at, author) VALUES (?, ?, ?, ?, ?)')
      .run('_retired_', 'delete', `deleted permanently: ${counted}`, at, ctx.source ?? null);
    for (const notePath of new Set(files.map((r) => r.memory.path))) links.push({ kind: 'note', path: notePath });
    reportErased(onErased, links);
    return { ok: true, action: 'deleted', ids: [...erasedFacts, ...rids], freedBytes, at };
  });
}

// ------------------------------- export (export_memory) ---------------------

export interface ExportEntry { id: string; at: string; source: string; text: string }

/** Every entry of one daily log as stored (identical entries are one, as everywhere), in file order. */
export function dailyEntriesForExport(rel: string, content: string): ExportEntry[] {
  const day = DAILY_FILE_RE.exec(rel)?.[2];
  if (!day) return [];
  return parseEntries(rel, content).blocks.map((b) => ({ id: b.id, at: entryInstant(day, b), source: b.source, text: b.text }));
}

export interface ExportRetired {
  /** The retirement's own id (what restore_memory takes). */
  rid: string;
  /** The memory id it was retired from. */
  memoryId: string;
  kind: MemoryKind;
  path: string;
  title: string;
  retiredAt: string;
  /** note: where the stored copy lives, vault-relative. */
  storedAt?: string;
  /** note: the stored file's full text; entry: the entry's exact bytes. */
  content: string;
  /** entry: when it was originally saved. */
  savedAt?: string;
}

/**
 * Every completed retirement of a note or an entry with its full retained text, newest first. A note's text is read from
 * its stored copy (confined to the retired area); an entry's is the journal's block. Retired facts are not here: they
 * come from listRetiredFacts. An interrupted retirement whose memory never left is not retired and is not listed.
 */
export async function retiredForExport(ctx: MemoryMapContext): Promise<ExportRetired[]> {
  const rootReal = await fs.realpath(ctx.memoryDir);
  const out: ExportRetired[] = [];
  for (const r of activeRetired(await readJournal(ctx)).reverse()) {
    const day = DAILY_FILE_RE.exec(r.path)?.[2];
    if (r.kind === 'entry') {
      if (!r.block) continue;
      let live = false;
      try {
        const file = await resolveVaultFile(ctx, r.path, true);
        live = parseEntries(file.rel, await readWhole(file.real)).blocks.some((b) => b.id === r.id);
      } catch { /* the log is gone with its last entry: the entry is retired */ }
      if (live) continue;
      const header = parseEntryHeader(r.block.split('\n')[0]);
      out.push({
        rid: r.rid, memoryId: r.id, kind: 'entry', path: r.path, title: r.title, retiredAt: r.retiredAt, content: r.block,
        ...(day && header ? { savedAt: entryInstant(day, header) } : {}),
      });
      continue;
    }
    if (!r.storedAt) continue;
    const stored = path.join(rootReal, ...r.storedAt.split('/'));
    if (!within(path.join(rootReal, RETIRED_FILES_DIR), stored)) continue;
    try {
      if ((await fs.realpath(path.dirname(stored))) !== path.dirname(stored)) continue;
      const handle = await openConfined(stored);
      let content: string;
      try { content = await handle.readFile('utf8'); } finally { await handle.close(); }
      out.push({ rid: r.rid, memoryId: r.id, kind: 'note', path: r.path, title: r.title, retiredAt: r.retiredAt, storedAt: r.storedAt, content });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // never moved: still live
      throw err;
    }
  }
  return out;
}
