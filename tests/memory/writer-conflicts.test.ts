/**
 * Writer conflicts (memory/writerConflicts.ts). A value that a different writer replaces stays visible, marked, in the
 * default reads until the writer that lost it saves the same subject and predicate again. The writer is the connection's
 * gateway-named agent (x-renor-agent), never the source a caller types. A correction by the same writer is unchanged.
 *
 * Writers are named connections on one hosted workspace (tests/helpers/hiveHarness.ts). No embeddings, no network.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { DEFAULT_LEDGER_REL, factsFor, remember, replayLedger, resolveLedgerPath } from '../../src/memory/lifecycle';
import { writerConflictLine, writerConflictLines } from '../../src/memory/writerConflicts';
import { withFactHits } from '../../src/mvp/factsLane';
import { named, restoreEnv, startWorkspace, type Harness } from '../helpers/hiveHarness';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

afterAll(restoreEnv);

const FACT = { subject: 'Launch city', predicate: 'location' };

interface Fact { object: string; current: boolean; source?: string; writerConflict?: string; validFrom: string }

/** The facts a default read returns for the launch city, from the connection's point of view. */
async function readFacts(ws: Harness, client: Client, extra: Record<string, unknown> = {}): Promise<Fact[]> {
  const res = await ws.call(client, 'retrieve_memory', { ...FACT, ...extra });
  expect(res.isError).toBe(false);
  return res.body.facts as Fact[];
}

