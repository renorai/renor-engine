import { describe, it, expect, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { attachEngine } from '../../src/mvp/engine';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { CALIBRATED_BARS, contextRelevanceArmed } from '../../src/mvp/contextRelevance';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * A caller that brings its own embedding provider must keep the relevance bar its model has.
 *
 * The engine read `modelKey` only from configuration, so every in-process caller that injects a provider
 * (`createMvpApp(config, provider)`, as the benches and the tests here do) got no model key at all, and with
 * it no `relevance` verdict from `get_context` or `search_memory` — not a wrong verdict, none. The product
 * path was unaffected because it builds its provider from config, which is why the loss was invisible outside
 * a harness. A provider that declares an identity is exactly the provider whose model a bar can be looked up
 * for, so the key is composed from that identity here; a provider that declares none (the eval-hash stub)
 * still gets no bar, and stays silent rather than judged by a bar fitted for a different model.
 *
 * The stub below declares the calibrated hosted identity and embeds with the same deterministic lexical hash
 * as the eval-hash stub, so nothing leaves this process: no credential, no model, no network. It therefore says
 * nothing about how a real gemini-embedding-001 embedding scores (that is the recorded calibration's job, in
 * context-relevance-calibration.test.ts). What it does say is that the verdict is produced at all, and against
 * the bar that model was calibrated on.
 */

const CALIBRATED_KEY = Object.keys(CALIBRATED_BARS)[0];
const [IDENTITY_KIND, IDENTITY_MODEL, IDENTITY_DIMS] = CALIBRATED_KEY.split(':');
const CALIBRATED_BAR = CALIBRATED_BARS[CALIBRATED_KEY];
const DIMENSIONS = Number(IDENTITY_DIMS);

/** Deterministic lexical embeddings that declare the calibrated hosted identity. No model, no network. */
class CalibratedIdentityProvider implements EmbeddingProvider {
  readonly identity = { kind: IDENTITY_KIND, model: IDENTITY_MODEL };
  dimensions = DIMENSIONS;
  private vector(text: string): number[] {
    const out = new Array<number>(this.dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let hash = 2166136261;
      for (let i = 0; i < word.length; i++) {
        hash ^= word.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      out[(hash >>> 0) % this.dimensions] += 1;
    }
    const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0)) || 1;
    return out.map(value => value / norm);
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.vector(text));
  }
  async embedQuery(text: string): Promise<number[]> {
    return this.vector(text);
  }
}

/** Declares no identity, so no model key can be composed for it. */
class AnonymousProvider implements EmbeddingProvider {
  readonly inner = new EvalHashEmbeddingProvider();
  dimensions = this.inner.dimensions;
  async embed(texts: string[]): Promise<number[][]> {
    return this.inner.embed(texts);
  }
  async embedQuery(text: string): Promise<number[]> {
    return this.inner.embedQuery(text);
  }
}

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
  'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL',
  'RENOR_CONTEXT_RELEVANCE', 'RENOR_CONTEXT_RELEVANCE_MIN', 'RENOR_SEARCH_EVIDENCE', 'RENOR_READ_HONESTY',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const cleanups: Array<() => Promise<void>> = [];
const dirs: string[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function workspaceDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'injected-relevance-'));
  dirs.push(root);
  const memoryDir = path.join(root, 'memory');
  const authRoot = path.join(root, 'auth');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    // No configured provider: the whole point is that the injected one is what the engine runs on.
    MVP_EMBEDDING_PROVIDER: 'none',
    RENOR_SEARCH_EVIDENCE: '0',
  });
  return memoryDir;
}

/** The real MCP surface, in memory, on a fresh workspace served by the injected provider. */
async function serve(provider: EmbeddingProvider) {
  workspaceDir();
  const app = createMvpApp(loadMvpConfig(), provider);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'injected-provider-relevance', version: '0.1.0' });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await app.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0].text;
    if (res.isError) throw new Error(`${name} ${JSON.stringify(args)}: ${text}`);
    return JSON.parse(text);
  };
  return { call, tools: async () => (await client.listTools()).tools };
}

