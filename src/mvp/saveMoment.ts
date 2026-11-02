/**
 * RENOR_SAVE_MOMENT (default off): where the server tells agents to save what the user states at the moment it is said.
 *
 * The shipped guidance asks for saves "when you save on your own" and lists decisions, root causes and corrections, while
 * the renor-memory skill asks for a check "before you finish any substantive piece of work". Neither names the moment the
 * user says it, and the server instructions do not name preferences or working rules. The owner's own sessions show the
 * costly miss is exactly that: a preference ("always reply in English") or an autonomy rule never saved, or saved days
 * late. The variants below are measured by scripts/eval/save-moment (docs/evals/results/save-moment-20261021).
 *
 * - unset / off: the shipped text, byte for byte;
 * - `instructions`: one paragraph added to the server instructions;
 * - `tool`: one sentence added to the start of remember's description (seen by clients that drop server instructions);
 * - `both`: the two together.
 */
export type SaveMomentMode = 'off' | 'instructions' | 'tool' | 'both';

export function saveMomentMode(env: NodeJS.ProcessEnv = process.env): SaveMomentMode {
  const v = (env.RENOR_SAVE_MOMENT ?? '').trim().toLowerCase();
  return v === 'instructions' || v === 'tool' || v === 'both' ? v : 'off';
}

/** Appended to the server instructions under `instructions` and `both`. */
export const SAVE_MOMENT_INSTRUCTIONS = ' Save at the moment it is said, not at the end of the task: when the user states a preference or a rule for how you'
  + ' should work (language, style, what you may do alone, what to ask first), makes or confirms a decision, or corrects you or'
  + ' an earlier fact, call remember in that same turn, in the user\'s words, before you go on with the task. A session can end'
  + ' at any time and what was not saved is lost. Do not save the rest: requests for the current task, questions, status,'
  + ' thanks, and instructions meant only for this one reply.';

/** Prepended to remember's description under `tool` and `both`. */
export const SAVE_MOMENT_TOOL = 'Call this in the same turn the user states a preference or working rule, makes or confirms a decision, or corrects'
  + ' you, in their words, not at the end of the task; not for task requests, questions, status or thanks. ';

/**
 * Under RENOR_STATUS_LEDGER (statusLedger.ts) the user's reported sends, replies and submissions are saved on purpose, so
 * the "not status" exclusion is narrowed to the agent's own progress and names the ledger. Off, the measured text above.
 */
export const SAVE_MOMENT_INSTRUCTIONS_WITH_LEDGER = SAVE_MOMENT_INSTRUCTIONS.replace(' questions, status,',
  ' questions, your own progress or status (the sent/submitted ledger below still asks you to record what the user reports having done),');

export const SAVE_MOMENT_TOOL_WITH_LEDGER = SAVE_MOMENT_TOOL.replace(' questions, status or thanks.',
  ' questions, your own progress or status (the sent/submitted ledger still asks you to record what the user reports having done) or thanks.');

export function saveMomentInstructions(mode: SaveMomentMode, statusLedger = false): string {
  if (mode !== 'instructions' && mode !== 'both') return '';
  return statusLedger ? SAVE_MOMENT_INSTRUCTIONS_WITH_LEDGER : SAVE_MOMENT_INSTRUCTIONS;
}

export function saveMomentTool(mode: SaveMomentMode, statusLedger = false): string {
  if (mode !== 'tool' && mode !== 'both') return '';
  return statusLedger ? SAVE_MOMENT_TOOL_WITH_LEDGER : SAVE_MOMENT_TOOL;
}
