import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { emitTelemetry, flushTelemetry } from '../../src/mvp/telemetry';
import { CallPhases, markRetrieved, recordPhase, recordedPhase } from '../../src/callPhases';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Where a read's time went, on the line the engine already writes for each call (callPhases.ts, telemetry.ts `phases`): a
 * number of milliseconds for each of embed, token, connect, call, retrieve and reply, on get_context and search_memory and on
 * no other tool, written to the local log and to no remote sink, and never in a reply.
 */

describe('CallPhases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('splits a call at the mark: retrieve is the time before it less the embedding, reply the time after it', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1100).mockReturnValueOnce(1130);
    const phases = new CallPhases(); // the call starts at 1000
    phases.run(() => {
      recordPhase('embed', 40.04); // the provider's own measure, taken inside the wait before the mark
      recordPhase('call', 30);
      markRetrieved(); // at 1100
    });
    expect(phases.report()).toEqual({ embed: 40, call: 30, retrieve: 60, reply: 30 }); // reported at 1130
  });

  it('counts the first mark only, and reports no retrieve or reply for a call that never reached one', () => {
    const unmarked = new CallPhases();
    unmarked.run(() => { recordPhase('embed', 5); });
    expect(unmarked.report()).toEqual({ embed: 5 });

    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(2000).mockReturnValueOnce(2010).mockReturnValueOnce(2050);
    const marked = new CallPhases(); // starts at 2000
    marked.run(() => { markRetrieved(); markRetrieved(); }); // the first mark, at 2010, is the one that counts
    expect(marked.report()).toEqual({ retrieve: 10, reply: 40 }); // reported at 2050
  });

  it('records nothing outside a call that is being recorded, and keeps two calls apart', async () => {
    recordPhase('embed', 5);
    markRetrieved();
    expect(recordedPhase('embed')).toBe(0);
    const a = new CallPhases();
    const b = new CallPhases();
    await Promise.all([
      a.run(async () => { await pause(10); recordPhase('call', 3); recordPhase('call', 4); }),
      b.run(async () => { await pause(2); recordPhase('call', 20); }),
    ]);
    expect(a.report().call).toBe(7); // requests made together add up
    expect(b.report().call).toBe(20);
  });

  it('ignores a duration that is not a number of milliseconds', () => {
    const phases = new CallPhases();
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) phases.add('token', ms);
    expect(phases.report()).toEqual({});
  });
});

