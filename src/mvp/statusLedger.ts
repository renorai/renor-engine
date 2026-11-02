/** Opt-in instructions for recording the user's real-world outreach and application state. */
export const STATUS_LEDGER_FLAG = 'RENOR_STATUS_LEDGER';

export const STATUS_LEDGER_INSTRUCTIONS = ' This workspace\'s owner turned on a sent/submitted ledger and asked for it, so recording counts as the user asking. When the user says they sent, replied, submitted or applied, in that turn call save_memory: subject is the person or program as named; predicate is outreach_status for messages or emails, or application_status for programs or forms; object is <state> <YYYY-MM-DD>. State is sent, replied, submitted, accepted, rejected or not sent. Record only what the user reports doing in the world, never your own work. Save state and date only, never message text. Before proposing the next contact or program, call get_context with the name and search_text with outreach_status or application_status; skip or flag anything already sent.';

export function statusLedgerInstructions(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[STATUS_LEDGER_FLAG] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on' ? STATUS_LEDGER_INSTRUCTIONS : '';
}
