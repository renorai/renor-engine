import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, createMvpApp, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { ClientRegistry, ClientRegistryError } from '../../src/mvp/client-store';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * CLIENT-PERSISTENCE regressions (restart contract for the DCR registry).
 *
 * The MVP previously kept registered OAuth clients in memory only; ChatGPT
 * registers a client ONCE and caches its client_id, so every service restart
 * broke fresh authorization with invalid_client. These tests pin the new
 * restart contract: registered client metadata persists in an explicit
 * owner-only store OUTSIDE the memory/history trees, a restart boots from
 * the SAME store, and the SAME client (no re-registration) authorizes again
 * with a fresh ticket + PKCE while memory/history keep working. Everything
 * else fails closed: corrupt/symlink/permission/bound/io-failure states
 * never yield a silently-reset or in-memory-only registry. Tickets and codes
 * are NOT persisted (single-use, short-lived). All data synthetic, loopback
 * only, no vault/Downloads access, no secrets in outputs.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const LOOPBACK_CB = 'http://127.0.0.1:1/callback';

const tmpDirs: string[] = [];
const services: { httpServer: import('http').Server }[] = [];
const apps: MvpApp[] = [];

afterEach(() => {
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
  }
  while (apps.length) apps.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function tmpdir0700(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); // mkdtemp is 0700
  tmpDirs.push(d);
  return d;
}

interface Boot {
  config: MvpConfig;
  app: Express;
  stop: () => void;
}

/** Boots a REAL listening service (true restart semantics). */
async function bootService(opts: {
  memoryDir: string;
  authStatePath: string;
  historyDir?: string;
  allowlist?: string;
}): Promise<Boot> {
  const port = await freePort();
  process.env.MVP_MEMORY_DIR = opts.memoryDir;
  process.env.MVP_AUTH_STATE_PATH = opts.authStatePath;
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_ALLOWED_CALLBACK_URIS = opts.allowlist ?? LOOPBACK_CB;
  if (opts.historyDir === undefined) delete process.env.MVP_HISTORY_DIR;
  else process.env.MVP_HISTORY_DIR = opts.historyDir;
  process.env.MVP_PORT = String(port);
  const config = loadMvpConfig();
  const started = await startMvpService(config);
  services.push(started);
  apps.push(started);
  return {
    config,
    app: started.app,
    stop: () => {
      started.httpServer.closeAllConnections?.();
      started.httpServer.close();
    },
  };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(app: Express): Promise<{ clientId: string; clientSecret: string; redirectUri: string }> {
  const res = await request(app).post('/register')
    .send({ client_name: 'synthetic-persistence-client', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code', 'refresh_token'] });
  expect(res.status).toBe(201);
  return { clientId: res.body.client_id, clientSecret: res.body.client_secret, redirectUri: LOOPBACK_CB };
}

async function getTicket(app: Express, clientId: string, redirectUri: string, challenge: string) {
  const res = await request(app).get('/authorize').query({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  });
  const ticket = res.status === 200 ? res.text.match(/name="ticket" value="([^"]+)"/)?.[1] ?? null : null;
  return { status: res.status, ticket, text: res.text };
}

async function ownerLogin(app: Express, _client: { clientId: string; clientSecret: string; redirectUri: string },
                         ticket: string) {
  const login = await request(app).post('/mvp-login')
    .type('form').send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
  if (login.status !== 302) return { loginStatus: login.status, code: null };
  const code = new URL(login.headers.location as string, 'http://x').searchParams.get('code');
  return { loginStatus: 302, code };
}

async function exchangeToken(app: Express, client: { clientId: string; clientSecret: string; redirectUri: string },
                             code: string, verifier: string) {
  const res = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: client.redirectUri,
    client_id: client.clientId, client_secret: client.clientSecret, code_verifier: verifier,
  });
  return { status: res.status, tokens: res.body };
}

async function fullAuthorize(app: Express, client: { clientId: string; clientSecret: string; redirectUri: string }): Promise<{
  status: number; tokens?: any; code?: string | null; ticket?: string | null;
}> {
  const { verifier, challenge } = pkce();
  const { status, ticket } = await getTicket(app, client.clientId, client.redirectUri, challenge);
  if (!ticket) return { status, ticket: null };
  const login = await ownerLogin(app, client, ticket);
  if (!login.code) return { status: login.loginStatus };
  const token = await exchangeToken(app, client, login.code, verifier);
  if (token.status !== 200) return { status: token.status };
  return { status: 200, tokens: token.tokens, code: login.code };
}

