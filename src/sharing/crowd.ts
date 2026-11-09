/**
 * The 3-people rule (owner decision, 2026-11-08): nothing computed from shared rows is shown unless at least MIN_CONTRIBUTORS distinct
 * contributors stand behind it, counted WITHIN ONE UTC MONTH.
 *
 * Why per month: an install's contributor id changes at the first send of every UTC month (state.ts monthlyRotation), so a contributor is an
 * install-month. One install active for three months is three ids; counted across months it would pass a "3 contributors" check on its own.
 * Within one month an install normally has one id, so three ids in one month are normally three installs. (An install can still have two
 * ids in one month after a deletion and restart, a refused credential, or a hosted owner's text switch, so the rule is a floor, not a proof.)
 *
 * Readers of shared rows (engine/scripts/eval/real-scoreboard.ts, engine/scripts/eval/ablation-loop/ranking-fit.ts, and any new one) keep
 * only the rows of months whose own rows have MIN_CONTRIBUTORS or more distinct contributors, and then suppress or refuse an output whose
 * remaining rows still have fewer. docs/TELEMETRY.md states the rule; tests hold each reader to it.
 */

export const MIN_CONTRIBUTORS = 3;

/** A month key, `2026-11`: from when the row was received (the rotation follows the send), else from the row's own hour. */
export function rowMonth(row: { receivedAt?: string; body?: Record<string, unknown> }): string | null {
  if (typeof row.receivedAt === 'string') {
    const t = Date.parse(row.receivedAt);
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 7);
  }
  const hour = row.body?.hour;
  return typeof hour === 'string' && /^\d{4}-\d{2}/.test(hour) ? hour.slice(0, 7) : null;
}

export interface Crowded<T> {
  /** The rows of months with at least `min` distinct contributors. */
  kept: T[];
  /** Rows dropped because their month had fewer (or no month could be read). */
  suppressedRows: number;
  /** Distinct contributors behind `kept` (install-months). */
  contributors: number;
  /**
   * The most distinct contributors in any one kept month: a floor on the number of distinct installs behind `kept` (an install has one id
   * per month), which is the honest count to compare with a "how many people" threshold.
   */
  installsAtLeast: number;
}

/** Keeps only the rows of months whose rows come from at least `min` distinct contributors. */
export function keepCrowdedMonths<T>(
  rows: readonly T[], contributorOf: (row: T) => string, monthOf: (row: T) => string | null, min: number = MIN_CONTRIBUTORS,
): Crowded<T> {
  const byMonth = new Map<string, Set<string>>();
  for (const row of rows) {
    const month = monthOf(row);
    if (month === null) continue;
    let group = byMonth.get(month);
    if (!group) byMonth.set(month, (group = new Set()));
    group.add(contributorOf(row));
  }
  const crowded = new Set<string>();
  const contributors = new Set<string>();
  let installsAtLeast = 0;
  for (const [month, group] of byMonth) {
    if (group.size < Math.max(MIN_CONTRIBUTORS, min)) continue;
    crowded.add(month);
    for (const c of group) contributors.add(c);
    installsAtLeast = Math.max(installsAtLeast, group.size);
  }
  // In the input's order, so a reader's output does not depend on how the months were grouped.
  const kept = rows.filter(row => {
    const month = monthOf(row);
    return month !== null && crowded.has(month);
  });
  const suppressedRows = rows.length - kept.length;
  return { kept, suppressedRows, contributors: contributors.size, installsAtLeast };
}
