import type Database from '../db/sqlite';
import { prepareOnce } from '../db/statements';
import { keywordSearch } from './keyword';
import { keywordLedgerHits, type IsLedgerNote } from './ledgerPresentation';
import { quoteFtsQuery, shownPage } from './queryHelpers';

/**
 * Plain-wording retrieval and crowding: three switches, each default OFF, each a kill switch of its own.
 *
 * Why (the owner's real use, 2026-10-21): where Renor held the memory, the owner's own words as the query returned it
 * 5 of 24 times against 19 of 24 for a hand-aimed topic query, and of 183 agent queries that once returned a memory the
 * agent acted on, 40% no longer return it as the workspace grows. None of the three calls a model.
 *
 *  - RENOR_ENTITY_LANE: the rare words a query names (a subject such as "jev", a service, a project) are looked up in
 *    the keyword index; the chunks that carry them join the semantic candidates at their own cosine, and every candidate
 *    that carries them is lifted by up to ENTITY_LANE_BOOST (the lift `+entity` already gives an entity's note).
 *  - RENOR_QUERY_REWRITE: the conversational wrapper of a query ("hey, do you remember what we said about ...") is taken
 *    off before it is embedded, so the words that are embedded are the ones stored memories use.
 *  - RENOR_NEAR_DUP_CAP=<n>: at most `n` near-copies (word-set Jaccard >= NEAR_DUP_JACCARD) in one window, the best
 *    scored kept; with it the candidate pool is read deeper (NEAR_DUP_POOL), so the distinct memories that newer
 *    near-copies pushed below the old pool depth can take the freed places.
 */

function on(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function entityLaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return on(env.RENOR_ENTITY_LANE);
}

export function queryRewriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return on(env.RENOR_QUERY_REWRITE);
}

/** The near-copy cap, or 0 (off) when unset, empty, junk or below 1. */
export function resolveNearDupCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RENOR_NEAR_DUP_CAP ?? '').trim();
  if (raw === '') return 0;
  const cap = Number(raw);
  return Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 0;
}

/** Words that never name what a memory is about: function words and the words of asking and remembering. */
const PLAIN_STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'does', 'did', 'done', 'with', 'about', 'this', 'that', 'these', 'those', 'there', 'here', 'then', 'than', 'from',
  'into', 'onto', 'over', 'your', 'yours', 'our', 'ours', 'their', 'theirs', 'his', 'her', 'hers', 'its', 'you', 'they',
  'them', 'she', 'him', 'can', 'could', 'would', 'should', 'will', 'shall', 'might', 'must', 'may', 'have', 'has', 'had',
  'been', 'being', 'not', 'any', 'all', 'some', 'just', 'also', 'very', 'really', 'again', 'still', 'now', 'ever',
  'remember', 'remind', 'recall', 'tell', 'told', 'say', 'said', 'know', 'think', 'thought', 'mean', 'meant', 'please',
  'thanks', 'hey', 'okay', 'yeah', 'yes', 'like', 'thing', 'things', 'stuff', 'something', 'anything', 'everything',
  'one', 'ones', 'get', 'got', 'let', 'lets', 'need', 'want', 'look', 'check', 'find', 'give', 'show', 'saved', 'save',
  'memory', 'memories', 'renor', 'claude', 'myself', 'yourself', 'we', 'us', 'me', 'my', 'it', 'is', 'in', 'on', 'of',
  'to', 'do', 'be', 'or', 'an', 'at', 'as', 'by', 'if', 'so', 'up', 'am', 'last', 'time', 'before', 'earlier', 'after',
  'since', 'until', 'during', 'while', 'because', 'between', 'other', 'another', 'first', 'next', 'every', 'each', 'many',
  'much', 'more', 'most', 'less', 'same', 'such', 'only', 'well', 'today', 'yesterday', 'ago', 'way', 'kind', 'sort',
]);

/** The words of `query` that could name its subject: three characters or more (a hyphenated name is one word), no stop word. */
export function contentTerms(query: string): string[] {
  const words = (query ?? '').toLowerCase().normalize('NFC').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]*/gu) ?? [];
  const out: string[] = [];
  for (const raw of words) {
    const word = raw.replace(/[-_]+$/, '').replace(/'s$/, '');
    if ([...word].length < 3 || PLAIN_STOP.has(word) || out.includes(word)) continue;
    out.push(word);
  }
  return out;
}

