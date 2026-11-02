/**
 * Short-lived status kept from misleading later readers (RENOR_STATUS_FRESHNESS, default OFF).
 *
 * Agents save status as facts ("PR 648 is not merged", "main is at 3f9a1c2", "12 tests failing") that are wrong within
 * hours. A fact is status-like when its subject/predicate/object names the state of a PR, commit, branch, build or
 * count. Such a fact has a freshness window counted from its `validFrom`; once past it, a read labels it `stale`
 * (`label`) or leaves it out (`hide`). Decisions, preferences and standing rules never match, so they are unaffected.
 * Nothing is stored or rewritten: the window is derived from the saved text, so turning the switch on or off changes
 * only what a read shows.
 */

export const STATUS_FRESHNESS_FLAG = 'RENOR_STATUS_FRESHNESS';

export type StatusFreshnessMode = 'off' | 'label' | 'hide';

export function statusFreshnessMode(env: NodeJS.ProcessEnv = process.env): StatusFreshnessMode {
  const raw = (env[STATUS_FRESHNESS_FLAG] ?? '').trim().toLowerCase();
  if (raw === 'hide') return 'hide';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on' || raw === 'label' ? 'label' : 'off';
}

const HOUR = 3_600_000;

/** Standing wording wins over status wording: "always check whether the PR is merged" is a rule, not a status. */
const DURABLE = /\b(always|never|must|should|prefers?|policy|rule|convention|decisi?on|decid(?:ed|es)|we (?:use|chose)|going forward|by default)\b/i;

const PATTERNS: Array<{ re: RegExp; hours: number }> = [
  // PR / issue / CI state
  { re: /\b(?:pr|pull request|issue)\s*#?\d+\b.*\b(?:open|closed|merged|not merged|unmerged|draft|approved|blocked|failing|passing|green|red|in review|waiting)\b/i, hours: 12 },
  { re: /\b(?:ci|build|checks?|pipeline|tests?)\b.*\b(?:failing|passing|green|red|broken|failed|flaky)\b/i, hours: 12 },
  { re: /\bnot (?:yet )?(?:merged|deployed|released|reviewed|pushed|shipped)\b/i, hours: 12 },
  // commit / branch heads
  { re: /\b(?:main|master|develop|head|branch\s+\S+|origin\/\S+)\b.*\b(?:is at|points? to|at commit|head is|is on)\b.*\b[0-9a-f]{7,40}\b/i, hours: 6 },
  { re: /\b(?:latest|current|last) (?:commit|release|deploy(?:ment)?|version|build)\b/i, hours: 24 },
  // counts that change
  { re: /\b\d+\s+(?:open\s+)?(?:prs?|pull requests|issues|tests?|failures|errors|todos?|tasks?)\s+(?:open|failing|passing|remaining|left|pending)\b/i, hours: 24 },
];

/** Hours the fact stays fresh, or null when it is not status-like. */
export function statusWindowHours(fact: { subject: string; predicate: string; object: string }): number | null {
  // Records of finished PRs, reviews and tasks are history, not state: they do not go stale.
  if (/^(outcome|verdict|review[ _]verdict|independent[ _]review|result|fix[ _]verdict|verdict[ _]and[ _]blockers)\b/i.test(fact.predicate.replace(/_/g, ' '))) return null;
  const text = `${fact.subject} ${fact.predicate.replace(/_/g, ' ')} ${fact.object}`;
  if (DURABLE.test(text)) return null;
  for (const { re, hours } of PATTERNS) if (re.test(text)) return hours;
  return null;
}

export interface StaleStatus { staleStatus: string }

/** Set when a status-like fact is past its window at `now`. */
export function staleStatusOf(
  fact: { subject: string; predicate: string; object: string; validFrom: string },
  now: number = Date.now(),
): string | null {
  const hours = statusWindowHours(fact);
  if (hours === null) return null;
  const saved = Date.parse(fact.validFrom);
  if (Number.isNaN(saved)) return null;
  const age = now - saved;
  if (age <= hours * HOUR) return null;
  const ago = age >= 48 * HOUR ? `${Math.floor(age / (24 * HOUR))} days` : `${Math.floor(age / HOUR)} hours`;
  return `status saved ${ago} ago; likely out of date, verify before relying on it`;
}
