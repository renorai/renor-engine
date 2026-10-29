import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import { once } from 'events';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { MVP_MCP_PATH } from '../../src/mvp/server';
import { killTree, spawnTree } from './childTree';
import { startMvpServiceOnFreePort } from './mvpPort';

// Shared by the hive breaker suite and its gateway-backed parity test (tests/memory/gateway-hive-parity.test.ts).
// Nothing here touches the gateway, so both files can use it and the public cut can carry it.
export const OWNER_EMAIL = 'owner@example.test';
export const OWNER_PASSWORD = 'synthetic-owner-secret-123';
export const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'RENOR_SECRET_GUARD', 'RENOR_ASK_AGENT_PER_HOUR', 'MVP_GATEWAY_SECRET', 'RENOR_CONNECTION_NAME', 'MVP_MCP_JSON',
  'RENOR_HANDOFF_NOTE',
];

export const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

/** Puts every environment variable the harness sets back to what the test file started with. */
export function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export interface Harness {
  config: MvpConfig;
  memoryDir: string;
  authorize(clientName: string): Promise<string>;
  connect(headers?: Record<string, string>, clientName?: string): Promise<Client>;
  call(client: Client, name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; raw: string; body: any }>;
  close(): Promise<void>;
}

/**
 * One shared workspace and any number of MCP connections to it, each with its own headers. A
 * connection with `x-renor-agent` stands in for a gateway-proxied client (the header the gateway
 * sets from the key's label); a connection with only a User-Agent stands in for a client that
 * reaches the engine with no gateway-set header.
 */
export async function startWorkspace(opts: { secretGuard?: boolean; selfHosted?: boolean; sse?: boolean; memoryDir?: string } = {}): Promise<Harness> {
  // `memoryDir`: an existing folder to serve (a throwaway copy: close() removes it). Default: a new empty one.
  const memoryDir = opts.memoryDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hive-breaker-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-breaker-auth-'));
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER']) delete process.env[key];
  process.env.RENOR_SECRET_GUARD = opts.secretGuard ? '1' : '0';
  process.env.MVP_GATEWAY_SECRET = opts.selfHosted ? '' : 'synthetic-gateway-secret';
  process.env.MVP_MCP_JSON = opts.sse ? 'false' : 'true';
  // The port is probed, then bound; another process can take it in between (EADDRINUSE), so the start retries on a fresh probe.
  const { started: service, config } = await startMvpServiceOnFreePort((port) => {
    process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MVP_PORT = String(port);
    return loadMvpConfig();
  });

  async function authorize(clientName = 'hive-breaker'): Promise<string> {
    const redirectUri = 'http://127.0.0.1:1/callback';
    const reg = await request(service.app).post('/register')
      .send({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
      .expect(201);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authorizeRes = await request(service.app).get('/authorize').query({
      client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    }).expect(200);
    const ticket = authorizeRes.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
    const login = await request(service.app).post('/mvp-login').type('form').send({
      ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
    }).expect(302);
    const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
    const tokens = await request(service.app).post('/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
    }).expect(200);
    return tokens.body.access_token as string;
  }

  const token = await authorize();
  const harness: Harness = {
    config,
    memoryDir,
    authorize,
    async connect(headers = {}, clientName) {
      const bearer = clientName === undefined ? token : await authorize(clientName);
      const client = new Client({ name: 'hive-breaker', version: '0.1.0' });
      await client.connect(new StreamableHTTPClientTransport(
        new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
        { requestInit: { headers: { Authorization: `Bearer ${bearer}`, ...headers } } },
      ));
      return client;
    },
    async call(client, name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const raw = (res.content as Array<{ text: string }>)[0].text;
      return { isError: Boolean(res.isError), raw, body: res.isError ? null : JSON.parse(raw) };
    },
    async close() {
      service.httpServer.closeAllConnections?.();
      service.httpServer.close();
      await service.close();
      for (const dir of [memoryDir, authRoot]) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/**
 * Registers a client without signing in, then runs the owner's consent step for it. Returns the status of each
 * step: registration is open to anyone (201); consent is where the owner's approval, and so the name, is claimed.
 */
export async function registerThenConsent(baseUrl: URL, clientName: string): Promise<{ register: number; consent: number }> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await fetch(new URL('/register', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] }),
  });
  if (reg.status !== 201) return { register: reg.status, consent: -1 };
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorizeUrl = new URL('/authorize', baseUrl);
  authorizeUrl.search = new URLSearchParams({
    client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).toString();
  const page = await fetch(authorizeUrl);
  const ticket = (await page.text()).match(/name="ticket" value="([^"]+)"/)?.[1] ?? '';
  const login = await fetch(new URL('/mvp-login', baseUrl), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD }).toString(),
  });
  return { register: reg.status, consent: login.status };
}

/** A connection the gateway would have named (x-renor-agent set from the key's label). */
export function named(agent: string): Record<string, string> {
  return { 'x-renor-agent': agent };
}

export const HIVE_NAMES = ['whats_new', 'ask_agent', 'list_requests', 'answer_request', 'close_request'];
export const HIVE_ARGS: Record<string, Record<string, unknown>> = {
  whats_new: {}, ask_agent: { to: 'richard', request: 'Ping' }, list_requests: {},
  answer_request: { id: 'req_missing', answer: 'pong' }, close_request: { id: 'req_missing' },
};

/** Launches the built CLI (`node dist/cli.js mcp`, the documented stdio entry) and speaks JSON-RPC over its pipes. */
export async function realStdioConnection(vault: string, connectionName: string, extraEnv: Record<string, string> = {}) {
  const child = spawnTree(process.execPath, [path.resolve(__dirname, '../../dist/cli.js'), 'mcp'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { PATH: process.env.PATH, VAULT_PATH: vault, EMBEDDING_PROVIDER: 'eval-hash',
      RENOR_TELEMETRY_DISABLED: 'true', RENOR_EVIDENCE_MODE: 'off', RENOR_VAULT_STALENESS: 'off',
      RENOR_CONNECTION_NAME: connectionName, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '', pending = '', nextId = 1;
  const waiters = new Map<number, (reply: any) => void>();
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout!.on('data', chunk => {
    pending += chunk.toString();
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try { const reply = JSON.parse(line); waiters.get(reply.id)?.(reply); } catch { /* not JSON-RPC */ }
    }
  });
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`stdio MCP timeout on ${method}: ${stderr}`)), 30_000);
    waiters.set(id, reply => { clearTimeout(timer); resolve(reply); });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'client-chosen-name', version: 'test' } });
  if (init.error) throw new Error(`stdio initialize failed: ${JSON.stringify(init.error)} ${stderr}`);
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    async listTools(): Promise<string[]> { return (await rpc('tools/list', {})).result.tools.map((t: { name: string }) => t.name); },
    async call(name: string, args: Record<string, unknown> = {}) {
      const reply = await rpc('tools/call', { name, arguments: args });
      if (reply.error) return { isError: true, raw: JSON.stringify(reply.error), body: null };
      const raw = reply.result.content[0].text;
      return { isError: Boolean(reply.result.isError), raw, body: reply.result.isError ? null : JSON.parse(raw) };
    },
    async close() { const closed = once(child, 'close'); killTree(child); await closed; },
  };
}
