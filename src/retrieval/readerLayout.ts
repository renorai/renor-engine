import { withRelativeTimeHints } from './relativeTimeHints';
import { withQuestionSpan } from './questionSpan';
import { eventLines, readerEventsEnabled, type EventLineOptions, type NoteSource, type NoteTurn } from './readerEvents';
import type Database from '../db/sqlite';
import { isTurnLabel } from './conversationShape';
import { asksForAdvice } from './adviceQuestion';
import type { HitOrder } from './orchestrator';

/**
 * How a search reply is laid out for the model that reads it. Retrieval picks the window and orders it; this only
 * changes how what it picked is handed over, and it never cuts or rewrites a word of an excerpt it shows:
 *
 *  - one hit per session: the chunks of a note on one date, which the newest-first layout left apart (a session's header,
 *    which carries its date, could come after the turns it dates, and turns of other sessions in between), come as one hit,
 *    in the note's own order, so every turn sits under the date of its session;
 *  - a session whose only chunk is its header (`# Session x` and a `Timestamp:` line) is no hit: it dated nothing the reader
 *    can see and took a place in the reply (a third of the hits of the 2026-10-16 LongMemEval-S run);
 *  - the blocks stand where the page had them (newest first by default);
 *  - a session that reaches the reader without its header (the date line is its first chunk) opens with
 *    `[Session date: <date>]`;
 *  - each time phrase that names one point in time ("three weeks ago", "last Thursday") is resolved to its date below
 *    the excerpt (relativeTimeHints.ts).
 *
 * Whole chunks leave (a header stub); no chunk is cut or reworded.
 *
 * Only notes shaped like a conversation (conversationShape.ts) are laid out: a session is one conversation, and merging
 * the chunks of a document or the entries of a daily note would break "a hit is one memory".
 *
 * Measured on LongMemEval-S dev100 with `gemma4:31b` as reader and judge: see docs/evals/results/READER-LAYOUT-20261014.md.
 * Not applied to get_context (its budget cuts whole items by relevance) or to any hit that is no chunk of an ordinary
 * note: a remembered fact, a ledger event, a correction, the evidence or digest table. Kill switch: RENOR_READER_LAYOUT=0.
 *
 * On by default, and only on top of this layout (`RENOR_READER_EVENTS=0` switches it off; then a layout-on page is
 * byte-identical): when the question asks for the order or the date of something the user did, one line per matching
 * statement of the user's, dated and oldest first, is placed above the excerpts (readerEvents.ts). A duration question and
 * any other question are left untouched.
 */

