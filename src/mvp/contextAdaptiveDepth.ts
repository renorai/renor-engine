import { FTS_STOP_WORDS } from '../retrieval/keyword.js';

/**
 * get_context with an adaptive page (RENOR_CONTEXT_ADAPTIVE_DEPTH, off by default: the reply is then what it always was).
 *
 * A get_context that names no size reads 50 matches into a reply capped at 8,000 tokens, whatever the question. This lever
 * serves the short page (the best SHORT_PAGE matches by score) when plain signals say the top matches are clearly enough,
 * and the deep page otherwise. No model call: only the matches' scores and words, and the words of the question.
 *
 * Rules, selectable in the switch's value (`gap,terms`; `1`, `true`, `yes` or `on` select both). The short page is served
 * only when EVERY selected rule agrees; a question the cue rule reads as spanning sessions or dates always keeps the deep one.
 *  - `gap`:   the 8th match scores at least GAP_RATIO times the 9th: the top 8 stand apart from the tail.
 *  - `terms`: the top 8 together hold every key term of the question (two or more terms of three letters or more).
 */
export const CONTEXT_ADAPTIVE_DEPTH_FLAG = 'RENOR_CONTEXT_ADAPTIVE_DEPTH';

export type DepthRule = 'gap' | 'terms';

/** The short page, in matches (the page the lean reads used before the deep one). */
export const SHORT_PAGE = 8;
/** `gap`: the 8th score over the 9th must reach this for the top 8 to count as standing apart. */
export const GAP_RATIO = 1.2;

const ALL_RULES: readonly DepthRule[] = ['gap', 'terms'];

/** The selected rules, or `null` when the lever is off (unset, empty, or no rule recognised). */
export function adaptiveDepthRules(env: NodeJS.ProcessEnv = process.env): DepthRule[] | null {
  const raw = (env[CONTEXT_ADAPTIVE_DEPTH_FLAG] ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return [...ALL_RULES];
  const picked = raw.split(',').map(s => s.trim()).filter((s): s is DepthRule => (ALL_RULES as readonly string[]).includes(s));
  return picked.length > 0 ? [...new Set(picked)] : null;
}

export function contextAdaptiveDepthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return adaptiveDepthRules(env) !== null;
}

// A question that spans sessions or dates: a count, a total, "every time", an order, a span between events, a written date
// or a relative time. These need the evidence of many sessions, so they keep the deep page.
const SPAN_CUES = [
  /\bhow (?:many|much|often|long)\b/i,
  /\b(?:total|altogether|in all|combined|overall|every|each time|all (?:the|of|my)|across|throughout)\b/i,
  /\b(?:before|after|first|last|earlier|later|latest|earliest|since|until|between|ago|previous|recent(?:ly)?|changed?|used to)\b/i,
  /\b(?:yesterday|today|tomorrow|week|month|year|day)s?\b/i,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\b/,
];

/** True when the question reads as spanning sessions or dates (its last line, as a caller may put a date above it). */
export function spansSessionsOrDates(query: string): boolean {
  const lines = query.split('\n').map(l => l.trim()).filter(Boolean);
  const question = lines[lines.length - 1] ?? '';
  return SPAN_CUES.some(cue => cue.test(question));
}

/** The words of a question that say what it is about: three letters or more, no stop word, each once. */
export function keyTerms(query: string): string[] {
  const lines = query.split('\n').map(l => l.trim()).filter(Boolean);
  const question = (lines[lines.length - 1] ?? '').toLowerCase();
  const words = question.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !FTS_STOP_WORDS.has(w));
  return [...new Set(words)];
}

export interface ScoredMatch { score?: number; text: string }

/**
 * Which of `matches` (any order) to keep. Returns `null` for the deep page (keep all), else the matches to drop: those
 * outside the SHORT_PAGE best by score. Matches without a score are never dropped.
 */
export function shortPageDrops<T extends ScoredMatch>(matches: readonly T[], query: string, rules: readonly DepthRule[]): Set<T> | null {
  const scored = matches.filter((m): m is T & { score: number } => typeof m.score === 'number');
  if (rules.length === 0 || scored.length <= SHORT_PAGE) return null; // nothing to shorten
  if (spansSessionsOrDates(query)) return null;
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, SHORT_PAGE);
  for (const rule of rules) {
    if (rule === 'gap') {
      const eighth = top[SHORT_PAGE - 1].score;
      const ninth = ranked[SHORT_PAGE].score;
      if (!(eighth > 0) || eighth < GAP_RATIO * ninth) return null;
    } else {
      const terms = keyTerms(query);
      if (terms.length < 2) return null;
      const page = top.map(m => m.text.toLowerCase()).join('\n');
      if (!terms.every(term => page.includes(term))) return null;
    }
  }
  return new Set(ranked.slice(SHORT_PAGE));
}
