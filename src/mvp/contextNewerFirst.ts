/**
 * get_context shows a correction before the note it corrects (RENOR_CONTEXT_NEWER_FIRST, off by default: the reply is
 * then what it always was).
 *
 * When two notes on the page say nearly the same thing in nearly the same words and one is newer, the newer one is the
 * current statement. The 2 Nov gap analysis found corrections ranked below the old note they fixed, past the budget.
 * With the flag on, the newer note is listed directly before the older one and the older one is tagged `earlier: true`.
 * Neither is ever dropped. A memory that already carries `replaced` (a recorded correction pair) is left to that
 * mechanism, and two notes without a date, or on the same date and time, are never reordered.
 */
export const CONTEXT_NEWER_FIRST_FLAG = 'RENOR_CONTEXT_NEWER_FIRST';

export function contextNewerFirstEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CONTEXT_NEWER_FIRST_FLAG] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Shared words, as a share of the smaller note's words, from which two notes are about the same thing. */
export const NEWER_FIRST_OVERLAP = 0.6;
/** Fewer distinct words than this say too little to be the same statement ("Yes", a bare name). */
const MIN_WORDS = 4;

const DAILY_PREFIX = /^(\s*-\s*\[(\d{2}:\d{2}(?::\d{2})?)\]\s*(?:\([^)]*\)\s*)?)+/;
const DATE_IN_PATH = /(\d{4}-\d{2}-\d{2})/;

export interface NewerFirstMemory { notePath: string; text: string; session_date?: string; replaced?: unknown; earlier?: true }

function wordSet(text: string): Set<string> {
  return new Set(text.replace(DAILY_PREFIX, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1));
}

/** When the memory was written, as a sortable string: its day, then the time of its daily entry. Null when undated. */
function writtenAt(memory: NewerFirstMemory): string | null {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(memory.session_date ?? '')?.[0] ?? DATE_IN_PATH.exec(memory.notePath)?.[1];
  if (!day) return null;
  const time = /^\s*-\s*\[(\d{2}:\d{2}(?::\d{2})?)\]/.exec(memory.text)?.[1];
  return time === undefined ? day : `${day} ${time.length === 5 ? `${time}:00` : time}`;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  if (a.size < MIN_WORDS || b.size < MIN_WORDS) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / Math.min(a.size, b.size) >= NEWER_FIRST_OVERLAP;
}

/**
 * `memories` with each newer near-duplicate listed right before the older one it overlaps, the older tagged `earlier`.
 * Nothing is added or dropped; memories that overlap nothing keep their places. Idempotent.
 */
export function newerFirstMemories<T extends NewerFirstMemory>(memories: readonly T[]): T[] {
  const at = memories.map(writtenAt);
  const sets = memories.map(m => wordSet(m.text));
  const eligible = memories.map((m, i) => m.replaced === undefined && at[i] !== null);
  // For each memory, the newest later-written overlapping memory that the list shows after it, if any.
  const newerOf = new Map<number, number>();
  memories.forEach((_, i) => {
    if (!eligible[i]) return;
    let best = -1;
    memories.forEach((__, j) => {
      if (j === i || !eligible[j] || at[j]! <= at[i]! || !overlaps(sets[i], sets[j])) return;
      // Two notes of the same day with no time say nothing about which is newer: ordered by day alone, only a later day counts.
      if (at[i]!.length === 10 && at[j]!.length === 10 && at[i]! === at[j]!) return;
      if ((at[i]!.length === 10) !== (at[j]!.length === 10) && at[i]!.slice(0, 10) === at[j]!.slice(0, 10)) return;
      if (best < 0 || at[j]! > at[best]!) best = j;
    });
    if (best >= 0) newerOf.set(i, best);
  });
  if (newerOf.size === 0) return [...memories];
  const out: T[] = [];
  const placed = new Set<number>();
  const place = (i: number, seen: Set<number>): void => {
    if (placed.has(i)) return;
    const newer = newerOf.get(i);
    if (newer !== undefined && !seen.has(newer)) place(newer, new Set([...seen, i]));
    if (placed.has(i)) return;
    placed.add(i);
    out.push(newer === undefined ? memories[i] : memories[i].earlier ? memories[i] : { ...memories[i], earlier: true });
  };
  memories.forEach((_, i) => place(i, new Set()));
  return out;
}
