import { describe, it, expect, afterEach, vi } from 'vitest';
import { chunksWithoutVectors } from '../../src/embeddings/rebuild';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import {
  engineFinishIndexInBackground,
  hasIndexWorkToFinish,
  resolveEmbedBudgets,
  runningBackgroundIndex,
  UNFINISHED_FILES,
} from '../../src/mvp/engine';
import { startWorkspace, restoreWorkspaceEnv, type Workspace } from '../helpers/mvpWorkspace';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * A save the embedding service could not take in time is not lost: the chunks stay (keyword search finds them), the
 * file is left unfinished, and a background job embeds them, trying again after a wait for as long as the service
 * is down. Driven through the MCP tools of a real service, with the eval-hash stub failing on demand.
 */

const OUTAGE = 'embedding service unavailable (synthetic)';
let workspace: Workspace | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await workspace?.close();
  workspace = undefined;
  restoreWorkspaceEnv();
});

class Flaky extends EvalHashEmbeddingProvider {
  /** Requests to fail from now on; each failure counts one. */
  failNext = 0;
  failures = 0;
  requests = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.requests++;
    if (this.failNext > 0) {
      this.failNext--;
      this.failures++;
      throw new Error(OUTAGE);
    }
    return super.embed(texts);
  }
}

async function start(provider: Flaky): Promise<Workspace> {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  workspace = await startWorkspace(() => provider);
  return workspace;
}

const settled = (ws: Workspace) => chunksWithoutVectors(ws.service.db) === 0 && ws.service.db.prepare(UNFINISHED_FILES).pluck().get() === 0;

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the background index', () => {
  it('tries again after each failure and finishes once the service answers: nothing a save kept is dropped', async () => {
    const provider = new Flaky();
    const ws = await start(provider);
    provider.failNext = 1_000;
    const saved = await ws.call('remember', { statement: 'The quarterly access review is due on November 15.' });
    expect(saved.body).toMatchObject({ indexed: false, warning: 'memory-saved-but-index-refresh-failed' });
    expect(chunksWithoutVectors(ws.service.db)).toBe(1);
    expect(hasIndexWorkToFinish(ws.service.db, ws.service.engine)).toBe(true);

    // The job the save started waits a second and then 30 s; this one is the same job on a short clock.
    const auto = runningBackgroundIndex(ws.service.db);
    expect(auto).not.toBeNull();
    auto!.abort();
    await auto!.done;
    expect(runningBackgroundIndex(ws.service.db)).toBeNull();

    const before = provider.failures;
    const job = engineFinishIndexInBackground(ws.service.db, ws.config, ws.service.engine, { firstDelayMs: 5, retryDelayMs: () => 40 })!;
    expect(engineFinishIndexInBackground(ws.service.db, ws.config, ws.service.engine)).toBe(job); // one job, not two
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(provider.failures - before).toBeGreaterThanOrEqual(3); // it kept trying
    expect(chunksWithoutVectors(ws.service.db)).toBe(1);

    provider.failNext = 0; // the service is back
    await job.done;
    expect(settled(ws)).toBe(true);
    expect(runningBackgroundIndex(ws.service.db)).toBeNull();
    expect(hasIndexWorkToFinish(ws.service.db, ws.service.engine)).toBe(false);
    const search = await ws.call('search_memory', { query: 'quarterly access review' });
    expect(search.body.hits.map((h: { text: string }) => h.text).join('\n')).toContain('November 15');
  }, 30_000);

  it('stops when aborted and leaves the work for the next start', async () => {
    const provider = new Flaky();
    const ws = await start(provider);
    provider.failNext = 1_000;
    await ws.call('remember', { statement: 'Kestrel uses Expo Router for navigation.' });
    const auto = runningBackgroundIndex(ws.service.db)!;
    auto.abort();
    await auto.done;
    expect(chunksWithoutVectors(ws.service.db)).toBe(1);
    // A service that is started on this index finishes it (createMvpApp asks this at boot).
    expect(hasIndexWorkToFinish(ws.service.db, ws.service.engine)).toBe(true);
  }, 30_000);

  it('a save while the service is healthy starts no job', async () => {
    const provider = new Flaky();
    const ws = await start(provider);
    const saved = await ws.call('remember', { statement: 'Atlas runs on ECS.' });
    expect(saved.body).toMatchObject({ indexed: true });
    expect(runningBackgroundIndex(ws.service.db)).toBeNull();
    expect(hasIndexWorkToFinish(ws.service.db, ws.service.engine)).toBe(false);
  }, 30_000);
});

describe('the embedding budgets', () => {
  it('are 5 s a request for a save and 3 s for a read unless set, and 0 turns a budget off', () => {
    expect(resolveEmbedBudgets({})).toEqual({ writeMs: 5_000, readMs: 3_000 });
    expect(resolveEmbedBudgets({ RENOR_EMBED_WRITE_BUDGET_MS: '8000', RENOR_EMBED_READ_BUDGET_MS: '1500' })).toEqual({ writeMs: 8_000, readMs: 1_500 });
    expect(resolveEmbedBudgets({ RENOR_EMBED_WRITE_BUDGET_MS: '0' })).toEqual({ writeMs: Infinity, readMs: 3_000 });
    expect(resolveEmbedBudgets({ RENOR_EMBED_WRITE_BUDGET_MS: '0', RENOR_EMBED_READ_BUDGET_MS: '0' })).toBeUndefined();
  });

  it('refuse a value that is not 0 or a number of milliseconds a service can be waited for', () => {
    for (const bad of ['abc', '-1', '50', '1.5', '600001']) {
      expect(() => resolveEmbedBudgets({ RENOR_EMBED_READ_BUDGET_MS: bad })).toThrow(/RENOR_EMBED_READ_BUDGET_MS must be 0/);
    }
  });
});
