import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { restoreWorkspaceEnv, startWorkspace, type Workspace } from '../helpers/mvpWorkspace';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Retiring a fact over the real MCP surface (the captain, 2026-10-07: "if the agent remove he can just reverse"). After
 * retire_memory takes `fact:<eventId>`, no read an agent has returns the value: get_context (with and without history),
 * search_memory, search_text, retrieve_memory (current and history), memory_map's facts and events, lookup_entity and
 * memory_status's count. restore_memory brings every one of those answers back as it was. Synthetic data, the
 * deterministic eval-hash embeddings, no network.
 */

const open: Workspace[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
afterAll(restoreWorkspaceEnv);

async function workspace(): Promise<Workspace> {
  const ws = await startWorkspace(() => new EvalHashEmbeddingProvider());
  open.push(ws);
  return ws;
}

async function ok(ws: Workspace, name: string, args: Record<string, unknown> = {}) {
  const res = await ws.call(name, args);
  expect(res.isError, `${name} ${JSON.stringify(res.body)}`).toBe(false);
  return res.body;
}

/**
 * What changes between two identical reads anyway: when they were made, how long they took, and the far decimals of a
 * score, whose recency part moves with the clock.
 */
function stable(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body), (key, value) => {
    if (['generatedAt', 'elapsedMs', 'tookMs', 'ms'].includes(key)) return undefined;
    return key === 'score' && typeof value === 'number' ? Number(value.toFixed(5)) : value;
  });
}

