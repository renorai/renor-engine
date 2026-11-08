import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import type { ChildProcess } from 'child_process';
import { forgetTree, killTree, spawnTree } from '../helpers/childTree';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * On-demand idle exit (RENOR_ON_DEMAND): an engine with nothing to do exits cleanly so its
 * workspace stops holding RAM, and the gateway starts it again on the next request. It
 * must never exit under work: an open request or stream, or a write/index job that is
 * still running after its client disconnected. Readiness probes and refused requests must
 * not keep it awake. With the switch off nothing changes.
 *
 * Synthetic data only, loopback only, deterministic eval-hash embeddings.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const GATEWAY_SECRET = 'synthetic-gateway-secret';
const ENGINE_DIR = path.join(__dirname, '../..');
const TSX = path.join(ENGINE_DIR, 'node_modules/.bin/tsx');
const ISOLATED_ENV = [
  'RENOR_ON_DEMAND', 'RENOR_ON_DEMAND_IDLE_SECONDS', 'MVP_MCP_JSON', 'MVP_HISTORY_DIR',
  'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_DB_PATH',
];

type Started = Awaited<ReturnType<typeof startMvpService>>;
const running: Started[] = [];
const tmpDirs: string[] = [];
/** Engines this file started as real processes: torn down with the rest, not by a timer. */
const engines: ChildProcess[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) {
    s.httpServer.closeAllConnections();
    s.httpServer.close();
    await s.close();
  }
  for (const engine of engines.splice(0)) killTree(engine);
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Runs `fn` with exactly these variables set (and the on-demand ones cleared otherwise). */
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

async function tenantEnv(): Promise<Record<string, string>> {
  const port = await freePort();
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-idle-mem-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-idle-auth-'));
  tmpDirs.push(memoryDir, authRoot);
  return {
    MVP_PORT: String(port),
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: `http://127.0.0.1:${port}`,
    MVP_OWNER_EMAIL: OWNER_EMAIL,
    MVP_OWNER_PASSWORD: OWNER_PASSWORD,
    MVP_GATEWAY_SECRET: GATEWAY_SECRET,
  };
}

async function boot(opts: { idleExitMs?: number; env?: Record<string, string>; provider?: EmbeddingProvider } = {}) {
  const env = { ...(await tenantEnv()), ...opts.env };
  const config: MvpConfig = withEnv(env, () => loadMvpConfig());
  if (opts.idleExitMs !== undefined) config.idleExitMs = opts.idleExitMs;
  const started = await startMvpService(config, opts.provider ?? null);
  running.push(started);
  return { started, base: env.MVP_BASE_URL };
}

