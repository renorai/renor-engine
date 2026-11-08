import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember } from '../../src/memory/lifecycle';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { buildAgentContext, nameOnFile, searchRelevance } from '../../src/mvp/agentMemory';
import {
  CALIBRATED_BARS,
  CONTEXT_RELEVANCE_DEFAULT_ON,
  CONTEXT_RELEVANCE_GUIDANCE,
  NO_STRONG_MATCH,
  UNKNOWN_NAME_MARGIN,
  assessContextRelevance,
  combineSimilarity,
  contextRelevanceArmed,
  contextRelevanceEnabled,
  factLane,
  notMentioned,
  renderFactForRelevance,
  similaritiesTo,
  requestNames,
  resolveRelevanceBar,
  warmFactVectors,
} from '../../src/mvp/contextRelevance';
import { attachEngine, engineSearchMemory, type Engine } from '../../src/mvp/engine';
import { withFactHits } from '../../src/mvp/factsLane';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { factText } from '../../src/retrieval/ledgerPresentation';
import { loadMvpConfig } from '../../src/mvp/config';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { seedWorkspace } from '../../scripts/eval/relevance-calibration';
import { removeTestDir } from '../helpers/removeDb';

/**
 * get_context relevance signal. Product path end to end (buildAgentContext over a real
 * indexed workspace) with the deterministic eval-hash embeddings: no network, no model.
 * The hash embedding is lexical, so these tests pin the signal's *mechanics* (what is
 * compared, when it is absent, what it costs); its calibrated bar for the real hosted
 * embedding model is replayed in context-relevance-calibration.test.ts.
 */

const FLAG_ON = { RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0.3' } as NodeJS.ProcessEnv;
const MATCHING = 'What is my dog name?';
const UNRELATED = 'quantum chromodynamics gluon lagrangian';

const tmp: string[] = [];
const openHandles: Array<{ close(): void }> = [];
afterEach(() => {
  for (const handle of openHandles.splice(0)) handle.close();
  for (const d of tmp.splice(0)) removeTestDir(d);
});

/** Counts embedding calls and can hold document embeds back, to observe the background fill. */
class CountingProvider implements EmbeddingProvider {
  readonly inner = new EvalHashEmbeddingProvider();
  dimensions = this.inner.dimensions;
  embedCalls = 0;
  queryCalls = 0;
  gate: Promise<void> | null = null;
  failNext = false;
  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls++;
    if (this.gate) await this.gate;
    if (this.failNext) { this.failNext = false; throw new Error('embedding backend down'); }
    return this.inner.embed(texts);
  }
  async embedQuery(text: string): Promise<number[]> {
    this.queryCalls++;
    return this.inner.embedQuery(text);
  }
}

const SEED: Parameters<typeof seedWorkspace>[2] = {
  facts: [
    { subject: 'user', predicate: 'home_city', object: 'Lisbon' },
    { subject: 'user', predicate: 'dog_name', object: 'Biscuit' },
    { subject: 'user', predicate: 'preferred_editor', object: 'Neovim' },
    { subject: 'Atlas', predicate: 'cloud_region', object: 'eu-west-1', scope: 'project:atlas' },
  ],
  notes: [{ slug: 'japan', date: '2026-08-20', text: 'Trip to Japan planned for April. Flights booked with TAP, landing in Tokyo on April 3rd.' }],
};

/**
 * A workspace busy enough that a search's page is all note chunks about the question's own subject: the facts lane
 * still finds `preferred_editor`, the ledger chunk behind it does not reach the page, and top_k leaves the facts lane
 * no room. Below about two dozen notes the ledger chunk does reach the page and the bug never fires, which is why it
 * read as intermittent rather than absent.
 */
const CROWDED: Parameters<typeof seedWorkspace>[2] = {
  facts: [{ subject: 'user', predicate: 'preferred_editor', object: 'Neovim' }],
  notes: Array.from({ length: 24 }, (_, i) => ({
    slug: `standup${i}`,
    date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
    text: `Standup ${i}: my favorite editor setup discussion, notes about the editor theme and keymap.`,
  })),
};

async function workspace(provider: EmbeddingProvider = new CountingProvider(), modelKey: string | undefined = 'test:hash:256', seed = SEED) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-relevance-'));
  tmp.push(root);
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  const db = openDb(path.join(root, 'index.db'));
  openHandles.push(db);
  runMigrations(db);
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await seedWorkspace(db, memoryDir, seed);
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 2);
  const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, ...(modelKey ? { modelKey } : {}) };
  return { db, memoryDir, engine, provider };
}

type Body = {
  facts: unknown[];
  memories: Array<{ text: string }>;
  relevance?: { relevant: boolean; reason?: string; similarity: number | null; bar: number };
};

async function ask(w: Awaited<ReturnType<typeof workspace>>, query: string, env: NodeJS.ProcessEnv, extra: { scope?: string } = {}) {
  return await buildAgentContext(w.db, w.engine, w.memoryDir, { query, env, ...extra }) as Body;
}

/** The recency boost moves `score` by ~1e-10 between two calls; everything else must match exactly. */
function withoutScores(body: Body): unknown {
  return { ...body, memories: body.memories.map(({ score: _score, ...rest }: Record<string, unknown>) => rest) };
}

