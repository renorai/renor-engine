import { closedLedgerEvents, ledgerEventIds, resolveLedgerHits } from './ledgerLiveness';
import { dropLedgerPreamble, type IsLedgerNote } from './ledgerPresentation';
import { createLedgerEventClock } from './ledgerEventTime';
import { createDailyEntryClock } from './dailyEntryTime';
import { dailyNoteDayName } from '../memory/dailyNote';
import Database from '../db/sqlite';
import { inReadSnapshot } from '../db/readCache';
import { listStatement, paddedList, prepareOnce } from '../db/statements';
import { VectorIndex } from '../embeddings/vectorIndex';
import { byScoreThenPlace, semanticSearch, type ChunkFilter, type ChunkScope, type RetrievalProbe } from './semantic';
import { lookupEntity } from './entityLookup';
import { factsFirstHits } from './factsFirst';
import { isConversationShaped } from './conversationShape';
import { CALIBRATED_BARS, embeddingModelKey } from '../mvp/contextRelevance';
import { keywordOrAll, keywordOrMatch, keywordSearch } from './keyword';
import { quoteFtsQuery, shownPage } from './queryHelpers';
import { keywordLedgerHits } from './ledgerPresentation';
import { noteStage, noteDrop } from './explain.js';
import {
  NEAR_DUP_POOL, contentTerms, factBoostMatches, applyNearDupCap, queryRewriteEnabled, rerankTopN, resolveNearDupCap, resolveRerankTopN, rewriteConversationalQuery,
} from './plainWording';
import { addRankingTerm, attachRankingTerms, currentRankingTrace, newRankingTerms, rankingTermIndex } from './rankingTrace';

export interface RetrievalHit {
  notePath: string;
  chunkId: number;
  headingPath: string;
  text: string;
  score: number;
  reason: string;
  /** Session/note date for clients to stamp excerpts. Never rewritten into `text`. */
  session_date?: string;
  /** Raw vector cosine before any boost or penalty. Semantic hits only, and only when the caller passed a `probe`. */
  similarity?: number;
}
/** The hit field a result is sorted by: newest `session_date` first, or highest `score` first. */
export type HitOrder = 'session_date' | 'score';
export interface RetrievalResult {
  query: string;
  hits: RetrievalHit[];
  /**
   * The key `hits` is in order of. The window is always SELECTED by score (the best top-K chunks); this says how
   * that window is laid out. `session_date` (the product default) puts the newest excerpt first, so hits[0] is
   * the most recent match, not the best one: judge a match by its `score`, never by its position.
   */
  rankedBy: HitOrder;
}

