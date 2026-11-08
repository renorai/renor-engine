import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import http from 'http';
import { EventEmitter } from 'events';
import { ActivityGauge, ACTIVITY_PATH, ACTIVITY_REPORT_VERSION, type BackgroundJob } from '../../src/mvp/activity';
import { runningBackgroundIndex } from '../../src/mvp/engine';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * What a release asks an engine before it restarts it (GET /internal/activity): tool calls in flight and when the last
 * one ended. The point of the report is what it does NOT count: an open MCP stream is a connected agent, not a call, so
 * a workspace whose agents are all connected and quiet reads zero. wait-until-idle.sh reads it (idle-gate.test.sh).
 *
 * Synthetic data only, loopback only, deterministic eval-hash embeddings.
 */

describe('ActivityGauge', () => {
  function clock(start = 1_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }
  function gate() {
    let release!: () => void;
    const open = new Promise<void>(resolve => { release = resolve; });
    return { open, release };
  }

  it('reports nothing running and nothing ended on a fresh process', () => {
    expect(new ActivityGauge().report()).toEqual({ renor: ACTIVITY_REPORT_VERSION, inFlight: 0, lastEndedAgoMs: null });
  });

  it('counts a call until it returns, then reports how long ago it ended', async () => {
    const c = clock();
    const gauge = new ActivityGauge(null, c.now);
    const g = gate();
    const call = gauge.track(async () => { await g.open; return 'done'; });
    expect(gauge.report().inFlight).toBe(1);
    expect(gauge.report().lastEndedAgoMs).toBeNull();
    c.advance(5_000);
    expect(gauge.report().inFlight).toBe(1); // still running however long it has run
    g.release();
    expect(await call).toBe('done');
    expect(gauge.report()).toEqual({ renor: ACTIVITY_REPORT_VERSION, inFlight: 0, lastEndedAgoMs: 0 });
    c.advance(2_500);
    expect(gauge.report().lastEndedAgoMs).toBe(2_500);
  });

  it('counts concurrent calls separately and ends the clock with the last one', async () => {
    const c = clock();
    const gauge = new ActivityGauge(null, c.now);
    const a = gate();
    const b = gate();
    const first = gauge.track(() => a.open);
    const second = gauge.track(() => b.open);
    expect(gauge.report().inFlight).toBe(2);
    a.release();
    await first;
    expect(gauge.report().inFlight).toBe(1);
    c.advance(100);
    b.release();
    await second;
    expect(gauge.report()).toMatchObject({ inFlight: 0, lastEndedAgoMs: 0 });
  });

  it('a call that throws is no longer in flight, and the error is the caller\'s', async () => {
    const gauge = new ActivityGauge();
    await expect(gauge.track(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gauge.report().inFlight).toBe(0);
    expect(gauge.report().lastEndedAgoMs).not.toBeNull();
  });

  it('hands the work to the idle monitor it wraps, once, and returns its result', async () => {
    const seen: string[] = [];
    const inner = { track: async <T>(work: () => Promise<T>) => { seen.push('inner'); return work(); } };
    const gauge = new ActivityGauge(inner);
    expect(await gauge.track(async () => 7)).toBe(7);
    expect(seen).toEqual(['inner']);
  });

  it('counts the call while the monitor it wraps is the one holding it', async () => {
    const g = gate();
    const inner = { track: async <T>(work: () => Promise<T>) => { await g.open; return work(); } };
    const gauge = new ActivityGauge(inner);
    const call = gauge.track(async () => 1);
    expect(gauge.report().inFlight).toBe(1);
    g.release();
    await call;
    expect(gauge.report().inFlight).toBe(0);
  });

  it('counts a request until its response has closed, however early its handler returned', async () => {
    const gauge = new ActivityGauge(null, clock().now);
    const res = new EventEmitter();
    gauge.request(res);
    await gauge.track(async () => undefined); // the tool handler is done
    expect(gauge.report().inFlight).toBe(1); // the response is not
    res.emit('close');
    expect(gauge.report()).toMatchObject({ inFlight: 0, lastEndedAgoMs: 0 });
    res.emit('close'); // a second close changes nothing
    expect(gauge.report().inFlight).toBe(0);
  });

  describe('background jobs a call starts and does not await', () => {
    function job() {
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const state = { waiting: false };
      const value: BackgroundJob = { done, waiting: () => state.waiting };
      return { value, state, finish };
    }

    it('count while they work, and end with their promise', async () => {
      const c = clock();
      const j = job();
      let running: BackgroundJob | null = j.value;
      const gauge = new ActivityGauge(null, c.now, () => [running, null]);
      expect(gauge.report().inFlight).toBe(1);
      expect(gauge.report().lastEndedAgoMs).toBeNull();
      c.advance(3_000);
      expect(gauge.report().inFlight).toBe(1);
      running = null; // the engine forgets a job as its promise settles
      j.finish();
      await j.value.done;
      await Promise.resolve();
      expect(gauge.report()).toMatchObject({ inFlight: 0, lastEndedAgoMs: 0 });
    });

    it('do not count while they only wait out a delay, and count again when they work', () => {
      const j = job();
      const gauge = new ActivityGauge(null, clock().now, () => [j.value]);
      j.state.waiting = true;
      expect(gauge.report().inFlight).toBe(0);
      j.state.waiting = false;
      expect(gauge.report().inFlight).toBe(1);
    });

    it('add to what is tracked, and a job that fails still ends', async () => {
      const g = gate();
      const failing: BackgroundJob = { done: Promise.reject(new Error('x')), waiting: () => false };
      failing.done.catch(() => undefined);
      const gauge = new ActivityGauge(null, clock().now, () => [failing]);
      const call = gauge.track(() => g.open);
      expect(gauge.report().inFlight).toBe(2);
      g.release();
      await call;
    });
  });

  it('never goes negative if the clock steps back', async () => {
    const c = clock(10_000);
    const gauge = new ActivityGauge(null, c.now);
    await gauge.track(async () => undefined);
    c.advance(-4_000);
    expect(gauge.report().lastEndedAgoMs).toBe(0);
  });
});

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const GATEWAY_SECRET = 'synthetic-gateway-secret';
const ISOLATED_ENV = [
  'RENOR_ON_DEMAND', 'RENOR_ON_DEMAND_IDLE_SECONDS', 'MVP_MCP_JSON', 'MVP_HISTORY_DIR',
  'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_DB_PATH',
];

type Started = Awaited<ReturnType<typeof startMvpService>>;
const running: Started[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) {
    s.httpServer.closeAllConnections();
    s.httpServer.close();
    await s.close();
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const keys = [...new Set([...ISOLATED_ENV, ...Object.keys(vars)])];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of ISOLATED_ENV) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The engine as a release finds it: always on (no RENOR_ON_DEMAND), behind the gateway secret. */
async function boot(opts: { provider?: EvalHashEmbeddingProvider; env?: Record<string, string> } = {}) {
  const port = await freePort();
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-activity-mem-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-activity-auth-'));
  tmpDirs.push(memoryDir, authRoot);
  const env: Record<string, string> = {
    MVP_PORT: String(port),
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: `http://127.0.0.1:${port}`,
    MVP_OWNER_EMAIL: OWNER_EMAIL,
    MVP_OWNER_PASSWORD: OWNER_PASSWORD,
    MVP_GATEWAY_SECRET: GATEWAY_SECRET,
    ...opts.env,
  };
  const config: MvpConfig = withEnv(env, () => loadMvpConfig());
  const started = await startMvpService(config, opts.provider ?? null);
  running.push(started);
  return { started, base: env.MVP_BASE_URL };
}

async function mint(base: string): Promise<string> {
  const res = await fetch(`${base}/internal/gateway-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-renor-gateway-secret': GATEWAY_SECRET },
    body: '{}',
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function activity(base: string): Promise<{ renor: string; inFlight: number; lastEndedAgoMs: number | null }> {
  const res = await fetch(`${base}${ACTIVITY_PATH}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return res.json() as Promise<{ renor: string; inFlight: number; lastEndedAgoMs: number | null }>;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`never became true: ${what}`);
}

/** The eval-hash stub, held inside embed() until released: an index job in flight. */
class GatedHashProvider extends EvalHashEmbeddingProvider {
  private markEntered!: () => void;
  readonly entered = new Promise<void>(resolve => { this.markEntered = resolve; });
  release!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });

  async embed(texts: string[]): Promise<number[][]> {
    this.markEntered();
    await this.gate;
    return super.embed(texts);
  }
}

