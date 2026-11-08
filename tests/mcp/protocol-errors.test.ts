import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnTree, killTree } from '../helpers/childTree';
import { startWorkspace, restoreEnv, type Harness } from '../helpers/hiveHarness';
import { loadMvpConfig } from '../../src/mvp/config';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

const ENGINE = path.resolve(__dirname, '../..');
const WAIT = 20_000;

/**
 * Protocol-layer standing tests from adversary run adv-protocol-1012 (F2, F3, F4, F6, section 6 of its report).
 * Each one fails on the commit before its fix. The stdio tests run dist/cli.js, so `npm run build` runs first.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// The stdio server, one line per frame. Every line it writes is kept, so a test can assert what stdout did not carry.
function startStdio() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-errors-vault-'));
  const child = spawnTree(process.execPath, [path.join(ENGINE, 'dist/cli.js'), 'mcp'], {
    cwd: ENGINE,
    env: { PATH: process.env.PATH, VAULT_PATH: vault, EMBEDDING_PROVIDER: 'eval-hash',
      RENOR_TELEMETRY_DISABLED: 'true', RENOR_EVIDENCE_MODE: 'off', RENOR_VAULT_STALENESS: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin!.on('error', () => {});
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  let raw = '';
  child.stdout!.on('data', chunk => { raw += chunk.toString(); });
  cleanups.push(async () => {
    const closed = once(child, 'close');
    killTree(child);
    await closed;
    fs.rmSync(vault, { recursive: true, force: true });
  });
  const lines = (): string[] => raw.split('\n').filter(line => line.length > 0);
  const replies = (): any[] => lines().map(line => {
    try { return JSON.parse(line); } catch { return { NONJSON: line }; }
  });
  const waitFor = async (ok: (all: any[]) => boolean, ms = WAIT): Promise<boolean> => {
    const until = Date.now() + ms;
    while (!ok(replies()) && Date.now() < until) await new Promise(r => setTimeout(r, 50));
    return ok(replies());
  };
  return {
    send: (frame: string) => child.stdin!.write(frame + '\n'),
    sendBytes: (bytes: Buffer) => child.stdin!.write(bytes),
    replies,
    waitFor,
    stderr: () => stderr,
  };
}

const initialize = (id: number) => JSON.stringify({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'protocol-errors', version: '1' } },
});

describe('stdio: every frame gets an answer, and stdout carries only JSON-RPC (F2)', () => {
  it('a JSON-RPC batch is refused with -32600 and id null, and the server keeps answering', async () => {
    const s = startStdio();
    s.send(initialize(1));
    expect(await s.waitFor(all => all.some(l => l.id === 1))).toBe(true);
    s.send(JSON.stringify([{ jsonrpc: '2.0', id: 2, method: 'ping' }, { jsonrpc: '2.0', id: 3, method: 'ping' }]));
    expect(await s.waitFor(all => all.some(l => l.id === null && l.error?.code === -32600))).toBe(true);
    s.send(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }));
    expect(await s.waitFor(all => all.some(l => l.id === 4 && l.result !== undefined))).toBe(true);
    expect(s.replies().some(l => l.id === 2 || l.id === 3)).toBe(false);
  }, 30_000);

  it('an unparseable line is answered with -32700 and id null', async () => {
    const s = startStdio();
    s.send('{"jsonrpc":"2.0",');
    expect(await s.waitFor(all => all.some(l => l.id === null && l.error?.code === -32700))).toBe(true);
  }, 30_000);

  it('a line that is not UTF-8 gets one -32700 with id null, nothing else, and the server keeps answering', async () => {
    const s = startStdio();
    s.send(initialize(1));
    expect(await s.waitFor(all => all.some(l => l.id === 1))).toBe(true);
    s.sendBytes(Buffer.concat([Buffer.from('{"t":"caf'), Buffer.from([0xe9]), Buffer.from('"}\n')]));   // cp1252 e-acute
    expect(await s.waitFor(all => all.some(l => l.id === null && l.error?.code === -32700))).toBe(true);
    s.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));
    expect(await s.waitFor(all => all.some(l => l.id === 2 && l.result !== undefined))).toBe(true);
    expect(s.replies().filter(l => l.id === null)).toHaveLength(1);
    expect(s.replies().some(l => 'NONJSON' in l)).toBe(false);
  }, 30_000);

  it('a request with an invalid id (null, or an object) is answered with -32600 and id null', async () => {
    const s = startStdio();
    s.send(initialize(1));
    expect(await s.waitFor(all => all.some(l => l.id === 1))).toBe(true);
    s.send('{"jsonrpc":"2.0","id":null,"method":"ping"}');
    s.send('{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}');
    expect(await s.waitFor(all => all.filter(l => l.id === null && l.error?.code === -32600).length === 2)).toBe(true);
  }, 30_000);

  it('stdout holds only JSON-RPC lines through the bad frames', async () => {
    const s = startStdio();
    s.send(initialize(1));
    s.send('not json at all');
    s.send('[]');
    expect(await s.waitFor(all => all.some(l => l.id === null && l.error?.code === -32600))).toBe(true);
    expect(s.replies().filter(l => 'NONJSON' in l)).toEqual([]);
  }, 30_000);
});

describe('stdio: invalid params are -32602 with one line (F4)', () => {
  it('a tools/call whose arguments are not an object answers -32602, not the validator dump', async () => {
    const s = startStdio();
    s.send(initialize(1));
    expect(await s.waitFor(all => all.some(l => l.id === 1))).toBe(true);
    s.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    s.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: 'nope' } }));
    expect(await s.waitFor(all => all.some(l => l.id === 2))).toBe(true);
    const reply = s.replies().find(l => l.id === 2);
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error.message).toMatch(/^Invalid params: /);
    expect(reply.error.message).not.toContain('\n');
    expect(JSON.stringify(reply)).not.toContain('invalid_type');
  }, 30_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('HTTP: a body is read only after the bearer check, and no error renders a stack (F3)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
    restoreEnv();
  });

  // Not UTF-8: a cp1252 e-acute inside an otherwise well-formed request.
  const NON_UTF8_BODY = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"t":"caf'), Buffer.from([0xe9]), Buffer.from('"}}')]);

  const post = (port: number, body: string | Buffer, token?: string) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : new Uint8Array(body),
  });

  it('a malformed body without a bearer is refused 401 as JSON-RPC, with no stack or path', async () => {
    h = await startWorkspace();
    const res = await post(h.config.port, '{"jsonrpc":');
    const text = await res.text();
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(text).not.toMatch(/\bat \S+ \(|node_modules|SyntaxError|\/home\//);
  }, 30_000);

  it('an oversized body without a bearer is refused 401 before the parser reads it', async () => {
    h = await startWorkspace();
    const res = await post(h.config.port, `{"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  }, 30_000);

  it('a malformed body with a valid bearer is answered -32700 as JSON, with no stack', async () => {
    h = await startWorkspace();
    const token = await h.authorize('malformed-body-probe');
    const res = await post(h.config.port, '{"jsonrpc":', token);
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(JSON.parse(text).error.code).toBe(-32700);
    expect(text).not.toMatch(/\bat \S+ \(|node_modules|SyntaxError/);
  }, 30_000);

  it('an oversized body with a valid bearer is answered 413 as JSON-RPC, with no stack', async () => {
    h = await startWorkspace();
    const token = await h.authorize('oversized-body-probe');
    const res = await post(h.config.port, `{"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`, token);
    const text = await res.text();
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(JSON.parse(text).error.code).toBe(-32600);
    expect(text).not.toMatch(/\bat \S+ \(|node_modules|PayloadTooLargeError/);
  }, 30_000);

  it('a body that is not UTF-8 without a bearer is refused 401 before the parser sees it', async () => {
    h = await startWorkspace();
    const res = await post(h.config.port, NON_UTF8_BODY);
    const text = await res.text();
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(text).not.toMatch(/\bat \S+ \(|node_modules|SyntaxError|\/home\//);
  }, 30_000);

  it('a body that is not UTF-8 with a valid bearer is answered -32700 as JSON, with no stack', async () => {
    h = await startWorkspace();
    const token = await h.authorize('non-utf8-body-probe');
    const res = await post(h.config.port, NON_UTF8_BODY, token);
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(JSON.parse(text).error.code).toBe(-32700);
    expect(text).not.toMatch(/\bat \S+ \(|node_modules|SyntaxError|\/home\//);
  }, 30_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('HTTP: invalid params are -32602 with one line (F4)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
    restoreEnv();
  });

  // JSON mode answers with application/json; a session answers with an SSE event. Both carry one JSON-RPC reply.
  const replyOf = (body: string) => JSON.parse(body.match(/data: (.*)/)?.[1] ?? body);

  it('tools/call with arguments that are not an object answers -32602 with one line', async () => {
    h = await startWorkspace();
    const token = await h.authorize('invalid-params-probe');
    const res = await fetch(`http://127.0.0.1:${h.config.port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'remember', arguments: [1, 2] } }),
    });
    const reply = replyOf(await res.text());
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error.message).toMatch(/^Invalid params: /);
    expect(reply.error.message).not.toContain('\n');
    expect(JSON.stringify(reply)).not.toContain('invalid_type');
  }, 30_000);

  it('initialize without protocolVersion answers -32602 (the SDK\'s own handler, mapped too)', async () => {
    h = await startWorkspace();
    const token = await h.authorize('init-params-probe');
    const res = await fetch(`http://127.0.0.1:${h.config.port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    const reply = replyOf(await res.text());
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error.message).not.toContain('\n');
  }, 30_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('SSE session mode: a DELETEd session answers 404 (F6)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
    restoreEnv();
  });

  it('POST on a session the client has DELETEd answers 404, and a second DELETE does too', async () => {
    h = await startWorkspace({ sse: true });
    const token = await h.authorize('delete-probe');
    const base = `http://127.0.0.1:${h.config.port}/mcp`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
    const sid = init.headers.get('mcp-session-id')!;
    expect((await fetch(base, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid } })).status).toBe(200);
    const after = await fetch(base, { method: 'POST', headers: { ...headers, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    expect(after.status).toBe(404);
    expect((await fetch(base, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid } })).status).toBe(404);
  }, 30_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('MVP_MCP_MAX_SESSIONS ceiling (F5)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
    delete process.env.MVP_MCP_MAX_SESSIONS;
    restoreEnv();
  });

  it('accepts 1,000 and refuses 1,001 with a message that names the ceiling', async () => {
    // The harness sets every variable loadMvpConfig requires; this test only varies the session ceiling.
    h = await startWorkspace();
    process.env.MVP_MCP_MAX_SESSIONS = '1000';
    expect(() => loadMvpConfig()).not.toThrow();
    process.env.MVP_MCP_MAX_SESSIONS = '1001';
    expect(() => loadMvpConfig()).toThrow(/largest accepted value is 1000/);
  }, 30_000);
});
