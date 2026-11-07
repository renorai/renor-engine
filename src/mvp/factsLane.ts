import path from 'path';
import fs from 'fs';
import { clampSessionDate } from '../retrieval/orchestrator';
import type Database from '../db/sqlite';
import { prepareOnce } from '../db/statements';
import { factQueryTerms } from './agentMemory';
import { resolveLedgerPath } from '../memory/lifecycle';
import { writerConflictLines } from '../memory/writerConflicts';
import { findCurrentFacts, newestFactEvent, type CurrentFact, type FactMatch } from '../memory/factTerms';
import { ledgerEventIds } from '../retrieval/ledgerLiveness';
import { factText } from '../retrieval/ledgerPresentation';
import { normalizeScope, scopeSqlPredicate, type NormalizedScope } from './scope';
import { leadingSummaryHits } from '../digests/digests';
import { authorMarker, type AuthorMarker } from '../memory/sourceName';
import { authorityField, authorityOfSource } from '../memory/authority';

/**
 * The facts lane of search: current lifecycle facts read straight from the `facts` table.
 *
 * remember() projects a fact into that table in the same call that appends it to the ledger,
 * but the chunk index (full-text and embeddings) only catches up on index_memory, and indexing
 * on every write would re-chunk and re-embed the whole ledger each time. So search asks the
 * table for the facts the index may not hold yet, and says so when the index is behind
 * (`indexNotice`). Only current facts are read: a corrected value never comes back as live,
 * whether or not the index has caught up. Superseded events stay with the index
 * (include_history), which already labels them. Facts are found through the term index
 * (memory/factTerms.ts): a fact that has a selective word of the query is found however old, and
 * a word in more than COMPLETE_POSTINGS facts is matched among the newest ones only, so the cost
 * of a read does not grow with the table.
 */

export interface FactHit extends AuthorMarker {
  notePath: string;
  headingPath: string;
  text: string;
  score: number;
  reason: 'fact';
  session_date?: string;
  /** Set on a current fact that replaced a value another writer saved, until that writer saves it again (memory/writerConflicts.ts). */
  writerConflict?: string;
}

/** Where the ledger lives, as the MCP tools know it. */
export interface LedgerLocation {
  memoryDir: string;
  ledgerRelPath: string;
}

/**
 * The fact as the index shows it, so a hit reads the same before and after index_memory: the fact itself, never the
 * markup of the ledger's record (its `## MEM_… · time` header and `- subject: …` lines are bookkeeping, and no read
 * returns them). The event and its time are in the hit's heading path.
 */
function factBlock(row: CurrentFact): string {
  return factText(row.subject, row.predicate, row.object);
}

/**
 * One current fact as a hit. `score` is left at 0 here and set by `factHits`, which knows the share of the query's
 * words the fact holds; a fact named by a caller instead (`withFactHits` `also`) was found by meaning rather than by
 * those words, so it keeps 0 — the convention session-expand hits use.
 */
function factHit(row: CurrentFact, ledger: LedgerLocation, date?: (at: string) => string | undefined, reader?: string, conflict?: string): FactHit {
  const notePath = path.relative(path.resolve(ledger.memoryDir), resolveLedgerPath(ledger.memoryDir, ledger.ledgerRelPath));
  return {
    notePath,
    headingPath: row.eventId ? `${row.eventId} · ${row.validFrom}` : `${row.subject} > ${row.predicate}`,
    text: factBlock(row),
    score: 0,
    reason: 'fact' as const,
    ...(date ? { session_date: date(row.validFrom) } : {}),
    // Who saved it, as get_context's facts show it: another agent's name, and untrusted for an import.
    ...authorMarker(row.author, reader),
    ...authorityField(authorityOfSource(row.author)),
    // The values another writer replaced that stay open against it (memory/writerConflicts.ts), when there are any.
    ...(conflict !== undefined ? { writerConflict: conflict } : {}),
  };
}

/** Facts can be returned before the ledger is indexed. Bound their clock by the actual ledger write, once per read. */
function ledgerTimeBound(ledger: LedgerLocation): (at: string) => string | undefined {
  let read = false;
  let modified: string | undefined;
  return at => {
    if (!read) {
      read = true;
      try { modified = fs.statSync(resolveLedgerPath(ledger.memoryDir, ledger.ledgerRelPath)).mtime.toISOString(); }
      catch { /* No trusted write time: the fact stays undated. */ }
    }
    return clampSessionDate(at, modified);
  };
}

/**
 * Current facts that match `query`, as search hits.
 *
 * `all`: every query word must be among the fact's words (search_text, a keyword tool).
 * `any`: one is enough, and more shared words rank higher (search_memory, a natural-language
 * tool). Stop words only count when nothing else is left. Facts whose ledger event is in
 * `exclude` (lowercased ids the index already returned) are skipped before the `limit`, so they
 * never use up a slot. Scope follows the facts lane of get_context: omitted means every scope,
 * a given scope means exactly that one.
 */
