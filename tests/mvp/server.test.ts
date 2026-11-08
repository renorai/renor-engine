import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Single-user ChatGPT MVP — end-to-end vertical-slice tests over the REAL
 * remote MCP surface: OAuth 2.1 authorization-server endpoints (dynamic
 * client registration, owner login, PKCE, token refresh/revocation) and the
 * Streamable HTTP MCP endpoint driven by the SDK's own client. All data is
 * synthetic (mkdtemp memory dirs); no embeddings, no network beyond localhost.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const tmpDirs: string[] = [];
let started: (MvpApp & { httpServer: import('http').Server }) | null = null;
let activeConfig: MvpConfig | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function makeConfig(memoryDir: string, port: number): MvpConfig {
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  tmpDirs.push(authRoot);
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  // AUTH-B1: DCR allowlist — synthetic tests allow only the synthetic loopback callback
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  const config = loadMvpConfig();
  return config;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

async function registerClient(app: Express, name = 'synthetic-test-client'): Promise<OAuthClient> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const res = await request(app).post('/register')
    .send({ client_name: name, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  return { clientId: res.body.client_id as string, clientSecret: res.body.client_secret as string, redirectUri };
}

/** Full successful owner OAuth dance: returns access + refresh tokens. */
async function ownerAuthorize(app: Express, client: OAuthClient, email = OWNER_EMAIL, password = OWNER_PASSWORD): Promise<{
  status: number; tokens?: any; location?: string; body?: string;
}> {
  const { verifier, challenge } = pkce();
  // 1. authorize GET -> consent + login form carrying the one-time ticket
  const authorizeRes = await request(app).get('/authorize').query({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'memory',
  });
  if (authorizeRes.status !== 200) return { status: authorizeRes.status, body: authorizeRes.text };
  const ticket = authorizeRes.text.match(/name="ticket" value="([^"]+)"/)?.[1];
  if (!ticket) return { status: 500, body: 'no authorization ticket rendered' };
  // 2. owner login POST: ticket + explicit approval only (parameters come
  // from the server-side ticket, never from the form body)
  const loginRes = await request(app).post('/mvp-login')
    .type('form')
    .send({
      ticket,
      approve: 'on',
      email,
      password,
    });
  if (loginRes.status !== 302) return { status: loginRes.status, body: loginRes.text };
  const location = loginRes.headers.location as string;
  const code = new URL(location, `http://x`).searchParams.get('code')!;
  // 3. token exchange with PKCE
  const tokenRes = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code_verifier: verifier,
  });
  if (tokenRes.status !== 200) return { status: tokenRes.status, body: tokenRes.text };
  return { status: 200, tokens: tokenRes.body, location };
}

async function mcpClient(config: MvpConfig, accessToken: string): Promise<Client> {
  const client = new Client({ name: 'mvp-test-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } },
  );
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  const port = await freePort();
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-e2e-'));
  tmpDirs.push(memoryDir);
  activeConfig = makeConfig(memoryDir, port);
  started = await startMvpService(activeConfig);
});

afterEach(() => {
  // nothing per-test; service is shared for the vertical slice flow
});

