import dc from 'node:diagnostics_channel';

/**
 * `fetch` with a longer-lived connection pool.
 *
 * Node's own `fetch` (undici) closes a connection that has been idle for 4 s, unless the server's `Keep-Alive: timeout=N`
 * says otherwise, and Google's embedding endpoint sends no such hint. A read that comes more than 4 s after the one before it,
 * which is how an agent reads, therefore opened a new TCP and TLS connection (and looked the address up again) before it could
 * ask for its query vector.
 *
 * The pool is the same pool with a longer idle timer, built from the class of the global dispatcher so that no package is
 * added and the requests, their headers, bodies, aborts and errors are exactly `fetch`'s. Where the global dispatcher is not
 * there (another runtime, a Node without undici, a Node that registers only a wrapper around its pool) the plain `fetch` is
 * returned and nothing changes. A server that sends its own `Keep-Alive: timeout=N` is still obeyed when N is shorter, which is
 * how a service says how long it will wait; one that names a longer time does not make the pool hold a connection longer than
 * its own timer.
 *
 * The sockets are bounded: at most POOL_MAX_CONNECTIONS to an origin, and a request beyond that waits for a free one. A socket
 * with no request on it does not keep a process alive (undici unrefs it; checked on Node 22.23.3, undici 6.28.1), so the pool
 * never delays an exit.
 *
 * A connection that sat idle can be one the server closed meanwhile; the request then fails with a reset before any answer.
 * `retryOnReset` sends such a request once more, on a new connection. It is for requests that are safe to send twice (an
 * embedding is a pure function of its text) and that can be sent again (a body held in memory, not a stream).
 */

/**
 * Where undici registers the dispatcher the global `fetch` uses; the symbol is how its own `getGlobalDispatcher` finds it.
 * Node 22 (undici 6) has only `.1`; Node 24 (undici 7) puts the same Agent under both; Node 26 (undici 8) keeps the Agent
 * under `.2` and a wrapper for older callers under `.1`. Newest first.
 */
const GLOBAL_DISPATCHERS = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')];

/**
 * How long an idle connection is kept. Google's front end closes an idle connection after 240 s: measured on 2026-10-18 on the
 * embedding endpoints of two regions and on the token endpoint, with and without a request on the connection
 * (240.0 to 240.2 s each), and it sends no `Keep-Alive` hint. The pool lets go a minute earlier, so a request is not sent into a
 * connection Google is closing, and the minute covers the pauses an agent makes (a connection that Google does close first is
 * sent the request again: `retryOnReset`).
 */
export const DEFAULT_POOL_IDLE_MS = 180_000;

/** Connections to one origin. The service has at most four index requests in flight (coalescing.ts) and an agent's reads beside them. */
const POOL_MAX_CONNECTIONS = 8;

/**
 * What a connection the other side closed looks like when `fetch` reports it, somewhere in the `cause` chain of its `TypeError`:
 * a reset or a broken pipe from the socket, or undici's own `SocketError` (its `code` says "UND_ERR_SOCKET"; the class is named
 * here because that code, written out in src/, reads as an environment variable to the guard in tests/docs/environment-variables.test.ts).
 */
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE']);
const RESET_ERROR = 'SocketError';

type Fetch = typeof fetch;

/** A `fetch` whose connections can be let go of (nothing to let go of when it is the plain `fetch`). */
export type PooledFetch = Fetch & { close(): Promise<void> };

export interface PoolFetchOptions {
  /** How long an idle connection is kept, from 1000 to 600000 ms. */
  idleMs?: number;
  /** Send a request once more, on a new connection, when its connection was reset before any answer. */
  retryOnReset?: boolean;
  /**
   * Called with the milliseconds a new connection took to open (TCP and TLS, and the address lookup) each time this pool opens
   * one to an origin it has requested. Not called for a request that reuses a connection. With requests in flight to the same
   * origin together, which of them a connection is counted for is approximate.
   */
  onConnect?: (ms: number) => void;
}

