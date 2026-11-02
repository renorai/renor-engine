import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { buildAgentContext } from '../../src/mvp/agentMemory';
import type { Engine } from '../../src/mvp/engine';
import { remember, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { statusFreshnessMode, statusWindowHours } from '../../src/memory/statusFacts';

const cleanups: Array<() => void> = [];
const engine: Engine = { provider: null, vectorIndex: null, dims: null };
afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length) cleanups.pop()!();
});

const STATUS = [
  { subject: 'PR 648', predicate: 'status', object: 'PR 648 is not merged yet, waiting for review' },
  { subject: 'main branch', predicate: 'head', object: 'main is at commit 3f9a1c2e7b' },
  { subject: 'CI', predicate: 'state', object: 'build is failing on the lint step' },
  { subject: 'Backlog', predicate: 'count', object: '14 issues open' },
];
const DURABLE = [
  { subject: 'Package manager', predicate: 'preference', object: 'The user prefers pnpm over npm in every project' },
  { subject: 'Merge policy', predicate: 'decision', object: 'We decided PRs are squash-merged; never push to main' },
  { subject: 'Database', predicate: 'choice', object: 'Postgres on Supabase holds the control plane' },
  { subject: 'Review rule', predicate: 'rule', object: 'Always check whether the PR 648 style checks are green before asking for review' },
];

describe('statusWindowHours', () => {
  it.each(STATUS)('treats $subject as short-lived status', fact => {
    expect(statusWindowHours(fact)).not.toBeNull();
  });
  it.each(DURABLE)('leaves $subject alone', fact => {
    expect(statusWindowHours(fact)).toBeNull();
  });
});

// A decision is standing wording even when its object names a PR or a commit: the DURABLE match must see "decision".
const DECISIONS_NAMING_STATUS = [
  { subject: 'Freshness flag', predicate: 'decision', object: 'Keep RENOR_STATUS_FRESHNESS off until main is at a new commit 3f9a1c2e7b' },
  { subject: 'Freshness flag', predicate: 'open_decision', object: 'PR 648 is not merged yet, so the flag waits for it' },
  { subject: 'Reader layout', predicate: 'design_decision_2026-10-02', object: 'The advice exception is on; the PR 710 branch is not merged' },
];
// A record of a finished PR, review or task is history: its wording may name a state, but the state does not change.
const RECORDS_NAMING_STATUS = [
  { subject: 'PR 648', predicate: 'outcome', object: 'PR 648 is not merged yet, waiting for review' },
  { subject: 'PR 648', predicate: 'verdict', object: 'PR 648 is failing on the lint step' },
  { subject: 'PR 648', predicate: 'review_verdict', object: 'PR 648 review: MERGE, not merged yet' },
  { subject: 'PR 648', predicate: 'review verdict', object: 'PR 648 review is approved, waiting on CI' },
  { subject: 'PR 648', predicate: 'independent_review', object: 'PR 648 is not merged yet, reviewed at head abc1234' },
  { subject: 'Bench run', predicate: 'result', object: '14 tests failing before the fix, passing after' },
  { subject: 'PR 648', predicate: 'fix_verdict', object: 'PR 648 fix is blocked, not merged' },
];

describe('statusWindowHours with decisions and records', () => {
  it.each(DECISIONS_NAMING_STATUS)('leaves the decision $predicate alone even when its object names status', fact => {
    expect(statusWindowHours(fact)).toBeNull();
  });
  it.each(RECORDS_NAMING_STATUS)('leaves the record $predicate alone even when its object names status', fact => {
    expect(statusWindowHours(fact)).toBeNull();
  });
  it('still labels a real status whose predicate is not a record', () => {
    expect(statusWindowHours({ subject: 'PR 648', predicate: 'status', object: 'PR 648 is not merged yet' })).toBe(12);
  });
});

it('is off unless asked', () => {
  expect(statusFreshnessMode({})).toBe('off');
  expect(statusFreshnessMode({ RENOR_STATUS_FRESHNESS: '1' })).toBe('label');
  expect(statusFreshnessMode({ RENOR_STATUS_FRESHNESS: 'hide' })).toBe('hide');
});

async function aged(env: NodeJS.ProcessEnv, afterHours: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-freshness-'));
  const db = openDb(path.join(dir, '.memory-index/index.db'));
  runMigrations(db);
  cleanups.push(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const fact of [...STATUS, ...DURABLE]) await remember(db, dir, DEFAULT_LEDGER_REL, fact);
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + afterHours * 3_600_000 });
  const body = await buildAgentContext(db, engine, dir, { maxTokens: 4000, env: { RENOR_READ_HONESTY: '0', RENOR_CONTEXT_RELEVANCE: '0', ...env } });
  return body.facts as Array<{ subject: string; staleStatus?: string }>;
}

describe('get_context', () => {
  it('is unchanged with the switch off, however old the status', async () => {
    const facts = await aged({}, 72);
    expect(facts).toHaveLength(STATUS.length + DURABLE.length);
    expect(facts.some(f => f.staleStatus)).toBe(false);
  });

  it('keeps fresh status unlabelled', async () => {
    const facts = await aged({ RENOR_STATUS_FRESHNESS: '1' }, 1);
    expect(facts.some(f => f.staleStatus)).toBe(false);
  });

  it('labels stale status and only status', async () => {
    const facts = await aged({ RENOR_STATUS_FRESHNESS: '1' }, 72);
    expect(facts.filter(f => f.staleStatus).map(f => f.subject).sort()).toEqual(STATUS.map(f => f.subject).sort());
    expect(facts.find(f => f.subject === 'PR 648')!.staleStatus).toMatch(/3 days ago/);
  });

  it('hides stale status and keeps decisions and preferences', async () => {
    const facts = await aged({ RENOR_STATUS_FRESHNESS: 'hide' }, 72);
    expect(facts.map(f => f.subject).sort()).toEqual(DURABLE.map(f => f.subject).sort());
  });
});
