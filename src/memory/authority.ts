import { parseEntryHeader, DAILY_FILE_RE } from './dailyNote';
import { isImportSource } from './sourceName';

/**
 * Authority labels (RENOR_AUTHORITY_LABELS, default off): one short word on each memory a read returns, saying where it
 * came from, so an agent can trust an owner's word differently from another agent's save, an automatic capture or an
 * imported file. The label is derived only from what Renor already stores: the fact's author, a daily entry's header
 * source, the `Imported/` path. It adds no column and rewrites no stored entry.
 *
 *   owner     the owner wrote it themselves: the dashboard only (its saves carry the reserved connect-token name
 *             `dashboard-inventory-read`, which no user can mint). With labels on, the server turns that name into
 *             `unnamed` for any call that does not carry the gateway's dashboard mark (mvp/server.ts sourceOf), so an
 *             agent cannot write under it. Only a fact or ledger event author can be `owner`: a daily-note chunk never is.
 *   agent     an agent saved it (also anything whose source is missing or not recognised: the lower label is the default).
 *   captured  automatic capture saved it (`capture-user`, `capture-server`): a model's reading of a session, not a decision.
 *   imported  it came from a file the owner imported (`import:*`, or a note under `Imported/`).
 *
 * The labels are a closed vocabulary written by this module, never stored text, so a label cannot carry an injection.
 * A chunk with several entries takes the LOWEST label among them.
 */
export const AUTHORITY_LABELS_FLAG = 'RENOR_AUTHORITY_LABELS';

export type Authority = 'owner' | 'agent' | 'captured' | 'imported';

/** Lowest first: the label of a memory made of several entries is the first of these any of them has. */
const LOWEST_FIRST: readonly Authority[] = ['imported', 'captured', 'agent', 'owner'];

/** The dashboard's connect token (supabase/functions/memory-inventory TOKEN_LABEL), which both mint RPCs refuse to a user. */
const OWNER_SOURCES = new Set(['dashboard-inventory-read']);
const CAPTURE_SOURCES = new Set(['capture-user', 'capture-server']);

export function authorityLabelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|on|true|yes)$/i.test(env.RENOR_AUTHORITY_LABELS?.trim() ?? '');
}

/** The label of one stored source name. Missing or unknown: agent. */
export function authorityOfSource(source: string | null | undefined): Authority {
  if (typeof source !== 'string' || source === '') return 'agent';
  if (isImportSource(source) || source.startsWith('import-')) return 'imported';
  if (CAPTURE_SOURCES.has(source)) return 'captured';
  if (OWNER_SOURCES.has(source)) return 'owner';
  return 'agent';
}

/** The lowest of these labels. */
export function lowestAuthority(labels: readonly Authority[]): Authority {
  return LOWEST_FIRST.find(label => labels.includes(label)) ?? 'agent';
}

const IMPORTED_NOTE = /(^|[\\/])Imported[\\/]/;

/**
 * The label of a search hit or context memory: an imported note is `imported`; a daily-log chunk takes the lowest label
 * among its entry headers but is never `owner`; anything else is `agent`. A chunk is read from decoded text, in which an
 * entry-shaped line an agent planted inside a long statement is indistinguishable from a real header, so a header in a
 * chunk can lower the label (captured, imported) and never raise it above `agent`. A ledger event or a fact is labelled from its author instead
 * (authorityOfSource).
 */
export function authorityOfChunk(notePath: unknown, text: unknown): Authority {
  if (typeof notePath === 'string' && IMPORTED_NOTE.test(notePath)) return 'imported';
  if (typeof notePath !== 'string' || typeof text !== 'string' || !DAILY_FILE_RE.test(notePath)) return 'agent';
  const found: Authority[] = [];
  for (const line of text.split('\n')) {
    const header = parseEntryHeader(line);
    if (header !== null) found.push(authorityOfSource(header.source));
  }
  const label = found.length === 0 ? 'agent' : lowestAuthority(found);
  return label === 'owner' ? 'agent' : label;
}

/** `{ authority }` for an item when labels are on, otherwise nothing, so a reply with the flag off is what it was. */
export function authorityField(label: Authority, env: NodeJS.ProcessEnv = process.env): { authority?: Authority } {
  return authorityLabelsEnabled(env) ? { authority: label } : {};
}
