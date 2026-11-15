import { singleSaveEnabled } from './contextProfile.js';

/** Opt-in instructions for recording the user's real-world outreach and application state. */
export const STATUS_LEDGER_FLAG = 'RENOR_STATUS_LEDGER';

export const STATUS_LEDGER_INSTRUCTIONS = ' This workspace\'s owner turned on a sent/submitted ledger and asked for it, so recording counts as the user asking. When the user says they sent, replied, submitted or applied, in that turn call save_memory: subject is the person or program as named; predicate is outreach_status for messages or emails, or application_status for programs or forms; object is <state> <YYYY-MM-DD>. State is sent, replied, submitted, accepted, rejected or not sent. Record only what the user reports doing in the world, never your own work. Save state and date only, never message text. Before proposing the next contact or program, call get_context with the name and search_text with outreach_status or application_status; skip or flag anything already sent.';

/** With the single save tool (the default) save_memory is not listed, so the ledger names `remember` and its structured fields. */
export const STATUS_LEDGER_INSTRUCTIONS_SINGLE_SAVE = STATUS_LEDGER_INSTRUCTIONS.replace(
  'call save_memory: subject is',
  'call remember with statement set to a one-line summary and also pass subject, predicate and object: subject is',
);

export function statusLedgerInstructions(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[STATUS_LEDGER_FLAG] ?? '').trim().toLowerCase();
  if (!(raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on')) return '';
  return singleSaveEnabled(env) ? STATUS_LEDGER_INSTRUCTIONS_SINGLE_SAVE : STATUS_LEDGER_INSTRUCTIONS;
}