function envFlagOn(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Newest-first is product default (S0 KEEP). Opt out with RENOR_NEWEST_FIRST=0/false/off. */
function newestFirstEnabled(): boolean {
  const v = (process.env.RENOR_NEWEST_FIRST ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  if (v === '') return true;
  return envFlagOn('RENOR_NEWEST_FIRST');
}

/**
 * Temporal ranking is product default (RenorBench prefer_current/prefer_historical
 * fix, 2026-09-17). Opt out with RENOR_TEMPORAL_RANKING=0/false/off — a kill
 * switch that reverts to pre-temporal ordering without a redeploy.
 */
function temporalRankingEnabled(): boolean {
  const v = (process.env.RENOR_TEMPORAL_RANKING ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  if (v === '') return true;
  return envFlagOn('RENOR_TEMPORAL_RANKING');
}

/** Explicit past-intent query: "what was it before / previously / used to be". */
export function hasPastIntent(query: string): boolean {
  return /\b(previously|before|used to|former|formerly|earlier|in the past|history)\b/i.test(query);
}

/**
 * STRICT past intent: the temporal word must signal that the QUESTION TARGET is
 * the past state, not merely appear in a query whose answer is current
 * ("Which FORMER vegetarian NOW eats fish?" asks for the present).
 */
export function hasStrictPastIntent(query: string): boolean {
  if (!hasPastIntent(query)) return false;
  return !/\b(now|currently|current)\b/i.test(query);
}

/**
 * Corpus-level historical marker in note frontmatter. Deliberately conservative:
 * only explicit declarations count, so ordinary notes are never demoted.
 */
export function frontmatterMarksHistorical(frontmatterJson: string | undefined): boolean {
  if (!frontmatterJson) return false;
  let fm: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(frontmatterJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  const historicalFlag = fm['historical'] === true || fm['archived'] === true;
  const kind = typeof fm['kind'] === 'string' ? fm['kind'].toLowerCase() : '';
  const type = typeof fm['type'] === 'string' ? fm['type'].toLowerCase() : '';
  return historicalFlag || kind === 'history' || kind === 'historical' || type === 'history' || type === 'historical';
}

function asDateString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

/**
 * Parse LME `YYYY/MM/DD (Dow) HH:MM` as UTC and ISO date-only strings as UTC midnight.
 * ISO datetimes require `Z` or an explicit numeric offset; never interpret them in host-local time.
 */
export function sessionDateMs(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const official = /^(\d{4})\/(\d{2})\/(\d{2})(?: \([A-Za-z]{3}\))?(?: (\d{2}):(\d{2}))?$/.exec(value);
  const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const zonedIsoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const iso = official
    ? `${official[1]}-${official[2]}-${official[3]}T${official[4] ?? '00'}:${official[5] ?? '00'}:00Z`
    : isoDateOnly
      ? `${value}T00:00:00Z`
      : zonedIsoDateTime
        ? value
        : undefined;
  const ms = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function resolveSessionDate(frontmatterJson: string | undefined, modifiedAt: string | undefined): string | undefined {
  let fm: Record<string, unknown> = {};
  if (frontmatterJson) {
    try {
      const parsed = JSON.parse(frontmatterJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
    } catch {
      fm = {};
    }
  }
  const modified = asDateString(modifiedAt);
  const asserted = asDateString(fm.session_date) ?? asDateString(fm.date);
  if (asserted === undefined) return modified;
  return clampSessionDate(asserted, modified);
}

// Absorbs coarse kernel file timestamps and 1–2 s filesystem resolution.
export const WRITE_CLOCK_TOLERANCE_MS = 2000;

/** Every content-derived clock, including entry/event overrides, obeys the write-time bound plus clock tolerance. */
export function clampSessionDate(asserted: string | undefined, modifiedAt: string | undefined): string | undefined {
  const modified = asDateString(modifiedAt);
  const modifiedMs = sessionDateMs(modified);
  // With no trusted timestamp, untrusted content cannot gain newest-session priority.
  if (!Number.isFinite(modifiedMs)) return undefined;
  if (asserted === undefined) return modified;
  const assertedMs = sessionDateMs(asserted);
  // A claim that is not an instant sorts as undated (sessionDateMs is -Infinity), so it is shown as undated, never verbatim.
  if (!Number.isFinite(assertedMs)) return undefined;
  return assertedMs > modifiedMs + WRITE_CLOCK_TOLERANCE_MS ? modified : asserted;
}

/**
 * Bound a content-derived date that is stored (structured-row valid_from) by the source file's write time, with the same
 * tolerance as `clampSessionDate`. Day-precision dates stay day-precision, and a clamped one floors to the write day, so
 * mixed formats still compare consistently. With no trusted write time, or a date that cannot be read as an instant, no
 * content date is kept (unknown stays unknown).
 */
export function boundContentDate(asserted: string | null, modifiedAt: string | null | undefined): string | null {
  if (asserted === null) return null;
  const modified = asDateString(modifiedAt ?? undefined);
  if (!Number.isFinite(sessionDateMs(modified))) return null;
  const trimmed = asserted.trim();
  // A zone-less date-time reads as UTC, the way every other date in the index does; sessionDateMs refuses it otherwise.
  const comparable = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(trimmed) ? `${trimmed}Z` : trimmed;
  if (!Number.isFinite(sessionDateMs(comparable))) return null;
  if (clampSessionDate(comparable, modified) === comparable) return trimmed;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? modified!.slice(0, 10) : modified!;
}

/** Bound an excerpt clock using its indexed file timestamp, rather than its (possibly historical) front matter. */
export function createNoteTimeBound(db: Database.Database): (notePath: string, asserted: string) => string | undefined {
  const row = onceStatement(db, 'SELECT modified_at FROM notes WHERE path = ?');
  return (notePath, asserted) => {
    const note = row().get(notePath) as { modified_at: string } | undefined;
    return clampSessionDate(asserted, note?.modified_at);
  };
}

/**
 * A note's date as retrieval dates the excerpts of it (front-matter session_date, else date, capped at the file's
 * modification time; absent front matter falls back to that time). For a caller that works on whole notes, such as
 * evidence hydration, and so needs the date of the note rather than of one excerpt: for a ledger event those differ.
 * One prepared statement per dater.
 */
export function createNoteDater(db: Database.Database): (notePath: string) => string | undefined {
  const row = onceStatement(db, 'SELECT modified_at, frontmatter_json FROM notes WHERE path = ?');
  return notePath => {
    const note = row().get(notePath) as { modified_at: string; frontmatter_json: string } | undefined;
    return resolveSessionDate(note?.frontmatter_json, note?.modified_at);
  };
}

/**
 * Lay hits out by the key they are said to be in order of, so the claim is true of the list and not only of
 * the code that usually produces it. Stable, and the input is not touched.
 * `session_date`: newest first; hits on one date, and hits with no date (which come last), by score.
 * `score`: highest first.
 */
export function orderHits<T extends { score: number; session_date?: string }>(hits: T[], by: HitOrder): T[] {
  if (by === 'score') return [...hits].sort((a, b) => b.score - a.score);
  // A date is read once for each hit, not once for each comparison the sort makes (a few hundred for a window).
  return hits.map(hit => ({ hit, ms: sessionDateMs(hit.session_date) })).sort((a, b) => {
    const delta = b.ms - a.ms;
    return delta !== 0 && !Number.isNaN(delta) ? delta : b.hit.score - a.hit.score; // NaN: both undated
  }).map(entry => entry.hit);
}

interface ProviderLike { embed(texts: string[]): Promise<number[][]>; dimensions?: number; identity?: { kind: string; model: string } }

/**
 * The visible text of each hit text the current read has met. A read asks it of the same text several times: whether the
 * hit is a stub, the key that drops a repeat, the boost for a hit with something to say, and again for a hit the session
 * expansion brings back. The text is the whole input, so the answer is kept until the read ends (`retrieveContext`
 * forgets it as it ends and again as the next one starts, which also covers a read that failed) and no longer: nothing
 * outlives the read it was worked out for. A text over the size limit, or a read that meets more texts than the count
 * limit, is simply worked out again.
 */
const CONTENTFUL_HELD_MAX = 256;
const CONTENTFUL_HELD_MAX_CHARS = 8 * 1024;
const contentfulHeld = new Map<string, string>();

/** Visible text after markdown/speaker-label strip — used to bury transcript stubs. */
export function contentfulText(text: string): string {
  const raw = text ?? '';
  const held = contentfulHeld.get(raw);
  if (held !== undefined) return held;
  const visible = stripToContentful(raw);
  if (raw.length <= CONTENTFUL_HELD_MAX_CHARS) {
    if (contentfulHeld.size >= CONTENTFUL_HELD_MAX) contentfulHeld.delete(contentfulHeld.keys().next().value as string);
    contentfulHeld.set(raw, visible);
  }
  return visible;
}

function stripToContentful(raw: string): string {
  // Each pass below but the heading rule can only change a text that holds the character it looks for, and most hit texts hold
  // few of them, so a pass whose character is absent is not run (a replace that finds nothing still reads the whole text).
  let t = raw.includes('\r') ? raw.replace(/\r/g, '') : raw;
  if (t.includes('*')) t = t.replace(/\*+/g, '');
  // Whole ATX heading line is structure, not answer text (chunker prefixes
  // section buffers with the heading — Kimi R-O1).
  t = t.replace(/^#{1,6}\s+.*$/gm, '');
  // Speaker-only lines: **Rowan:** / Rowan: / **Gabriel:** / 李雷： — any script and
  // either colon. Cue detection was Latin-1 only (`[A-Za-zÀ-ÿ]`), so labels in
  // non-Latin scripts were counted as content by contentfulText, which feeds both
  // contentBoost and dedupeHits.
  if (t.includes(':') || t.includes('：')) t = t.replace(/^[\s>*-]*[\p{L}\p{M}][\p{L}\p{M} .'-]{0,40}[:：]\s*$/gmu, '');
  if (t.includes('\n\n')) t = t.replace(/\n{2,}/g, '\n');
  return t.trim();
}

export function isSpeakerStub(text: string): boolean {
  const raw = (text ?? '').replace(/\r/g, '').trim();
  // Whole chunk is only a speaker cue (optional markdown/list markers) — any
  // script, either colon.
  if (/^(?:[\s>*-]*\*?\*?[\p{L}\p{M}][\p{L}\p{M} .'-]{0,40}\*?\*?[:：]\s*)+$/u.test(raw) && contentfulText(raw).length === 0) {
    return true;
  }
  return contentfulText(raw).length === 0;
}

function contentBoost(text: string): number {
  const n = contentfulText(text).length;
  if (n < 40) return 0;
  return Math.min(0.12, (n / 800) * 0.12);
}

/** Two hits of one note whose visible text opens the same way are one hit: the key dedupeHits keeps the first of. */
function hitKey(h: { notePath: string; text: string }): string {
  return `${h.notePath}\0${contentfulText(h.text).slice(0, 80)}`;
}

function dedupeHits<T extends { notePath: string; text: string }>(hits: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const h of hits) {
    const key = hitKey(h);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** The search cap when RENOR_SESSION_DIVERSITY is unset or empty; get_context uses 0. */
export const SESSION_DIVERSITY_DEFAULT_CAP = 2;

/**
 * RENOR_SESSION_DIVERSITY (search default 2, get_context default 0; explicit 0 turns it off): max chunks per note in the top-K
 * window. Capped chunks do not vanish — every hit in the candidate pool is
 * scanned, so chunks of notes that have not reached the cap still take their
 * slots in rank order, and distinct notes that outrank the surplus are kept.
 *
 * MEASURED LIMIT, stated because the previous revision of this comment claimed
 * the opposite ("so the window keeps topK entries"): the window is NOT
 * guaranteed to be full. When the candidate pool is concentrated in fewer than
 * topK/cap distinct notes there is nothing else to promote — every surplus hit
 * belongs to a note already at its cap by construction — so the window shrinks
 * below topK. That is exactly the chunk-heavy corpus this flag targets:
 * measured on a 4-notes x 5-chunks pool, topK=10, cap=1 -> 4 slots, cap=2 -> 8
 * slots, and on the 90-case screen the delivered context fell 3,791 -> 2,221
 * tokens (-41.4%). A true backfill would have to retrieve BEYOND the current
 * candidate pool, which this function cannot do and does not claim to.
 *
 * THE CAP IS AUTHORITATIVE WHENEVER IT IS ARMED, including when the candidate pool is no
 * deeper than the window. This function used to early-return on `hits.length <= topK`,
 * which skipped the cap entirely for a small or single-note vault (measured: cap=1 over ten
 * same-note chunks returned all ten, `kept=10`, while the headline above promises a maximum
 * per note). The window then shrinks rather than silently ignoring the setting, which is the
 * same trade the concentrated-pool case above already makes: the cap is not a backfill
 * guarantee, but it is not optional either. Only `cap < 1` (0, or a value that names no cap)
 * short-circuits, so the off path is untouched.
 *
 * Rationale (measured on full500-count-contract results.jsonl, 2026-09-28):
 * the top-20 window carries a mean 9.4 repeated-note slots (all different
 * chunks of the same note — dedupeHits only matches identical prefixes), and
 * cap=2 frees 6.9 slots on 453/500 cases.
 *
 * DEFAULT 2 since 2026-10-07 (the captain's call), from the held-out answer confirmation of 2026-10-06: GLM-5.3-Flash
 * reading and gemma4:31b judging through the shipped CLI, the 395 held-out LongMemEval-S questions the base answered.
 * No cap got 340 right and a cap of 2 got 350 (16 wins, 6 losses, +2.5 points, interval +0.3 to +4.8, p = 0.0525),
 * with 6.3% fewer context tokens and no category worse by more than 2 questions. A cap of 1 looked best on dev and lost
 * evidence on held-out, which is why 1 is not the default. The record: docs/evals/results/SESSION-DIVERSITY-DEFAULT-20261007.md.
 *
 * WHAT THE CAP COUNTS, because the evidence covers one kind of note. The cap is about the chunks of one conversation or
 * one document crowding out the others, so it counts only those. Three kinds of hit share a note path without being parts
 * of one thing said, and are left alone (not counted, not cut): a fact row (a negative chunkId, no chunk of a note; the
 * facts-first rows all carry the pseudo-path `_mcp_`), a ledger event (every fact-mode save is an event of the one ledger
 * file) and an entry of a daily log (one file per day, one memory per entry: dailyEntryTime.ts). Counted by path they
 * were capped at `cap` each, and a saved statement stopped coming back from search_memory once `cap` others of the
 * ledger, or of its day, outranked it. A benchmark vault holds none of the three, so what was measured is unchanged;
 * docs/evals/results/SESSION-DIVERSITY-DEFAULT-20261007.md has the tests that showed it.
 *
 * Unset (or empty) is the default. 0, or a value that names no cap (junk, negative, below 1), is off, and off is the
 * window as it was before the default existed, byte for byte. Searches default to 2 (search_memory, the CLI search and
 * the older API/MCP search servers). get_context passes noteCapWhenUnset=0, preserving its existing window and budget
 * assembly. An explicit environment value still wins on every read, as it did before this default changed.
 */
export function resolveSessionDiversityCap(env: NodeJS.ProcessEnv = process.env, unsetCap = SESSION_DIVERSITY_DEFAULT_CAP): number {
  const rawCap = (env.RENOR_SESSION_DIVERSITY ?? '').trim();
  const cap = rawCap === '' ? unsetCap : Number(rawCap);
  if (!Number.isFinite(cap) || cap < 1) return 0; // off: 0, or a value that names no cap
  return Math.floor(cap);
}

/**
 * Whether a hit counts toward its note's cap: a chunk of a conversation or a document. A fact row (a negative chunkId)
 * is no chunk of a note and a ledger event is no session's chunk (the two tests sessionExpansionHits ranks notes by),
 * and an entry of a daily log is a memory of its own.
 */
function countsTowardNoteCap(h: { notePath: string; chunkId: number; text: string; headingPath?: string }): boolean {
  return h.chunkId > 0 && ledgerEventIds(h).length === 0 && dailyNoteDayName(h.notePath) === null;
}

function applySessionDiversity<T extends { notePath: string; chunkId: number; text: string; headingPath?: string }>(hits: T[], cap: number, _topK: number): T[] {
  // `cap < 1` is the flag-OFF short-circuit and must stay: 0 restores the window exactly as it was
  // before the default existed. The former `|| hits.length <= topK` here was a bypass, not an optimization — it
  // skipped the configured cap entirely whenever the pool was no deeper than the window.
  if (cap < 1) return hits;
  const kept: T[] = [];
  const counts = new Map<string, number>();
  // Single pass over the WHOLE pool, in rank order: a hit is kept while its note
  // has fewer than `cap` slots already taken (a hit that is no chunk of a note is kept and takes none).
  // This is the entire mechanism —
  // the "backfill" loop that used to follow it was dead code (every item it
  // could reach came from a note already at cap, and counts never decrease, so
  // its `continue` was always taken and it never appended anything). It is
  // deleted rather than kept, because a loop that cannot run cannot be a
  // guarantee, and the docstring above used to rest on it.
  for (const h of hits) {
    if (!countsTowardNoteCap(h)) {
      kept.push(h);
      continue;
    }
    const n = counts.get(h.notePath) ?? 0;
    if (n < cap) {
      counts.set(h.notePath, n + 1);
      kept.push(h);
    }
  }
  return kept;
}

/**
 * RENOR_SESSION_EXPAND (default 5 notes; 0 turns it off): add the short statements of the notes retrieval already found.
 *
 * What it fixes, measured (PageIndex scout, 2026-10-03, on the frozen product-path top-20 of LongMemEval-S): the
 * window holds every gold SESSION for 98.3% of the 470 answerable questions but every evidence TURN for only 79.4%.
 * The miss is inside a session it found: the note comes back through several of its chunks, but not through the one
 * short sentence ("by the way, I ...") that answers the question, because that sentence is not what the query is
 * about. Adding the short turns of the five best sessions to the top-20 delivered every evidence turn for 93.6%, with
 * no model call. Measured through the shipped CLI with this code (results/SESSION-EXPAND-DELIVERY-20261003.md): off
 * 373/470 = 79.4%; five notes 440/470 = 93.6% unbounded and 439/470 = 93.4% under the default 2,000-token budget, at
 * 3,430 mean / 5,162 p95 tokens of client context against 1,978 / 4,033 off.
 *
 * What it does: rank the notes in the window by their best hit, take the best `RENOR_SESSION_EXPAND` of them, and add
 * their statements that the window does not already hold, best note first and each note in document order, while
 * they fit in `RENOR_SESSION_EXPAND_TOKENS` (default SESSION_EXPAND_DEFAULT_TOKENS). The expansion is the longest run
 * of that list that fits: it stops at the first statement that does not. Two bounded queries over `chunks`, no embedding and no
 * model call.
 *
 *  - A statement is a whole section (one chunk under a unique heading path), skipped whole when over its limit,
 *    never cut. Conversation-shaped notes use `RENOR_SESSION_EXPAND_STATEMENT_TOKENS` (default 120); every other
 *    note keeps the former 200-token limit (`RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS`). The shape comes
 *    only from the note's own headings (conversationShape.ts), never benchmark labels or front matter.
 *    The document screen found that applying 100 to all notes lost 186 delivered answer statements. Keeping
 *    documents at 200 preserved every document reply and 96.2% of the conversation token saving (11.7% overall).
 *    See docs/evals/results/SESSION-EXPAND-STATEMENT-LIMIT-20261007.md for the measurement and its limits.
 *  - Role-agnostic within a conversation: both user and assistant statements qualify, regardless of speaker.
 *  - A union, never a replacement: the window is returned as it was, and the expansion only adds. Replacing the
 *    window with the expansion lost the questions whose evidence is what the assistant said (56/56 -> 5/56).
 *  - An added hit was not matched by the query, and says so: `reason` 'session-expand', `score` 0 and no `similarity`
 *    (get_context's relevance signal stays the window's). get_context surfaces that as a first-class field on the
 *    item it lists (`matched: false`, mvp/agentMemory.ts normalizeMemory); the search lane is unchanged. It carries its
 *    note's date, so the layout (`orderHits`) places it with its session, after the chunks that matched; by score it
 *    comes after the whole window.
 *  - It never adds a note: every added hit belongs to a note the window holds, so a read scoped by note path keeps or
 *    drops it with that note. And it never adds a ledger event: the ledger is no session, its events are judged for
 *    liveness and scope one by one, and an event added here would skip both (a superseded event would come back as
 *    live). An event in the window does not rank the ledger either.
 *
 * RANKED (default, for an embedding model with a calibrated bar; RENOR_SESSION_EXPAND_RANK=0 restores the above): the
 * statements of EVERY note in the window compete by their cosine to the query (one `VectorIndex.search` among their
 * chunk ids: no embedding, no model call), and the best are added while they fit in `SESSION_EXPAND_RANKED_TOKENS`, each
 * note's laid out in document order. The statement limits are the former expansion's (120 for a conversation, 200 for a
 * document), and only the cosine ranks: nothing the note's author writes (a heading, a speaker label) adds to it. Why:
 * the expansion above spends its budget on every short statement of five notes whatever the query, and the gold
 * evidence of a multi-session question sits in a session ranked below five. Measured on the held-out 400 in
 * docs/evals/results/RANKED-EXPANSION-20261011.md. Armed only for a calibrated model because it relies on the
 * cosine's order being meaningful: the lexical eval stub and an unmeasured model keep the expansion above, byte for byte.
 * An OpenAI-compatible endpoint that returns a calibrated model's vectors is armed by the operator's declaration
 * (RENOR_EMBEDDING_SERVED_BY, see calibratedModelKey); docs/evals/results/EXPANSION-PATH-ALIGNMENT-20261018.md.
 *
 * Unset is five notes. 0, a value that names no note, a budget that allows nothing or both statement limits admitting
 * nothing is off, and off costs nothing: no statement is prepared and the result is what it was before the expansion
 * existed, byte for byte. The budget bounds what is added; nothing in the window is cut to make room. A caller that
 * cuts the result by position cuts what the layout puts last: by score, the added hits; newest first, the oldest
 * session's hits, matched or added. Measured with the benchmark client's 6,000-token cap: five notes lost no question
 * at any budget, seven notes unbounded lost 3 whose evidence the window had delivered. And a caller with a small
 * budget of its own spends it on added hits too, so it must not let them take a match's room: get_context (800 tokens
 * by default) gives them only what its facts and its matches leave (mvp/agentMemory.ts applyBudget).
 */
/**
 * The longest statement of a conversation-shaped note the expansion adds.
 *
 * 120, not 100: the evidence turns of the questions that still miss at 100 sit just over it. Measured on LongMemEval-S
 * 2026-10-10 (cache-only retrieval ablation, practice split and held-out 400): the practice split's remaining
 * multi-session misses hold statements of 101-117 tokens, and every one of them is under 120. The held-out curve at the
 * shipped defaults, 376 answerable questions: a cap of 100 delivers every gold evidence turn on 341 questions in 2,822
 * mean client tokens, 120 on 349 in 2,921 (+8 questions, +3.5%), 150 on 351 in 3,047 (+10, +8.0%); the 120-to-150 step is
 * 2 questions inside the noise (exact McNemar p = 0.500). The 2026-10-07 record
 * (docs/evals/results/SESSION-EXPAND-STATEMENT-LIMIT-20261007.md) adds that the answer-level effect of the limit is flat
 * from 120 to 200 while the delivered context keeps growing, so 120 is the knee of the curve. Documents keep 200: their
 * statements were measured separately and a flat 100 there lost 186 delivered answer statements.
 */
export const SESSION_EXPAND_MAX_CHUNK_TOKENS = 120;
/** The longest statement of a note that is not shaped like a conversation (a document): the limit before the cap. */
export const SESSION_EXPAND_DOCUMENT_MAX_CHUNK_TOKENS = 200;
export const SESSION_EXPAND_DEFAULT_TOKENS = 2000;
/** The ranked expansion's budget. Its statement limits are the former expansion's (120 for a conversation, 200 for a document). */
export const SESSION_EXPAND_RANKED_TOKENS = 1300;
/** The `reason` of a hit the expansion added: no word of the query matched it, and it has no score of its own. */
export const SESSION_EXPAND_REASON = 'session-expand';
/** How many of the window's best notes are expanded when RENOR_SESSION_EXPAND is unset. */
export const SESSION_EXPAND_DEFAULT_NOTES = 5;

export interface SessionExpansion {
  /** How many of the window's best notes are expanded. */
  notes: number;
  /** The most `chunks.token_count` tokens the expansion may add. */
  tokenBudget: number;
  /** The most `chunks.token_count` tokens one statement of a conversation-shaped note may have: a longer section is skipped, never cut. */
  statementTokens: number;
  /** The same for every other note (a document): the cap is not measured on them (see conversationShape.ts). */
  documentStatementTokens: number;
}

export function resolveSessionExpand(env: NodeJS.ProcessEnv = process.env): SessionExpansion | null {
  const rawNotes = (env.RENOR_SESSION_EXPAND ?? '').trim();
  const notes = rawNotes === '' ? SESSION_EXPAND_DEFAULT_NOTES : Number(rawNotes);
  if (!Number.isFinite(notes) || notes < 1) return null; // off: 0, or a value that names no note
  const rawBudget = (env.RENOR_SESSION_EXPAND_TOKENS ?? '').trim();
  const budget = rawBudget === '' ? SESSION_EXPAND_DEFAULT_TOKENS : Number(rawBudget);
  if (!Number.isFinite(budget) || budget < 1) return null; // a budget that allows nothing adds nothing
  // Each class has its own limit; one that admits no statement adds nothing for that class, both of them add nothing at all.
  const limit = (raw: string | undefined, fallback: number): number => {
    const text = (raw ?? '').trim();
    const value = text === '' ? fallback : Number(text);
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0;
  };
  const statementTokens = limit(env.RENOR_SESSION_EXPAND_STATEMENT_TOKENS, SESSION_EXPAND_MAX_CHUNK_TOKENS);
  const documentStatementTokens = limit(env.RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS, SESSION_EXPAND_DOCUMENT_MAX_CHUNK_TOKENS);
  if (statementTokens === 0 && documentStatementTokens === 0) return null;
  return { notes: Math.floor(notes), tokenBudget: Math.floor(budget), statementTokens, documentStatementTokens };
}

/**
 * How the expansion chooses its statements when it can rank them: by their cosine to the query (RENOR_SESSION_EXPAND_RANK,
 * on unless set to 0). Everything unset here is the ranked default; an explicit RENOR_SESSION_EXPAND, RENOR_SESSION_EXPAND_TOKENS,
 * RENOR_SESSION_EXPAND_STATEMENT_TOKENS or RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS is honoured as before.
 */
export interface RankedExpansion {
  /** How many of the window's best notes compete (all of them unless RENOR_SESSION_EXPAND names a count). */
  notes: number;
  tokenBudget: number;
  statementTokens: number;
  documentStatementTokens: number;
}

/**
 * Deep search, Renor's one default read: the configuration behind the published LongMemEval-S 98.4% (LEDGER section BM,
 * docs/evals/results/top-score-20261026/): a search of 50 matches with the ranked expansion grown to 4,000 tokens
 * (orchestrator.ts rankedBudgetFor). search_memory and `renor search` have read 50 matches since 2026-10-27; get_context
 * reads them too since 2026-11-09, with a reply budget large enough to hold that page (its p95 was 6,379 tokens).
 *
 * RENOR_DEEP_SEARCH (default on): `0`, `false`, `no` or `off` is lean mode, the reads that were the default before:
 * get_context searches 8 matches into an 800-token reply (ceiling 4,000), search_memory and `renor search` 20 matches with
 * the 1,300-token expansion. RENOR_SEARCH_TOP_K and RENOR_TOPK_SCALES_BUDGET, when set, still decide for search.
 * A caller's own max_tokens, top_k or --top-k is never overridden. The automatic recall hook names its own budget
 * (at most 4,000 tokens), so it reads the lean page either way.
 */
export function deepSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RENOR_DEEP_SEARCH ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/** Semantic matches get_context asks for on a deep page, and on a lean one (the default before 2026-11-09). */
export const DEEP_CONTEXT_TOP_K = 50;
export const LEAN_CONTEXT_TOP_K = 8;

/** get_context's reply budget when the caller names none: deep holds the benchmarked page (max 7,490 tokens), lean is the former 800. */
export const DEEP_CONTEXT_MAX_TOKENS = 8000;
export const LEAN_CONTEXT_MAX_TOKENS = 800;

/** A reply budget above this is a deep page; at or below it get_context searches LEAN_CONTEXT_TOP_K, as it always did. */
export const LEAN_REPLY_CEILING = 4000;

/** The reply budget get_context uses when the caller names none. */
export function defaultContextMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return deepSearchEnabled(env) ? DEEP_CONTEXT_MAX_TOKENS : LEAN_CONTEXT_MAX_TOKENS;
}

/**
 * The semantic matches get_context searches for a reply of `maxTokens`: 50 when deep search is on and the reply has room
 * for the deep page (more than 4,000 tokens), else 8. So a caller that asks for a small reply, the recall hook included,
 * gets exactly the page it got before.
 */
export function contextTopK(maxTokens: number, env: NodeJS.ProcessEnv = process.env): number {
  return deepSearchEnabled(env) && maxTokens > LEAN_REPLY_CEILING ? DEEP_CONTEXT_TOP_K : LEAN_CONTEXT_TOP_K;
}

/** The top-K the ranked expansion's base budget (SESSION_EXPAND_RANKED_TOKENS) was sized for. */
export const PAGE_BASE_TOP_K = 20;

/** What each match asked for beyond PAGE_BASE_TOP_K adds to the ranked expansion's budget unless RENOR_TOPK_SCALES_BUDGET is off. */
export const RANKED_TOKENS_PER_EXTRA_MATCH = 90;

/**
 * RENOR_TOPK_SCALES_BUDGET (default ON since the flip of 2026-10-27, unset follows RENOR_DEEP_SEARCH; `0`, `false`, `no` or `off` restore the former budget): a read that asks for more
 * than PAGE_BASE_TOP_K matches gets a ranked expansion budget that grows with the ask, SESSION_EXPAND_RANKED_TOKENS plus RANKED_TOKENS_PER_EXTRA_MATCH
 * for each match above 20 (4,000 tokens at 50), so the statements that go with a window of 50 matches are not squeezed into the 1,300 tokens that were
 * sized for 20. RENOR_SESSION_EXPAND_TOKENS still decides when it is set. At a top-K of 20 or less nothing changes, on or off; off, nothing changes at any top-K.
 *
 * Measured at one point, 50 (LEDGER section BM, results/top-score-20261026/): the page of `--top-k 50` with the 1,300-token budget completes the
 * evidence of no more questions than the page of 20; the same page with a 4,000-token budget completes more of them. Other asks are interpolated.
 */
export function topKScalesBudget(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RENOR_TOPK_SCALES_BUDGET ?? '').trim().toLowerCase();
  if (v === '') return deepSearchEnabled(env); // unset: deep search decides (on unless RENOR_DEEP_SEARCH=0, orchestrator.ts)
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/** The matches a `search` asks for when its caller names no number: 50 since the flip of 2026-10-27 (it was 20); the hosted tool's own ceiling. */
export const DEFAULT_SEARCH_TOP_K = 50;

/**
 * The matches `renor search` and the hosted `search_memory` return when the caller names none. RENOR_SEARCH_TOP_K (a whole number from 1 to 50) sets it
 * for a deployment: `20` with RENOR_TOPK_SCALES_BUDGET=0 is the page that was the default before the flip, byte for byte. Unset or anything else is 50,
 * or 20 in lean mode (RENOR_DEEP_SEARCH=0, orchestrator.ts).
 * A caller that passes its own top-k (`--top-k`, `top_k`) is never touched.
 */
export function defaultSearchTopK(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RENOR_SEARCH_TOP_K ?? '').trim();
  const n = Number(raw);
  if (raw !== '' && Number.isInteger(n) && n >= 1 && n <= DEFAULT_SEARCH_TOP_K) return n;
  return deepSearchEnabled(env) ? DEFAULT_SEARCH_TOP_K : PAGE_BASE_TOP_K; // RENOR_DEEP_SEARCH=0 (lean mode): the former 20
}

/** The ranked expansion's token budget for a read of `topK` matches: SESSION_EXPAND_RANKED_TOKENS, grown with the ask when RENOR_TOPK_SCALES_BUDGET is armed. */
export function rankedBudgetFor(topK: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  return topKScalesBudget(env) && topK !== undefined && Number.isFinite(topK) && topK > PAGE_BASE_TOP_K
    ? SESSION_EXPAND_RANKED_TOKENS + Math.round(RANKED_TOKENS_PER_EXTRA_MATCH * (topK - PAGE_BASE_TOP_K))
    : SESSION_EXPAND_RANKED_TOKENS;
}

export function resolveRankedExpansion(env: NodeJS.ProcessEnv = process.env, topK?: number): RankedExpansion | null {
  if ((env.RENOR_SESSION_EXPAND_RANK ?? '').trim() === '0') return null;
  const legacy = resolveSessionExpand(env);
  if (!legacy) return null;
  const rawNotes = (env.RENOR_SESSION_EXPAND ?? '').trim();
  const rawBudget = (env.RENOR_SESSION_EXPAND_TOKENS ?? '').trim();
  return {
    notes: rawNotes === '' ? Number.POSITIVE_INFINITY : legacy.notes,
    tokenBudget: rawBudget === '' ? rankedBudgetFor(topK, env) : legacy.tokenBudget,
    statementTokens: rankedStatementTokens(env) ?? legacy.statementTokens,
    documentStatementTokens: legacy.documentStatementTokens,
  };
}

/**
 * The longest conversation statement the RANKED expansion adds when nothing says otherwise: 400 tokens. The former expansion
 * (a command line that does not declare a calibrated model) keeps RENOR_SESSION_EXPAND_STATEMENT_TOKENS (120).
 */
export const SESSION_EXPAND_RANKED_STATEMENT_TOKENS = 400;

/**
 * RENOR_SESSION_EXPAND_RANKED_STATEMENT_TOKENS (default 400 since the flip of 2026-10-25): the longest conversation statement,
 * in tokens, that the RANKED expansion alone may add. Unset or empty: 400, unless RENOR_SESSION_EXPAND_STATEMENT_TOKENS is set,
 * which an operator's explicit value keeps winning as it always did. A number of 1 or more: that limit, over the general one.
 * The off switch: `0`, a negative number or anything that is not a number returns null, and the ranked expansion then takes
 * RENOR_SESSION_EXPAND_STATEMENT_TOKENS (120 unset), as it did before the flip. The former expansion and the documents are
 * never touched by it.
 *
 * Why 400: the session expansion skips a conversation statement over its limit, whole, and the long user turn that answers a
 * question is often just over 120 tokens (501 to 700 characters: missing from the page 5 times in 21, against 6 in 777 for
 * shorter ones, on the Haiku default run of 2026-10-23). The chunker leaves no section over 400 tokens as one chunk, so 400 is
 * the largest value that changes anything. On the official LongMemEval-S instrument with a Haiku 5.5 reader the ranked
 * expansion with 400 scored 433 of 500 and with 120 (the control) 431, against 418, 417 and 423 for the command-line default;
 * the four pages only the limit completes are right 4 of 4 with it and 0 of 4 without, and the page is 5.5% smaller:
 * engine/docs/evals/results/ranked-statement-limit-20261024/ and LEDGER sections BE and BF.
 */
export function rankedStatementTokens(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.RENOR_SESSION_EXPAND_RANKED_STATEMENT_TOKENS ?? '').trim();
  if (raw === '') return (env.RENOR_SESSION_EXPAND_STATEMENT_TOKENS ?? '').trim() === '' ? SESSION_EXPAND_RANKED_STATEMENT_TOKENS : null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

const OFF_VALUES = new Set(['off', 'none', '0', 'false']);

/**
 * The calibrated key (CALIBRATED_BARS) of the embedding model behind a provider, or null when there is none.
 *
 * A key names the provider that made the vectors. An OpenAI-compatible endpoint that returns Vertex's gemini-embedding-001
 * vectors (the benchmark's embedding cache proxy replays them) declares itself `openai:gemini-embedding-001:768`, which is
 * not calibrated on its own key. Since 12 Nov 2026 (issue 1811) that case is inferred by default: an `openai` endpoint whose model
 * name and size match a calibrated key counts as it, so the result no longer hangs on a variable one script set (issue 1559).
 * RENOR_EMBEDDING_SERVED_BY=off (or none, 0, false) restores the former null. Otherwise it is the operator's declaration of whose vectors the endpoint returns: `vertex`
 * there counts the provider as the calibrated model, but only when the key that makes (the declared kind with the provider's
 * own model and dimensions) is in CALIBRATED_BARS. Any other value, model or size changes nothing, and the declaration is the
 * operator's word: nothing here checks the vectors. Read here and nowhere else; a hosted workspace is unaffected.
 */
export function calibratedModelKey(
  identity: { kind: string; model: string } | undefined, dimensions: number | undefined, env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!identity) return null;
  const own = embeddingModelKey(identity.kind, identity.model, dimensions);
  if (own in CALIBRATED_BARS) return own;
  const servedBy = (env.RENOR_EMBEDDING_SERVED_BY ?? '').trim().toLowerCase();
  if (OFF_VALUES.has(servedBy)) return null;
  if (servedBy === '') {
    // Default (on): an OpenAI-compatible endpoint that serves a calibrated model's own name and size (gemini-embedding-001
    // at 768) returns that model's vectors, so it is counted as the calibrated model, as a hosted workspace is. Only the
    // `openai` kind is inferred; the lexical stub, an unmeasured model or another size still match nothing.
    // The off switch is RENOR_EMBEDDING_SERVED_BY=off (or none, 0, false), which restores the former null for this case.
    if (identity.kind !== 'openai') return null;
    const inferred = Object.keys(CALIBRATED_BARS).find(key => key.split(':').slice(1).join(':') === `${identity.model}:${dimensions ?? ''}`);
    return inferred ?? null;
  }
  const declared = embeddingModelKey(servedBy, identity.model, dimensions);
  return declared in CALIBRATED_BARS ? declared : null;
}

function sessionExpansionHits(
  db: Database.Database, window: RetrievalHit[], expansion: SessionExpansion,
  ranking?: { vectorIndex: VectorIndex; queryVector: number[]; ranked: RankedExpansion },
): RetrievalHit[] {
  // A note is ranked by its best chunk in the window. A fact row (chunkId < 0) is no chunk of a note, and a ledger
  // event is no session's chunk: neither ranks a note.
  const best = new Map<string, RetrievalHit>();
  for (const hit of window) {
    if (hit.chunkId > 0 && ledgerEventIds(hit).length === 0 && hit.score > (best.get(hit.notePath)?.score ?? Number.NEGATIVE_INFINITY)) {
      best.set(hit.notePath, hit);
    }
  }
  const ranked = ranking?.ranked;
  if (ranked) expansion = { ...expansion, ...ranked };
  const notes = [...best.values()].sort((a, b) => b.score - a.score).slice(0, expansion.notes);
  if (notes.length === 0) return [];
  const rank = new Map(notes.map((hit, i) => [hit.notePath, i]));
  // A statement is a whole section: a chunk that no other chunk of its note shares a heading path with. The chunker
  // cuts a section of over 400 tokens into paragraphs under one heading path, and such a piece is a fragment of a long
  // answer, not something said in a few words.
  const paths = notes.map(hit => hit.notePath);
  // What a note is shaped like decides its limit: every heading path of its chunks, not only the statements'.
  const headings = new Map<string, string[]>();
  for (const row of listStatement(
    db, paths.length, marks => `SELECT note_path AS notePath, heading_path AS headingPath FROM chunks WHERE note_path IN (${marks})`,
  ).all(...paddedList(paths)) as Array<{ notePath: string; headingPath: string }>) {
    const list = headings.get(row.notePath) ?? [];
    list.push(row.headingPath);
    headings.set(row.notePath, list);
  }
  const limitOf = new Map(paths.map(notePath => [
    notePath,
    isConversationShaped(headings.get(notePath) ?? []) ? expansion.statementTokens : expansion.documentStatementTokens,
  ]));
  const rows = (db.prepare(
    `SELECT chunkId, notePath, headingPath, text, tokens FROM (
       SELECT id AS chunkId, note_path AS notePath, heading_path AS headingPath, text, token_count AS tokens,
         start_line AS startLine, COUNT(*) OVER (PARTITION BY note_path, heading_path) AS parts
       FROM chunks WHERE note_path IN (${paths.map(() => '?').join(',')})
     ) WHERE parts = 1 AND tokens <= ?
     ORDER BY startLine, chunkId`,
  ).all(...paths, Math.max(expansion.statementTokens, expansion.documentStatementTokens)) as Array<{
    chunkId: number; notePath: string; headingPath: string; text: string; tokens: number;
  }>).filter(row => row.tokens <= limitOf.get(row.notePath)!)
    .sort((a, b) => rank.get(a.notePath)! - rank.get(b.notePath)!); // stable: document order inside a note
  const inWindow = new Set(window.map(hit => hit.chunkId));
  const seen = new Set(window.map(hitKey));
  const added: RetrievalHit[] = [];
  let spent = 0;
  let candidates = rows;
  if (ranking) {
    const eligible = rows.filter(row => !inWindow.has(row.chunkId) && !isSpeakerStub(row.text) && ledgerEventIds(row).length === 0 && !seen.has(hitKey(row)));
    const cosine = new Map(ranking.vectorIndex.search(ranking.queryVector, Math.max(1, eligible.length), eligible.map(r => r.chunkId)).map(h => [h.chunkId, h.score]));
    const picked: typeof rows = [];
    let room = expansion.tokenBudget;
    // Cosine and nothing else: a heading, a speaker label or a front-matter field is text the note's author wrote, and
    // a ranking signal taken from it would be one more way for a planted note to steer what the expansion delivers.
    const cosineOf = (row: typeof rows[number]): number => cosine.get(row.chunkId) ?? -1;
    for (const row of [...eligible].sort((a, b) => cosineOf(b) - cosineOf(a) || a.chunkId - b.chunkId)) {
      if (row.tokens > room) break;
      room -= row.tokens;
      picked.push(row);
    }
    const chosen = new Set(picked.map(r => r.chunkId));
    candidates = rows.filter(r => chosen.has(r.chunkId)); // note rank, then document order, as the unranked expansion lays them out
  }
  for (const row of candidates) {
    // A ledger event is never added: liveness (closed events) and scope (per event) are judged on the window only.
    if (inWindow.has(row.chunkId) || isSpeakerStub(row.text) || ledgerEventIds(row).length > 0) continue;
    const key = hitKey(row);
    if (seen.has(key)) continue;
    if (spent + row.tokens > expansion.tokenBudget) break;
    spent += row.tokens;
    seen.add(key);
    const sessionDate = best.get(row.notePath)!.session_date;
    added.push({
      notePath: row.notePath,
      chunkId: row.chunkId,
      headingPath: row.headingPath,
      text: row.text,
      score: 0,
      reason: SESSION_EXPAND_REASON,
      ...(sessionDate ? { session_date: sessionDate } : {}),
    });
  }
  return added;
}

/** Prepares `sql` on first use, and once per connection: for lookups that run once per hit, and on every read. */
function onceStatement(db: Database.Database, sql: string): () => Database.Statement {
  let statement: Database.Statement | undefined;
  return () => (statement ??= prepareOnce(db, sql));
}

/** A `facts` row as the temporal ranking reads it. */
type FactRow = { predicate: string | null; object_text: string | null; valid_to: string | null };

function getEntityIdsForNotes(db: Database.Database, notePaths: string[]): Array<{ id: number; notePath: string }> {
  if (notePaths.length === 0) return [];
  return (listStatement(
    db, notePaths.length, marks => `SELECT id, source_note as notePath FROM entities WHERE source_note IN (${marks})`
  ).all(...paddedList(notePaths)) as Array<{ id: number; notePath: string }>).map(r => ({ id: r.id, notePath: r.notePath }));
}

function getRelatedEntityIds(db: Database.Database, entityIds: Array<{ id: number }>): number[] {
  if (entityIds.length === 0) return [];
  const ids = entityIds.map(e => e.id);
  const rows = listStatement(
    db, ids.length, marks => `SELECT DISTINCT target_entity_id as id FROM relations WHERE source_entity_id IN (${marks})
     UNION
     SELECT DISTINCT source_entity_id as id FROM relations WHERE target_entity_id IN (${marks})`
  ).all(...paddedList(ids), ...paddedList(ids)) as Array<{ id: number }>;
  const existing = new Set(ids);
  return rows.map(r => r.id).filter(id => !existing.has(id));
}

function getNotesForEntities(db: Database.Database, entityIds: number[]): string[] {
  if (entityIds.length === 0) return [];
  return (listStatement(
    db, entityIds.length, marks => `SELECT DISTINCT source_note FROM entities WHERE id IN (${marks})`
  ).all(...paddedList(entityIds)) as Array<{ source_note: string }>).map(r => r.source_note);
}

function getBestChunksForNotes(db: Database.Database, notePaths: string[], limit: number, keep?: ChunkFilter): Array<{
  notePath: string; chunkId: number; headingPath: string; text: string; startLine: number; endLine: number
}> {
  if (notePaths.length === 0) return [];
  // The longest chunk of each note, the first of equally long ones; the notes in path order. Neither is left to row
  // order, which follows the order indexing wrote the notes in.
  const chunks = listStatement(
    db, notePaths.length, marks => `SELECT chunkId, notePath, headingPath, text, startLine, endLine FROM (
       SELECT id as chunkId, note_path as notePath, heading_path as headingPath, text, start_line as startLine, end_line as endLine,
         ROW_NUMBER() OVER (PARTITION BY note_path ORDER BY token_count DESC, id) as rn
       FROM chunks WHERE note_path IN (${marks})
     ) WHERE rn = 1
     ORDER BY notePath
     LIMIT ?`
  ).all(...paddedList(notePaths), keep ? -1 : limit) as Array<{
    notePath: string; chunkId: number; headingPath: string; text: string; startLine: number; endLine: number
  }>;
  // Given `keep`, the chunks it shows are judged before the limit (LIMIT -1 is none).
  return keep ? chunks.filter(keep).slice(0, limit) : chunks;
}

interface RetrieveOptions {
  includeHistory?: boolean; probe?: RetrievalProbe; isLedgerNote?: IsLedgerNote;
  /**
   * A read that shows only some chunks (a scoped read): every candidate is judged by it before any cut, so the window
   * holds the best of what the read shows, and never fewer because chunks it does not show ranked above them.
   */
  scope?: ChunkScope;
  /** Default cap for this read when the environment is unset/empty. get_context passes 0; searches use 2. */
  noteCapWhenUnset?: number;
}

/**
 * RENOR_RETRIEVE_AGGREGATE_K (default off, a research lever): a positive whole number widens every read to at least that many
 * matches; the session-diversity cap still merges the window per session. Unset, empty, 0 or not a number: the ask is unchanged.
 */
export function aggregateTopK(topK: number, env: NodeJS.ProcessEnv = process.env): number {
  const k = Number((env.RENOR_RETRIEVE_AGGREGATE_K ?? '').trim());
  return Number.isInteger(k) && k > 0 && k > topK ? k : topK;
}

export async function retrieveContext(
  db: Database.Database, vectorIndex: VectorIndex | undefined, provider: ProviderLike | undefined,
  query: string, topK = 20, priorityPaths: string[] = [],
  clock: { nowMs?: number } = {},
  opts: RetrieveOptions = {},
): Promise<RetrievalResult> {
  topK = aggregateTopK(topK);
  contentfulHeld.clear(); // what another read worked out is not this read's
  const factHits = factsFirstHits(db, query, Math.min(3, topK), opts.scope?.shows);
  const queryProbe: RetrievalProbe = opts.probe ?? {}; // the query vector, for the expansion's ranking
  // `explain`: a chunk the scope refuses is seen and counted here, before any cut. Absent, the scope is used as it is.
  const explain = queryProbe.explain;
  if (explain && opts.scope) {
    const inner = opts.scope;
    opts = { ...opts, scope: { ...inner, shows: hit => {
      const shown = inner.shows(hit);
      if (!shown) noteDrop(explain, hit.chunkId, 'scope');
      return shown;
    } } };
  }
  // RENOR_NEAR_DUP_CAP (default off): the pool is read deeper, so the places near-copies leave are taken (plainWording.ts).
  const nearDupCap = resolveNearDupCap();
  const candidateLimit = nearDupCap > 0 ? Math.min(NEAR_DUP_POOL.max, topK * NEAR_DUP_POOL.perTopK) : Math.min(40, topK * 4);
  // RENOR_QUERY_REWRITE (default off): what is embedded is the query without its conversational wrapper.
  const embeddedQuery = queryRewriteEnabled() ? rewriteConversationalQuery(query) : query;
  const semanticHits = vectorIndex && provider
    ? await semanticSearch(db, vectorIndex, provider, embeddedQuery, candidateLimit, queryProbe, opts.scope)
    : (() => {
        // No embedding provider (the default self-hosted install): the keyword index stands in for the semantic lane.
        // The question's content words joined by OR (H11b, the default; RENOR_KEYWORD_OR_ALL=0 or RENOR_KEYWORD_DEFAULTS=0
        // restores the exact-phrase match), so "what test runner does acme-api use" finds the note that says "acme-api:
        // tests run on vitest" (#1456). BM25 ranks the notes that carry the rarest and the most of the words first. A
        // question of stop words only keeps the exact phrase.
        const match = (keywordOrAll() ? keywordOrMatch(query) : '') || quoteFtsQuery(query);
        if (!match) return [];
        // Its rows are judged (ledger header and events the words are not in, then the scope) before the page is cut, as
        // every keyword reader does.
        return shownPage(
          rows => keywordSearch(db, match, rows),
          rows => {
            const live = keywordLedgerHits(rows.map(r => ({ ...r, score: 1 / (1 + Math.abs(r.score)) })), opts.isLedgerNote, query);
            return opts.scope ? live.filter(hit => opts.scope!.shows(hit)) : live;
          },
          candidateLimit,
        );
      })();
  // The window is ranked without waiting for anything, so it is read in one transaction (inReadSnapshot).
  const window = inReadSnapshot(db, () => rankWindow({ db, query, topK, priorityPaths, clock, opts, factHits, semanticHits, nearDupCap }));
  return finishContext({ db, vectorIndex, provider, query, queryProbe, window, topK });
}

type PoolHit = Omit<Awaited<ReturnType<typeof semanticSearch>>[number], 'startLine' | 'endLine'>;

/** The window of hits of a read: scored, with the graph of its notes, their facts and dates, live and capped per note. Waits for nothing. */
function rankWindow(read: {
  db: Database.Database; query: string; topK: number; priorityPaths: string[]; clock: { nowMs?: number }; opts: RetrieveOptions;
  factHits: ReturnType<typeof factsFirstHits>; semanticHits: PoolHit[];
  /** RENOR_NEAR_DUP_CAP: at most this many near-copies in the window; 0 is off. */
  nearDupCap: number;
}) {
  const { db, query, topK, priorityPaths, clock, opts, factHits, semanticHits, nearDupCap } = read;
  // Set only while the learning log collects the ranker's terms (rankingTrace.ts); otherwise every use below is skipped.
  const trace = currentRankingTrace();
  // Raw cosines, kept only for a caller that asked to see them (get_context's relevance signal).
  const cosineByChunk = opts.probe ? new Map(semanticHits.map(h => [h.chunkId, h.score])) : null;
  const entityHit = lookupEntity(db, query.trim());

  // Prepared once per call, not once per hit: each of these runs for every semantic hit (dozens per call).
  const noteRowStmt = onceStatement(db, 'SELECT modified_at, frontmatter_json FROM notes WHERE path = ?');
  const ownFactsStmt = onceStatement(db, 'SELECT predicate, object_text, valid_to FROM facts WHERE subject_entity_id = ?');
  // Hits of one note ask the same question of it, and of its entity's facts: once each, not once per hit. Everything
  // below runs in one synchronous step, so nothing can be written between two asks.
  type NoteRow = { modified_at: string; frontmatter_json: string } | undefined;
  const noteRows = new Map<string, NoteRow>();
  const noteRow = (notePath: string): NoteRow => {
    if (!noteRows.has(notePath)) noteRows.set(notePath, noteRowStmt().get(notePath) as NoteRow);
    return noteRows.get(notePath);
  };
  const ownFactRows = new Map<number, FactRow[]>();

  const scored = semanticHits.map(h => {
    let score = h.score; let reason = 'semantic';
    const terms = trace ? newRankingTerms() : null;
    if (isSpeakerStub(h.text)) {
      score -= 0.5;
      if (terms) terms[rankingTermIndex('stub')] -= 0.5;
      reason = 'semantic+stub';
    } else {
      const boost = contentBoost(h.text);
      if (boost > 0) { score += boost; reason += '+content'; if (terms) terms[rankingTermIndex('content')] += boost; }
    }
    if (priorityPaths.some(p => h.notePath.includes('/' + p) || h.notePath.startsWith(p))) {
      score += 0.1; reason += '+priority'; if (terms) terms[rankingTermIndex('priority')] += 0.1;
    }
    if (entityHit?.sourceNote === h.notePath) { score += 0.2; reason += '+entity'; if (terms) terms[rankingTermIndex('entity')] += 0.2; }
    // Time-decay recency: +0.1 for today, linearly decaying to 0 over 30 days.
    const row = noteRow(h.notePath);
    const session_date = resolveSessionDate(row?.frontmatter_json, row?.modified_at);
    if (row) {
      const daysSince = ((clock.nowMs ?? Date.now()) - new Date(row.modified_at).getTime()) / 86400000;
      const recencyBoost = Math.max(0, 0.1 * (1 - daysSince / 30));
      if (recencyBoost > 0.001) { score += recencyBoost; reason += '+recency'; if (terms) terms[rankingTermIndex('recency')] += recencyBoost; }
    }
    const out = { ...h, score, reason, session_date };
    return terms ? attachRankingTerms(out, terms) : out;
  });

  // Graph expansion
  const hitNotePaths = [...new Set(semanticHits.map(h => h.notePath))];
  const hitEntityIds = getEntityIdsForNotes(db, hitNotePaths);

  const relatedEntityIds = getRelatedEntityIds(db, hitEntityIds);

  const relatedNotePaths = getNotesForEntities(db, relatedEntityIds);
  const newPaths = relatedNotePaths.filter(p => !hitNotePaths.includes(p));

  if (newPaths.length > 0) {
    const relatedChunks = getBestChunksForNotes(db, newPaths, topK, opts.scope?.shows);
    for (const chunk of relatedChunks) {
      const row = noteRow(chunk.notePath);
      scored.push({
        ...chunk,
        score: 0.3,
        reason: 'graph',
        session_date: resolveSessionDate(row?.frontmatter_json, row?.modified_at),
      });
    }
  }

  // Fact-aware boost + temporal ranking. Two complementary signals, both general:
  //
  // 1. Lifecycle facts (facts table, incl. MCP-written facts resolved by
  //    canonical_name across entity rows — not just per-note entities): chunks
  //    carrying a superseded value are demoted, chunks carrying the current
  //    value are lifted, and explicit past-intent queries invert both.
  // 2. Corpus signal (works without an LLM fact extractor — RenorBench, and
  //    real vaults with a History/ convention): notes whose frontmatter marks
  //    them historical (kind/type: history|historical, historical: true,
  //    archived: true) are demoted for present-tense queries and lifted for
  //    past-intent ones.
  // No hardcoded subject or cue table. Kill switch: RENOR_TEMPORAL_RANKING=0.
  const temporal = temporalRankingEnabled();
  const pastIntent = temporal && hasStrictPastIntent(query);
  const historicalNotes = new Set<string>();
  const factsByNote = new Map<string, FactRow[]>();
  if (temporal) {
    // Frontmatter historical flags for all hit notes (one batched query).
    if (hitNotePaths.length > 0) {
      const noteRows = listStatement(
        db, hitNotePaths.length, marks => `SELECT path, frontmatter_json FROM notes WHERE path IN (${marks})`
      ).all(...paddedList(hitNotePaths)) as Array<{ path: string; frontmatter_json: string }>;
      for (const row of noteRows) {
        if (frontmatterMarksHistorical(row.frontmatter_json)) historicalNotes.add(row.path);
      }
    }
    // Lifecycle facts: a note's entities share canonical names with MCP-written
    // entities (source_note '_mcp_'), so expand by canonical_name — otherwise
    // MCP facts would never match corpus hits.
    if (hitEntityIds.length > 0) {
      const ids = hitEntityIds.map(e => e.id);
      const nameRows = listStatement(
        db, ids.length, marks => `SELECT DISTINCT canonical_name FROM entities WHERE id IN (${marks})`
      ).all(...paddedList(ids)) as Array<{ canonical_name: string }>;
      const names = nameRows.map(r => String(r.canonical_name)).filter(Boolean);
      if (names.length > 0) {
        const entityRows = listStatement(
          db, names.length, marks => `SELECT id, canonical_name, source_note FROM entities WHERE canonical_name COLLATE NOCASE IN (${marks})`
        ).all(...paddedList(names)) as Array<{ id: number; canonical_name: string; source_note: string }>;
        const nameByEntityId = new Map(entityRows.map(r => [r.id, String(r.canonical_name).toLowerCase()]));
        const factRows = listStatement(
          db, entityRows.length, marks => `SELECT subject_entity_id, predicate, object_text, valid_to FROM facts WHERE subject_entity_id IN (${marks})`
        ).all(...paddedList(entityRows.map(r => r.id))) as Array<FactRow & { subject_entity_id: number }>;
        for (const hitEntity of hitEntityIds) {
          const ownName = nameByEntityId.get(hitEntity.id);
          if (ownName === undefined) continue;
          const merged = factsByNote.get(hitEntity.notePath) ?? [];
          for (const f of factRows) {
            if (nameByEntityId.get(f.subject_entity_id) === ownName) merged.push(f);
          }
          factsByNote.set(hitEntity.notePath, merged);
        }
      }
    }
  }
  // Distinctive query words (not pure temporal/function markers): used to anchor
  // the past-intent lift to content — an unconditional lift rockets OTHER
  // subjects' historical notes above multi-constraint gold (RenorBench hop-009).
  const TEMPORAL_STOPWORDS = new Set(['previously','before','used','earlier','former','formerly','past','history','was','were','did','does','the','and','what','where','who','when','from']);
  const contentfulQueryWords = (query.toLowerCase().match(/[\p{L}\p{M}]{3,}/gu) ?? [])
    .filter(w => !TEMPORAL_STOPWORDS.has(w));
  const hitText = (h: { text: string }) => h.text.toLowerCase();
  const factQueryTerms = contentTerms(query);
  for (const hit of scored) {
    // Legacy fact-aware boost: scoped to the hit note's OWN entity facts exactly
    // as before this change — the canonical-name expansion below exists for
    // temporal decisions only and must not perturb the legacy boost distribution.
    const ownEntityFacts = (() => {
      const own = hitEntityIds.find(e => e.notePath === hit.notePath);
      if (!own) return [];
      let rows = ownFactRows.get(own.id);
      if (!rows) ownFactRows.set(own.id, rows = ownFactsStmt().all(own.id) as FactRow[]);
      return rows;
    })();
    const facts = factsByNote.get(hit.notePath) ?? [];

    const factMatch = factBoostMatches(factQueryTerms, ownEntityFacts);
    if (factMatch) {
      hit.score += 0.15;
      if (trace) addRankingTerm(hit, 'fact', 0.15);
      hit.reason += '+fact';
    }

    if (temporal) {
      const text = hitText(hit);
      // Historical-note signal is lift-only, on strict past-intent queries:
      // a blanket present-tense demotion pushed gold historical notes out of the
      // window for queries like "which tea drinker grew up in Sacramento?" —
      // present-tense phrasing, past answer. The lifecycle-fact staleness
      // demotion below remains the general present-tense mechanism.
      const isHistoricalNote = historicalNotes.has(hit.notePath);
      if (pastIntent && isHistoricalNote) {
        // Content-anchored lift: the historical note must itself match the query's
        // distinctive words (≥2), so an unrelated person's history note — however
        // semantically adjacent — does not ride the intent signal past the gold.
        const contentOverlap = contentfulQueryWords.filter(w => text.includes(w)).length;
        if (contentOverlap >= 2) {
          // Must clear recency (+0.1 max) + fact boost (+0.15) the current note
          // typically carries, or past-intent queries can never win.
          hit.score += 0.3;
          if (trace) addRankingTerm(hit, 'historical_intent', 0.3);
          hit.reason += '+historical-intent';
        }
      }

      const currentPredicates = new Set(
        facts.filter(f => f.valid_to === null).map(f => String(f.predicate))
      );
      // Demote: chunk carries a value the lifecycle has since superseded.
      for (const f of facts) {
        if (f.valid_to === null || !currentPredicates.has(String(f.predicate))) continue;
        const stale = (f.object_text ?? '').trim().toLowerCase();
        if (stale.length >= 3 && text.includes(stale)) {
          if (pastIntent) {
            hit.score += 0.1;
            if (trace) addRankingTerm(hit, 'past_fact', 0.1);
            hit.reason += '+historical-intent';
          } else {
            hit.score -= 0.15;
            if (trace) addRankingTerm(hit, 'stale_fact', -0.15);
            hit.reason += '+stale-fact';
          }
          break; // one demotion per hit; stale signal already applied
        }
      }
      // Lift: chunk carries the currently-valid value for a superseded predicate.
      if (!pastIntent) {
        for (const f of facts) {
          if (f.valid_to !== null) continue;
          const wasSuperseded = facts.some(g =>
            g.valid_to !== null && String(g.predicate) === String(f.predicate)
          );
          if (!wasSuperseded) continue; // plain current facts already get the fact boost above
          const cur = (f.object_text ?? '').trim().toLowerCase();
          if (cur.length >= 3 && text.includes(cur)) {
            hit.score += 0.1;
            if (trace) addRankingTerm(hit, 'current_fact', 0.1);
            hit.reason += '+current-fact';
            break;
          }
        }
      }
    }
  }

  const ranked = dedupeHits(scored.sort(byScoreThenPlace));
  if (trace) ranked.forEach((hit, index) => trace.pool(hit, index + 1));
  // Fail-open floor. The stub filter must never empty the window: a zero-hit
  // retrieval is a hard abort on the product path, because the benchmark client
  // refuses to score a case with no hits ("Retrieval precondition failed: public
  // CLI search returned zero hits"). That is strictly worse than surfacing a stub.
  // Measured 2026-09-29: an arm carrying a metadata-strip variant of this filter
  // died at case 122/500 on exactly this precondition. Fall back to the unfiltered
  // ranking when filtering would leave nothing.
  const filtered = ranked.filter(h => !isSpeakerStub(h.text));
  const contentful = filtered.length > 0 ? filtered : ranked;
  const datedFactHits = factHits.map(h => {
    const row = noteRow(h.notePath);
    return { ...h, session_date: resolveSessionDate(row?.frontmatter_json, row?.modified_at) };
  });
  const seen = new Set(datedFactHits.map(h => h.text));
  // The ledger's own header is no memory: it comes off with the closed events, before the page is cut.
  const mixed = dropLedgerPreamble(resolveLedgerHits(
    [...datedFactHits, ...contentful.filter(h => !seen.has(h.text))],
    closedLedgerEvents(db), opts.includeHistory === true,
  ), opts.isLedgerNote);
  const explain = opts.probe?.explain;
  if (explain) {
    explain.lanes.push(semanticHits.length > 0 ? 'semantic-or-keyword' : 'none');
    if (factHits.length > 0) explain.lanes.push('facts');
    noteStage(explain, 'candidates', semanticHits.length + factHits.length);
    noteStage(explain, 'ranked-pool', ranked.length);
    const liveIds = new Set(mixed.map(h => h.chunkId));
    for (const h of contentful) if (!liveIds.has(h.chunkId)) noteDrop(explain, h.chunkId, 'retired');
    noteStage(explain, 'live', mixed.length);
  }
  const diversityCap = resolveSessionDiversityCap(process.env, opts.noteCapWhenUnset);
  // RENOR_NEAR_DUP_CAP (default off): near-copies are capped before the per-note cap, on the visible text.
  // RENOR_RERANK_TOP_N (default off): the first n of that ranking are reranked by the query words they carry, then cut to topK.
  const rerankN = resolveRerankTopN();
  const diversified = applySessionDiversity(applyNearDupCap(mixed, nearDupCap, contentfulText), diversityCap, topK);
  const windowed = (rerankN > topK ? rerankTopN(diversified, query, rerankN) : diversified).slice(0, topK);
  if (explain) {
    const afterDiversity = new Set(diversified.map(h => h.chunkId));
    const inWindow = new Set(windowed.map(h => h.chunkId));
    for (const h of mixed) if (!afterDiversity.has(h.chunkId)) noteDrop(explain, h.chunkId, 'per-note-cap');
    noteStage(explain, 'after-per-note-cap', diversified.length);
    for (const h of diversified) if (!inWindow.has(h.chunkId)) noteDrop(explain, h.chunkId, 'budget');
    noteStage(explain, 'window', windowed.length);
  }
  // The window's candidates are recorded before they are copied into the plain hits below, which carry no terms.
  if (trace) for (const hit of windowed) trace.touch(hit);
  let hits = windowed.map(h => ({
    notePath: h.notePath,
    chunkId: h.chunkId,
    headingPath: h.headingPath,
    text: h.text,
    score: h.score,
    reason: h.reason,
    ...(h.session_date ? { session_date: h.session_date } : {}),
    ...(cosineByChunk?.has(h.chunkId) ? { similarity: cosineByChunk.get(h.chunkId) } : {}),
    // A fact an identity question read names its author, so the reader's view can mark it (mvp/factMarkers.ts).
    ...('author' in h && h.author !== undefined ? { author: h.author } : {}),
  }));
  return { hits, noteRow, temporal, pastIntent };
}

/** The hits dated, joined by the statements of their sessions and laid out. The first wait is for the date of an entry of a daily note. */
async function finishContext(read: {
  db: Database.Database; vectorIndex: VectorIndex | undefined; provider: ProviderLike | undefined; query: string; queryProbe: RetrievalProbe;
  window: ReturnType<typeof rankWindow>;
  /** The matches the read asked for: the ranked expansion's budget may grow with it (RENOR_TOPK_SCALES_PAGE). */
  topK: number;
}): Promise<RetrievalResult> {
  const { db, vectorIndex, provider, query, queryProbe, window, topK } = read;
  const { noteRow, temporal, pastIntent } = window;
  let { hits } = window;
  // A hit that is a ledger event is dated by the event, and one that is an entry of a daily note by the entry: each
  // is one note, so the note's date is one date for every event, or every entry of the day, in it. Decided on the
  // text a hit still has after liveness filtering, and only for the hits that are returned. Everything else keeps its
  // note's date; no score is touched. Entry headers, filenames and replayed event times are content too: none may
  // override the indexed file's write-time bound, even on already indexed notes.
  const eventTime = createLedgerEventClock(db);
  const entryTime = createDailyEntryClock();
  // The dates of events are read as the hits are mapped, before any of them waits: in one transaction (inReadSnapshot).
  hits = await Promise.all(inReadSnapshot(db, () => hits.map(async h => {
    const derived = eventTime(h) ?? await entryTime(h);
    if (derived === undefined) return h;
    const session_date = clampSessionDate(derived, noteRow(h.notePath)?.modified_at);
    return { ...h, session_date };
  })));
  // RENOR_SESSION_EXPAND (default 5 notes, 0 is off): the short statements of the best notes in the window join it,
  // under a token budget. The window itself is not touched; see sessionExpansionHits.
  const expansion = resolveSessionExpand();
  // Ranking by cosine is armed only for an embedding model the product has calibrated (CALIBRATED_BARS): the order
  // of cosines was measured for that model. Any other provider (the lexical eval stub, an unmeasured model) keeps the
  // former expansion, unless the operator declares that its endpoint serves a calibrated model (calibratedModelKey).
  const rankedExpansion = calibratedModelKey(provider?.identity, provider?.dimensions) !== null ? resolveRankedExpansion(process.env, topK) : null;
  if (expansion) hits = [...hits, ...inReadSnapshot(db, () => sessionExpansionHits(db, hits, expansion, rankedExpansion && queryProbe.queryVector && vectorIndex ? { vectorIndex, queryVector: queryProbe.queryVector, ranked: rankedExpansion } : undefined))];
  // Default-on (S0 78.4%): lay the already-selected window out newest-session-first.
  // Does not replace scoring or change which chunks enter top-K. Opt out: RENOR_NEWEST_FIRST=0.
  // An explicit past-intent query overrides this presentation rerank — "what was
  // it before" is precisely the case where newest-first is the wrong order.
  // Either way the result says which key it is in order of (`rankedBy`): the order is a presentation
  // choice the agent cannot see from the hits alone, and hits[0] is not "the answer" unless that key is score.
  const newestFirst = newestFirstEnabled() && !(temporal && pastIntent);
  const rankedBy: HitOrder = newestFirst ? 'session_date' : 'score';
  contentfulHeld.clear(); // nothing outlives the read it was worked out for
  // The order the reply presents its hits in, so a candidate's place in it is recorded for the learning log (rankingTrace.ts).
  const presented = orderHits(hits, rankedBy);
  currentRankingTrace()?.presented(presented);
  return { query, hits: presented, rankedBy };
}
