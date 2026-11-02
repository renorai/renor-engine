// A minimal MCP Streamable HTTP client for hooks: initialize, then tools/call, each bounded by one deadline.
// A hook cannot use the connection Claude Code holds for the renor server (its OAuth stays inside Claude Code), so it
// authenticates with a Renor connect token of its own. That token is a credential, so:
//
// - it goes only to an https endpoint, or over plain http to a literal loopback address (127.0.0.1 or [::1]; not the
//   name `localhost`, which a hosts file or resolver can point anywhere): checkEndpoint refuses anything else before a
//   request is made;
// - a redirect is refused, never followed (fetch would strip the bearer on a cross-host hop, but still send the
//   session id, and the client would talk to a host it was not given);
// - an error says only what kind of failure it was (`HookError.category`), never text the server sent back.

const PROTOCOL_VERSION = '2025-06-18';
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

/** A failure the hook may log: `message` is one of a closed set of categories and holds no remote text. */
export class HookError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

/** The endpoint as a URL when the token may be sent to it; throws HookError('invalid-endpoint') otherwise. */
export function checkEndpoint(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new HookError('invalid-endpoint');
  }
  if (parsed.username || parsed.password) throw new HookError('invalid-endpoint');
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)) return parsed;
  throw new HookError('invalid-endpoint');
}

/** The JSON-RPC message in a reply that is JSON or an SSE stream (the last `data:` event that carries an id). */
async function readMessage(res) {
  const text = await res.text();
  try {
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const events = text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/)
        .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
        .filter(Boolean);
      for (const data of events.reverse()) {
        const message = JSON.parse(data);
        if (message && message.id !== undefined) return message;
      }
      throw new Error('no reply');
    }
    return JSON.parse(text);
  } catch {
    throw new HookError('bad-reply');
  }
}

/**
 * A client for `url` with `token`, whose callTool resolves to the tool's JSON reply and throws a HookError on any
 * failure. `signal` (an AbortSignal) ends every request when it fires. The endpoint is checked before any request.
 */
export function createHttpClient({ url, token, signal, clientName = 'renor-session-start', fetchImpl = globalThis.fetch }) {
  let endpoint;
  try {
    endpoint = checkEndpoint(url);
  } catch (err) {
    const refused = Promise.reject(err);
    refused.catch(() => {});
    return { callTool: () => refused };
  }
  let session = null;
  let nextId = 1;
  const post = async (body) => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (session) headers['mcp-session-id'] = session;
    let res;
    try {
      res = await fetchImpl(endpoint.href, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
    } catch {
      throw new HookError(signal?.aborted ? 'timeout' : 'network');
    }
    if (res.status >= 300 && res.status < 400) throw new HookError('redirect-refused');
    if (!res.ok && res.status !== 202) throw new HookError(`http-${res.status}`);
    return res;
  };
  const request = async (method, params) => {
    const res = await post({ jsonrpc: '2.0', id: nextId++, method, params });
    const message = await readMessage(res);
    if (message.error) throw new HookError(`rpc-${Number.isInteger(message.error.code) ? message.error.code : 'error'}`);
    return { res, result: message.result };
  };
  let ready = null;
  const init = () => (ready ??= (async () => {
    const { res } = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: '1' },
    });
    session = res.headers.get('mcp-session-id');
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  })());
  return {
    /** A JSON-RPC request outside tools/call (the session index); resolves to the reply's `result` object. */
    async callMethod(method, params) {
      await init();
      const { result } = await request(method, params);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HookError('bad-reply');
      return result;
    },
    async callTool(name, args) {
      await init();
      const { result } = await request('tools/call', { name, arguments: args });
      if (result?.isError) throw new HookError('tool-error');
      if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
      // The reply is the first text item; the hosted server may add a connection-status item after it on a first call.
      const text = (result?.content ?? []).find(c => c?.type === 'text')?.text ?? '';
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new HookError('bad-reply');
      }
    },
  };
}