const current = (facts: Fact[]): Fact[] => facts.filter(f => f.current);

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('writer conflicts over the hosted tools', () => {
  it('a later save by the same writer replaces the value with no conflict, as before', async () => {
    const ws = await startWorkspace();
    try {
      const owner = await ws.connect(named('owner-agent'));
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Lisbon' });
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Tokyo' });

      const facts = await readFacts(ws, owner);
      expect(current(facts).map(f => f.object)).toEqual(['Tokyo']);
      expect(current(facts)[0]).not.toHaveProperty('writerConflict');

      const history = await readFacts(ws, owner, { include_history: true });
      expect(history.map(f => f.object).sort()).toEqual(['Lisbon', 'Tokyo']);
    } finally {
      await ws.close();
    }
  });

  it('a save by a different writer replaces the value and keeps the replaced one as a marked conflict', async () => {
    const ws = await startWorkspace();
    try {
      const owner = await ws.connect(named('owner-agent'));
      const other = await ws.connect(named('grok-bot'));
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Lisbon' });
      const claim = await ws.call(other, 'save_memory', { ...FACT, object: 'Reykjavik' });
      expect(claim.body.action).toBe('supersede');

      const facts = await readFacts(ws, owner);
      expect(current(facts).map(f => f.object)).toEqual(['Reykjavik']);
      expect(current(facts)[0].writerConflict).toMatch(/^CONFLICT: "Lisbon" by owner-agent, \d{4}-\d{2}-\d{2}\. /);

      const history = await readFacts(ws, owner, { include_history: true });
      expect(history.find(f => f.object === 'Lisbon')?.current).toBe(false);
      expect(history.find(f => f.object === 'Reykjavik')?.writerConflict).toContain('"Lisbon" by owner-agent');
    } finally {
      await ws.close();
    }
  });

  it('get_context shows the same conflict beside the current fact', async () => {
    const ws = await startWorkspace();
    try {
      const owner = await ws.connect(named('owner-agent'));
      const other = await ws.connect(named('grok-bot'));
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Lisbon' });
      await ws.call(other, 'save_memory', { ...FACT, object: 'Reykjavik' });

      const context = await ws.call(owner, 'get_context', { query: 'What is the launch city?', max_tokens: 800 });
      expect(context.isError).toBe(false);
      const shown = context.body.facts.find((f: Fact) => f.object === 'Reykjavik');
      expect(shown.writerConflict).toContain('"Lisbon" by owner-agent');
    } finally {
      await ws.close();
    }
  });

  it('memory_map and search_text show the same line beside the current value, and not beside the replaced one', async () => {
    const ws = await startWorkspace();
    try {
      const owner = await ws.connect(named('owner-agent'));
      const other = await ws.connect(named('grok-bot'));
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Lisbon' });
      await ws.call(other, 'save_memory', { ...FACT, object: 'Reykjavik' });

      const map = await ws.call(owner, 'memory_map', {});
      expect(map.isError).toBe(false);
      const mapped = map.body.facts as Array<{ object: string; writerConflict?: string }>;
      expect(mapped.find(f => f.object === 'Reykjavik')?.writerConflict).toContain('"Lisbon" by owner-agent');
      expect(mapped.find(f => f.object === 'Lisbon')).not.toHaveProperty('writerConflict');

      const text = await ws.call(owner, 'search_text', { query: 'Reykjavik' });
      expect(text.isError).toBe(false);
      const hit = (text.body.results as Array<{ reason?: string; writerConflict?: string }>).find(h => h.reason === 'fact');
      expect(hit?.writerConflict).toContain('"Lisbon" by owner-agent');
    } finally {
      await ws.close();
    }
  });

  it('a caller cannot make its save pass as the owner by typing the owner\'s name as the source', async () => {
    const ws = await startWorkspace();
    try {
      const owner = await ws.connect(named('owner-agent'));
      const other = await ws.connect(named('grok-bot'));
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Lisbon' });
      const claim = await ws.call(other, 'save_memory', { ...FACT, object: 'Reykjavik', source: 'owner-agent' });
      expect(claim.isError).toBe(false);

      const facts = await readFacts(ws, owner);
      expect(current(facts)[0].source).toBe('grok-bot');
      expect(current(facts)[0].writerConflict).toContain('"Lisbon" by owner-agent');
    } finally {
      await ws.close();
    }
  });

  it('the displaced writer clears the conflict by saving the subject and predicate again, with the replaced value', async () => {
    const ws = await startWorkspace();
    try {
      const owner = await ws.connect(named('owner-agent'));
      const other = await ws.connect(named('grok-bot'));
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Lisbon' });
      await ws.call(other, 'save_memory', { ...FACT, object: 'Reykjavik' });
      expect(current(await readFacts(ws, owner))[0].writerConflict).toContain('"Lisbon" by owner-agent');
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Lisbon' });

      const facts = await readFacts(ws, owner);
      expect(current(facts).map(f => f.object)).toEqual(['Lisbon']);
      expect(current(facts)[0]).not.toHaveProperty('writerConflict');
    } finally {
      await ws.close();
    }
  });

  it('the displaced writer clears the conflict by saving the current value', async () => {
    const ws = await startWorkspace();
    try {
      const owner = await ws.connect(named('owner-agent'));
      const other = await ws.connect(named('grok-bot'));
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Lisbon' });
      await ws.call(other, 'save_memory', { ...FACT, object: 'Reykjavik' });
      expect(current(await readFacts(ws, owner))[0].writerConflict).toContain('"Lisbon" by owner-agent');
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Reykjavik' });

      const facts = await readFacts(ws, owner);
      expect(current(facts)).toHaveLength(1);
      expect(current(facts)[0].object).toBe('Reykjavik');
      expect(current(facts)[0]).not.toHaveProperty('writerConflict');
    } finally {
      await ws.close();
    }
  });

  it('a third writer does not clear the conflict, and both replaced values stay listed', async () => {
    const ws = await startWorkspace();
    try {
      const owner = await ws.connect(named('owner-agent'));
      const other = await ws.connect(named('grok-bot'));
      const third = await ws.connect(named('mira-agent'));
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Lisbon' });
      await ws.call(other, 'save_memory', { ...FACT, object: 'Reykjavik' });
      await ws.call(third, 'save_memory', { ...FACT, object: 'Tokyo' });

      const facts = await readFacts(ws, owner);
      expect(current(facts)[0].object).toBe('Tokyo');
      expect(current(facts)[0].writerConflict).toContain('"Lisbon" by owner-agent');
      expect(current(facts)[0].writerConflict).toContain('"Reykjavik" by grok-bot');
    } finally {
      await ws.close();
    }
  });

  it('the current writer\'s own correction does not clear a conflict owed by the displaced writer', async () => {
    const ws = await startWorkspace();
    try {
      const owner = await ws.connect(named('owner-agent'));
      const other = await ws.connect(named('grok-bot'));
      await ws.call(owner, 'save_memory', { ...FACT, object: 'Lisbon' });
      await ws.call(other, 'save_memory', { ...FACT, object: 'Reykjavik' });
      await ws.call(other, 'save_memory', { ...FACT, object: 'Reykjavik, confirmed by grok' });

      const facts = await readFacts(ws, owner);
      expect(current(facts)[0].object).toBe('Reykjavik, confirmed by grok');
      expect(current(facts)[0].writerConflict).toContain('"Lisbon" by owner-agent');
    } finally {
      await ws.close();
    }
  });

  it('connections with no name are one writer, so their saves replace each other as before', async () => {
    const ws = await startWorkspace();
    try {
      const first = await ws.connect({});
      const second = await ws.connect({});
      await ws.call(first, 'save_memory', { ...FACT, object: 'Lisbon' });
      await ws.call(second, 'save_memory', { ...FACT, object: 'Reykjavik' });

      const facts = await readFacts(ws, first);
      expect(current(facts).map(f => f.object)).toEqual(['Reykjavik']);
      expect(current(facts)[0]).not.toHaveProperty('writerConflict');
    } finally {
      await ws.close();
    }
  });
});

