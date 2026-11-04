import path from 'path';
import Database from '../db/sqlite';
import { encodeTokens } from '../indexer/tokenizer';
import { escapeInvisibleControls } from './sanitize';
import { labelMemoryText } from './hiddenSpans';
import { currentRankingTrace } from '../retrieval/rankingTrace';
import { engineSearchMemory, engineSearchText, type Engine } from './engine';
import { leadingSummaryHits } from '../digests/digests';
import { normalizeScope, savedScopeMatches } from './scope';
import { contextDistinctEnabled, distinctMemories } from './contextDistinct';
import { contextNewerFirstEnabled, newerFirstMemories } from './contextNewerFirst';
import { claimsReservedEntrySource, eventMarker, factAuthorsByEvent } from './factMarkers';
import { authorMarker } from '../memory/sourceName';
import type { HitOrder } from '../retrieval/orchestrator';
import { orderHits, SESSION_EXPAND_REASON, sessionDateMs } from '../retrieval/orchestrator';
import type { EvidenceToolOptions } from '../evidence/options';
import type { EvidenceExtractor } from '../evidence/secondPass';
import { productEvidenceReport, type ProductEvidenceState } from '../evidence/attach';
import {
  acrossScopes,
  applyReadHonesty,
  conflictAcrossScopes,
  factProvenance,
  fitConflicts,
  noteProvenance,
  questionKey,
  readHonestyEnabled,
  type ConflictSide,
  type FactConflict,
  type Abstention,
  type Provenance,
} from '../context/readHonesty';
import { DEFAULT_LEDGER_REL } from '../memory/lifecycle';
import { writerConflictLines } from '../memory/writerConflicts';
import { ledgerEventIds } from '../retrieval/ledgerLiveness';
import { ledgerNoteMatcher, type LedgerRecordCache } from '../retrieval/ledgerPresentation';
import { atomSequence, atoms, findCurrentFacts, recentCurrentFacts, words, type CurrentFact } from '../memory/factTerms';
import { namedConflicts } from '../memory/factConflicts';
import { inReadSnapshot } from '../db/readCache';
import { prepareOnce } from '../db/statements';
import { assessQueryRelevance, CALIBRATED_BARS, contextRelevanceEnabled, renderFactForRelevance, resolveRelevanceBar, similaritiesTo, type ContextRelevance } from './contextRelevance';
import type { RetrievalProbe } from '../retrieval/semantic';
import { hasReplacements, withReplacements, type ReplacedLabel, type ReplacementPair } from '../memorymap/replacements';
import { markRetrieved } from '../callPhases';
import { staleStatusOf, statusFreshnessMode } from '../memory/statusFacts';
import { APPROVED_RULES_NOTE, loadPinnedRules, PINNED_RULES_NOTE } from './pinnedRules';
import { buildDatedOutline, replyCeiling, datedOutlineBudget, datedOutlineEnabled, datedOutlineMinSimilarity, listOutlineCandidates, withoutReplaced, withDatedOutline, MIN_OUTLINE_TOKENS, type OutlineCandidate } from './datedOutline';
import { turnScorer, vectorsMeanSomething } from '../retrieval/readerEvents';
import { ruleApprovalsEnabled } from './ruleApprovals';
import { ownScopeFirstFacts, ownScopeFirstMemories, ownScopeSlug } from './ownScopeFirst';

export interface AgentContextOptions {
  query?: string;
  scope?: string;
  /** The project scope the connection names (x-renor-scope, written by `renor connect` into a project config). Only orders, only with RENOR_OWN_SCOPE_FIRST on. */
  connectionScope?: string;
  maxTokens?: number;
  /** The reading agent's name: a fact saved under another name carries its `source`. Absent: every fact with an author does. */
  reader?: string;
  /** Explicit request for superseded ledger events (labelled); never inferred from the query text. */
  includeHistory?: boolean;
  evidence?: { options: EvidenceToolOptions; extractor: EvidenceExtractor | null };
  /** Relative ledger path for fact provenance (LANE 3). */
  ledgerRelPath?: string;
  /** Env seam for the read-honesty flag (LANE 3). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Calibration seam: receives the chunk and fact similarities behind `relevance`. */
  relevanceComponents?: { chunk: number | null; fact: number | null };
  /**
   * Fields the caller adds at the end of the reply (the MCP tool's index notice), asked once the searches have run, so
   * that they count against max_tokens with the rest of it.
   */
  trailer?: () => Record<string, unknown>;
}

export interface AgentContextFact {
  subject: string;
  predicate: string;
  object: string;
  validFrom: string;
  scope: string;
  /** Who saved it, when it differs from the reading agent. Absent when the reader saved it, or nobody is named. */
  source?: string;
  /** Set on a fact an import saved: its text came from a file, not from something the user said to an agent. */
  untrusted?: true;
  /** Where this fact came from and when it was last verified (LANE 3, flag-gated). */
  provenance?: Provenance;
  /** Set on a current fact that replaced a value another writer saved, until that writer saves it again (memory/writerConflicts.ts). */
  writerConflict?: string;
  /** Set (RENOR_STATUS_FRESHNESS) on a short-lived status fact past its freshness window. */
  staleStatus?: string;
}

export interface AgentContextMemory {
  notePath: string;
  headingPath?: string;
  text: string;
  score?: number;
  reason: string;
  session_date?: string;
  /**
   * Present only on a memory a later correction replaced (remember `replaces`): `by` is the correction's memory id, `at`
   * when it was saved, `source` who saved it, and `note` when that differs from the replaced memory's source. The correction
   * is listed before it. A workspace with no replacement never has this field.
   */
  replaced?: ReplacedLabel;
  /**
   * False on a memory the query did not match: only the session expansion adds those (normalizeMemory), in the
   * explicit-boolean marker style the hive tools use for untrusted agent text (memory/whatsNew.ts). Absent on every
   * match, so a memory without it was matched.
   */
  matched?: boolean;
  /**
   * `import` on a memory under `Imported/`: a document someone imported, written as an ordinary note. Its text is
   * untrusted source material, not one of the engine's own daily entries, and the path alone was the only thing that
   * told them apart (adv report renor-adv-inj6b-1012, F3). Absent on every other memory.
   */
  origin?: 'import';
  /** `true` on a memory a newer, near-identical memory on the same page follows from (RENOR_CONTEXT_NEWER_FIRST, off by default). */
  earlier?: true;
}

export const FTS_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'which', 'who', 'where', 'when',
  'why', 'how', 'do', 'does', 'did', 'to', 'for', 'of', 'in', 'on', 'at', 'with', 'and',
  'or', 'my', 'your', 'our', 'their', 'his', 'her', 'it', 'this', 'that', 'about',
  // Two-letter words that never name a topic. Not every two-letter word: CI, DB, AI, Go or IP often are the topic.
  'am', 'as', 'be', 'by', 'he', 'if', 'me', 'so', 'up', 'we',
]);

/**
 * The facts lane's stop words: FTS_STOP_WORDS and the other words that never say what a fact is about. Pronouns,
 * auxiliaries and modals, negation and what a contraction leaves of it ("don't" is `don`), quantifiers, and the
 * adverbs, prepositions and conjunctions of any question. A fact's object is often a sentence that has them, so a
 * question found it by them: "Hi, how are you?" returned a finding that says "you can not run all the tests now" (live
 * dogfood, 2026-10-03, D7). Words that can be the topic are not here: "us" (the country), "may" (the month), "won" (a
 * deal), "down", "off", "out" and "over" (a state), and two-letter topics like CI or DB.
 */
const FACT_STOP_WORDS = new Set([
  ...FTS_STOP_WORDS,
  'you', 'him', 'she', 'they', 'them', 'its', 'mine', 'yours', 'ours', 'theirs', 'hers', 'these', 'those', 'whom', 'whose',
  'myself', 'yourself', 'yourselves', 'himself', 'herself', 'itself', 'ourselves', 'themselves',
  'can', 'could', 'will', 'would', 'shall', 'should', 'might', 'must', 'have', 'has', 'had', 'having', 'been', 'being', 'doing',
  'not', 'no', 'nor', 'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'hasn', 'haven', 'hadn', 'couldn', 'wouldn',
  'shouldn', 'mustn', 'needn', 'mightn', 'shan', 'ain', 'll', 're', 've',
  'all', 'any', 'both', 'each', 'every', 'few', 'many', 'much', 'more', 'most', 'other', 'some', 'such', 'same', 'own',
  'now', 'then', 'here', 'there', 'just', 'also', 'very', 'too', 'only', 'again', 'once', 'further',
  'from', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'against', 'between',
  'but', 'because', 'until', 'while', 'than',
]);

/**
 * The words a fact is looked up by for `query`: its atoms (memory/factTerms.ts) without the facts lane's stop words, so
 * "in", "you" or "not" never make a fact relevant. The stop words count only when the query has no other word.
 */
export function factQueryTerms(query: string): string[] {
  const all = atoms(query);
  const content = all.filter(word => !FACT_STOP_WORDS.has(word));
  return content.length > 0 ? content : all;
}

/**
 * Two neighbouring words of `query` written as one, the way keys often are: "time zone" is `timezone`, "home lab" `homelab`,
 * "Lane J" `lanej`. Single letters and digits following a word are joined as well so relation keys like "lanej" or "v2" match.
 */
export function joinedWords(query: string): string[] {
  const sequence = atomSequence(query);
  const joined: string[] = [];
  for (let i = 1; i < sequence.length; i++) {
    // Never a stop word: "to do" is not the status `todo`.
    if (!FACT_STOP_WORDS.has(sequence[i - 1]) && !FACT_STOP_WORDS.has(sequence[i])) joined.push(sequence[i - 1] + sequence[i]);
  }
  const rawParts = query.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_-]+/gu, ' ').split(/\s+/).map(w => w.trim()).filter(Boolean);
  for (let i = 1; i < rawParts.length; i++) {
    const prev = rawParts[i - 1];
    const curr = rawParts[i];
    // A trailing `s` is a possessive, not an initial: "John's plan" is not the key `johns`.
    if (prev.length >= 2 && curr.length === 1 && curr !== 's' && !FACT_STOP_WORDS.has(prev) && !FACT_STOP_WORDS.has(curr) && curr !== 'a' && curr !== 'i') {
      joined.push(prev + curr);
    }
  }
  return Array.from(new Set(joined));
}

export function wordStems(wordList: readonly string[]): string[] {
  const out = new Set<string>();
  const irregularBases: Record<string, string> = { does: 'do', has: 'have' };
  for (const word of wordList) {
    out.add(word);
    const irregular = irregularBases[word];
    if (irregular) {
      out.add(irregular);
    } else if (/^[a-z]+ies$/.test(word) && word.length >= 5) {
      out.add(`${word.slice(0, -3)}y`);
    } else if (/^[a-z]+(ches|shes|xes|zes|oes|sses)$/.test(word)) {
      out.add(word.slice(0, -2));
    } else if (
      /^[a-z]+s$/.test(word) && word.length >= 4 &&
      !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')
    ) {
      out.add(word.slice(0, -1));
    } else if (/^[a-z]+ed$/.test(word) && word.length >= 5) {
      out.add(word.slice(0, -2));
      out.add(word.slice(0, -1));
    } else if (/^[a-z]+ing$/.test(word) && word.length >= 6) {
      out.add(word.slice(0, -3));
    }
  }
  return Array.from(out);
}

/**
 * The words a query looks facts up by, and the same with two neighbouring words joined: where ranking and scoring both
 * start. Ranking scores every candidate against one query, so the words are worked out once, not once per fact.
 */
const FACT_SEARCH_TERMS_MAX = 8;
const factSearchTermsHeld = new Map<string, string[]>();
function factSearchTerms(query: string): string[] {
  const held = factSearchTermsHeld.get(query);
  if (held) return held;
  const terms = [...new Set([...factQueryTerms(query), ...joinedWords(query)])];
  if (factSearchTermsHeld.size >= FACT_SEARCH_TERMS_MAX) factSearchTermsHeld.delete(factSearchTermsHeld.keys().next().value as string);
  factSearchTermsHeld.set(query, terms);
  return terms;
}

/**
 * Stems of one field of a fact (its subject, predicate, object or saved statement words). The text is the whole input.
 * A read ranks a few dozen candidates and then scores each of them again, so a field is stemmed once per read, not twice
 * per fact and word; a subject or predicate that many facts share costs one stemming for all of them. A few hundred
 * fields are kept: the working set of one read, not of the workspace.
 */
const FIELD_STEMS_MAX = 256;
/** A field longer than this is stemmed again each time rather than held: one long object would take the room of dozens. */
const FIELD_STEMS_MAX_CHARS = 1024;
const fieldStems = new Map<string, Set<string>>();
const statementWordStems = new Map<string, Set<string>>();
function stemsOfField(text: string): Set<string> {
  const held = fieldStems.get(text);
  if (held) return held;
  const stems = new Set(wordStems(atoms(text)));
  if (text.length <= FIELD_STEMS_MAX_CHARS) {
    if (fieldStems.size >= FIELD_STEMS_MAX) fieldStems.delete(fieldStems.keys().next().value as string);
    fieldStems.set(text, stems);
  }
  return stems;
}

/** The stems of the words a fact's saved statement was stored with (`statementTerms`: atoms joined by one space). */
function stemsOfStatementWords(statementWords: string | null | undefined): Set<string> {
  const text = statementWords ?? '';
  const held = statementWordStems.get(text);
  if (held) return held;
  const stems = new Set(wordStems(text ? text.split(' ') : []));
  if (text.length <= FIELD_STEMS_MAX_CHARS) {
    if (statementWordStems.size >= FIELD_STEMS_MAX) statementWordStems.delete(statementWordStems.keys().next().value as string);
    statementWordStems.set(text, stems);
  }
  return stems;
}

/**
 * Score a fact's relevance to the query: matches in subject and predicate weight highest because they define what
 * the fact is about; object matches are normalized by length (BM25 principle: long objects have incidental matches);
 * distinct query term coverage scales the score; and facts matching the request's scope or naming the queried scope are preferred.
 */
export function scoreFactRelevance(fact: CurrentFact, query: string, requestScope?: string): number {
  const queryTerms = factSearchTerms(query);
  if (queryTerms.length === 0) return 0;
  return scoreFactTerms(fact, query, requestScope, queryTerms, queryTerms.map(cachedTermStems));
}

