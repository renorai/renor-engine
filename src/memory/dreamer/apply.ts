import type Database from '../../db/sqlite';
import { normDedupeValue } from '../../context/rowStore';
import { remember, StaleExpectationError, type MemoryReceipt } from '../lifecycle';
import type { ClusterKind } from './candidates';
import { collectionVerdict } from './collection';
import { oneLine, type JudgedFact, type PairVerdict } from './adjudicate';

/**
 * What the dreamer writes, and the rules it holds the model's labels to. Only "updates" ever writes, and then as an
 * ordinary lifecycle supersede (`remember`): the older fact is closed at the write time and stays in history, a new
 * event carries the replacing value, and nothing is deleted. "same", "coexist" and "uncertain" write nothing.
 *
 *   - The value goes into the older fact's own subject, predicate and scope, so a read of that name, in that scope,
 *     now says what the newer fact says. It is never written into the newer fact's name.
 *   - A value may replace one in its own scope, or one in a project scope when it was saved in `global` (an agent that
 *     forgot the project). It is never copied from one project scope into another, and never from a project scope into
 *     `global`: scope is the owner's isolation boundary.
 *   - The event is written by source `renor-dreamer`. Its statement says why, and names the ledger events it relied on.
 *   - A group about a collection predicate is never superseded here (collection.ts): it is skipped and flagged `both-may-hold`.
 *   - It is written only if the older fact is still the current one (`expectCurrentEvent`): an agent that corrected it
 *     while the model was thinking wins. The newer fact and every intermediate one must still be live and current too
 *     (`expectLiveEvents`): a source retired, erased or replaced meanwhile refuses the write.
 */

export const DREAMER_SOURCE = 'renor-dreamer';

/** Whether a value saved in scope `from` may replace the value of a fact in scope `into`. */
export function scopeMayReplace(from: string, into: string): boolean {
  return from === into || from === 'global';
}

export interface PlannedWrite {
  /** The fact that is replaced: its subject, predicate and scope receive the write. */
  older: JudgedFact;
  /** The fact whose value is written: the last of the chain of replacements. */
  newer: JudgedFact;
  /** The facts between them, when the newer one was itself replaced by a still newer one. */
  via: JudgedFact[];
  reason: string;
  statement: string;
}

export interface SkippedUpdate {
  older: JudgedFact;
  newer: JudgedFact;
  reason: string;
  /** `both-may-hold`: the collection guard (collection.ts) held the write back; the group is reported, not superseded. */
  flag?: 'both-may-hold';
}


/** What a dreamer write records about how it was made: the prompt version and the model, and whether a second look agreed. */
export interface WriteProvenance {
  promptVersion: string;
  model: string;
  /** The second look's mode (review.ts), when one was made on this kind of pair. */
  secondLook?: string;
}

/**
 * The ledger statement of a dreamer write: who and how (the dreamer, the prompt version, the model, a second look), the
 * model's reason, which event it replaces and which events it relied on. It names the facts by event and by subject and
 * predicate and does not repeat either value: a reply about the new value then does not carry the old one as a memory.
 */
export function provenanceStatement(older: JudgedFact, newer: JudgedFact, via: JudgedFact[], reason: string, provenance: WriteProvenance): string {
  const relied = [older, ...via, newer].map(fact => fact.eventId).join(', ');
  const how = [DREAMER_SOURCE, provenance.promptVersion, oneLine(provenance.model, 60), ...(provenance.secondLook ? [`second look: ${provenance.secondLook}`] : [])].join(' · ');
  return [
    `[${how}] ${oneLine(reason, 160) || 'the newer fact replaces the older one'}.`,
    `Replaces event ${older.eventId} (${oneLine(older.subject, 60)} · ${oneLine(older.predicate, 40)} · ${older.scope})`,
    `with the value of event ${newer.eventId} (${oneLine(newer.subject, 60)} · ${newer.scope}).`,
    `Relied on events: ${relied}.`,
  ].join(' ');
}

