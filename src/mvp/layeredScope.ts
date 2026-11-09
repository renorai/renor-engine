/**
 * Layered scope (RENOR_LAYERED_SCOPE, off by default): one memory pool, each save tagged with where it was said (`origin`)
 * and whether it is about the user or a project (`kind`), and a read that decides visibility from both. Option (d) of
 * docs/research/2026-11-08-memory-scope-architecture.md.
 *
 *   write  every save records origin (from the client: x-renor-origin, the request's `_meta["renor/origin"]`, x-renor-scope,
 *          a chat client's name, or the stdio server's own repository) and kind (rules only, recall/origin.ts). Metadata
 *          only: a note stays in the file it was always written to and a fact keeps its scope. An explicit `scope` still
 *          wins: a named one marks the save `project`, `global` marks it `personal`.
 *   read   with no `scope` passed (an explicit scope keeps its partition): personal items, items of the current origin and
 *          items of unknown origin (today's global memory) are eligible. Another origin's project items are never eligible
 *          on their own; they are shown, labelled with their origin and `otherProject: true`, only when the query names that
 *          project, or when nothing eligible answered at all. The automatic recall hook drops every labelled item, so other
 *          projects are never injected unasked.
 *
 * Off, nothing here runs: no table is created, no reply changes by a byte.
 */
import crypto from 'node:crypto';
import type Database from '../db/sqlite';
import { LIFECYCLE_NOTE_PATH } from '../memory/lifecycle';
import { ledgerEventIds } from '../retrieval/ledgerLiveness';
import { classifyKind, normalizeOrigin, originRepoName, ORIGIN_HEADER, ORIGIN_META_KEY, type MemoryKind } from '../recall/origin';
import { normalizeScope } from './scope';
import { createLogger } from './log';

const log = createLogger('layered-scope');

export const LAYERED_SCOPE_FLAG = 'RENOR_LAYERED_SCOPE';
export const ORIGIN_TABLE = 'memory_origins';

export function layeredScopeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env[LAYERED_SCOPE_FLAG] ?? '').trim());
}

/**
 * One row per save. A note's words are not copied here: `text_hash` is a SHA-256 of the entry's text, enough to tell which
 * entry of a note a search hit is, so deleting a memory leaves no readable copy of it in this table. Facts need none (their
 * event id is the key).
 */
const DDL = `CREATE TABLE IF NOT EXISTS ${ORIGIN_TABLE} (
  item TEXT PRIMARY KEY,
  note_path TEXT,
  text_hash TEXT,
  origin TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'project')),
  rule TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_origins_note_path ON ${ORIGIN_TABLE}(note_path)`;

const ensured = new WeakSet<object>();

/** Creates the table (first layered write or read only) and backfills the facts saved before it. Idempotent. */
export function ensureOriginTable(db: Database.Database): void {
  if (ensured.has(db)) return;
  db.exec(DDL);
  backfillOrigins(db);
  ensured.add(db);
}

/** A fact's item key: its ledger event, upper-case as the facts table stores it. */
const eventItem = (eventId: string) => `event:${eventId.toUpperCase()}`;

/** The hash a note entry's text is known by: whitespace-trimmed, SHA-256, hex. */
export const entryHash = (text: string): string => crypto.createHash('sha256').update(text.trim()).digest('hex');

/** A daily-log entry as a search hit shows it: `- [09:00:00] (source) text`, one or more per chunk. */
const ENTRY_HEAD = /^- \[[^\]\n]*\]\s*(?:\([^)\n]*\)\s*)?/;