describe('writer conflicts survive a rebuild from the ledger', () => {
  it('a replay of the ledger reads the same conflict, and names the writer only where it differs from the source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-replay-'));
    const memoryDir = path.join(dir, 'vault');
    fs.mkdirSync(memoryDir);
    const db = openDb(path.join(dir, 'index.db'));
    const rebuilt = openDb(path.join(dir, 'rebuilt.db'));
    try {
      runMigrations(db);
      await remember(db, memoryDir, DEFAULT_LEDGER_REL, { ...FACT, object: 'Lisbon', source: 'owner-agent', writer: 'owner-agent' });
      await remember(db, memoryDir, DEFAULT_LEDGER_REL, { ...FACT, object: 'Reykjavik', source: 'system', writer: 'grok-bot' });

      const ledger = fs.readFileSync(resolveLedgerPath(memoryDir, DEFAULT_LEDGER_REL), 'utf8');
      expect(ledger.match(/^- writer: .*$/gm)).toEqual(['- writer: grok-bot']);

      const id = (factsFor(db, FACT.subject) as Array<{ valid_to: string | null; event_id: string }>).find(f => f.valid_to === null)!.event_id;
      const live = writerConflictLines(db, [id]).get(id);
      expect(live).toContain('"Lisbon" by owner-agent');

      runMigrations(rebuilt);
      await replayLedger(rebuilt, memoryDir, DEFAULT_LEDGER_REL);
      expect(writerConflictLines(rebuilt, [id]).get(id)).toBe(live);
    } finally {
      db.close();
      rebuilt.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the fact lane of search_memory', () => {
  // search_memory returns fact hits only with semantic search, which the hosted test harness does not have, so the lane is
  // read directly: the function search_memory calls for its fact hits (mvp/factsLane.ts withFactHits).
  it('a fact hit for the replacing value carries the same conflict line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-lane-'));
    const memoryDir = path.join(dir, 'vault');
    fs.mkdirSync(memoryDir);
    const db = openDb(path.join(dir, 'index.db'));
    try {
      runMigrations(db);
      await remember(db, memoryDir, DEFAULT_LEDGER_REL, { ...FACT, object: 'Lisbon', source: 'owner-agent', writer: 'owner-agent' });
      await remember(db, memoryDir, DEFAULT_LEDGER_REL, { ...FACT, object: 'Reykjavik', source: 'system', writer: 'grok-bot' });

      const hits = withFactHits(db, { memoryDir, ledgerRelPath: DEFAULT_LEDGER_REL }, [], {
        query: 'launch city location Reykjavik', match: 'any', limit: 5,
      });
      const hit = hits.find(h => h.reason === 'fact' && h.text.includes('Reykjavik'));
      expect(hit?.writerConflict).toContain('"Lisbon" by owner-agent');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('RENOR_UPDATE_AS_HISTORY', () => {
  const one = [{ writer: 'owner-agent', object: 'Lisbon', validFrom: '2026-10-01T00:00:00Z', byEvent: 'e2' }];
  const two = [...one, { writer: 'third-bot', object: 'Oslo', validFrom: '2026-10-02T00:00:00Z', byEvent: 'e3' }];
  const prev = process.env.RENOR_UPDATE_AS_HISTORY;
  afterAll(() => { if (prev === undefined) delete process.env.RENOR_UPDATE_AS_HISTORY; else process.env.RENOR_UPDATE_AS_HISTORY = prev; });

  it('is off by default: the CONFLICT line is unchanged', () => {
    delete process.env.RENOR_UPDATE_AS_HISTORY;
    expect(writerConflictLine(one)).toMatch(/^CONFLICT: "Lisbon" by owner-agent, 2026-10-01\. /);
  });

  it('on, an ordinary update by another agent reads as history, not CONFLICT', () => {
    process.env.RENOR_UPDATE_AS_HISTORY = '1';
    const line = writerConflictLine(one);
    expect(line).toBe('replaced "Lisbon" (owner-agent, 2026-10-01); the value shown is current.');
    expect(line).not.toContain('CONFLICT');
  });

  it('on, writers still in disagreement with two or more different writers stay a CONFLICT', () => {
    process.env.RENOR_UPDATE_AS_HISTORY = '1';
    expect(writerConflictLine(two)).toMatch(/^CONFLICT: /);
  });
});