/** Its first embedding call fails (the service is down: the save is kept for keyword search and the background index takes it), and the next is held. */
class FlakyThenGatedProvider extends EvalHashEmbeddingProvider {
  private calls = 0;
  gated = false;
  release!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });

  async embed(texts: string[]): Promise<number[][]> {
    if (this.calls++ === 0) throw new Error('the embedding service is down');
    this.gated = true;
    await this.gate;
    return super.embed(texts);
  }
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)(`GET ${ACTIVITY_PATH}`, () => {
  it('answers on an always-on engine with no credential: nothing running, nothing ended', async () => {
    const { base } = await boot();
    expect(await activity(base)).toEqual({ renor: ACTIVITY_REPORT_VERSION, inFlight: 0, lastEndedAgoMs: null });
  });

  it('is loopback-only: a forwarded request gets the same 404 as an unknown path, and nothing else in the body', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}${ACTIVITY_PATH}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    const unknown = await fetch(`${base}/internal/no-such-path`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(unknown.status).toBe(404);
  });

  it('an open MCP stream is not a call: a connected agent that is not calling leaves it at zero', async () => {
    const { base } = await boot({ env: { MVP_MCP_JSON: 'false' } });
    const token = await mint(base);
    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'activity-probe', version: '0' } },
      }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id')!;
    await init.text();
    const stream = new AbortController();
    const open = await fetch(`${base}/mcp`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Mcp-Session-Id': sid },
      signal: stream.signal,
    });
    expect(open.status).toBe(200);
    try {
      // The initialize call above has ended; the stream beside it is not work.
      expect((await activity(base)).inFlight).toBe(0);
    } finally {
      stream.abort();
    }
  }, 30_000);

  it('a write whose index job is still running is in flight, even after its client has gone, and then it has ended', async () => {
    const provider = new GatedHashProvider();
    const { base } = await boot({ provider });
    const token = await mint(base);
    const client = new AbortController();
    const call = fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'remember', arguments: { statement: 'The activity test keeps a numbat sanctuary note.' } },
      }),
      signal: client.signal,
    }).catch(() => null);
    await provider.entered;
    expect((await activity(base)).inFlight).toBeGreaterThanOrEqual(1);
    client.abort();
    await call;
    expect((await activity(base)).inFlight).toBeGreaterThanOrEqual(1); // the client left; the work did not
    provider.release();
    await until(async () => (await activity(base)).inFlight === 0, 'the write finished');
    const done = await activity(base);
    expect(done.lastEndedAgoMs).not.toBeNull();
    expect(done.lastEndedAgoMs!).toBeLessThan(10_000);
  }, 30_000);

  it('on-demand: the look neither keeps a sleeping engine awake nor changes what the report says', async () => {
    const { started, base } = await boot({ env: { RENOR_ON_DEMAND: '1', RENOR_ON_DEMAND_IDLE_SECONDS: '600' } });
    expect(started.idle).not.toBeNull();
    expect(await activity(base)).toEqual({ renor: ACTIVITY_REPORT_VERSION, inFlight: 0, lastEndedAgoMs: null });
  });

  it('work a call started and did not await keeps it busy after the response is complete, until the job ends', async () => {
    const provider = new FlakyThenGatedProvider();
    const { started, base } = await boot({ provider });
    const token = await mint(base);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'remember', arguments: { statement: 'The activity test keeps a bilby sanctuary note.' } },
      }),
    });
    expect(res.status).toBe(200);
    await res.text(); // the response is complete: the client has everything
    // The save found the embedding service down (its first call failed) and handed the note to the background index.
    await until(async () => runningBackgroundIndex(started.db) !== null, 'the background index started');
    await until(async () => provider.gated, 'the background index is embedding (held)');
    const job = runningBackgroundIndex(started.db)!;
    const during = await activity(base);
    expect(during.inFlight, 'no request, no tool call: only the background job is working').toBeGreaterThanOrEqual(1);
    provider.release();
    await job.done;
    const after = await activity(base);
    expect(after.inFlight).toBe(0);
    expect(after.lastEndedAgoMs).not.toBeNull();
    expect(after.lastEndedAgoMs!).toBeLessThan(10_000);
  }, 40_000);

  describe('a request is counted until its HTTP response has finished or closed', () => {
    /** Holds the end of every POST /mcp response until released: the handler has returned, the response has not finished. */
    function holdResponses(httpServer: Started['httpServer']) {
      const held: Array<() => void> = [];
      httpServer.prependListener('request', (req, res) => {
        if (req.method !== 'POST' || req.url !== '/mcp') return;
        const end = res.end.bind(res) as (...args: unknown[]) => unknown;
        (res as any).end = (...args: unknown[]) => {
          if (res.destroyed) return end(...args); // the client is gone: nothing is being delivered any more
          held.push(() => end(...args));
          return res;
        };
      });
      return { release: () => { for (const fn of held.splice(0)) fn(); }, count: () => held.length };
    }
    const status = (token: string) => ({
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_status', arguments: {} } }),
    });

    it('stays counted after its tool call returned, until the response ends', async () => {
      const { started, base } = await boot();
      const held = holdResponses(started.httpServer);
      const token = await mint(base);
      const reply = fetch(`${base}/mcp`, status(token));
      await until(async () => held.count() > 0, 'the engine tried to end the response');
      await new Promise(r => setTimeout(r, 200)); // the handler has long returned
      expect((await activity(base)).inFlight).toBeGreaterThanOrEqual(1);
      held.release();
      expect((await reply).status).toBe(200);
      await until(async () => (await activity(base)).inFlight === 0, 'the response closed');
      expect((await activity(base)).lastEndedAgoMs).not.toBeNull();
    }, 30_000);

    it('ends when the client goes away from a response that was still being delivered', async () => {
      const { started, base } = await boot();
      const held = holdResponses(started.httpServer);
      const token = await mint(base);
      const body = status(token).body;
      const socket = net.connect(Number(new URL(base).port), '127.0.0.1');
      socket.on('error', () => undefined);
      await new Promise<void>(resolve => socket.once('connect', () => resolve()));
      socket.write(
        'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ' + token
        + '\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ' + Buffer.byteLength(body)
        + '\r\n\r\n' + body,
      );
      await until(async () => held.count() > 0, 'the engine tried to end the response');
      await new Promise(r => setTimeout(r, 200));
      expect((await activity(base)).inFlight).toBeGreaterThanOrEqual(1);
      socket.destroy(); // the connection closes with the response unfinished
      await until(async () => (await activity(base)).inFlight === 0, 'the abandoned response closed');
    }, 30_000);

    it('counts a request whose body is still arriving, and ends it when the client goes', async () => {
      const { base } = await boot();
      const token = await mint(base);
      const url = new URL(base);
      const socket = net.connect(Number(url.port), '127.0.0.1');
      await new Promise<void>(resolve => socket.once('connect', () => resolve()));
      socket.write(
        'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ' + token
        + '\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 500\r\n\r\n{"jsonrpc":"2.0",',
      );
      await until(async () => (await activity(base)).inFlight >= 1, 'the half-sent request is counted');
      socket.destroy();
      await until(async () => (await activity(base)).inFlight === 0, 'the abandoned request ended');
    }, 30_000);

    it('does not count the idle GET stream, only the POST beside it', async () => {
      const { started, base } = await boot({ env: { MVP_MCP_JSON: 'false' } });
      const held = holdResponses(started.httpServer);
      const token = await mint(base);
      const init = fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'activity-probe', version: '0' } },
        }),
      });
      await until(async () => held.count() > 0, 'the initialize response is held');
      expect((await activity(base)).inFlight).toBeGreaterThanOrEqual(1);
      held.release();
      const response = await init;
      const sid = response.headers.get('mcp-session-id')!;
      await response.text();
      const stream = new AbortController();
      const open = await fetch(`${base}/mcp`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Mcp-Session-Id': sid },
        signal: stream.signal,
      });
      expect(open.status).toBe(200);
      try {
        await until(async () => (await activity(base)).inFlight === 0, 'only the stream is left, and it is not work');
      } finally {
        stream.abort();
      }
    }, 30_000);
  });
});
