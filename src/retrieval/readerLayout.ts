import { withRelativeTimeHints } from './relativeTimeHints';
import { SESSION_EXPAND_REASON, sessionDateMs } from './orchestrator';
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
 *  - the blocks stand where the page had them (newest first by default). RENOR_READER_ORDER=relevance puts them best match
 *    first instead (a block's score is its best chunk's, ties newest first) and the reply says so (`rankedBy: score`,
 *    readerLayoutPage; only a page whose ordinary notes are all conversations). It is off by default: on RenorBench v2 it puts a
 *    superseded value ahead of the current one (tests/eval/renorbench-v2.test.ts);
 *  - RENOR_READER_SESSION_CAP=N lets a session show at most N chunks besides its header, except that every chunk the query
 *    matched stays: the cap only stops the statements the session expansion added. Off by default (0): on RenorBench v2 a cap
 *    of 10 drops the remark a question asks about, which only the expansion delivers;
 *  - a session that reaches the reader without its header (the date line is its first chunk) opens with
 *    `[Session date: <date>]`;
 *  - each time phrase that names one point in time ("three weeks ago", "last Thursday") is resolved to its date below
 *    the excerpt (relativeTimeHints.ts).
 *
 * Whole chunks leave (a header stub, a statement over the cap); no chunk is cut or reworded.
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
 *
 * Opt-in, and only on top of this layout (`RENOR_READER_TIMELINE=1`; default off, so a layout-on page is byte-identical):
 * when the question asks what a value is now, one timeline of the user turns that state it is placed above the excerpts.
 * Oldest first, the latest line marked, earlier lines kept. It quotes those turns and does not cut or reword an excerpt,
 * invent a value, or do arithmetic on a session header (a header date orders two different calendar days only; a shared
 * day is not a clock). A duration question or an order question is left untouched.
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

