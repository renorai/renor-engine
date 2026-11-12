/**
 * When the server's instructions tell an agent to read its memory: at the start of a substantive task, and again before a
 * decision an earlier session may have settled or a review of another agent's work. The alternative texts that
 * RENOR_RECALL_TIMING once selected were measured and none was better (docs/evals/results/recall-timing-20261021/, LEDGER
 * BV); the switch was removed on 2026-11-09 and this is the one text.
 */
const START = 'For substantive user requests, call get_context with the current request before answering so relevant prior context can follow the user across agents. ';
const DECISION = 'Call it again before you decide something an earlier session may have settled and before you review another agent\'s work, with that choice or topic as the query: reading once at the start is not enough. ';

/** The read-timing sentences of the server's instructions, between the whats_new sentence and the save guidance. */
export function recallInstructions(): string {
  return START + DECISION;
}
