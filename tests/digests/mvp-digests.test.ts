import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp, type MvpApp } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { startDigestStub } from './stubDigestModel';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Write-time digests through the real MCP server (createMvpApp, the registered tools, JSON serialization) over an
 * in-memory transport: the tool surface is what it was with the switch off, the status and the search carry the digests
 * with it on, and a save never waits for the model. The model is a loopback stub; no provider is called.
 */

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_DB_PATH', 'RENOR_DIGESTS',
  'RENOR_DIGEST_BASE_URL', 'RENOR_DIGEST_API_KEY', 'RENOR_DIGEST_MODEL', 'RENOR_DIGEST_CACHE', 'RENOR_DIGEST_RETRIES',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_EVIDENCE_API_KEY', 'RENOR_EVIDENCE_BASE_URL',
];
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const tmpDirs: string[] = [];
const apps: MvpApp[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const app of apps.splice(0)) await app.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function boot(env: Record<string, string>): Promise<{ app: MvpApp; client: Client; call: (name: string, args?: Record<string, unknown>) => Promise<any> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-digests-'));
  tmpDirs.push(root);
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  // The OAuth client registry refuses a state directory that is not owner-only.
  fs.mkdirSync(path.join(root, 'state'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, 'state'), 0o700);
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(root, 'state', 'clients.json'),
    MVP_DB_PATH: path.join(root, 'state', 'index.db'),
    MVP_BASE_URL: 'http://127.0.0.1:1',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    MVP_PORT: '1',
    MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
    RENOR_SEARCH_EVIDENCE: '0',
    ...env,
  });
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  for (const key of ['RENOR_DIGESTS', 'RENOR_DIGEST_BASE_URL', 'RENOR_DIGEST_API_KEY', 'RENOR_DIGEST_MODEL', 'RENOR_DIGEST_CACHE']) {
    if (!(key in env)) delete process.env[key];
  }
  const app = createMvpApp(loadMvpConfig(), new EvalHashEmbeddingProvider());
  apps.push(app);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverSide);
  const client = new Client({ name: 'digest-test', version: '1.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
    return JSON.parse(result.content[0].text);
  };
  return { app, client, call };
}

const searchDescription = async (client: Client) =>
  (await client.listTools()).tools.find(tool => tool.name === 'search_memory')!.description ?? '';

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('write-time digests through the MCP server', () => {
  it('off by default: no digests object in memory_status, no digest sentence in the tool description, no worker', async () => {
    const { app, client, call } = await boot({});
    expect(app.digests).toBeNull();
    const status = await call('memory_status');
    expect(status).not.toHaveProperty('digests');
    expect(await searchDescription(client)).not.toContain('digest');
    const saved = await call('remember_note', { text: 'I bought a red bicycle yesterday.' });
    expect(saved.ok).toBe(true);
  });

  it('on without a model: memory_status says the worker is stopped and why, and saves still work', async () => {
    const { app, client, call } = await boot({ RENOR_DIGESTS: 'on' });
    expect(app.digests).not.toBeNull();
    expect((await call('memory_status')).digests).toMatchObject({ state: 'stopped', maxUsdPerDay: 0.5 });
    expect((await call('memory_status')).digests.reason).toContain('no digest model');
    expect(await searchDescription(client)).toContain('digest');
    expect((await call('remember_note', { text: 'I bought a red bicycle yesterday.' })).ok).toBe(true);
  });

  it('on with only the evidence provider configured: the worker stays stopped, says why, and the evidence provider is never called', async () => {
    // The Privacy Policy names one digests processor, so another provider's key and URL must not be borrowed for notes.
    const evidence = await startDigestStub();
    try {
      const { app, call } = await boot({
        RENOR_DIGESTS: 'on', RENOR_EVIDENCE_BASE_URL: evidence.baseUrl, RENOR_EVIDENCE_API_KEY: 'evidence-key',
      });
      expect(await call('remember_note', { text: 'I bought a red bicycle yesterday.' })).toMatchObject({ ok: true, indexed: true });
      await app.digests!.worker.sweepNow();
      expect(evidence.calls).toHaveLength(0);
      const status = (await call('memory_status')).digests;
      expect(status).toMatchObject({ state: 'stopped' });
      expect(status.reason).toContain('RENOR_DIGEST_BASE_URL');
      expect(status.reason).toContain('RENOR_DIGEST_API_KEY');
      expect(JSON.stringify(status)).not.toContain('evidence-key');
    } finally {
      await evidence.close();
    }
  });

  it('on with a model: a save is indexed and answered without a model call, the digest is written in the background, and search leads with it', async () => {
    const stub = await startDigestStub();
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-digests-cache-'));
      tmpDirs.push(root);
      const { app, call } = await boot({
        RENOR_DIGESTS: 'on', RENOR_DIGEST_BASE_URL: stub.baseUrl, RENOR_DIGEST_API_KEY: 'stub-key', RENOR_DIGEST_MODEL: 'stub-digest',
        RENOR_DIGEST_RETRIES: '0', RENOR_DIGEST_CACHE: path.join(root, 'digest-cache.db'),
      });
      const saved = await call('remember_note', { text: 'I bought a red bicycle yesterday.' });
      expect(saved).toMatchObject({ ok: true, indexed: true });
      // The save returned before any model was asked: the digest is a timer away.
      expect(stub.calls).toHaveLength(0);
      expect((await call('memory_status')).digests.state).toBe('scheduled');
      await app.digests!.worker.sweepNow();
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].body).toMatchObject({ model: 'stub-digest', temperature: 0, reasoning_effort: 'low' });
      const status = (await call('memory_status')).digests;
      expect(status).toMatchObject({ state: 'idle', consecutiveFailures: 0 });
      expect(status.spentTodayUsd).toBeGreaterThan(0);
      const calls = stub.calls.length;
      const found = await call('search_memory', { query: 'red bicycle' });
      expect(stub.calls).toHaveLength(calls);
      expect(found.ok).toBe(true);
      expect(found.hits[0]).toMatchObject({ reason: 'digest' });
    } finally {
      await stub.close();
    }
  });
});
