import path from 'path';
import { ledgerNotePath, type InventoryVault } from '../memory/inventory';
import { ledgerEventIds, SUPERSEDED_LABEL } from './ledgerLiveness';

/**
 * What a memory hit shows of the ledger.
 *
 * The ledger is the engine's own record of what it was asked to keep. It is indexed so that what the user said can
 * be found again (a fact-mode `remember` stores the sentence there and nowhere else), but its text is not something
 * the user said: its header ("# Memory Events Ledger", "Append-only durable record of memory events. Replayed on
 * rebuild.") and the markup of its records (`## MEM_… · time`, `- kind: store`, `- subject: …`) are bookkeeping.
 * Handed back as hits, they were the engine's internals presented as the person's memories, and a question that
 * nothing answered still got them back (new-user re-check, finding N6).
 *
 * So a hit from the ledger is never shown as it is stored:
 *  - text of the ledger that no event owns (its header) is no memory at all and is dropped;
 *  - an event is shown as what the user said when the event kept their words, and otherwise as the fact it records;
 *  - a keyword search finds an event only by what it says (the words, the subject, the predicate, the object), never by
 *    its markup: "kind" or "store" or a year is in every record, and said nothing.
 *
 * Nothing here decides which hits are found by meaning, in what order or in which scope: liveness, scope and the page
 * limit are judged on the stored text, by the callers, before the hits are shown. Only what is shown changes.
 *
 * The ledger is told by identity, as the inventory does (`ledgerNotePath`): the file this workspace is configured
 * with, never a name, a heading or front matter, which a person's own note can carry too. A note that merely looks
 * like a ledger is a note, and is returned as written.
 */

/** Whether a note path is the ledger: given as the index stores it (absolute) or as a client is shown it (relative to the vault). */
export type IsLedgerNote = (notePath: string) => boolean;

/** What is judged and rewritten: a hit, whatever else it carries. */
interface LedgerHit {
  notePath: string;
  text: string;
  headingPath?: string;
}

export function ledgerNoteMatcher(vault: InventoryVault): IsLedgerNote {
  const stored = ledgerNotePath(vault);
  if (stored === null) return () => false; // a path that cannot name a file names no ledger
  const shown = path.relative(path.resolve(vault.memoryDir), stored);
  // Clients are shown vault paths with '/' (mvp/engine.ts clientPath); on Windows the native form differs (#1563).
  const shownSlashes = shown.split(path.sep).join('/');
  return notePath => notePath === stored || notePath === shown || notePath === shownSlashes;
}

/** A chunk of the ledger that no event owns: its header (nothing else comes before the first event). */
export function isLedgerPreamble(hit: LedgerHit, isLedger: IsLedgerNote | undefined): boolean {
  return isLedger !== undefined && isLedger(hit.notePath) && ledgerEventIds(hit).length === 0;
}

/**
 * The hits without the ledger's header. For a caller that cuts a page: the header has to come off before the cut, as
 * a closed event does, so that it never takes a place that a memory should have had.
 */
export function dropLedgerPreamble<T extends LedgerHit>(hits: T[], isLedger: IsLedgerNote | undefined): T[] {
  return isLedger === undefined ? hits : hits.filter(hit => !isLedgerPreamble(hit, isLedger));
}

/**
 * The hits a keyword search may show, before its page is cut: no header of the ledger, and an event of it only when a
 * word of the question is in what the event says. The search matched the record's markup too ("kind", "store", "ledger",
 * a year), and a hit that way is no match for the question.
 */
export function keywordLedgerHits<T extends LedgerHit>(hits: T[], isLedger: IsLedgerNote | undefined, query: string, held?: LedgerRecordCache): T[] {
  if (isLedger === undefined) return hits;
  const words = wordsOf(query);
  return dropLedgerPreamble(hits, isLedger).filter(hit => {
    if (!isLedger(hit.notePath) || words.length === 0) return true;
    const events = parseEvents(hit.text, held);
    return events.length === 0 || events.some(event => {
      const said = says(event);
      return words.some(word => said.has(word));
    });
  });
}

/** The hits as a client is shown them: no header of the ledger, and each event of it as the user's words (or the fact). */
export function presentLedgerEvents<T extends LedgerHit>(hits: T[], isLedger: IsLedgerNote | undefined, held?: LedgerRecordCache): T[] {
  if (isLedger === undefined) return hits;
  return dropLedgerPreamble(hits, isLedger).flatMap(hit => {
    if (!isLedger(hit.notePath)) return [hit];
    const text = presentEvents(hit.text, held);
    // An event is one chunk that opens with its own header line (the chunker cuts at every `##` heading and never inside
    // a paragraph, and a record has no blank line), so a ledger text with no record in it is one already presented.
    if (text === null) return [hit];
    return text === '' ? [] : [{ ...hit, text }]; // a record that says nothing is not a memory
  });
}