/** Default off. `1` / `true` / `yes` / `on` places a current-value timeline above a layout-on page. */
export function readerTimelineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RENOR_READER_TIMELINE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// A duration or an order stays byte-identical. "Ago" and "last Tuesday" are a point in the past, not a changed value.
const DURATION_QUESTION = /\b(?:how (?:many|much) (?:days|weeks|months|years)|how long|how much time|how old)\b|\b(?:days|weeks|months|years)\b[^?]{0,24}\b(?:ago|passed)\b|\bago\b|\bpassed between\b|\blast (?:week|month|year|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const ORDER_QUESTION = /\border\b|\b(?:first to last|earliest to latest|happened first|came first)\b|\b(?:which|who)\b[^?]{0,80}\bfirst\b/i;
const CURRENT_VALUE_QUESTION = /\b(?:now|currently|current|most recent(?:ly)?|latest|so far|previous(?:ly)?|updated|initially|what changed|used to|how many|how often|how much|what|where|did i|do i|am i|is my|have i)\b/i;

/** A knowledge-update-shaped question: what the value is now, or what it was before it changed. Not a duration or an order. */
export function isCurrentValueQuestion(query: string): boolean {
  const q = (query.split('\n').pop() ?? query).trim();
  if (q === '' || DURATION_QUESTION.test(q) || ORDER_QUESTION.test(q)) return false;
  return CURRENT_VALUE_QUESTION.test(q);
}

const QUOTE_STOP = new Set([
  'what', 'where', 'when', 'which', 'who', 'whom', 'how', 'many', 'much', 'often', 'does', 'did', 'do', 'have', 'has',
  'had', 'was', 'were', 'been', 'being', 'this', 'that', 'these', 'those', 'with', 'from', 'your', 'about', 'into',
  'over', 'under', 'after', 'before', 'between', 'since', 'until', 'while', 'just', 'still', 'also', 'than', 'then',
  'them', 'they', 'their', 'there', 'here', 'would', 'could', 'should', 'will', 'shall', 'can', 'may', 'might', 'must',
  'some', 'any', 'more', 'most', 'other', 'only', 'same', 'very', 'really', 'around', 'time', 'times', 'when',
]);

function contentTokens(question: string): Set<string> {
  const words = question.toLowerCase().match(/[a-z0-9$][a-z0-9$'-]{3,}/g) ?? [];
  return new Set(words.filter(word => !QUOTE_STOP.has(word) && !/^\d+$/.test(word)));
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  return longer === `${shorter}s` || longer === `${shorter}es`;
}

function sharesToken(sentence: string, tokens: Set<string>): boolean {
  const words = sentence.toLowerCase().match(/[a-z0-9$][a-z0-9$'-]{3,}/g) ?? [];
  return words.some(word => {
    for (const token of tokens) if (sameWord(word, token)) return true;
    return false;
  });
}

function headingOf(line: string): string | null {
  const match = /^#{1,6}\s+(.*)$/.exec(line.trim());
  return match ? match[1].trim() : null;
}

function headingWords(heading: string): string[] {
  return heading.toLowerCase().replace(/[\p{N}\p{P}\p{S}\p{Z}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

function isUserTurnHeading(line: string): boolean {
  const heading = headingOf(line);
  if (heading === null || !isTurnLabel(heading)) return false;
  const words = headingWords(heading);
  return words.includes('user') || words.includes('human');
}

function isTurnHeading(line: string): boolean {
  const heading = headingOf(line);
  return heading !== null && isTurnLabel(heading);
}

/** The user's own words in one laid-out hit, one string per user turn. Assistant turns are not quoted. */
function userTurnBodies(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isUserTurnHeading(lines[i])) continue;
    const buf: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (isTurnHeading(lines[j])) break;
      if (trimmed.startsWith('[Counted from this session\'s date') || trimmed.startsWith('[Session date:')) continue;
      buf.push(lines[j]);
    }
    const body = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (body !== '') bodies.push(body);
  }
  return bodies;
}

function quoteSentences(body: string, tokens: Set<string>): string | null {
  const sentences = body.split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(sentence => sentence !== '');
  const kept = (sentences.length > 0 ? sentences : [body]).filter(sentence => sharesToken(sentence, tokens));
  if (kept.length === 0) return null;
  const best = kept.slice().sort((a, b) => Number(sharesToken(b, tokens)) - Number(sharesToken(a, tokens)) || b.length - a.length)[0];
  const text = kept.length === 1 ? kept[0] : [best, ...kept.filter(sentence => sentence !== best)].slice(0, 2).join(' ');
  if (text.length <= 500) return text;
  const lower = best.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    const found = lower.indexOf(token);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return best.slice(0, 500).trim();
  const start = Math.max(0, at - 180);
  return best.slice(start, Math.min(best.length, start + 500)).trim();
}

/** Calendar day only. The clock on a shared day is not an order: those stamps are often the question's own day. */
function calendarDay(sessionDate: string | undefined): string | null {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(sessionDate ?? '');
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function sessionIndex(notePath: string): number | null {
  const base = notePath.split('/').pop() ?? notePath;
  const match = /_(\d+)(?:-|\.|$)/.exec(base);
  return match ? Number(match[1]) : null;
}

interface StatedValue {
  day: string | null;
  index: number | null;
  chunk: number;
  appearance: number;
  text: string;
}

/**
 * The timeline line, or null when this question is not a current-value question or no user turn states one.
 * Nothing here is invented: every quote is a substring of a user turn that is already in `hits`.
 */
export function currentValueTimeline(hits: readonly LayoutHit[], query: string): string | null {
  if (!isCurrentValueQuestion(query)) return null;
  const tokens = contentTokens(query.split('\n').pop() ?? query);
  if (tokens.size === 0) return null;
  const stated: StatedValue[] = [];
  const seen = new Set<string>();
  hits.forEach((hit, appearance) => {
    const day = calendarDay(hit.session_date);
    const index = sessionIndex(hit.notePath);
    for (const body of userTurnBodies(hit.text)) {
      const text = quoteSentences(body, tokens);
      if (text === null) continue;
      // One statement per note: the same words in a later session are a later statement (A, B, A ends on A), not a repeat.
      const key = `${hit.notePath}\u0000${text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stated.push({ day, index, chunk: hit.chunkId ?? 0, appearance, text });
    }
  });
  if (stated.length === 0) return null;
  stated.sort((a, b) => {
    if (a.day !== null && b.day !== null && a.day !== b.day) return a.day < b.day ? -1 : 1;
    if (a.index !== null && b.index !== null && a.index !== b.index) return a.index - b.index;
    if (a.chunk !== b.chunk) return a.chunk - b.chunk;
    return a.appearance - b.appearance;
  });
  const lines = stated.map((value, i) => (i === stated.length - 1 ? `- latest: "${value.text}"` : `- "${value.text}"`));
  return ['Stated by the user, oldest first. Earlier values stay. The last line is the latest.', ...lines].join('\n');
}

function withCurrentValueTimeline<T extends LayoutHit>(hits: T[], query: string | undefined): T[] {
  if (!readerTimelineEnabled() || query === undefined || query.trim() === '') return hits;
  const text = currentValueTimeline(hits, query);
  if (text === null) return hits;
  return [{ notePath: '', text, score: 0, reason: 'timeline' } as T, ...hits];
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

/** The most chunks of one session's block (its header aside); RENOR_READER_SESSION_CAP, 0 (the default) is no cap. */
export const READER_SESSION_CAP = 0;

export function readerSessionCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RENOR_READER_SESSION_CAP ?? '').trim();
  if (raw === '') return READER_SESSION_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : READER_SESSION_CAP;
}

export type BlockOrder = 'relevance' | 'date';

/** Blocks keep the page's own (newest-first) order; RENOR_READER_ORDER=relevance puts them best match first. */
export function readerBlockOrder(env: NodeJS.ProcessEnv = process.env): BlockOrder {
  return (env.RENOR_READER_ORDER ?? '').trim().toLowerCase() === 'relevance' ? 'relevance' : 'date';
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
  /** The most chunks one session may show besides its header (default readerSessionCap()); 0 is no cap. */
  sessionCap?: number;
  /** How the blocks are ordered (default readerBlockOrder()). */
  order?: BlockOrder;
}

interface Block<T extends LayoutHit> {
  header: T[];
  body: T[];
  first: number;
}

/** A hit of an ordinary note (a chunk the layout could place, a daily entry, a document paragraph): not a fact, a ledger event, a correction or the evidence and digest tables (`_renor/…`). */
function isOrdinaryNoteHit(hit: LayoutHit & { author?: unknown; replaced?: unknown }, isLedger: (notePath: string) => boolean): boolean {
  return hit.notePath !== '' && !hit.notePath.startsWith('_renor/') && !isLedger(hit.notePath) && hit.author === undefined && hit.replaced === undefined;
}

export function layoutHitsForReader<T extends LayoutHit>(hits: T[], opts: LayoutOptions): T[] {
  return layoutPage(hits, opts).hits;
}

/**
 * `byRelevance` is true when the blocks were placed best match first, which the reply then says (`rankedBy: score`). It is
 * done only to a page whose every chunk of an ordinary note is a conversation's: a daily note's entries or a document's
 * paragraphs on the same page keep the order the page gave them, and a page that is half one order and half the other must
 * not claim either key.
 */
export function layoutPage<T extends LayoutHit>(hits: T[], opts: LayoutOptions): { hits: T[]; byRelevance: boolean } {
  const chunk = (hit: T): boolean => isNoteChunk(hit, opts.isLedger) && (opts.isConversation?.(hit.notePath) ?? true);
  const cap = opts.sessionCap ?? readerSessionCap();
  const order = opts.order ?? readerBlockOrder();
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
  for (const [key, block] of blocks) made.set(key, blockHit(block, cap));

  // The blocks stand in the places the page gave its chunks; anything else keeps its place.
  const slots = new Set(laid.flatMap((hit, index) => (keyOf(hit) !== null && blocks.get(keyOf(hit)!)!.first === index ? [index] : [])));
  let placed = [...slots].map(index => keyOf(laid[index])!).filter(key => made.get(key) !== null);
  const byRelevance = order === 'relevance' && placed.length > 0 && hits.every(hit => !isOrdinaryNoteHit(hit, opts.isLedger) || chunk(hit));
  if (byRelevance) {
    const at = new Map(placed.map((key, i) => [key, i]));
    placed = [...placed].sort((a, b) => made.get(b)!.score - made.get(a)!.score
      || (sessionDateMs(made.get(b)!.session_date) || 0) - (sessionDateMs(made.get(a)!.session_date) || 0)
      || at.get(a)! - at.get(b)!);
  }
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
  // RENOR_READER_TIMELINE (default off): a current-value timeline for a "what is it now" question; a duration or an order question is left alone.
  // Each such line comes first, outside the order rankedBy names, as the evidence hit does. The event lines too read the
  // conversations as the page found them: a session that came as its header alone is no hit, but its turns are still read.
  return {
    hits: withCurrentValueTimeline(withEventLines(withQuestionSpan(dated, opts.query, { source: hits }), hits.filter(chunk), opts), opts.query),
    byRelevance,
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
 * score and reason of its chunks. A session that came as a header and nothing else is no hit. Over the cap, every chunk the
 * query matched stays and the statements the session expansion added are taken in the order they came, as many as the cap leaves room for.
 */
function blockHit<T extends LayoutHit>(block: Block<T>, cap: number): T | null {
  if (block.body.length === 0) return null;
  const byPlace = (a: T, b: T): number => (a.chunkId ?? 0) - (b.chunkId ?? 0);
  let body = block.body;
  if (cap > 0 && body.length > cap) {
    // What the query matched always stays; the cap only limits the statements the session expansion added.
    const expanded = body.filter(h => h.reason === SESSION_EXPAND_REASON);
    const room = Math.max(0, cap - (body.length - expanded.length));
    const kept = new Set([...body.filter(h => h.reason !== SESSION_EXPAND_REASON), ...expanded.slice(0, room)]);
    body = body.filter(h => kept.has(h));
  }
  const run = [...block.header, ...body].sort(byPlace);
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
    rankedBy: laid.byRelevance ? 'score' : rankedBy,
  };
}

/** The hits of readerLayoutPage alone. */
export function readerLayoutOf<T extends object>(rankedBy: HitOrder | undefined, hits: T[], isLedger: (notePath: string) => boolean, events: ReaderEventsInput | string = {}, enabled: boolean = readerLayoutEnabled()): T[] {
  return readerLayoutPage(rankedBy, hits, isLedger, events, enabled).hits;
}