/**
 * Fact vectors are embedded by a background fill after the first read, and a "nothing matches" verdict is
 * withheld until they are there: a read that cannot compare every current fact cannot prove absence. So the
 * first calls may carry no verdict; the settled one is the first that does.
 */
async function settled(call: Awaited<ReturnType<typeof serve>>['call'], tool: 'get_context' | 'search_memory', query: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const body = await call(tool, { query, max_tokens: 2000 });
    if (body.relevance) return body;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${tool} returned no relevance verdict for "${query}"`);
}

describe('the model key of an injected provider', () => {
  it('is composed from the identity it declares, so the calibrated bar applies', () => {
    const memoryDir = workspaceDir();
    const db = openDb(path.join(memoryDir, 'index.db'));
    try {
      runMigrations(db);
      const engine = attachEngine(db, loadMvpConfig(), new CalibratedIdentityProvider());
      expect(engine.modelKey).toBe(CALIBRATED_KEY);
      expect(contextRelevanceArmed(engine, {})).toBe(true);
    } finally {
      db.close();
    }
  });

  it('is composed for the eval-hash stub but resolves to no bar, and is absent when no identity is declared', () => {
    // One workspace per provider: two models of different sizes may not share one index (ADR-0003), and the
    // dimension guard would fail the second attach before the key under test was ever read.
    const providers: Array<EmbeddingProvider & { identity?: { kind: string; model: string } }> = [
      new EvalHashEmbeddingProvider(), new AnonymousProvider(),
    ];
    for (const provider of providers) {
      const memoryDir = workspaceDir();
      const db = openDb(path.join(memoryDir, 'index.db'));
      try {
        runMigrations(db);
        const engine = attachEngine(db, loadMvpConfig(), provider);
        // The stub names its model, so the key exists; no bar was ever calibrated for lexical hash vectors,
        // so the signal stays silent. A provider that names nothing gets no key at all, exactly as before.
        expect(engine.modelKey, provider.constructor.name).toBe(provider.identity
          ? `${provider.identity.kind}:${provider.identity.model}:${provider.dimensions}`
          : undefined);
        expect(contextRelevanceArmed(engine, {}), provider.constructor.name).toBe(false);
      } finally {
        db.close();
      }
    }
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the relevance verdict an injected provider gets', () => {
  it('is returned by get_context and search_memory when the injected model has a calibrated bar', async () => {
    const { call, tools } = await serve(new CalibratedIdentityProvider());
    await call('remember', { statement: 'The Renor dog is called Biscuit.', subject: 'user', predicate: 'dog_name', object: 'Biscuit' });
    await call('index_memory', {});

    const context = await settled(call, 'get_context', 'What is my dog name?');
    expect(context.relevance).toMatchObject({ bar: CALIBRATED_BAR });
    expect(typeof context.relevance.similarity).toBe('number');

    const searched = await settled(call, 'search_memory', 'What is my dog name?');
    expect(searched.relevance).toMatchObject({ bar: CALIBRATED_BAR });
    expect(searched.hits.length).toBeGreaterThan(0);

    // The agent is told the signal exists, which is armed from the same key.
    expect((await tools()).find(t => t.name === 'get_context')!.description).toContain('relevance.relevant === false');
  }, 60_000);

  it('is still absent for the eval-hash stub, whose vectors were never calibrated against a bar', async () => {
    const { call } = await serve(new EvalHashEmbeddingProvider());
    await call('remember', { statement: 'The Renor dog is called Biscuit.', subject: 'user', predicate: 'dog_name', object: 'Biscuit' });
    await call('index_memory', {});

    for (const tool of ['get_context', 'search_memory'] as const) {
      const body = await call(tool, { query: 'What is my dog name?', max_tokens: 2000 });
      expect(body, tool).not.toHaveProperty('relevance');
    }
  }, 60_000);
});
