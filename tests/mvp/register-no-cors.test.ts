import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { LOCAL_PORT, localApp, cleanupLocalApps } from '../helpers/localMvpApp';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Client registration is not open to web pages (adversary run renor-adv-localhost-1012, F4). The SDK answers
 * /register with `Access-Control-Allow-Origin: *`, so a page on any origin could register a client from the owner's
 * browser: squat the name the owner's real client needs (the entry is persisted), or burn the hourly limit.
 *
 * MCP clients are native programs and send no Origin; their reply is unchanged apart from carrying no CORS header.
 */

afterEach(cleanupLocalApps);

const BODY = { redirect_uris: ['http://localhost:39472/callback'], client_name: 'claude-code', token_endpoint_auth_method: 'none' };
const ORIGIN = `http://127.0.0.1:${LOCAL_PORT}`;
const storedClients = (authStatePath: string): unknown[] =>
  fs.existsSync(authStatePath) ? JSON.parse(fs.readFileSync(authStatePath, 'utf8')).clients : [];
const corsHeaders = (headers: Record<string, unknown>) => Object.keys(headers).filter(name => name.startsWith('access-control-'));

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('POST /register', () => {
  it('refuses a web page: no client is stored, so the name stays free for the real client', async () => {
    const { app, authStatePath } = localApp();
    for (const origin of ['http://evil.test', 'http://127.0.0.1:39580', 'https://evil.test:8443', 'null']) {
      const res = await request(app.app).post('/register').set('Origin', origin).send(BODY);
      expect(res.status, origin).toBe(403);
      expect(res.body.error).toBe('forbidden_origin');
      expect(corsHeaders(res.headers), origin).toEqual([]);
    }
    expect(storedClients(authStatePath)).toEqual([]);
    // The real client, which sends no Origin, still registers under the name the page tried to take.
    const real = await request(app.app).post('/register').send(BODY);
    expect(real.status).toBe(201);
    expect(real.body.client_name).toBe('claude-code');
    expect(storedClients(authStatePath)).toHaveLength(1);
  });

  it('answers a page\'s preflight with a refusal and no CORS headers, so the browser never sends the POST', async () => {
    const { app } = localApp();
    const res = await request(app.app).options('/register').set('Origin', 'http://evil.test')
      .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');
    expect(res.status).toBe(403);
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  it('registers a client that sends no Origin, with no wildcard CORS header on the answer', async () => {
    const { app, authStatePath } = localApp();
    const res = await request(app.app).post('/register').send(BODY);
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/\S/);
    expect(res.body.redirect_uris).toEqual(BODY.redirect_uris);
    expect(corsHeaders(res.headers)).toEqual([]);
    expect(storedClients(authStatePath)).toHaveLength(1);
  });

  it('accepts the service\'s own origin (its own pages), also without a CORS header', async () => {
    const { app } = localApp();
    const res = await request(app.app).post('/register').set('Origin', ORIGIN).send({ ...BODY, client_name: 'own-page' });
    expect(res.status).toBe(201);
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  it('does not change the other OAuth routes\' CORS (discovery and /token stay readable by browser clients)', async () => {
    const { app } = localApp();
    const res = await request(app.app).get('/.well-known/oauth-authorization-server').set('Origin', 'http://evil.test');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