describe('the phases on a tool_use line', () => {
  const ENV_KEYS = ['MVP_INSTANCE_ID', 'RENOR_POSTHOG_KEY', 'RENOR_POSTHOG_HOST', 'RENOR_POSTHOG_CAPTURE_URL', 'RENOR_SENTRY_DSN',
    'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST', 'RENOR_TELEMETRY_HASH_SALT', 'RENOR_TELEMETRY_DISABLED'] as const;
  beforeEach(() => { for (const key of ENV_KEYS) delete process.env[key]; });
  afterEach(async () => {
    await flushTelemetry();
    for (const key of ENV_KEYS) delete process.env[key];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const logged = (calls: unknown[][]) =>
    calls.map(args => String(args[0])).filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, any>);

  it('is written to the log as milliseconds, to a tenth, for the closed list of phases', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitTelemetry({ event: 'tool_use', tool: 'get_context', ok: true, ms: 208, phases: { embed: 131.44, token: 0, call: 129.96, retrieve: 57.2, reply: 18.8 } });
    const [line] = logged(log.mock.calls);
    expect(line).toMatchObject({ event: 'tool_use', tool: 'get_context', ok: true, ms: 208 });
    expect(line.phases).toEqual({ embed: 131.4, token: 0, call: 130, retrieve: 57.2, reply: 18.8 });
  });

  it('is left off, and the call still counted, when a value is not a duration; a name nobody listed is never written', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bad: unknown[] = [{ embed: -1 }, { embed: Number.NaN }, { embed: '5' }, { embed: 1e12 }, [1, 2], 'embed', 5, { query: 5 }, {}];
    for (const phases of bad) emitTelemetry({ event: 'tool_use', tool: 'search_memory', ok: true, ms: 9, phases: phases as never });
    emitTelemetry({ event: 'tool_use', tool: 'search_memory', ok: true, ms: 9, phases: { embed: 2, query: 'CANARY-text', secret: 7 } as never });
    const lines = logged(log.mock.calls);
    expect(lines).toHaveLength(bad.length + 1); // every call counted
    for (const line of lines.slice(0, bad.length)) expect(line).not.toHaveProperty('phases');
    expect(lines.at(-1)!.phases).toEqual({ embed: 2 }); // the listed name kept, the others never read
    expect(JSON.stringify(lines)).not.toMatch(/CANARY|secret/);
  });

  it('is written for the local log only: PostHog, Sentry and Langfuse get the event exactly as before', async () => {
    process.env.MVP_INSTANCE_ID = 'alpha-phases';
    process.env.RENOR_POSTHOG_KEY = 'phc_test';
    process.env.RENOR_SENTRY_DSN = 'https://publickey@o0.ingest.sentry.io/12345';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
    process.env.RENOR_TELEMETRY_HASH_SALT = 'test-salt';
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const event = { event: 'tool_use' as const, tool: 'get_context', ok: false, ms: 211, error_kind: 'internal' as const };

    emitTelemetry({ ...event, phases: { embed: 130, token: 1, connect: 20, call: 100, retrieve: 50, reply: 20 } });
    await flushTelemetry();
    const withPhases = fetchMock.mock.calls.map(call => call as unknown as [string, RequestInit]);
    expect(withPhases.map(([url]) => new URL(url).host).sort()).toEqual(['cloud.langfuse.com', 'o0.ingest.sentry.io', 'us.i.posthog.com']);
    for (const [, init] of withPhases) expect(String(init.body)).not.toMatch(/phases|"embed"|"token"|"connect"|"call"|"retrieve"|"reply"/);

    fetchMock.mockClear();
    emitTelemetry(event);
    await flushTelemetry();
    const without = fetchMock.mock.calls.map(call => call as unknown as [string, RequestInit]);
    const properties = (calls: Array<[string, RequestInit]>) => JSON.parse(String(calls.find(([url]) => url.includes('posthog'))![1].body)).properties;
    expect(properties(withPhases)).toEqual(properties(without)); // the event PostHog gets does not know the line had phases
  });
});

