import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { HOSTED_MCP_URL, connectionStatusFromEnv } from '../../src/mvp/connectionStatus';
import { authorize, freePort, restoreWorkspaceEnv } from '../helpers/mvpWorkspace';

/**
 * Agents could not tell that they were connected to the wrong server, or that a connection had silently dropped.
 * A hosted workspace now says where it is on the first tool reply of an MCP session, and on every error a tool
 * returns with how to reconnect; a later successful reply of the same session is exactly what it always was.
 * The status is an extra trailing text block, so the block every tool always returned is untouched.
 */

const ENV_KEYS = ['RENOR_SHARING_DEFAULT', 'MVP_INSTANCE_ID', 'RENOR_CONNECTION_STATUS', 'RENOR_TELEMETRY_DISABLED', 'RENOR_SEARCH_EVIDENCE'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

type Block = { type: string; text: string };
interface Reply { blocks: Block[]; isError: boolean }

const workspaces: Array<{ service: MvpApp & { httpServer: import('http').Server }; clients: Client[]; dirs: string[]; connect(): Promise<Client> }> = [];

async function start(opts: { instance?: string; killSwitch?: boolean; sessions?: boolean }) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-cs-'));
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-cs-auth-'));
  const port = await freePort();
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authDir, 'clients.json'),
    MVP_BASE_URL: `http://127.0.0.1:${port}`,
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    MVP_PORT: String(port),
    MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
    MVP_MCP_JSON: opts.sessions === false ? 'true' : 'false',
    RENOR_SEARCH_EVIDENCE: '0',
    RENOR_TELEMETRY_DISABLED: 'true',
    // This file compares two workspaces byte for byte; at the shipped sharing default each would also record a learning log with keys of its own.
    RENOR_SHARING_DEFAULT: 'off',
  });
  for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_DB_PATH', 'RENOR_CONNECTION_STATUS', 'MVP_INSTANCE_ID']) delete process.env[key];
  if (opts.instance !== undefined) process.env.MVP_INSTANCE_ID = opts.instance;
  if (opts.killSwitch) process.env.RENOR_CONNECTION_STATUS = '0';
  const service = await startMvpService(loadMvpConfig(), null);
  const token = await authorize(service.app);
  const clients: Client[] = [];
  const ws = {
    service,
    clients,
    dirs: [memoryDir, authDir],
    async connect(): Promise<Client> {
      const client = new Client({ name: 'connection-status-test', version: '0.1.0' });
      await client.connect(new StreamableHTTPClientTransport(
        new URL(MVP_MCP_PATH, `http://127.0.0.1:${port}`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
      ));
      clients.push(client);
      return client;
    },
  };
  workspaces.push(ws);
  return ws;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const res = await client.callTool({ name, arguments: args });
  return { blocks: res.content as Block[], isError: res.isError === true };
}

/** The status block, parsed, when a reply carries one. */
function statusOf(reply: Reply): { renor_connection: { hosted: boolean; workspace: string; url: string }; message: string } | null {
  const found = reply.blocks.find((b) => b.type === 'text' && b.text.startsWith('{"renor_connection"'));
  return found ? JSON.parse(found.text) : null;
}

