import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import * as z from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { countSchemaRejections } from '../../src/mvp/schemaRejections';
import { instrumentMcpServer, resetPosthogMcpForTests, shutdownPosthogMcp } from '../../src/mvp/posthogMcp';
import { flushTelemetry } from '../../src/mvp/telemetry';
import { MAX_STATEMENT_LENGTH } from '../../src/memory/limits';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * A call the tool's own input schema refuses never reaches a handler: the SDK answers it before `tracedTool` runs, so it left
 * no `tool_use` line and no trace at all. One user's agents were rejected this way and nothing in the numbers showed it.
 *
 * Every such call now leaves ONE metadata-only `tool_rejected` line: the tool, the argument that failed first (a name from
 * the tool's own schema) and the kind of failure, from a closed set. Never a value, never memory text.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const tmpDirs: string[] = [];
const services: Array<MvpApp & { httpServer: import('http').Server }> = [];
const CLEARED_ENV = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_EMBEDDING_PROVIDER', 'MVP_EMBEDDING_DIMS', 'EMBEDDING_PROVIDER',
  'MVP_MCP_JSON', 'MVP_INSTANCE_ID', 'RENOR_TELEMETRY_DISABLED', 'RENOR_POSTHOG_KEY', 'RENOR_POSTHOG_HOST', 'RENOR_POSTHOG_CAPTURE_URL',
  'RENOR_SENTRY_DSN', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST',
];
const savedEnv: Record<string, string | undefined> = {};

// A test on the real service starts it inside the test: the database and its migrations, the ledger replay, an OAuth login and an
// MCP session, then its calls. The first such test in a worker also pays that worker's first run of every one of those paths. Idle,
// that is under two seconds; on a gate slot sharing four CPUs with three other files it passed vitest's default 5 s, and the test
// failed on a timeout while nothing in it was wrong. Every step is awaited, so this is only the deadline for a slow machine, as the
// other real-service tests in tests/mvp/ have. The bare-server tests start nothing and keep the default.
const REAL_SERVICE_TIMEOUT_MS = 30_000;

// Remote sinks read the environment by name, so a machine that exports them would deliver these lines for real.
beforeEach(() => {
  for (const name of CLEARED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.RENOR_TELEMETRY_DISABLED = 'true';
  process.env.MVP_INSTANCE_ID = 'rejected-test';
  process.env.RENOR_BLANK_STATEMENT = 'off'; // this file pins the schema refusal of an empty statement (the off switch); the default is tested in remember-blank-statement-mcp.test.ts
  resetPosthogMcpForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
    await s.close();
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  resetPosthogMcpForTests();
}, REAL_SERVICE_TIMEOUT_MS); // closing a service waits for its background work, which a loaded machine slows the same way

/** Every telemetry line the process writes, parsed; the stdout line is the canonical record. */
function captureTelemetry() {
  const raw: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    raw.push(args.map(String).join(' '));
  });
  return {
    raw,
    events: (name: string): Array<Record<string, unknown>> =>
      raw.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.event === name),
    since: (mark: number) => raw.slice(mark),
  };
}

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

async function makeConfig(memoryDir: string, port: number): Promise<MvpConfig> {
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  tmpDirs.push(authRoot);
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  return loadMvpConfig();
}

/** Deterministic stub in place of a real embedder: no model, no download, no API. */
function stubProvider(dims: number): EmbeddingProvider {
  return {
    dimensions: dims,
    async embed(texts: string[]) {
      return texts.map(() => new Array(dims).fill(0.1));
    },
  };
}

async function registerAndToken(app: Express): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'rejected-test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorizeRes = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorizeRes.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({
    ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
  }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  return tokens.body.access_token as string;
}

