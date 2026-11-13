import { FTS_STOP_WORDS } from '../retrieval/keyword.js';

/**
 * get_context that respects a name in the request (RENOR_NAME_AWARE_RECALL, default on; `0`/`false`/`off`/`no` restores
 * the reply it always was, byte for byte).
 *
 * An agent that asks about `catalog-worker` was handed the newest notes that shared common words with the request,
 * among them a note about another service, and when nothing was saved about the named one the nearest unrelated note
 * looked like the answer. Three rules, applied to the memories the search already returned (no new search, no new field):
 *  1. A note that holds the request's identifier verbatim (a hyphenated name such as `catalog-worker`) is listed ahead of
 *     the notes that do not, in the order it already had.
 *  2. A note that names a different service and not the requested one is left out, when a note names the requested one,
 *     or when none does (then nothing stands in its place).
 *  3. When no returned note holds the identifier, or the notes that do say nothing on the request's topic, the reply's
 *     `notice` says "Nothing saved about <name>" and to use what the project's own files say.
 * A note of another project scope is never returned for a scoped read; the scope partition in the search already holds
 * that and tests/mvp/name-aware-recall.test.ts pins it.
 */
export const NAME_AWARE_RECALL_FLAG = 'RENOR_NAME_AWARE_RECALL';

export function nameAwareRecallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[NAME_AWARE_RECALL_FLAG] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

const IDENTIFIER = /(?<![a-z0-9-])[a-z0-9]+(?:-[a-z0-9]+)+(?![a-z0-9-])/g;
/** Last part of a hyphenated name that reads as a service or component, not as a compound word ("wall-clock", "ts-jest"). */
const SERVICE_SUFFIX = /-(?:api|app|bot|builder|cache|client|console|db|gateway|indexer|job|jobs|proxy|queue|relay|scheduler|server|service|store|ui|web|worker)$/;

export function requestedNames(query: string): string[] {
  return [...new Set(query.toLowerCase().match(IDENTIFIER) ?? [])].filter(name => name.length >= 5 && SERVICE_SUFFIX.test(name));
}

function namesIn(text: string): string[] {
  return [...new Set(text.toLowerCase().match(IDENTIFIER) ?? [])];
}

/** The authoritative shapes of a saved statement: they answer a request about their subject without sharing its words. */
const STATEMENT_OF_RECORD = /(?:^|[\]\s)])(?:decision|correction|convention|rule)\s+for\s/i;

export interface NameAwareMemory { text: string; matched?: boolean }

export interface NameAwareResult<T> { memories: T[]; nothingSaved: string | null }

export const NOTHING_SAVED_NEXT = 'Use what the project\'s own files say.';

export function nameAwareMemories<T extends NameAwareMemory>(query: string, memories: readonly T[]): NameAwareResult<T> {
  const wanted = requestedNames(query);
  if (wanted.length === 0) return { memories: [...memories], nothingSaved: null };
  const holds = (m: T) => m.matched !== false && namesIn(m.text).some(n => wanted.includes(n));
  const hits = memories.filter(holds);
  const strangers = (m: T) => !holds(m) && namesIn(m.text).some(n => !wanted.includes(n) && SERVICE_SUFFIX.test(n));
  const rest = memories.filter(m => !holds(m) && !strangers(m));
  const topic = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u))]
    .filter(w => w.length >= 3 && !FTS_STOP_WORDS.has(w) && !wanted.some(n => n.split('-').includes(w)));
  const onTopic = (m: T) => STATEMENT_OF_RECORD.test(m.text) || topic.some(w => m.text.toLowerCase().includes(w.length > 5 ? w.slice(0, w.length - 2) : w));
  const nothing = hits.length === 0 || !hits.some(onTopic);
  return { memories: [...hits, ...rest], nothingSaved: nothing ? wanted[0] : null };
}