describe('flag, bar and arming', () => {
  it('follows the shipped default and the usual on/off spellings', () => {
    expect(contextRelevanceEnabled({})).toBe(CONTEXT_RELEVANCE_DEFAULT_ON);
    expect(contextRelevanceEnabled({ RENOR_CONTEXT_RELEVANCE: 'maybe' } as NodeJS.ProcessEnv)).toBe(CONTEXT_RELEVANCE_DEFAULT_ON);
    for (const on of ['1', 'true', 'YES', ' on ']) expect(contextRelevanceEnabled({ RENOR_CONTEXT_RELEVANCE: on } as NodeJS.ProcessEnv)).toBe(true);
    for (const off of ['0', 'false', 'No', 'off']) expect(contextRelevanceEnabled({ RENOR_CONTEXT_RELEVANCE: off } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('takes the bar from the explicit override, else the model calibration, else none', () => {
    const [model, bar] = Object.entries(CALIBRATED_BARS)[0];
    expect(resolveRelevanceBar(model, {})).toBe(bar);
    expect(resolveRelevanceBar(model, { RENOR_CONTEXT_RELEVANCE_MIN: '0.5' } as NodeJS.ProcessEnv)).toBe(0.5);
    expect(resolveRelevanceBar(model, { RENOR_CONTEXT_RELEVANCE_MIN: 'not-a-number' } as NodeJS.ProcessEnv)).toBe(bar);
    expect(resolveRelevanceBar('openai:voyage-4-large:1024', {})).toBeNull();
    expect(resolveRelevanceBar(undefined, {})).toBeNull();
    expect(resolveRelevanceBar(undefined, { RENOR_CONTEXT_RELEVANCE_MIN: '0.4' } as NodeJS.ProcessEnv)).toBe(0.4);
  });

  it('is armed only with embeddings, the flag and a bar', () => {
    const provider = new EvalHashEmbeddingProvider();
    expect(contextRelevanceArmed({ provider, modelKey: 'test:hash:256' }, FLAG_ON)).toBe(true);
    expect(contextRelevanceArmed({ provider: null }, FLAG_ON)).toBe(false);
    expect(contextRelevanceArmed({ provider, modelKey: 'unknown:model:1' }, { RENOR_CONTEXT_RELEVANCE: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(contextRelevanceArmed({ provider, modelKey: 'test:hash:256' }, { ...FLAG_ON, RENOR_CONTEXT_RELEVANCE: '0' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('shipped default', () => {
  it('speaks for the calibrated hosted embedding model without any setting, and for no other model', () => {
    const provider = new EvalHashEmbeddingProvider();
    const [hosted] = Object.keys(CALIBRATED_BARS);
    expect(contextRelevanceArmed({ provider, modelKey: hosted }, {})).toBe(CONTEXT_RELEVANCE_DEFAULT_ON);
    expect(contextRelevanceArmed({ provider, modelKey: hosted }, { RENOR_CONTEXT_RELEVANCE: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(contextRelevanceArmed({ provider, modelKey: 'openai:voyage-4-large:1024' }, {})).toBe(false);
    expect(contextRelevanceArmed({ provider: null, modelKey: hosted }, {})).toBe(false);
  });
});

describe('hosted configuration', () => {
  it('resolves the Vertex defaults to the calibrated model key, so the shipped bar actually applies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-relevance-config-'));
    tmp.push(root);
    const keyFile = path.join(root, 'sa.json');
    fs.writeFileSync(keyFile, JSON.stringify({ client_email: 'svc@example.iam', private_key: 'not-a-real-key', token_uri: 'https://oauth2.example.test/token' }));
    const memoryDir = path.join(root, 'memory');
    fs.mkdirSync(memoryDir);
    const names = [
      'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_ALLOWED_CALLBACK_URIS',
      'MVP_EMBEDDING_PROVIDER', 'MVP_VERTEX_KEY_FILE', 'MVP_VERTEX_PROJECT', 'MVP_VERTEX_LOCATION',
      'MVP_EMBEDDING_MODEL', 'EMBEDDING_MODEL', 'RENOR_EVAL_MODEL', 'MVP_EMBEDDING_DIMS', 'EMBEDDING_DIMS', 'RENOR_EVAL_EMBEDDING_DIMS', 'EMBEDDING_PROVIDER',
    ];
    const saved = new Map(names.map(n => [n, process.env[n]]));
    try {
      for (const n of names) delete process.env[n];
      Object.assign(process.env, {
        MVP_MEMORY_DIR: memoryDir,
        MVP_AUTH_STATE_PATH: path.join(root, 'clients.json'),
        MVP_BASE_URL: 'http://127.0.0.1:1',
        MVP_OWNER_EMAIL: 'owner@example.test',
        MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
        MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
        MVP_EMBEDDING_PROVIDER: 'vertex',
        MVP_VERTEX_KEY_FILE: keyFile,
        MVP_VERTEX_PROJECT: 'demo-project',
        MVP_VERTEX_LOCATION: 'europe-west4',
      });
      const db = openDb(path.join(root, 'index.db'));
      openHandles.push(db);
      runMigrations(db);
      const engine = attachEngine(db, loadMvpConfig());
      // attachEngine opens the query-embedding cache beside the index (its owner, the server, closes it on shutdown).
      const cache = engine.provider as { close?: () => void } | null;
      if (cache?.close) openHandles.push({ close: () => cache.close!() });
      expect(engine.modelKey).toBe(Object.keys(CALIBRATED_BARS)[0]);
      expect(contextRelevanceArmed(engine, {})).toBe(CONTEXT_RELEVANCE_DEFAULT_ON);
      db.close();
    } finally {
      for (const [n, v] of saved) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
    }
  });
});

describe('verdict', () => {
  it('compares the rounded similarity the caller sees, so equal to the bar is relevant', () => {
    expect(assessContextRelevance(0.6296, 0.63)).toEqual({ relevant: true, similarity: 0.63, bar: 0.63 });
    const below = assessContextRelevance(0.6294, 0.63)!;
    expect(below).toEqual({ relevant: false, reason: NO_STRONG_MATCH, similarity: 0.629, bar: 0.63 });
  });

  it('gives no verdict without a usable similarity or a bar', () => {
    expect(assessContextRelevance(null, 0.63)).toBeNull();
    expect(assessContextRelevance(0.7, null)).toBeNull();
    expect(assessContextRelevance(Number.NaN, 0.63)).toBeNull();
  });

  it('takes the better lane, and the other when one is unavailable', () => {
    expect(combineSimilarity(0.5, 0.7)).toBe(0.7);
    expect(combineSimilarity(0.8, 0.7)).toBe(0.8);
    expect(combineSimilarity(null, 0.7)).toBe(0.7);
    expect(combineSimilarity(0.5, null)).toBe(0.5);
    expect(combineSimilarity(null, null)).toBeNull();
  });
});

describe('get_context over a real indexed workspace', () => {
  it('is byte-identical to the shipped response while the flag is off or there is no bar', async () => {
    const w = await workspace();
    const off = await ask(w, MATCHING, { RENOR_CONTEXT_RELEVANCE: '0' } as NodeJS.ProcessEnv);
    expect(off).not.toHaveProperty('relevance');
    const uncalibrated = await workspace(new CountingProvider(), undefined);
    const noBar = await ask(uncalibrated, MATCHING, { RENOR_CONTEXT_RELEVANCE: '1' } as NodeJS.ProcessEnv);
    expect(noBar).not.toHaveProperty('relevance');
    const on = await ask(w, MATCHING, FLAG_ON);
    const { relevance: _signal, ...rest } = on;
    expect(JSON.stringify(withoutScores(rest as Body))).toBe(JSON.stringify(withoutScores(off)));
  });

  it('says a matching request has something on file, and a stray one does not', async () => {
    const w = await workspace();
    expect(await warmFactVectors(w.db, w.provider)).toBe(true);

    const hit = await ask(w, MATCHING, FLAG_ON);
    expect(hit.relevance).toEqual({ relevant: true, similarity: expect.any(Number), bar: 0.3 });
    expect(hit.relevance!.similarity).toBeGreaterThanOrEqual(0.3);

    const miss = await ask(w, UNRELATED, FLAG_ON);
    expect(miss.relevance).toEqual({ relevant: false, reason: NO_STRONG_MATCH, similarity: expect.any(Number), bar: 0.3 });
    expect(miss.relevance!.similarity).toBeLessThan(0.3);
  });

  it('only advises: the payload of a flagged request is exactly what it would have been', async () => {
    const w = await workspace();
    await warmFactVectors(w.db, w.provider);
    const off = await ask(w, UNRELATED, { RENOR_CONTEXT_RELEVANCE: '0' } as NodeJS.ProcessEnv);
    const on = await ask(w, UNRELATED, FLAG_ON);
    expect(on.relevance?.relevant).toBe(false);
    expect(withoutScores({ ...on, relevance: undefined })).toEqual(withoutScores({ ...off, relevance: undefined }));
  });

  it('counts a current fact as on file even when the note chunk behind it is diluted', async () => {
    const w = await workspace();
    await warmFactVectors(w.db, w.provider);
    const components = { chunk: null as number | null, fact: null as number | null };
    // The rendering of the dog fact is "dog name: Biscuit"; asking in those words is an exact match.
    const body = await buildAgentContext(w.db, w.engine, w.memoryDir, {
      query: renderFactForRelevance('dog_name', 'Biscuit'), env: { ...FLAG_ON, RENOR_CONTEXT_RELEVANCE_MIN: '0.9' } as NodeJS.ProcessEnv, relevanceComponents: components,
    }) as Body;
    expect(components.chunk!).toBeLessThan(0.9);
    expect(components.fact!).toBeGreaterThan(0.99);
    expect(body.relevance?.relevant).toBe(true);
  });

  it('adds no embedding request to get_context once the fact vectors are warm', async () => {
    const w = await workspace();
    const provider = w.provider as CountingProvider;
    await warmFactVectors(w.db, provider);
    const [embedBefore, queryBefore] = [provider.embedCalls, provider.queryCalls];
    await ask(w, MATCHING, { RENOR_CONTEXT_RELEVANCE: '0' } as NodeJS.ProcessEnv);
    const offQueries = provider.queryCalls - queryBefore;
    await ask(w, MATCHING, FLAG_ON);
    await ask(w, UNRELATED, FLAG_ON);
    expect(provider.queryCalls - queryBefore - offQueries).toBe(offQueries * 2);
    expect(provider.embedCalls).toBe(embedBefore);
  });

  it('does not make up a verdict from nothing: no query vector, no signal', async () => {
    const w = await workspace();
    const empty = openDb(path.join(path.dirname(w.memoryDir), 'empty.db'));
    openHandles.push(empty);
    runMigrations(empty);
    const vectorIndex = new VectorIndex(empty, w.provider.dimensions);
    vectorIndex.initTable();
    const engine: Engine = { provider: w.provider, vectorIndex, dims: w.provider.dimensions, modelKey: 'test:hash:256' };
    const body = await buildAgentContext(empty, engine, w.memoryDir, { query: UNRELATED, env: FLAG_ON }) as Body;
    expect(body).not.toHaveProperty('relevance');
    const profile = await buildAgentContext(w.db, w.engine, w.memoryDir, { env: FLAG_ON }) as Body;
    expect(profile).not.toHaveProperty('relevance');
  });
});

describe('a read with nothing to compare (live dogfood D10)', () => {
  it('says "not relevant" instead of giving no verdict: no note found by meaning, no current fact', async () => {
    const w = await workspace();
    await warmFactVectors(w.db, w.provider, 'project:empty');
    const body = await ask(w, MATCHING, FLAG_ON, { scope: 'project:empty' });
    expect(body.facts).toEqual([]);
    expect(body.memories).toEqual([]);
    expect(body.relevance).toEqual({ relevant: false, reason: NO_STRONG_MATCH, similarity: null, bar: 0.3 });
  });
});

/** The best of the two lanes for `query`, as the signal computes it (bar 0: every lane value is reported). */
async function closest(w: Awaited<ReturnType<typeof workspace>>, query: string): Promise<number> {
  const components = { chunk: null as number | null, fact: null as number | null };
  await buildAgentContext(w.db, w.engine, w.memoryDir, { query, env: { RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0' } as NodeJS.ProcessEnv, relevanceComponents: components });
  return combineSimilarity(components.chunk, components.fact)!;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const armedAt = (bar: number) => ({ RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: String(bar) }) as NodeJS.ProcessEnv;

describe('a request that names something nothing on file mentions (live dogfood D2)', () => {
  const PRICING = { ...SEED, notes: [...SEED.notes, { slug: 'pricing', date: '2026-08-21', text: 'Launch pricing: 9 dollars a month per seat, and the first month is free.' }] };

  it('is not answered by a match just over the bar: the live Quillmoor case, a pricing question on a workspace that never said Quillmoor', async () => {
    const w = await workspace(new CountingProvider(), 'test:hash:256', PRICING);
    await warmFactVectors(w.db, w.provider);
    const query = 'What is the Quillmoor pricing?';
    const best = await closest(w, query);
    const bar = Math.floor((best - 0.02) * 1000) / 1000; // live: 0.646 over a bar of 0.63
    const body = await ask(w, query, armedAt(bar));
    expect(body.relevance).toEqual({ relevant: false, reason: notMentioned(['Quillmoor']), similarity: round3(best), bar: round3(bar + UNKNOWN_NAME_MARGIN) });
  });

  it('keeps the verdict when the name is on file, or the match is closer by the margin', async () => {
    const w = await workspace(new CountingProvider(), 'test:hash:256', PRICING);
    await warmFactVectors(w.db, w.provider);
    // Atlas is on file (a fact of project:atlas; an unscoped read sees every scope).
    const known = 'What is the Atlas pricing?';
    const knownBest = await closest(w, known);
    expect((await ask(w, known, armedAt(Math.floor((knownBest - 0.02) * 1000) / 1000))).relevance?.relevant).toBe(true);
    // A cross-language word or a name the user simply never wrote down: a close enough match still counts.
    const query = 'What is the Quillmoor pricing?';
    const best = await closest(w, query);
    const body = await ask(w, query, armedAt(Math.floor((best - UNKNOWN_NAME_MARGIN - 0.01) * 1000) / 1000));
    expect(body.relevance?.relevant).toBe(true);
  });

  it('finds names only in the scope read: a name of another scope is not on file in this one', async () => {
    const w = await workspace();
    expect(nameOnFile(w.db, w.memoryDir)('Atlas')).toBe(true);
    expect(nameOnFile(w.db, w.memoryDir, { scope: 'project:atlas' })('Atlas')).toBe(true);
    expect(nameOnFile(w.db, w.memoryDir, { scope: 'project:other' })('Atlas')).toBe(false);
    expect(nameOnFile(w.db, w.memoryDir)('Lisbon')).toBe(true); // a fact's value
    expect(nameOnFile(w.db, w.memoryDir)('Tokyo')).toBe(true); // a note
    expect(nameOnFile(w.db, w.memoryDir)('Quillmoor')).toBe(false);
  });

  it('takes for names the capitalized words that do not open a sentence: not "I", weekdays or months', () => {
    expect(requestNames('What is the Quillmoor pricing?')).toEqual(['Quillmoor']);
    expect(requestNames("I'm starting a side project called Quillmoor, an inventory tracker. What do you remember about it?")).toEqual(['Quillmoor']);
    expect(requestNames('Hi, how are you?')).toEqual([]);
    expect(requestNames('Book me a restaurant for dinner on Friday, the 3rd of March')).toEqual([]);
    expect(requestNames("Plan my day. Can you ask Ana's sister? I'd like her advice")).toEqual(['Ana']);
    expect(requestNames('Why did we consider moving Atlas to Fly.io?')).toEqual(['Atlas', 'Fly']);
    expect(requestNames('¿Dónde vive Ana?')).toEqual(['Ana']);
  });
});

describe('search_memory\'s verdict (findings inventory 7)', () => {
  it('is relevant only when its hits hold the match; "not relevant" is about everything on file, whatever the hits', async () => {
    const w = await workspace();
    await warmFactVectors(w.db, w.provider);
    const verdict = async (query: string, keep: (hits: unknown[]) => unknown[]) => {
      const probe = {};
      const body = await engineSearchMemory(w.db, w.engine, w.memoryDir, query, 20, undefined, undefined, false, undefined, probe);
      return searchRelevance(w.db, w.engine, w.memoryDir, { query, env: FLAG_ON }, probe, keep(body.hits) as Array<{ notePath: string; text: string }>);
    };
    expect((await verdict(MATCHING, hits => hits)).relevance).toEqual({ relevant: true, similarity: expect.any(Number), bar: 0.3 });
    // A page that already holds the match asks for nothing: no fact to list, so the page it returns is the one it was.
    expect((await verdict(MATCHING, hits => hits)).listFact).toBeUndefined();
    // The hits do not hold the fact it would report, so the caller is told to list it: the same rule get_context
    // applies to the fact its own verdict was judged on, and the reason the verdict is not withheld here.
    const missing = await verdict(MATCHING, () => []);
    expect(missing.relevance).toMatchObject({ relevant: true, similarity: expect.any(Number), bar: 0.3 });
    expect(missing.listFact).toMatchObject({ subject: 'user', predicate: 'dog_name', object: 'Biscuit' });
    expect((await verdict(UNRELATED, () => [])).relevance).toEqual({ relevant: false, reason: NO_STRONG_MATCH, similarity: expect.any(Number), bar: 0.3 });
    const off = async () => {
      const probe = {};
      const body = await engineSearchMemory(w.db, w.engine, w.memoryDir, MATCHING, 20, undefined, undefined, false, undefined, probe);
      return searchRelevance(w.db, w.engine, w.memoryDir, { query: MATCHING, env: { RENOR_CONTEXT_RELEVANCE: '0' } as NodeJS.ProcessEnv }, probe, body.hits as Array<{ notePath: string; text: string }>);
    };
    expect(await off()).toEqual({});
  });

  /**
   * The verdict used to be withheld exactly when a workspace was busy: the fact lane is the better lane, and the
   * page the search returns does not hold that fact — neither as a fact hit nor as its ledger event. The ledger chunk
   * behind a fact is boilerplate that does not rank (why the fact lane exists at all), and the facts lane ranks facts
   * by the query's words and only in the room top_k leaves, so on a page of note chunks about the same subject it
   * listed nothing. Measured on this fixture before the fix: `relevant: true` at 0.516 over a 0.3 bar, and no
   * `relevance` key at all — the agent could not tell "the answer is on file" from "cannot judge".
   *
   * The fact is saved after the last `index_memory`, which is what every `remember`/`save_memory` does (no save indexes
   * its event, D14), so the ledger chunk behind it is not on the page and the only way the fact is listed is the one
   * this verdict names. Both cases are the same query and the same workspace: a page top_k filled, and one it did not.
   */
  it('names the fact to list when the page has room, and in the verdict when it does not', async () => {
    const w = await workspace(new CountingProvider(), 'test:hash:256', { facts: [], notes: CROWDED.notes });
    await remember(w.db, w.memoryDir, 'System/Memory Events Ledger.md', { subject: 'user', predicate: 'preferred_editor', object: 'Neovim', source: 'test' });
    await warmFactVectors(w.db, w.provider);
    const query = 'what is my favorite editor';
    const ledger = { memoryDir: w.memoryDir, ledgerRelPath: DEFAULT_LEDGER_REL };
    const page = async (topK: number) => {
      const probe = {};
      const body = await engineSearchMemory(w.db, w.engine, w.memoryDir, query, topK, undefined, undefined, false, undefined, probe);
      const read = { query, env: FLAG_ON, ledgerRelPath: DEFAULT_LEDGER_REL };
      const verdict = searchRelevance(w.db, w.engine, w.memoryDir, read, probe, body.hits as Array<{ notePath: string; text: string }>, topK);
      const hits = withFactHits(w.db, ledger, body.hits as any[], { query, match: 'any', limit: topK, dated: true }, verdict.listFact ? [verdict.listFact] : []);
      return { body, probe, verdict, hits };
    };
    const factHitsOn = (hits: unknown[]) => hits.filter(hit => (hit as { reason?: string }).reason === 'fact');

    // A full page of notes: the page the search returns is all note chunks, and no fact hit fits beside them.
    const full = await page(20);
    expect(full.body.ok).toBe(true);
    expect(factHitsOn(withFactHits(w.db, ledger, full.body.hits as any[], { query, match: 'any', limit: 20, dated: true }))).toEqual([]);
    // The verdict stands anyway: a page top_k filled takes no more hits, so it names the fact itself.
    expect(full.verdict.relevance).toMatchObject({
      relevant: true, similarity: expect.any(Number), bar: 0.3,
      fact: { subject: 'user', predicate: 'preferred_editor', object: 'Neovim', scope: 'global' },
    });
    expect(full.verdict.listFact).toBeUndefined();
    // Every index hit kept, in order, and the page never passes top_k (the tool's own promise, D14).
    expect(full.hits).toEqual(full.body.hits);
    expect(full.hits.length).toBeLessThanOrEqual(20);

    // The same query and workspace where top_k leaves room: the fact is listed, and it counts toward top_k.
    const room = await page(30);
    expect(room.body.hits.length).toBeLessThan(30);
    expect(room.verdict.relevance).toEqual({ relevant: true, similarity: expect.any(Number), bar: 0.3 });
    expect(room.verdict.listFact).toMatchObject({ subject: 'user', predicate: 'preferred_editor', object: 'Neovim' });
    expect(factHitsOn(room.hits)).toHaveLength(1);
    expect(room.hits.filter(hit => (hit as { text: string }).text === factText('user', 'preferred_editor', 'Neovim'))).toHaveLength(1);
    expect(room.hits.slice(room.hits.length - (room.body.hits.length as number))).toEqual(room.body.hits); // every index hit kept, in order, last
    expect(room.hits.length).toBeLessThanOrEqual(30);
    // And the fact lane held the verdict, so the second judging (over the finished page) agrees.
    expect(searchRelevance(w.db, w.engine, w.memoryDir, { query, env: FLAG_ON }, room.probe, room.hits as Array<{ notePath: string; text: string }>, 30))
      .toMatchObject({ relevance: room.verdict.relevance });
  });

  /**
   * The bound the tool promises ("the hits are at most top_k in all", D14) is one the listed fact used to break: on a
   * page top_k had filled it arrived as one hit more, so top_k 8 answered with 9 and top_k 20 with 21. Now the fact is
   * listed only in the room and named in the verdict when there is none, so the page never passes top_k and the verdict
   * never vanishes.
   */
  it('never answers with more than top_k hits, and never withholds the verdict, at any top_k', async () => {
    const w = await workspace(new CountingProvider(), 'test:hash:256', { facts: [], notes: CROWDED.notes });
    await remember(w.db, w.memoryDir, 'System/Memory Events Ledger.md', { subject: 'user', predicate: 'preferred_editor', object: 'Neovim', source: 'test' });
    await warmFactVectors(w.db, w.provider);
    const query = 'what is my favorite editor';
    const ledger = { memoryDir: w.memoryDir, ledgerRelPath: DEFAULT_LEDGER_REL };
    for (const topK of [8, 20, 24]) {
      const probe = {};
      const body = await engineSearchMemory(w.db, w.engine, w.memoryDir, query, topK, undefined, undefined, false, undefined, probe);
      const verdict = searchRelevance(w.db, w.engine, w.memoryDir, { query, env: FLAG_ON }, probe, body.hits as Array<{ notePath: string; text: string }>, topK);
      const hits = withFactHits(w.db, ledger, body.hits as any[], { query, match: 'any', limit: topK, dated: true }, verdict.listFact ? [verdict.listFact] : []);
      expect(hits.length, `top_k ${topK}`).toBeLessThanOrEqual(topK);
      expect(verdict.relevance?.relevant, `top_k ${topK}`).toBe(true);
      // The verdict names its match whether or not the page could hold it, so it is never claimed and withheld.
      const named = verdict.relevance?.fact ?? (verdict.listFact ? verdict.listFact : undefined);
      expect(named, `top_k ${topK}`).toMatchObject({ subject: 'user', predicate: 'preferred_editor', object: 'Neovim' });
      // Every index hit is kept, in order, at the end of the page.
      expect(hits.slice(hits.length - (body.hits.length as number)), `top_k ${topK}`).toEqual(body.hits);
    }
  });

  /**
   * A fact derived from a note (saved through `remember`) carries no ledger event, so de-duplicating the named fact by
   * event id alone listed it a second time when the query's words had already found it.
   */
  it('lists a fact with no ledger event once, when the words found the same fact', async () => {
    const w = await workspace();
    await warmFactVectors(w.db, w.provider);
    const query = MATCHING;
    const nulled = (w.db.prepare('UPDATE facts SET event_id = NULL WHERE predicate = ?').run('dog_name') as { changes: number }).changes;
    expect(nulled).toBe(1);
    const ledger = { memoryDir: w.memoryDir, ledgerRelPath: DEFAULT_LEDGER_REL };
    const probe = {};
    const body = await engineSearchMemory(w.db, w.engine, w.memoryDir, query, 20, undefined, undefined, false, undefined, probe);
    const verdict = searchRelevance(w.db, w.engine, w.memoryDir, { query, env: FLAG_ON }, probe, body.hits as Array<{ notePath: string; text: string }>, 20);
    expect(verdict.relevance).toMatchObject({ relevant: true, bar: 0.3 });
    expect(verdict.listFact).toMatchObject({ subject: 'user', predicate: 'dog_name', object: 'Biscuit', eventId: null });
    // The lane's own page, with no index hit in front of it: the fact its words found and the fact the verdict names
    // are the same one, and it is listed once.
    const hits = withFactHits(w.db, ledger, [], { query, match: 'any', limit: 20, dated: true }, verdict.listFact ? [verdict.listFact] : []);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ reason: 'fact', text: factText('user', 'dog_name', 'Biscuit') });
    // And on the real page too, where the ledger chunk carries the same rendering: still one fact hit.
    const onPage = withFactHits(w.db, ledger, body.hits as any[], { query, match: 'any', limit: 20, dated: true }, verdict.listFact ? [verdict.listFact] : []);
    expect(onPage.filter(hit => (hit as { reason?: string }).reason === 'fact')).toHaveLength(1);
  });

  /**
   * No embedding call is added: the fact the verdict was judged on was already compared by the fact lane, and
   * listing it renders text the page already had.
   */
  it('costs no embedding call to list it', async () => {
    const provider = new CountingProvider();
    const w = await workspace(provider, 'test:hash:256', CROWDED);
    await warmFactVectors(w.db, provider);
    const query = 'what is my favorite editor';
    const probe = {};
    await engineSearchMemory(w.db, w.engine, w.memoryDir, query, 20, undefined, undefined, false, undefined, probe);
    const before = provider.embedCalls;
    const verdict = searchRelevance(w.db, w.engine, w.memoryDir, { query, env: FLAG_ON }, probe, [], 20);
    withFactHits(w.db, { memoryDir: w.memoryDir, ledgerRelPath: DEFAULT_LEDGER_REL }, [], { query, match: 'any', limit: 20, dated: true }, verdict.listFact ? [verdict.listFact] : []);
    expect(provider.embedCalls).toBe(before);
  });

  /**
   * The change is additive: a query whose verdict was already reported before it (held by the page, or "not relevant",
   * which is about the store and never about the page) gets the same page and the same verdict object as the lane
   * produced without naming anything. `listFact` absent is what makes that exact — the facts lane is then called with
   * no `also`, so the page is the one the facts lane always returned.
   */
  it('a query that already carried a verdict gets the same page and the same verdict as before', async () => {
    const w = await workspace();
    await warmFactVectors(w.db, w.provider);
    const ledger = { memoryDir: w.memoryDir, ledgerRelPath: DEFAULT_LEDGER_REL };
    const search = async (query: string, topK: number) => {
      const probe = {};
      const body = await engineSearchMemory(w.db, w.engine, w.memoryDir, query, topK, undefined, undefined, false, undefined, probe);
      const verdict = searchRelevance(w.db, w.engine, w.memoryDir, { query, env: FLAG_ON }, probe, body.hits as Array<{ notePath: string; text: string }>, topK);
      const named = verdict.listFact ? [verdict.listFact] : [];
      const lane = { query, match: 'any' as const, limit: topK, dated: true };
      return { body, verdict, hits: withFactHits(w.db, ledger, body.hits as any[], lane, named), unnamed: withFactHits(w.db, ledger, body.hits as any[], lane) };
    };

    // A question the words answer directly: the page already held the match, so the lane names nothing and the page is
    // the one it returned before this change could name anything.
    const held = await search(MATCHING, 20);
    expect(held.verdict.relevance).toEqual({ relevant: true, similarity: expect.any(Number), bar: 0.3 });
    expect(held.verdict.listFact).toBeUndefined();
    expect(held.verdict.relevance).not.toHaveProperty('fact');
    expect(held.hits).toEqual(held.unnamed);
    // The page really does hold the fact the verdict names, which is what the verdict asserts.
    expect(held.hits.some(hit => (hit as { text: string }).text === factText('user', 'dog_name', 'Biscuit'))).toBe(true);

    // "Not relevant" was always reported, is about the store and never about the page: unchanged, nothing named.
    for (const topK of [3, 20]) {
      const miss = await search(UNRELATED, topK);
      expect(miss.verdict.listFact, `top_k ${topK}`).toBeUndefined();
      expect(miss.verdict.relevance).toEqual({ relevant: false, reason: NO_STRONG_MATCH, similarity: expect.any(Number), bar: 0.3 });
      expect(miss.verdict.relevance).not.toHaveProperty('fact');
      expect(miss.hits).toEqual(miss.unnamed);
    }
  });
});

describe('fact vectors', () => {
  it('never wait: a request during warm-up is answered at once, and "no match" is withheld until every fact was compared', async () => {
    const provider = new CountingProvider();
    const w = await workspace(provider);
    let release!: () => void;
    provider.gate = new Promise<void>(resolve => { release = resolve; });

    // Warming: a clear match already proves relevance, but "nothing matches" would be a guess.
    const strongViaChunk = await ask(w, 'Trip to Japan planned for April. Flights booked with TAP, landing in Tokyo on April 3rd.', FLAG_ON);
    expect(strongViaChunk.relevance?.relevant).toBe(true);
    const unknown = await ask(w, UNRELATED, FLAG_ON);
    expect(unknown).not.toHaveProperty('relevance');

    release();
    expect(await warmFactVectors(w.db, provider)).toBe(true);
    const known = await ask(w, UNRELATED, FLAG_ON);
    expect(known.relevance?.relevant).toBe(false);
  });

  it('survive a failing embedding backend: no throw, no verdict, and a retry on the next call', async () => {
    const provider = new CountingProvider();
    const w = await workspace(provider);
    provider.failNext = true;
    const lane = factLane(w.db, provider, new Float32Array(provider.dimensions).fill(1));
    expect(lane).toEqual({ similarity: null, complete: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await warmFactVectors(w.db, provider)).toBe(true);
    expect(factLane(w.db, provider, new Float32Array(provider.dimensions).fill(1)).complete).toBe(true);
  });

  it('are not retried on every read while the backend is failing: it backs off, then tries again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const provider = new CountingProvider();
      const w = await workspace(provider);
      const q = new Float32Array(provider.dimensions).fill(1);
      provider.failNext = true;
      factLane(w.db, provider, q); // starts a fill; the backend rejects it
      await new Promise(resolve => setTimeout(resolve, 20));
      const afterFailure = provider.embedCalls;
      for (let i = 0; i < 5; i++) factLane(w.db, provider, q);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(provider.embedCalls).toBe(afterFailure); // five reads, no new embedding request
      vi.setSystemTime(Date.now() + 31_000);
      factLane(w.db, provider, q);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(provider.embedCalls).toBeGreaterThan(afterFailure);
      expect(factLane(w.db, provider, q).complete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compare current facts only, inside the requested scope', async () => {
    const provider = new CountingProvider();
    const w = await workspace(provider);
    await remember(w.db, w.memoryDir, 'System/Memory Events Ledger.md', { subject: 'user', predicate: 'employer', object: 'Acme', source: 'test' });
    await remember(w.db, w.memoryDir, 'System/Memory Events Ledger.md', { subject: 'user', predicate: 'employer', object: 'Globex', source: 'test' });
    await warmFactVectors(w.db, provider);
    const q = await provider.inner.embedQuery(renderFactForRelevance('employer', 'Acme'));
    // "employer: Acme" was superseded: the live fact is "employer: Globex", so it is not an exact match.
    expect(factLane(w.db, provider, q).similarity!).toBeLessThan(0.99);
    const live = await provider.inner.embedQuery(renderFactForRelevance('employer', 'Globex'));
    expect(factLane(w.db, provider, live).similarity!).toBeGreaterThan(0.99);

    const atlas = await provider.inner.embedQuery(renderFactForRelevance('cloud_region', 'eu-west-1'));
    await warmFactVectors(w.db, provider, 'project:atlas');
    expect(factLane(w.db, provider, atlas, 'project:atlas').similarity!).toBeGreaterThan(0.99);
    // A named scope is its slug: the fact saved as project:atlas is compared when the read says scope:atlas.
    expect(factLane(w.db, provider, atlas, 'scope:atlas').similarity!).toBeGreaterThan(0.99);
    await warmFactVectors(w.db, provider, 'project:other');
    expect(factLane(w.db, provider, atlas, 'project:other')).toEqual({ similarity: null, complete: true });
  });

  it('scores each fact with the same cosine as a direct dot of its stored unit vector, including a second call', async () => {
    const provider = new CountingProvider();
    const w = await workspace(provider);
    expect(await warmFactVectors(w.db, provider)).toBe(true);
    const renderings = SEED.facts.map(fact => renderFactForRelevance(fact.predicate, fact.object));
    const q = await provider.embedQuery(renderings[0]);
    const lane = factLane(w.db, provider, q);
    const sims = await similaritiesTo(provider, renderings, q);
    const scalar = [...sims!.values()];
    expect(scalar).toContain(lane.similarity);
    expect(lane.similarity).toBe(Math.max(...scalar));
    expect(factLane(w.db, provider, q)).toEqual(lane);
  });

  it('compares a fact saved after the lane has already answered', async () => {
    const provider = new CountingProvider();
    const w = await workspace(provider);
    expect(await warmFactVectors(w.db, provider)).toBe(true);
    const rendering = renderFactForRelevance('desk_plant', 'Fern');
    const q = await provider.embedQuery(rendering);
    expect(factLane(w.db, provider, q).similarity!).toBeLessThan(0.99);
    await remember(w.db, w.memoryDir, 'System/Memory Events Ledger.md', { subject: 'user', predicate: 'desk_plant', object: 'Fern', source: 'test' });
    expect(await warmFactVectors(w.db, provider)).toBe(true);
    const lane = factLane(w.db, provider, q);
    const sims = await similaritiesTo(provider, [rendering], q);
    expect(lane.similarity).toBe(sims!.get(rendering));
    expect(lane.similarity!).toBeGreaterThan(0.99);
  });
});

/** `count` current facts with unrelated vocabulary, oldest first, so each one's exact rendering is its own best match. */
async function manyFactsWorkspace(count: number) {
  let seed = 12345;
  const word = () => {
    let w = '';
    for (let i = 0; i < 7; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; w += String.fromCharCode(97 + (seed >> 16) % 26); }
    return w;
  };
  const facts = Array.from({ length: count }, () => ({ subject: 'user', predicate: `trait_${word()}`, object: `${word()} ${word()} ${word()}` }));
  const provider = new CountingProvider();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-relevance-many-'));
  tmp.push(root);
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  const db = openDb(path.join(root, 'index.db'));
  openHandles.push(db);
  runMigrations(db);
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await seedWorkspace(db, memoryDir, { facts, notes: [] });
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 4);
  const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'test:hash:256' };
  return { db, memoryDir, engine, provider, facts };
}

describe('every current fact is compared, however many there are', () => {
  it('finds the oldest of 501 current facts (the newest-500 cut-off used to drop it and still claim completeness)', async () => {
    const w = await manyFactsWorkspace(501);
    expect(await warmFactVectors(w.db, w.provider)).toBe(true);
    const oldest = w.facts[0];
    const q = await w.provider.inner.embedQuery(renderFactForRelevance(oldest.predicate, oldest.object));
    const lane = factLane(w.db, w.provider, q);
    expect(lane.complete).toBe(true);
    expect(lane.similarity!).toBeGreaterThan(0.99);
  }, 120_000);

  it('so a question that is exactly the oldest fact is never answered "nothing on file" (product path, 501 facts)', async () => {
    const w = await manyFactsWorkspace(501);
    await warmFactVectors(w.db, w.provider);
    const oldest = w.facts[0];
    const strict = { RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0.9' } as NodeJS.ProcessEnv;
    const body = await buildAgentContext(w.db, w.engine, w.memoryDir, { query: renderFactForRelevance(oldest.predicate, oldest.object), env: strict }) as Body;
    expect(body.relevance?.relevant).toBe(true);
    expect(body.relevance!.similarity).toBeGreaterThan(0.99);
  }, 120_000);

  it('reports the lane incomplete, never truncated-but-complete, once the in-scope facts outnumber the ceiling', async () => {
    const provider = new CountingProvider();
    const w = await workspace(provider); // 4 current facts: 3 global, 1 in project:atlas
    await warmFactVectors(w.db, w.provider);
    const q = await provider.inner.embedQuery(renderFactForRelevance('dog_name', 'Biscuit'));
    expect(factLane(w.db, w.provider, q, undefined, 4).complete).toBe(true); // exactly at the ceiling
    const over = factLane(w.db, w.provider, q, undefined, 3);
    expect(over.complete).toBe(false); // one over: the newest 3 are compared, the lane says it did not see them all
    expect(over.similarity).not.toBeNull();
    expect(factLane(w.db, w.provider, q, 'project:atlas', 1).complete).toBe(true); // only in-scope facts count
  });
});

describe('retrieval probe', () => {
  it('exposes the raw cosine of semantic hits only to a caller that passes a probe', async () => {
    const w = await workspace();
    const plain = await retrieveContext(w.db, w.engine.vectorIndex!, w.provider, MATCHING, 8, [], {}, {});
    expect(plain.hits.length).toBeGreaterThan(0);
    for (const hit of plain.hits) expect(hit).not.toHaveProperty('similarity');

    const probe: { queryVector?: number[] } = {};
    const probed = await retrieveContext(w.db, w.engine.vectorIndex!, w.provider, MATCHING, 8, [], {}, { probe });
    expect(probe.queryVector).toHaveLength(w.provider.dimensions);
    expect(probed.hits.some(h => typeof h.similarity === 'number')).toBe(true);
    expect(probed.hits.map(h => h.notePath)).toEqual(plain.hits.map(h => h.notePath));
  });
});

describe('guidance', () => {
  it('tells agents to treat a flagged result as no memory, but not to discard a clear answer', () => {
    expect(CONTEXT_RELEVANCE_GUIDANCE).toContain('relevance.relevant === false');
    expect(CONTEXT_RELEVANCE_GUIDANCE).toMatch(/unless one clearly answers it/);
    expect(CONTEXT_RELEVANCE_GUIDANCE).toMatch(/ask the user/);
  });
});
