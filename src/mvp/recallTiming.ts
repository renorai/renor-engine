/**
 * When the server's instructions tell an agent to read its memory (RENOR_RECALL_TIMING). Renor cannot change the agent's
 * model, only the text it is told, so these are the variants of that text an eval compares
 * (scripts/eval/agent-workflow/timing.ts). Unset, the instructions are exactly what the product has always sent.
 *
 *   start-only         ablation: the start-of-task read alone, without the second read before a decision or review;
 *   start-always       the start read on every task, not only "substantive" ones, then the decision read as before;
 *   decision-concrete  the decision read names what a decision is (a library, a command, a value, an approach) and the query;
 *   correction         the default, plus a read after the user corrects or rejects what the agent proposed.
 *
 * Off by default; an unknown value is the default, so a typo never changes what agents are told.
 */
export const RECALL_TIMINGS = ['start-only', 'start-always', 'decision-concrete', 'correction'] as const;
export type RecallTiming = typeof RECALL_TIMINGS[number] | 'default';

export function recallTiming(env: NodeJS.ProcessEnv = process.env): RecallTiming {
  const v = (env.RENOR_RECALL_TIMING ?? '').trim().toLowerCase();
  return (RECALL_TIMINGS as readonly string[]).includes(v) ? v as RecallTiming : 'default';
}

const START = 'For substantive user requests, call get_context with the current request before answering so relevant prior context can follow the user across agents. ';
const START_ALWAYS = 'At the start of every task, call get_context with the current request before answering, even when the task looks simple, so relevant prior context can follow the user across agents. ';
const DECISION = 'Call it again before you decide something an earlier session may have settled and before you review another agent\'s work, with that choice or topic as the query: reading once at the start is not enough. ';
const DECISION_CONCRETE = 'Call it again before each choice an earlier session may have settled (a library, a command, a value, an approach) and before you review another agent\'s work, with that choice as the query, for example "package manager for <service>": reading once at the start is not enough. ';
const CORRECTION = 'When the user corrects you or rejects what you proposed, call get_context again with what was corrected as the query before you answer: an earlier session may already hold the right answer, and the user should not have to repeat it. ';

/** The read-timing sentences of the server's instructions, between the whats_new sentence and the save guidance. */
export function recallInstructions(timing: RecallTiming = recallTiming()): string {
  switch (timing) {
    case 'start-only': return START;
    case 'start-always': return START_ALWAYS + DECISION;
    case 'decision-concrete': return START + DECISION_CONCRETE;
    case 'correction': return START + DECISION + CORRECTION;
    default: return START + DECISION;
  }
}
