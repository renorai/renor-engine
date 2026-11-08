import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

// The hint is advisory, so a test can make its read fail. Off, the real function runs.
const hint = vi.hoisted(() => ({ fail: false }));
vi.mock('../../src/memory/factConflicts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/memory/factConflicts')>();
  return {
    ...actual,
    possibleDuplicates: (...args: Parameters<typeof actual.possibleDuplicates>) => {
      if (hint.fail) throw new Error('the duplicate read failed');
      return actual.possibleDuplicates(...args);
    },
  };
});

/**
 * `save_memory` names the duplicate it creates, as a fact-mode `remember` does.
 *
 * The first-week scout (finding F2) put `possibleDuplicates` on `remember`'s
 * fact receipt and left the lower-level `save_memory` out. An agent saving through it made the same second copy (the
 * unscoped correction beside the project's value, "Atlas project" beside "Atlas") and was told nothing.
 *
 * Driven through the real MCP tool of a keyword-only workspace, in memory. Synthetic data only; no embeddings.
 */

const HOOK_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
  'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'RENOR_READ_HONESTY',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A fresh keyword-only workspace. Calls are sequential: one shared stateless MCP server. */
async function startWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-memory-duplicates-'));
  const memoryDir = path.join(root, 'memory');
  const authRoot = path.join(root, 'auth');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    MVP_EMBEDDING_PROVIDER: 'none',
  });
  const app = createMvpApp(loadMvpConfig());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'save-memory-duplicates', version: '0.1.0' });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as any)[0].text as string;
    expect(res.isError, `${name} ${JSON.stringify(args)}: ${text}`).not.toBe(true);
    return JSON.parse(text);
  };
  return {
    client,
    call,
    /** A save as an agent makes it with the lower-level tool; `scope` omitted means the call names no scope. */
    save: (subject: string, predicate: string, object: string, scope?: string) =>
      call('save_memory', { subject, predicate, object, ...(scope === undefined ? {} : { scope }) }),
    async close() {
      await client.close();
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Workspace = Awaited<ReturnType<typeof startWorkspace>>;

/** A value as the receipt lists it, without its time. */
const brief = (value: any) => `${value.subject} = ${value.object} [${value.scope}]`;

// The report's reproduction (first-week scout, section 2, F2), call for call, through save_memory.
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the F2 reproduction through save_memory: the duplicate is named when it is saved', () => {
  let ws: Workspace;
  const receipts: any[] = [];
  beforeAll(async () => {
    ws = await startWorkspace();
    receipts.push(await ws.save('Atlas', 'api_rate_limit', '600/min', 'project:atlas'));
    receipts.push(await ws.save('Atlas', 'api_rate_limit', '1200/min'));
    receipts.push(await ws.save('Atlas project', 'deploy_target', 'Fly.io'));
    receipts.push(await ws.save('Atlas', 'deploy_target', 'AWS ECS Fargate'));
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a save with nothing related to it carries no possibleDuplicates', () => {
    expect(receipts[0]).not.toHaveProperty('possibleDuplicates');
    expect(receipts[2]).not.toHaveProperty('possibleDuplicates'); // Atlas has no deploy_target yet
  });

  it('a correction saved without the project scope names the value it did not supersede, with its scope', () => {
    const receipt = receipts[1];
    expect(receipt).toMatchObject({ ok: true, action: 'store', closed: null });
    expect((receipt.possibleDuplicates ?? []).map(brief)).toEqual(['Atlas = 600/min [project:atlas]']);
    expect(Object.keys(receipt.possibleDuplicates?.[0] ?? {}).sort()).toEqual(['object', 'scope', 'subject', 'validFrom']);
    expect(receipt).not.toHaveProperty('possibleDuplicatesTotal');
  });

  it('a reversal saved under another name for the project names the decision it reverses', () => {
    const receipt = receipts[3];
    expect(receipt).toMatchObject({ action: 'store', closed: null });
    expect((receipt.possibleDuplicates ?? []).map(brief)).toEqual(['Atlas project = Fly.io [global]']);
  });

  it('following the receipt closes the loop: the correction saved in that scope supersedes and names nothing', async () => {
    const receipt = await ws.save('Atlas', 'api_rate_limit', '1200/min', 'project:atlas');
    expect(receipt).toMatchObject({ action: 'supersede', closed: { object: '600/min' } });
    expect(receipt).not.toHaveProperty('possibleDuplicates');
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('scope stays an isolation boundary for the save_memory receipt', () => {
  let ws: Workspace;
  const receipts: Record<string, any> = {};
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.save('user', 'timezone', 'America/Sao_Paulo');
    await ws.save('staging database', 'host', 'staging-db.atlas.internal', 'project:atlas');
    receipts.kestrelHost = await ws.save('staging database', 'host', 'kestrel-staging.supabase.co', 'project:kestrel');
    receipts.lisbon = await ws.save('user', 'timezone', 'Europe/Lisbon', 'project:kestrel');
    receipts.everywhere = await ws.save('user', 'timezone', 'Asia/Tokyo');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a save in one project is not told what another project or global holds', () => {
    expect(receipts.kestrelHost).not.toHaveProperty('possibleDuplicates'); // project:atlas has the same subject and predicate
    expect(receipts.lisbon).not.toHaveProperty('possibleDuplicates'); // global has the same subject and predicate
    expect(JSON.stringify(receipts.kestrelHost)).not.toContain('atlas.internal');
    expect(JSON.stringify(receipts.lisbon)).not.toContain('Sao_Paulo');
  });

  it('a save that names no scope compares across every scope', () => {
    // It supersedes the global value, and still names the other scope's value beside it.
    expect(receipts.everywhere).toMatchObject({ action: 'supersede', closed: { object: 'America/Sao_Paulo' } });
    expect((receipts.everywhere.possibleDuplicates ?? []).map(brief)).toEqual(['user = Europe/Lisbon [project:kestrel]']);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('what the receipt carries', () => {
  let ws: Workspace;
  let crowded: any;
  beforeAll(async () => {
    ws = await startWorkspace();
    for (let i = 1; i <= 10; i++) await ws.save('meeting room', 'booked_by', `team ${i}`, `scope:floor-${i}`);
    crowded = await ws.save('meeting room', 'booked_by', 'nobody');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a long list is cut to the newest eight, and says how many there are', () => {
    expect(crowded.possibleDuplicates?.length).toBe(8);
    expect(crowded.possibleDuplicatesTotal).toBe(10);
    expect(crowded.possibleDuplicates?.[0]?.object).toBe('team 10'); // newest first
  });

  it('a hint that cannot be read leaves the receipt without it: the fact is saved whatever the hint does', async () => {
    await ws.save('Ravi', 'role', 'engineer', 'project:atlas');
    hint.fail = true;
    let receipt: any;
    try {
      receipt = await ws.save('Ravi', 'role', 'staff engineer');
    } finally {
      hint.fail = false;
    }
    expect(receipt).toMatchObject({ ok: true, action: 'store', subject: 'Ravi', predicate: 'role' });
    expect(receipt).not.toHaveProperty('possibleDuplicates');
    // The same save with the hint working would have named the project's value: the fact itself was kept.
    const stored = await ws.call('retrieve_memory', { subject: 'Ravi', predicate: 'role' });
    expect(stored.facts.map((f: any) => `${f.object} [${f.scope}]`).sort()).toEqual(['engineer [project:atlas]', 'staff engineer [global]']);
  });

  it('the tool description tells an agent the receipt may carry the hint', async () => {
    const { tools } = await ws.client.listTools();
    const save = tools.find(tool => tool.name === 'save_memory');
    expect(save?.description).toContain('possibleDuplicates');
  });
});