/** Every read an agent or the dashboard has of a fact about Kestrel. */
async function reads(ws: Workspace) {
  const map = await ok(ws, 'memory_map');
  return {
    context: await ok(ws, 'get_context', { query: 'What is the Kestrel staging database?', max_tokens: 2000 }),
    contextHistory: await ok(ws, 'get_context', { query: 'What is the Kestrel staging database?', max_tokens: 2000, include_history: true }),
    search: await ok(ws, 'search_memory', { query: 'Kestrel staging database quokkadb' }),
    text: await ok(ws, 'search_text', { query: 'quokkadb' }),
    current: await ok(ws, 'retrieve_memory', { subject: 'Kestrel' }),
    history: await ok(ws, 'retrieve_memory', { subject: 'Kestrel', include_history: true }),
    mapFacts: map.facts,
    mapEvents: map.events,
    mapThings: map.things,
  };
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('retire_memory and restore_memory with a fact', () => {
  it('revives an identical earlier statement for get_context when its restatement is retired', async () => {
    const ws = await workspace();
    const first = await ok(ws, 'remember', { statement: 'Kestrel staging runs on Postgres 14.', subject: 'Kestrel', predicate: 'staging_database', object: 'Postgres 14' });
    expect(first.action).toBe('store');
    const restatement = await ok(ws, 'remember', { statement: 'Confirmed: Kestrel staging is on Postgres 14.', subject: 'Kestrel', predicate: 'staging_database', object: 'Postgres 14' });
    expect(restatement).toMatchObject({ action: 'supersede', closed: { object: 'Postgres 14' } });

    await ok(ws, 'retire_memory', { id: `fact:${restatement.eventId}` });
    const context = await ok(ws, 'get_context', { query: 'What database does Kestrel staging use?' });
    expect(context.facts).toEqual([expect.objectContaining({ subject: 'Kestrel', predicate: 'staging_database', object: 'Postgres 14' })]);
  });

  it('a retired fact leaves every read, its history stays, and restore brings every read back as it was', async () => {
    const ws = await workspace();
    await ok(ws, 'remember', { statement: 'Kestrel staging runs on Postgres 14.', subject: 'Kestrel', predicate: 'staging_database', object: 'Postgres 14' });
    const saved = await ok(ws, 'remember', { statement: 'We moved Kestrel staging to QuokkaDB.', subject: 'Kestrel', predicate: 'staging_database', object: 'QuokkaDB' });
    expect(saved.action).toBe('supersede');

    const before = await reads(ws);
    const { mapThings: thingsBefore, ...valueReads } = before;
    for (const [name, body] of Object.entries(valueReads)) expect(JSON.stringify(body), name).toMatch(/quokkadb/i);
    expect(thingsBefore).toEqual([expect.objectContaining({ name: 'Kestrel', currentFacts: 1 })]);
    const fact = before.mapFacts.find((f: any) => f.object === 'QuokkaDB');
    expect(fact.eventId).toBe(saved.eventId);

    const retired = await ok(ws, 'retire_memory', { id: `fact:${fact.eventId}` });
    expect(retired).toMatchObject({ ok: true, id: `fact:${saved.eventId}`, action: 'retired', title: 'Kestrel staging_database: QuokkaDB', current: true });

    const after = await reads(ws);
    for (const [name, body] of Object.entries(after)) expect(JSON.stringify(body), name).not.toMatch(/quokkadb/i);
    expect(after.mapThings).toEqual([expect.objectContaining({ name: 'Kestrel', currentFacts: 0 })]);
    // The different value it replaced stays replaced: no current value, and the old one only as history.
    expect(after.current.facts).toEqual([]);
    expect(after.current.known).toBe(true);
    expect(after.history.facts.map((f: any) => [f.object, f.current])).toEqual([['Postgres 14', false]]);
    expect(after.mapEvents.filter((e: any) => e.action === 'retire')).toEqual([
      expect.objectContaining({ memoryId: `fact:${saved.eventId}`, summary: 'Kestrel staging_database' }),
    ]);

    // Listed among the retired, where the dashboard and an agent find what to restore.
    const map = await ok(ws, 'memory_map');
    expect(map.retired).toEqual([expect.objectContaining({ id: `fact:${saved.eventId}`, memoryId: `fact:${saved.eventId}`, kind: 'fact', title: 'Kestrel staging_database: QuokkaDB' })]);
    const lookup = await ok(ws, 'memory_map', { query: 'quokkadb' });
    expect(lookup.memories).toEqual([]);
    expect(lookup.retired.map((r: any) => r.id)).toEqual([`fact:${saved.eventId}`]);
    expect((await ok(ws, 'memory_map', { query: 'quokkadb', scope: 'project:elsewhere' })).retired).toEqual([]);

    const restored = await ok(ws, 'restore_memory', { id: `fact:${saved.eventId}` });
    expect(restored).toMatchObject({ ok: true, id: `fact:${saved.eventId}`, action: 'restored', current: true });
    const back = await reads(ws);
    const { mapEvents: eventsBack, ...restBack } = back;
    const { mapEvents: eventsBefore, ...restBefore } = before;
    expect(stable(restBack)).toEqual(stable(restBefore));
    // The log gained the retire and the restore, and holds the save again.
    expect(eventsBack.slice(2)).toEqual(eventsBefore);
    expect(eventsBack.slice(0, 2).map((e: any) => e.action)).toEqual(['restore', 'retire']);
    expect((await ok(ws, 'memory_map')).retired).toEqual([]);
  });

  it('a subject whose only fact is retired is named by no lookup and counted by no status', async () => {
    const ws = await workspace();
    const probe = await ok(ws, 'remember', { statement: 'Test probe value.', subject: 'Zephyrine probe', predicate: 'marker', object: 'test value' });
    const status = await ok(ws, 'memory_status');
    expect((await ok(ws, 'lookup_entity', { name: 'Zephyrine probe' })).entity).toMatchObject({ canonicalName: 'Zephyrine probe' });

    await ok(ws, 'retire_memory', { id: `fact:${probe.eventId}` });
    const miss = await ok(ws, 'lookup_entity', { name: 'Zephyrine probe' });
    expect(miss.entity).toBeNull();
    const after = await ok(ws, 'memory_status');
    expect(after.entities).toBe(status.entities - 1);
    expect(after.facts).toBe(status.facts - 1);
    expect(miss.entitiesIndexed).toBe(after.entities);
    expect((await ok(ws, 'retrieve_memory', { subject: 'Zephyrine probe' })).known).toBe(false);
    expect((await ok(ws, 'memory_map')).things).toEqual([]);

    await ok(ws, 'restore_memory', { id: `fact:${probe.eventId}` });
    expect((await ok(ws, 'memory_status')).entities).toBe(status.entities);
    expect((await ok(ws, 'lookup_entity', { name: 'Zephyrine probe' })).entity).toMatchObject({ canonicalName: 'Zephyrine probe' });
  });
});
