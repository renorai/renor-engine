import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'fs';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { newExplainTrace, explainReply, noteDrop, explainAdvertised, searchExplainEnabled } from '../../src/retrieval/explain';
import type { RetrievalProbe } from '../../src/retrieval/semantic';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { tmpPath } from '../helpers/tmpPath';

const DB = tmpPath('test-search-explain.db');
afterEach(() => { if (fs.existsSync(DB)) fs.unlinkSync(DB); });

function seed(count: number) {
  const db = openDb(DB); runMigrations(db);
  const idx = new VectorIndex(db, 4); idx.initTable();
  for (let i = 0; i < count; i++) {
    const path = `/v/Sessions/s${i}.md`;
    db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?)').run(path, 'Session', null, `n${i}`, '2026-03-30', '{}');
    db.prepare('INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)')
      .run(path, '', `Rowan moved to Port Alder in 2026, note ${i}, and told the whole team about the plans for ${i}.`, 0, 2, 5, `h${i}`);
    const id = (db.prepare('SELECT id FROM chunks WHERE chunk_hash = ?').get(`h${i}`) as { id: number }).id;
    idx.upsert(id, [1, 0, 0, 0]);
  }
  const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.9, 0, 0, 0]]) };
  return { db, idx, provider };
}

describe('search explain', () => {
  it('says 12 candidates, 5 kept and 7 dropped for the budget', async () => {
    const { db, idx, provider } = seed(12);
    const probe: RetrievalProbe = { explain: newExplainTrace(true)! };
    const result = await retrieveContext(db, idx, provider, 'anything', 5, [], {}, { probe });
    const explain = explainReply(probe.explain!) as { stages: Array<{ stage: string; count: number }>; droppedCounts: Record<string, number>; dropped: unknown[] };
    expect(explain.stages.find(s => s.stage === 'candidates')?.count).toBe(12);
    expect(explain.stages.find(s => s.stage === 'window')?.count).toBe(5);
    expect(explain.droppedCounts.budget).toBe(7);
    expect(explain.dropped.length).toBeLessThanOrEqual(5);
    expect(result.hits.filter(h => h.reason !== 'session-expand').length).toBeGreaterThan(0);
    expect(JSON.stringify(explain)).not.toContain('Port Alder'); // ids only, no note text
  });

  it('lists a note the scope refuses as dropped with reason scope', async () => {
    const { db, idx, provider } = seed(12);
    const probe: RetrievalProbe = { explain: newExplainTrace(true)! };
    const scope = { shows: (h: { notePath: string }) => h.notePath !== '/v/Sessions/s3.md', chunkIds: () => [] as number[] };
    await retrieveContext(db, idx, provider, 'anything', 5, [], {}, { probe, scope });
    expect(explainReply(probe.explain!).droppedCounts).toMatchObject({ scope: 1 });
  });

  it('counts a chunk once per reason when the filter asks about it repeatedly', () => {
    const trace = newExplainTrace(true)!;
    for (let pass = 0; pass < 4; pass++) noteDrop(trace, 7, 'scope');
    noteDrop(trace, 8, 'scope');
    noteDrop(trace, 7, 'budget');
    const reply = explainReply(trace) as { droppedCounts: Record<string, number>; dropped: { id: string; reason: string }[] };
    expect(reply.droppedCounts).toEqual({ scope: 2, budget: 1 });
    expect(reply.dropped).toHaveLength(3);
  });

  it('returns the same hits with or without explain', async () => {
    const { db, idx, provider } = seed(12);
    const plain = await retrieveContext(db, idx, provider, 'anything', 5, [], {}, { probe: {} });
    const explained = await retrieveContext(db, idx, provider, 'anything', 5, [], {}, { probe: { explain: newExplainTrace(true)! } });
    expect(explained).toEqual(plain);
  });

  it('collects nothing unless asked, and RENOR_SEARCH_EXPLAIN=0 ignores the argument', () => {
    expect(newExplainTrace(undefined)).toBeUndefined();
    expect(newExplainTrace(false)).toBeUndefined();
    expect(newExplainTrace(true, { RENOR_SEARCH_EXPLAIN: '0' })).toBeUndefined();
    expect(newExplainTrace(true, { RENOR_SEARCH_EXPLAIN: 'off' })).toBeUndefined();
    expect(newExplainTrace(true, {})).toBeDefined();
    expect(searchExplainEnabled({})).toBe(true);
  });

  it('is advertised in the full profile only', () => {
    expect(explainAdvertised({}, null, {})).toBe(true);
    expect(explainAdvertised({ tools: new Set(['get_context']) }, null, {})).toBe(false);
    expect(explainAdvertised({}, 'coding', {})).toBe(false);
    expect(explainAdvertised({}, null, { RENOR_SEARCH_EXPLAIN: '0' })).toBe(false);
  });
});