/** 'exited' once the engine has drained and stopped listening, else 'running' after `ms`. */
function settle(started: Started, ms: number): Promise<'exited' | 'running'> {
  return Promise.race([
    started.idleExit!.then(() => 'exited' as const),
    sleep(ms).then(() => 'running' as const),
  ]);
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

describe('on-demand switch (RENOR_ON_DEMAND)', () => {
  it('is off by default and reads the switch and idle period strictly', async () => {
    const env = await tenantEnv();
    expect(withEnv(env, () => loadMvpConfig()).idleExitMs).toBeNull();
    expect(withEnv({ ...env, RENOR_ON_DEMAND: '0' }, () => loadMvpConfig()).idleExitMs).toBeNull();
    expect(withEnv({ ...env, RENOR_ON_DEMAND: '1' }, () => loadMvpConfig()).idleExitMs).toBe(600_000);
    expect(withEnv({ ...env, RENOR_ON_DEMAND: 'true', RENOR_ON_DEMAND_IDLE_SECONDS: '5' }, () => loadMvpConfig()).idleExitMs).toBe(5_000);
    expect(() => withEnv({ ...env, RENOR_ON_DEMAND: 'yes' }, () => loadMvpConfig())).toThrow(/RENOR_ON_DEMAND/);
    for (const bad of ['0', '1.5', 'ten', '86401']) {
      expect(() => withEnv({ ...env, RENOR_ON_DEMAND: '1', RENOR_ON_DEMAND_IDLE_SECONDS: bad }, () => loadMvpConfig()))
        .toThrow(/RENOR_ON_DEMAND_IDLE_SECONDS/);
    }
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('with the switch off the engine has no idle monitor and keeps serving', async () => {
    const { started, base } = await boot();
    expect(started.idle).toBeNull();
    expect(started.idleExit).toBeNull();
    await sleep(300);
    expect((await fetch(`${base}/version`)).status).toBe(200);
  });
});

describe('on-demand idle exit of a running engine', () => {
  it.skipIf(HTTP_SERVER_UNSUPPORTED)('exits after the idle period with nothing in flight and stops listening', async () => {
    const t0 = Date.now();
    const { started, base } = await boot({ idleExitMs: 400 });
    expect(await settle(started, 20_000)).toBe('exited');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390);
    await expect(fetch(`${base}/version`)).rejects.toThrow();
  }, 30_000);

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('readiness probes, scanners and refused requests do not keep it awake', async () => {
    const { started, base } = await boot({ idleExitMs: 800 });
    let polling = true;
    const poller = (async () => {
      while (polling) {
        await Promise.allSettled([
          fetch(`${base}/version`),
          fetch(`${base}/`),
          fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
          fetch(`${base}/internal/gateway-token`, { method: 'POST', headers: { 'x-renor-gateway-secret': 'wrong' } }),
        ]);
        await sleep(100);
      }
    })();
    try {
      expect(await settle(started, 20_000)).toBe('exited');
    } finally {
      polling = false;
      await poller;
    }
  }, 30_000);

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('an open SSE stream holds it awake; it exits an idle period after the stream closes', async () => {
    const { started, base } = await boot({ idleExitMs: 500, env: { MVP_MCP_JSON: 'false' } });
    const token = await mint(base);
    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'idle-probe', version: '0' } },
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

    expect(await settle(started, 2_000)).toBe('running');
    expect(started.idle!.isDraining).toBe(false);

    const closedAt = Date.now();
    stream.abort();
    expect(await settle(started, 20_000)).toBe('exited');
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(490);
  }, 40_000);

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a write and index job holds it awake after its client disconnects, and completes before the drain', async () => {
    const provider = new GatedHashProvider();
    const { started, base } = await boot({ idleExitMs: 500, provider });
    const token = await mint(base);

    const client = new AbortController();
    const call = fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'remember', arguments: { statement: 'The drain test keeps a quokka sanctuary note.' } },
      }),
      signal: client.signal,
    }).catch(() => null);
    await provider.entered; // the note is written; its index job is waiting on embeddings
    client.abort();
    await call;

    expect(await settle(started, 2_500)).toBe('running');
    expect(started.idle!.isDraining).toBe(false);

    const releasedAt = Date.now();
    provider.release();
    expect(await settle(started, 20_000)).toBe('exited');
    expect(Date.now() - releasedAt).toBeGreaterThanOrEqual(490);
    const indexed = started.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE text LIKE ?').get('%quokka sanctuary%') as { n: number };
    expect(indexed.n).toBeGreaterThan(0);
  }, 40_000);

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a save that holds the engine past its idle deadline is durable across the sleep and the next wake', async () => {
    // On-demand split admission puts newborns and idle workspaces to sleep far more often than
    // always-on engines ever restarted, so the race that matters is a save still running when the
    // idle period ends: it must hold the engine awake, finish, and be there when the next request
    // wakes a NEW engine process on the same workspace.
    const env = await tenantEnv();
    const provider = new GatedHashProvider();
    const first = await boot({ idleExitMs: 400, env, provider });
    const token = await mint(first.base);
    const save = fetch(`${first.base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'remember', arguments: { statement: 'The wake test keeps a narwhal observatory note.' } },
      }),
    });
    await provider.entered;
    await sleep(1_000); // more than twice the idle period, with the save still in flight
    expect(first.started.idle!.isDraining).toBe(false);
    provider.release();
    expect((await save).status).toBe(200);
    expect(await settle(first.started, 20_000)).toBe('exited');
    await first.started.close(); // what the CLI does once the drain is over

    const wakePort = await freePort();
    const second = await boot({ env: { ...env, MVP_PORT: String(wakePort), MVP_BASE_URL: `http://127.0.0.1:${wakePort}` } });
    const again = await mint(second.base);
    const found = await fetch(`${second.base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${again}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'search_text', arguments: { query: 'narwhal observatory' } },
      }),
    });
    expect(found.status).toBe(200);
    expect(await found.text()).toContain('narwhal observatory');
  }, 60_000);

  it('the CLI exits with status 0 (so Restart=on-failure leaves the unit stopped)', async () => {
    const env = await tenantEnv();
    const child = spawnTree(TSX, ['src/mvp/cli.ts'], {
      cwd: ENGINE_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ...env,
        RENOR_ON_DEMAND: '1',
        RENOR_ON_DEMAND_IDLE_SECONDS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    engines.push(child);
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const timer = setTimeout(() => { killTree(child); }, 90_000);
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    forgetTree(child); // it exited on its own, as the assertion below requires
    expect(output).toContain('[mvp] Listening');
    expect(output).toContain('[mvp] idle: no work in flight for the idle period; exiting cleanly');
    expect(exit).toEqual({ code: 0, signal: null });
  }, 120_000);
});