/** Distinct whole content words a query must share with an entity's facts before the fact boost applies. */
export const FACT_BOOST_MIN_TERMS = 2;

/**
 * True when at least FACT_BOOST_MIN_TERMS distinct (or the one, for a one-word query) content words of the query appear as WHOLE words in the facts' objects
 * or predicates. Stop words and substrings ("it" inside "commit") never count, so a long plain-wording question no longer
 * lifts every hit by noise.
 */
export function factBoostMatches(
  queryContentTerms: string[],
  facts: Array<{ object_text?: string | null; predicate?: string | null }>,
): boolean {
  const terms = [...new Set(queryContentTerms)];
  // A query with a single content word ("Acme") can only ever match one; it still counts, as a whole word. Longer queries need two.
  const needed = Math.min(FACT_BOOST_MIN_TERMS, terms.length);
  if (needed === 0) return false;
  const tokens = new Set<string>();
  for (const f of facts) {
    for (const text of [f.object_text, f.predicate]) {
      for (const w of contentTerms(text ?? '')) tokens.add(w);
    }
  }
  let matched = 0;
  for (const t of terms) {
    if (tokens.has(t) && ++matched >= needed) return true;
  }
  return false;
}

/**
 * Wrappers a person puts around a question when they talk to an agent. Taken off the front of the query, repeatedly,
 * and only there: inside a query the same words can be what it is about.
 */
const LEADING_WRAPPERS: RegExp[] = [
  /^(?:hey|hi|hello|ok|okay|so|um|uh|well|right|and|but|also|btw|by the way|quick question|question)\b[\s,:;.!-]*/i,
  /^(?:claude|renor|codex|cursor)\b[\s,:;.!-]*/i,
  /^(?:please|pls|can you|could you|would you|will you|do you|did you|are you able to)\b\s*/i,
  /^(?:(?:still )?remember|recall|remind me(?: of)?|tell me|look up|find|check|pull up|bring up|show me)\b\s*/i,
  /^(?:what (?:(?:did|do|have) )?(?:i|we|you) (?:say|said|tell you|told you|decide|decided|note|noted|save|saved|write|wrote|agree|agreed|settle|settled)(?: on)?)\b\s*/i,
  /^(?:what (?:was|were|is|are) (?:it|that|the thing|those|these))\b\s*/i,
  /^(?:the (?:thing|stuff|notes?)|our (?:notes?|discussion|conversation))\b\s*/i,
  /^(?:about|on|regarding|re|for|of|with|that)\b[\s,:]*/i,
];

/**
 * The query without its conversational wrapper ("hey, do you remember what we said about the jev measurements?" ->
 * "the jev measurements"). The question's own words are kept as written; a trailing "again", "?" or "please" goes too.
 * When the rewrite would leave fewer than two content words, or nothing changed, the query is returned as it came.
 */
export function rewriteConversationalQuery(query: string): string {
  const original = (query ?? '').trim();
  let q = original;
  for (let guard = 0; guard < 12; guard++) {
    const before = q;
    for (const wrapper of LEADING_WRAPPERS) q = q.replace(wrapper, '');
    q = q.trim();
    if (q === before) break;
  }
  q = q.replace(/[\s,]*(?:again|please|for me|real quick|if you can|do you remember|remember)?[\s?.!]*$/i, '').trim();
  const kept = contentTerms(q).length;
  if (q === original.replace(/[\s?.!]+$/, '') || kept === 0 || kept < Math.min(2, contentTerms(original).length)) return original;
  return q;
}

/** The lift a candidate that carries every lane word gets: the lift `+entity` gives an entity's note (orchestrator.ts). */
export const ENTITY_LANE_BOOST = 0.2;
/** At most this many lane words per query: the rarest. */
export const ENTITY_LANE_MAX_TERMS = 3;
/** The lane reads queries of at most this many content words. */
export const ENTITY_LANE_MAX_QUERY_TERMS = 12;
/** A word is rare enough to name a subject when at most this many chunks carry it, or ENTITY_LANE_DF_SHARE of all chunks. */
export const ENTITY_LANE_MIN_DF_LIMIT = 5;
export const ENTITY_LANE_DF_SHARE = 0.02;

/**
 * The lane words of `query`: its content words that name a registered entity, or that few enough chunks carry to name a
 * subject, rarest first (a named entity before any other word). Two bounded lookups per word; none for a query of more than
 * ENTITY_LANE_MAX_QUERY_TERMS content words.
 */
