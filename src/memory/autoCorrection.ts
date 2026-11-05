import type Database from '../db/sqlite';
import { normalizeScope, scopeSpellings } from '../mvp/scope';
import { identityKey } from '../retrieval/queryHelpers';

/**
 * Automatic correction detection (RENOR_AUTO_CORRECT, default OFF).
 *
 * A fact save replaces the current value only when subject, predicate and scope are the same slot. A correction
 * saved with a different spelling ("Fjord DB" / "db" instead of "Fjord" / "database") lands in a new slot and the
 * stale value stays current. This module finds, before the save, the ONE current fact in the SAME scope that the
 * new fact updates, and names the slot to save into. The save itself is the unchanged remember(): the old value is
 * superseded, kept in history and reversible, and the receipt says what was replaced. Nothing is deleted here and
 * nothing is written by this module.
 *
 * Deterministic and local (no model call, no embedding):
 *   - strong match: the subject and the predicate are the same after folding case, accents, punctuation, articles
 *     and plurals, and after a small predicate synonym table;
 *   - cue match: the subject is the same name plus or minus one word ("Atlas" / "Atlas project") AND the statement
 *     carries an update cue ("now", "no longer", "instead", "changed to", ...).
 *
 * It refuses to guess: a different entity with the same predicate, a different scope (a scoped save never replaces
 * a global value or another scope's), and any ambiguity (two candidate slots)
 * return no match. A value that is already the same still resolves to its slot, so the save is a `nochange` there
 * (not a second copy under the new spelling); the server then reports no correction.
 */

/** RENOR_AUTO_CORRECT (default OFF). Opt in with 1/true/yes/on. */
export function autoCorrectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_AUTO_CORRECT ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const SYNONYMS: ReadonlyArray<readonly string[]> = [
  ['database', 'db', 'datastore'],
  ['location', 'city', 'residence', 'home', 'livesin', 'basedin'],
  ['employer', 'company', 'workplace', 'worksat', 'job'],
  ['deadline', 'duedate', 'due', 'dueby'],
  ['manager', 'boss', 'lead'],
  ['email', 'emailaddress', 'mail'],
  ['phone', 'phonenumber', 'mobile'],
  ['editor', 'ide'],
  ['language', 'lang', 'programminglanguage'],
  ['framework', 'stack'],
  ['host', 'hosting', 'hostedon'],
  ['owner', 'maintainer'],
];

const CUES = /\b(now|no longer|not anymore|anymore|instead|changed to|change to|switched to|switch to|moved to|move to|updated to|renamed to|actually|replaced|replaces|rather than|from now on)\b/i;

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const ARTICLES = new Set(['the', 'a', 'an']);

function subjectWords(subject: string): string[] {
  return fold(subject)
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w && !ARTICLES.has(w))
    .map(stem);
}

function predicateKey(predicate: string): string {
  const key = fold(predicate).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem).join('');
  for (const group of SYNONYMS) if (group.includes(key)) return group[0];
  return key;
}

function oneWordLonger(longer: string[], shorter: string[]): boolean {
  if (shorter.length === 0 || longer.length !== shorter.length + 1) return false;
  const same = (offset: number) => shorter.every((w, i) => longer[i + offset] === w);
  return same(0) || same(1);
}

export interface CorrectionMatch {
  /** The subject, predicate and scope to save into: the slot of the current fact being updated. */
  subject: string;
  predicate: string;
  /** The value being replaced and how it was recognised. */
  replaced: { subject: string; predicate: string; object: string; scope: string; eventId: string | null };
  reason: 'same-fact-other-spelling' | 'update-cue';
}

interface Row { id: number; subject: string; predicate: string; object: string; scope: string; event_id: string | null }

export function detectCorrection(
  db: Database.Database,
  written: { subject: string; predicate: string; object: string; scope?: string; statement?: string },
): CorrectionMatch | null {
  const scope = normalizeScope(written.scope);
  const spellings = scopeSpellings(scope);
  const rows = db.prepare(
    `SELECT f.id AS id, e.canonical_name AS subject, f.predicate AS predicate, COALESCE(f.object_text, '') AS object,
            f.scope AS scope, f.event_id AS event_id
     FROM facts f JOIN entities e ON e.id = f.subject_entity_id
     WHERE f.valid_to IS NULL AND f.source_path = '_mcp_' AND f.scope IN (${spellings.map(() => '?').join(',')})
     ORDER BY f.id DESC LIMIT 5000`,
  ).all(...spellings) as Row[];

  const askedWords = subjectWords(written.subject);
  const askedKey = askedWords.join(' ');
  const askedPredicate = predicateKey(written.predicate);
  const cue = written.statement !== undefined && CUES.test(written.statement);
  if (!askedKey || !askedPredicate) return null;

  const hits = new Map<string, { row: Row; reason: CorrectionMatch['reason'] }>();
  for (const row of rows) {
    if (predicateKey(row.predicate) !== askedPredicate) continue;
    const words = subjectWords(row.subject);
    const sameName = words.join(' ') === askedKey;
    const near = !sameName && cue && (oneWordLonger(words, askedWords) || oneWordLonger(askedWords, words));
    if (!sameName && !near) continue;
    // The slot remember() would already use: nothing to detect.
    const exactSlot = identityKey(row.subject) === identityKey(written.subject) && row.predicate === written.predicate;
    if (exactSlot) return null;
    hits.set(`${row.subject}\u0000${row.predicate}`, { row, reason: sameName ? 'same-fact-other-spelling' : 'update-cue' });
  }
  if (hits.size !== 1) return null; // none, or ambiguous: never guess
  const { row, reason } = [...hits.values()][0];
  return {
    subject: row.subject,
    predicate: row.predicate,
    replaced: { subject: row.subject, predicate: row.predicate, object: row.object, scope: row.scope, eventId: row.event_id },
    reason,
  };
}
