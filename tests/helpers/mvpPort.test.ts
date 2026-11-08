import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { freePort, startMvpServiceOnFreePort, type StartedMvpService } from './mvpPort';
import { HTTP_SERVER_UNSUPPORTED } from './httpServerPlatform';

/**
 * The port-race guard's own tests. A test that probes a port and starts the service on it loses the race when another
 * process binds the port between the probe and the bind; the helper must then start again on another port, and must
 * not hide any other failure. The race is made on purpose here: a real listener holds the first port the helper is
 * offered, so the first attempt can only fail the way a lost race does.
 */

const ENV = ['MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT', 'MVP_ALLOWED_CALLBACK_URIS', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_DB_PATH'];
const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
const dirs: string[] = [];
const holders: net.Server[] = [];
const started: StartedMvpService[] = [];

afterEach(async () => {
  while (started.length) {
    const service = started.pop()!;
    service.httpServer.closeAllConnections?.();
    service.httpServer.close();
    await service.close();
  }
  while (holders.length) await new Promise<void>(resolve => holders.pop()!.close(() => resolve()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A port a live listener holds for the length of the test: binding it again is EADDRINUSE. */
async function heldPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  holders.push(server);
  return (server.address() as net.AddressInfo).port;
}

function configFactory(memoryDir: string, seen: number[] = []) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-port-auth-'));
  dirs.push(authDir);
  return (port: number): MvpConfig => {
    seen.push(port);
    process.env.MVP_MEMORY_DIR = memoryDir;
    process.env.MVP_AUTH_STATE_PATH = path.join(authDir, 'clients.json');
    process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MVP_OWNER_EMAIL = 'owner@example.test';
    process.env.MVP_OWNER_PASSWORD = 'synthetic-owner-secret-123';
    process.env.MVP_PORT = String(port);
    process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
    delete process.env.MVP_EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.MVP_DB_PATH;
    return loadMvpConfig();
  };
}

const memoryDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-port-'));
  dirs.push(dir);
  return dir;
};

/** The ports a picker hands out, in order; one past the end is a failure of the test, not of the helper. */
const picks = (...ports: number[]) => {
  const left = [...ports];
  return { calls: () => ports.length - left.length, pick: async () => { const next = left.shift(); if (next === undefined) throw new Error('the helper asked for more ports than the test allowed'); return next; } };
};

describe('startMvpServiceOnFreePort', () => {
  it.skipIf(HTTP_SERVER_UNSUPPORTED)('starts on a fresh port when the first one was taken between the probe and the bind', async () => {
    const taken = await heldPort();
    const fresh = await freePort();
    const seen: number[] = [];
    const offer = picks(taken, fresh);

    const result = await startMvpServiceOnFreePort(configFactory(memoryDir(), seen), undefined, { pickPort: offer.pick });
    started.push(result.started);

    expect(seen).toEqual([taken, fresh]); // the settings were built again for the second port
    expect(result.port).toBe(fresh);
    expect(result.config.port).toBe(fresh);
    expect(result.started.httpServer.listening).toBe(true);
    expect((result.started.httpServer.address() as net.AddressInfo).port).toBe(fresh);
    // It is this service that answers on the port it reports, not the process that held the first one.
    const metadata = await fetch(`http://127.0.0.1:${fresh}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    expect(String(((await metadata.json()) as { issuer?: unknown }).issuer)).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${fresh}/?$`));
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('starts on the first port when nothing took it, with one attempt', async () => {
    const port = await freePort();
    const offer = picks(port);
    const result = await startMvpServiceOnFreePort(configFactory(memoryDir()), undefined, { pickPort: offer.pick });
    started.push(result.started);
    expect(result.port).toBe(port);
    expect(offer.calls()).toBe(1);
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('gives up after its attempts, with the bind error itself', async () => {
    const taken = await heldPort();
    const offer = picks(taken, taken, taken);
    await expect(startMvpServiceOnFreePort(configFactory(memoryDir()), undefined, { attempts: 3, pickPort: offer.pick }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(offer.calls()).toBe(3);
  });

  it('does not retry a failure that is not a taken port', async () => {
    // A memory directory that is a file: the service cannot start, and another port would not change that.
    const notADirectory = path.join(memoryDir(), 'a-file');
    fs.writeFileSync(notADirectory, 'not a directory');
    const offer = picks(await freePort(), await freePort());
    await expect(startMvpServiceOnFreePort(configFactory(notADirectory), undefined, { pickPort: offer.pick }))
      .rejects.not.toMatchObject({ code: 'EADDRINUSE' });
    expect(offer.calls()).toBe(1);
  });
});
