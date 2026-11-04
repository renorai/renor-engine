import { headerSource } from '../memory/sourceName.js';
import { notePathMatchesScope, type NormalizedScope } from './scope.js';

/**
 * RENOR_INFER_REPLACES (default off): at save time, a new note that reads as a correction of an earlier one in the same
 * scope and from the same client gets `replaces` set automatically. Off, nothing here runs and every reply is unchanged.
 */
export function inferReplacesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|on|true|yes)$/i.test(env.RENOR_INFER_REPLACES?.trim() ?? '');
}

export interface ReplaceCandidate { id: string; path: string; excerpt: string; source: string | null; at: string }

/** Cues that mark a save as a correction: a leading/inline "actually", "instead", "correction", "not X but Y", "no longer". */
const CUE = /\b(actually|instead|correction|corrected|not\s+[^,.;]{1,60}?\s*,?\s+but|no longer|rather than|should be|is now|are now|was wrong|wrong:)\b/i;
const CUE_WORDS = new Set(['actually', 'instead', 'correction', 'corrected', 'not', 'but', 'no', 'longer', 'rather', 'than', 'should', 'be', 'is', 'now', 'are', 'was', 'wrong']);
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'it', 'this', 'that', 'we', 'i', 'you', 'use', 'run', 'with', 'at', 'as', 'by']);

export function readsAsCorrection(text: string): boolean {
  return CUE.test(text);
}

const tokens = (s: string, dropCues: boolean): Set<string> => {
  const out = new Set<string>();
  for (const w of s.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_./:-]*/gu) ?? []) {
    if (w.length < 2 || STOP.has(w) || (dropCues && CUE_WORDS.has(w))) continue;
    out.add(w);
  }
  return out;
};

const sourceKey = (s: string | null | undefined): string => (typeof s === 'string' ? headerSource(s) : '') || '';

/** The named thing a note is about: its first plain hyphenated name ("report-service"). Two notes where neither mentions the other's name are about different things. */
const subjectOf = (s: string): string | null => s.toLocaleLowerCase().match(/(?<![\p{L}\p{N}_-])\p{L}+(?:-\p{L}+)+(?![\p{L}\p{N}_-])/u)?.[0] ?? null;

/** Minimum share of the older note's words the correction must also hold, and the minimum words they share. */
const MIN_SHARED = 2;
const MIN_OVERLAP = 0.4;
/** The same two limits when the earlier note was saved by a different client. */
const CROSS_MIN_SHARED = 3;
const CROSS_MIN_OVERLAP = 0.6;

/**
 * The earlier note this save most likely corrects, or null. Same scope only (never across workspaces or scopes); a note from another client needs a stricter match; the newest of the
 * best-overlapping candidates wins, and a tie between different notes at the top score is left unlinked.
 */
export function inferReplaced(
  text: string,
  scope: NormalizedScope,
  source: string | undefined,
  candidates: ReplaceCandidate[],
): ReplaceCandidate | null {
  if (!readsAsCorrection(text)) return null;
  const mine = tokens(text, true);
  const saver = sourceKey(source);
  const mySubject = subjectOf(text);
  const lowerText = text.toLocaleLowerCase();
  let best: { c: ReplaceCandidate; score: number } | null = null;
  let tie = false;
  for (const c of candidates) {
    if (!notePathMatchesScope(c.path, scope)) continue;
    const theirs0 = c.excerpt.toLocaleLowerCase();
    const theirSubject = subjectOf(c.excerpt);
    if (mySubject && theirSubject && !theirs0.includes(mySubject) && !lowerText.includes(theirSubject)) continue;
    const theirs = tokens(c.excerpt, true);
    if (theirs.size === 0) continue;
    let shared = 0;
    for (const w of theirs) if (mine.has(w)) shared++;
    const score = shared / theirs.size;
    // A note from another client (the usual case: Codex corrects what Claude saved) needs a stricter match than the same client's own.
    const cross = sourceKey(c.source) !== saver;
    if (shared < (cross ? CROSS_MIN_SHARED : MIN_SHARED) || score < (cross ? CROSS_MIN_OVERLAP : MIN_OVERLAP)) continue;
    if (!best || score > best.score || (score === best.score && c.at > best.c.at)) { best = { c, score }; tie = false; }
    else if (score === best.score && c.at === best.c.at) tie = true;
  }
  return best && !tie ? best.c : null;
}