export function entityLaneTerms(db: Database.Database, query: string): string[] {
  const terms = contentTerms(query);
  // A query of many words is a passage, not a named subject: its rarest word is as likely a heading's (measured: a pasted
  // section lost its own chunk to a "Parking lot" section of another note). The semantic lane already matches a passage.
  if (terms.length === 0 || terms.length > ENTITY_LANE_MAX_QUERY_TERMS) return [];
  const chunks = (prepareOnce(db, 'SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  const limit = Math.max(ENTITY_LANE_MIN_DF_LIMIT, Math.floor(chunks * ENTITY_LANE_DF_SHARE));
  const counted: Array<{ term: string; df: number; named: boolean }> = [];
  for (const term of terms) {
    const match = quoteFtsQuery(term);
    if (!match) continue;
    let df: number;
    try {
      df = (prepareOnce(db, 'SELECT COUNT(*) AS n FROM (SELECT 1 FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT ?)').get(match, limit + 1) as { n: number }).n;
    } catch {
      continue; // a word FTS5 cannot read is no lane word
    }
    if (df === 0) continue;
    const named = prepareOnce(
      db,
      `SELECT 1 FROM entities WHERE canonical_name = ? COLLATE NOCASE
       UNION ALL SELECT 1 FROM entities, json_each(entities.aliases_json) AS alias WHERE lower(alias.value) = ? LIMIT 1`,
    ).get(term, term) !== undefined;
    if (named || df <= limit) counted.push({ term, df, named });
  }
  return counted
    .sort((a, b) => Number(b.named) - Number(a.named) || a.df - b.df)
    .slice(0, ENTITY_LANE_MAX_TERMS)
    .map(c => c.term);
}

/**
 * The chunks that carry any lane word, best keyword match first, at most `perTerm` for each word. Read as every keyword
 * reader reads (shownPage): the ledger's header and the events the word is not in are judged away before the page is cut.
 */
export function entityLaneChunkIds(db: Database.Database, terms: string[], perTerm: number, isLedgerNote?: IsLedgerNote): number[] {
  const ids: number[] = [];
  for (const term of terms) {
    const match = quoteFtsQuery(term);
    if (!match) continue;
    const page = shownPage(rows => keywordSearch(db, match, rows), rows => keywordLedgerHits(rows, isLedgerNote, term), perTerm);
    for (const hit of page) if (!ids.includes(hit.chunkId)) ids.push(hit.chunkId);
  }
  return ids;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The share of `terms` that `text` carries as whole words (a hyphen or underscore in a lane word matches any separator). */
export function laneTermShare(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = (text ?? '').toLowerCase().normalize('NFC');
  let carried = 0;
  for (const term of terms) {
    const pattern = term.split(/[-_]+/).map(escapeRegExp).join('[\\s_-]+');
    if (new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'u').test(lower)) carried++;
  }
  return carried / terms.length;
}

/** Two texts whose word sets share at least this share of their union are near-copies. */
export const NEAR_DUP_JACCARD = 0.6;
/** How deep the candidate pool is read while the near-copy cap is on (the default reads min(40, topK * 4)). */
export const NEAR_DUP_POOL = { perTopK: 8, max: 160 };

function wordSet(text: string): Set<string> {
  return new Set((text ?? '').toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * At most `cap` near-copies in the window: in rank order, a hit is kept while fewer than `cap` kept hits are near-copies
 * of it. A fact row (a negative chunkId) is left alone. `cap < 1` returns the hits as they came. `textOf` is the text the
 * copies are compared on (the orchestrator passes the visible text, without markdown and speaker labels).
 */
export function applyNearDupCap<T extends { chunkId: number; text: string }>(hits: T[], cap: number, textOf: (text: string) => string = t => t): T[] {
  if (cap < 1) return hits;
  const kept: T[] = [];
  const keptWords: Array<Set<string>> = [];
  for (const hit of hits) {
    if (hit.chunkId < 0) { kept.push(hit); continue; }
    const words = wordSet(textOf(hit.text));
    let copies = 0;
    for (const other of keptWords) if (jaccard(words, other) >= NEAR_DUP_JACCARD && ++copies >= cap) break;
    if (copies >= cap) continue;
    kept.push(hit);
    keptWords.push(words);
  }
  return kept;
}
