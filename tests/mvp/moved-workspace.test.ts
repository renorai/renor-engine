import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp, startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { openDb } from '../../src/db/client';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { authorize, freePort, restoreWorkspaceEnv } from '../helpers/mvpWorkspace';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * A workspace folder that is moved or restored from a backup into another directory keeps working, and each note is
 * served once, from where it is now. The index stores each note by its absolute path, so the rows an earlier run wrote
 * name the old folder; this test moves a stopped workspace, starts it at the new path, and reads what the tools answer.
 * Synthetic data only: temp folders, loopback, the deterministic eval-hash embeddings.
 */

const NOTE = 'Notes/mango.md';
const NOTE_TEXT = '# Mango\n\nThe mango juice stand closes at six on Sundays.\n';
const QUERY = 'mango juice stand';

const roots: string[] = [];
const open: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  vi.useRealTimers();
  while (open.length) await open.pop()!.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  restoreWorkspaceEnv();
});

/** The service's settings for `memoryDir` on a free port, with an OAuth file of its own. */
async function configFor(memoryDir: string) {
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-moved-auth-'));
  roots.push(authRoot);
  const port = await freePort();
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = 'owner@example.test';
  process.env.MVP_OWNER_PASSWORD = 'synthetic-owner-secret-123';
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_DB_PATH']) delete process.env[key];
  process.env.RENOR_SEARCH_EVIDENCE = '0';
  process.env.MVP_MCP_JSON = 'false';
  return loadMvpConfig();
}

/** A service on `memoryDir`, which it keeps: the folder a stopped service left, moved or not, is what the next start reads. */
async function startAt(memoryDir: string, provider: EmbeddingProvider = new EvalHashEmbeddingProvider()) {
  const config = await configFor(memoryDir);
  const service: MvpApp & { httpServer: import('http').Server } = await startMvpService(config, provider);
  const token = await authorize(service.app);
  const client = new Client({ name: 'moved-workspace', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  let stopped = false;
  const running = {
    /** The tool's answer as the agent reads it: the exact text, and parsed. */
    async raw(name: string, args: Record<string, unknown> = {}) {
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) throw new Error(`${name} failed: ${(res.content as Array<{ text: string }>)[0].text}`);
      return (res.content as Array<{ text: string }>)[0].text;
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      return JSON.parse(await running.raw(name, args));
    },
    /** Stop the service and keep its memory folder, as a host does when it restarts or moves the engine. */
    async stop() {
      if (stopped) return;
      stopped = true;
      await client.close();
      service.httpServer.closeAllConnections?.();
      await new Promise<void>(resolve => service.httpServer.close(() => resolve()));
      await service.close();
    },
  };
  open.push(running);
  return running;
}

/** The hits of a search whose text names the note. */
function hitsForNote(reply: { hits: Array<{ notePath?: string; text?: string }> }) {
  return reply.hits.filter(hit => (hit.text ?? '').includes('mango juice stand'));
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a workspace folder moved to another directory', () => {
  it('serves its note once, from the new folder, and nothing from the old one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-moved-'));
    roots.push(root);
    const before = path.join(root, 'first', 'memory');
    const after = path.join(root, 'second', 'memory');
    fs.mkdirSync(path.join(before, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(before, NOTE), NOTE_TEXT);

    const first = await startAt(before);
    await first.call('index_memory');
    expect(hitsForNote(await first.call('search_memory', { query: QUERY }))).toHaveLength(1);
    await first.stop();

    fs.mkdirSync(path.dirname(after), { recursive: true });
    fs.renameSync(before, after);

    // No index pass is asked for: the start itself indexes the folder at its new paths, before it answers.
    const second = await startAt(after);

    const reply = await second.call('search_memory', { query: QUERY });
    const hits = hitsForNote(reply);
    expect(hits.map(hit => hit.notePath)).toEqual([NOTE]);
    expect(JSON.stringify(reply)).not.toContain(before);

    const context = await second.call('get_context', { query: QUERY });
    expect(JSON.stringify(context)).not.toContain(before);
    expect(JSON.stringify(context).split(NOTE).length - 1).toBeLessThanOrEqual(1);

    const status = await second.call('memory_status');
    expect(status.notes).toBe(1);

    const map = await second.raw('memory_map', { query: 'mango' });
    expect(map).not.toContain(before);
  });

  it('indexes a moved folder again after a crash between removing its old rows and the start pass', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-moved-crash-'));
    roots.push(root);
    const before = path.join(root, 'first', 'memory');
    const after = path.join(root, 'second', 'memory');
    fs.mkdirSync(path.join(before, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(before, NOTE), NOTE_TEXT);
    const first = await startAt(before);
    await first.call('index_memory');
    await first.stop();
    fs.mkdirSync(path.dirname(after), { recursive: true });
    fs.renameSync(before, after);

    // The start is cut short after the old rows are removed and before the folder is indexed again: the process ends here.
    const crashed = createMvpApp(await configFor(after), new EvalHashEmbeddingProvider());
    await crashed.close();

    const second = await startAt(after);
    expect(hitsForNote(await second.call('search_memory', { query: QUERY })).map(hit => hit.notePath)).toEqual([NOTE]);
    expect((await second.call('memory_status')).notes).toBe(1);
  });

  it('keeps the folder owed a pass while the start pass fails, and clears it on a start that indexes it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-moved-refused-'));
    roots.push(root);
    const before = path.join(root, 'first', 'memory');
    const after = path.join(root, 'second', 'memory');
    fs.mkdirSync(path.join(before, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(before, NOTE), NOTE_TEXT);
    const first = await startAt(before);
    await first.call('index_memory');
    await first.stop();
    fs.mkdirSync(path.dirname(after), { recursive: true });
    fs.renameSync(before, after);

    // The embedding service refuses every call: the start pass cannot index the note, so the service starts without it.
    const refusing: EmbeddingProvider = {
      dimensions: 256,
      embed: async () => { throw new Error('embedding service unavailable'); },
      embedQuery: async () => { throw new Error('embedding service unavailable'); },
    };
    const down = await startAt(after, refusing);
    await down.stop();
    const config = await configFor(after);
    const pending = openDb(config.dbPath);
    expect(pending.prepare("SELECT 1 FROM index_state WHERE key = 'reindex_pending'").get()).toBeDefined();
    pending.close();

    const up = await startAt(after);
    expect(hitsForNote(await up.call('search_memory', { query: QUERY })).map(hit => hit.notePath)).toEqual([NOTE]);
    const cleared = openDb(config.dbPath);
    expect(cleared.prepare("SELECT 1 FROM index_state WHERE key = 'reindex_pending'").get()).toBeUndefined();
    cleared.close();
  });

  it('answers byte-identically when the folder is started where it was left', async () => {
    // Recency is scored against the clock, so the clock is held: the same index then gives the same bytes.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-unmoved-'));
    roots.push(root);
    const memoryDir = path.join(root, 'memory');
    fs.mkdirSync(path.join(memoryDir, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, NOTE), NOTE_TEXT);

    const first = await startAt(memoryDir);
    await first.call('index_memory');
    const answers = {
      search: await first.raw('search_memory', { query: QUERY }),
      context: await first.raw('get_context', { query: QUERY }),
      map: await first.raw('memory_map', {}),
      status: await first.raw('memory_status'),
    };
    await first.stop();

    const second = await startAt(memoryDir);
    expect({
      search: await second.raw('search_memory', { query: QUERY }),
      context: await second.raw('get_context', { query: QUERY }),
      map: await second.raw('memory_map', {}),
      status: await second.raw('memory_status'),
    }).toEqual(answers);
  });
});
