import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp, MVP_MCP_PATH, MVP_VERSION_PATH, type MvpApp } from '../../src/mvp/server';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Live-security F5: mcp.renor.cloud answered with `X-Powered-By: Express`. The header names the
 * stack to a scanner and serves no client, and the gateway passes a tenant engine's answers through
 * as they are, so both processes stop sending it (the gateway's half is in
 * tests/review/gateway-oauth-routes.test.ts). One answer from each kind of route the engine serves:
 * the OAuth router, the owner login form, /mcp, the loopback instruments and an unknown path.
 *
 * Synthetic data, loopback only, no embedding provider.
 */

const GATEWAY_SECRET = 'synthetic-gateway-secret-f5';
const ENV = {
  MVP_BASE_URL: 'http://127.0.0.1:3471',
  MVP_OWNER_EMAIL: 'owner@example.test',
  MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
  MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
  MVP_GATEWAY_SECRET: GATEWAY_SECRET,
};
const tmpDirs: string[] = [];
let mvp: MvpApp | null = null;

function app(): MvpApp['app'] {
  if (!mvp) throw new Error('app not created');
  return mvp.app;
}

beforeAll(() => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-banner-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-banner-auth-'));
  tmpDirs.push(memoryDir, authRoot);
  const vars: Record<string, string> = { ...ENV, MVP_MEMORY_DIR: memoryDir, MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json') };
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    mvp = createMvpApp(loadMvpConfig(), null);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

afterAll(async () => {
  await mvp?.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the tenant engine does not advertise its framework (live-security F5)', () => {
  it.each([
    ['OAuth discovery', () => request(app()).get('/.well-known/oauth-authorization-server'), 200],
    ['the owner login form without a ticket', () => request(app()).post('/mvp-login').type('form').send({}), 400],
    ['/mcp without a bearer', () => request(app()).post(MVP_MCP_PATH).send({}), 401],
    ['the loopback build-identity probe', () => request(app()).get(MVP_VERSION_PATH), 200],
    ["the gateway's loopback mint", () => request(app()).post('/internal/gateway-token').set('x-renor-gateway-secret', GATEWAY_SECRET).send({}), 200],
    ['an unknown path', () => request(app()).get('/no-such-route'), 404],
  ])('sends nosniff and no X-Powered-By on %s', async (_label, call, status) => {
    const res = await call();
    expect(res.status).toBe(status);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