export function readerLayoutEnabled(): boolean {
  const v = (process.env.RENOR_READER_LAYOUT ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/**
 * Default on (decided by firstmate under the owner's autonomy rule, 2026-10-30; see the CHANGELOG). A query that asks to be
 * advised (adviceQuestion.ts: a recommendation, a suggestion, tips, ideas, an opinion) is left without the layout, so its page
 * is the one RENOR_READER_LAYOUT=0 gives. `0`, `false`, `no` or `off` turns the exception off: every query is laid out as before.
 * Any other value, and unset, keeps the exception on, as the other switches treat an unknown value.
 */
export function readerLayoutSkipsAdvice(): boolean {
  const v = (process.env.RENOR_READER_LAYOUT_SKIP_ADVICE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/** Is the page of this query laid out? The kill switch decides first, then the advice exception. */
export function readerLayoutEnabledFor(query: string): boolean {
  return readerLayoutEnabled() && !(readerLayoutSkipsAdvice() && asksForAdvice(query));
}

/**
 * A note of turns: at least `LAYOUT_MIN_TURNS` of its distinct heading paths end in a speaker or turn label (conversationShape.ts
 * isTurnLabel) and those are at least half of its paths. One exchange, a question and its answer, is a conversation here: the
 * session expansion's own rule asks for four turns because it cuts statements, and this one only joins what a session already is.
 */
export const LAYOUT_MIN_TURNS = 2;
export function isConversation(headingPaths: readonly string[]): boolean {
  const distinct = new Set(headingPaths);
  let turns = 0;
  for (const headingPath of distinct) if (isTurnLabel(headingPath.split(' > ').pop() ?? '')) turns += 1;
  return turns >= LAYOUT_MIN_TURNS && turns * 2 >= distinct.size;
}

/** Is this stored note path a conversation? Told from the headings of its chunks, once per note. */
export function conversationNoteMatcher(db: Database.Database): (storedNotePath: string) => boolean {
  const select = db.prepare('SELECT heading_path AS headingPath FROM chunks WHERE note_path = ?');
  const known = new Map<string, boolean>();
  return storedNotePath => {
    let shaped = known.get(storedNotePath);
    if (shaped === undefined) {
      shaped = isConversation((select.all(storedNotePath) as Array<{ headingPath: string }>).map(row => row.headingPath));
      known.set(storedNotePath, shaped);
    }
    return shaped;
  };
}

export interface LayoutHit {
  notePath: string;
  /** The chunk's id; it grows with the chunk's place in its note. Absent, zero or negative: the hit is no chunk of a note. */
  chunkId?: number;
  text: string;
  score: number;
  reason: string;
  session_date?: string;
  similarity?: number;
}

function isNoteChunk(hit: LayoutHit & { author?: unknown; replaced?: unknown }, isLedger: (notePath: string) => boolean): boolean {
  return (hit.chunkId ?? 0) > 0 && hit.notePath !== '' && !isLedger(hit.notePath) && hit.author === undefined && hit.replaced === undefined;
}

/**
 * A chunk that is only a session's header: headings and `Timestamp:` lines, no turn. It dates the turns under it and says
 * nothing itself; on its own it is a stub that takes a place in the reply (a third of the hits of the 2026-10-16 run).
 */
export function isHeaderOnly(text: string): boolean {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && !/^#{1,6}\s/.test(line));
  return lines.length > 0 && lines.every(line => /^Timestamp:/i.test(line));
}

export interface ReaderEventsInput {
  /** The question as the search received it (a `Question date:` line may come first). Event lines need it. */
  query?: string;
  /** The stored chunks of a conversation note, to read the user's turns of every conversation the page holds. */
  turnsOf?: (source: NoteSource) => NoteTurn[];
  /** The cosine of stored chunks to the question's vector (readerEvents.ts turnScorer), when the caller holds that vector. */
  scoreTurns?: EventLineOptions['scoreTurns'];
}

export interface LayoutOptions extends ReaderEventsInput {
  rankedBy: HitOrder | undefined;
  isLedger: (notePath: string) => boolean;
  isConversation?: (notePath: string) => boolean;
}

interface Block<T extends LayoutHit> {
  header: T[];
  body: T[];
  first: number;
}

export function layoutHitsForReader<T extends LayoutHit>(hits: T[], opts: LayoutOptions): T[] {
  return layoutPage(hits, opts).hits;
}

export function layoutPage<T extends LayoutHit>(hits: T[], opts: LayoutOptions): { hits: T[] } {
  const chunk = (hit: T): boolean => isNoteChunk(hit, opts.isLedger) && (opts.isConversation?.(hit.notePath) ?? true);
  const laid = hits.map(hit => (chunk(hit) ? { ...hit, text: withRelativeTimeHints(hit.text, hit.session_date) } : hit));

  // One block per conversation on one date: every chunk of it under that date, wherever the page had put it.
  const keyOf = (hit: T): string | null => (chunk(hit) ? `${hit.notePath}\0${hit.session_date ?? ''}` : null);
  const blocks = new Map<string, Block<T>>();
  laid.forEach((hit, index) => {
    const key = keyOf(hit);
    if (key === null) return;
    const block = blocks.get(key) ?? { header: [], body: [], first: index };
    (isHeaderOnly(hit.text) ? block.header : block.body).push(hit);
    blocks.set(key, block);
  });

  const made = new Map<string, T | null>();
  for (const [key, block] of blocks) made.set(key, blockHit(block));

  // The blocks stand in the places the page gave its chunks; anything else keeps its place.
  const slots = new Set(laid.flatMap((hit, index) => (keyOf(hit) !== null && blocks.get(keyOf(hit)!)!.first === index ? [index] : [])));
  const placed = [...slots].map(index => keyOf(laid[index])!).filter(key => made.get(key) !== null);
  const out: T[] = [];
  let next = 0;
  laid.forEach((hit, index) => {
    const key = keyOf(hit);
    if (key === null) out.push(hit);
    else if (slots.has(index) && made.get(key) !== null) out.push(made.get(placed[next++])!);
  });
  const dated = out.map(hit => (chunk(hit) && hit.session_date && !/Timestamp:/i.test(hit.text)
    ? { ...hit, text: `[Session date: ${hit.session_date}]\n${hit.text}` }
    : hit));
  // RENOR_READER_DURATION (default on; `0` switches it off): one line of dates the user wrote, first, for a "how many days between" question (questionSpan.ts).
  // It reads the chunks as they were found: joined, a turn's continuation would sit under the speaker before it.
  // RENOR_READER_EVENTS (default on; `0` switches it off) adds event lines for an order or a date question; its gate leaves a duration question alone, so at most one of the two lines is added.
  // Each such line comes first, outside the order rankedBy names, as the evidence hit does. The event lines too read the
  // conversations as the page found them: a session that came as its header alone is no hit, but its turns are still read.
  return {
    hits: withEventLines(withQuestionSpan(dated, opts.query, { source: hits }), hits.filter(chunk), opts),
  };
}

/** The event lines, as the first hit (reason "events"), when the flag is on and the question asks for an order or a date. `sources` are the conversation chunks they read. */
function withEventLines<T extends LayoutHit>(hits: T[], sources: readonly LayoutHit[], opts: ReaderEventsInput): T[] {
  if (!readerEventsEnabled() || opts.query === undefined || opts.turnsOf === undefined || opts.query.trim() === '') return hits;
  const text = eventLines(sources, opts.query, opts.turnsOf, { scoreTurns: opts.scoreTurns });
  if (text === null) return hits;
  return [{ notePath: '', text, score: 0, reason: 'events' } as T, ...hits];
}

/**
 * One conversation's hit: its header first when it came, then its turns in the conversation's own order, with the best
 * score and reason of its chunks. A session that came as a header and nothing else is no hit.
 */
function blockHit<T extends LayoutHit>(block: Block<T>): T | null {
  if (block.body.length === 0) return null;
  const byPlace = (a: T, b: T): number => (a.chunkId ?? 0) - (b.chunkId ?? 0);
  const run = [...block.header, ...block.body].sort(byPlace);
  if (run.length === 1) return run[0];
  const best = run.reduce((a, b) => (b.score > a.score ? b : a));
  const similarities = run.flatMap(h => (typeof h.similarity === 'number' ? [h.similarity] : []));
  return {
    ...run[0],
    text: run.map(h => h.text).join('\n\n'),
    score: best.score,
    reason: best.reason,
    ...(similarities.length > 0 ? { similarity: Math.max(...similarities) } : {}),
  };
}

/**
 * The page search_memory shows, laid out for its reader when RENOR_READER_LAYOUT is on (the chunk ids the layout needed
 * leave with it); otherwise the page as it was. `rankedBy` is the key the returned page is in order of. `enabled` is the
 * answer for this query (readerLayoutEnabledFor).
 */
export function readerLayoutPage<T extends object>(rankedBy: HitOrder | undefined, hits: T[], isLedger: (notePath: string) => boolean, events: ReaderEventsInput | string = {}, enabled: boolean = readerLayoutEnabled()): { hits: T[]; rankedBy: HitOrder | undefined } {
  if (!enabled) return { hits, rankedBy };
  // A bare string is the question alone (the duration line's form); the object also carries what the event lines read.
  const input: ReaderEventsInput = typeof events === 'string' ? { query: events } : events;
  const laid = layoutPage(hits as Array<T & LayoutHit>, { rankedBy, isLedger, ...input });
  return {
    hits: laid.hits.map(hit => {
      const { chunkId: _chunkId, ...rest } = hit as T & { chunkId?: number };
      return rest as unknown as T;
    }),
    rankedBy,
  };
}

/** The hits of readerLayoutPage alone. */
export function readerLayoutOf<T extends object>(rankedBy: HitOrder | undefined, hits: T[], isLedger: (notePath: string) => boolean, events: ReaderEventsInput | string = {}, enabled: boolean = readerLayoutEnabled()): T[] {
  return readerLayoutPage(rankedBy, hits, isLedger, events, enabled).hits;
}