/** `scoreFactRelevance` for a query whose words, and their stems, the caller has already worked out. */
function scoreFactTerms(
  fact: CurrentFact, query: string, requestScope: string | undefined,
  queryTerms: readonly string[], termStemList: ReadonlyArray<readonly string[]>,
): number {
  const subjStems = stemsOfField(fact.subject);
  const predStems = stemsOfField(fact.predicate);
  const objStems = stemsOfField(fact.object ?? '');
  const objectText = fact.object ?? '';
  const objectWordTokens = objectText.trim() ? objectText.split(/\s+/).length : 0;

  let subjectMatches = 0;
  let predicateMatches = 0;
  let objectMatches = 0;
  let distinctMatched = 0;

  for (const tStems of termStemList) {
    const inSubj = tStems.some(s => subjStems.has(s));
    const inPred = tStems.some(s => predStems.has(s));
    const inObj = tStems.some(s => objStems.has(s));
    if (inSubj) subjectMatches++;
    if (inPred) predicateMatches++;
    if (inObj) objectMatches++;
    if (inSubj || inPred || inObj) distinctMatched++;
  }

  const subjectScore = subjectMatches * 4.0;
  const predicateScore = predicateMatches * 4.0;
  const bothBonus = subjectMatches > 0 && predicateMatches > 0 ? 3.0 : 0.0;
  const lengthDamping = 1.0 + (objectWordTokens / 24.0);
  const objectScore = (objectMatches * 2.0) / lengthDamping;

  const coverage = distinctMatched / queryTerms.length;
  const coverageMult = 1.0 + coverage;

  let baseScore = (subjectScore + predicateScore + bothBonus + objectScore) * coverageMult;

  if (requestScope && fact.scope) {
    if (savedScopeMatches(fact.scope, normalizeScope(requestScope))) {
      baseScore += 2.0;
    }
  } else if (!requestScope && fact.scope) {
    const scopeSlug = fact.scope.includes(':') ? fact.scope.slice(fact.scope.indexOf(':') + 1) : fact.scope;
    if (scopeSlug && query.toLowerCase().includes(scopeSlug.toLowerCase())) {
      baseScore += 1.5;
    }
  }

  return baseScore;
}

export function rankCandidateFacts(facts: CurrentFact[], query: string, requestScope?: string): CurrentFact[] {
  if (!query.trim() || facts.length <= 1) return facts;
  const queryTerms = factSearchTerms(query);
  const termStemList = queryTerms.map(cachedTermStems);

  const scored = facts.map(fact => {
    const subjStems = stemsOfField(fact.subject);
    const predStems = stemsOfField(fact.predicate);
    const objStems = stemsOfField(fact.object ?? '');
    // The words of the statement the fact was saved with let a fact with a terse object reach the bar that the best fact
    // sets from subject, predicate and object alone (bestDistinct below). A statement never raises that bar: it only
    // admits its own fact. The order (scoreFactRelevance) does not change.
    const stmtStems = stemsOfStatementWords(fact.statementWords);
    let ownMatched = 0;
    let distinctMatched = 0;
    for (const tStems of termStemList) {
      if (tStems.some(s => subjStems.has(s) || predStems.has(s) || objStems.has(s))) ownMatched++;
      if (tStems.some(s => subjStems.has(s) || predStems.has(s) || objStems.has(s) || stmtStems.has(s))) distinctMatched++;
    }
    return {
      fact,
      score: queryTerms.length === 0 ? 0 : scoreFactTerms(fact, query, requestScope, queryTerms, termStemList),
      ownMatched,
      distinctMatched,
    };
  });

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-4) {
      return b.score - a.score;
    }
    if (a.fact.validFrom !== b.fact.validFrom) {
      return a.fact.validFrom < b.fact.validFrom ? 1 : -1;
    }
    return (b.fact.eventId ?? '').localeCompare(a.fact.eventId ?? '');
  });

  const bestDistinct = Math.max(...scored.map(s => s.ownMatched), 0);
  if (bestDistinct <= 0) return facts;

  // A fact that shares fewer than half as many words as the best one is left out, counting the best one by its subject,
  // predicate and object words only: when "Why did we consider moving Atlas to Fly.io?" finds the Fly.io fact by three
  // words, a fact that only says "Atlas" is not what was asked.
  return scored
    .filter(item => item.distinctMatched * 2 >= bestDistinct)
    .map(item => item.fact);
}

/**
 * The maximum share of the facts lane's budget a single fact's object may take.
 * Long fact objects (e.g. 2,000-char benchmark outputs from other lanes) are capped to this share so they do
 * not crowd out subsequent answering facts in get_context.
 */
export const MAX_FACT_OBJECT_LANE_SHARE = 0.35;

/**
 * Appended to a fact object the lane cut, so a reader knows it is a prefix and where the rest is: the agent
 * reads the whole fact with `read_memory` or `lookup_entity`.
 */
export const TRUNCATION_MARKER = '… [truncated — read the rest with read_memory or lookup_entity]';

export function capFactObject(object: string, maxTokens: number): string {
  if (replyTokens(object) <= maxTokens) return object;
  const budget = Math.max(1, maxTokens - replyTokens(TRUNCATION_MARKER));
  const words = object.split(/\s+/);
  let low = 0;
  let high = words.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = mid === 0 ? '' : words.slice(0, mid).join(' ') + '…';
    if (replyTokens(candidate) <= budget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return (best || (object.slice(0, Math.max(1, budget * 3)) + '…')) + TRUNCATION_MARKER;
}

/** Whether a listed fact's object is `value`, or the prefix of it the lane cut (a cut object carries TRUNCATION_MARKER). */
const objectIs = (shown: string, value: string): boolean =>
  shown === value || (shown.includes('…') && value.startsWith(shown.split('…')[0]));

/**
 * H11b (RENOR_KEYWORD_OR_ALL=1, default off): the keyword lane issues one FTS expression, the question's content words joined
 * by OR (BM25 ranks rare words highest), instead of the variants. Unset, nothing changes. Pre-registered in
 * data/renor-goal-better-temporal-2/prereg/H11b-H18-H12.md.
 */
export function keywordOrAll(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.RENOR_KEYWORD_OR_ALL ?? '').trim() === '1';
}

/** The FTS expression of H11b: each content word quoted, joined by OR. */
export function keywordOrMatch(query: string): string {
  const terms = [...new Set(words(query).filter(word => !FTS_STOP_WORDS.has(word)))];
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

/** H12 (RENOR_SEARCH_TEXT_FALLBACK=1, default off): search_text falls back to an OR over the words when the exact phrase is empty. */
export function searchTextFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.RENOR_SEARCH_TEXT_FALLBACK ?? '').trim() === '1';
}

export function keywordVariants(query: string): string[] {
  const compact = words(query).filter(word => !FTS_STOP_WORDS.has(word));
  const variants: string[] = [query.trim()];
  if (compact.length >= 2) variants.push(compact.slice(0, 4).join(' '));
  for (const word of compact.slice(0, 4)) variants.push(word);
  return Array.from(new Set(variants.filter(Boolean))).slice(0, 6);
}

// get_context reads a fact as the user's own standing rule unless it says otherwise, so a fact another agent saved names
// it, and an import is marked untrusted. The reader's own facts stay bare: the reply is budgeted with these fields counted.
const toAgentFact = (fact: CurrentFact, reader?: string): AgentContextFact => {
  const { subject, predicate, object, validFrom, scope } = fact;
  return { subject, predicate, object, validFrom, scope, ...authorMarker(fact.author, reader) };
};

/**
 * The words a predicate holding a standing rule or decision is saved under: what a later question about whether an
 * action is allowed must be answered with, and what the action's own words never name. A predicate counts when it is
 * one of these or is made of words one of which is (`ui_rule`, `approval_policy`, `deploy constraint`). The facts lane
 * looks these up when the question asks for permission (`permissionQuestion`), because the question is about the action
 * and shares no subject words with the rule that governs it. The words are read through the term index
 * (`findCurrentFacts`), which is bounded by the query, not the table.
 *
 * A word outside this list is not a standing fact to the permission path, however it is worded (`note`, `status`): the
 * list is the contract, and a governing fact saved under another word is found only by the question's own words.
 */
export const GOVERNANCE_PREDICATES: readonly string[] = [
  'rule', 'rules', 'policy', 'policies', 'decision', 'decisions', 'guideline', 'guidelines',
  'constraint', 'constraints', 'requirement', 'requirements', 'must', 'convention', 'conventions',
  'principle', 'principles', 'guardrail', 'guardrails', 'permission', 'permissions', 'approval', 'approvals',
];

/** Whether a fact's predicate holds a standing rule or decision (`GOVERNANCE_PREDICATES`), whole or by one of its words. */
export function isGovernancePredicate(predicate: string): boolean {
  const lower = predicate.toLowerCase();
  if (GOVERNANCE_PREDICATES.includes(lower)) return true;
  return lower.split(/[^\p{L}\p{N}]+/u).some(word => word !== '' && GOVERNANCE_PREDICATES.includes(word));
}

/**
 * The most governance facts a permission question adds ahead of the facts its words found: enough for
 * the rules that govern an action (there are usually a handful), never enough to crowd out the specific
 * fact the question named.
 */
export const PERMISSION_RULE_LIMIT = 3;

/**
 * How many governance candidates are considered before the relevance ranking. Governance facts are a
 * small share of a workspace, and the term index bounds the read (factTerms.ts), so this is generous
 * while keeping the work bounded by the query. A workspace with more governance facts than this is not
 * silently mis-ranked: the candidates are ranked by relevance to the question, and the ones sharing its
 * words are the ones that matter.
 */
const PERMISSION_RULE_CANDIDATES = 1_000;

/**
 * The phrases that ask whether an action is allowed or needs approval, as a person words them. The
 * subject of such a question is the action ("Can I add a section to the dashboard?"), so it shares no
 * words with the rule that governs it; the intent has to be read from the question, not matched to the
 * rule. Matched on word boundaries over a lower-cased, punctuation-stripped query, contractions spelled out.
 *
 * These ask for permission wherever they are: a modal addressed to the speaker, or a need for approval.
 */
const PERMISSION_PHRASES: readonly string[] = [
  'can i', 'can we', 'could i', 'could we', 'may i', 'may we', 'should i', 'should we',
  'am i allowed', 'are we allowed', 'is it allowed', 'is this allowed', 'is that allowed', 'is that still allowed',
  'need permission', 'needs permission', 'need approval', 'needs approval', 'need an approval',
  'require approval', 'requires approval', 'am i permitted', 'are we permitted', 'is it permitted',
  'need to ask', 'needs to ask', 'have to ask', 'has to ask', 'ask before', 'ask first', 'ask permission',
  'need to check with', 'need to confirm with', 'have to check with',
  'do i have to', 'do we have to',
  'is it ok to', 'is it okay to', 'is it fine to', 'is it acceptable to', 'is that ok', 'is that okay',
  'would it be okay to', 'would it be ok to', 'would it be fine to', 'would it be acceptable to',
];

/**
 * Words that ask for permission only in a question about the present: "Which regions are allowed?" asks, "The
 * migration is allowed to run after review." states, and "Where did we check with the vendor?" recalls (delta review
 * P3, 2026-10-09).
 */
const PERMISSION_WORDS: readonly string[] = [
  'allowed', 'permitted', 'permission to', 'permission for',
  'check with', 'confirm with', 'clear it with', 'clear this with', 'okay with', 'ok with',
];

/** Openings that make a sentence a question without its question mark. */
const QUESTION_OPENINGS = /^(?:is|are|am|do|does|can|could|may|might|should|would|will|must|what|which|who|whom|whose|where|when|why|how)\b/;
/** Openings of a question about what was done, not what may be: "Where did we", "When was it". */
const RECOLLECTION = /^(?:what|which|who|where|when|why|how)\s+(?:did|was|were|had)\b/;

/** Whether `query` asks whether an action is allowed or needs approval. */
export function permissionQuestion(query: string): boolean {
  const spelled = query.toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bcan't\b/g, 'can not').replace(/\bcannot\b/g, 'can not').replace(/\bwon't\b/g, 'will not')
    .replace(/\b(\p{L}+)n't\b/gu, '$1 not');
  const words = spelled.replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return false;
  // "can not i" / "could not we" ask what "can i" asks: the negation is the asker's doubt, not the action.
  const padded = ` ${words.replace(/\b(can|could|may|should|would|do) not (i|we)\b/g, '$1 $2')} `;
  if (PERMISSION_PHRASES.some(phrase => padded.includes(` ${phrase} `))) return true;
  const asks = query.trim().endsWith('?') || QUESTION_OPENINGS.test(words);
  return asks && !RECOLLECTION.test(words) && PERMISSION_WORDS.some(phrase => padded.includes(` ${phrase} `));
}

/**
 * How close in meaning the question is to each standing fact, by the embedding path notes are searched with: the
 * engine's provider, the same fact renderings and store the relevance signal reads (contextRelevance.ts), judged by the
 * same calibrated bar. Undefined (answer by words) when there is no provider or no bar, or the backend fails.
 */
export interface PermissionMeaning {
  similarity: Map<string, number>;
  bar: number;
}

function governanceCandidates(db: Database.Database, scope: string | undefined): CurrentFact[] {
  return findCurrentFacts(db, {
    terms: GOVERNANCE_PREDICATES,
    scope,
    match: 'any',
    limit: PERMISSION_RULE_CANDIDATES,
  }).filter(fact => isGovernancePredicate(fact.predicate)); // a note that says "decision" is not one (delta review P3)
}

/**
 * The standing facts' closeness in meaning to a permission question (`PermissionMeaning`). `queryVector` is the one
 * the read's search by meaning embedded, when it ran; otherwise the question is embedded here, through the same
 * provider.
 *
 * It runs only for an embedding model with a measured bar (CALIBRATED_BARS: today the Vertex model production runs),
 * and with that bar. An explicit RENOR_CONTEXT_RELEVANCE_MIN tunes the relevance signal; it is not a calibration for
 * this lookup, so any other embedder skips it and the standing facts are found by words alone (Batch 7 follow-up c).
 */
