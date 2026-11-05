import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_POOL_IDLE_MS, poolFetch } from '../../src/net/poolFetch';

/**
 * `poolFetch` is `fetch` whose pool keeps an idle connection for a minute instead of 4 s. What is pinned is what a caller sees:
 * how many TCP connections a server is asked to accept for two calls that are a little more than 4 s apart, and that
 * nothing else about the call moved.
 *
 * Three servers answer at once, so the one pause (4.6 s) serves every case: Node's own fetch against a server that sends no
 * `Keep-Alive` hint (the premise: it opens a second connection, which is what the product's calls did after a pause), poolFetch
 * against the same kind of server (it opens one), and poolFetch against a server that says it will wait only 3 s (it is
 * obeyed, so a service can still say how long it will hold a connection). The servers have no idle timeout of their own, so
 * Node adds no `Keep-Alive` header to their answers and nothing but the caller's pool decides.
 */

// Every test here makes real HTTP requests, and two of them wait out real seconds (a connection's idle time); a loaded machine needs the room.
vi.setConfig({ testTimeout: 20_000 });

interface Origin {
  url: string;
  connections(): number;
  close(): Promise<void>;
}

const origins: Origin[] = [];

async function origin(hintSeconds?: number): Promise<Origin> {
  let connections = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', ...(hintSeconds ? { 'keep-alive': `timeout=${hintSeconds}` } : {}) });
    res.end(JSON.stringify({ method: req.method, saw: req.headers['x-test'] ?? null }));
  });
  server.keepAliveTimeout = 0;
  server.on('connection', () => { connections++; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const made: Origin = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    connections: () => connections,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  origins.push(made);
  return made;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(origins.splice(0).map(o => o.close()));
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const ask = async (request: typeof fetch, url: string) => (await request(url)).text();

describe('poolFetch', () => {
  it('opens one connection for two calls a little more than 4 s apart, where fetch opens two', async () => {
    const [plain, pooled, hinted] = [await origin(), await origin(), await origin(3)];
    const request = poolFetch();
    await Promise.all([ask(fetch, plain.url), ask(request, pooled.url), ask(request, hinted.url)]);
    await sleep(4_600);
    await Promise.all([ask(fetch, plain.url), ask(request, pooled.url), ask(request, hinted.url)]);
    expect(plain.connections()).toBe(2);
    expect(pooled.connections()).toBe(1);
    expect(hinted.connections()).toBe(2);
  }, 20_000);

  it('answers as fetch does: the same status, headers and body for a POST, and the caller\'s signal ends the call', async () => {
    const server = await origin();
    const request = poolFetch();
    const init = { method: 'POST', body: '{"a":1}', headers: { 'x-test': 'yes', 'content-type': 'application/json' } };
    const pooled = await request(server.url, init);
    const plain = await fetch(server.url, init);
    expect(pooled.status).toBe(plain.status);
    expect(pooled.headers.get('content-type')).toBe(plain.headers.get('content-type'));
    expect(await pooled.text()).toBe(await plain.text());
    const stop = new AbortController();
    stop.abort(new Error('stopped by the caller'));
    await expect(request(server.url, { signal: stop.signal })).rejects.toThrow('stopped by the caller');
  });

  it('looks the global fetch up at each call, so a stub installed after it was built still answers', async () => {
    const seen: Array<{ url: string; init: RequestInit & { dispatcher?: unknown } }> = [];
    const request = poolFetch();
    vi.stubGlobal('fetch', async (input: string, init: RequestInit & { dispatcher?: unknown }) => {
      seen.push({ url: input, init });
      return new Response('stubbed');
    });
    expect(await (await request('http://example.invalid/x', { method: 'POST' })).text()).toBe('stubbed');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://example.invalid/x');
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.dispatcher).toBeDefined(); // the longer-lived pool rides along on the call
  });

  it('is plain fetch where the global dispatcher is not the plain pool it knows how to build', async () => {
    const registered = [Symbol.for('undici.globalDispatcher.1'), Symbol.for('undici.globalDispatcher.2')];
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const saved = registered.map(symbol => [symbol, Object.getOwnPropertyDescriptor(globals, symbol)] as const);
    const seen: Array<RequestInit & { dispatcher?: unknown }> = [];
    try {
      class Wrapper {} // a wrapper around the dispatcher (what Node 26 registers under `.1`), not the pool
      for (const symbol of registered) globals[symbol] = new Wrapper();
      const request = poolFetch();
      vi.stubGlobal('fetch', async (_input: string, init: RequestInit & { dispatcher?: unknown }) => { seen.push(init); return new Response('plain'); });
      expect(await (await request('http://example.invalid/y', { method: 'GET' })).text()).toBe('plain');
      expect(seen).toHaveLength(1);
      expect('dispatcher' in seen[0]).toBe(false);
    } finally {
      for (const [symbol, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globals, symbol, descriptor);
        else delete globals[symbol];
      }
    }
  });

  describe('a connection the server closed while it sat idle', () => {
    /** Serves the first request of each connection and resets the second one on the same connection, as a server that dropped an idle connection does. */
    async function resetting(): Promise<Origin & { requests(): number }> {
      let requests = 0;
      const seen = new WeakMap<object, number>();
      const server = http.createServer((req, res) => {
        requests++;
        const n = (seen.get(req.socket) ?? 0) + 1;
        seen.set(req.socket, n);
        req.resume();
        if (n === 2) { req.socket.destroy(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ n }));
      });
      server.keepAliveTimeout = 0;
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const made = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        connections: () => 0,
        requests: () => requests,
        close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
      };
      origins.push(made);
      return made;
    }
    const post = (request: typeof fetch, url: string, init: RequestInit = {}) => request(url, { method: 'POST', body: '{"q":1}', ...init });

    it('sends the request once more on a new connection when asked to, and fails as fetch does when not', async () => {
      const retried = await resetting();
      const request = poolFetch({ retryOnReset: true });
      expect(await (await post(request, retried.url)).json()).toEqual({ n: 1 });
      await sleep(20); // the connection is back in the pool before the next call
      expect(await (await post(request, retried.url)).json()).toEqual({ n: 1 }); // the reset second request was sent again, as the first of a new connection
      expect(retried.requests()).toBe(3);

      const unretried = await resetting();
      const plain = poolFetch();
      await (await post(plain, unretried.url)).text();
      await sleep(20);
      await expect(post(plain, unretried.url)).rejects.toThrow('fetch failed');
      expect(unretried.requests()).toBe(2);
    });

    it('does not send a request again whose body it cannot replay', async () => {
      const server = await resetting();
      const request = poolFetch({ retryOnReset: true });
      await (await post(request, server.url)).text();
      await sleep(20);
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"q":1}')); controller.close(); } });
      await expect(request(server.url, { method: 'POST', body: stream, duplex: 'half' } as RequestInit)).rejects.toThrow('fetch failed'); // the reset, not a second try
      expect(server.requests()).toBe(2); // the stream was sent once and not again
    });
  });

  describe('its limits', () => {
    it('keeps a connection through a pause of more than a minute and lets go of it before Google closes it', () => {
      // Google's front end closes an idle connection after 240 s (measured 2026-10-18); a read after more than 60 s idle is the case.
      expect(DEFAULT_POOL_IDLE_MS).toBeGreaterThan(65_000);
      expect(DEFAULT_POOL_IDLE_MS).toBeLessThanOrEqual(240_000 - 30_000);
    });

    it('opens at most 8 connections to one origin at once, and the requests beyond them wait for a free one', async () => {
      const POOL_MAX_CONNECTIONS = 8; // the bound the pool documents: a change to it is a change to this test
      let open = 0;
      let mostOpen = 0;
      const server = http.createServer((req, res) => {
        req.resume();
        setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }, 100);
      });
      server.keepAliveTimeout = 0;
      server.on('connection', socket => {
        open++;
        mostOpen = Math.max(mostOpen, open);
        socket.on('close', () => { open--; });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      origins.push({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        connections: () => mostOpen,
        close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
      });
      const request = poolFetch();
      const calls = POOL_MAX_CONNECTIONS * 2;
      const answers = await Promise.all(Array.from({ length: calls }, () => request(origins.at(-1)!.url, { method: 'POST', body: '{}' }).then(r => r.text())));
      expect(answers).toEqual(Array(calls).fill('ok'));
      expect(mostOpen).toBeGreaterThan(1);
      expect(mostOpen).toBeLessThanOrEqual(POOL_MAX_CONNECTIONS);
      await request.close();
    });

    it('lets go of a connection when its own idle time runs out, however long the server says it will wait', async () => {
      const [patient, plain] = [await origin(60), await origin()];
      const request = poolFetch({ idleMs: 1_000 });
      await ask(request, patient.url);
      await ask(request, plain.url);
      await sleep(2_500);
      await ask(request, patient.url);
      await ask(request, plain.url);
      expect(patient.connections()).toBe(2); // a hint of 60 s did not stretch the 1 s the pool keeps a connection
      expect(plain.connections()).toBe(2);
      await request.close();
    }, 20_000);
  });

  describe('onConnect', () => {
    it('is told how long each new connection took, once for each, and not for a call that reuses one', async () => {
      const server = await origin();
      const told: number[] = [];
      const request = poolFetch({ onConnect: ms => told.push(ms) });
      await ask(request, server.url);
      await sleep(50); // the connection is back in the pool before the next call
      await ask(request, server.url);
      expect(server.connections()).toBe(1);
      expect(told).toHaveLength(1);
      expect(Number.isFinite(told[0]) && told[0] >= 0).toBe(true);
      await request.close();
    });

    it('is told only of the origins the pool was asked for, not of a connection another fetch of the process opens', async () => {
      const [mine, other] = [await origin(), await origin()];
      const told: number[] = [];
      const request = poolFetch({ onConnect: ms => told.push(ms) });
      await ask(fetch, other.url);
      await ask(request, mine.url);
      expect(other.connections()).toBe(1);
      expect(told).toHaveLength(1);
      await request.close();
    });

    it('stops telling once the pool is closed', async () => {
      const server = await origin();
      const told: number[] = [];
      const request = poolFetch({ onConnect: ms => told.push(ms) });
      await ask(request, server.url);
      await request.close();
      expect(told).toHaveLength(1);
      await ask(fetch, server.url); // the same origin, opened by the process's own fetch
      expect(told).toHaveLength(1);
    });
  });

  it('refuses an idle time a pool cannot use', () => {
    for (const idleMs of [0, 999, 600_001, 1.5, Number.NaN]) {
      expect(() => poolFetch({ idleMs })).toThrow('poolFetch needs an idle time between 1000 and 600000 ms');
    }
  });
});
