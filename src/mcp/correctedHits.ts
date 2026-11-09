import { inferReplaced, inferReplacesEnabled, readsAsCorrection, type ReplaceCandidate } from '../mvp/inferReplaces';
import type { NormalizedScope } from '../mvp/scope';

/**
 * The label a `search` hit of the self-hosted stdio server carries when a later hit on the same page corrects it (#1457):
 * the correction's chunk id and when it was saved. Absent on every other hit.
 */
export interface SupersededLabel {
  superseded: {
    /** The chunk id of the hit that corrects it, listed before it on the same page. */
    byChunkId: number;
    /** When that correction was saved (its session_date). */
    at: string;
  };
}

interface PageHit { chunkId?: number; notePath: string; text: string; session_date?: string }

/** A daily-note entry as the `note` tool writes it: `- [HH:MM:SS] (source) text`. */
const DAILY_ENTRY = /^\s*-\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*(?:\(([^)\n]{1,80})\)\s*)?/;

function entryOf(text: string): { body: string; source: string | null } {
  const m = DAILY_ENTRY.exec(text);
  return m ? { body: text.slice(m[0].length), source: m[1]?.trim() || null } : { body: text, source: null };
}

/** The scope a stored note belongs to, read from its path (Memory/Scopes/<slug>/...): two scopes never correct each other. */
function scopeOfPath(notePath: string): NormalizedScope {
  const m = /(?:^|\/)Memory\/Scopes\/([a-z0-9-]{1,64})\//.exec(notePath.replace(/\\/g, '/'));
  return m ? `scope:${m[1]}` : 'global';
}

/**
 * The page of a self-hosted `search` with every hit that a later hit on it reads as correcting marked superseded and
 * listed right after its correction (#1457). A note saved with `note` has no `replaces` link (the hosted `remember` sets
 * one at save time, #1460), so the same inference runs here at read time over the page: a correction cue ("correction",
 * "now", "not X", "instead", ...), the same subject and enough shared words (mvp/inferReplaces.ts). Nothing stored
 * changes, and a page with no correction on it is returned as it was. RENOR_INFER_REPLACES=0 switches it off, as it
 * switches off the save-time inference.
 */
export function markCorrectedHits<T extends PageHit>(hits: T[], env: NodeJS.ProcessEnv = process.env): Array<T | (T & SupersededLabel)> {
  if (!inferReplacesEnabled(env) || hits.length < 2) return hits;
  const entries = hits.map(hit => ({ hit, ...entryOf(hit.text) }));
  // Index of the correcting hit for each superseded hit.
  const correctedBy = new Map<number, number>();
  entries.forEach((entry, i) => {
    if (!entry.hit.session_date || entry.hit.chunkId === undefined || !readsAsCorrection(entry.body)) return;
    const correctionChunkId = entry.hit.chunkId;
    const candidates: Array<ReplaceCandidate & { index: number }> = [];
    entries.forEach((other, j) => {
      if (j === i || !other.hit.session_date || other.hit.chunkId === undefined) return;
      const earlierTimestamp = other.hit.session_date < entry.hit.session_date!;
      // Daily-note entries are timestamped only to the second. When two saves land in that
      // second, their chunks still preserve append order, so use it to break the tie. Do not
      // impose that ordering across notes, which may have been indexed in either order.
      const earlierOnSameNote = other.hit.session_date === entry.hit.session_date
        && other.hit.notePath === entry.hit.notePath
        && other.hit.chunkId < correctionChunkId;
      if (!earlierTimestamp && !earlierOnSameNote) return;
      if (correctedBy.has(j)) return;
      candidates.push({ id: String(j), index: j, path: other.hit.notePath, excerpt: other.body, source: other.source, at: other.hit.session_date });
    });
    const found = inferReplaced(entry.body, scopeOfPath(entry.hit.notePath), entry.source ?? undefined, candidates);
    if (found) correctedBy.set(Number(found.id), i);
  });
  if (correctedBy.size === 0) return hits;

  const labelled: Array<T | (T & SupersededLabel)> = hits.map((hit, i) => {
    const by = correctedBy.get(i);
    if (by === undefined) return hit;
    return { ...hit, superseded: { byChunkId: hits[by].chunkId!, at: hits[by].session_date! } };
  });
  // A superseded hit listed above its correction moves to just after it, so the current value is read first.
  const order = labelled.map((_, i) => i);
  for (const [old, by] of correctedBy) {
    const from = order.indexOf(old), to = order.indexOf(by);
    if (from > to) continue;
    order.splice(from, 1);
    order.splice(order.indexOf(by) + 1, 0, old);
  }
  return order.map(i => labelled[i]);
}