export async function permissionMeaning(
  db: Database.Database,
  engine: Pick<Engine, 'provider' | 'modelKey'>,
  query: string,
  scope: string | undefined,
  queryVector: ArrayLike<number> | undefined,
): Promise<PermissionMeaning | undefined> {
  const provider = engine.provider;
  const bar = engine.modelKey && engine.modelKey in CALIBRATED_BARS ? CALIBRATED_BARS[engine.modelKey] : null;
  if (!provider || bar === null || !permissionQuestion(query)) return undefined;
  try {
    const candidates = governanceCandidates(db, scope === undefined ? undefined : normalizeScope(scope));
    if (candidates.length === 0) return undefined;
    const vector = queryVector ?? (provider.embedQuery ? await provider.embedQuery(query) : (await provider.embed([query]))[0]);
    if (!vector) return undefined;
    const similarity = await similaritiesTo(provider, candidates.map(f => renderFactForRelevance(f.predicate, f.object ?? '')), vector);
    return similarity ? { similarity, bar } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The standing facts a permission question should be answered with, at most `PERMISSION_RULE_LIMIT`:
 *
 * 1. the ones close in meaning to the question (at or over the calibrated bar, `permissionMeaning`), closest first:
 *    a rule worded without any of the action's words ("Ship nothing until Rowan signs off" for "Can I deploy?");
 * 2. then the ones sharing a word with the question, ranked the way the word-found facts are (`scoreFactRelevance`:
 *    subject and predicate overlap, a length-damped object, the named-scope bonus), then newest. On a scoped read the
 *    scope's own name counts as one of the question's words: an agent scoped to project:renor asks "Can I add a
 *    section to the dashboard?", and the rule about Renor is about its question (delta review P2, 2026-10-09);
 * 3. when none of them share a word, the newest.
 *
 * Without a provider or a bar, or when the backend fails, the list is 2 and 3, as it was.
 */
function permissionFacts(db: Database.Database, query: string, scope: string | undefined, meaning?: PermissionMeaning): CurrentFact[] {
  const candidates = governanceCandidates(db, scope);
  if (candidates.length === 0) return [];
  const slug = scope?.includes(':') ? scope.slice(scope.indexOf(':') + 1) : scope;
  const asked = slug && slug !== 'global' && !query.toLowerCase().includes(slug.toLowerCase()) ? `${query} ${slug}` : query;
  const newestFirst = (a: CurrentFact, b: CurrentFact) => {
    if (a.validFrom !== b.validFrom) return a.validFrom < b.validFrom ? 1 : -1;
    return (b.eventId ?? '').localeCompare(a.eventId ?? '');
  };
  const close = meaning
    ? candidates
      .map(fact => ({ fact, similarity: meaning.similarity.get(renderFactForRelevance(fact.predicate, fact.object ?? '')) ?? -Infinity }))
      .filter(item => Math.round(item.similarity * 1000) / 1000 >= meaning.bar)
      .sort((a, b) => (Math.abs(b.similarity - a.similarity) > 1e-6 ? b.similarity - a.similarity : newestFirst(a.fact, b.fact)))
      .map(item => item.fact)
    : [];
  const scored = candidates
    .map(fact => ({ fact, score: scoreFactRelevance(fact, asked, scope) }))
    .sort((a, b) => (Math.abs(b.score - a.score) > 1e-4 ? b.score - a.score : newestFirst(a.fact, b.fact)));
  const related = scored.filter(item => item.score > 0);
  const byWords = (related.length > 0 ? related : scored).map(item => item.fact);
  const out: CurrentFact[] = [];
  for (const fact of [...close, ...byWords]) {
    if (out.length === PERMISSION_RULE_LIMIT) break;
    if (!out.includes(fact)) out.push(fact);
  }
  return out;
}

/**
 * The standing facts a permission question put ahead of the facts its words found, for this read: get_context caps a
 * long one that leads the page (`capFact`). Marked on the fact itself, so a word-found fact with a standing predicate
 * is not taken for one, and a fact the permission path put first is, whatever its predicate (delta review P3).
 */
const STANDING = new WeakSet<CurrentFact>();

/**
 * Current lifecycle facts for a query: the facts found by its words (`factQueryTerms`, and two neighbouring words
 * joined, so "time zone" finds a `timezone` key), ranked by query relevance and scope preference, then newest. A fact
 * that scores less than half as much as the best one is left out. With no query, the newest facts.
 *
 * A question about whether an action is allowed or needs approval is also about the standing rule or
 * decision that governs it, which its words do not name. Those facts are looked up through the term
 * index (`permissionFacts`) and put first, ahead of the facts the words found: the rule is the answer,
 * and the long other-lane facts that share the action's words used to fill the candidate window before
 * the rule was even ranked (2026-10-09). They are ranked by meaning where the embedding path can say, then by
 * relevance to the question, not by recency, deduped against the word-found facts, and capped.
 */
export function currentLifecycleFacts(
  db: Database.Database,
  query = '',
  scope?: string,
  limit = 12,
): AgentContextFact[] {
  return currentFactMatches(db, query, scope, limit).map(fact => toAgentFact(fact));
}

/** `currentLifecycleFacts` with each fact's ledger event, which get_context reads to list an event once. */
function currentFactMatches(db: Database.Database, query: string, scope: string | undefined, limit: number, meaning?: PermissionMeaning): CurrentFact[] {
  const scopeNorm = scope === undefined ? undefined : normalizeScope(scope);
  if (!query.trim()) return recentCurrentFacts(db, scopeNorm, limit);
  const found = findCurrentFacts(db, {
    terms: [...factQueryTerms(query), ...joinedWords(query)],
    scope: scopeNorm,
    match: 'any',
    limit: Math.max(limit * 3, 36),
  });
  const ranked = rankCandidateFacts(found, query, scopeNorm);
  if (!permissionQuestion(query)) return ranked.slice(0, limit);
  const standing = permissionFacts(db, query, scopeNorm, meaning);
  if (standing.length === 0) return ranked.slice(0, limit);
  const key = (fact: CurrentFact) => `${fact.scope ?? 'global'}\u0000${fact.subject}\u0000${fact.predicate}`;
  const seen = new Set(ranked.map(key));
  const prepended = standing.filter(fact => !seen.has(key(fact)));
  for (const fact of prepended) STANDING.add(fact);
  return [...prepended, ...ranked].slice(0, limit);
}

/**
 * Whether a name is on file for a read: a current fact or a note (its text, path or front matter) of the scope read has
 * its words. Read through the indexes the facts lane and search_text read, so a scoped read never consults another scope.
 */
export function nameOnFile(
  db: Database.Database,
  memoryDir: string,
  { scope, includeHistory = false, ledgerRelPath }: { scope?: string; includeHistory?: boolean; ledgerRelPath?: string } = {},
): (name: string) => boolean {
  return name => {
    const terms = atoms(name);
    if (terms.length === 0) return true; // nothing to look up is no evidence
    if (findCurrentFacts(db, { terms, scope, match: 'all', limit: 1 }).length > 0) return true;
    const keyword = engineSearchText(db, memoryDir, terms.join(' '), 1, scope, includeHistory, ledgerRelPath);
    return !keyword.ok || keyword.results.length > 0;
  };
}

/** Whether `hit` is the semantic hit the probe scored best, as it is listed. */
function isTopHit(top: RetrievalProbe['topHit'], hit: { notePath: string; headingPath?: string; text: string }): boolean {
  return top !== undefined && hit.notePath === top.notePath && (hit.headingPath ?? '') === (top.headingPath || '')
    && hit.text.trim() === top.text.trim();
}

/**
 * The places `top_k` leaves for facts on a page of `indexHits`: what the index's own hits do not fill, the leading
 * evidence summary aside (that one is outside top_k by the tool's own promise). Zero on a page top_k has already
 * filled, which is the only case in which a caller cannot list a fact it wants to.
 */
export function factLaneRoom(indexHits: ReadonlyArray<unknown>, limit: number): number {
  const lead = leadingSummaryHits(indexHits as ReadonlyArray<{ reason?: string }>);
  return Math.max(0, limit - (indexHits.length - lead));
}

export interface SearchVerdict {
  /** What to report, or undefined when there is no verdict: off, or nothing the signal could judge. */
  relevance?: ContextRelevance;
  /**
   * When `relevance.relevant` is true: the closest fact the verdict was judged on that `hits` do not hold, so a
   * caller lists it (withFactHits `also`) and the verdict stays honest. Which is the case whenever the fact lane is
   * the better one and the page does not already carry that fact — neither as a fact hit nor as its ledger event —
   * and the page has room for one more, which the caller says with `limit`.
   */
  listFact?: CurrentFact;
}

/**
 * search_memory's relevance (RENOR_CONTEXT_RELEVANCE, where armed): get_context's verdict over the same read. A
 * search adds no hit for the verdict, so "relevant" stands only when the hits hold the match it reports: the closest
 * returned note chunk, or the closest fact (as a fact hit or its ledger event). A relevant verdict whose fact the
 * hits do not hold is returned with that fact in `listFact` for the caller to list — the same rule get_context applies
 * to the fact its own verdict was judged on (`missed`), and for the same reason: the fact lane exists because the
 * ledger chunk behind a fact is boilerplate that does not rank (contextRelevance.ts), so on a workspace whose notes
 * out-rank that chunk — and whose full page leaves the facts lane no room — the fact was not going to be listed, and
 * withholding the verdict there left the agent with no way to tell "the answer is on file" from "cannot judge".
 * `limit` is the page's top_k, which decides that case: with room the caller lists the fact, and without it the
 * verdict names the fact itself (`relevance.fact`) rather than the page passing top_k. The chunk lane needs no such
 * rule: the probe's best chunk is the hit it was taken from, so it is always held.
 *
 * `hits` are the index's own hits, before the facts lane adds any: a fact the hits already carry is not named twice.
 */
export function searchRelevance(
  db: Database.Database,
  engine: Engine,
  memoryDir: string,
  read: { query: string; scope?: string; includeHistory?: boolean; ledgerRelPath?: string; env?: NodeJS.ProcessEnv },
  probe: RetrievalProbe,
  hits: Array<{ notePath: string; headingPath?: string; text: string }>,
  limit?: number,
): SearchVerdict {
  if (!contextRelevanceEnabled(read.env)) return {};
  const scope = read.scope === undefined ? undefined : normalizeScope(read.scope);
  const judged = assessQueryRelevance({
    db, engine, scope, probe, env: read.env,
    query: read.query, onFile: nameOnFile(db, memoryDir, { scope, includeHistory: read.includeHistory, ledgerRelPath: read.ledgerRelPath }),
  });
  if (!judged) return {};
  if (!judged.relevance.relevant) return { relevance: judged.relevance };
  const held = judged.matchedOn === 'chunk'
    ? hits.some(hit => isTopHit(probe.topHit, hit))
    : (() => {
      const event = judged.closestFact?.eventId?.toLowerCase();
      return event !== undefined && hits.some(hit => ledgerEventIds(hit).includes(event));
    })();
  if (held) return { relevance: judged.relevance };
  if (judged.matchedOn !== 'fact' || !judged.closestFact) return {};
  // A page top_k has already filled takes no more hits, so the fact cannot be listed; naming it is what keeps the
  // verdict honest without breaking the tool's own bound (factsLane `also`).
  if (limit !== undefined && factLaneRoom(hits, limit) === 0) {
    const { subject, predicate, object, scope: factScope } = judged.closestFact;
    return { relevance: { ...judged.relevance, fact: { subject, predicate, object, scope: normalizeScope(factScope) } } };
  }
  return { relevance: judged.relevance, listFact: judged.closestFact };
}

/** A note the import tool wrote (importing/hosted.ts: `Imported/<label>/…`), never one of the engine's own notes. */
const IMPORTED_PATH = /^Imported\//;

/**
 * A score as a reply lists it: six decimals, whatever else is on the page. Tools tell agents to judge hits by score, so the
 * rounding must not tie hits the ranking told apart: four decimals did (0.50004 and 0.50003 are both 0.5), six tie only
 * scores closer than 5e-7, and no pair on the 50 search_memory pages of the agent-workflow eval. A hit shows the same score on
 * every page.
 */
export function scoreForReply(score: number): number {
  return Math.round(score * 1e6) / 1e6;
}

/** A heading that only repeats the note's own name (a daily note's heading is its date) says nothing the path does not. */
export function headingForReply<T extends { notePath?: unknown; headingPath?: string }>(hit: T): T {
  if (typeof hit.notePath !== 'string' || !hit.headingPath) return hit;
  const file = hit.notePath.slice(hit.notePath.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  if (hit.headingPath !== file) return hit;
  const { headingPath: _headingPath, ...rest } = hit;
  return rest as T;
}

/** The fields normalizeMemory reads from a semantic or keyword hit: each one is checked before it is used. */
interface HitFields {
  text?: unknown;
  reason?: unknown;
  notePath?: unknown;
  headingPath?: unknown;
  score?: unknown;
  session_date?: unknown;
  author?: string | null;
}

function normalizeMemory(raw: unknown, fallbackReason: string, reader?: string): AgentContextMemory | null {
  if (!raw || typeof raw !== 'object') return null;
  const hit = raw as HitFields;
  if (typeof hit.text !== 'string' || !hit.text.trim()) return null;
  const reason = typeof hit.reason === 'string' ? hit.reason : fallbackReason;
  return {
    notePath: typeof hit.notePath === 'string' ? hit.notePath : '',
    ...(typeof hit.headingPath === 'string' && hit.headingPath ? { headingPath: hit.headingPath } : {}),
    text: hit.text,
    ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
    reason,
    ...(typeof hit.session_date === 'string' ? { session_date: hit.session_date } : {}),
    // A fact the retrieval named its author of (a fact an identity question reads) is marked as get_context's facts are.
    // A memory that is a ledger event is marked in buildAgentContext, which reads its event's author.
    ...(hit.author !== undefined ? authorMarker(hit.author, reader) : {}),
    // A statement the session expansion added sits in the same memories[] list as matched evidence, so the item says
    // in a field a reader reads that the query did not match it (adv hardening, report renor-adv-inj5-1011 proposal 3):
    // an explicit boolean, in the marker style the hive tools use for untrusted agent text (memory/whatsNew.ts). The
    // search lane is untouched, so a matched memory — and every search_memory hit — keeps the fields it had, byte for
    // byte. The marker's tokens are budget tokens like any other item's (applyBudget `cost`).
    ...(reason.split('+').includes(SESSION_EXPAND_REASON) ? { matched: false } : {}),
    ...(IMPORTED_PATH.test(String(hit.notePath ?? '')) ? { origin: 'import' as const } : {}),
    // A daily-log chunk an entry of which claims a reserved source (factMarkers.ts): marked here, before the budget counts it.
    ...(claimsReservedEntrySource(hit.notePath, hit.text) ? { untrusted: true as const } : {}),
  };
}

export const CONTEXT_LEAN_ITEMS_FLAG = 'RENOR_CONTEXT_LEAN_ITEMS';

/** get_context's lean memory items (RENOR_CONTEXT_LEAN_ITEMS): off by default, and the reply is then what it always was. */
export function contextLeanItemsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CONTEXT_LEAN_ITEMS_FLAG] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * A memory as the lean get_context lists it: its text as stored, the day it was written, and every marker it carries
 * (replaced, matched, origin, source, untrusted). The note path, heading, score and reason go: they cost about twice
 * the memory's own text (an item was about 107 tokens for 32 of text, docs/evals/results/agent-workflow-20261020), and
 * the reply is already in the order they decided. A daily entry's text keeps its own time and writer.
 */
export function leanMemory(memory: AgentContextMemory): Record<string, unknown> {
  const { notePath: _notePath, headingPath: _headingPath, text, score: _score, reason: _reason, session_date, ...markers } = memory;
  const day = session_date === undefined ? undefined : /^\d{4}-\d{2}-\d{2}/.exec(session_date)?.[0] ?? session_date;
  return { text, ...(day === undefined ? {} : { session_date: day }), ...markers };
}

/** The reasons of a memory the question's own words found (keyword search), as opposed to one found by meaning alone. */
const WORD_MATCH_REASONS = ['fts', 'note-identity'];

export function dedupeMemories(memories: AgentContextMemory[]): AgentContextMemory[] {
  const at = new Map<string, number>();
  const out: AgentContextMemory[] = [];
  for (const memory of memories) {
    const key = `${memory.notePath}\0${memory.headingPath ?? ''}\0${memory.text.trim()}`;
    const kept = at.get(key);
    if (kept === undefined) {
      at.set(key, out.length);
      out.push(memory);
    } else if (WORD_MATCH_REASONS.includes(memory.reason) && !out[kept].reason.split('+').includes(memory.reason)) {
      // The question's words found a memory that is already listed (by meaning, usually): the one copy keeps saying so,
      // where it used to be dropped without a trace, and a caller cannot otherwise tell "close in meaning" from "contains
      // what you asked for".
      out[kept] = { ...out[kept], reason: `${out[kept].reason}+${memory.reason}` };
    }
  }
  return out;
}

/**
 * The most of the budget facts take while memories are waiting; the memories get the rest, and the room they leave
 * goes back to the facts. Facts used to be added until the budget was spent, so a dozen facts that each shared one
 * word with the question cut the note that answered it.
 */
export const FACTS_BUDGET_SHARE = 0.4;

/**
 * The most of the budget the newest match above the relevance bar and the rest of its own session may take, before the
 * others are taken by score (applyBudget): the match itself, its other matches above the bar, and the statements the
 * session's retrieval expansion added. A session that said something newer about the question said it in more than one
 * chunk, and the one that holds the answer is often not its closest: with the reservation alone, a closer chunk of an older
 * session took the room and the later statement was cut. A quarter of the budget (the first value, PR 508) left a
 * budget of 800 tokens room for one big chunk of the session and no statement beside it; the practice questions were best
 * served at 0.6, and worse at 0.5 and 0.4 (docs/evals/results/NEWEST-FACT-POOL-20261011.md).
 */
export const NEWEST_SESSION_SHARE = 0.6;

/**
 * The most pieces of the newest session the reservation takes: the match, its other matches and its statements together.
 * They are taken by relevance per token, so the share above would otherwise be spent on as many small pieces as fit, and
 * four is what the 1,200-token budget holds beside the older evidence without losing a question the cut by score kept.
 */
export const NEWEST_SESSION_PIECES = 4;

/**
 * The fewest of the question's content words (`statementRelevance`) a statement of the newest session must hold to be
 * a candidate for its reservation. The reservation ranks its candidates by relevance squared per token, so a statement with
 * one shared word takes room only when nothing better fits; one with none is unmatched text and never takes it.
 */
export const NEWEST_SESSION_STATEMENT_FLOOR = 1;

/**
 * How much more a session statement weighs against a chunk of the same relevance. A statement is a short piece of what
 * the user said (the expansion cuts them at 100 tokens); a chunk is 250 to 500 tokens of the answer around it.
 */
export const NEWEST_SESSION_STATEMENT_WEIGHT = 2;

/**
 * The most statements that share a single word of the question the reservation takes. One shared word is a coincidence, and the
 * deciding statement can be one (a turn that says "I now have 5 of them" shares "bikes"), but a session of many short turns
 * about the same subject has several, and each weighs double and costs half a chunk: four of them took the room of the scored
 * chunk that held the answer (a held-out question about how many bikes a person owns, after the statement cap went to 120
 * tokens). A statement that shares two words, and every match retrieval scored, are not counted.
 */
export const NEWEST_SESSION_WEAK_STATEMENTS = 1;

export const CONTEXT_SPLIT_FLAG = 'RENOR_CONTEXT_SPLIT';

/**
 * How get_context splits its budget between facts, the newest session and the older evidence (RENOR_CONTEXT_SPLIT, off by
 * default; unset, or anything but `facts,recent,pieces`, gives the constants above). `facts` is the facts' share while memories
 * wait and `recent` the newest session's share, both in (0, 1]; `pieces` is the most pieces of that session, an integer from
 * 1 to 12. The older evidence takes what the two leave.
 */
export function budgetSplit(): { facts: number; recent: number; pieces: number } {
  const off = { facts: FACTS_BUDGET_SHARE, recent: NEWEST_SESSION_SHARE, pieces: NEWEST_SESSION_PIECES };
  const raw = process.env[CONTEXT_SPLIT_FLAG];
  if (!raw) return off;
  const [facts, recent, pieces] = raw.split(',').map(part => Number(part.trim()));
  const share = (n: number) => Number.isFinite(n) && n > 0 && n <= 1;
  return share(facts) && share(recent) && Number.isInteger(pieces) && pieces >= 1 && pieces <= 12 ? { facts, recent, pieces } : off;
}

/** The fewest of the question's content words the newest match above the bar must share with it (`newestMatchAbove`). */
export const NEWEST_ANCHOR_RELEVANCE_FLOOR = 1;

/** Tokens of a reply as the engine counts them: o200k, the chunker's tokenizer, special-token syntax read as text.
 *  The reply is escaped after fitting (jsonResult), so the budget counts what is actually sent: a memory
 *  rich in hidden characters must not push the reply past max_tokens once they become \uXXXX escapes. */
export function replyTokens(text: string): number {
  return encodeTokens(escapeInvisibleControls(text));
}

export type Item = AgentContextFact | AgentContextMemory;

interface Budgeted {
  facts: AgentContextFact[];
  memories: AgentContextMemory[];
  truncated: boolean;
  /** What the facts and memories kept cost, by `cost`. */
  tokens: number;
  /** The ledger events (lower case) of the facts the reply lists. */
  listed: ReadonlySet<string>;
}

/**
 * The order the matches are taken into a token budget in, as positions in `memories`: first the summary tables that lead
 * the list, when there are any (the evidence and digest tables, `leadingSummaryHits`: they sit outside any order), then the
 * matches retrieval scored, best score first, then the matches the words of the request found, as they are listed. A match
 * retrieval scored is one whose score is the one that picked the window (cosine plus its boosts), so those compare; keyword
 * matches are scored on other scales (WORD_MATCH_REASONS) and are not ranked with them. Equal scores keep their place in the
 * list, which makes the order the same on every call, and under "score" (a list already in score order) the order is the
 * list's own. What the session expansion added is no match and is not in it.
 *
 * The budget keeps the longest run of this order that fits (applyBudget), except that a top match too big for the whole budget is
 * passed over. The list is laid out newest first, and a budget that kept the longest run of the layout cut the oldest matches
 * first however close they were: retrieval ablations, 2026-10-06 (docs/evals/results/CUT-BY-SCORE-20261007.md, which also reads what the cut by score trades away).
 */
export function matchBudgetOrder(memories: ReadonlyArray<AgentContextMemory>): number[] {
  const leading = leadingSummaryHits(memories);
  const lead: number[] = [];
  const scored: number[] = [];
  const found: number[] = [];
  memories.forEach((memory, i) => {
    if (memory.reason === SESSION_EXPAND_REASON) return;
    if (i < leading) lead.push(i);
    else if (memory.reason.split('+').every(reason => WORD_MATCH_REASONS.includes(reason))) found.push(i);
    else scored.push(i);
  });
  // A score that is not a number ranks last among the scored matches, never first: it cannot displace a match.
  const score = (i: number): number => (Number.isFinite(memories[i].score) ? memories[i].score! : Number.NEGATIVE_INFINITY);
  scored.sort((a, b) => score(b) - score(a) || a - b);
  return [...lead, ...scored, ...found];
}

/**
 * The newest match above the relevance bar, as a position in `memories` (-1 when there is none): the match a cut by score
 * must not take the place of. A cut by score keeps the closest matches, and when two statements are about one thing it
 * cannot tell which is current; the newest one that is itself relevant (its raw cosine, `similarities`, is at least `bar`,
 * the bar the relevance signal judges by) is the one the reader needs last. A match that is not a semantic hit of this
 * read (a keyword match, a statement the expansion added) has no cosine and is never it, and neither is one with no date.
 * The newer date wins; of equal dates the earlier in the list, which is the better score.
 *
 * With the question (`query`), a match must also share NEWEST_ANCHOR_RELEVANCE_FLOOR of its content words to be it: the
 * cosine is a measure of meaning, and a newer session about something else (a fashion chat that answers a question about
 * a grocery list) can sit above the bar and would take the reservation, and the session's room, from the session
 * that answers. A question with no word to share (only numbers and single letters, `statementRelevance` counts neither) leaves the bar alone to decide.
 */
/** First similarity for each hit, keyed the way `isTopHit` compares a memory to a hit. */
function similarityByMemory(
  similarities: ReadonlyArray<{ notePath: string; headingPath?: string; text: string; similarity: number }>,
): (memory: { notePath: string; headingPath?: string; text: string }) => number | undefined {
  const byNote = new Map<string, Map<string, Map<string, number>>>();
  for (const hit of similarities) {
    const heading = hit.headingPath || '';
    const text = hit.text.trim();
    let byHeading = byNote.get(hit.notePath);
    if (!byHeading) byNote.set(hit.notePath, byHeading = new Map());
    let byText = byHeading.get(heading);
    if (!byText) byHeading.set(heading, byText = new Map());
    if (!byText.has(text)) byText.set(text, hit.similarity);
  }
  return memory => byNote.get(memory.notePath)?.get(memory.headingPath ?? '')?.get(memory.text.trim());
}

export function newestMatchAbove(
  memories: ReadonlyArray<AgentContextMemory>,
  similarities: ReadonlyArray<{ notePath: string; headingPath?: string; text: string; similarity: number }>,
  bar: number,
  query?: string,
): number {
  let newest = -1;
  let newestAt = Number.NEGATIVE_INFINITY;
  const asked = query === undefined ? 0 : questionTerms(query).length;
  // The cosine rules out almost every memory. Stemming a statement the cosine has already rejected cannot change the pick.
  const heardAt = similarityByMemory(similarities);
  memories.forEach((memory, i) => {
    if (memory.reason === SESSION_EXPAND_REASON || !memory.session_date) return;
    const heard = heardAt(memory);
    if (heard === undefined || !(heard >= bar)) return;
    if (asked > 0 && statementRelevance(memory.text, query!) < NEWEST_ANCHOR_RELEVANCE_FLOOR) return;
    const at = sessionDateMs(memory.session_date);
    if (at > newestAt) { newest = i; newestAt = at; }
  });
  return newest;
}

/** The session a match belongs to: its note and its date. A chat session is one note with one date; a ledger or a daily log holds one session per event or day. */
const sessionOf = (memory: AgentContextMemory): string => `${memory.notePath}\0${memory.session_date ?? ''}`;

/** The content words of a question: the ones a statement can share with it (`statementRelevance`). */
function questionTerms(query: string): string[] {
  return factQueryTerms(query).filter(term => term.length > 1 && !/^\p{Nd}+$/u.test(term));
}

/**
 * How many distinct content words of the question a text holds, as stems: how much a statement says about the
 * question that brought its session. The session expansion adds a statement without scoring it, and the budget that
 * keeps the newest session's statements can rarely keep all of them: the one that answers the question is usually
 * not the first the session said (a header, a turn about something else), so they are taken most relevant first.
 * A word of one letter or one made of digits alone never says what a statement is about — "I" is in every statement
 * of a chat, and "10 pounds" answers "how much" without the number being what a later question shares — so neither
 * is counted.
 */
/** Stems of a statement text. The text is the whole input, so a later write of a different statement is a different key. */
const STATEMENT_STEMS_MAX = 4096;
const statementStems = new Map<string, Set<string>>();
const TERM_STEMS_MAX = 1024;
const termStems = new Map<string, string[]>();
const QUESTION_TERMS_MAX = 64;
const questionTermCache = new Map<string, string[]>();

function cachedQuestionTerms(query: string): string[] {
  const held = questionTermCache.get(query);
  if (held) return held;
  const terms = questionTerms(query);
  if (questionTermCache.size >= QUESTION_TERMS_MAX) questionTermCache.delete(questionTermCache.keys().next().value as string);
  questionTermCache.set(query, terms);
  return terms;
}

function cachedTermStems(term: string): string[] {
  const held = termStems.get(term);
  if (held) return held;
  const stems = wordStems([term]);
  if (termStems.size >= TERM_STEMS_MAX) termStems.delete(termStems.keys().next().value as string);
  termStems.set(term, stems);
  return stems;
}

function cachedStatementStems(text: string): Set<string> {
  const held = statementStems.get(text);
  if (held) return held;
  const stems = new Set(wordStems(atoms(text)));
  if (statementStems.size >= STATEMENT_STEMS_MAX) statementStems.delete(statementStems.keys().next().value as string);
  statementStems.set(text, stems);
  return stems;
}

export function statementRelevance(text: string, query: string): number {
  const terms = cachedQuestionTerms(query);
  if (terms.length === 0) return 0;
  const stems = cachedStatementStems(text);
  let held = 0;
  for (const term of terms) if (cachedTermStems(term).some(stem => stems.has(stem))) held++;
  return held;
}

/**
 * The least of the question's content words a session statement must hold to be taken with the newest session's
 * reservation, before the matches are taken by score (applyBudget `sessionStatements`). One shared word is a
 * coincidence: a session header shares a date, a turn about something else shares a topic word, and the statement
 * that decides the answer sometimes shares none at all. Two is the least that says a statement is about the
 * question, so a statement below it keeps the expansion's own leftover room, in document order, which is where it
 * was. Measured on the LongMemEval held-out knowledge-update cases: every statement the reservation delivered held
 * two or more of the question's words, and the statements it displaced from other sessions held one or none.
 */
export const STATEMENT_RELEVANCE_FLOOR = 2;

/**
 * The statements of the session `memories[at]` belongs to, as positions in `memories`, ranked for the budget's
 * reservation: most relevant to the question first (`statementRelevance`), and only from STATEMENT_RELEVANCE_FLOOR, so
 * a statement the question shares fewer words with is a coincidence and keeps the expansion's own leftover room. Equal
 * relevance keeps the order of the list, which is document order inside the note. A session that said something newer
 * about the question said the deciding thing somewhere else, and the statement that holds it is usually not the first
 * the session said: a header, a turn about something else, the answer. `floor` is the fewest shared words a statement
 * needs: STATEMENT_RELEVANCE_FLOOR unless the caller ranks what it takes by relevance per token, as the budget's
 * reservation does (NEWEST_SESSION_STATEMENT_FLOOR).
 */
export function sessionStatementsFor(
  memories: ReadonlyArray<AgentContextMemory>,
  at: number,
  query: string,
  floor: number = STATEMENT_RELEVANCE_FLOOR,
): number[] {
  if (at < 0 || !query.trim()) return [];
  const session = sessionOf(memories[at]);
  return memories
    .map((memory, i) => ({ memory, i }))
    .filter(({ memory, i }) => i !== at && memory.reason === SESSION_EXPAND_REASON && sessionOf(memory) === session)
    .map(({ memory, i }) => ({ i, relevance: statementRelevance(memory.text, query) }))
    .filter(entry => entry.relevance >= floor)
    .sort((a, b) => b.relevance - a.relevance)
    .map(entry => entry.i);
}

/**
 * The other matches of the session `memories[at]` belongs to that are themselves above the relevance bar (as `newestMatchAbove`
 * counts), as positions in `memories`, in the order of the list: within a session that is best score first. What a session
 * said about the question is rarely one chunk, and the chunk that holds the answer is often not its closest.
 */
export function sessionMatesAbove(
  memories: ReadonlyArray<AgentContextMemory>,
  similarities: ReadonlyArray<{ notePath: string; headingPath?: string; text: string; similarity: number }>,
  bar: number,
  at: number,
): number[] {
  if (at < 0) return [];
  const session = sessionOf(memories[at]);
  const mates: number[] = [];
  memories.forEach((memory, i) => {
    if (i === at || memory.reason === SESSION_EXPAND_REASON || !memory.session_date || sessionOf(memory) !== session) return;
    const heard = similarities.find(hit => isTopHit(hit, memory));
    if (heard !== undefined && heard.similarity >= bar) mates.push(i);
  });
  return mates;
}

/**
 * The facts and memories that fit in `allowance` tokens, an item costing `cost(item)`. `factEvents[i]` is the ledger
 * event (lower case) fact i was saved by, and `memoryEvents[i]` the events memory i is (none for a note). A memory that
 * is the event of a fact the reply lists is not listed again: it said the same thing twice in one reply, about 600
 * characters each in the live workspace (dogfood, 2026-10-03, D8). It is no cut either.
 *
 * The facts are cut from their end. The matches are cut by score, not by date (`matchBudgetOrder`): the budget keeps the
 * longest run of them, best first, that fits, so of the matches retrieval scored one that is cut never scored above one
 * that is kept, unless it was the top match and too big for the whole budget (`keep`, `recent` and the summary tables that
 * lead apart, which are kept first). `recent`, the newest match
 * above the relevance bar, is reserved its room before the rest are taken by score: a cut by score alone keeps the closest
 * matches and drops the newest, and where the later statement decides the answer it is the newest that must win. The rest of
 * that match's own session is reserved with it, in at most NEWEST_SESSION_SHARE of the allowance and NEWEST_SESSION_PIECES pieces:
 * `mates`, its other matches above the bar (sessionMatesAbove), and `sessionStatements`, the statements the expansion added to
 * it (sessionStatementsFor). The statement that decides is often the session's second chunk or one of its short turns, not its
 * closest chunk, which a closer chunk of an older session used to outscore. The match and these pieces compete for that room
 * by `relevance` squared per token, a statement weighing NEWEST_SESSION_STATEMENT_WEIGHT times a chunk of the same relevance:
 * a session's long closest chunk then no longer takes the room of the short turns that say what was decided. One that does
 * not fit that room, or the allowance, is passed over for the next (the statements' total cost is capped at the reserved match's own
 * cost, PR #520, and after NEWEST_SESSION_WEAK_STATEMENTS statements that share
 * a single word of the question, the next such statement is passed over too), and when none of the session's matches is kept the
 * match itself is tried alone. The matches kept are listed in the order the list has (newest first under "session_date"), so
 * nothing a reader sees is reordered, and when every match fits the reply is the one it always was.
 *
 * `keep`, the match a relevant verdict reports, stays in its place, so the cut is made around it. It takes its room first when
 * there is no `recent`, it is a fact, or it is more relevant to the question than `recent` (`relevance`). Otherwise the reserved session,
 * which is newer and about the same thing, takes its room first and `keep` takes what is left: the verdict match of an
 * older session used to take the room of the newer statement that decides the answer, and the reply gave the old value. A
 * `keep` that then has no room is left out, and the reply does not claim it as its verdict (`assemble`). `closest`, a fact close in
 * meaning that the words of the request did not find, comes after every fact they found and takes only the room the rest
 * leaves, unless it is `keep`.
 *
 * A memory retrieval's session expansion added (reason SESSION_EXPAND_REASON) is no match: it is a short statement of a
 * note that matched. It takes only the room the facts and the matches leave, after both, so it never displaces one, and
 * is not counted in `truncated`, which says that a fact or a match was cut. The statements of the reserved session are the
 * exception: they are the rest of what that session said, so they are taken with its reservation (`sessionStatements`),
 * before the others are taken by score, in the room NEWEST_SESSION_SHARE names. (Laid out with its session, a statement
 * used to come before the keyword matches and take their place: docs/evals/results/SESSION-EXPAND-GET-CONTEXT-20261004.md.)
 */
export interface BudgetPlan {
  keep?: Item;
  closest?: { fact: AgentContextFact; event: string | null };
  recent?: Item;
  mates?: ReadonlyArray<Item>;
  sessionStatements?: ReadonlyArray<Item>;
  /** How much of the question a piece says (`statementRelevance`): ranks the reserved session's pieces and decides whether `keep` comes first. */
  relevance?: (item: Item) => number;
}

export function applyBudget(
  facts: AgentContextFact[],
  factEvents: ReadonlyArray<string | null>,
  memories: AgentContextMemory[],
  memoryEvents: ReadonlyArray<readonly string[]>,
  allowance: number,
  cost: (item: Item) => number,
  plan: BudgetPlan = {},
): Budgeted {
  const { keep, recent, relevance } = plan;
  // `keep` comes before the reserved session when nothing is reserved, when it is a fact, or when it says more about the question.
  const keepFirst = keep === undefined || recent === undefined || relevance === undefined || !memories.includes(keep as AgentContextMemory) || relevance(keep) > relevance(recent);
  const budgeted = budgetWith(keepFirst, facts, factEvents, memories, memoryEvents, allowance, cost, plan);
  if (keepFirst) return budgeted;
  // The reserved session came first, and the facts took the room before it: if neither the match the verdict was judged on
  // nor `recent` is in the reply, the verdict has nothing to stand on (`stands`) and the reply loses `relevance`. `keep`
  // then takes its room first, and the session takes what is left in the order it always did (`ordered`): the room a held match
  // leaves is too small to spend on a ranking by the words of the question.
  const reserved = memories.indexOf(recent as AgentContextMemory);
  const holdsRecent = budgeted.memories.includes(recent as AgentContextMemory)
    || (reserved >= 0 && memoryEvents[reserved].length > 0 && memoryEvents[reserved].every(id => budgeted.listed.has(id)));
  const holdsKeep = budgeted.memories.includes(keep as AgentContextMemory)
    || (memoryEvents[memories.indexOf(keep as AgentContextMemory)]?.length > 0 && memoryEvents[memories.indexOf(keep as AgentContextMemory)].every(id => budgeted.listed.has(id)));
  return holdsRecent || holdsKeep ? budgeted : budgetWith(true, facts, factEvents, memories, memoryEvents, allowance, cost, plan, true);
}

function budgetWith(
  keepFirst: boolean,
  facts: AgentContextFact[],
  factEvents: ReadonlyArray<string | null>,
  memories: AgentContextMemory[],
  memoryEvents: ReadonlyArray<readonly string[]>,
  allowance: number,
  cost: (item: Item) => number,
  { keep, closest, recent, mates = [], sessionStatements = [], relevance }: BudgetPlan = {},
  ordered = false,
): Budgeted {
  const added = (memory: number): boolean => memories[memory].reason === SESSION_EXPAND_REASON;
  const factShare = memories.some((_, i) => !added(i)) ? Math.floor(allowance * budgetSplit().facts) : allowance;
  let used = 0;
  let held: Item | undefined; // `keep`, once it has its room
  const fits = (item: Item, limit: number): boolean => {
    if (item === held) return true; // its room is taken
    if (used + cost(item) > limit) return false;
    used += cost(item);
    return true;
  };
  const listed = new Set<string>();
  const kept = new Set<number>(); // the memories listed, by position
  const repeats = (memory: number): boolean => memoryEvents[memory].length > 0 && memoryEvents[memory].every(id => listed.has(id));
  // A fact the reply lists: a memory that is its event is not listed again, and gives its room back.
  const list = (event: string | null) => {
    if (!event) return;
    listed.add(event);
    for (const memory of kept) {
      if (repeats(memory)) {
        kept.delete(memory);
        used -= cost(memories[memory]);
      }
    }
  };
  const placeKeep = () => {
    if (keep === undefined) return;
    const heldMemory = memories.indexOf(keep as AgentContextMemory);
    if (heldMemory >= 0 && kept.has(heldMemory)) held = keep; // the reservation took it, and its room is paid
    else if (fits(keep, allowance)) {
      held = keep;
      const heldFact = facts.indexOf(keep as AgentContextFact);
      if (heldFact >= 0) list(factEvents[heldFact]);
      else if (heldMemory >= 0) kept.add(heldMemory);
      else if (keep === closest?.fact) list(closest.event);
    }
  };
  if (keepFirst) placeKeep();
  // The top-ranked fact that the whole allowance cannot hold is delivered as a marked truncated prefix that fits
  // the room it has, not dropped: a long fact that is itself the answer is the one item the budget must not lose.
  // (The P2-1 cap is a crowding rule and never touches the top fact; this is the no-room case, where the choice is
  // a prefix or nothing.)
  let topFactCut = false;
  let top = facts;
  if (facts.length > 0 && used + cost(facts[0]) > allowance) {
    const first = facts[0];
    const object = first.object ?? '';
    const room = Math.max(1, allowance - used - (cost(first) - replyTokens(object)));
    top = [{ ...first, object: capFactObject(object, room) }, ...facts.slice(1)];
    topFactCut = true;
  }
  let keptFacts = 0;
  // The first fact is the best match, so it may take more than the facts' share.
  while (keptFacts < top.length && fits(top[keptFacts], keptFacts === 0 ? allowance : factShare)) list(factEvents[keptFacts++]);
  // The newest match above the relevance bar and the rest of its session take their room before the others are taken by score.
  // They are one pool, taken by relevance to the question squared per token (a statement weighing more), at most
  // NEWEST_SESSION_PIECES of them in at most NEWEST_SESSION_SHARE of the budget. One that does not fit that room, or the
  // allowance, is passed over for the next (it must not end the run), so a session's closest chunk can be too big for the budget
  // while what it said elsewhere still fits, and the statement that decides the answer is usually one of the small ones.
  const reserved = recent === undefined ? -1 : memories.indexOf(recent as AgentContextMemory);
  if (reserved >= 0) {
    const split = budgetSplit();
    const room = Math.floor(allowance * split.recent);
    const said = (item: Item): number => relevance?.(item) ?? 0;
    const weight = (item: Item): number => ((item as AgentContextMemory).reason === SESSION_EXPAND_REASON ? NEWEST_SESSION_STATEMENT_WEIGHT : 1);
    const value = (item: Item): number => (weight(item) * said(item) * said(item)) / Math.max(1, cost(item));
    // `ordered`: the match first, then its other matches, then the statements that share two words of the question, as listed.
    const pool = ordered
      ? [recent!, ...mates, ...sessionStatements.filter(statement => said(statement) >= STATEMENT_RELEVANCE_FLOOR)]
      : [recent!, ...mates, ...sessionStatements].sort((a, b) => value(b) - value(a));
    // A small match cannot buy a share of the budget in unmatched statements (PR #520): the statements together cost no more
    // than the match itself. The match need not fit, so a large matching chunk can still reserve a short deciding statement.
    const statementRoom = cost(memories[reserved]);
    let statementSpent = 0;
    let spent = 0;
    let taken = 0;
    let weakTaken = 0;
    for (const piece of pool) {
      if (taken >= (ordered ? Infinity : split.pieces)) break;
      const statement = (piece as AgentContextMemory).reason === SESSION_EXPAND_REASON;
      const weak = !ordered && statement && said(piece) < 2;
      if (weak && weakTaken >= NEWEST_SESSION_WEAK_STATEMENTS) continue;
      const i = memories.indexOf(piece as AgentContextMemory);
      if (ordered && piece === recent) { // the match itself is no part of the session's room
        if (i >= 0 && !kept.has(i) && !repeats(i) && fits(piece, allowance)) kept.add(i);
        continue;
      }
      if (i < 0 || kept.has(i) || repeats(i) || spent + cost(piece) > room || (statement && statementSpent + cost(piece) > statementRoom) || !fits(piece, allowance)) continue;
      spent += cost(piece);
      if (statement) statementSpent += cost(piece);
      taken++;
      if (weak) weakTaken++;
      kept.add(i);
    }
    // Nothing of the session's matches was taken: the match itself is tried alone, as the reservation always did.
    const sessionKept = [...kept].some(i => !added(i) && sessionOf(memories[i]) === sessionOf(memories[reserved]));
    if (!sessionKept && !repeats(reserved) && fits(memories[reserved], allowance)) kept.add(reserved);
  }
  if (!keepFirst) placeKeep();
  // A top-ranked match too big for the whole allowance is passed over, and then every later match that fits is taken, in score
  // order, as the top fact is cut (topFactCut). Before, one long note that topped a generic question (the report's "what does
  // ember need": 1,100 words above an 80-token note) emptied the reply at every budget that could not hold it. A top match that
  // fits the allowance is never passed over: while nothing is passed over, a later match that does not fit ends the run, so a
  // budget that holds the top match keeps the best matches (cut by score), not the next ones that happen to be small. The top
  // match is passed over only when it can never fit: a reply cut back from over budget must not swap it for a smaller one.
  const ranked = matchBudgetOrder(memories);
  const topMatch = ranked.find(i => !repeats(i) && !kept.has(i));
  let passedOver = false;
  for (const i of ranked) {
    if (repeats(i) || kept.has(i)) continue;
    if (fits(memories[i], allowance)) {
      kept.add(i);
      continue;
    }
    if (i === topMatch && cost(memories[i]) > allowance) passedOver = true;
    else if (!passedOver) break;
  }
  while (keptFacts < top.length && fits(top[keptFacts], allowance)) list(factEvents[keptFacts++]);
  // What the expansion added takes what the facts and the matches left, in the order it was laid out.
  for (let i = 0; i < memories.length; i++) {
    if (!added(i)) continue;
    if (!fits(memories[i], allowance)) break;
    kept.add(i);
  }
  const shownFacts = top.filter((fact, i) => i < keptFacts || fact === held);
  if (closest !== undefined && (closest.fact === held || (keptFacts === top.length && fits(closest.fact, allowance)))) {
    shownFacts.push(closest.fact);
    list(closest.event);
  }
  const shown = [...kept].sort((a, b) => a - b);
  return {
    facts: shownFacts,
    memories: shown.map(i => memories[i]),
    truncated: topFactCut || shownFacts.length < top.length + (closest === undefined ? 0 : 1) || memories.some((_, i) => !added(i) && !kept.has(i) && !repeats(i)),
    tokens: used,
    listed,
  };
}

/**
 * Client-safe note path: never leak a host path through a product surface
 * (the same rule the engine search tools follow). Paths inside the memory dir
 * render relative to it; anything else falls back to the basename.
 */
function clientSafePath(memoryDir: string, stored: string): string {
  const resolved = path.resolve(stored);
  const root = path.resolve(memoryDir);
  if (resolved === root || resolved.startsWith(root + path.sep)) {
    return path.relative(root, resolved) || stored;
  }
  return path.basename(stored);
}

/**
 * The most of max_tokens a correction listed for a replaced memory may take. A correction can be as long as a statement
 * (4,000 characters), and a long item the budget cannot fit stops the run of matches behind it (applyBudget), so a
 * correction the replacement brings into a reply is cut to this share, with the marker that says where to read the rest, as
 * a long fact is.
 */
const CORRECTION_SHARE = 0.3;

/**
 * The correction the budget works with in place of each one a replaced memory has: it takes the best score of the memories it
 * corrects, and as a match found only by its words it is ranked with the matches retrieval scored (reason "+replacement"),
 * so a correction that says it in other words than the memory it replaces is not cut before that memory. Returns the
 * corrections as they are budgeted, by the one they stand for, and the correction each replaced memory has.
 */
function bindCorrections(
  pairs: ReadonlyArray<ReplacementPair<AgentContextMemory>>,
  maxTokens: number,
): { bound: Map<AgentContextMemory, AgentContextMemory>; correctionOf: Map<AgentContextMemory, AgentContextMemory> } {
  const share = Math.max(32, Math.floor(maxTokens * CORRECTION_SHARE));
  const bound = new Map<AgentContextMemory, AgentContextMemory>();
  for (const { replaced, correction } of pairs) {
    let item = bound.get(correction);
    if (!item) {
      const wordsOnly = correction.reason.split('+').every(reason => WORD_MATCH_REASONS.includes(reason));
      item = {
        ...correction,
        ...(replyTokens(correction.text) > share ? { text: capFactObject(correction.text, share) } : {}),
        ...(wordsOnly ? { reason: `${correction.reason}+replacement` } : {}),
      };
    }
    const score = Math.max(item.score ?? Number.NEGATIVE_INFINITY, replaced.score ?? Number.NEGATIVE_INFINITY);
    bound.set(correction, Number.isFinite(score) ? { ...item, score } : item);
  }
  const correctionOf = new Map<AgentContextMemory, AgentContextMemory>();
  for (const { replaced, correction } of pairs) correctionOf.set(replaced, bound.get(correction)!);
  return { bound, correctionOf };
}

const sameMemory = (a: AgentContextMemory, b: AgentContextMemory): boolean =>
  a.notePath === b.notePath && (a.headingPath ?? '') === (b.headingPath ?? '') && a.text === b.text;

/**
 * A reply never lists a replaced memory before its correction, nor without it: each is moved to follow the correction, and
 * one whose correction the reply does not hold is left out (the reply says it cut something).
 */
function pinToCorrections(reply: Record<string, unknown>, correctionOf: Map<AgentContextMemory, AgentContextMemory>): void {
  let listed = reply.memories as AgentContextMemory[];
  const replacedOf = (memory: AgentContextMemory): AgentContextMemory | undefined =>
    memory.replaced === undefined ? undefined : [...correctionOf].find(([replaced]) => sameMemory(replaced, memory))?.[1];
  let cut = false;
  for (const memory of [...listed]) {
    const correction = replacedOf(memory);
    if (correction === undefined) continue;
    const at = listed.findIndex(other => other !== memory && sameMemory(other, correction));
    const from = listed.indexOf(memory);
    if (at < 0) {
      listed = listed.filter(other => other !== memory);
      cut = true;
    } else if (at > from) {
      listed = [...listed.slice(0, from), ...listed.slice(from + 1, at + 1), memory, ...listed.slice(at + 1)];
    }
  }
  reply.memories = listed;
  if (cut) reply.truncated = true;
}

/**
 * What the semantic search's notices (mvp/engine.ts: a failed search, a rebuild) say keyword search still does, and what
 * get_context says instead when its keyword index is missing too: the reply never claims it in one sentence and denies
 * it in the next.
 */
const KEYWORD_STILL_ANSWERS: ReadonlyArray<readonly [string, string]> = [
  ['the saved facts and keyword search do not need it and still answer.', 'the saved facts still answer.'],
  ['Keyword search works meanwhile.', 'The saved facts still answer.'],
];

export async function buildAgentContext(
  db: Database.Database,
  engine: Engine,
  memoryDir: string,
  options: AgentContextOptions = {},
) {
  const query = (options.query ?? '').trim();
  const scopeNorm = options.scope === undefined ? undefined : normalizeScope(options.scope);
  const maxTokens = Math.min(Math.max(options.maxTokens ?? 800, 128), replyCeiling(options.env ?? process.env));
  // Off performs no lookup and changes no reply byte. On, failure is deliberately fail-open: pinned rules are additive.
  let pinnedRules: ReturnType<typeof loadPinnedRules> = { rules: [], pendingRules: [], eventIds: new Set(), tokens: 0 };
  try { pinnedRules = loadPinnedRules(db, scopeNorm, options.reader, options.env ?? process.env, maxTokens); } catch { /* omit the field */ }

  let rankedBy: HitOrder | undefined;
  const memories: AgentContextMemory[] = [];
  // What retrieval's session expansion added is no match; it is budgeted after every match (see applyBudget).
  const added: AgentContextMemory[] = [];
  let unfinishedEvidence: { state: ProductEvidenceState; note: string } | undefined;
  let semanticAvailable = false;
  let keywordAvailable = false;
  let notice: string | undefined;
  // A search that could not run (not one that found nothing), named so an empty reply is never mistaken for an empty store.
  const degraded: string[] = [];
  let keywordFailed = false;
  const probe: RetrievalProbe = {};

  if (query) {
    // Preserve the uncapped get_context default; an explicit environment cap still wins.
    const semantic = await engineSearchMemory(db, engine, memoryDir, query, 8, scopeNorm, options.evidence, options.includeHistory === true, options.ledgerRelPath, probe, undefined, 0);
    semanticAvailable = semantic.ok;
    notice = semantic.notice; // semantic search is off while the embeddings are rebuilt, or the provider failed it: say so
    if (semantic.error === 'semantic-unavailable' && semantic.notice) degraded.push('semantic');
    if (semantic.ok) {
      rankedBy = semantic.rankedBy;
      for (const hit of semantic.hits) {
        const normalized = normalizeMemory(hit, 'semantic', options.reader);
        if (normalized) (normalized.reason === SESSION_EXPAND_REASON ? added : memories).push(normalized);
      }
    }
    // Bounded-wait evidence (RENOR_EVIDENCE_ASYNC) can answer before the table exists. get_context then says so in the
    // words search_memory uses; with the flag off neither reason occurs and the response is what it was.
    if (semantic.evidence?.reason === 'pending' || semantic.evidence?.reason === 'queue-full' || semantic.evidence?.reason === 'daily-cap') {
      const { state, note } = productEvidenceReport(semantic.evidence);
      unfinishedEvidence = { state, note };
    }

    // The variants find the same chunks of the ledger: each chunk is parsed once for this read.
    const ledgerRecords: LedgerRecordCache = new Map();
    inReadSnapshot(db, () => {
      const orAll = keywordOrAll();
      for (const variant of orAll ? [query.trim()] : keywordVariants(query)) {
        const keyword = engineSearchText(db, memoryDir, variant, 6, scopeNorm, options.includeHistory === true, options.ledgerRelPath, ledgerRecords, orAll ? keywordOrMatch(query) : undefined);
        keywordAvailable = keywordAvailable || keyword.ok;
        if (!keyword.ok) { keywordFailed = true; continue; }
        for (const hit of keyword.results) {
          const normalized = normalizeMemory(hit, 'fts', options.reader);
          if (normalized) memories.push(normalized);
        }
      }
    });
    if (keywordFailed && !keywordAvailable) {
      degraded.push('keyword');
      const semanticNotice = KEYWORD_STILL_ANSWERS.reduce((text, [claim, instead]) => text.replace(claim, instead), notice ?? '');
      notice = `${semanticNotice ? `${semanticNotice} ` : ''}Keyword search is unavailable: its index is missing, so nothing here was found by words.`;
    }
  }

  // A permission question also looks for the standing facts by meaning, through the embedding path the search above
  // used (and its query vector, when it ran), when that path is the calibrated (Vertex) model; otherwise, or when it
  // fails, by words alone (permissionMeaning).
  const meaning = query ? await permissionMeaning(db, engine, query, scopeNorm, probe.queryVector) : undefined;
  // Status facts ("PR 648 is not merged") past their freshness window are labelled, or left out (RENOR_STATUS_FRESHNESS, off by default).
  const freshness = statusFreshnessMode(options.env);
  const readAt = Date.now();
  const staleOf = (fact: CurrentFact): string | null => freshness === 'off' ? null : staleStatusOf(fact, readAt);
  // RENOR_OWN_SCOPE_FIRST: with no scope passed and a default project scope set, that scope's items lead other scopes'.
  const ownScope = scopeNorm === undefined ? ownScopeSlug(options.env, options.connectionScope) : null;
  const facts = ownScopeFirstFacts(inReadSnapshot(db, () => currentFactMatches(db, query, scopeNorm, query ? 12 : 20, meaning))
    .filter(fact => freshness !== 'hide' || staleOf(fact) === null), ownScope);
  markRetrieved(); // the matches and the facts are in hand: what follows builds the reply (callPhases.ts)

  // After the keyword matches, so a statement a keyword search also found is that match, not the added copy.
  const isLedger = ledgerNoteMatcher({ memoryDir, ledgerRelPath: options.ledgerRelPath ?? DEFAULT_LEDGER_REL });
  const deduplicated = ownScopeFirstMemories(dedupeMemories([...memories, ...added]), ownScope);
  // RENOR_CONTEXT_DISTINCT (off by default): a memory that repeats the reply's facts or another memory is not listed.
  const distinct = contextDistinctEnabled(options.env) ? distinctMemories(deduplicated, facts, isLedger) : deduplicated;
  // RENOR_CONTEXT_NEWER_FIRST (off by default): of two near-identical notes, the newer is listed first and the older is tagged `earlier`.
  const newerFirst = contextNewerFirstEnabled(options.env);
  const merged = newerFirst ? newerFirstMemories(distinct) : distinct;
  // A correction takes the best score of the memories it corrects and is cut to a share of the budget (`bindCorrections`), and
  // the reply keeps them in pairs: a replaced memory is never listed without its correction, nor before it, whatever the
  // budget cut and however the layout sorts (`pinToCorrections`, and `pinned` below). Awaited only when the workspace has a
  // replacement: without one the assembly below stays synchronous, as it always was.
  const pairs: Array<ReplacementPair<AgentContextMemory>> = [];
  const arranged = hasReplacements(memoryDir)
    ? await withReplacements({ db, memoryDir, ledgerRelPath: options.ledgerRelPath ?? DEFAULT_LEDGER_REL, indexOptions: {} }, merged, { pairs })
    : merged;
  const { bound, correctionOf: correctionOfRaw } = pairs.length > 0 ? bindCorrections(pairs, maxTokens) : { bound: new Map<AgentContextMemory, AgentContextMemory>(), correctionOf: new Map<AgentContextMemory, AgentContextMemory>() };
  const deduped = arranged.map(memory => bound.get(memory) ?? memory);
  const hasMemories = deduped.some(m => m.reason !== SESSION_EXPAND_REASON);

  // Relevance signal (RENOR_CONTEXT_RELEVANCE): absent when off. Judged before the budget, and the response holds the
  // match it reports. A fact close in meaning that the words of the request did not find ("Where am I based?" for
  // home_city) stands in when they found none; otherwise it follows the facts they found, in the room left, unless it is
  // that match: then, like a note chunk that is, the budget makes room for it.
  const judged = query && contextRelevanceEnabled(options.env)
    ? inReadSnapshot(db, () => assessQueryRelevance({
      db, engine, scope: scopeNorm, probe, env: options.env, components: options.relevanceComponents,
      query, onFile: nameOnFile(db, memoryDir, { scope: scopeNorm, includeHistory: options.includeHistory === true, ledgerRelPath: options.ledgerRelPath }),
    }))
    : null;
  const closestFact = judged?.closestFact;
  const unpinnedFacts = facts.filter(f => !f.eventId || !pinnedRules.eventIds.has(f.eventId.toLowerCase()));
  const shownFacts = unpinnedFacts.length === 0 && closestFact && (!closestFact.eventId || !pinnedRules.eventIds.has(closestFact.eventId.toLowerCase())) ? [closestFact] : unpinnedFacts;
  // The values another writer replaced that stay open against a shown fact (memory/writerConflicts.ts): a fact with one
  // carries its line, and a fact with none is shaped as it always was.
  const disputes = writerConflictLines(db, shownFacts.map(fact => fact.eventId));
  const shaped = (fact: CurrentFact): AgentContextFact => {
    const base = toAgentFact(fact, options.reader);
    const line = fact.eventId === null ? undefined : disputes.get(fact.eventId);
    const stale = staleOf(fact);
    const marked = stale === null ? base : { ...base, staleStatus: stale };
    return line === undefined ? marked : { ...marked, writerConflict: line };
  };
  const factLaneBudget = hasMemories ? Math.floor(maxTokens * budgetSplit().facts) : maxTokens;
  const maxFactObjectTokens = Math.max(32, Math.floor(factLaneBudget * MAX_FACT_OBJECT_LANE_SHARE));
  // The cap is a crowding rule: it applies only when the facts would not otherwise fit the lane, and never to the
  // top-ranked fact — a long fact that is itself the answer is delivered whole when the lane has room for it.
  const factCost = (fact: CurrentFact): number => replyTokens(JSON.stringify(shaped(fact))) + 1;
  const crowding = shownFacts.reduce((sum, fact) => sum + factCost(fact), 0) > factLaneBudget;
  let factObjectCut = false;
  const capFact = (fact: CurrentFact, index: number): AgentContextFact => {
    const object = fact.object ?? '';
    // A standing rule the permission lookup put first leads the page, but it is not necessarily the answer to the
    // action: a long one must not eat the lane and displace the fact the question's words found. So it is capped like
    // any non-top fact when another fact shares the page (review P3, 2026-10-09); a lone governance fact is whole.
    const leads = index === 0 && shownFacts.length > 1 && STANDING.has(fact);
    if ((crowding && index > 0 || leads) && replyTokens(object) > maxFactObjectTokens) {
      factObjectCut = true;
      return { ...shaped(fact), object: capFactObject(object, maxFactObjectTokens) };
    }
    return shaped(fact);
  };
  // The closest fact is the top-ranked one when the words found none (shownFacts is [closestFact]); otherwise it
  // follows the facts they found and is capped with them when the lane is crowded.
  const closestIndex = closestFact === undefined ? -1 : shownFacts.indexOf(closestFact);
  const closest = closestFact ? capFact(closestFact, closestIndex >= 0 ? closestIndex : shownFacts.length) : undefined;
  const isClosest = (fact: AgentContextFact) => closest !== undefined && fact.subject === closest.subject
    && fact.predicate === closest.predicate && fact.scope === closest.scope && fact.validFrom === closest.validFrom
    && objectIs(closest.object, fact.object);
  // A memory of the ledger names no note and no heading (retrieval/ledgerPresentation.ts); the event in its heading is
  // read first, so that a memory that is the event of a listed fact is not listed again. Its heading alone: its text is
  // the user's words now, which may hold a line that looks like a record's heading.
  const candidateFacts = shownFacts.map((fact, index) => capFact(fact, index));
  const factEvents = shownFacts.map(fact => fact.eventId?.toLowerCase() ?? null);
  // The agent-facing text: hidden spans labelled (hiddenSpans.ts). It is taken after every judgment above, which compares
  // the raw text (isTopHit), and before the budget, which counts what the reply will carry.
  // A ledger event that is a saved fact says who saved it, as get_context's facts do: its author is read from the fact.
  const eventAuthors = factAuthorsByEvent(db, deduped.flatMap(memory => (isLedger(memory.notePath) ? ledgerEventIds(memory) : [])));
  const candidateMemories = deduped.map(memory => {
    if (!isLedger(memory.notePath)) return labelMemoryText(memory);
    const plain = normalizeMemory({ ...memory, notePath: '', headingPath: '' }, memory.reason)!;
    return labelMemoryText({ ...plain, ...eventMarker(ledgerEventIds(memory), eventAuthors, options.reader) });
  });
  // The dated outline (RENOR_DATED_OUTLINE, off by default): the pool is read here, the block is built last (below), from
  // the room the finished reply leaves, so it never takes a place from a fact or memory. Off performs no lookup and changes
  // no reply byte. On, failure is fail-open: the block is additive, so an error omits it. A read the relevance verdict calls
  // unrelated gets none ("nothing on file closely matches" and a page of dated notes would contradict each other).
  let outlinePool: OutlineCandidate[] = [];
  const outlineEnv = options.env ?? process.env;
  const outlineBudget = query && datedOutlineEnabled(outlineEnv) && judged?.relevance.relevant !== false
    ? datedOutlineBudget(Math.max(0, maxTokens - pinnedRules.tokens), outlineEnv)
    : 0;
  if (outlineBudget > 0) {
    try {
      outlinePool = inReadSnapshot(db, () => listOutlineCandidates(db, memoryDir, scopeNorm));
      outlinePool = await withoutReplaced(
        { db, memoryDir, ledgerRelPath: options.ledgerRelPath ?? DEFAULT_LEDGER_REL, indexOptions: {} },
        outlinePool,
      );
    } catch { outlinePool = []; }
  }
  // The pairs were made on the memories as retrieved; the budget and the reply hold the labelled copies, so the pairs are
  // re-keyed to those (a memory with hidden text is a new object with different text).
  const listedAs = new Map(deduped.map((memory, i) => [memory, candidateMemories[i]] as const));
  const correctionOf = new Map([...correctionOfRaw].map(([replaced, correction]) =>
    [listedAs.get(replaced) ?? replaced, listedAs.get(correction) ?? correction] as const));
  const memoryEvents = deduped.map(memory => (isLedger(memory.notePath) ? ledgerEventIds({ text: '', headingPath: memory.headingPath }) : []));
  const missed = closest !== undefined && !candidateFacts.some(isClosest)
    ? { fact: closest, event: closestFact?.eventId?.toLowerCase() ?? null }
    : undefined;
  // The match the verdict reports: the closest fact, or the note chunk the semantic search scored best. The probe records
  // that chunk with the paths the memories have before the ledger's are taken off, so it is found among those.
  const topMemory = judged?.matchedOn === 'chunk' ? deduped.findIndex(memory => isTopHit(probe.topHit, memory)) : -1;
  const match: Item | undefined = judged?.matchedOn === 'fact'
    ? candidateFacts.find(isClosest) ?? missed?.fact
    : topMemory >= 0
      ? candidateMemories[topMemory]
      : undefined;
  // The newest match above the relevance bar keeps its place in the budget (applyBudget `recent`), where the layout is by
  // date (a read about the past is laid out by score and asks for the older statement) and the model has a bar to judge by,
  // and so does the rest of its session that is above the bar, in NEWEST_SESSION_SHARE of the budget (`mates`), and so do the statements
  // its expansion added to that session (`sessionStatementsFor` ranks them): the session said the deciding thing somewhere
  // else, and a statement is not scored, so the words of the question rank it.
  const bar = resolveRelevanceBar(engine.modelKey, options.env);
  const newest = rankedBy === 'session_date' && bar !== null ? newestMatchAbove(deduped, probe.similarities ?? [], bar, query) : -1;
  const recent: Item | undefined = newest >= 0 ? candidateMemories[newest] : undefined;
  const mates = bar === null ? [] : sessionMatesAbove(deduped, probe.similarities ?? [], bar, newest).map(i => candidateMemories[i]);
  const sessionStatements = sessionStatementsFor(deduped, newest, query, NEWEST_SESSION_STATEMENT_FLOOR).map(i => candidateMemories[i]);
  // Whether the reply `kept` holds it: listed, or a memory that is the event of a fact it lists (that one is said once).
  // A fact the budget truncated to a prefix is still the match it was: same key, and its object is the prefix of the
  // candidate's (`objectIs` reads that direction), so the verdict a truncated top fact answers is still reported.
  const holds = (kept: Budgeted): boolean => match !== undefined && (
    kept.facts.some(f => f === match || (f.subject === (match as AgentContextFact).subject
      && f.predicate === (match as AgentContextFact).predicate
      && f.scope === (match as AgentContextFact).scope
      && f.validFrom === (match as AgentContextFact).validFrom
      && objectIs(f.object, (match as AgentContextFact).object)))
    || kept.memories.includes(match as AgentContextMemory)
    || (topMemory >= 0 && match === candidateMemories[topMemory] && memoryEvents[topMemory].length > 0
      && memoryEvents[topMemory].every(id => kept.listed.has(id)))
  );
  // The verdict stands when the reply holds its match, or, for a note chunk, the newest match above the same bar that the
  // budget reserved in its place (`recent`): the reply then holds a match as relevant as the one the verdict judged, and the
  // verdict reports no more than that (`relevant`, the closest cosine and the bar). A fact the verdict names stays strict.
  const stands = (kept: Budgeted): boolean => holds(kept) || (topMemory >= 0 && recent !== undefined
    && (kept.memories.includes(recent as AgentContextMemory) || (memoryEvents[newest].length > 0 && memoryEvents[newest].every(id => kept.listed.has(id)))));
  const retrieval = !query
    ? 'facts'
    : semanticAvailable && keywordAvailable
      ? 'hybrid'
      : semanticAvailable
        ? 'semantic'
        : keywordAvailable
          ? 'keyword'
          : 'facts';
  const trailer = (options.trailer && inReadSnapshot(db, options.trailer)) ?? {};
  // The facts this read could list: the ones its words found, and the closest one when they did not find it.
  const named = missed ? [...candidateFacts, missed.fact] : candidateFacts;

  // The opt-in read-honesty lane (LANE 3, RENOR_READ_HONESTY, off by default), set up once per read when it is armed.
  const honestyLane = readHonestyEnabled(options.env) && Boolean(query);
  // Lean memory items (RENOR_CONTEXT_LEAN_ITEMS, off by default): each memory is costed, and the reply measured, as it is
  // listed (leanMemory), so the same max_tokens holds more of them. The read-honesty lane lists provenance on every item,
  // so it keeps its own items.
  const lean = !honestyLane && contextLeanItemsEnabled(options.env);
  const listedTokens = (body: Record<string, unknown>): number => replyTokens(JSON.stringify(
    lean ? { ...body, memories: (body.memories as AgentContextMemory[]).map(leanMemory) } : body,
  ));
  const ledgerRel = options.ledgerRelPath ?? DEFAULT_LEDGER_REL;
  // Each item the lane lists says where it came from and when it was last verified. A fact get_context lists is a
  // lifecycle fact (memory/factTerms.ts reads `source_path = '_mcp_'` only), so the ledger is its source.
  const factWithProvenance = (f: AgentContextFact): AgentContextFact => ({ ...f, provenance: factProvenance(f.validFrom, ledgerRel) });
  const memoryWithProvenance = (m: AgentContextMemory): AgentContextMemory & { provenance: Provenance } => ({
    ...m,
    provenance: noteProvenance(m.notePath, m.session_date ?? null),
  });
  // Conflicts are about the product's OWN stored facts, so their source paths are rendered client-safe too: a product
  // surface never leaks a host path (the same rule engineSearchMemory follows). A conflict across scopes is built again
  // from its rendered sides.
  const safe = (side: ConflictSide): ConflictSide => ({ ...side, source: clientSafePath(memoryDir, side.source) });
  const clientSafe = (c: FactConflict): FactConflict => (acrossScopes(c)
    ? conflictAcrossScopes(c.subject, c.predicate, [c.newer, c.older, ...(c.alsoCurrent ?? [])].map(safe), c.total)
    : {
      ...c,
      newer: { ...c.newer, source: clientSafePath(memoryDir, c.newer.source) },
      older: { ...c.older, source: clientSafePath(memoryDir, c.older.source) },
      statement: c.statement
        .split(c.newer.source).join(clientSafePath(memoryDir, c.newer.source))
        .split(c.older.source).join(clientSafePath(memoryDir, c.older.source)),
    });
  // The lane's contradictions for a reply listing `listed`: about what those facts say, in any scope the read sees, and
  // inside one scope about their subjects and the subjects the query names. Read once per list.
  let lastRead: { listed: AgentContextFact[]; found: FactConflict[] } | undefined;
  const contradictions = (listed: AgentContextFact[]): FactConflict[] => {
    if (lastRead?.listed !== listed) {
      const { conflicts } = applyReadHonesty({
        db, query, ledgerRelPath: ledgerRel, scope: scopeNorm, subjects: listed.map(f => f.subject), facts: listed, texts: [], env: options.env,
      });
      lastRead = { listed, found: conflicts.map(clientSafe) };
    }
    return lastRead.found;
  };
  const about = (fact: { subject: string; predicate: string }, conflict: FactConflict) =>
    questionKey(fact.subject, fact.predicate) === questionKey(conflict.subject, conflict.predicate);
  // What the lane judges is the read, not the reply: everything it could list, the facts it found and the memories a
  // reply listing all of them would list. "No good answer on file for this" is a claim about the store, so it is the
  // same at every max_tokens: a reply the budget cut down to one fact, or to none, does not get to make it while the
  // store covers the question, and a contradiction the read could name stands it down, as in applyReadHonesty.
  const judgedRead = honestyLane ? (() => {
    const factEventIds = new Set([...factEvents, missed?.event ?? null].filter((id): id is string => id !== null));
    const listable = candidateMemories.filter((_, i) => !(memoryEvents[i].length > 0 && memoryEvents[i].every(id => factEventIds.has(id))));
    return applyReadHonesty({
      db,
      query,
      ledgerRelPath: ledgerRel,
      scope: scopeNorm,
      subjects: named.map(f => f.subject),
      facts: named,
      texts: [...named.map(f => `${f.subject} ${f.predicate} ${f.object}`), ...listable.map(m => m.text)],
      considered: named.length + listable.length,
      env: options.env,
    });
  })() : undefined;

  // A conflict-free superset cannot gain a conflict when facts are cut from it. Keep
  // that proof only for this synchronous assembly and the same committed DB contents.
  const conflictStamp = (): string | null => db.inTransaction ? null :
    `${prepareOnce(db, 'PRAGMA data_version').pluck().get()}:${prepareOnce(db, 'SELECT total_changes()').pluck().get()}`;
  let emptyConflictsAt: string | null = null;

  // The reply for the facts and memories `kept`. `relevant: true` reports its closest match, so it stands only when the
  // reply holds it (the match can be too big for max_tokens on its own); "not relevant" is about everything on file,
  // whatever is shown.
  const assemble = (
    kept: Budgeted,
    verdict = judged && (!judged.relevance.relevant || stands(kept)) ? judged.relevance : undefined,
  ): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      ok: true,
      query: query || null,
      scope: scopeNorm ?? 'all',
      retrieval,
      facts: kept.facts,
      ...(pinnedRules.rules.length > 0 ? { pinned_rules_note: ruleApprovalsEnabled(options.env ?? process.env) ? APPROVED_RULES_NOTE : PINNED_RULES_NOTE, pinned_rules: pinnedRules.rules } : {}),
      ...(pinnedRules.pendingRules.length > 0 ? { pending_rule_notes: pinnedRules.pendingRules } : {}),
      // The order of the semantic memories (keyword matches, reason "fts" or "note-identity", follow them). Named
      // right above the list it describes: memories[0] is the newest match under "session_date", not the best one.
      ...(rankedBy ? { rankedBy } : {}),
      memories: kept.memories,
      // A fact object the lane cut is a cut the reply says it made, whatever the budget did: the agent reads the
      // rest of that fact with read_memory or lookup_entity (the object itself carries TRUNCATION_MARKER).
      truncated: kept.truncated || factObjectCut,
      maxTokens,
      ...(notice ? { notice } : {}),
      ...(degraded.length > 0 ? { degraded } : {}),
    };

    if (verdict) body.relevance = verdict;

    // Multi-agent drift (memory/factConflicts.ts): a returned fact whose predicate has another current value under the
    // same subject in another scope, or under a related name, is named with those values. Absent when nothing
    // disagrees; within the read's scope only, so a scoped read never learns what another scope holds. Counted in
    // max_tokens with the fact that names it. The opt-in read-honesty lane below replaces it with its own `conflicts`
    // when armed.
    const conflicts = kept.facts.length > 0 && emptyConflictsAt !== null && emptyConflictsAt === conflictStamp()
      ? [] : namedConflicts(db, kept.facts, scopeNorm ?? null, options.reader);
    if (conflicts.length > 0) body.conflicts = conflicts;

    // LANE 3 read-time honesty (RENOR_READ_HONESTY, default OFF). When off, the
    // response is byte-identical to the shipped contract — no new fields, no new
    // queries. When on: every item says where it came from and when it was last
    // verified, contradictions between current facts are named instead of
    // silently returned as compatible, and a question the stored evidence does
    // not cover gets an explicit "no good answer on file for this".
    if (honestyLane) {
      const listed = body.facts as AgentContextFact[];
      body.facts = listed.map(factWithProvenance);
      body.memories = kept.memories.map(memoryWithProvenance);
      body.provenance = {
        ledger: ledgerRel,
        note: 'lifecycle facts are ledger-backed; note items are sourced from the note path shown on each item.',
      };
      // A contradiction about what a listed fact says is in the reply with it, at its least (#331's cut, readHonesty.ts
      // fitConflicts): the two values that disagree, and how many there are. The fact was charged that much (below), so
      // the two are inside max_tokens together or neither is. The lane's other contradictions, and more sides of these,
      // take the room the items leave (`withLane`, below).
      body.conflicts = fitConflicts(contradictions(listed).filter(c => listed.some(f => about(f, c))), 0);
      body.abstention = judgedRead!.abstention;
    }

    if (unfinishedEvidence) body.evidence = unfinishedEvidence;
    return Object.assign(body, trailer);
  };

  // The whole reply is bounded by max_tokens, as the engine counts tokens (replyTokens): the echoed query, `relevance`,
  // `conflicts` and every other field count, not the facts and memories alone (live dogfood, 2026-10-03, D9: 19 of 31
  // replies were over, by up to 1.89 times). The items get what the rest of an empty reply leaves, a fact costing the
  // conflicts it is the first to name as well (it brings them into the reply). The reply they make is then measured
  // whole, and while it is over (by how separately counted pieces join), the items get that much less. Each round
  // keeps fewer tokens of items, so it ends; a reply whose fixed part alone is over (an echoed query longer than the
  // budget) holds no fact and no memory.
  //
  // The opt-in read-honesty lane (RENOR_READ_HONESTY, off by default) reads under the same bound, and what a budget cuts
  // is the least of what it says. Its items are counted as it lists them, with their provenance. A fact is charged the
  // contradiction about what it says at its least, the two values that disagree and how many there are, so the two are
  // inside max_tokens together or neither is. What else the lane can add takes the room the items leave (`withLane`).
  // A fact is charged the contradiction it names by its key (subject/predicate/scope), not its object: a fact the budget
  // truncated to a prefix is a new object, and it must carry the same charge as the candidate it was cut from, so a kept
  // fact and the contradiction it brings are still in the reply together or neither is.
  const bringsKey = (item: Item): string => 'predicate' in item ? `${item.subject}\u0000${item.predicate}\u0000${item.scope ?? 'global'}` : '';
  const brings = new Map<string, number>();
  if (!honestyLane) { // that lane names its own contradictions instead
    const beforeConflicts = named.length > 0 ? conflictStamp() : null;
    const allConflicts = namedConflicts(db, named, scopeNorm ?? null, options.reader);
    if (allConflicts.length === 0) emptyConflictsAt = beforeConflicts;
    for (const conflict of allConflicts) {
      const first = named.find(f => f.predicate === conflict.predicate
        && conflict.values.some(v => v.subject === f.subject && objectIs(f.object, v.object) && v.scope === f.scope))
        ?? named.find(f => f.predicate === conflict.predicate);
      if (first) brings.set(bringsKey(first), (brings.get(bringsKey(first)) ?? 0) + replyTokens(JSON.stringify(conflict)) + 1);
    }
  } else {
    // Over every fact the read could list, so the charge does not move as the list is cut; the first fact that says what
    // a contradiction is about pays for it, as the reply renders it (and, like the lane's items, without a comma).
    for (const conflict of judgedRead!.conflicts.map(clientSafe)) {
      const first = named.find(f => about(f, conflict));
      if (first) brings.set(bringsKey(first), (brings.get(bringsKey(first)) ?? 0) + replyTokens(JSON.stringify(fitConflicts([conflict], 0)[0])));
    }
  }
  const costs = new Map<Item, number>();
  const cost = (item: Item): number => {
    let size = costs.get(item);
    if (size === undefined) {
      // Counted alone and with its comma, an item is a token or two over what it adds to the reply (`},{"` is one token
      // there): the items rarely add up to more than the reply they make, so a reply is rarely cut a second time. The
      // read-honesty lane counts an item as it lists it, with its provenance, and without the comma: what it adds to the
      // reply, so a fact and the contradiction it brings are listed from the least max_tokens that holds them.
      size = honestyLane
        ? replyTokens(JSON.stringify('predicate' in item ? factWithProvenance(item) : memoryWithProvenance(item))) + (brings.get(bringsKey(item)) ?? 0)
        : replyTokens(JSON.stringify(lean && !('predicate' in item) ? leanMemory(item) : item)) + 1 + (brings.get(bringsKey(item)) ?? 0);
      costs.set(item, size);
    }
    return size;
  };
  // With the lane armed, what the session expansion added (reason SESSION_EXPAND_REASON) is not budgeted with the items.
  // The lane lists the whole reply when it fits, and its contradictions take the room the items leave; counted as items,
  // the statements made too big a whole reply that fit without them (the cut that followed listed one fact of three), and
  // took a contradiction's room. So the lane budgets what it budgets with the expansion off, and the statements take the
  // room its whole reply leaves (`withLane`).
  const statement = (memory: number) => honestyLane && candidateMemories[memory].reason === SESSION_EXPAND_REASON;
  const itemMemories = candidateMemories.filter((_, i) => !statement(i));
  const itemEvents = memoryEvents.filter((_, i) => !statement(i));
  const statements = candidateMemories.filter((_, i) => statement(i)).map(memoryWithProvenance);
  // The facts are cut from their end and the matches by score, but the match the verdict reports takes its room first when
  // that would not list it, and so does the newest match above the relevance bar (`recent`) when it fits.
  const budget = (allowance: number): Budgeted => {
    const place = (keep?: Item) => pinned(applyBudget(candidateFacts, factEvents, itemMemories, itemEvents, allowance, cost, { keep, closest: missed, recent, mates, sessionStatements, relevance: item => ('text' in item ? statementRelevance(item.text, query) : 0) }), allowance);
    const plain = place();
    return match !== undefined && !holds(plain) ? place(match) : plain;
  };
  // A replaced memory the budget kept has its correction kept with it: the correction is added when the allowance holds it, and
  // when it does not the replaced memory is the one left out (the reply says it cut something).
  const pinned = (kept: Budgeted, allowance: number): Budgeted => {
    if (correctionOf.size === 0) return kept;
    let memories = kept.memories;
    let tokens = kept.tokens;
    let truncated = kept.truncated;
    for (const memory of kept.memories) {
      const correction = correctionOf.get(memory);
      if (correction === undefined || memories.includes(correction)) continue;
      if (tokens + cost(correction) <= allowance) {
        memories = [...memories, correction];
        tokens += cost(correction);
      } else {
        memories = memories.filter(other => other !== memory);
        tokens -= cost(memory);
        truncated = true;
      }
    }
    if (memories === kept.memories) return kept;
    return { ...kept, memories: itemMemories.filter(memory => memories.includes(memory)), tokens, truncated };
  };
  // What the read-honesty lane adds in the room the items leave, measured whole, so it never costs the reply an item: its
  // contradictions that no listed fact brings (inside one scope, about a subject the query names), at their least and in
  // their order while the reply holds them, cut from their end like any list; then more sides of each contradiction
  // across scopes, first contradiction first, which `total` counts while they are not named (readHonesty.ts
  // fitConflicts). A contradiction the reply cannot hold is not named, and the reply says it was cut.
  const withLane = (kept: Budgeted, body: Record<string, unknown>): Record<string, unknown> => {
    const fits = (reply: Record<string, unknown>) => replyTokens(JSON.stringify(reply)) <= maxTokens;
    const found = contradictions(kept.facts);
    const least = fitConflicts(found, 0);
    const take = found.map(c => kept.facts.some(f => about(f, c))); // in the reply already: their facts paid for them
    for (let i = 0; i < found.length; i++) {
      if (take[i]) continue;
      take[i] = true;
      if (!fits({ ...body, conflicts: least.filter((_, j) => take[j]) })) {
        take[i] = false;
        break;
      }
    }
    const shown = fitConflicts(found.filter((_, i) => take[i]), conflicts => fits({ ...body, conflicts }));
    const reply: Record<string, unknown> = { ...body, conflicts: shown };
    if (shown.length < found.length) reply.truncated = true;
    // Then what the session expansion added, after every match in the order it was laid out, while the whole reply holds
    // it: the room the reply leaves with the expansion off. As in the default lane (applyBudget), `truncated` does not
    // count it.
    for (const memory of statements) {
      const memories = [...(reply.memories as AgentContextMemory[]), memory];
      if (!fits({ ...reply, memories })) break;
      reply.memories = memories;
    }
    if (kept.facts.length > 0 || kept.memories.length > 0) return reply;
    // A reply that lists no item can be over all the same: its fixed part alone, for a read with nothing on file or a
    // budget too small for any item. It drops what the lane adds, the least of it first, until it fits: the provenance
    // legend, which explains items it does not list; how the abstention was reached (the terms it looked for, then its
    // coverage, bar and count); a list of contradictions that names none; and last the abstention itself, which a budget
    // that cannot hold it does not carry, as it does not carry a contradiction, and the reply says it was cut. What is
    // left is the reply with the lane off, over only where that one is (an echoed query longer than the budget).
    const abstention = reply.abstention as Abstention | null;
    const cuts: Array<() => void> = [
      () => { delete reply.provenance; },
      () => {
        if (!abstention) return;
        const { terms: _terms, ...reached } = abstention;
        reply.abstention = reached;
      },
      () => { if (abstention) reply.abstention = { status: abstention.status, reason: abstention.reason, statement: abstention.statement }; },
      () => { if (shown.length === 0) delete reply.conflicts; },
      () => {
        delete reply.abstention;
        if (abstention) reply.truncated = true;
      },
    ];
    for (const cut of cuts) {
      if (fits(reply)) break;
      cut();
    }
    return reply;
  };
  const fixed = () => budget(maxTokens - listedTokens(assemble({ facts: [], memories: [], truncated: false, tokens: 0, listed: new Set() }, judged?.relevance)));
  // With the lane armed, the reply that holds everything the read found is the reply whenever it fits: the budget cuts
  // each list in turn, so short of that it can keep a fact's ledger event where the fact would take its place.
  const whole = honestyLane ? budget(Number.POSITIVE_INFINITY) : undefined;
  let kept = whole ?? fixed();
  let body = assemble(kept);
  if (whole && replyTokens(JSON.stringify(body)) > maxTokens) {
    kept = fixed();
    body = assemble(kept);
  }
  for (let over = listedTokens(body) - maxTokens; over > 0 && kept.tokens > 0; over = listedTokens(body) - maxTokens) {
    kept = budget(kept.tokens - over);
    body = assemble(kept);
  }
  const reply = honestyLane ? withLane(kept, body) : body;
  // The budget's final decision, for the learning log (rankingTrace.ts): which of the candidates it considered it kept.
  currentRankingTrace()?.budgeted(candidateMemories, kept.memories);
  if (rankedBy === 'session_date') {
    // Selection is finished, including the honesty lane's extra statements. Render those statements with their
    // session: appending a newest update after an older match contradicts the order the reply promises. Summary
    // tables stay outside ranking, and word-only matches follow the dated lane in their original order.
    const listed = reply.memories as AgentContextMemory[];
    const leading = leadingSummaryHits(listed);
    const dated: AgentContextMemory[] = [];
    const keywords: AgentContextMemory[] = [];
    for (const memory of listed.slice(leading)) {
      (memory.reason.split('+').every(r => WORD_MATCH_REASONS.includes(r)) ? keywords : dated).push(memory);
    }
    reply.memories = [
      ...listed.slice(0, leading),
      ...orderHits(dated.map(item => ({ item, score: item.score ?? 0, session_date: item.session_date })), 'session_date').map(hit => hit.item),
      ...keywords,
    ];
  }
  // The layout above may have sorted a newer note after the older one it overlaps: the same rule, once more on the final list.
  if (newerFirst) reply.memories = newerFirstMemories(reply.memories as AgentContextMemory[]);
  if (correctionOf.size > 0) pinToCorrections(reply, correctionOf);
  // Last, once the order and the pairs are settled on the full items, which say how they were found.
  if (lean) reply.memories = (reply.memories as AgentContextMemory[]).map(leanMemory);
  // Last: the dated outline takes only the room the finished reply leaves (capped at its own budget), so the closest match
  // the relevance contract keeps is never crowded out by it, and the whole reply still holds max_tokens.
  if (outlinePool.length > 0) {
    try {
      const room = Math.min(outlineBudget, maxTokens - replyTokens(JSON.stringify(reply)));
      const block = room < MIN_OUTLINE_TOKENS ? null : buildDatedOutline(outlinePool, room, {
        listed: candidateMemories.map(memory => memory.text),
        scoreOf: engine.vectorIndex && probe.queryVector && vectorsMeanSomething(engine.provider?.identity?.kind)
          ? turnScorer(engine.vectorIndex, probe.queryVector)
          : undefined,
        minSimilarity: datedOutlineMinSimilarity(resolveRelevanceBar(engine.modelKey, outlineEnv), outlineEnv),
      });
      if (block) {
        const withBlock = withDatedOutline(reply, block);
        if (replyTokens(JSON.stringify(withBlock)) <= maxTokens) return withBlock;
      }
    } catch { /* omit the block */ }
  }
  return reply;
}
