import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService } from '../../src/mvp/server';
import { StoredSizeGauge, measureMarkdownBytes } from '../../src/mvp/storedSize';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * How many bytes of Markdown a workspace stores, and how the engine tells the gateway.
 *
 * The plan's storage meter needs one number per workspace: the bytes of the user's notes and the engine's ledger. It is
 * measured here, on the engine, and rides on the `/internal/gateway-token` call the gateway already makes for every
 * request, so recording it costs no extra round trip and wakes nothing (an engine that sleeps has not changed what it
 * stores). What is pinned:
 *
 *   1. what counts: every regular `.md` file, the ledger included; not the index folder, not a non-Markdown file, not a
 *      file whose extension is not exactly `.md`, and never anything reached through a symbolic link;
 *   2. the gauge serves a figure at once, never blocks, never throws, refreshes in the background after its TTL, keeps the
 *      last good figure when a measurement fails, and runs one measurement at a time;
 *   3. the real route, over loopback, carries the figure beside the bearer, and still answers a mint with no figure yet.
 *
 * Synthetic data, loopback only, no embedding provider.
 */

const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function put(root: string, rel: string, bytes: number): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(bytes));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('measureMarkdownBytes: what a workspace stores', () => {
  it('adds up every regular .md file, the ledger included, at any depth', async () => {
    const root = tmp('stored-size-');
    put(root, 'a.md', 10);
    put(root, 'Daily/2026-10-05.md', 20);
    put(root, 'System/Memory Events Ledger.md', 30);
    put(root, 'deep/er/est/note.md', 7);
    expect(await measureMarkdownBytes(root)).toBe(67);
  });

  it('counts bytes, not characters: a note in another alphabet weighs what it weighs on disk', async () => {
    const root = tmp('stored-size-');
    const text = 'memória € 记忆';
    fs.writeFileSync(path.join(root, 'unicode.md'), text);
    expect(Buffer.byteLength(text)).toBeGreaterThan(text.length);
    expect(await measureMarkdownBytes(root)).toBe(Buffer.byteLength(text));
  });

  it('does not count the index, a non-Markdown file or a name whose extension is not exactly .md', async () => {
    const root = tmp('stored-size-');
    put(root, 'kept.md', 5);
    put(root, '.memory-index/index.db', 5000);
    put(root, '.memory-index/wal.md', 999); // inside the index folder: derived state, whatever it is called
    put(root, 'notes.txt', 1000);
    put(root, 'UPPER.MD', 500);
    put(root, 'archive.md.bak', 400);
    put(root, 'md', 300);
    expect(await measureMarkdownBytes(root)).toBe(5);
  });

  it('never follows a symbolic link: not a file link, not a folder link, whatever they point at', async () => {
    const root = tmp('stored-size-');
    const outside = tmp('stored-size-outside-');
    put(root, 'kept.md', 11);
    put(outside, 'secret.md', 100_000);
    put(outside, 'folder/inner.md', 100_000);
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'link.md'));
    fs.symlinkSync(path.join(outside, 'folder'), path.join(root, 'linked-folder'));
    expect(await measureMarkdownBytes(root)).toBe(11);
  });

  it('counts more files than one stat chunk (64) without losing any', async () => {
    const root = tmp('stored-size-');
    for (let i = 0; i < 150; i += 1) put(root, `bulk/${i}.md`, 3);
    expect(await measureMarkdownBytes(root)).toBe(450);
  });

  it('is 0 for an empty workspace and rejects for a directory that does not exist', async () => {
    expect(await measureMarkdownBytes(tmp('stored-size-'))).toBe(0);
    await expect(measureMarkdownBytes(path.join(tmp('stored-size-'), 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('StoredSizeGauge: serve now, measure in the background', () => {
  /** A measurement the test finishes by hand. */
  function manual() {
    const calls: Array<{ resolve: (n: number) => void; reject: (e: Error) => void }> = [];
    const measure = () =>
      new Promise<number>((resolve, reject) => {
        calls.push({ resolve, reject });
      });
    return { measure, calls };
  }

  it('starts measuring when it is made, so the first call after a wake already has a figure', async () => {
    const { measure, calls } = manual();
    const gauge = new StoredSizeGauge('/unused', { measure });
    expect(calls).toHaveLength(1);
    expect(gauge.read()).toBeNull(); // not finished yet: never blocks, never waits
    calls[0].resolve(1234);
    await gauge.settled();
    expect(gauge.read()).toBe(1234);
  });

  it('serves the figure it has until the TTL, without measuring again', async () => {
    let now = 1_000;
    const { measure, calls } = manual();
    const gauge = new StoredSizeGauge('/unused', { measure, ttlMs: 30_000, now: () => now });
    calls[0].resolve(100);
    await gauge.settled();
    now += 29_999;
    expect(gauge.read()).toBe(100);
    expect(gauge.read()).toBe(100);
    expect(calls).toHaveLength(1);
  });

  it('after the TTL it answers with the old figure at once and refreshes for the next caller', async () => {
    let now = 0;
    const { measure, calls } = manual();
    const gauge = new StoredSizeGauge('/unused', { measure, ttlMs: 30_000, now: () => now });
    calls[0].resolve(100);
    await gauge.settled();
    now += 30_000;
    expect(gauge.read()).toBe(100); // the stale figure, immediately
    expect(calls).toHaveLength(2); // and a measurement is under way
    calls[1].resolve(250);
    await gauge.settled();
    expect(gauge.read()).toBe(250);
  });

  it('runs one measurement at a time however many calls arrive while it runs', async () => {
    const { measure, calls } = manual();
    const gauge = new StoredSizeGauge('/unused', { measure, ttlMs: 0 });
    for (let i = 0; i < 25; i += 1) gauge.read();
    expect(calls).toHaveLength(1);
    calls[0].resolve(1);
    await gauge.settled();
  });

  it('keeps the last good figure when a measurement fails, and retries after the TTL rather than on every call', async () => {
    let now = 0;
    const { measure, calls } = manual();
    const gauge = new StoredSizeGauge('/unused', { measure, ttlMs: 30_000, now: () => now });
    calls[0].resolve(500);
    await gauge.settled();
    now += 30_000;
    gauge.read();
    calls[1].reject(new Error('EIO'));
    await gauge.settled();
    expect(gauge.read()).toBe(500);
    expect(gauge.read()).toBe(500);
    expect(calls).toHaveLength(2); // a failure did not turn into a retry per call
    now += 30_000;
    gauge.read();
    expect(calls).toHaveLength(3);
    calls[2].resolve(600);
    await gauge.settled();
    expect(gauge.read()).toBe(600);
  });

  it('stays null, without throwing, while no measurement has ever succeeded', async () => {
    const { measure, calls } = manual();
    const gauge = new StoredSizeGauge('/unused', { measure });
    calls[0].reject(new Error('ENOENT'));
    await gauge.settled();
    expect(gauge.read()).toBeNull();
  });

  it('does not let a measurement that throws synchronously, or answers nonsense, reach the caller or the figure', async () => {
    const throwing = new StoredSizeGauge('/unused', {
      measure: () => {
        throw new Error('boom');
      },
    });
    await throwing.settled();
    expect(throwing.read()).toBeNull();

    for (const nonsense of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 60]) {
      const gauge = new StoredSizeGauge('/unused', { measure: async () => nonsense });
      await gauge.settled();
      expect(gauge.read(), `a measurement of ${nonsense}`).toBeNull();
    }
  });

  it('awaits initial measurement, then starts a new admission walk rather than authorizing from the initial value', async () => {
    const { measure, calls } = manual();
    const gauge = new StoredSizeGauge('/unused', { measure });
    const fresh = gauge.readFresh();
    expect(calls).toHaveLength(1);
    calls[0].resolve(10);
    await gauge.settled();
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    calls[1].resolve(40);
    expect(await fresh).toBe(40);
  });

  it('fresh admission never falls back to a cached size after failure or invalid data', async () => {
    let value: number | Error = 12;
    const gauge = new StoredSizeGauge('/unused', { measure: async () => {
      if (value instanceof Error) throw value;
      return value;
    } });
    await gauge.settled();
    value = 30;
    expect(await gauge.readFresh()).toBe(30);
    value = new Error('EIO');
    expect(await gauge.readFresh()).toBeNull();
    expect(gauge.read()).toBe(30);
    value = NaN;
    expect(await gauge.readFresh()).toBeNull();
  });

  it('measures a real directory by default', async () => {
    const root = tmp('stored-size-');
    put(root, 'one.md', 40);
    put(root, 'two/three.md', 2);
    const gauge = new StoredSizeGauge(root);
    await gauge.settled();
    expect(gauge.read()).toBe(42);
  });
});

/**
 * The real route, on the real engine, over loopback: the figure arrives beside the bearer the gateway reads.
 */
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('POST /internal/gateway-token carries the stored size', () => {
  const GATEWAY_SECRET = 'synthetic-gateway-secret-stored-size';
  const ENV_KEYS = [
    'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
    'MVP_PORT', 'MVP_ALLOWED_CALLBACK_URIS', 'MVP_GATEWAY_SECRET', 'MVP_MCP_JSON',
  ];
  let started: Awaited<ReturnType<typeof startMvpService>> | null = null;
  let config: MvpConfig;
  let memoryDir = '';

  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  beforeAll(async () => {
    const port = await freePort();
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-stored-size-'));
    const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-stored-size-auth-'));
    tmpDirs.push(authRoot);
    // The workspace already holds 3 notes and a ledger when the engine starts.
    put(memoryDir, 'Notes/first.md', 100);
    put(memoryDir, 'Notes/second.md', 200);
    put(memoryDir, 'Daily/2026-10-05.md', 300);
    put(memoryDir, 'ignored/not-markdown.txt', 4000);
    process.env.MVP_MEMORY_DIR = memoryDir;
    process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
    process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MVP_OWNER_EMAIL = 'owner@example.test';
    process.env.MVP_OWNER_PASSWORD = 'synthetic-owner-secret-123';
    process.env.MVP_PORT = String(port);
    process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
    process.env.MVP_GATEWAY_SECRET = GATEWAY_SECRET;
    process.env.MVP_MCP_JSON = 'true';
    config = loadMvpConfig();
    started = await startMvpService(config, null);
  });

  afterAll(async () => {
    if (started) {
      started.httpServer.closeAllConnections();
      started.httpServer.close();
      await started.close();
    }
    fs.rmSync(memoryDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) delete process.env[key];
  });

  async function mint(fresh = false): Promise<{ status: number; body: { access_token?: string; stored_bytes?: unknown } }> {
    const res = await fetch(`http://127.0.0.1:${config.port}/internal/gateway-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-renor-gateway-secret': GATEWAY_SECRET },
      body: JSON.stringify(fresh ? { fresh_storage: true } : {}),
    });
    return { status: res.status, body: (await res.json()) as { access_token?: string; stored_bytes?: unknown } };
  }

  it("answers the gateway's mint with the bearer and the bytes the workspace stores (the notes, not the .txt or the index)", async () => {
    // The first measurement starts with the engine; poll until it has landed rather than assuming how fast a disk is.
    let last = await mint();
    for (let i = 0; i < 60 && last.body.stored_bytes === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      last = await mint();
    }
    expect(last.status).toBe(200);
    expect(last.body.access_token).toEqual(expect.any(String));
    expect(last.body.stored_bytes).toBe(600);
  });

  it('measures new writes within the TTL on the enforcing admission path', async () => {
    put(memoryDir, 'rapid.md', 10);
    expect((await mint(true)).body.stored_bytes).toBe(610);
    put(memoryDir, 'rapid.md', 20);
    expect((await mint(true)).body.stored_bytes).toBe(620);
    fs.unlinkSync(path.join(memoryDir, 'rapid.md'));
  });

  it('never leaks the figure to a call that is not the gateway: the mint is refused without the secret', async () => {
    const res = await fetch(`http://127.0.0.1:${config.port}/internal/gateway-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-renor-gateway-secret': 'not-the-secret' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('stored_bytes');
  });
});
