import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * The unit ExecStarts `node dist/mvp/cli.js` directly. `npm run mvp` used to put the package's
 * node_modules/.bin on PATH and a set of npm_* variables in the environment; dropping npm is a
 * speed change only if the engine needs none of that. This starts the real compiled entry point
 * with an environment that has ONLY the engine's own MVP_* settings (no PATH, no HOME, no npm_*)
 * and shows it serves and stops cleanly, which is a behaviour check rather than a search of the
 * source for the names npm injects.
 */

const ENTRY = path.resolve(__dirname, '../../dist/mvp/cli.js');
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

describe('the engine started with nothing npm provides', () => {
  it.skipIf(HTTP_SERVER_UNSUPPORTED)('serves, and exits 0 on SIGTERM, with no PATH, no HOME and no npm_* variable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-nonpm-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'memory'), { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'auth'), { mode: 0o700 });
    const port = await freePort();
    const env: Record<string, string> = {
      MVP_MEMORY_DIR: path.join(root, 'memory'),
      MVP_AUTH_STATE_PATH: path.join(root, 'auth', 'clients.json'),
      MVP_COMPILE_CACHE_DIR: path.join(root, 'cache', 'compile'),
      MVP_BASE_URL: `http://127.0.0.1:${port}`,
      MVP_PORT: String(port),
      MVP_OWNER_EMAIL: 'owner@example.test',
      MVP_OWNER_PASSWORD: 'synthetic-secret',
      MVP_EMBEDDING_PROVIDER: 'none',
    };
    expect(Object.keys(env).filter((k) => !k.startsWith('MVP_'))).toEqual([]);

    const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout!.on('data', (d) => { output += String(d); });
    child.stderr!.on('data', (d) => { output += String(d); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    let status = 0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && status !== 200) {
      try {
        status = (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`)).status;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    expect(status, output).toBe(200);
    expect(output).toContain('[mvp] Listening');

    child.kill('SIGTERM');
    expect(await exited).toEqual({ code: 0, signal: null });
  }, 90_000);
});

describe('the OpenAI SDK is loaded where it is constructed', () => {
  it('importing the provider module does not load the SDK; constructing a provider does', () => {
    const script = `
      const loaded = () => Object.keys(require.cache).filter((k) => /node_modules[\\\\/]openai[\\\\/]/.test(k)).length;
      const mod = require(${JSON.stringify(path.resolve(__dirname, '../../dist/embeddings/openai.js'))});
      const afterImport = loaded();
      new mod.OpenAIEmbeddingProvider('sk-synthetic');
      process.stdout.write(JSON.stringify({ afterImport, afterConstruct: loaded() }));
    `;
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
    if (res.status !== 0) throw new Error(`child failed (${res.status}): ${(res.stderr || '').slice(0, 500)}`);
    const out = JSON.parse(res.stdout) as { afterImport: number; afterConstruct: number };
    expect(out.afterImport).toBe(0);
    expect(out.afterConstruct).toBeGreaterThan(0);
  });
});