/**
 * The writes a group's labels allow. `facts` are oldest first (candidates.ts). Each older fact is replaced by the newest
 * fact labelled "updates" over it, and a replacement that was itself replaced hands on its own replacement, so the value
 * written is the last one in the chain, never an intermediate one.
 */
export function planWrites(kind: ClusterKind, facts: JudgedFact[], pairs: PairVerdict[], provenance: WriteProvenance = { promptVersion: 'unknown', model: 'unknown' }): { writes: PlannedWrite[]; skipped: SkippedUpdate[] } {
  const position = new Map(facts.map((fact, i) => [fact.id, i]));
  const replacedBy = new Map<number, { fact: JudgedFact; reason: string }>();
  for (const pair of pairs) {
    if (pair.verdict !== 'updates') continue;
    const o = position.get(pair.older);
    const n = position.get(pair.newer);
    if (o === undefined || n === undefined || n <= o) continue; // the model does not decide which is older
    const held = replacedBy.get(pair.older);
    if (!held || position.get(held.fact.id)! < n) replacedBy.set(pair.older, { fact: facts[n], reason: pair.reason });
  }
  const writes: PlannedWrite[] = [];
  const skipped: SkippedUpdate[] = [];
  const collection = collectionVerdict(kind, facts, pairs);
  for (const older of facts) {
    const first = replacedBy.get(older.id);
    if (!first) continue;
    const via: JudgedFact[] = [];
    let last = first.fact;
    for (let next = replacedBy.get(last.id); next; next = replacedBy.get(last.id)) {
      via.push(last);
      last = next.fact;
    }
    if (kind === 'predicate') {
      skipped.push({ older, newer: last, reason: 'predicate drift is named, not written: one predicate\'s value is not another\'s replacement' });
    } else if (collection.collection) {
      skipped.push({ older, newer: last, reason: `a collection predicate (${collection.why}): both may hold`, flag: 'both-may-hold' });
    } else if (!scopeMayReplace(last.scope, older.scope)) {
      skipped.push({ older, newer: last, reason: `a value saved in ${last.scope} may not replace one in ${older.scope}` });
    } else if (normDedupeValue(last.object) === normDedupeValue(older.object)) {
      skipped.push({ older, newer: last, reason: 'the older fact already says the same' });
    } else {
      writes.push({ older, newer: last, via, reason: first.reason, statement: provenanceStatement(older, last, via, first.reason, provenance) });
    }
  }
  return { writes, skipped };
}

export interface AppliedWrite {
  write: PlannedWrite;
  /** Set when the write landed. */
  receipt?: MemoryReceipt;
  /** Set when it did not: the older fact had changed since it was judged, or the lifecycle refused the input. */
  refused?: string;
}

/** Write the planned supersedes, one at a time, through the lifecycle. Each is refused rather than forced when its older fact has changed. */
export async function applyWrites(
  target: { db: Database.Database; vaultPath: string; ledgerRelPath: string },
  writes: PlannedWrite[],
): Promise<AppliedWrite[]> {
  const out: AppliedWrite[] = [];
  for (const write of writes) {
    try {
      const receipt = await remember(target.db, target.vaultPath, target.ledgerRelPath, {
        subject: write.older.subject,
        predicate: write.older.predicate,
        object: write.newer.object,
        source: DREAMER_SOURCE,
        scope: write.older.scope,
        statement: write.statement,
        expectCurrentEvent: write.older.eventId,
        expectLiveEvents: [...write.via, write.newer].map(f => f.eventId),
      });
      out.push(receipt.action === 'supersede'
        ? { write, receipt }
        : { write, receipt, refused: `unexpected action ${receipt.action}` });
    } catch (err) {
      out.push({ write, refused: err instanceof StaleExpectationError ? 'the fact changed since it was judged' : oneLine(err instanceof Error ? err.message : String(err), 200) });
    }
  }
  return out;
}