function matchedFacts(
  db: Database.Database,
  args: {
    query: string;
    scope?: string;
    match: 'all' | 'any';
    limit: number;
    dated?: boolean;
    exclude?: ReadonlySet<string>;
  },
  terms: readonly string[],
): FactMatch[] {
  if (terms.length === 0) return [];
  const scope = args.scope === undefined ? undefined : normalizeScope(args.scope);
  const exclude = args.exclude ?? new Set<string>();

  // At most |exclude| of the best matches are dropped below, so this many always leaves `limit`.
  return findCurrentFacts(db, { terms: [...terms], scope, match: args.match, limit: args.limit + exclude.size })
    .filter(row => !(row.eventId && exclude.has(row.eventId.toLowerCase())))
    .slice(0, args.limit);
}

export function factHits(
  db: Database.Database,
  ledger: LedgerLocation,
  args: {
    query: string;
    scope?: string;
    match: 'all' | 'any';
    limit: number;
    dated?: boolean;
    exclude?: ReadonlySet<string>;
    /** The reading agent's name: a fact saved under another name carries its `source`. */
    reader?: string;
  },
): FactHit[] {
  const terms = factQueryTerms(args.query);
  const date = args.dated ? ledgerTimeBound(ledger) : undefined;
  return matchedFacts(db, args, terms)
    .map(row => ({ ...factHit(row, ledger, date, args.reader), score: Math.round((row.shared / terms.length) * 100) / 100 }));
}

/**
 * What a fact claims, in its own scope: two current facts with the same key are the same fact whatever ledger event
 * backs them, and one derived from a note has none. So a fact already on the page is recognised without an event id
 * to compare, which is the only way a fact saved through `remember` (not through `save_memory`) could be listed twice.
 */
function factKey(row: CurrentFact): string {
  return `${normalizeScope(row.scope)}\u0000${row.subject}\u0000${row.predicate}`;
}

/**
 * The index's hits plus the current facts that match `args.query`, at most `args.limit` hits in all (the search's
 * top_k): the facts take the places the index's own hits leave, so no index hit is lost or reordered, and a full page
 * of index hits gets no fact (they used to come on top of it, up to top_k more, matched by any word: live dogfood,
 * 2026-10-03, D14). Fact hits go first, after a leading evidence summary if there is one, which is outside top_k as
 * before. A fact whose ledger event the index already returned is not repeated.
 *
 * `also` are facts a caller names because it is about to report one of them as its closest match, so they are listed
 * whether or not the query's words found them — the same rule get_context applies to the fact its verdict was judged on
 * (agentMemory.ts `missed`). They go after the facts the words found, in the order given, and only out of the room top_k
 * leaves: a page already full of index hits gets none of them, and a full room of facts the words found gives way to
 * them. So the page never passes top_k, and the verdict keeps its match whenever the page can carry it. A fact already on
 * the page is not repeated, by its ledger event or by the claim it makes in its own scope — a fact saved through
 * `remember` has no event to compare.
 */
export function withFactHits<T extends { text: string; headingPath?: string; reason?: string }>(
  db: Database.Database,
  ledger: LedgerLocation,
  indexHits: T[],
  args: Omit<Parameters<typeof factHits>[2], 'exclude'>,
  also: readonly CurrentFact[] = [],
): Array<T | FactHit> {
  const lead = leadingSummaryHits(indexHits);
  const room = args.limit - (indexHits.length - lead);
  const listed = new Set(indexHits.flatMap(ledgerEventIds));
  const terms = factQueryTerms(args.query);
  const words = room > 0 ? matchedFacts(db, { ...args, limit: room, exclude: listed }, terms) : [];
  const claimed = new Set(words.map(factKey));
  // The named facts the page does not hold yet, so each is listed once and none is pushed out by another.
  const pending: CurrentFact[] = [];
  for (const row of also) {
    const event = row.eventId?.toLowerCase();
    if (claimed.has(factKey(row)) || (event !== undefined && listed.has(event))) continue;
    if (event !== undefined) listed.add(event);
    claimed.add(factKey(row));
    pending.push(row);
  }
  // Only as many named facts as the page has room for; a page top_k has already filled takes none of them.
  const named = pending.slice(0, Math.max(0, room));
  const date = args.dated ? ledgerTimeBound(ledger) : undefined;
  const disputes = writerConflictLines(db, [...words, ...named].map(row => row.eventId));
  const line = (row: CurrentFact): string | undefined => (row.eventId === null ? undefined : disputes.get(row.eventId));
  const facts = [
    ...words.slice(0, Math.max(0, room - named.length)).map(row => ({ ...factHit(row, ledger, date, args.reader, line(row)), score: Math.round((row.shared / terms.length) * 100) / 100 })),
    ...named.map(row => factHit(row, ledger, date, args.reader, line(row))),
  ];
  return [...indexHits.slice(0, lead), ...facts, ...indexHits.slice(lead)];
}