afterAll(async () => {
  if (started) {
    started.httpServer.close();
    await started.close();
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.MVP_MEMORY_DIR;
  delete process.env.MVP_BASE_URL;
  delete process.env.MVP_OWNER_EMAIL;
  delete process.env.MVP_OWNER_PASSWORD;
  delete process.env.MVP_PORT;
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('MVP vertical slice: owner OAuth 2.1 + remote MCP + persistent memory', () => {
  let oauth: OAuthClient;
  let tokens: any;

  it('advertises OAuth discovery metadata and registers clients dynamically', async () => {
    const app = started!.app;
    const meta = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(meta.body.authorization_endpoint).toContain('/authorize');
    expect(meta.body.token_endpoint).toContain('/token');
    expect(meta.body.registration_endpoint).toContain('/register');
    const rsMeta = await request(app).get('/.well-known/oauth-protected-resource/mcp').expect(200);
    expect(rsMeta.body.resource).toContain('/mcp');
    expect(rsMeta.body.authorization_servers[0]).toContain(config().baseUrl.href);
    oauth = await registerClient(app);
    expect(oauth.clientId).toBeTruthy();
  });

  it('rejects wrong owner credentials: no code, no token, never any access', async () => {
    const app = started!.app;
    const badClient = await registerClient(app, 'bad-creds-client');
    const result = await ownerAuthorize(app, badClient, 'intruder@example.test', 'wrong-secret');
    expect(result.status).toBe(403);
    expect(result.body).toContain('rejected');
    // And a direct login with the right email but wrong password fails too.
    const result2 = await ownerAuthorize(app, badClient, OWNER_EMAIL, 'wrong-secret');
    expect(result2.status).toBe(403);
  });

  it('completes the owner OAuth dance with PKCE; a wrong code_verifier fails', async () => {
    const app = started!.app;
    const result = await ownerAuthorize(app, oauth);
    expect(result.status).toBe(200);
    tokens = result.tokens;
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe('Bearer');

    // PKCE enforcement: fresh dance with a mismatched verifier must not mint a token.
    const { challenge } = pkce();
    const authorizeRes = await request(app).get('/authorize').query({
      client_id: oauth.clientId, redirect_uri: oauth.redirectUri, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    }).expect(200);
    const badTicket = authorizeRes.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
    const loginRes = await request(app).post('/mvp-login').type('form').send({
      ticket: badTicket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
    }).expect(302);
    const code = new URL(loginRes.headers.location, 'http://x').searchParams.get('code')!;
    const badExchange = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: oauth.redirectUri,
      client_id: oauth.clientId, client_secret: oauth.clientSecret,
      code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier',
    });
    expect(badExchange.status).toBeGreaterThanOrEqual(400);
  });

  it('refresh token rotation works and old refresh tokens are single-use', async () => {
    const app = started!.app;
    const first = await request(app).post('/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
      client_id: oauth.clientId, client_secret: oauth.clientSecret,
    }).expect(200);
    expect(first.body.access_token).toBeTruthy();
    const replay = await request(app).post('/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
      client_id: oauth.clientId, client_secret: oauth.clientSecret,
    });
    expect(replay.status).toBeGreaterThanOrEqual(400); // rotated: single use
    tokens = first.body; // keep the fresh pair for later tests
  });

  it('blocks MCP access without or with invalid credentials (never read/write)', async () => {
    const cfg = config();
    const noAuth = new Client({ name: 'noauth', version: '0' });
    const t1 = new StreamableHTTPClientTransport(new URL(MVP_MCP_PATH, `http://127.0.0.1:${cfg.port}`));
    await expect(noAuth.connect(t1)).rejects.toThrow();
    const garbage = new Client({ name: 'garbage', version: '0' });
    const t2 = new StreamableHTTPClientTransport(
      new URL(MVP_MCP_PATH, `http://127.0.0.1:${cfg.port}`),
      { requestInit: { headers: { Authorization: 'Bearer not-a-real-token' } } },
    );
    await expect(garbage.connect(t2)).rejects.toThrow();
  });

  it('saves a memory over authenticated MCP, persists real Markdown, returns an honest receipt', async () => {
    const client = await mcpClient(config(), tokens.access_token);
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['remember', 'get_context', 'save_memory', 'retrieve_memory', 'export_memory']));

    const save = await client.callTool({ name: 'save_memory', arguments: {
      subject: 'SynthOwner', predicate: 'works_at', object: 'Memory Company', source: 'chatgpt',
    } });
    const receipt = JSON.parse((save.content as any)[0].text);
    expect(receipt.ok).toBe(true);
    expect(receipt.action).toBe('store');
    expect(receipt.eventId).toMatch(/^MEM_/);
    expect(receipt.ledger).toBe('System/Memory Events Ledger.md'); // relative, no host path leak

    // Real persisted Markdown on disk (source of truth), SQLite only derived.
    const ledgerPath = path.join(config().memoryDir, 'System/Memory Events Ledger.md');
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const ledger = fs.readFileSync(ledgerPath, 'utf-8');
    expect(ledger).toContain('## ' + receipt.eventId);
    expect(ledger).toContain('- subject: SynthOwner');
    expect(ledger).toContain('- object: Memory Company');
    await client.close();
  });

  it('remember gives agents a natural write path and get_context returns the corrected current fact', async () => {
    const client = await mcpClient(config(), tokens.access_token);

    const first = await client.callTool({ name: 'remember', arguments: {
      statement: 'AgentUXOwner prefers Bun for TypeScript projects.',
      subject: 'AgentUXOwner',
      predicate: 'prefers_runtime',
      object: 'Bun',
      source: 'claude',
    } });
    const firstBody = JSON.parse((first.content as any)[0].text);
    expect(firstBody.ok).toBe(true);
    expect(firstBody.mode).toBe('fact');
    expect(firstBody.action).toBe('store');

    const corrected = await client.callTool({ name: 'remember', arguments: {
      statement: 'AgentUXOwner now prefers Node.js for TypeScript projects.',
      subject: 'AgentUXOwner',
      predicate: 'prefers_runtime',
      object: 'Node.js',
      source: 'cursor',
    } });
    const correctedBody = JSON.parse((corrected.content as any)[0].text);
    expect(correctedBody.ok).toBe(true);
    expect(correctedBody.mode).toBe('fact');
    expect(correctedBody.action).toBe('supersede');

    const context = await client.callTool({ name: 'get_context', arguments: {
      query: 'What runtime does AgentUXOwner prefer for TypeScript projects?',
      max_tokens: 800,
    } });
    const contextBody = JSON.parse((context.content as any)[0].text);
    expect(contextBody.ok).toBe(true);
    expect(contextBody.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: 'AgentUXOwner',
        predicate: 'prefers_runtime',
        object: 'Node.js',
      }),
    ]));
    expect(JSON.stringify(contextBody)).not.toContain('\"object\":\"Bun\"');

    await client.close();
  });

  it('remember falls back to an indexed durable note when one safe fact cannot be extracted', async () => {
    const client = await mcpClient(config(), tokens.access_token);

    const saved = await client.callTool({ name: 'remember', arguments: {
      statement: 'The launch codename is Project Firefly and the rehearsal should stay relaxed.',
      source: 'chatgpt',
    } });
    const savedBody = JSON.parse((saved.content as any)[0].text);
    expect(savedBody.ok).toBe(true);
    expect(savedBody.mode).toBe('note');
    expect(savedBody.indexed).toBe(true);

    const context = await client.callTool({ name: 'get_context', arguments: {
      query: 'What is the launch codename?',
      max_tokens: 800,
    } });
    const contextBody = JSON.parse((context.content as any)[0].text);
    expect(contextBody.ok).toBe(true);
    expect(contextBody.memories.some((m: any) => m.text.includes('Project Firefly'))).toBe(true);

    await client.close();
  });

  it('memory_map shows the saved note and fact; retire takes the note out of recall and restore brings it back', async () => {
    const client = await mcpClient(config(), tokens.access_token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['memory_map', 'read_memory', 'retire_memory', 'restore_memory']));

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      return { isError: Boolean(res.isError), body: (res.content as any)[0].text as string };
    };

    const map = JSON.parse((await call('memory_map')).body);
    expect(map.ok).toBe(true);
    // The note saved by the fallback test above, and the corrected fact with its history.
    const firefly = map.memories.find((m: any) => m.kind === 'entry' && m.title.includes('Project Firefly'));
    expect(firefly).toBeTruthy();
    const runtime = map.facts.filter((f: any) => f.subject === 'AgentUXOwner' && f.predicate === 'prefers_runtime');
    expect(runtime.map((f: any) => [f.object, f.validTo === null])).toEqual([['Node.js', true], ['Bun', false]]);
    // No host path leaks: memory paths are vault-relative.
    expect(JSON.stringify(map)).not.toContain(config().memoryDir);

    const read = JSON.parse((await call('read_memory', { id: firefly.id })).body);
    expect(read.text).toContain('Project Firefly');

    const retired = JSON.parse((await call('retire_memory', { id: firefly.id })).body);
    expect(retired.action).toBe('retired');
    const recall = JSON.parse((await call('get_context', { query: 'What is the launch codename?', max_tokens: 800 })).body);
    expect(JSON.stringify(recall.memories)).not.toContain('Project Firefly');

    const restored = JSON.parse((await call('restore_memory', { id: firefly.id })).body);
    expect(restored.action).toBe('restored');
    const recallAgain = JSON.parse((await call('get_context', { query: 'What is the launch codename?', max_tokens: 800 })).body);
    expect(recallAgain.memories.some((m: any) => m.text.includes('Project Firefly'))).toBe(true);

    // Path escapes are tool errors, not reads.
    const escape = await call('read_memory', { id: 'note:../../etc/passwd.md' });
    expect(escape.isError).toBe(true);

    await client.close();
  });

  it('the landing-page recall example works: save a favourite editor, ask about it in the same words', async () => {
    // The wording below is copied into the website's setup prompt
    // (src/lib/landing-setup-prompt.ts, pinned by tests/landing-setup-prompt.test.ts). The earlier
    // example, "What do you know about my preferences?", returned nothing: get_context matches words.
    const client = await mcpClient(config(), tokens.access_token);
    const call = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool(args as any)).content as any)[0].text);

    await call({ name: 'remember', arguments: {
      statement: 'My favorite editor is Neovim.', subject: 'user', predicate: 'favorite_editor', object: 'Neovim', source: 'claude',
    } });
    const structured = await call({ name: 'get_context', arguments: { query: 'What is my favorite editor?', max_tokens: 800 } });
    expect(structured.facts.some((f: any) => f.object === 'Neovim')).toBe(true);

    // An agent that cannot extract a structured fact stores a note; the same question must still find it.
    const note = await call({ name: 'remember', arguments: { statement: 'My favorite terminal is Ghostty.', source: 'claude' } });
    expect(note.mode).toBe('note');
    expect(note.indexed).toBe(true);
    const viaNote = await call({ name: 'get_context', arguments: { query: 'What is my favorite terminal?', max_tokens: 800 } });
    expect(viaNote.memories.some((m: any) => m.text.includes('Ghostty'))).toBe(true);
    await client.close();
  });

  it('immediate consistent read: retrieve sees the saved value in the same service', async () => {
    const client = await mcpClient(config(), tokens.access_token);
    const res = await client.callTool({ name: 'retrieve_memory', arguments: { subject: 'SynthOwner' } });
    const body = JSON.parse((res.content as any)[0].text);
    expect(body.facts).toHaveLength(1);
    expect(body.facts[0].predicate).toBe('works_at');
    expect(body.facts[0].object).toBe('Memory Company');
    await client.close();
  });

  it('correction by supersession: new value current, old value in history only', async () => {
    const client = await mcpClient(config(), tokens.access_token);
    const save = await client.callTool({ name: 'save_memory', arguments: {
      subject: 'SynthOwner', predicate: 'works_at', object: 'Memory Company (corrected)', source: 'chatgpt',
    } });
    const receipt = JSON.parse((save.content as any)[0].text);
    expect(receipt.action).toBe('supersede');
    expect(receipt.closed.object).toBe('Memory Company');

    const current = JSON.parse(((await client.callTool({ name: 'retrieve_memory', arguments: { subject: 'SynthOwner' } })).content as any)[0].text);
    expect(current.facts).toHaveLength(1);
    expect(current.facts[0].object).toBe('Memory Company (corrected)');

    const history = JSON.parse(((await client.callTool({ name: 'retrieve_memory', arguments: { subject: 'SynthOwner', include_history: true } })).content as any)[0].text);
    expect(history.facts).toHaveLength(2);
    await client.close();
  });

  it('bounded inputs: an oversized subject is rejected with a clear error, nothing persisted', async () => {
    const client = await mcpClient(config(), tokens.access_token);
    const res = await client.callTool({ name: 'save_memory', arguments: {
      subject: 'x'.repeat(100000), predicate: 'p', object: 'o',
    } });
    expect(res.isError).toBeTruthy();
    const ledgerPath = path.join(config().memoryDir, 'System/Memory Events Ledger.md');
    const before = fs.readFileSync(ledgerPath, 'utf-8');
    expect(before).not.toContain('x'.repeat(600));
    await client.close();
  });

  it('export returns the complete raw Markdown source of truth', async () => {
    const client = await mcpClient(config(), tokens.access_token);
    const res = await client.callTool({ name: 'export_memory', arguments: {} });
    const meta = JSON.parse((res.content as any)[0].text);
    const markdown = (res.content as any)[1].text as string;
    expect(meta.file).toBe('System/Memory Events Ledger.md');
    expect(markdown).toContain('SynthOwner');
    expect(markdown).toContain('Memory Company (corrected)');
    const onDisk = fs.readFileSync(path.join(config().memoryDir, 'System/Memory Events Ledger.md'), 'utf-8');
    // The export is a strict superset of the ledger: it opens with the actual source bytes, then the workspace's notes.
    expect(markdown.startsWith(onDisk)).toBe(true);
    expect(meta.bytes).toBe(onDisk.length);
    await client.close();
  });

  it('revocation: a revoked access token can never read or write again', async () => {
    const app = started!.app;
    const fresh = await request(app).post('/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
      client_id: oauth.clientId, client_secret: oauth.clientSecret,
    }).expect(200);
    const doomed = fresh.body;
    const client = await mcpClient(config(), doomed.access_token);
    await client.callTool({ name: 'retrieve_memory', arguments: { subject: 'SynthOwner' } });
    await client.close();

    await request(app).post('/revoke').type('form').send({
      token: doomed.access_token, client_id: oauth.clientId, client_secret: oauth.clientSecret,
      token_type_hint: 'access_token',
    }).expect(200);

    const revoked = new Client({ name: 'revoked', version: '0' });
    const t = new StreamableHTTPClientTransport(
      new URL(MVP_MCP_PATH, `http://127.0.0.1:${config().port}`),
      { requestInit: { headers: { Authorization: `Bearer ${doomed.access_token}` } } },
    );
    await expect(revoked.connect(t)).rejects.toThrow();
    tokens = { ...doomed, refresh_token: doomed.refresh_token }; // keep remaining valid pair
  });

  it('the legacy unauthenticated HTTP API is NOT exposed by the MVP service', async () => {
    const app = started!.app;
    await request(app).post('/retrieve-context').send({ query: 'x' }).expect(404);
    await request(app).post('/memory/fact').send({ subject: 's', predicate: 'p', object: 'o' }).expect(404);
  });

  it('restart recovery: a fresh service replays the ledger and serves the same current value', async () => {
    // Stop the current service (fresh process equivalent: new app, new db handle).
    started!.httpServer.close();
    await started!.close();

    const port = await freePort();
    const cfg = makeConfig(config().memoryDir, port); // SAME memory dir
    activeConfig = cfg;
    started = await startMvpService(cfg);

    const app = started.app;
    const client2 = await registerClient(app, 'restart-client');
    const dance = await ownerAuthorize(app, client2);
    expect(dance.status).toBe(200);
    const client = await mcpClient(cfg, dance.tokens.access_token);
    const res = await client.callTool({ name: 'retrieve_memory', arguments: { subject: 'SynthOwner' } });
    const body = JSON.parse((res.content as any)[0].text);
    expect(body.facts).toHaveLength(1);
    expect(body.facts[0].object).toBe('Memory Company (corrected)');
    // Full history survived the restart too.
    const hist = JSON.parse(((await client.callTool({ name: 'retrieve_memory', arguments: { subject: 'SynthOwner', include_history: true } })).content as any)[0].text);
    expect(hist.facts).toHaveLength(2);
    await client.close();
  });
});

function config(): MvpConfig {
  if (!activeConfig) throw new Error('service not started');
  return activeConfig;
}