async function mcpCall(config: MvpConfig, accessToken: string, method: string, toolName?: string, args?: Record<string, unknown>) {
  const client = new Client({ name: 'persistence-test-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } },
  );
  await client.connect(transport);
  try {
    if (method === 'initialize' || !toolName) {
      const tools = await client.listTools();
      return tools;
    }
    const res = await client.callTool({ name: toolName, arguments: args ?? {} });
    return JSON.parse((res.content as { text: string }[])[0].text);
  } finally {
    await client.close();
  }
}

/** Minimal synthetic promoted-history fixture (reviewed promotion shape). */
function writeSyntheticHistory(historyDir: string): void {
  // reviewed promotion shape: note files sit DIRECTLY in the history dir;
  // the manifest entry's rel is the marker `notes/<name>` (see src/mvp/history.ts)
  const convId = 'conv-persist-0001';
  const fm = [
    'type: "journal"', 'source: "ChatGPT export"', `conversation_id: "${convId}"`,
    'title: "Synthetic persistence calibration chat"',
    'created: "2023-11-14T22:13:20Z"', 'updated: "2023-11-14T22:23:20Z"',
    'memory_layer: "history"', 'trust: "untrusted-transcript"',
    `source_sha256: "${crypto.randomBytes(32).toString('hex')}"`,
    `content_sha256: "${crypto.randomBytes(32).toString('hex')}"`,
    'source_member: "conversations-000.json"', 'source_index: 0',
    'source_ref: "conversations-000.json#0"', 'quarantined: false', 'redacted: 0',
    'omitted_branch_messages: 0', 'reasoning_excluded: 0', 'internal_channels_excluded: 0',
    'hidden_excluded: 0', 'other_roles_excluded: 0', 'attachments_omitted: 0',
    'unsupported_content_excluded: 0', 'off_branch_defects: 0', 'active_branch_nodes: 2', 'total_mapping_nodes: 2',
  ].join('\n');
  const note = `---\n${fm}\n---\n\n# Synthetic persistence calibration chat\n\n`
    + `> [!warning] Untrusted historical transcript\n\n## Visible active branch\n\n`
    + `**[user]** 2023-11-14T22:13:20Z\n\nHow do I calibrate the ZYNTHETIC-QUARTZ-PERSIST oscillator?`
    + `\n\n**[assistant]** 2023-11-14T22:13:40Z\n\nThe ZYNTHETIC-QUARTZ-PERSIST oscillator is calibrated weekly with the reference jig.\n`;
  fs.writeFileSync(path.join(historyDir, 'chatgpt-conv-persist-0001.md'), note, 'utf-8');
  fs.writeFileSync(path.join(historyDir, 'promote-manifest.json'), JSON.stringify({
    schema: 'chatgpt-promote-manifest/1', staging_manifest_digest: '0'.repeat(64),
    notes: {
      'chatgpt-conv-persist-0001.md': {
        rel: 'notes/chatgpt-conv-persist-0001.md', conversation_id: convId,
        note_sha256: crypto.createHash('sha256').update(note, 'utf-8').digest('hex'),
        staging_manifest_digest: '0'.repeat(64),
      },
    },
  }, null, 2), 'utf-8');
}

function validStoreWith(clients: unknown[]): string {
  return JSON.stringify({ schema: 'mvp-oauth-clients/1', clients });
}

function syntheticClientRecord(id: string): Record<string, unknown> {
  return {
    client_id: id, client_secret: `synthetic-secret-${id}`,
    redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'],
    token_endpoint_auth_method: 'client_secret_basic', client_id_issued_at: 1_700_000_000,
  };
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('CLIENT-PERSISTENCE: pending registration expiry', () => {
  it('keeps a pending registration at 9 minutes, removes it at 11 minutes, and never expires an approved registration', () => {
    const authStatePath = path.join(tmpdir0700('mvp-cp-auth-'), 'clients.json');
    const registry = new ClientRegistry(authStatePath);
    const createdAt = new Date('2026-10-13T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(createdAt);

    registry.add({ ...syntheticClientRecord('pending'), client_id_issued_at: createdAt.getTime() / 1000 } as any);
    registry.add({ ...syntheticClientRecord('approved'), client_id_issued_at: createdAt.getTime() / 1000 } as any);
    registry.approve('approved');

    vi.setSystemTime(new Date(createdAt.getTime() + 9 * 60_000));
    expect(registry.get('pending')?.client_id).toBe('pending');
    expect(registry.size).toBe(2);

    vi.setSystemTime(new Date(createdAt.getTime() + 11 * 60_000));
    expect(registry.get('pending')).toBeUndefined();
    expect(registry.get('approved')?.client_id).toBe('approved');
    expect(registry.size).toBe(1);
    expect(JSON.parse(fs.readFileSync(authStatePath, 'utf-8')).clients.map((client: { client_id: string }) => client.client_id))
      .toEqual(['approved']);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('CLIENT-PERSISTENCE: expiry never breaks reads', () => {
  it('drops an expired pending registration in memory when the store cannot be written, and does not throw', () => {
    const dir = tmpdir0700('mvp-cp-auth-');
    const registry = new ClientRegistry(path.join(dir, 'clients.json'));
    const createdAt = new Date('2026-10-13T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(createdAt);
    registry.add({ ...syntheticClientRecord('pending'), client_id_issued_at: createdAt.getTime() / 1000 } as any);
    fs.chmodSync(dir, 0o500);
    try {
      vi.setSystemTime(new Date(createdAt.getTime() + 11 * 60_000));
      expect(registry.get('pending')).toBeUndefined();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('CLIENT-PERSISTENCE: restart contract (register once, restart, re-authorize)', () => {
  it('CRITICAL: register once -> use tools -> restart from same store (no re-registration) -> same clientId/secret authorizes again and memory/history still work; old ticket/code replay fails', async () => {
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const authStatePath = path.join(authRoot, 'clients.json');
    const historyDir = tmpdir0700('mvp-cp-history-');
    writeSyntheticHistory(historyDir);

    // --- run 1: register ONCE and use everything
    const run1 = await bootService({ memoryDir, authStatePath, historyDir });
    const client = await registerClient(run1.app);
    const auth1 = await fullAuthorize(run1.app, client);
    expect(auth1.status).toBe(200);
    const saved = await mcpCall(run1.config, auth1.tokens.access_token, 'call', 'save_memory',
      { subject: 'PersistSubject', predicate: 'survives_restart', object: 'yes', source: 'chatgpt' });
    expect(saved.ok).toBe(true);
    const retrieved = await mcpCall(run1.config, auth1.tokens.access_token, 'call', 'retrieve_memory',
      { subject: 'PersistSubject' });
    expect(retrieved.facts.length).toBe(1);
    const search1 = await mcpCall(run1.config, auth1.tokens.access_token, 'call', 'search_history',
      { query: 'ZYNTHETIC-QUARTZ-PERSIST' });
    expect(search1.ok).toBe(true);
    expect(search1.results.length).toBeGreaterThanOrEqual(1);

    // capture a live ticket + code from run 1 for the replay assertions
    const { verifier: vOld, challenge: cOld } = pkce();
    const t1 = await getTicket(run1.app, client.clientId, client.redirectUri, cOld);
    expect(t1.ticket).toBeTruthy();
    const loginOld = await ownerLogin(run1.app, client, t1.ticket!);
    expect(loginOld.code).toBeTruthy();

    // the store on disk holds ONLY schema + clients (no tickets/codes/tokens)
    const rawStore = fs.readFileSync(authStatePath, 'utf-8');
    const parsedStore = JSON.parse(rawStore);
    expect(Object.keys(parsedStore).sort()).toEqual(['clients', 'schema']);
    expect(parsedStore.clients.length).toBe(1);
    expect(parsedStore.clients[0].client_id).toBe(client.clientId);
    expect(JSON.stringify(parsedStore)).not.toContain('ticket');
    expect(rawStore.includes(loginOld.code!)).toBe(false);
    // the store lives OUTSIDE the memory and history trees
    expect(authStatePath.startsWith(memoryDir)).toBe(false);
    expect(authStatePath.startsWith(historyDir)).toBe(false);

    // --- STOP the service, RESTART from the SAME store, DO NOT re-register
    run1.stop();
    const run2 = await bootService({ memoryDir, authStatePath, historyDir });

    // the SAME client authorizes again with a fresh ticket + PKCE
    const auth2 = await fullAuthorize(run2.app, client);
    expect(auth2.status).toBe(200);

    // memory and history still work after the restart
    const retrieved2 = await mcpCall(run2.config, auth2.tokens.access_token, 'call', 'retrieve_memory',
      { subject: 'PersistSubject' });
    expect(retrieved2.facts.length).toBe(1);
    expect(JSON.stringify(retrieved2)).toContain('survives_restart');
    const search2 = await mcpCall(run2.config, auth2.tokens.access_token, 'call', 'search_history',
      { query: 'ZYNTHETIC-QUARTZ-PERSIST' });
    expect(search2.ok).toBe(true);
    expect(search2.results.length).toBeGreaterThanOrEqual(1);
    // export returns [meta, raw ledger markdown]: the persisted fact must be
    // in the ledger bytes, and the OAuth registry must never surface in it
    const exportClient = new Client({ name: 'persistence-export-client', version: '0.1.0' });
    const exportTransport = new StreamableHTTPClientTransport(
      new URL(MVP_MCP_PATH, `http://127.0.0.1:${run2.config.port}`),
      { requestInit: { headers: { Authorization: `Bearer ${auth2.tokens.access_token}` } } },
    );
    await exportClient.connect(exportTransport);
    const exportRes = await exportClient.callTool({ name: 'export_memory', arguments: {} });
    await exportClient.close();
    const exportMeta = JSON.parse((exportRes.content as { text: string }[])[0].text);
    const exportLedger = (exportRes.content as { text: string }[])[1].text;
    expect(exportMeta.bytes).toBeGreaterThan(0);
    expect(exportLedger).toContain('PersistSubject');
    // the registry never surfaces in exports
    expect(exportLedger).not.toContain('client_secret');
    expect(exportLedger).not.toContain(path.basename(authStatePath));

    // old ticket replay on run 2 fails (tickets are not persisted: single-use, short-lived)
    const replayLogin = await request(run2.app).post('/mvp-login')
      .type('form').send({ ticket: t1.ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(replayLogin.status).toBe(403);
    // old code replay on run 2 fails (codes are not persisted either)
    const oldCodeExchange = await request(run2.app).post('/token').type('form').send({
      grant_type: 'authorization_code', code: loginOld.code, redirect_uri: client.redirectUri,
      client_id: client.clientId, client_secret: client.clientSecret, code_verifier: vOld,
    });
    expect(oldCodeExchange.status).toBeGreaterThanOrEqual(400);
  }, 120_000);

  it('unknown client_id is rejected at /authorize (no fabricated clients)', async () => {
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const authStatePath = path.join(tmpdir0700('mvp-cp-auth-'), 'clients.json');
    const svc = await bootService({ memoryDir, authStatePath });
    const { challenge } = pkce();
    const res = await request(svc.app).get('/authorize').query({
      client_id: 'totally-unknown-client-id', redirect_uri: LOOPBACK_CB, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain('ticket');
  });

  it('a persisted client whose callback was REMOVED from the allowlist cannot authorize after restart (current allowlist enforced)', async () => {
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const authStatePath = path.join(tmpdir0700('mvp-cp-auth-'), 'clients.json');
    const run1 = await bootService({ memoryDir, authStatePath });
    const client = await registerClient(run1.app);
    run1.stop();
    // restart with an EMPTY allowlist: the persisted client survives, but its
    // callback is no longer allowlisted, so fresh authorization is refused
    const run2 = await bootService({ memoryDir, authStatePath, allowlist: '' });
    const { challenge } = pkce();
    const res = await request(run2.app).get('/authorize').query({
      client_id: client.clientId, redirect_uri: client.redirectUri, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    });
    expect(res.status).toBe(403);
    expect(res.text).toContain('no longer allowlisted');
  });
});

/** Boots nothing: a store that is corrupt/unsafe must fail registry load. */
function expectStartupFails(authStatePath: string, memoryDir: string) {
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = authStatePath;
  process.env.MVP_BASE_URL = 'http://127.0.0.1:3471';
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_ALLOWED_CALLBACK_URIS = LOOPBACK_CB;
  delete process.env.MVP_HISTORY_DIR;
  const config = loadMvpConfig();
  let registryError: unknown = null;
  try {
    createMvpApp(config);
  } catch (err) {
    registryError = err;
  }
  expect(registryError).toBeInstanceOf(ClientRegistryError);
  expect((registryError as Error).message).toContain('not usable');
  // The store is checked before the index is opened: a refused start creates, migrates and holds no database (#1563).
  expect(fs.existsSync(config.dbPath)).toBe(false);
  return registryError as ClientRegistryError;
}

describe('CLIENT-PERSISTENCE: store integrity fails closed (never silently reset)', () => {

  it('refuses startup when a non-Windows platform has no POSIX user id', ({ skip }) => {
    if (process.platform === 'win32') skip('native Windows is covered by the next test');
    vi.spyOn(process, 'getuid').mockImplementation(() => undefined as never);
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const authStatePath = path.join(authRoot, 'clients.json');

    const error = expectStartupFails(authStatePath, tmpdir0700('mvp-cp-memory-'));
    expect(error.message).toContain('process uid is unavailable on this platform');
  });

  it('native Windows (no getuid) skips the owner checks and starts', () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const realGetuid = process.getuid;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    // simulate Windows, where the function does not exist
    (process as { getuid?: unknown }).getuid = undefined;
    try {
      const authRoot = tmpdir0700('mvp-cp-auth-');
      const registry = new ClientRegistry(path.join(authRoot, 'clients.json'));
      expect(registry).toBeInstanceOf(ClientRegistry);
      // a missing store directory is still refused
      expect(() => new ClientRegistry(path.join(authRoot, 'nope', 'clients.json'))).toThrow(ClientRegistryError);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      (process as { getuid?: unknown }).getuid = realGetuid;
    }
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('corrupt JSON store fails closed at startup', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    fs.writeFileSync(p, '{not valid json', { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('valid JSON but wrong schema version fails closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    fs.writeFileSync(p, JSON.stringify({ schema: 'mvp-oauth-clients/2', clients: [] }), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a store written by the live ChatGPT connector (response_types present) loads fine; still-unknown fields fail closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    fs.writeFileSync(p, validStoreWith([
      {
        client_id: 'synthetic-live-shape', client_name: 'Synthetic connector client',
        redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'client_secret_basic',
        client_id_issued_at: 1_700_000_000, scope: 'memory', client_secret: 'synthetic-secret',
        client_secret_expires_at: 0,
      },
    ]), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    // config-level validation passes, registry loads (no throw)
    process.env.MVP_MEMORY_DIR = tmpdir0700('mvp-cp-memory-');
    process.env.MVP_AUTH_STATE_PATH = p;
    process.env.MVP_BASE_URL = 'http://127.0.0.1:3471';
    process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
    process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
    process.env.MVP_ALLOWED_CALLBACK_URIS = LOOPBACK_CB;
    delete process.env.MVP_HISTORY_DIR;
    let threw: unknown = null;
    try { createMvpApp(loadMvpConfig()); } catch (err) { threw = err; }
    expect(threw).toBeNull();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('unknown top-level or client fields fail closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    fs.writeFileSync(p, JSON.stringify({ schema: 'mvp-oauth-clients/1', clients: [], extra: 1 }), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('symlink store file fails closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const target = path.join(authRoot, 'real.json');
    fs.writeFileSync(target, validStoreWith([]), { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    const p = path.join(authRoot, 'clients.json');
    fs.symlinkSync(target, p);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('symlinked store DIRECTORY fails closed', () => {
    const realRoot = tmpdir0700('mvp-cp-real-');
    const linkRoot = tmpdir0700('mvp-cp-link-'); // 0700, holds the symlink
    fs.rmSync(linkRoot, { recursive: true, force: true });
    tmpDirs.splice(tmpDirs.indexOf(linkRoot), 1);
    const dirWithLink = tmpdir0700('mvp-cp-holder-');
    fs.symlinkSync(realRoot, path.join(dirWithLink, 'authroot'));
    expectStartupFails(path.join(dirWithLink, 'authroot', 'clients.json'), tmpdir0700('mvp-cp-memory-'));
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('group/world-readable store file (0644) fails closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    fs.writeFileSync(p, validStoreWith([]));
    fs.chmodSync(p, 0o644);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('group/world-accessible store directory (0755) fails closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    fs.chmodSync(authRoot, 0o755);
    expectStartupFails(path.join(authRoot, 'clients.json'), tmpdir0700('mvp-cp-memory-'));
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('store exceeding the bounded client limit fails closed (not trimmed)', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    const many = Array.from({ length: 101 }, (_, i) => syntheticClientRecord(`bulk-${i}`));
    fs.writeFileSync(p, validStoreWith(many), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a valid store at the bound still boots, and further registration is refused (store bound)', async () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    const many = Array.from({ length: 100 }, (_, i) => syntheticClientRecord(`bulk-${i}`));
    fs.writeFileSync(p, validStoreWith(many), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    const svc = await bootService({ memoryDir: tmpdir0700('mvp-cp-memory-'), authStatePath: p });
    const res = await request(svc.app).post('/register')
      .send({ client_name: 'over-bound', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });
});

describe('CLIENT-PERSISTENCE: disk-first registration and I/O failure', () => {
  it.skipIf(HTTP_SERVER_UNSUPPORTED)('failed disk write acknowledges NO client (not even in memory)', async ({ skip }) => {
    if (process.getuid?.() === 0) skip('requires a non-root process so directory permissions deny writes');
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const svc = await bootService({ memoryDir, authStatePath: p });
    fs.chmodSync(authRoot, 0o500); // owner r-x: reads fine, writes fail (still owner-only)
    const res = await request(svc.app).post('/register')
      .send({ client_name: 'io-fail-client', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    fs.chmodSync(authRoot, 0o700);
    expect(res.status).toBe(500);            // ServerError: persist failed
    expect(res.body.error).toBe('server_error');
    const attemptedId = res.body.client_id; // never echoed anyway
    expect(attemptedId).toBeUndefined();
    // no store file was created => the failed client cannot authorize
    expect(fs.existsSync(p)).toBe(false);
    const { challenge } = pkce();
    // even a guessed/known client_id from a failed write is unknown:
    const probe = await request(svc.app).get('/authorize').query({
      client_id: 'guessed-after-io-failure', redirect_uri: LOOPBACK_CB, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    });
    expect(probe.status).toBeGreaterThanOrEqual(400);
    // after the store becomes writable again, registration works
    const ok = await request(svc.app).post('/register')
      .send({ client_name: 'recovers', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    expect(ok.status).toBe(201);
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('registration audit output contains no secrets or full client identifiers', async () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const svc = await bootService({ memoryDir, authStatePath: path.join(authRoot, 'clients.json') });
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const reg = await request(svc.app).post('/register')
      .send({ client_name: 'audit-check', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    expect(reg.status).toBe(201);
    const logged = lines.join('\n');
    expect(logged).not.toContain(reg.body.client_secret);
    expect(logged).not.toContain(reg.body.client_id);
    expect(logged).toContain('dcr_ok'); // metadata-only audit still fires
  });

  it('MVP_AUTH_STATE_PATH inside the memory dir, inside the history dir, or a Markdown file is rejected at config time', () => {
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const historyDir = tmpdir0700('mvp-cp-history-');
    process.env.MVP_MEMORY_DIR = memoryDir;
    process.env.MVP_HISTORY_DIR = historyDir;
    process.env.MVP_BASE_URL = 'http://127.0.0.1:3471';
    process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
    process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
    process.env.MVP_ALLOWED_CALLBACK_URIS = LOOPBACK_CB;
    process.env.MVP_AUTH_STATE_PATH = path.join(memoryDir, 'clients.json');
    expect(() => loadMvpConfig()).toThrow(/MVP_AUTH_STATE_PATH must not be inside the fact memory directory/);
    process.env.MVP_AUTH_STATE_PATH = path.join(historyDir, 'clients.json');
    expect(() => loadMvpConfig()).toThrow(/MVP_AUTH_STATE_PATH must not be equal to or overlap the promoted history directory/);
    process.env.MVP_AUTH_STATE_PATH = '/tmp/somewhere/clients.md';
    expect(() => loadMvpConfig()).toThrow(/MVP_AUTH_STATE_PATH must not be a Markdown file/);
    process.env.MVP_AUTH_STATE_PATH = '';
    expect(() => loadMvpConfig()).toThrow(/Missing required configuration MVP_AUTH_STATE_PATH/);
  });

  it('missing auth-state directory fails closed at startup (operator must create it 0700)', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const missing = path.join(authRoot, 'missing-dir', 'clients.json');
    expectStartupFails(missing, tmpdir0700('mvp-cp-memory-'));
  });
});


describe.skipIf(HTTP_SERVER_UNSUPPORTED)('CLIENT-PERSISTENCE: the path to the store directory may cross a root-owned symlink only where nobody but root and the service user can change it', () => {
  // macOS reaches its per-user temp directory through /var, a symlink to private/var that root owns, so a store kept
  // there is reached through a symlink. A test cannot make a file that root owns, so `lstatReports` has lstat say what
  // the platform says for the paths a test names; the symlinks, the directories and the writes through them are real.
  // `rootChain` does the same for the directories above a fixture, so no test depends on what the machine under test
  // keeps in /tmp or /dev/shm. The one test that needs no pretence runs on macOS only.
  const realLstat = fs.lstatSync;
  const SERVICE_UID = process.getuid?.() ?? 0; // the uid the registry runs as
  const STRANGER_UID = SERVICE_UID === 4242 ? 4243 : 4242; // neither root nor the service user
  const LINK = fs.constants.S_IFLNK;
  const DIR = fs.constants.S_IFDIR;
  type Report = { uid: number; mode: number };
  const ROOT_LINK: Report = { uid: 0, mode: LINK | 0o755 }; // ls -l /var on macOS: lrwxr-xr-x, root
  const ROOT_DIR: Report = { uid: 0, mode: DIR | 0o755 }; // ls -ld /private/var on macOS: drwxr-xr-x, root
  const GROUP_WRITABLE = DIR | 0o775;
  const OTHER_WRITABLE = DIR | 0o757;
  const STICKY_WORLD_WRITABLE = DIR | 0o1777; // ls -ld /tmp: drwxrwxrwt
  const RULE = 'store directory must not contain symlinks';
  const NOT_TRUSTED = 'a directory on its path is not owned by root or the service user';
  const WRITABLE = 'a directory on its path is writable by group or other';

  /** `dir` and every directory above it, as root's and closed to group and other. */
  function rootChain(dir: string): Record<string, Report> {
    const chain: Record<string, Report> = {};
    for (let at = dir; ; at = path.dirname(at)) {
      chain[at] = ROOT_DIR;
      if (at === path.dirname(at)) break;
    }
    return chain;
  }

  /** <base>/real/auth is the store directory (0700) and <base>/link leads to <base>/real. All of it is a real path. */
  function linkedStore(kind: 'relative' | 'absolute' | 'climbing' = 'relative') {
    const base = fs.realpathSync(tmpdir0700('mvp-cp-link-'));
    const target = path.join(base, 'real');
    fs.mkdirSync(path.join(target, 'auth'), { recursive: true });
    fs.chmodSync(path.join(target, 'auth'), 0o700);
    const holder = kind === 'climbing' ? path.join(base, 'sub') : base;
    fs.mkdirSync(holder, { recursive: true });
    const link = path.join(holder, 'link');
    // macOS: /var -> private/var, a relative target
    fs.symlinkSync({ relative: 'real', absolute: target, climbing: path.join('..', 'real') }[kind], link);
    // Root's, as on a platform where root made the link and the directories it leads through.
    const chain = { ...rootChain(holder), [target]: ROOT_DIR };
    return { base, target, link, chain, storePath: path.join(link, 'auth', 'clients.json') };
  }

  function lstatReports(reports: Record<string, Report>): void {
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike) => {
      const stat = realLstat(target);
      const report = reports[String(target)];
      return report ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, report) : stat;
    }) as unknown as typeof fs.lstatSync);
  }

  function refusal(storePath: string): ClientRegistryError {
    try {
      new ClientRegistry(storePath);
    } catch (err) {
      expect(err).toBeInstanceOf(ClientRegistryError);
      return err as ClientRegistryError;
    }
    throw new Error('the registry opened a store it must refuse');
  }

  function newClient(id: string): any {
    return { ...syntheticClientRecord(id), client_id_issued_at: Math.floor(Date.now() / 1000) };
  }

  it('says that a symlink is the reason, and not that the directory "could not be resolved"', () => {
    const { base, chain, storePath } = linkedStore();
    lstatReports(chain); // the link itself is the real one: lrwxrwxrwx on Linux, and not root's wherever a test makes it
    const error = refusal(storePath);
    expect(error.message).toContain(RULE);
    expect(error.message).toContain('a symlink on its path');
    expect(error.message).not.toContain('could not be resolved');
    // The message reaches the /register response, so it names no path.
    expect(error.message).not.toContain(base);
  });

  it.each(['relative', 'absolute', 'climbing'] as const)('opens a store behind a root-owned symlink with a %s target, to a root-owned directory that group and other cannot write: the macOS /var shape', (kind) => {
    const { target, link, chain, storePath } = linkedStore(kind);
    lstatReports({ ...chain, [link]: ROOT_LINK });
    const registry = new ClientRegistry(storePath);
    registry.add(newClient('behind-link'));
    // The write went through the link into the real directory, and a restart reads it back through the link.
    const stored = JSON.parse(fs.readFileSync(path.join(target, 'auth', 'clients.json'), 'utf-8'));
    expect(stored.clients.map((client: { client_id: string }) => client.client_id)).toEqual(['behind-link']);
    expect(new ClientRegistry(storePath).get('behind-link')?.client_id).toBe('behind-link');
  });

  it.each<[string, { link: Report; target: Report }, string]>([
    ['a symlink another user owns', { link: { ...ROOT_LINK, uid: STRANGER_UID }, target: ROOT_DIR },
      'a symlink on its path is not owned by root'],
    ['a root-owned symlink that group and other can write (Linux reports every link as lrwxrwxrwx)',
      { link: { ...ROOT_LINK, mode: LINK | 0o777 }, target: ROOT_DIR }, 'a symlink on its path is writable by group or other'],
    ['a root-owned symlink to a directory another user owns',
      { link: ROOT_LINK, target: { ...ROOT_DIR, uid: STRANGER_UID } }, 'leads to a directory that is not owned by root'],
    ['a root-owned symlink to a directory group can write',
      { link: ROOT_LINK, target: { ...ROOT_DIR, mode: GROUP_WRITABLE } }, 'leads to a directory that is writable by group or other'],
    ['a root-owned symlink to a sticky directory other can write (/tmp on macOS is drwxrwxrwt)',
      { link: ROOT_LINK, target: { ...ROOT_DIR, mode: STICKY_WORLD_WRITABLE } }, 'leads to a directory that is writable by group or other'],
  ])('refuses %s, and says which', (_name, reports, reason) => {
    const { base, target, link, chain, storePath } = linkedStore();
    lstatReports({ ...chain, [link]: reports.link, [target]: reports.target });
    const error = refusal(storePath);
    expect(error.message).toContain(RULE);
    expect(error.message).toContain(reason);
    expect(error.message).not.toContain(base);
    expect(fs.existsSync(path.join(target, 'auth', 'clients.json'))).toBe(false);
  });

  it('judges every link on the way, not only the first: one that leads through a link it does not trust is refused', () => {
    const { base, link, chain } = linkedStore(); // <base>/link -> real
    const first = path.join(base, 'first');
    fs.symlinkSync('link', first); // <base>/first -> link -> real
    const storePath = path.join(first, 'auth', 'clients.json');
    lstatReports({ ...chain, [first]: ROOT_LINK, [link]: { ...ROOT_LINK, uid: STRANGER_UID } });
    expect(refusal(storePath).message).toContain('a symlink on its path is not owned by root');
    lstatReports({ ...chain, [first]: ROOT_LINK, [link]: ROOT_LINK });
    expect(new ClientRegistry(storePath).size).toBe(0);
  });

  it('still holds the store directory itself to 0700 and to its owner, however it is reached', () => {
    const { target, link, chain, storePath } = linkedStore();
    lstatReports({ ...chain, [link]: ROOT_LINK });
    fs.chmodSync(path.join(target, 'auth'), 0o755);
    expect(refusal(storePath).message).toContain('store directory must be owner-only (0700)');
    fs.chmodSync(path.join(target, 'auth'), 0o700);
    vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
    expect(refusal(storePath).message).toContain('store directory is not owned by the service user');
  });

  it('refuses a store directory that is itself a symlink, even one root owns', () => {
    const { target, link } = linkedStore();
    fs.symlinkSync('auth', path.join(target, 'store-link'));
    const store = path.join(link, 'store-link');
    lstatReports({ [link]: ROOT_LINK, [target]: ROOT_DIR, [store]: ROOT_LINK });
    expect(refusal(path.join(store, 'clients.json')).message).toContain('store path parent is not a directory');
  });

  it('says why a path cannot be resolved', () => {
    const { storePath } = linkedStore();
    vi.spyOn(fs, 'realpathSync').mockImplementation((() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }) as unknown as typeof fs.realpathSync);
    expect(refusal(storePath).message).toContain('store directory could not be resolved (EACCES)');
  });

  it('stops following links after a bounded number, so a path that keeps leading back to itself ends', () => {
    const { link, chain, storePath } = linkedStore();
    lstatReports({ ...chain, [link]: ROOT_LINK });
    vi.spyOn(fs, 'readlinkSync').mockImplementation((() => link) as unknown as typeof fs.readlinkSync); // the link now leads to itself
    expect(refusal(storePath).message).toContain('its path crosses too many symlinks');
  });

  it('refuses a path that its own walk and the kernel resolve to different places', () => {
    const { base, link, chain, storePath } = linkedStore();
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(path.join(elsewhere, 'auth'), { recursive: true, mode: 0o700 });
    lstatReports({ ...chain, [link]: ROOT_LINK, [elsewhere]: ROOT_DIR });
    vi.spyOn(fs, 'readlinkSync').mockImplementation((() => 'elsewhere') as unknown as typeof fs.readlinkSync);
    expect(refusal(storePath).message).toContain('store directory could not be resolved consistently');
  });

  // The bypass the review found: every link was judged, and the directory a link leads to, but the ordinary directories
  // around them were not. A link is only as safe as the directory it sits in, and a target only as safe as every
  // directory on the way to it, because whoever can write one of those can rename or replace what the check looked at.
  describe('every directory the path goes through, not only the links', () => {
    // macOS's own shape under one base that stands for "/": <base>/var is a root-owned link to private/var, and the store
    // directory is <base>/private/var/folders/T/auth, as /var/folders/<xx>/<hash>/T/<store> is there. "private" appears
    // only in the link's target, never in the path the operator wrote. `trusted` is root's down to `folders`, as on a
    // Mac; `T` is the service user's own.
    function macStore(kind: 'relative' | 'absolute' = 'relative') {
      const base = fs.realpathSync(tmpdir0700('mvp-cp-mac-'));
      const dirs = {
        root: path.parse(base).root,
        outer: path.dirname(base), // the directory that holds the base
        base,
        private: path.join(base, 'private'),
        target: path.join(base, 'private', 'var'),
        folders: path.join(base, 'private', 'var', 'folders'),
        temp: path.join(base, 'private', 'var', 'folders', 'T'),
      };
      fs.mkdirSync(path.join(dirs.temp, 'auth'), { recursive: true, mode: 0o755 });
      fs.chmodSync(path.join(dirs.temp, 'auth'), 0o700);
      const link = path.join(base, 'var');
      fs.symlinkSync(kind === 'relative' ? path.join('private', 'var') : dirs.target, link);
      return {
        ...dirs,
        link,
        trusted: { ...rootChain(dirs.folders), [link]: ROOT_LINK },
        storePath: path.join(link, 'folders', 'T', 'auth', 'clients.json'),
      };
    }
    type Mac = ReturnType<typeof macStore>;

    it('opens the macOS shape when root and the service user own every directory on the path and group and other cannot write them', () => {
      const m = macStore();
      lstatReports(m.trusted);
      const registry = new ClientRegistry(m.storePath);
      registry.add(newClient('behind-var'));
      const stored = JSON.parse(fs.readFileSync(path.join(m.temp, 'auth', 'clients.json'), 'utf-8'));
      expect(stored.clients.map((client: { client_id: string }) => client.client_id)).toEqual(['behind-var']);
      expect(new ClientRegistry(m.storePath).get('behind-var')?.client_id).toBe('behind-var');
    });

    it.each<[string, (m: Mac) => Record<string, Report>]>([
      ['/private owned by the service user, which only the service user can change', m => ({ [m.private]: { ...ROOT_DIR, uid: SERVICE_UID } })],
      ['a directory below the link target owned by the service user, as /var/folders/<xx>/<hash> is', m => ({ [m.folders]: { ...ROOT_DIR, uid: SERVICE_UID } })],
      ['the directory above the link owned by the service user, as a home directory is', m => ({ [m.outer]: { ...ROOT_DIR, uid: SERVICE_UID } })],
      ['a sticky world-writable directory above the link that root owns, for an entry that root owns', m => ({ [m.outer]: { ...ROOT_DIR, mode: STICKY_WORLD_WRITABLE } })],
      ['the link itself in a sticky world-writable directory that root owns, as /tmp is: only root may rename or remove it', m => ({ [m.base]: { ...ROOT_DIR, mode: STICKY_WORLD_WRITABLE } })],
    ])('still opens it with %s', (_name, change) => {
      const m = macStore();
      lstatReports({ ...m.trusted, ...change(m) });
      expect(new ClientRegistry(m.storePath).size).toBe(0);
    });

    it.each<[string, (m: Mac) => Record<string, Report>, string]>([
      // The directory that holds the link: whoever can write it can rename the link away and put another there.
      ['the directory that holds the link is writable by group', m => ({ [m.base]: { ...ROOT_DIR, mode: GROUP_WRITABLE } }), WRITABLE],
      ['the directory that holds the link is writable by other', m => ({ [m.base]: { ...ROOT_DIR, mode: OTHER_WRITABLE } }), WRITABLE],
      ['the directory that holds the link belongs to another user', m => ({ [m.base]: { ...ROOT_DIR, uid: STRANGER_UID } }), NOT_TRUSTED],
      // /private holds the link target and is in no path the operator wrote, only in the link.
      ['/private, which only the link names, is writable by group', m => ({ [m.private]: { ...ROOT_DIR, mode: GROUP_WRITABLE } }), WRITABLE],
      ['/private, which only the link names, is writable by other', m => ({ [m.private]: { ...ROOT_DIR, mode: OTHER_WRITABLE } }), WRITABLE],
      ['/private, which only the link names, belongs to another user', m => ({ [m.private]: { ...ROOT_DIR, uid: STRANGER_UID } }), NOT_TRUSTED],
      // Below the target.
      ['a directory below the link target is writable by other', m => ({ [m.folders]: { ...ROOT_DIR, mode: OTHER_WRITABLE } }), WRITABLE],
      ['a directory below the link target belongs to another user', m => ({ [m.folders]: { ...ROOT_DIR, uid: STRANGER_UID } }), NOT_TRUSTED],
      ['the directory that holds the store directory is writable by group', m => ({ [m.temp]: { uid: SERVICE_UID, mode: GROUP_WRITABLE } }), WRITABLE],
      ['the directory that holds the store directory belongs to another user', m => ({ [m.temp]: { uid: STRANGER_UID, mode: DIR | 0o755 } }), NOT_TRUSTED],
      // Above the link.
      ['a directory above the link is writable by other and not sticky', m => ({ [m.outer]: { ...ROOT_DIR, mode: OTHER_WRITABLE } }), WRITABLE],
      ['a directory above the link belongs to another user', m => ({ [m.outer]: { ...ROOT_DIR, uid: STRANGER_UID } }), NOT_TRUSTED],
      ['the root of the file system belongs to another user', m => ({ [m.root]: { ...ROOT_DIR, uid: STRANGER_UID } }), NOT_TRUSTED],
      // The sticky bit keeps others from renaming an entry that root owns, and from nothing else.
      ['a sticky world-writable directory above the link holds an entry another user owns', m => ({ [m.outer]: { ...ROOT_DIR, mode: STICKY_WORLD_WRITABLE }, [m.base]: { ...ROOT_DIR, uid: STRANGER_UID } }), WRITABLE],
      ['a sticky world-writable directory above the link belongs to another user', m => ({ [m.outer]: { uid: STRANGER_UID, mode: STICKY_WORLD_WRITABLE } }), NOT_TRUSTED],
    ])('refuses it when %s, and says which', (_name, change, reason) => {
      const m = macStore();
      lstatReports({ ...m.trusted, ...change(m) });
      const error = refusal(m.storePath);
      expect(error.message).toContain(RULE);
      expect(error.message).toContain(reason);
      expect(error.message).not.toContain(m.base); // the message reaches /register, so it names no path
      expect(fs.existsSync(path.join(m.temp, 'auth', 'clients.json'))).toBe(false);
    });

    // Only root's own entry is safe in a directory that others can write. The service user's is safe from them too, but
    // the rule stays the narrow one: nothing here needs more.
    it.skipIf(SERVICE_UID === 0)('refuses it when a sticky world-writable directory above the link holds an entry the service user owns', () => {
      const m = macStore();
      lstatReports({ ...m.trusted, [m.outer]: { ...ROOT_DIR, mode: STICKY_WORLD_WRITABLE }, [m.base]: { uid: SERVICE_UID, mode: DIR | 0o755 } });
      const error = refusal(m.storePath);
      expect(error.message).toContain(WRITABLE);
      expect(error.message).not.toContain(m.base);
    });

    it.each<[string, (m: Mac) => Record<string, Report>, string]>([
      ['writable by group', m => ({ [m.private]: { ...ROOT_DIR, mode: GROUP_WRITABLE } }), WRITABLE],
      ['owned by another user', m => ({ [m.private]: { ...ROOT_DIR, uid: STRANGER_UID } }), NOT_TRUSTED],
    ])('judges the directories an ABSOLUTE link target goes through as well: /private %s', (_name, change, reason) => {
      const m = macStore('absolute');
      lstatReports({ ...m.trusted, ...change(m) });
      const error = refusal(m.storePath);
      expect(error.message).toContain(reason);
      expect(error.message).not.toContain(m.base);
    });

    it('judges the path again before every write: a directory that stops being trusted while the service runs ends registration and approval, and nothing is written', () => {
      const m = macStore();
      lstatReports(m.trusted);
      const registry = new ClientRegistry(m.storePath);
      registry.add(newClient('before'));
      const file = path.join(m.temp, 'auth', 'clients.json');
      const written = fs.readFileSync(file, 'utf-8');
      lstatReports({ ...m.trusted, [m.private]: { ...ROOT_DIR, mode: GROUP_WRITABLE } });
      expect(() => registry.add(newClient('after'))).toThrow(WRITABLE);
      expect(() => registry.approve('before')).toThrow(WRITABLE);
      expect(fs.readFileSync(file, 'utf-8')).toBe(written);
      expect(registry.get('after')).toBeUndefined();
    });

    it('over HTTP: a directory that stops being trusted ends registration with the reason, no path, and nothing written', async () => {
      const m = macStore();
      lstatReports(m.trusted);
      const svc = await bootService({ memoryDir: tmpdir0700('mvp-cp-memory-'), authStatePath: m.storePath });
      lstatReports({ ...m.trusted, [m.private]: { ...ROOT_DIR, uid: STRANGER_UID } });
      const res = await request(svc.app).post('/register')
        .send({ client_name: 'untrusted-ancestor', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('server_error');
      expect(res.body.error_description).toContain(RULE);
      expect(res.body.error_description).toContain(NOT_TRUSTED);
      expect(res.body.error_description).not.toContain(m.base);
      expect(fs.existsSync(path.join(m.temp, 'auth', 'clients.json'))).toBe(false);
    });
  });

  it('a store directory swapped for a symlink while the service runs: registration is refused with the reason, no path, and nothing is written', async () => {
    const outer = tmpdir0700('mvp-cp-outer-');
    fs.mkdirSync(path.join(outer, 'auth'), { mode: 0o700 });
    const svc = await bootService({ memoryDir: tmpdir0700('mvp-cp-memory-'), authStatePath: path.join(outer, 'auth', 'clients.json') });
    const moved = `${outer}-moved`;
    tmpDirs.push(moved);
    fs.renameSync(outer, moved);
    fs.symlinkSync(moved, outer);
    const res = await request(svc.app).post('/register')
      .send({ client_name: 'swapped-root', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body.error_description).toContain(RULE);
    expect(res.body.error_description).not.toContain(outer);
    expect(res.body.error_description).not.toContain(moved);
    expect(fs.existsSync(path.join(moved, 'auth', 'clients.json'))).toBe(false);
  });

  // The real thing, with nothing pretended: where the platform temp directory is /var/folders/..., the store spelled
  // through /var crosses the system's own symlink, and every directory on the way is the system's own as well. When it
  // is refused, the failure lists who owns what on the real path, so a surprise on a runner can be read from its log.
  it.runIf(process.platform === 'darwin')('opens a store directory spelled through the real /var symlink of macOS', ({ skip }) => {
    const real = fs.realpathSync(tmpdir0700('mvp-cp-var-'));
    if (!real.startsWith('/private/var/')) skip('the temp directory is not under /private/var');
    const spelled = real.slice('/private'.length);
    expect(fs.realpathSync(spelled)).toBe(real);
    expect(spelled).not.toBe(real);
    const storePath = path.join(spelled, 'clients.json');
    const owners = ['/var', ...Object.keys(rootChain(real)).reverse()]
      .map((at) => { const st = fs.lstatSync(at); return `${at} uid=${st.uid} mode=${(st.mode & 0o7777).toString(8)}${st.isSymbolicLink() ? ' (symlink)' : ''}`; });
    let registry: ClientRegistry;
    try {
      registry = new ClientRegistry(storePath);
    } catch (err) {
      throw new Error(`${(err as Error).message}\nservice uid=${process.getuid?.()}\n${owners.join('\n')}`);
    }
    registry.add(newClient('behind-var'));
    expect(new ClientRegistry(storePath).get('behind-var')?.client_id).toBe('behind-var');
    expect(JSON.parse(fs.readFileSync(path.join(real, 'clients.json'), 'utf-8')).clients).toHaveLength(1);
  });
});
