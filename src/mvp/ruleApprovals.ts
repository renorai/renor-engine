import { createHash } from 'node:crypto';
import type Database from '../db/sqlite';

export interface RuleIdentity { eventId?: string | null; scope?: string | null; predicate?: string | null; object?: string | null; source?: string | null }

export function ruleApprovalsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|on|true|yes)$/i.test(env.RENOR_RULE_APPROVALS?.trim() ?? '');
}

/** Must stay byte-identical to claude-code-plugin/hooks/standing-rules/approvals.mjs. */
export function ruleKey(rule: RuleIdentity): string {
  const parts = [rule.eventId ?? '', rule.scope ?? 'global', rule.predicate ?? '', rule.object ?? '', rule.source ?? ''];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function approvedRuleKeys(db: Database.Database): Set<string> {
  return new Set((db.prepare('SELECT rule_key FROM standing_rule_approvals').all() as Array<{ rule_key: string }>).map(row => row.rule_key));
}

/**
 * Approves or revokes standing rules by key. Every key is checked before anything is written: an approve key must be a
 * current standing rule with an event id, and a revoke key must already be approved. Either check failing throws and
 * changes nothing. Returns the number of approval rows actually written or removed.
 */
export function updateRuleApprovals(db: Database.Database, action: 'approve' | 'revoke', keys: string[]): number {
  const unique = [...new Set(keys)];
  const run = db.transaction(() => {
    if (action === 'revoke') {
      const exists = db.prepare('SELECT 1 FROM standing_rule_approvals WHERE rule_key = ?');
      for (const key of unique) {
        if (!exists.get(key)) throw new Error('revoke target is not an approved standing rule');
      }
      const remove = db.prepare('DELETE FROM standing_rule_approvals WHERE rule_key = ?');
      let changed = 0;
      for (const key of unique) changed += remove.run(key).changes;
      return changed;
    }
    const facts = db.prepare(`SELECT f.event_id AS eventId, COALESCE(f.scope, 'global') AS scope,
      f.predicate, f.object_text AS object, f.author AS source FROM facts f
      JOIN entities e ON e.id=f.subject_entity_id
      WHERE f.valid_to IS NULL AND lower(replace(replace(e.canonical_name, '_', ' '), '-', ' ')) IN ('standing rule','standing rules')`).all() as RuleIdentity[];
    const byKey = new Map(facts.map(fact => [ruleKey(fact), fact.eventId]));
    for (const key of unique) {
      if (!byKey.get(key)) throw new Error('approval target is not a current standing rule with an event id');
    }
    const put = db.prepare(`INSERT INTO standing_rule_approvals(rule_key,event_id,approved_at,via)
      VALUES(?,?,?, 'terminal') ON CONFLICT(rule_key) DO UPDATE SET approved_at=excluded.approved_at, via=excluded.via`);
    const now = new Date().toISOString();
    let changed = 0;
    for (const key of unique) changed += put.run(key, byKey.get(key), now).changes;
    return changed;
  });
  return run();
}
