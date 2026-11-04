import type Database from '../db/sqlite';
import { prepareOnce } from '../db/statements';

/**
 * Writer conflicts: when a writer replaces a value another writer saved, both values stay visible, marked, until the
 * writer that lost the value saves the same subject and predicate again.
 *
 * The writer of a fact is the identity the gateway (or the OAuth client) authenticated for the connection that saved it
 * (`agentOf` in mvp/server.ts). It is never the `source` the caller typed, which says nothing a caller cannot choose. A
 * fact with no writer recorded (written before this table, or by a path that names none) was saved by its source, so its
 * writer is its source, or `unnamed` when it has none.
 *
 * Each fact a write leaves current carries the displacements still open on it, in `fact_writers` keyed by its event:
 *   - a save by the same writer keeps every open displacement (the other writer has not confirmed yet);
 *   - a save by another writer clears the displacements that writer owns, whichever value it saves: that is its
 *     confirmation. A save by a third writer clears nothing it does not own, so the other displacements stay open;
 *   - it opens a displacement for the value it replaces (the value, its writer and its date), unless that value is the
 *     one that displaced the writer's own displacement (it answered its counter-claim) or the two values are the same text.
 * Replay derives the same rows from the ledger. A live index has no rows for facts saved before migration 26, so those
 * have no displacements on it; a rebuild from the ledger derives rows for them, so a rebuilt index can show a line the
 * live one does not. A fact with no row has no displacements.
 */

/** The writer a write has when it has no authenticated identity and no source. */
export const UNNAMED_WRITER = 'unnamed';

/** A value another writer replaced, which that writer has not confirmed yet. */
export interface OpenDisplacement {
  /** Who saved the value that was replaced. */
  writer: string;
  object: string;
  validFrom: string;
  /** The event that replaced it. Its writer confirms it by a save that replaces that very value. */
  byEvent: string;
}

/** The fact a write closes: its event, value, when it was saved, and its source (its writer when none was recorded). */
export interface ClosedFact {
  eventId: string | null;
  object: string;
  validFrom: string;
  source: string | null;
}

interface WriterRow {
  writer: string;
  displaced: string;
}

/** The writer a fact event recorded, and the displacements open on it. */
export function writerOf(db: Database.Database, eventId: string | null, source: string | null): { writer: string; displaced: OpenDisplacement[] } {
  const row = eventId === null ? undefined : prepareOnce(db, 'SELECT writer, displaced FROM fact_writers WHERE event_id = ?').get(eventId) as WriterRow | undefined;
  if (row) return { writer: row.writer, displaced: JSON.parse(row.displaced) as OpenDisplacement[] };
  return { writer: source || UNNAMED_WRITER, displaced: [] };
}

/** Two values agree when they are the same text once composed and trimmed. */
const sameValue = (a: string, b: string): boolean => a.normalize('NFC').trim() === b.normalize('NFC').trim();

/**
 * The displacements a save leaves open on the fact it creates: `write` is that save (its event, writer and value) and
 * `closed` the fact it replaces, null when it replaces none.
 */
export function displacementsAfter(
  db: Database.Database,
  closed: ClosedFact | null,
  write: { eventId: string; writer: string; object: string },
): OpenDisplacement[] {
  if (closed === null) return [];
  const before = writerOf(db, closed.eventId, closed.source);
  if (before.writer === write.writer) return before.displaced;
  const rest = before.displaced.filter(d => d.writer !== write.writer);
  const confirms = before.displaced.some(d => d.writer === write.writer && d.byEvent === closed.eventId);
  if (confirms || sameValue(closed.object, write.object)) return rest;
  return [...rest, { writer: before.writer, object: closed.object, validFrom: closed.validFrom, byEvent: write.eventId }];
}

/** Whether `writer` has a displacement open on the fact `eventId`, which its next save of the subject and predicate confirms. */
export function hasOpenDisplacementBy(db: Database.Database, eventId: string, writer: string): boolean {
  return writerOf(db, eventId, null).displaced.some(d => d.writer === writer);
}

/** RENOR_UPDATE_AS_HISTORY=1 (or on/true): an ordinary update by another agent reads as history, not CONFLICT. Off by default. */
export const updateAsHistory = (): boolean => /^(1|on|true|yes)$/i.test(process.env.RENOR_UPDATE_AS_HISTORY?.trim() ?? '');

/**
 * A genuine conflict: values saved by two or more different writers are still open against the current one, so the
 * writers disagree with each other and not just with an earlier value of their own. A single replaced value is an update.
 */
export function isSimultaneousDisagreement(open: OpenDisplacement[]): boolean {
  return new Set(open.map(d => d.writer)).size > 1;
}

/**
 * One line a read shows beside a current value that replaced another writer's value: the values it displaced, each with
 * its writer and date, and what clears them. Plain words, so an agent reads it as it reads the rest of the reply.
 */
export function writerConflictLine(open: OpenDisplacement[]): string {
  if (updateAsHistory() && !isSimultaneousDisagreement(open)) {
    const replaced = open.map(d => `replaced ${JSON.stringify(d.object)} (${d.writer}, ${d.validFrom.slice(0, 10)})`).join('; ');
    return `${replaced}; the value shown is current.`;
  }
  const values = open.map(d => `${JSON.stringify(d.object)} by ${d.writer}, ${d.validFrom.slice(0, 10)}`).join('; ');
  return `CONFLICT: ${values}. Replaced by a different writer; it stays a conflict until that writer saves this subject and predicate again.`;
}

/**
 * The conflict line of each current fact (by event id) that has displacements open, read in one query. A fact with none
 * has no entry, so a reply about it is what it was before.
 */
export function writerConflictLines(db: Database.Database, eventIds: ReadonlyArray<string | null | undefined>): Map<string, string> {
  const ids = [...new Set(eventIds.filter((id): id is string => typeof id === 'string'))];
  const lines = new Map<string, string>();
  if (ids.length === 0) return lines;
  const rows = prepareOnce(db, 'SELECT event_id, displaced FROM fact_writers WHERE event_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)) as Array<{ event_id: string; displaced: string }>;
  for (const row of rows) {
    const open = JSON.parse(row.displaced) as OpenDisplacement[];
    if (open.length > 0) lines.set(row.event_id, writerConflictLine(open));
  }
  return lines;
}