/**
 * The hits as a client is shown their metadata: a hit of the ledger names no note and no heading (both empty). Its path
 * is the engine's own file and its heading the record's (`Memory Events Ledger > MEM_… · time`): bookkeeping too, which
 * every ledger hit carried, at about 46 tokens (live dogfood, 2026-10-03, D8). What it says is its text, and when, its
 * session_date. Run last: liveness, scope and a repeat of a fact are judged by the event id in the heading.
 */
export function withoutLedgerMetadata<T extends LedgerHit>(hits: T[], isLedger: IsLedgerNote | undefined): T[] {
  if (isLedger === undefined) return hits;
  return hits.map(hit => (isLedger(hit.notePath) ? { ...hit, notePath: '', headingPath: '' } : hit));
}

const EVENT_HEADER = /^## MEM_[A-Za-z0-9]+ · /i;
// A field value is the rest of its physical line (dotAll: U+2028/U+2029 and a lone \r belong to a value, as in the ledger parser).
const FIELD = /^- ([A-Za-z][\w-]*): (.*)$/s;

export interface LedgerRecord {
  fields: Map<string, string>;
  /** The history label came just before this event's header. */
  superseded: boolean;
  /** The words the event says (`says`), worked out the first time they are asked for. */
  said?: Set<string>;
}

/**
 * The records parsed from the chunk texts of one read, by text. A keyword read asks about the same chunk of the ledger
 * once for each variant of the question that finds it, and again to show it; the records are a function of the text alone,
 * so the read parses a text once and hands the records round. The caller makes one for its read and lets it go with the read;
 * a read without one parses each time, as it always did. Nothing that is given the records changes them.
 */
export type LedgerRecordCache = Map<string, LedgerRecord[]>;
const RECORDS_HELD_MAX = 256;
const RECORDS_HELD_MAX_CHARS = 8 * 1024;

/** The events in a chunk's text, as the lines of their records say. Tolerant: it only reads, and never throws. */
function parseEvents(text: string, held?: LedgerRecordCache): LedgerRecord[] {
  const kept = held?.get(text);
  if (kept !== undefined) return kept;
  const events = readEvents(text);
  if (held && held.size < RECORDS_HELD_MAX && text.length <= RECORDS_HELD_MAX_CHARS) held.set(text, events);
  return events;
}

function readEvents(text: string): LedgerRecord[] {
  const events: LedgerRecord[] = [];
  let labelled = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line === SUPERSEDED_LABEL) {
      labelled = true;
    } else if (EVENT_HEADER.test(line)) {
      events.push({ fields: new Map(), superseded: labelled });
      labelled = false;
    } else if (events.length > 0) {
      const field = FIELD.exec(line);
      const fields = events[events.length - 1].fields;
      if (field && !fields.has(field[1])) fields.set(field[1], field[2]);
    }
  }
  return events;
}

/**
 * The events in a chunk's text, one after another: the user's statement as they said it, else `subject — predicate:
 * object`. A superseded event (shown only on request) keeps the label that says so. Null when the text holds no event,
 * so a text that is already presented is left as it is.
 */
export function presentEvents(text: string, held?: LedgerRecordCache): string | null {
  const events = parseEvents(text, held);
  return events.length ? events.map(show).filter(Boolean).join('\n\n') : null;
}

function show({ fields, superseded }: LedgerRecord): string {
  const said = statementOf(fields.get('statement'));
  const body = said ?? factText(fields.get('subject'), fields.get('predicate'), fields.get('object'));
  return body && superseded ? `${SUPERSEDED_LABEL}\n${body}` : body;
}

/**
 * A fact as it is shown when no words of the user's were kept: `subject — predicate: object`. The one form for a fact,
 * whether an indexed event of the ledger shows it or a read that finds it in the facts table before the index does.
 */
export function factText(subject: string | undefined, predicate: string | undefined, object: string | undefined): string {
  return [subject, [predicate, object].filter(Boolean).join(': ')].filter(Boolean).join(' — ');
}

/** The statement the ledger kept: one JSON string literal. Anything else, or nothing said, is not the user's words. */
function statementOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The words of what an event says: the statement and the fact, without the record's markup. Worked out once for a record. */
function says(record: LedgerRecord): Set<string> {
  const { fields } = record;
  return record.said ??= new Set(wordsOf([statementOf(fields.get('statement')), fields.get('subject'), fields.get('predicate'), fields.get('object')]
    .filter(Boolean)
    .join(' ')));
}

/**
 * The words of a text as the keyword index reads them: runs of letters and digits, lower case, accents off. Whole
 * words, as the index matches them, so that "mem" of an event id is not found in "remember".
 */
function wordsOf(text: string): string[] {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