function isReset(err: unknown): boolean {
  let cause: unknown = err;
  for (let depth = 0; cause && depth < 4; depth++) {
    const { code, name } = cause as { code?: unknown; name?: unknown };
    if ((typeof code === 'string' && RESET_CODES.has(code)) || name === RESET_ERROR) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/** A body that can be sent again: none, or one held in memory. */
function replayable(init: RequestInit | undefined): boolean {
  const body = init?.body;
  return body === undefined || body === null || typeof body === 'string' || body instanceof URLSearchParams
    || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

/** `host:port` of an origin, the same way for a URL and for the connect parameters undici publishes. */
function originKey(hostname: string, port: string, protocol: string): string {
  return `${hostname}:${port || (protocol === 'https:' ? '443' : '80')}`;
}

function urlOriginKey(input: Parameters<Fetch>[0]): string | null {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return originKey(url.hostname, url.port, url.protocol);
  } catch {
    return null;
  }
}

interface ConnectMessage {
  connectParams?: { hostname?: string; port?: string | number; protocol?: string };
}

/**
 * Times the connections undici opens to `origins`, from its own diagnostics channel (every connection of the process is
 * announced there, so only the origins this pool has asked for count). Returns what stops it listening.
 */
function watchConnects(origins: Set<string>, onConnect: (ms: number) => void): () => void {
  const opening = new Map<string, number[]>();
  const keyOf = (message: unknown): string | null => {
    const params = (message as ConnectMessage).connectParams;
    if (!params || typeof params.hostname !== 'string') return null;
    const key = originKey(params.hostname, String(params.port ?? ''), String(params.protocol ?? ''));
    return origins.has(key) ? key : null;
  };
  const begun = (message: unknown) => {
    const key = keyOf(message);
    if (key === null) return;
    const starts = opening.get(key) ?? [];
    starts.push(performance.now());
    if (starts.length > 16) starts.shift(); // an attempt that never reported back is not kept for ever
    opening.set(key, starts);
  };
  const ended = (message: unknown, ok: boolean) => {
    const key = keyOf(message);
    const started = key === null ? undefined : opening.get(key)?.shift();
    if (started !== undefined && ok) onConnect(performance.now() - started);
  };
  const connected = (message: unknown) => ended(message, true);
  const failed = (message: unknown) => ended(message, false);
  dc.subscribe('undici:client:beforeConnect', begun);
  dc.subscribe('undici:client:connected', connected);
  dc.subscribe('undici:client:connectError', failed);
  return () => {
    dc.unsubscribe('undici:client:beforeConnect', begun);
    dc.unsubscribe('undici:client:connected', connected);
    dc.unsubscribe('undici:client:connectError', failed);
  };
}

export function poolFetch(options: PoolFetchOptions = {}): PooledFetch {
  const idleMs = options.idleMs ?? DEFAULT_POOL_IDLE_MS;
  if (!Number.isInteger(idleMs) || idleMs < 1_000 || idleMs > 600_000) {
    throw new Error('poolFetch needs an idle time between 1000 and 600000 ms');
  }
  // Looked up at each call, as a bare `fetch(...)` is, so a stub installed on the global later is still the one that answers.
  const plain: Fetch = (input, init) => globalThis.fetch(input, init);
  const unpooled = (): PooledFetch => Object.assign(plain, { close: async () => undefined });
  // Reading one of undici's globals loads it (`fetch` itself loads it only when it is first called), and undici registers
  // its dispatcher when it loads.
  void globalThis.Headers;
  // Only the plain pool is known to take these options, not a wrapper around it.
  const Pool = GLOBAL_DISPATCHERS
    .map(symbol => ((globalThis as Record<symbol, unknown>)[symbol] as { constructor?: { name?: string } } | undefined)?.constructor)
    .find(ctor => typeof ctor === 'function' && ctor.name === 'Agent');
  if (!Pool) return unpooled();
  let dispatcher: { close(): Promise<void> };
  try {
    // keepAliveMaxTimeout caps what a server's own `Keep-Alive` hint may stretch the idle timer to: the hint can only shorten it.
    dispatcher = new (Pool as new (options: { keepAliveTimeout: number; keepAliveMaxTimeout: number; connections: number }) => { close(): Promise<void> })({
      keepAliveTimeout: idleMs,
      keepAliveMaxTimeout: idleMs,
      connections: POOL_MAX_CONNECTIONS,
    });
  } catch {
    return unpooled();
  }
  const origins = new Set<string>();
  const stopWatching = options.onConnect ? watchConnects(origins, options.onConnect) : () => undefined;
  const pooled: Fetch = (input, init) => {
    const origin = urlOriginKey(input);
    if (origin !== null) origins.add(origin);
    return globalThis.fetch(input, { ...init, dispatcher } as RequestInit);
  };
  const close = async () => {
    stopWatching();
    await dispatcher.close();
  };
  if (!options.retryOnReset) return Object.assign(pooled, { close });
  const retrying: Fetch = async (input, init) => {
    try {
      return await pooled(input, init);
    } catch (err) {
      // A call the caller already stopped is not sent again, and neither is one whose body cannot be.
      if (!isReset(err) || init?.signal?.aborted || !replayable(init)) throw err;
      return pooled(input, init);
    }
  };
  return Object.assign(retrying, { close });
}