/** The check as a join: one full-text match for every chunk of the ledger note. RENOR_NARROW_LEDGER_CHECK=0 keeps it. */
const LEDGER_CHECK_JOIN = `SELECT 1 FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
     WHERE chunks_fts MATCH ? AND c.note_path = ? LIMIT 1`;

/**
 * The same check with the full-text match evaluated once: the chunks of the ledger note whose id is a match. The join
 * above evaluates the match once for every chunk of the note. This is the default.
 */
const LEDGER_CHECK_NARROW = `SELECT 1 FROM chunks WHERE note_path = ? AND id IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?) LIMIT 1`;

/** The RENOR_NARROW_LEDGER_CHECK values that select the join. Unset, empty and any other value keep the narrow form. */
const LEDGER_CHECK_JOIN_VALUE = /^(0|off|false|no)$/i;

/**
 * Whether the newest saved fact is missing from the chunk index.
 *
 * The ledger is append-only and indexed whole, so the index holds a prefix of it: if the newest
 * event is there, every older one is too. The facts table knows the newest event; the chunk
 * full-text index finds its heading (the id, as the tokens `mem` and the rest) without reading the
 * ledger's chunks.
 *
 * A read is told only about the events it can see (a scoped read returns the ledger events saved in
 * its own scope, readScope.ts): a named scope or `global` by the newest event of that scope, a read
 * without a scope by the newest event of all.
 */
export function indexBehindLedger(db: Database.Database, ledgerPath: string, scope?: NormalizedScope): boolean {
  const newest = newestFactEvent(db, scope);
  if (!newest) return false;
  const phrase = `"${newest.replace(/"/g, '""').replace(/_/g, ' ')}"`;
  const join = LEDGER_CHECK_JOIN_VALUE.test(process.env.RENOR_NARROW_LEDGER_CHECK?.trim() ?? '');
  const indexed = join
    ? prepareOnce(db, LEDGER_CHECK_JOIN).get(phrase, ledgerPath)
    : prepareOnce(db, LEDGER_CHECK_NARROW).get(ledgerPath, phrase);
  return !indexed;
}

/** Added to a response only while the index is behind. Silence means no known lag. */
const INDEX_BEHIND = {
  stale: true,
  detail: 'The search index has not caught up with some saved facts, so they are matched by keyword only. Run index_memory to find them by meaning too.',
} as const;

/**
 * How many saved note files of the scope (every scope when none is given) are still waiting for their embedding. A
 * note whose embedding failed or ran past the write budget keeps its chunks, which keyword search finds, and its file
 * stays unfinished (note_hash ''); search by meaning cannot see it until a later pass embeds it. The partial index of
 * migration 15 answers this at the cost of those few rows.
 */
function unembeddedNoteCount(db: Database.Database, scope?: string): number {
  const pred = scope === undefined ? null : scopeSqlPredicate(normalizeScope(scope), 'path');
  const sql = `SELECT COUNT(*) FROM notes WHERE note_hash = ''${pred ? ` AND ${pred.sql}` : ''}`;
  return prepareOnce(db, sql).pluck().get(...(pred?.params ?? [])) as number;
}

/**
 * `{ index }` for a read that uses meaning-based search while the index is behind the ledger, or while notes of its
 * scope wait for their embedding (`unembeddedNotes`: the count, and search_text or a retry finds them).
 * `semantic` is whether an embedding provider is configured; without one there is no meaning
 * search for index_memory to catch up. Silence means nothing is known to be behind or waiting.
 */
export function indexNotice(
  db: Database.Database,
  semantic: boolean,
  ledger: LedgerLocation,
  scope?: string,
): { index?: { stale: true; detail: string; unembeddedNotes?: number } } {
  if (!semantic) return {};
  const behind = indexBehindLedger(
    db,
    resolveLedgerPath(ledger.memoryDir, ledger.ledgerRelPath),
    scope === undefined ? undefined : normalizeScope(scope),
  );
  const unembedded = unembeddedNoteCount(db, scope);
  if (unembedded === 0) return behind ? { index: INDEX_BEHIND } : {};
  const it = unembedded === 1 ? 'it' : 'them';
  const waiting = `${unembedded} saved note${unembedded === 1 ? ' is' : 's are'} still waiting for an embedding, so search_memory cannot find ${it} by meaning yet. search_text finds ${it} by exact words now; a retry finds ${it} once the embedder answers.`;
  return {
    index: {
      stale: true,
      detail: behind ? `${INDEX_BEHIND.detail} ${waiting}` : waiting,
      unembeddedNotes: unembedded,
    },
  };
}