afterEach(async () => {
  for (const ws of workspaces.splice(0)) {
    await Promise.all(ws.clients.map((c) => c.close().catch(() => undefined)));
    ws.service.httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => ws.service.httpServer.close(() => resolve()));
    await ws.service.close();
    for (const d of ws.dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  restoreWorkspaceEnv();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('connection status of a hosted workspace', () => {
  it('is the tenant slug and the one public MCP URL, and only for a hosted workspace', () => {
    expect(connectionStatusFromEnv({ MVP_INSTANCE_ID: 'Ada-1' })).toEqual({ workspace: 'ada-1', url: HOSTED_MCP_URL });
    expect(HOSTED_MCP_URL).toBe('https://mcp.renor.cloud/mcp');
    expect(connectionStatusFromEnv({})).toBeNull();
    expect(connectionStatusFromEnv({ MVP_INSTANCE_ID: '' })).toBeNull();
    expect(connectionStatusFromEnv({ MVP_INSTANCE_ID: 'has space' })).toBeNull();
    expect(connectionStatusFromEnv({ MVP_INSTANCE_ID: 'ada', RENOR_CONNECTION_STATUS: '0' })).toBeNull();
  });

  it('puts it on the first reply of a session, not on the second, and again on a new session', async () => {
    const ws = await start({ instance: 'status-ws' });
    const one = await ws.connect();

    const first = await call(one, 'memory_status');
    const status = statusOf(first);
    expect(status).not.toBeNull();
    expect(status!.renor_connection).toEqual({ hosted: true, workspace: 'status-ws', url: 'https://mcp.renor.cloud/mcp' });
    expect(status!.message).toContain('"status-ws"');
    expect(status!.message).toContain('https://mcp.renor.cloud/mcp');
    expect(status!.message).toContain('tell the user');
    expect(first.blocks).toHaveLength(2); // the block a tool always returned, then the status
    expect(first.blocks[1]).toBe(first.blocks.at(-1));

    for (const [name, args] of [['memory_status', {}], ['get_context', { query: 'anything' }], ['search_text', { query: 'anything' }], ['memory_map', {}]] as const) {
      const later = await call(one, name, args);
      expect(statusOf(later), `${name} in the same session`).toBeNull();
      expect(later.blocks, `${name} in the same session`).toHaveLength(1);
    }

    const two = await ws.connect();
    expect(statusOf(await call(two, 'get_context', { query: 'anything' }))).not.toBeNull();
    expect(statusOf(await call(two, 'get_context', { query: 'anything' }))).toBeNull();
  });

  it('carries it whichever tool is the first of a session', async () => {
    const ws = await start({ instance: 'status-ws' });
    for (const [name, args] of [['get_context', { query: 'x' }], ['search_text', { query: 'x' }], ['memory_map', {}], ['export_memory', {}], ['lookup_entity', { name: 'x' }]] as const) {
      const reply = await call(await ws.connect(), name, args);
      expect(statusOf(reply), name).not.toBeNull();
      expect(reply.blocks.at(-1)!.text.startsWith('{"renor_connection"'), name).toBe(true);
    }
  });

  it('always carries it on an error, with how to reconnect, however late in the session', async () => {
    const ws = await start({ instance: 'status-ws' });
    const client = await ws.connect();
    await call(client, 'memory_status'); // the first reply is spent
    await call(client, 'memory_status');

    for (const [name, args] of [['retrieve_memory', {}], ['read_memory', { id: 'note:does-not-exist.md' }], ['save_memory', { subject: 'only-subject' }]] as const) {
      const reply = await call(client, name, args);
      expect(reply.isError, name).toBe(true);
      expect(reply.blocks[0].text.startsWith('Error:'), name).toBe(true);
      const status = statusOf(reply);
      expect(status, name).not.toBeNull();
      expect(status!.renor_connection.workspace).toBe('status-ws');
      expect(status!.message).toContain('reconnect');
      expect(status!.message).toContain('https://mcp.renor.cloud/mcp');
    }
    // An error on the very first reply of a session says it once.
    const fresh = await call(await ws.connect(), 'retrieve_memory', {});
    expect(fresh.blocks.filter((b) => b.text.startsWith('{"renor_connection"'))).toHaveLength(1);
    expect(statusOf(fresh)!.message).toContain('reconnect');
  });

  it('carries it on the errors the SDK answers itself: a refused input schema and an unknown tool', async () => {
    const ws = await start({ instance: 'status-ws' });
    const client = await ws.connect();
    await call(client, 'memory_status'); // the first reply is spent
    for (const [name, args] of [['get_context', { max_tokens: 'many' }], ['remember', {}], ['no_such_tool', {}]] as const) {
      const reply = await call(client, name, args);
      expect(reply.isError, name).toBe(true);
      expect(reply.blocks[0].text, name).toMatch(/error/i);
      const status = statusOf(reply);
      expect(status, name).not.toBeNull();
      expect(status!.renor_connection.workspace).toBe('status-ws');
      expect(status!.message).toContain('reconnect');
    }
    // A workspace without the status answers a refused call as it always did.
    const plain = await start({});
    const bare = await call(await plain.connect(), 'get_context', { max_tokens: 'many' });
    expect(bare.isError).toBe(true);
    expect(bare.blocks).toHaveLength(1);
    // Refused before any tool ran, so the first successful reply of the session still announces itself.
    const fresh = await ws.connect();
    expect(statusOf(await call(fresh, 'get_context', { max_tokens: 'many' }))).not.toBeNull();
    expect(statusOf(await call(fresh, 'memory_status'))).not.toBeNull();
    expect(statusOf(await call(fresh, 'memory_status'))).toBeNull();
  });

  it('adds nothing else: every reply is byte-identical to a workspace without it, whichever is the first call', async () => {
    const hosted = await start({ instance: 'status-ws' });
    const control = await start({ killSwitch: true, instance: 'status-ws' });
    const calls: Array<[string, Record<string, unknown>]> = [
      ['memory_status', {}], ['get_context', { query: 'anything' }], ['search_text', { query: 'anything' }], ['memory_map', {}],
      ['export_memory', {}], ['lookup_entity', { name: 'nobody' }], ['retrieve_memory', { subject: 'nobody' }], ['retrieve_memory', {}],
      ['read_memory', { id: 'note:none.md' }], ['search_history', { query: 'anything' }],
    ];
    // One session for the whole run, then each call as the first of a session of its own.
    for (const mode of ['shared', 'fresh'] as const) {
      const a = mode === 'shared' ? await hosted.connect() : null;
      const b = mode === 'shared' ? await control.connect() : null;
      for (const [name, args] of calls) {
        const left = await call(a ?? await hosted.connect(), name, args);
        const right = await call(b ?? await control.connect(), name, args);
        expect(right.blocks.filter((x) => x.text.startsWith('{"renor_connection"')), `${name} control`).toHaveLength(0);
        expect(left.isError, `${name} ${mode}`).toBe(right.isError);
        // memory_map stamps the moment it was asked; nothing else differs.
        const same = (blocks: Block[]) => blocks.map((x) => x.text.replace(/"generatedAt":"[^"]+"/, '"generatedAt":"-"'));
        const withoutStatus = left.blocks.filter((x) => !x.text.startsWith('{"renor_connection"'));
        expect(same(withoutStatus), `${name} ${mode}`).toEqual(same(right.blocks));
      }
    }
  });

  it('says nothing in a workspace that is not hosted, or with the switch off', async () => {
    const plain = await start({});
    const off = await start({ instance: 'status-ws', killSwitch: true });
    for (const ws of [plain, off]) {
      const client = await ws.connect();
      expect(statusOf(await call(client, 'memory_status'))).toBeNull();
      const error = await call(client, 'retrieve_memory', {});
      expect(error.isError).toBe(true);
      expect(error.blocks).toHaveLength(1);
    }
  });

  it('has no session to announce on without sessions, but still says it on an error', async () => {
    const ws = await start({ instance: 'status-ws', sessions: false });
    const client = await ws.connect();
    expect(statusOf(await call(client, 'memory_status'))).toBeNull();
    expect(statusOf(await call(client, 'memory_status'))).toBeNull();
    const error = await call(client, 'retrieve_memory', {});
    expect(error.isError).toBe(true);
    expect(statusOf(error)!.renor_connection.workspace).toBe('status-ws');
  });
});
