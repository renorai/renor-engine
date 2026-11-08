import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMvpApp } from '../../src/mvp/server';
import { loadMvpConfig } from '../../src/mvp/config';
import { removeDailyHeaderFacts } from '../../src/indexer/pipeline';
import * as pipeline from '../../src/indexer/pipeline';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * A server removes the facts an earlier build made of the engine's own daily-note headers when it starts, before it
 * serves anything (the behaviour itself is proved against a real restart in inventory-counts.test.ts). The cleanup is
 * housekeeping on a derived index: if it fails, the workspace must still start and say so, because a person's memory
 * is worth more than the tidiness of an index. Here the cleanup is made to fail.
 */
vi.mock('../../src/indexer/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof pipeline>();
  return { ...actual, removeDailyHeaderFacts: vi.fn(actual.removeDailyHeaderFacts) };
});

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const tmpDirs: string[] = [];

beforeEach(() => {
  vi.mocked(removeDailyHeaderFacts).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function config() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-startup-clean-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  tmpDirs.push(memoryDir, authRoot);
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = 'http://127.0.0.1:3000';
  process.env.MVP_OWNER_EMAIL = 'owner@example.test';
  process.env.MVP_OWNER_PASSWORD = 'synthetic-owner-secret-123';
  process.env.MVP_PORT = '3000';
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  delete process.env.MVP_LEDGER_REL;
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  return loadMvpConfig();
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the cleanup a server does when it starts', () => {
  it('runs once, over the whole index, before the server is returned', async () => {
    const app = createMvpApp(config(), null);
    expect(removeDailyHeaderFacts).toHaveBeenCalledTimes(1);
    const [call] = vi.mocked(removeDailyHeaderFacts).mock.calls;
    expect(call).toHaveLength(1); // no note named: every note
    expect(call[0]).toBe(app.db);
    await app.close();
  });

  it('does not keep the workspace from starting when it fails, and says so', async () => {
    vi.mocked(removeDailyHeaderFacts).mockImplementationOnce(() => {
      throw new Error('database disk image is malformed');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = createMvpApp(config(), null);

    // It started and is usable: the index answers.
    expect(app.db.prepare('SELECT COUNT(*) AS c FROM notes').get()).toEqual({ c: 0 });
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/"event":"startup_header_cleanup_failed","err":\{"name":"Error","message":"database disk image is malformed"/));
    await app.close();
  });
});
