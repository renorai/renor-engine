import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { attachEngine } from '../../src/mvp/engine';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService } from '../../src/mvp/server';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Starting the service means owning the port. Express hands a failed bind to the same
 * callback as a successful one, so an engine that never listened used to be returned as
 * started: the CLI printed `[mvp] Listening` for a port another process answers, and the
 * second engine silently talked to the first one. A port that is already taken is a start
 * failure that names the port, and the engine that does hold it keeps serving.
 *
 * A start that fails owns nothing either. The engine it opened — its database, and the
 * embedding rebuild it may have started — is closed before the failure is reported, because
 * the caller never receives the app and so can never close it.
 *
 * Synthetic data only, loopback only, hash embeddings only (no model, no network).
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const ENV_KEYS = [
  'MVP_PORT', 'MVP_BASE_URL', 'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_DB_PATH',
  'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_ALLOWED_CALLBACK_URIS',
  'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'RENOR_ON_DEMAND',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const tmpDirs: string[] = [];
const started: Awaited<ReturnType<typeof startMvpService>>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of started.splice(0)) {
    service.httpServer.closeAllConnections();
    service.httpServer.close();
    await service.close();
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A port nothing holds, taken the way every test in this suite takes one. */
function freePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** A private owner workspace on `port`, with its own memory directory and derived index. */
function workspaceOn(port: number, memoryDir = tmp('mvp-bind-mem-')): MvpConfig {
  const authRoot = tmp('mvp-bind-auth-');
  Object.assign(process.env, {
    MVP_PORT: String(port),
    MVP_BASE_URL: `http://127.0.0.1:${port}`,
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_OWNER_EMAIL: OWNER_EMAIL,
    MVP_OWNER_PASSWORD: OWNER_PASSWORD,
    MVP_ALLOWED_CALLBACK_URIS: `http://127.0.0.1:${port}/callback`,
  });
  delete process.env.MVP_DB_PATH;
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.RENOR_ON_DEMAND;
  return loadMvpConfig();
}

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * A model the stub's own model is not: an index built by `EvalHashEmbeddingProvider` is not
 * whole in this model's space, so a start with this one begins a boot rebuild. Every request
 * is counted, and while `hold` is set each one waits for `release()`.
 */
class OtherModel extends EvalHashEmbeddingProvider {
  readonly identity = { kind: 'eval-hash', model: 'other-bind-test-model' };
  /** Requests the engine has asked for. */
  requests = 0;
  hold = true;
  private waiting: Array<() => void> = [];
  private onRequest: (() => void) | null = null;
  /** Resolves once the engine has asked for its first batch of vectors. */
  firstRequest(): Promise<void> {
    if (this.requests > 0) return Promise.resolve();
    return new Promise<void>(resolve => { this.onRequest = resolve; });
  }
  release() { this.hold = false; this.waiting.splice(0).forEach(resume => resume()); }
  async embed(texts: string[]): Promise<number[][]> {
    this.requests++;
    this.onRequest?.();
    this.onRequest = null;
    if (this.hold) await new Promise<void>(resume => this.waiting.push(resume));
    return (await super.embed(texts)).map(v => v.map(x => -x));
  }
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Long enough that a start which has already been told the port is gone has said so. It only has to outlast the
 * delivery of a local bind error, which takes a tick, so this is slack for a loaded machine rather than a budget.
 */
const FAILURE_WINDOW_MS = 500;

const note = (title: string, sections: number) =>
  `# ${title}\n\n` + Array.from({ length: sections }, (_, k) =>
    `## ${title} section ${k}\nbody ${title} ${k} codeword quokkaberry\n`).join('\n');

/** A workspace whose index the stub's own model built, so a start with `OtherModel` begins a boot rebuild. */
async function workspaceNeedingRebuild(port: number): Promise<MvpConfig> {
  const memoryDir = tmp('mvp-bind-rebuild-mem-');
  fs.writeFileSync(path.join(memoryDir, 'a.md'), note('Alpha', 3));
  fs.writeFileSync(path.join(memoryDir, 'b.md'), note('Bravo', 3));
  const config = workspaceOn(port, memoryDir);
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = openDb(config.dbPath);
  runMigrations(db);
  const builder = new EvalHashEmbeddingProvider();
  const engine = attachEngine(db, { embeddingProvider: 'none' } as MvpConfig, builder);
  try {
    await indexVault(db, memoryDir, { embeddingProvider: builder, vectorIndex: engine.vectorIndex! }, 1);
  } finally {
    db.close();
  }
  return config;
}

/** Keeps the engine's own start-up and rebuild logging out of this file's output, and records its lines. */
function silenceEngine() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return log;
}

/** The open file descriptors of this process that point inside `dir` (Linux). */
function handlesInside(dir: string): string[] {
  const found: string[] = [];
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    try {
      const target = fs.readlinkSync(path.join('/proc/self/fd', fd));
      if (target.startsWith(dir)) found.push(`${fd} -> ${path.relative(dir, target)}`);
    } catch {
      // The descriptor closed while it was being read; it is not open any more, which is all this asks.
    }
  }
  return found;
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('starting the service on a port', () => {
  it('fails with the listen error naming the port, and leaves the engine that holds it serving', async () => {
    const port = await freePort();
    const holder = await startMvpService(workspaceOn(port), null);
    started.push(holder);
    expect(holder.httpServer.listening).toBe(true);

    // A second engine, its own workspace, asked for the port the first one already owns.
    const attempt = await startMvpService(workspaceOn(port), null).then(
      service => ({ started: service }),
      (error: unknown) => ({ error })
    );
    // Before the fix this resolved with a server that never listened; keep that one closable
    // so a failing run here leaks nothing.
    if ('started' in attempt) started.push(attempt.started);

    expect(attempt, 'starting on a taken port must not resolve').not.toHaveProperty('started');
    const error = (attempt as { error: NodeJS.ErrnoException }).error;
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
    expect((error as Error).message).toContain(String(port));

    // The engine that owns the port is untouched: it is still listening and still serving.
    expect(holder.httpServer.listening).toBe(true);
    const response = await fetch(`http://127.0.0.1:${port}/version`, { redirect: 'manual' });
    expect(response.status).toBe(200);
  });

  it('closes the engine it opened when the port is taken: nothing it started is left running', async () => {
    const log = silenceEngine();
    const port = await freePort();
    const holder = await startMvpService(workspaceOn(port), null);
    started.push(holder);

    // This workspace's index is in another model's space, so a start with `OtherModel` begins a boot rebuild
    // before it binds: the failed engine here has real background work that only its close can stop.
    const model = new OtherModel();
    const config = await workspaceNeedingRebuild(port);
    const attempt = startMvpService(config, model).then(
      service => ({ started: service }),
      (error: unknown) => ({ error })
    );
    await model.firstRequest(); // the rebuild is under way and its request is held

    // Reporting the failure while that rebuild is still running means it leaked: the caller was told the start
    // failed and the work carried on, on an engine the caller never received and so can never close. A start
    // that closes what it opened waits for the work it started before it gives up.
    const reportedWhileRebuilding = await Promise.race([
      attempt.then(() => true),
      delay(FAILURE_WINDOW_MS).then(() => false),
    ]);
    model.release();
    const outcome = await attempt;
    if ('started' in outcome) started.push(outcome.started);

    expect(outcome, 'starting on a taken port must not resolve').not.toHaveProperty('started');
    expect(((outcome as { error: NodeJS.ErrnoException }).error).code).toBe('EADDRINUSE');
    expect(model.requests, 'the failed engine had a boot rebuild to stop').toBeGreaterThan(0);
    expect(reportedWhileRebuilding, 'the failed start reported the failure while its own rebuild was still running').toBe(false);
    expect(log.mock.calls.map(args => String(args[0])).filter(line => line.includes('rebuild finished')),
      'the engine whose start failed carried its rebuild to the end').toEqual([]);
  }, 30_000);

  it.runIf(process.platform === 'linux')('closes the database of a failed start', async () => {
    silenceEngine();
    const port = await freePort();
    const holder = await startMvpService(workspaceOn(port), null);
    started.push(holder);

    const config = workspaceOn(port);
    const attempt = await startMvpService(config, null).then(
      service => ({ started: service }),
      (error: unknown) => ({ error })
    );
    if ('started' in attempt) started.push(attempt.started);

    expect(attempt, 'starting on a taken port must not resolve').not.toHaveProperty('started');
    expect(((attempt as { error: NodeJS.ErrnoException }).error).code).toBe('EADDRINUSE');
    expect(handlesInside(config.memoryDir), 'the engine whose start failed left its database open').toEqual([]);
  }, 30_000);
});
