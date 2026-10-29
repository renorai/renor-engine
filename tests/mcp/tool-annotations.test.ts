import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';

// Clients ask before running any tool not marked read-only, so each hosted tool is classified here as reading or writing.
const READING_TOOLS = [
  'export_memory', 'get_context', 'lookup_entity', 'memory_map', 'memory_status',
  'read_memory', 'retrieve_memory', 'search_history', 'search_memory', 'search_text',
  'list_requests',
];
const WRITING_TOOLS = [
  'apply_import', 'index_memory', 'remember', 'remember_note', 'restore_memory', 'retire_memory', 'save_memory', 'undo_import',
  // preview_import stages a batch that holds up to 8 previews at once: each call adds one, so it is not read-only and not
  // idempotent. It writes no memory, and nothing it stages is destructive.
  'preview_import',
  // whats_new moves this connection's mark, so a second call answers less: not read-only and not idempotent.
  'whats_new',
  // sharing_level reads the level and, on the user's word, lowers it (a file in the sharing folder): not read-only, and setting the same level again changes nothing.
  'sharing_level',
  // Requests are records; asking, answering and closing still change state.
  'ask_agent', 'answer_request', 'close_request',
];
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

async function listAlphaTools(): Promise<Tool[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-annotations-'));
  const memoryDir = path.join(root, 'memory');
  const authRoot = path.join(root, 'auth');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });

  const env: Record<string, string> = {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'tool-annotations@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-tool-annotations-secret',
    MVP_EMBEDDING_PROVIDER: 'none',
  };
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const app = createMvpApp(loadMvpConfig());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tool-annotations', version: '0' });
    await app.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
      await app.close();
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('MCP tool annotations (alpha / tenant surface)', () => {
  let tools: Tool[] = [];

  beforeAll(async () => {
    tools = await listAlphaTools();
  });

  it('classifies every registered tool as reading or writing, and nothing else', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...READING_TOOLS, ...WRITING_TOOLS].sort());
  });

  it('declares every hint on every tool, over a closed domain', () => {
    for (const tool of tools) {
      for (const hint of HINTS) {
        expect(typeof tool.annotations?.[hint], `${tool.name}: ${hint}`).toBe('boolean');
      }
      expect(tool.annotations?.openWorldHint, `${tool.name}: openWorldHint`).toBe(false);
    }
  });

  it('marks exactly the reading tools read-only, and reading tools neither destroy nor vary', () => {
    for (const tool of tools) {
      const reading = READING_TOOLS.includes(tool.name);
      expect(tool.annotations?.readOnlyHint, `${tool.name}: readOnlyHint`).toBe(reading);
      if (reading) {
        expect(tool.annotations?.destructiveHint, `${tool.name}: destructiveHint`).toBe(false);
        expect(tool.annotations?.idempotentHint, `${tool.name}: idempotentHint`).toBe(true);
      }
    }
  });
});