/** The hashes of the entries a hit's text holds (each entry without its time and source), and of the whole text. */
export function hitEntryHashes(text: string): string[] {
  const entries = text.split(/\n(?=- \[)/).map(entry => entry.replace(ENTRY_HEAD, ''));
  return [...new Set([...entries, text].map(entryHash))];
}

/** The origin the backfill gives an item saved before origins were recorded: its named scope's slug, or unknown. */
export function originOfScope(scope: string | null | undefined): string | null {
  if (!scope || scope === 'global' || !scope.includes(':')) return null;
  return normalizeOrigin(scope.slice(scope.indexOf(':') + 1));
}

/** The origin of a note saved before origins were recorded: the scope directory it lives in, or unknown. */
export function originOfNotePath(notePath: string): string | null {
  const m = /(?:^|\/)Memory\/Scopes\/([^/]+)\//.exec(notePath.replace(/\\/g, '/'));
  return m ? normalizeOrigin(m[1]) : null;
}

/**
 * Additive backfill for facts: every ledger event with no origin row gets one (named scope → that origin, global →
 * unknown) and a kind by the same rules a new save gets. Nothing is moved, rewritten or deleted. Notes need no rows:
 * a note without one is read by the same rule from its path (`noteVerdictInput`).
 */
export function backfillOrigins(db: Database.Database): number {
  let rows: Array<{ eventId: string; subject: string | null; predicate: string; object: string | null; scope: string | null; at: string }>;
  try {
    rows = db.prepare(`SELECT f.event_id AS eventId, e.canonical_name AS subject, f.predicate AS predicate, f.object_text AS object,
        f.scope AS scope, f.valid_from AS at
      FROM facts f LEFT JOIN entities e ON e.id = f.subject_entity_id
      WHERE f.event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${ORIGIN_TABLE} o WHERE o.item = 'event:' || upper(f.event_id))`).all() as typeof rows;
  } catch { return 0; } // an index without the lifecycle columns has no facts to backfill
  const insert = db.prepare(`INSERT OR IGNORE INTO ${ORIGIN_TABLE} (item, note_path, text_hash, origin, kind, rule, saved_at) VALUES (?, ?, NULL, ?, ?, ?, ?)`);
  let added = 0;
  db.transaction(() => {
    for (const r of rows) {
      const text = `${r.subject ?? ''} ${r.predicate}: ${r.object ?? ''}`.trim();
      const origin = originOfScope(r.scope);
      const verdict = classifyKind({ text, subject: r.subject ?? undefined, origin });
      added += insert.run(eventItem(r.eventId), LIFECYCLE_NOTE_PATH, origin, verdict.kind, `backfill:${verdict.rule}`, r.at).changes;
    }
  })();
  return added;
}

export interface SaveOrigin {
  /** A fact's ledger event id, or a note entry's id (memory_map's). */
  eventId?: string;
  noteId?: string;
  /** The note file the entry was appended to (the receipt's `file`), so a search hit on it finds this row. */
  notePath?: string;
  text: string;
  subject?: string;
  origin: string | null;
  /** The scope the agent passed, when it passed one: named → project, global → personal (an explicit override). */
  explicitScope?: string;
}

/**
 * Removes the origin rows of memories that are being permanently deleted (delete_retired_memory): a fact by its event id,
 * an entry by its memory id, a whole note by its path. The rows hold no words, but an entry's key and hash are derived from
 * its text, so a deleted memory must leave none. Runs whether or not the flag is on now (it may have been on when the
 * memory was saved); a workspace that never had the table is left untouched.
 */
export function forgetOrigins(db: Database.Database, gone: { eventIds?: string[]; noteIds?: string[]; notePaths?: string[] }): number {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(ORIGIN_TABLE);
  if (!exists) return 0;
  const byItem = db.prepare(`DELETE FROM ${ORIGIN_TABLE} WHERE item = ?`);
  const byPath = db.prepare(`DELETE FROM ${ORIGIN_TABLE} WHERE note_path = ?`);
  let removed = 0;
  db.transaction(() => {
    for (const id of gone.eventIds ?? []) removed += byItem.run(eventItem(id)).changes;
    for (const id of gone.noteIds ?? []) removed += byItem.run(`note:${id}`).changes;
    for (const p of gone.notePaths ?? []) removed += byPath.run(p.replace(/\\/g, '/')).changes;
  })();
  return removed;
}

/** Records one save's origin and kind (flag on only). Best effort: the memory is already saved, so a failure is swallowed. */
export function recordSaveOrigin(db: Database.Database, save: SaveOrigin): { origin: string | null; kind: MemoryKind } | null {
  const item = save.eventId ? eventItem(save.eventId) : save.noteId ? `note:${save.noteId}` : null;
  if (!item) return null;
  try {
    ensureOriginTable(db);
    let kind: MemoryKind;
    let rule: string;
    let origin = save.origin;
    const scope = save.explicitScope?.trim() ? normalizeScope(save.explicitScope) : null;
    if (scope && scope !== 'global') {
      kind = 'project';
      rule = 'explicit-scope';
      origin = origin ?? originOfScope(scope);
    } else if (scope === 'global') {
      kind = 'personal';
      rule = 'explicit-global';
    } else {
      const verdict = classifyKind({ text: save.text, subject: save.subject, origin });
      kind = verdict.kind;
      rule = verdict.rule;
    }
    db.prepare(`INSERT OR REPLACE INTO ${ORIGIN_TABLE} (item, note_path, text_hash, origin, kind, rule, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(item, save.notePath ? save.notePath.replace(/\\/g, '/') : LIFECYCLE_NOTE_PATH, save.eventId ? null : entryHash(save.text), origin, kind, rule, new Date().toISOString());
    return { origin, kind };
  } catch (err) {
    // The memory is saved; without its row it reads as unknown origin (visible everywhere), so say so in the log.
    log.error('origin_not_recorded', { detail: 'the memory was saved; it reads as unknown origin' }, err);
    return null;
  }
}

/** The minimum of a tool call the origin is read from. */
export interface OriginCall {
  requestInfo?: { headers?: Record<string, unknown> };
  _meta?: Record<string, unknown>;
}

const header = (headers: Record<string, unknown> | undefined, name: string): string | undefined => {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
};

/** Chat clients by their connection name's family: a save from one, with no repository, is `chat:<family>`. */
const CHAT_FAMILIES = ['claude-ai', 'chatgpt', 'gemini', 'claude-desktop'];

/**
 * Where this call was made: x-renor-origin, then `_meta["renor/origin"]`, then x-renor-scope's project (what a
 * project-level `renor connect` writes), then `chat:<client>` for a directory or chat client, then `fallback` (the stdio
 * server's own repository), else unknown (null).
 */
export function originOfCall(extra: OriginCall | undefined, opts: { agent?: string; directory?: boolean; fallback?: string | null } = {}): string | null {
  const headers = extra?.requestInfo?.headers;
  const sent = normalizeOrigin(header(headers, ORIGIN_HEADER)) ?? normalizeOrigin(extra?._meta?.[ORIGIN_META_KEY]);
  if (sent) return sent;
  const scope = header(headers, 'x-renor-scope');
  if (scope?.trim()) {
    try {
      const fromScope = originOfScope(normalizeScope(scope));
      if (fromScope) return fromScope;
    } catch { /* an invalid scope names no origin */ }
  }
  const agent = (opts.agent ?? '').trim().toLowerCase().replace(/[\s_.]+/g, '-');
  const family = CHAT_FAMILIES.find(f => agent === f || agent.startsWith(`${f}-`));
  if (family) return `chat:${family}`;
  if (opts.directory) return 'chat:directory';
  return opts.fallback ?? null;
}

export type Visibility = 'in' | 'named' | 'other';

export interface LayeredVerdict {
  visibility: Visibility;
  origin: string | null;
  kind: MemoryKind;
}

/** Whether a query names an origin's project: its repository or folder name as a whole word. */
export function queryNamesOrigin(query: string, origin: string): boolean {
  const name = originRepoName(origin);
  if (!name || name.length < 3) return false;
  const words = query.toLowerCase();
  const variants = new Set([name, name.replace(/[-_.]+/g, ' ')]);
  return [...variants].some(v => new RegExp(`(^|[^a-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(words));
}

/** The one visibility rule (module comment). */
export function visibilityOf(origin: string | null, kind: MemoryKind, current: string | null, query: string): Visibility {
  if (kind === 'personal' || origin === null) return 'in';
  if (current !== null && origin === current) return 'in';
  return queryNamesOrigin(query, origin) ? 'named' : 'other';
}

interface Row { item: string; note_path: string | null; text_hash: string | null; origin: string | null; kind: MemoryKind }

/** A read's view of origins: the verdict for each fact or memory the read found. */
export interface LayeredView {
  current: string | null;
  fact(fact: { eventId?: string | null; scope?: string | null; subject: string; predicate: string; object: string }): LayeredVerdict;
  memory(memory: { notePath: string; text: string; headingPath?: string }): LayeredVerdict;
}

export function layeredView(db: Database.Database, current: string | null, query: string): LayeredView {
  ensureOriginTable(db);
  const byItem = db.prepare(`SELECT item, note_path, text_hash, origin, kind FROM ${ORIGIN_TABLE} WHERE item = ?`);
  const byPath = db.prepare(`SELECT item, note_path, text_hash, origin, kind FROM ${ORIGIN_TABLE} WHERE text_hash IS NOT NULL AND (note_path = ? OR ? LIKE '%/' || note_path)`);
  const factScope = db.prepare(`SELECT f.scope AS scope, e.canonical_name AS subject, f.predicate AS predicate, f.object_text AS object
    FROM facts f LEFT JOIN entities e ON e.id = f.subject_entity_id WHERE f.event_id = ?`);
  const verdict = (origin: string | null, kind: MemoryKind): LayeredVerdict => ({ visibility: visibilityOf(origin, kind, current, query), origin, kind });
  const rank: Record<Visibility, number> = { in: 0, named: 1, other: 2 };
  const best = (verdicts: LayeredVerdict[]): LayeredVerdict => verdicts.reduce((a, b) => (rank[b.visibility] < rank[a.visibility] ? b : a));

  const ofEvent = (eventId: string): LayeredVerdict => {
    const row = byItem.get(eventItem(eventId)) as Row | undefined;
    if (row) return verdict(row.origin, row.kind);
    const fact = factScope.get(eventId.toUpperCase()) as { scope: string | null; subject: string | null; predicate: string; object: string | null } | undefined;
    const origin = originOfScope(fact?.scope);
    const text = fact ? `${fact.subject ?? ''} ${fact.predicate}: ${fact.object ?? ''}` : '';
    return verdict(origin, classifyKind({ text, subject: fact?.subject ?? undefined, origin }).kind);
  };

  return {
    current,
    fact(fact) {
      if (fact.eventId) return ofEvent(fact.eventId);
      const origin = originOfScope(fact.scope);
      return verdict(origin, classifyKind({ text: `${fact.subject} ${fact.predicate}: ${fact.object}`, subject: fact.subject, origin }).kind);
    },
    memory(memory) {
      const events = ledgerEventIds(memory);
      if (events.length) return best(events.map(ofEvent));
      const path = memory.notePath.replace(/\\/g, '/');
      const hashes = new Set(hitEntryHashes(memory.text));
      const rows = (byPath.all(path, path) as Row[]).filter(r => r.text_hash !== null && hashes.has(r.text_hash));
      if (rows.length) return best(rows.map(r => verdict(r.origin, r.kind)));
      // Saved before origins were recorded (or written into the vault by hand): its scope directory, and the same rules.
      const origin = originOfNotePath(path);
      return verdict(origin, classifyKind({ text: memory.text, origin }).kind);
    },
  };
}

/** The label an item of another origin carries in a reply: where it was said, and that it is not this project's. */
export const otherProjectLabel = (origin: string | null) => ({ savedIn: origin ?? 'unknown', otherProject: true as const });

/**
 * The layered selection over a read's facts and memories, in their order: eligible items as they are; another origin's
 * items labelled, kept when the query names their project, or all of them when nothing eligible is left (`answered`
 * decides what counts as answered: by default, any fact or matched memory).
 */
export function layerItems<F, M>(
  view: LayeredView,
  facts: F[],
  memories: M[],
  factOf: (f: F) => Parameters<LayeredView['fact']>[0],
  memoryOf: (m: M) => Parameters<LayeredView['memory']>[0],
  matched: (m: M) => boolean = () => true,
): { facts: F[]; memories: M[]; fallback: boolean; hidden: number } {
  const fv = facts.map(f => ({ f, v: view.fact(factOf(f)) }));
  const mv = memories.map(m => ({ m, v: view.memory(memoryOf(m)) }));
  const label = <T>(item: T, v: LayeredVerdict): T => (v.visibility === 'in' ? item : { ...item, ...otherProjectLabel(v.origin) });
  const keep = (v: LayeredVerdict) => v.visibility !== 'other';
  const keptFacts = fv.filter(x => keep(x.v));
  const keptMemories = mv.filter(x => keep(x.v));
  const answered = keptFacts.length > 0 || keptMemories.some(x => matched(x.m));
  const fallback = !answered && (fv.length > keptFacts.length || mv.length > keptMemories.length);
  const pickF = fallback ? fv : keptFacts;
  const pickM = fallback ? mv : keptMemories;
  return {
    facts: pickF.map(x => label(x.f, x.v)),
    memories: pickM.map(x => label(x.m, x.v)),
    fallback,
    hidden: fv.length + mv.length - pickF.length - pickM.length,
  };
}
