/**
 * RENOR_SEARCH_EXPLAIN (default ON; `0`, `false`, `no` or `off` restore the former behaviour): get_context and
 * search_memory accept `explain: true` and then add one small `explain` object to the reply, saying why a memory was or
 * was not returned. Without the argument, or with the switch off, the reply is byte-identical to the former one.
 * The collector costs nothing when absent: every recording site is guarded by `probe.explain`.
 * Only ids are listed for dropped items, never note text.
 */
export type DropReason = 'budget' | 'reply-budget' | 'per-note-cap' | 'floor' | 'scope' | 'retired';

export interface ExplainDrop { id: string; reason: DropReason }

/** Filled by retrieveContext while a read runs (set on the read's RetrievalProbe). */
export interface ExplainTrace {
  lanes: string[];
  /** Candidates after each stage of the read, in order. */
  stages: Array<{ stage: string; count: number }>;
  dropped: ExplainDrop[];
  /** Tools add these on top (the search floor, the reply budget). */
  floor?: number;
}

export const MAX_EXPLAIN_DROPPED = 5;

export function searchExplainEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes((env.RENOR_SEARCH_EXPLAIN ?? '').trim().toLowerCase());
}

/** A fresh collector when the caller asked for `explain` and the switch allows it; else undefined (nothing is recorded). */
export function newExplainTrace(asked: boolean | undefined, env: NodeJS.ProcessEnv = process.env): ExplainTrace | undefined {
  return asked === true && searchExplainEnabled(env) ? { lanes: [], stages: [], dropped: [] } : undefined;
}

export function noteStage(trace: ExplainTrace | undefined, stage: string, count: number): void {
  if (trace) trace.stages.push({ stage, count });
}

const noted = new WeakMap<ExplainTrace, Set<string>>();

/** A chunk is counted once per reason: one read can ask the same filter about the same chunk several times. */
export function noteDrop(trace: ExplainTrace | undefined, id: string | number, reason: DropReason): void {
  if (!trace) return;
  let seen = noted.get(trace);
  if (!seen) noted.set(trace, (seen = new Set()));
  const key = `${reason}:${String(id)}`;
  if (seen.has(key)) return;
  seen.add(key);
  trace.dropped.push({ id: String(id), reason });
}

/** The reply object: counts per reason for everything dropped, plus up to five dropped ids. */
export function explainReply(trace: ExplainTrace): Record<string, unknown> {
  const droppedCounts: Record<string, number> = {};
  for (const d of trace.dropped) droppedCounts[d.reason] = (droppedCounts[d.reason] ?? 0) + 1;
  return {
    lanes: trace.lanes,
    stages: trace.stages,
    ...(trace.floor !== undefined ? { floor: trace.floor } : {}),
    droppedCounts,
    dropped: trace.dropped.slice(0, MAX_EXPLAIN_DROPPED),
  };
}

/** The argument is advertised in the full tool profile only (the lean and coding profiles keep their tool list as it was). */
export function explainAdvertised(profile: { tools?: unknown }, toolProfile: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return searchExplainEnabled(env) && !profile.tools && toolProfile !== 'coding';
}

export const EXPLAIN_ARG_DESCRIPTION = 'Set true to add an `explain` object to the reply: the lanes used, candidate counts after each stage, and up to 5 dropped ids with a reason (budget, reply-budget, per-note-cap, floor, scope, retired). No note text.';
