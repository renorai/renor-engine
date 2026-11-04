import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { chunksWithoutVectors } from '../../src/embeddings/rebuild';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { createEmbeddingProvider, DEFAULT_EMBED_BUDGETS, engineFinishIndexInBackground, runningBackgroundIndex, UNFINISHED_FILES } from '../../src/mvp/engine';
import { startVertexStub, type VertexStub } from '../helpers/vertexStub';
import { startWorkspace, vertexConfigFor, restoreWorkspaceEnv, type Workspace } from '../helpers/mvpWorkspace';

/**
 * What an agent waits when Google's embedding service refuses or stalls, through the product's own Vertex stack
 * (`createEmbeddingProvider`) pointed at a local stub, and the real MCP tools over HTTP. No Google call, no credential.
 *
 * On 2026-10-06 the service answered most calls with 429 for 17 minutes while the project used about 1% of its quota.
 * The engine retried (8 attempts, up to 120 s apart) inside the tool call, so `remember` took 645-777 s and
 * `get_context` 497 s. Measured on main with this stub and the product's backoff, a 40 s refusal made `remember` take
 * 72 s, `get_context` 74 s and `search_memory` 73 s (scripts/bench/embed-throttle-latency.ts).
 *
 * The calls here are made while the stub is still refusing (or silent), so a call that waits for the service
 * cannot answer at all: it is cut off by the test's timeout, not passed by a loose number.
 */

const TEST_TIMEOUT_MS = 30_000;
/** What a call that does not wait on the service costs, with a wide margin for a loaded machine (a call takes ~100 ms). */
const PROMPT_MS = 4_000;

let stub: VertexStub | undefined;
let workspace: Workspace | undefined;
let provider: (EmbeddingProvider & { close?: () => void }) | null = null;

/**
 * This file exercises the throttle/recovery contract over `vertexConfigFor`, so the workspace's embedding namespace is
 * the calibrated `vertex:gemini-embedding-001:768` while the stub behind it answers with deterministic lexical hash
 * vectors (vertexStub.ts). Those cosines are not the hosted model's, so the calibrated 0.63 floor is meaningless here
 * and drops a genuine lexical match. The floor is off for this file only; the shipped default is search-hit-floor.test.ts.
 */
let savedFloor: string | undefined;
beforeEach(() => {
  savedFloor = process.env.RENOR_SEARCH_HIT_FLOOR;
  process.env.RENOR_SEARCH_HIT_FLOOR = '0';
});

afterEach(async () => {
  if (savedFloor === undefined) delete process.env.RENOR_SEARCH_HIT_FLOOR;
  else process.env.RENOR_SEARCH_HIT_FLOOR = savedFloor;
  savedFloor = undefined;
  vi.restoreAllMocks();
  delete process.env.RENOR_EMBED_WRITE_BUDGET_MS;
  delete process.env.RENOR_EMBED_READ_BUDGET_MS;
  await workspace?.close();
  provider?.close?.();
  await stub?.close();
  workspace = undefined;
  provider = null;
  stub = undefined;
  restoreWorkspaceEnv();
});

/** The product's embedding stack on the stub. `fastRetry` shortens the waits between a patient call's attempts. */
async function start(options: { fastRetry?: boolean } = {}): Promise<{ ws: Workspace; stub: VertexStub }> {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stub = await startVertexStub();
  workspace = await startWorkspace((config) => {
    provider = createEmbeddingProvider(
      vertexConfigFor(config, stub!.keyFile),
      { baseUrl: stub!.baseUrl, ...(options.fastRetry ? { retry: { waitMs: () => 100 } } : {}) },
    );
    return provider;
  });
  return { ws: workspace, stub };
}

const NOTE = 'The quarterly access review is due on November 15.';
const QUESTION = 'When is the quarterly access review due?';