async function realService(): Promise<Client> {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-rejected-'));
  tmpDirs.push(memoryDir);
  const config = await makeConfig(memoryDir, await freePort());
  const started = await startMvpService(config, stubProvider(8));
  services.push(started);
  const token = await registerAndToken(started.app);
  const client = new Client({ name: 'rejected-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  return client;
}

interface Reply { isError: boolean; text: string }
async function callTool(client: Client, name: string, args?: Record<string, unknown>): Promise<Reply> {
  const res = await client.callTool((args === undefined ? { name } : { name, arguments: args }) as never);
  return { isError: Boolean(res.isError), text: (res.content as Array<{ text: string }>)[0].text };
}

// The hosted engines run with MVP_MCP_JSON=false: Streamable HTTP with SSE replies, and a server built for each session.
// The default builds one shared server. Both are built by the same function, and both are exercised here.
const MODES: Array<[string, string]> = [
  ['JSON replies, one shared server (the default)', 'true'],
  ['SSE replies, a server per session (how it is hosted)', 'false'],
];

describe.skipIf(HTTP_SERVER_UNSUPPORTED).each(MODES)('tool_rejected: the real service, %s', (_mode, mcpJson) => {
  beforeEach(() => {
    process.env.MVP_MCP_JSON = mcpJson;
  });

  it('records one metadata-only line for each call the schema refuses, and the client still gets the SDK\'s own answer', async () => {
    const telemetry = captureTelemetry();
    const client = await realService();
    // The mode under test is the mode that is running: only the session-per-client mode hands the client a session id.
    expect(Boolean((client.transport as { sessionId?: string } | undefined)?.sessionId)).toBe(mcpJson === 'false');

    const cases: Array<{ label: string; tool: string; args?: Record<string, unknown>; arg?: string; kind: string }> = [
      { label: 'a required argument is absent', tool: 'remember', args: {}, arg: 'statement', kind: 'missing' },
      { label: 'a string under its minimum', tool: 'remember', args: { statement: '' }, arg: 'statement', kind: 'too_small' },
      { label: 'a statement over the bound', tool: 'remember', args: { statement: 'x'.repeat(MAX_STATEMENT_LENGTH + 1) }, arg: 'statement', kind: 'too_big' },
      { label: 'a number sent as a string', tool: 'memory_map', args: { limit: 'CANARY-limit-value' }, arg: 'limit', kind: 'wrong_type' },
      { label: 'two arguments wrong in one call', tool: 'remember', args: { statement: 5, scope: 5 }, arg: 'statement', kind: 'wrong_type' },
      { label: 'an id that is not a UUID', tool: 'apply_import', args: { batchId: 'CANARY-not-a-uuid' }, arg: 'batchId', kind: 'invalid_format' },
      { label: 'a nested entry missing a field names the argument, not the entry or its index', tool: 'preview_import', args: { label: 'notes', files: [{ relativePath: 'a.md' }] }, arg: 'files', kind: 'missing' },
      {
        label: 'a nested file over the bound, whose text is memory text',
        tool: 'preview_import',
        args: { label: 'notes', files: [{ relativePath: 'a.md', markdown: 'CANARY-memory-text '.repeat(4000) }] },
        arg: 'files',
        kind: 'too_big',
      },
    ];

    // SDK 1.32 accepts a call that omits `arguments` when every argument is optional (1.31 refused it as `missing`): it reaches the handler.
    const omitted = telemetry.events('tool_rejected').length;
    const noArguments = await callTool(client, 'get_context');
    expect(noArguments.isError, 'no arguments at all, for a tool whose arguments are all optional').toBe(false);
    expect(telemetry.events('tool_rejected'), 'no arguments at all, for a tool whose arguments are all optional').toHaveLength(omitted);

    for (const c of cases) {
      const before = telemetry.events('tool_rejected').length;
      const reply = await callTool(client, c.tool, c.args);

      // What the agent reads is what it always read.
      expect(reply.isError, c.label).toBe(true);
      expect(reply.text, c.label).toContain(`Input validation error: Invalid arguments for tool ${c.tool}`);

      const fresh = telemetry.events('tool_rejected').slice(before);
      expect(fresh, c.label).toHaveLength(1);
      const event = fresh[0];
      expect(event, c.label).toMatchObject({ event: 'tool_rejected', tool: c.tool, kind: c.kind, instance: 'rejected-test' });
      expect(event.arg, c.label).toBe(c.arg);
      // Exactly these fields, so a value cannot ride along under another name.
      expect(Object.keys(event).sort(), c.label).toEqual(['arg', 'event', 'instance', 'kind', 'tool', 'ts'].filter((k) => k !== 'arg' || c.arg !== undefined));
    }

    // Nothing the caller sent, and nothing from the memory text, reached any line the process wrote.
    const everything = telemetry.raw.join('\n');
    for (const secret of ['CANARY-limit-value', 'CANARY-not-a-uuid', 'CANARY-memory-text', 'xxxxxxxxxx', 'a.md']) {
      expect(everything, secret).not.toContain(secret);
    }

    // A call refused by the schema never ran, so it is not a tool_use: the only one is the call without arguments (accepted since SDK 1.32).
    expect(telemetry.events('tool_use').map((e) => e.tool)).toEqual(['get_context']);
    await client.close();
  }, REAL_SERVICE_TIMEOUT_MS);

  it('keeps the three outcomes apart: accepted is a tool_use, a handler refusal is a tool_use that failed, only a schema refusal is a tool_rejected', async () => {
    const telemetry = captureTelemetry();
    const client = await realService();

    const accepted = await callTool(client, 'memory_status', {});
    expect(accepted.isError).toBe(false);

    // Passes the schema (every field is a string) and is refused inside the handler.
    const refused = await callTool(client, 'remember', { statement: 'one fact', subject: 'atlas' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('remember requires subject, predicate, and object together');

    expect(telemetry.events('tool_rejected')).toHaveLength(0);
    expect(telemetry.events('tool_use').map((e) => [e.tool, e.ok])).toEqual([['memory_status', true], ['remember', false]]);

    await callTool(client, 'remember', {});
    expect(telemetry.events('tool_rejected')).toHaveLength(1);
    expect(telemetry.events('tool_use')).toHaveLength(2);
    await client.close();
  }, REAL_SERVICE_TIMEOUT_MS);

  it('does not count a call to a tool that does not exist, and never writes the name it was called by', async () => {
    const telemetry = captureTelemetry();
    const client = await realService();

    const reply = await callTool(client, 'CANARY_no_such_tool', { statement: 'x' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('not found');

    expect(telemetry.events('tool_rejected')).toHaveLength(0);
    expect(telemetry.raw.join('\n')).not.toContain('CANARY_no_such_tool');

    // Positive control: on this same service a call the schema does refuse IS counted, so the zero above is not a broken capture.
    await callTool(client, 'remember', {});
    expect(telemetry.events('tool_rejected')).toHaveLength(1);
    await client.close();
  }, REAL_SERVICE_TIMEOUT_MS);

  it('an argument name the caller invents is never written: it is not in the schema, so it is not what failed', async () => {
    const telemetry = captureTelemetry();
    const client = await realService();

    await callTool(client, 'remember', { 'CANARY-invented-name': 'v' });
    const [event] = telemetry.events('tool_rejected');
    expect(event.arg).toBe('statement');
    expect(telemetry.raw.join('\n')).not.toContain('CANARY-invented-name');
    await client.close();
  }, REAL_SERVICE_TIMEOUT_MS);
});

// A call on a session the engine lost (a restart, an idle sleep, the TTL sweep, the cap) is answered on a server built for that one
// request, which is how a hosted tenant's agents are served most of the time. It is built by the same function, so it is counted.
it.skipIf(HTTP_SERVER_UNSUPPORTED)('counts a call the schema refuses on a session the engine lost', async () => {
  process.env.MVP_MCP_JSON = 'false';
  const telemetry = captureTelemetry();
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-rejected-'));
  tmpDirs.push(memoryDir);
  const config = await makeConfig(memoryDir, await freePort());
  const started = await startMvpService(config, stubProvider(8));
  services.push(started);
  const token = await registerAndToken(started.app);

  const res = await fetch(`http://127.0.0.1:${config.port}${MVP_MCP_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'a-session-this-engine-lost',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'remember', arguments: {} } }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('mcp-session-id')).toBeNull(); // nothing was registered for it: it really was served on its own
  expect(await res.text()).toContain('Input validation error: Invalid arguments for tool remember');

  expect(telemetry.events('tool_rejected')).toHaveLength(1);
  expect(telemetry.events('tool_rejected')[0]).toMatchObject({ tool: 'remember', arg: 'statement', kind: 'missing' });
  expect(telemetry.events('tool_use')).toHaveLength(0);
}, REAL_SERVICE_TIMEOUT_MS);

describe('tool_rejected: the hook on a bare server', () => {
  const SHAPE = {
    statement: z.string().min(1).max(10),
    limit: z.number().int().min(1).max(5).optional(),
    mode: z.enum(['a', 'b']).optional(),
    label: z.string().regex(/^[a-z]+$/).optional(),
    pair: z.union([z.string(), z.number()]).optional(),
  };

  function bareServer(hook: boolean): McpServer {
    const server = new McpServer({ name: 'bare', version: '0' });
    if (hook) countSchemaRejections(server);
    server.registerTool('probe', { description: 'probe', inputSchema: SHAPE }, async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
    return server;
  }

  async function connectBare(server: McpServer): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'bare-client', version: '0' });
    await client.connect(clientSide);
    return client;
  }

  it('names each kind of failure from a closed set', async () => {
    const telemetry = captureTelemetry();
    const client = await connectBare(bareServer(true));

    const table: Array<[Record<string, unknown>, string, string]> = [
      [{}, 'statement', 'missing'],
      [{ statement: null }, 'statement', 'wrong_type'],
      [{ statement: 7 }, 'statement', 'wrong_type'],
      [{ statement: '' }, 'statement', 'too_small'],
      [{ statement: 'x'.repeat(11) }, 'statement', 'too_big'],
      [{ statement: 'ok', limit: 0 }, 'limit', 'too_small'],
      [{ statement: 'ok', limit: 9 }, 'limit', 'too_big'],
      [{ statement: 'ok', limit: 1.5 }, 'limit', 'wrong_type'],
      [{ statement: 'ok', mode: 'CANARY' }, 'mode', 'invalid_value'],
      [{ statement: 'ok', label: 'CANARY-1' }, 'label', 'invalid_format'],
      [{ statement: 'ok', pair: true }, 'pair', 'other'],
    ];
    for (const [args, arg, kind] of table) {
      const before = telemetry.events('tool_rejected').length;
      const res = await client.callTool({ name: 'probe', arguments: args });
      expect(res.isError, JSON.stringify(Object.keys(args))).toBe(true);
      const fresh = telemetry.events('tool_rejected').slice(before);
      expect(fresh, JSON.stringify(Object.keys(args))).toHaveLength(1);
      expect(fresh[0], JSON.stringify(Object.keys(args))).toMatchObject({ tool: 'probe', arg, kind });
    }
    expect(telemetry.raw.join('\n')).not.toContain('CANARY');

    // An accepted call is not a rejection.
    const before = telemetry.events('tool_rejected').length;
    const ok = await client.callTool({ name: 'probe', arguments: { statement: 'fine' } });
    expect(ok.isError).toBeFalsy();
    expect(telemetry.events('tool_rejected')).toHaveLength(before);
    await client.close();
  });

  it('never names a key the caller invented, even when the schema itself reads that key', async () => {
    const telemetry = captureTelemetry();
    const server = new McpServer({ name: 'bare', version: '0' });
    countSchemaRejections(server);
    const handler = async () => ({ content: [{ type: 'text' as const, text: 'ran' }] });
    // A catchall schema checks the keys the caller chose, so the issue's path then starts with the caller's own text.
    server.registerTool('open', { description: 'open', inputSchema: z.object({ statement: z.string() }).catchall(z.number()) }, handler);
    server.registerTool('closed', { description: 'closed', inputSchema: z.object({ statement: z.string() }).strict() }, handler);
    const client = await connectBare(server);

    await client.callTool({ name: 'open', arguments: { statement: 'ok', 'CANARY-key-name': 'not a number' } });
    await client.callTool({ name: 'closed', arguments: { statement: 'ok', 'CANARY-extra-key': 1 } });

    const events = telemetry.events('tool_rejected');
    expect(events.map((e) => [e.tool, e.kind])).toEqual([['open', 'wrong_type'], ['closed', 'other']]);
    for (const event of events) expect(event).not.toHaveProperty('arg');
    expect(telemetry.raw.join('\n')).not.toContain('CANARY');
    await client.close();
  });

  it('still counts a call whose failing argument is declared under a name that is not a plain identifier, and leaves the name out', async () => {
    const telemetry = captureTelemetry();
    const server = new McpServer({ name: 'bare', version: '0' });
    countSchemaRejections(server);
    server.registerTool('odd', { description: 'odd', inputSchema: { 'include-history': z.boolean() } }, async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
    const client = await connectBare(server);

    const res = await client.callTool({ name: 'odd', arguments: {} });
    expect(res.isError).toBe(true);
    // The egress gate would drop a line that named it, so the producer leaves it out: the call is counted either way.
    expect(telemetry.events('tool_rejected')).toHaveLength(1);
    expect(telemetry.events('tool_rejected')[0]).toMatchObject({ tool: 'odd', kind: 'missing' });
    expect(telemetry.events('tool_rejected')[0]).not.toHaveProperty('arg');
    await client.close();
  });

  it('gives the client exactly the answer the SDK gives without the hook', async () => {
    captureTelemetry();
    const plain = await connectBare(bareServer(false));
    const hooked = await connectBare(bareServer(true));

    for (const args of [{}, { statement: 5 }, { statement: 'x'.repeat(11) }, { statement: 'ok', mode: 'z' }, { statement: 'fine' }]) {
      const a = await plain.callTool({ name: 'probe', arguments: args });
      const b = await hooked.callTool({ name: 'probe', arguments: args });
      expect(b).toEqual(a);
    }
    await plain.close();
    await hooked.close();
  });

  it('records the call when the server is also instrumented for PostHog, which wraps the registry in a Proxy', async () => {
    // Every other test here switches remote delivery off, which also makes the instrumentation a no-op. This one needs it ON, with
    // nothing leaving the process: the key is a placeholder and every fetch is a stub.
    delete process.env.RENOR_TELEMETRY_DISABLED;
    process.env.RENOR_POSTHOG_KEY = 'phc_test';
    process.env.RENOR_POSTHOG_HOST = 'http://127.0.0.1:9';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const telemetry = captureTelemetry();
    resetPosthogMcpForTests();

    const server = new McpServer({ name: 'bare', version: '0' });
    const registry = (server as unknown as { _registeredTools: unknown })._registeredTools;
    instrumentMcpServer(server);
    // The instrumentation really took effect: it replaced the tool registry with a Proxy around it, which `tool` now comes from.
    expect((server as unknown as { _registeredTools: unknown })._registeredTools).not.toBe(registry);
    countSchemaRejections(server);
    server.registerTool('probe', { description: 'probe', inputSchema: SHAPE }, async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));

    const client = await connectBare(server);
    const res = await client.callTool({ name: 'probe', arguments: {} });
    expect(res.isError).toBe(true);
    expect(telemetry.events('tool_rejected')).toHaveLength(1);
    expect(telemetry.events('tool_rejected')[0]).toMatchObject({ tool: 'probe', arg: 'statement', kind: 'missing' });
    await client.close();
    await flushTelemetry();
    await shutdownPosthogMcp();
  });

  it('never changes what the client sees, even when describing the failure goes wrong', async () => {
    const telemetry = captureTelemetry();
    let parses = 0;
    // The SDK's own parse refuses the call; the hook's second look at it throws.
    const fragile = { statement: z.string().refine(() => { parses++; if (parses > 1) throw new Error('boom'); return false; }) };
    const plainServer = new McpServer({ name: 'bare', version: '0' });
    plainServer.registerTool('probe', { description: 'probe', inputSchema: fragile }, async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
    const plain = await connectBare(plainServer);
    const expected = await plain.callTool({ name: 'probe', arguments: { statement: 'v' } });

    parses = 0;
    const hookedServer = new McpServer({ name: 'bare', version: '0' });
    countSchemaRejections(hookedServer);
    hookedServer.registerTool('probe', { description: 'probe', inputSchema: fragile }, async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
    const hooked = await connectBare(hookedServer);
    const got = await hooked.callTool({ name: 'probe', arguments: { statement: 'v' } });

    expect(got).toEqual(expected);
    // The call was still refused by the schema, so it is still counted: with the kind left as "other" and no argument.
    expect(telemetry.events('tool_rejected')).toHaveLength(1);
    expect(telemetry.events('tool_rejected')[0]).toMatchObject({ tool: 'probe', kind: 'other' });
    expect(telemetry.events('tool_rejected')[0]).not.toHaveProperty('arg');
    await plain.close();
    await hooked.close();
  });

  it('does not count what the protocol layer refuses before the tool is reached: arguments that are not an object', async () => {
    const telemetry = captureTelemetry();
    const client = await connectBare(bareServer(true));

    for (const args of ['{"statement":"hand-built JSON in a string"}', ['statement'], 5, null]) {
      // The SDK answers with a JSON-RPC error and the call never reaches the tool's own check, so there is nothing to count here.
      await expect(client.request({ method: 'tools/call', params: { name: 'probe', arguments: args as never } }, CallToolResultSchema)).rejects.toBeTruthy();
    }
    expect(telemetry.events('tool_rejected')).toHaveLength(0);

    // Positive control: the hook is installed on this server, and a call its schema refuses is counted.
    expect((await client.callTool({ name: 'probe', arguments: {} })).isError).toBe(true);
    expect(telemetry.events('tool_rejected')).toHaveLength(1);
    await client.close();
  });

  it('does not count an error the schema itself throws: that is a defect, not a refusal of the call', async () => {
    const telemetry = captureTelemetry();
    const server = new McpServer({ name: 'bare', version: '0' });
    countSchemaRejections(server);
    const broken = { statement: z.string().refine(() => { throw new Error('a bug in the schema'); }) };
    server.registerTool('broken', { description: 'broken', inputSchema: broken }, async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
    server.registerTool('sound', { description: 'sound', inputSchema: { statement: z.string() } }, async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
    const client = await connectBare(server);

    const res = await client.callTool({ name: 'broken', arguments: { statement: 'v' } });
    expect(res.isError).toBe(true);
    expect(telemetry.events('tool_rejected')).toHaveLength(0);

    // Positive control: the hook is installed on this server, and a call a sound schema refuses is counted.
    await client.callTool({ name: 'sound', arguments: {} });
    expect(telemetry.events('tool_rejected').map((e) => e.tool)).toEqual(['sound']);
    await client.close();
  });

  it('leaves the tool list exactly as it was', async () => {
    captureTelemetry();
    const plain = await connectBare(bareServer(false));
    const hooked = await connectBare(bareServer(true));
    expect(await hooked.listTools()).toEqual(await plain.listTools());
    await plain.close();
    await hooked.close();
  });
});
