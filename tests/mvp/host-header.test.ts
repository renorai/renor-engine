import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { MVP_MCP_PATH } from '../../src/mvp/server';
import { LOCAL_PORT as PORT, localApp, cleanupLocalApps } from '../helpers/localMvpApp';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * DNS rebinding (adversary run renor-adv-localhost-1012, F3). A web page that rebinds its own domain to
 * 127.0.0.1 reaches the loopback listener with a foreign Host and, being same-origin to itself, can read every
 * response of every route that needs no token. The service answers only its own name (MVP_BASE_URL) and the
 * loopback names; the gateway-fronted deployment is the exception, since its public tenant Host arrives through Caddy.
 *
 * Every probe is a request with an explicit Host header against the real app; nothing inspects internal state.
 */

afterEach(cleanupLocalApps);

const appFor = (baseUrl: string, gatewaySecret?: string) => localApp({ baseUrl, gatewaySecret }).app;

/** Routes a rebound page would read: none needs a token. */
const OPEN_ROUTES: Array<['get' | 'post', string]> = [
  ['get', '/.well-known/oauth-authorization-server'],
  ['get', '/.well-known/oauth-protected-resource/mcp'],
  ['post', '/register'],
  ['get', '/authorize'],
  ['post', '/mvp-login'],
  ['post', MVP_MCP_PATH],
];

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('MVP server: Host header (DNS rebinding)', () => {
  it.each(OPEN_ROUTES)('refuses a foreign Host on %s %s with 403 before any route runs', async (method, route) => {
    const { app } = appFor(`http://127.0.0.1:${PORT}`);
    for (const host of ['evil.test', `evil.test:${PORT}`, '127.0.0.1.evil.test', 'localhost.evil.test:80']) {
      const res = await request(app)[method](route).set('Host', host);
      expect(res.status, `${host} ${route}`).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('leaks nothing of the OAuth metadata to a foreign Host', async () => {
    const { app } = appFor(`http://127.0.0.1:${PORT}`);
    const res = await request(app).get('/.well-known/oauth-authorization-server').set('Host', `evil.test:${PORT}`);
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('authorization_endpoint');
  });

  it.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, 'localhost'])('still answers the loopback Host %s', async (host) => {
    const { app } = appFor(`http://127.0.0.1:${PORT}`);
    const res = await request(app).get('/.well-known/oauth-authorization-server').set('Host', host);
    expect(res.status).toBe(200);
    expect(res.body.registration_endpoint).toBe(`http://127.0.0.1:${PORT}/register`);
  });

  it('answers the configured base hostname, whatever it is', async () => {
    const { app } = appFor('https://memory.example.test');
    const own = await request(app).get('/.well-known/oauth-authorization-server').set('Host', 'memory.example.test');
    expect(own.status).toBe(200);
    const other = await request(app).get('/.well-known/oauth-authorization-server').set('Host', 'evil.test');
    expect(other.status).toBe(403);
  });

  it('stays out of the way behind the gateway, where the public tenant Host arrives through Caddy', async () => {
    const { app } = appFor(`http://127.0.0.1:${PORT}`, 'synthetic-gateway-secret-for-host-test');
    const res = await request(app).get('/.well-known/oauth-authorization-server').set('Host', 'sample-tenant.203.0.113.10.sslip.io');
    expect(res.status).toBe(200);
  });
});
