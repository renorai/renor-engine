import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { authorize, freePort, restoreWorkspaceEnv } from '../helpers/mvpWorkspace';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

// A query or a subject is short text an agent names something with. Two inputs got past the schema: retrieve_memory's
// subject had no length bound, so a megabyte came back in the reply, and search_text let a NUL byte through to SQLite,
// whose own error text was returned. Both are refused by the schema, with a message that says what to change.

const HOOK_TIMEOUT_MS = 30_000;

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('retrieve_memory and search_text refuse input they cannot use', () => {
  let started: MvpApp & { httpServer: import('http').Server };
  let client: Client;
  const dirs: string[] = [];

  beforeAll(async () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-input-caps-'));
    const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
    dirs.push(memoryDir, authRoot);
    const port = await freePort();
    process.env.MVP_MEMORY_DIR = memoryDir;
    process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
    process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MVP_OWNER_EMAIL = 'owner@example.test';
    process.env.MVP_OWNER_PASSWORD = 'synthetic-owner-secret-123';
    process.env.MVP_PORT = String(port);
    process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
    for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER']) delete process.env[key];
    const config = loadMvpConfig();
    started = await startMvpService(config, null);
    const token = await authorize(started.app);
    client = new Client({ name: 'search-input-caps', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(MVP_MCP_PATH, `http://127.0.0.1:${port}`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    ));
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await client?.close();
    started?.httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => (started ? started.httpServer.close(() => resolve()) : resolve()));
    await started?.close?.();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    restoreWorkspaceEnv();
  });

  /** The tool result as an agent reads it: the text, and whether the call was refused. */
  async function answer(name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError === true, text: (res.content as Array<{ text: string }>)[0].text };
  }

  it('a subject over 512 characters is refused with what to pass instead, and is not echoed back', async () => {
    const subject = 'x'.repeat(1_000_000);
    const res = await answer('retrieve_memory', { subject });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('subject is longer than 512 characters');
    expect(res.text.length).toBeLessThan(4096);
  });

  it('a subject of exactly 512 characters is still a subject', async () => {
    const res = await answer('retrieve_memory', { subject: 'x'.repeat(512) });
    expect(res.isError).toBe(false);
  });

  it('a NUL byte in a search query is refused with the code point named, not with the SQLite error', async () => {
    const res = await answer('search_text', { query: 'alpha\u0000beta' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('control characters (U+0000)');
    expect(res.text).not.toContain('fts-query');
  });

  it('a tab in a search query is words, not a control character to refuse', async () => {
    const res = await answer('search_text', { query: 'alpha\tbeta' });
    expect(res.text).not.toContain('control characters');
  });
});