// ---- the two reads, through the real tools ----------------------------------------------------------------------------

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_HISTORY_DIR',
  'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_VERTEX_KEY_FILE', 'MVP_VERTEX_PROJECT',
  'MVP_VERTEX_LOCATION', 'MVP_EMBEDDING_MODEL', 'EMBEDDING_MODEL', 'MVP_EMBEDDING_DIMS', 'EMBEDDING_DIMS',
  'GOOGLE_APPLICATION_CREDENTIALS', 'RENOR_EVAL_VERTEX_KEY_FILE', 'RENOR_EVAL_VERTEX_PROJECT', 'RENOR_EVAL_MODEL',
  'RENOR_EVAL_EMBEDDING_DIMS', 'RENOR_SEARCH_EVIDENCE', 'MVP_DB_PATH', 'MVP_INSTANCE_ID', 'RENOR_TELEMETRY_DISABLED',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const cleanups: Array<() => void | Promise<void>> = [];

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('get_context and search_memory', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    while (cleanups.length) await cleanups.pop()!();
  });
  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  /** Replaces `fetch` with a token endpoint and a predict endpoint in this process; a predict takes `predictMs`. */
  function fakeVertex(predictMs: number) {
    const seen = { queries: 0 };
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      if (String(url) === 'https://oauth.fake.test/token') {
        return new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }), { status: 200 });
      }
      if (/^https:\/\/europe-west4-aiplatform\.googleapis\.com\/.*:predict$/.test(String(url))) {
        await pause(predictMs);
        const body = JSON.parse(init.body) as { instances: Array<{ content: string; task_type: string }>; parameters: { outputDimensionality: number } };
        const predictions = body.instances.map(instance => {
          if (instance.task_type === 'RETRIEVAL_QUERY') seen.queries += 1;
          let seed = 0;
          for (const ch of instance.content) seed = (seed * 31 + ch.charCodeAt(0)) % 10007;
          return { embeddings: { values: Array.from({ length: body.parameters.outputDimensionality }, (_, i) => Math.sin(seed + i) / 3), statistics: { token_count: 3 } } };
        });
        return new Response(JSON.stringify({ predictions }), { status: 200 });
      }
      throw new Error(`the test reached an unexpected URL: ${url}`);
    });
    return seen;
  }

  function workspace(): MvpConfig {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'call-phases-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const authRoot = path.join(root, 'auth');
    fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
    fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = path.join(authRoot, 'fake-sa.json');
    fs.writeFileSync(keyFile, JSON.stringify({
      client_email: 'fake@fake.test',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      token_uri: 'https://oauth.fake.test/token',
    }));
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, {
      MVP_MEMORY_DIR: path.join(root, 'memory'),
      MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
      MVP_BASE_URL: 'http://127.0.0.1:3471',
      MVP_OWNER_EMAIL: 'owner@example.test',
      MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
      MVP_EMBEDDING_PROVIDER: 'vertex',
      MVP_VERTEX_KEY_FILE: keyFile,
      MVP_VERTEX_PROJECT: 'fake-project',
      MVP_VERTEX_LOCATION: 'europe-west4',
      RENOR_SEARCH_EVIDENCE: '0',
      RENOR_TELEMETRY_DISABLED: 'true', // no remote sink; the line on stdout is the record
      MVP_INSTANCE_ID: 'call-phases',
    });
    return loadMvpConfig();
  }

  async function connect(config: MvpConfig) {
    const app = createMvpApp(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'call-phases', version: '0.1.0' });
    await app.server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => { await client.close(); await app.close(); });
    return async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ text: string }>).map(c => c.text).join('\n');
      expect(res.isError, `${name}: ${text}`).not.toBe(true);
      return text;
    };
  }

  it('say where their time went on their tool_use line, and an embedding that came from the query cache says it made no call', async () => {
    const predictMs = 30;
    const fake = fakeVertex(predictMs);
    const config = workspace();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const call = await connect(config);
    await call('remember', { statement: 'The mango juice stand closes at six.' });

    const asked = await call('get_context', { query: 'when does the juice stand close' });
    const repeated = await call('get_context', { query: 'when does the juice stand close' });
    const searchedAgain = await call('search_memory', { query: 'when does the juice stand close' }); // the same words: the vector is cached
    const searchedNew = await call('search_memory', { query: 'what time does the stand shut for the day' });
    await call('memory_status');
    expect(fake.queries).toBe(2); // one embedding for each of the two different questions

    const uses = log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, any>)
      .filter(line => line.event === 'tool_use');
    const of = (tool: string) => uses.filter(use => use.tool === tool);
    const [miss, hit] = of('get_context');
    const [searchHit, searchMiss] = of('search_memory');

    // A question that had to be embedded: the whole embedding, its token, its request, then the matches and the reply.
    expect(Object.keys(miss.phases).sort()).toEqual(['call', 'embed', 'reply', 'retrieve', 'token']);
    expect(miss.phases.embed).toBeGreaterThanOrEqual(predictMs - 5);
    expect(miss.phases.call).toBeGreaterThanOrEqual(predictMs - 5);
    expect(miss.phases.embed).toBeGreaterThanOrEqual(miss.phases.call + miss.phases.token - 0.2);
    expect(miss.ms).toBeGreaterThanOrEqual(miss.phases.embed - 1);
    // The same question asked again: no embedding, token or request at all, only the two parts of the call that are the engine's.
    expect(Object.keys(hit.phases).sort()).toEqual(['reply', 'retrieve']);
    expect(Object.keys(searchHit.phases).sort()).toEqual(['reply', 'retrieve']);
    expect(Object.keys(searchMiss.phases).sort()).toEqual(['call', 'embed', 'reply', 'retrieve', 'token']);
    expect(searchMiss.phases.embed).toBeGreaterThanOrEqual(predictMs - 5);
    // Every other tool's line is as it was.
    for (const tool of ['remember', 'memory_status']) {
      expect(of(tool).length).toBeGreaterThan(0);
      for (const use of of(tool)) expect(use).not.toHaveProperty('phases');
    }

    // A reply knows nothing of it, and the one whose vector came from the cache says what the one from the service said. (A score
    // differs from one call to the next in its seventh decimal, as it does on main: the retrieval's own float noise, not the vector's.)
    const sameWords = (reply: string) => JSON.parse(reply, (key, value) => (key === 'score' && typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : value));
    expect(sameWords(repeated)).toEqual(sameWords(asked));
    expect(Object.keys(JSON.parse(repeated)).sort()).toEqual(Object.keys(JSON.parse(asked)).sort());
    expect([asked, repeated, searchedAgain, searchedNew].join('\n')).not.toMatch(/phases|"retrieve"|"embed"/);
  }, 60_000);
});