/** Wait until `done()` holds, polling; a background job (or what `what` names) is what is being waited for. */
async function until(done: () => boolean, ms = 20_000, what = 'the background index'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// The secret guard is on by default. These tests store fixture text that the guard refuses (a credential-shaped or an
// identifier-shaped sentence that is incidental to what each test checks), so they run with it explicitly off.
const SAVED_GUARD = process.env.RENOR_SECRET_GUARD;
beforeAll(() => { process.env.RENOR_SECRET_GUARD = '0'; });
afterAll(() => { if (SAVED_GUARD === undefined) delete process.env.RENOR_SECRET_GUARD; else process.env.RENOR_SECRET_GUARD = SAVED_GUARD; });

describe('while the embedding service refuses (429)', () => {
  it('no tool waits on it: saves return with the memory kept, reads answer from keyword search, and a failed service is not asked again at once', async () => {
    const { ws, stub } = await start();
    await ws.call('remember', { statement: 'Kestrel uses Expo Router for navigation.' });
    expect(chunksWithoutVectors(ws.service.db)).toBe(0);
    // Hold the background job still, so the requests counted below are the calls', not its. A failed save queues a job
    // that asks the service, patiently, 1 s later (BACKGROUND_INDEX_FIRST_DELAY_MS), and a later failed save starts it
    // again once it is aborted, so on a slow machine it asks between the calls. Started here with a first delay longer
    // than the test, it is the job every failed save finds running, and it asks nothing.
    const held = engineFinishIndexInBackground(ws.service.db, ws.config, ws.service.engine, { firstDelayMs: TEST_TIMEOUT_MS });
    expect(held).not.toBeNull();

    stub.mode = 'throttle';
    const note = await ws.timed('remember', { statement: NOTE });
    // The memory is saved and says its index is not finished (the receipt the API already has); it is no longer the
    // retry loop's hostage.
    expect(note.ms).toBeLessThan(PROMPT_MS);
    expect(note.body).toMatchObject({ ok: true, mode: 'note', indexed: false, warning: 'memory-saved-but-index-refresh-failed' });
    expect(note.body.detail).toMatch(/HTTP 429/);
    expect(runningBackgroundIndex(ws.service.db)).toBe(held);
    const requestsAfterFirstFailure = stub.counts.requests;
    expect(requestsAfterFirstFailure).toBeGreaterThan(0);

    const fact = await ws.timed('remember', { statement: 'The carrier rates API key rotates every 90 days.', subject: 'carrier rates API key', predicate: 'rotation', object: 'every 90 days' });
    expect(fact.ms).toBeLessThan(PROMPT_MS);
    expect(fact.body).toMatchObject({ ok: true, mode: 'fact', action: 'store', warning: 'memory-saved-but-index-refresh-failed' });

    const saved = await ws.timed('save_memory', { subject: 'Atlas staging', predicate: 'node_count', object: '3' });
    expect(saved.ms).toBeLessThan(PROMPT_MS);
    expect(saved.body).toMatchObject({ ok: true, action: 'store' });

    // A read answers at once from the facts and keyword search, and says semantic search did not answer.
    const context = await ws.timed('get_context', { query: QUESTION });
    expect(context.ms).toBeLessThan(PROMPT_MS);
    expect(context.isError).toBe(false);
    expect(context.body).toMatchObject({ ok: true, retrieval: 'keyword' });
    expect(context.body.notice).toMatch(/Semantic search is unavailable/);
    expect(context.body.memories.map((m: { text: string }) => m.text).join('\n')).toContain(NOTE);
    const factContext = await ws.timed('get_context', { query: 'How often does the carrier rates API key rotate?' });
    expect(factContext.ms).toBeLessThan(PROMPT_MS);
    expect(factContext.body.facts).toEqual(expect.arrayContaining([expect.objectContaining({ subject: 'carrier rates API key', object: 'every 90 days' })]));

    const search = await ws.timed('search_memory', { query: 'quarterly access review' });
    expect(search.ms).toBeLessThan(PROMPT_MS);
    expect(search.body).toMatchObject({ ok: true, fallback: 'keyword' });

    // Nothing was lost: the saved text is found by its words now.
    const text = await ws.call('search_text', { query: 'quarterly access review' });
    expect(JSON.stringify(text.body)).toContain(NOTE);

    // After the first failure the service was not asked again: every later call was answered without a request.
    expect(stub.counts.requests).toBe(requestsAfterFirstFailure);
    expect(runningBackgroundIndex(ws.service.db)).toBe(held);
  }, TEST_TIMEOUT_MS);

  it('what was saved is embedded in the background once the service answers, and is then found by meaning', async () => {
    const { ws, stub } = await start({ fastRetry: true });
    stub.mode = 'throttle';
    const note = await ws.timed('remember', { statement: NOTE });
    expect(note.body).toMatchObject({ indexed: false, warning: 'memory-saved-but-index-refresh-failed' });
    expect(note.ms).toBeLessThan(PROMPT_MS);
    expect(chunksWithoutVectors(ws.service.db)).toBeGreaterThan(0);
    expect(runningBackgroundIndex(ws.service.db)).not.toBeNull();

    stub.mode = 'ok';
    await until(() => chunksWithoutVectors(ws.service.db) === 0 && ws.service.db.prepare(UNFINISHED_FILES).pluck().get() === 0);

    const status = await ws.call('memory_status');
    expect(status.body).toMatchObject({ semantic: true, chunksWithoutVectors: 0 });
    const search = await ws.call('search_memory', { query: 'quarterly access review' });
    expect(search.isError).toBe(false);
    expect(search.body.hits.map((h: { text: string }) => h.text).join('\n')).toContain(NOTE);
    const context = await ws.call('get_context', { query: QUESTION });
    expect(context.body.retrieval).toBe('hybrid');
    expect(context.body).not.toHaveProperty('notice');
    await until(() => runningBackgroundIndex(ws.service.db) === null);
  }, TEST_TIMEOUT_MS);
});

/** A note written into the memory folder outside the engine, as the one `index_memory` is run to pick up. */
function writeOutsideNote(ws: Workspace, name: string, text: string): void {
  fs.mkdirSync(path.join(ws.memoryDir, 'Projects'), { recursive: true });
  fs.writeFileSync(path.join(ws.memoryDir, 'Projects', name), `# ${name}\n\n${text}\n`);
}

describe('index_memory while the embedding service is refusing', () => {
  it('answers within the write budget and says the file is still being indexed, instead of running the whole retry loop', async () => {
    const { ws, stub } = await start();
    stub.mode = 'throttle';
    writeOutsideNote(ws, 'access-review.md', NOTE);

    const index = await ws.timed('index_memory');
    // Before the budget, this call ran the provider's whole retry loop (8 attempts, up to 120 s apart: about 9 minutes).
    expect(index.ms).toBeLessThan(PROMPT_MS);
    expect(index.isError).toBe(false);
    expect(index.body).toMatchObject({ ok: true, errors: 1, warning: 'index-unfinished' });
    expect(index.body.detail).toMatch(/being finished in the background/);
    // Its chunks are kept: keyword search finds the note now, and a job holds the file to embed it later.
    expect(ws.service.db.prepare(UNFINISHED_FILES).pluck().get()).toBe(1);
    expect(runningBackgroundIndex(ws.service.db)).not.toBeNull();
    expect(JSON.stringify((await ws.call('search_text', { query: 'quarterly access review' })).body)).toContain(NOTE);
  }, TEST_TIMEOUT_MS);

  it('the background job finishes the file once the service answers, and it is then found by meaning', async () => {
    const { ws, stub } = await start({ fastRetry: true });
    stub.mode = 'throttle';
    writeOutsideNote(ws, 'access-review.md', NOTE);

    const index = await ws.timed('index_memory');
    expect(index.ms).toBeLessThan(PROMPT_MS);
    expect(index.body).toMatchObject({ ok: true, warning: 'index-unfinished' });
    expect(runningBackgroundIndex(ws.service.db)).not.toBeNull();

    stub.mode = 'ok';
    await until(() => chunksWithoutVectors(ws.service.db) === 0 && ws.service.db.prepare(UNFINISHED_FILES).pluck().get() === 0);
    const search = await ws.call('search_memory', { query: 'quarterly access review' });
    expect(search.isError).toBe(false);
    expect(search.body.hits.map((h: { text: string }) => h.text).join('\n')).toContain(NOTE);
    await until(() => runningBackgroundIndex(ws.service.db) === null);
    // A healthy pass says nothing more than it always did.
    const again = await ws.call('index_memory');
    expect(again.body).toMatchObject({ ok: true, errors: 0 });
    for (const key of ['warning', 'detail']) expect(again.body).not.toHaveProperty(key);
  }, TEST_TIMEOUT_MS);
});

describe('while the embedding service does not answer at all', () => {
  it('a save and a read end within their budgets instead of waiting for a service that never replies', async () => {
    process.env.RENOR_EMBED_WRITE_BUDGET_MS = '400';
    process.env.RENOR_EMBED_READ_BUDGET_MS = '300';
    const { ws, stub } = await start({ fastRetry: true });
    stub.mode = 'hang';

    const note = await ws.timed('remember', { statement: NOTE });
    expect(note.ms).toBeLessThan(PROMPT_MS);
    expect(note.body).toMatchObject({ ok: true, indexed: false, warning: 'memory-saved-but-index-refresh-failed' });
    expect(note.body.detail).toMatch(/did not answer within 1 s/);

    const context = await ws.timed('get_context', { query: QUESTION });
    expect(context.ms).toBeLessThan(PROMPT_MS);
    expect(context.body).toMatchObject({ ok: true, retrieval: 'keyword' });
    expect(context.body.memories.map((m: { text: string }) => m.text).join('\n')).toContain(NOTE);

    // It comes back, and the note is embedded. The save queued a job that asks 1 s after it failed; on a slow machine that
    // is before this line, and its patient request (no budget) would wait on the stall for minutes, so the stub answers it now.
    // The budgets above are cut short for the stall; with the service back, the calls get the shipped ones, so a loaded
    // machine's round trip past 300 ms is not taken for a service that is down.
    ws.service.engine.embedBudgets = DEFAULT_EMBED_BUDGETS;
    stub.mode = 'ok';
    stub.answerHanging();
    await until(() => chunksWithoutVectors(ws.service.db) === 0);
    expect((await ws.call('search_memory', { query: 'quarterly access review' })).body.hits.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it('a read does not queue behind a save that is stuck embedding', async () => {
    process.env.RENOR_EMBED_WRITE_BUDGET_MS = '2500';
    process.env.RENOR_EMBED_READ_BUDGET_MS = '400';
    const { ws, stub } = await start({ fastRetry: true });
    await ws.call('remember', { statement: 'Kestrel uses Expo Router for navigation.' });
    // This question's vector is cached now, so the read below does not need the service for it.
    await ws.call('get_context', { query: QUESTION });

    stub.mode = 'hang';
    const asked = stub.counts.requests;
    const stuck = ws.timed('remember', { statement: NOTE }); // holds the daily note's lock while its embedding hangs
    // Its request reaching the service is what says it holds the lock now; a fixed pause says it only on a fast machine.
    await until(() => stub.counts.requests > asked, 20_000, 'the stuck save to ask the service');
    const read = await ws.timed('get_context', { query: QUESTION });
    // Before the budgets, the read's own pass over the unfinished note waited for that lock for as long as the save did.
    expect(read.ms).toBeLessThan(2_000);
    expect(read.body.ok).toBe(true);
    const write = await stuck;
    expect(write.ms).toBeGreaterThan(read.ms);
    expect(write.body).toMatchObject({ indexed: false, warning: 'memory-saved-but-index-refresh-failed' });
  }, TEST_TIMEOUT_MS);
});

describe('while the embedding service is healthy', () => {
  it('a save is indexed in the same call, with the receipt it always had, and nothing is left for a background job', async () => {
    const { ws, stub } = await start();
    const note = await ws.call('remember', { statement: NOTE });
    expect(note.body).toMatchObject({ ok: true, mode: 'note', indexed: true, index: { errors: 0 } });
    expect(Object.keys(note.body.index).sort()).toEqual(['errors', 'indexed', 'total']);
    for (const key of ['warning', 'detail']) expect(note.body).not.toHaveProperty(key);
    const fact = await ws.call('remember', { statement: 'Atlas runs on ECS.', subject: 'Atlas', predicate: 'runs_on', object: 'ECS' });
    for (const key of ['index', 'warning', 'detail']) expect(fact.body).not.toHaveProperty(key);

    expect(chunksWithoutVectors(ws.service.db)).toBe(0);
    expect(runningBackgroundIndex(ws.service.db)).toBeNull();
    const context = await ws.call('get_context', { query: QUESTION });
    expect(context.body.retrieval).toBe('hybrid');
    expect(context.body).not.toHaveProperty('notice');
    // Documents are embedded as documents and the one query as a query.
    expect(stub.taskTypes).toContain('RETRIEVAL_DOCUMENT');
    expect(stub.taskTypes.filter(t => t === 'RETRIEVAL_QUERY')).toHaveLength(1);
  }, TEST_TIMEOUT_MS);
});
