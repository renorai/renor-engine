import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { startMvpServiceOnFreePort } from './mvpPort';
import type { EmbeddingProvider } from '../../src/embeddings/types';

/**
 * A running MVP service on loopback with its own temp memory directory, and an authenticated MCP client over the real
 * Streamable HTTP endpoint, for tests and measurements that drive the tools the way an agent does. The embedding provider
 * is injected (a stub, or the real Vertex stack pointed at `vertexStub`), so nothing here reaches a model or a network.
 *
 * The service reads its settings from the environment; they are set here for the one workspace a process runs at a time
 * and restored by `restoreWorkspaceEnv`.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'MVP_DB_PATH', 'MVP_MCP_JSON', 'RENOR_SEARCH_EVIDENCE', 'RENOR_CONTEXT_RELEVANCE', 'RENOR_CONTEXT_RELEVANCE_MIN',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

export function restoreWorkspaceEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

export { freePort } from './mvpPort';

export async function authorize(app: Parameters<typeof request>[0], clientName = 'workspace-helper'): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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
  return tokens.body.access_token;
}

export interface Workspace {
  service: MvpApp & { httpServer: import('http').Server };
  config: MvpConfig;
  memoryDir: string;
  /** The first JSON answer is preserved, including isError replies; plain-text rejections return { ok: false, error }. Transport failures throw. */
  call(name: string, args?: Record<string, unknown>): Promise<{ body: any; isError: boolean }>;
  /** Every text block of the tool's answer, unparsed (export_memory sends two; a refusal is plain text), and whether it was an error. */
  callRaw(name: string, args?: Record<string, unknown>): Promise<{ texts: string[]; isError: boolean }>;
  /** `call`, and how long it took in ms. */
  timed(name: string, args?: Record<string, unknown>): Promise<{ body: any; isError: boolean; ms: number }>;
  /** A call from another connection, registered under `agent` as its client name: what a save and a read record as its author. */
  connectAs(agent: string): Promise<Workspace['call']>;
  /** The server instructions the shared client received on connect. */
  instructions(): string;
  close(): Promise<void>;
}

async function invokeMcp(client: Client, name: string, args: Record<string, unknown>) {
  let res;
  try {
    res = await client.callTool({ name, arguments: args }, undefined, { timeout: 30 * 60_000 });
  } catch (error) {
    if (!(error instanceof McpError) || error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout) throw error;
    return { body: { ok: false, error: error.message }, isError: true };
  }
  const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  // Preserve existing JSON payloads, including structured errors and multi-block replies.
  try { return { body: JSON.parse(text), isError: res.isError === true }; }
  catch { return { body: { ok: false, error: text }, isError: true }; }
}

/**
 * An authenticated workspace in SSE session mode, the hosted one: each client has its own session, so calls from
 * different clients run at the same time, as the captain's agents' did (the stateless JSON mode shares one server
 * and takes one call at a time). `call` uses one persistent client; `timed` connects a new client for each call.
 * `makeProvider` gets the config, so a provider can be built from the settings the service uses.
 */
export async function startWorkspace(
  makeProvider: (config: MvpConfig) => EmbeddingProvider | null,
): Promise<Workspace> {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-ws-'));
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-ws-auth-'));
  const { started: service, config, port } = await startMvpServiceOnFreePort((port) => {
    process.env.MVP_MEMORY_DIR = memoryDir;
    process.env.MVP_AUTH_STATE_PATH = path.join(authDir, 'clients.json');
    process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
    process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
    process.env.MVP_PORT = String(port);
    process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
    for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_DB_PATH']) delete process.env[key];
    process.env.RENOR_SEARCH_EVIDENCE = '0';
    process.env.MVP_MCP_JSON = 'false';
    return loadMvpConfig();
  }, makeProvider);
  const token = await authorize(service.app);
  const clients: Client[] = [];
  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'workspace-helper', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(MVP_MCP_PATH, `http://127.0.0.1:${port}`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    ));
    clients.push(client);
    return client;
  };
  const shared = await connect();
  const call: Workspace['call'] = (name, args = {}) => invokeMcp(shared, name, args);
  return {
    service,
    config,
    memoryDir,
    call,
    instructions: () => shared.getInstructions() ?? '',
    async callRaw(name, args = {}) {
      const res = await shared.callTool({ name, arguments: args }, undefined, { timeout: 30 * 60_000 });
      return { texts: (res.content as Array<{ type: string; text: string }>).map(c => c.text), isError: res.isError === true };
    },
    async timed(name, args = {}) {
      const client = await connect();
      const started = performance.now();
      const result = await invokeMcp(client, name, args);
      return { ...result, ms: Math.round(performance.now() - started) };
    },
    async connectAs(agent) {
      const agentToken = await authorize(service.app, agent);
      const client = new Client({ name: agent, version: '0.1.0' });
      await client.connect(new StreamableHTTPClientTransport(
        new URL(MVP_MCP_PATH, `http://127.0.0.1:${port}`),
        { requestInit: { headers: { Authorization: `Bearer ${agentToken}` } } },
      ));
      clients.push(client);
      return (name, args = {}) => invokeMcp(client, name, args);
    },
    async close() {
      await Promise.all(clients.map(c => c.close().catch(() => undefined)));
      service.httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => service.httpServer.close(() => resolve()));
      await service.close();
      fs.rmSync(memoryDir, { recursive: true, force: true });
      fs.rmSync(authDir, { recursive: true, force: true });
    },
  };
}

/** The product's own embedding stack (`createEmbeddingProvider`: Vertex, then the query cache) pointed at a stub. */
export function vertexConfigFor(config: MvpConfig, keyFile: string): MvpConfig {
  return {
    ...config,
    embeddingProvider: 'vertex',
    embeddingModel: 'gemini-embedding-001',
    embeddingDims: 768,
    vertexKeyFile: keyFile,
    vertexProject: 'stub-project',
    vertexLocation: 'europe-west4',
  };
}

/**
 * A second connection to the same workspace, under its own client name: the connection's name is the agent that writes through
 * it (its daily entries and corrections carry that name). Two named connections are two agents sharing one memory.
 */
export async function connectAs(ws: Workspace, clientName: string): Promise<{ call: Workspace['call']; close(): Promise<void> }> {
  const token = await authorize(ws.service.app, clientName);
  const client = new Client({ name: clientName, version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${process.env.MVP_PORT}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  const call: Workspace['call'] = async (name, args = {}) => {
    return invokeMcp(client, name, args);
  };
  return { call, close: () => client.close() };
}
