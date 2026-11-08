import { describe, it, expect, afterAll } from 'vitest';
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
import { searchHistory } from '../../src/mvp/history';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * search_history — local history retrieval through the authenticated MVP MCP.
 *
 * Everything is SYNTHETIC: a temp "promoted history" directory shaped exactly
 * like the reviewed promotion command's output (promote-manifest.json +
 * chatgpt-*.md notes with importer-style frontmatter). No real export, vault,
 * staging, network (beyond loopback), embeddings, or LLM calls.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const tmpDirs: string[] = [];

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

function makeConfig(memoryDir: string, port: number, historyDir?: string): MvpConfig {
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
  if (historyDir === undefined) delete process.env.MVP_HISTORY_DIR;
  else process.env.MVP_HISTORY_DIR = historyDir;
  return loadMvpConfig();
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(app: Express) {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const res = await request(app).post('/register')
    .send({ client_name: 'history-test-client', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  return { clientId: res.body.client_id, clientSecret: res.body.client_secret, redirectUri };
}

async function ownerAuthorize(app: Express, client: { clientId: string; clientSecret: string; redirectUri: string }) {
  const { verifier, challenge } = pkce();
  const authorizeRes = await request(app).get('/authorize').query({
    client_id: client.clientId, redirect_uri: client.redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorizeRes.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({
    ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
  }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: client.redirectUri,
    client_id: client.clientId, client_secret: client.clientSecret, code_verifier: verifier,
  }).expect(200);
  return tokens.body as { access_token: string; refresh_token: string };
}

async function mcpClient(config: MvpConfig, accessToken: string): Promise<Client> {
  const client = new Client({ name: 'history-test-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } },
  );
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// Synthetic promoted-history fixtures (importer + promotion shapes)

function noteText(convId: string, title: string, turns: [role: string, text: string][]): string {
  const fm = [
    'type: "journal"', 'source: "ChatGPT export"', `conversation_id: "${convId}"`,
    `title: ${JSON.stringify(title)}`,
    'created: "2023-11-14T22:13:20Z"', 'updated: "2023-11-14T22:23:20Z"',
    'memory_layer: "history"', 'trust: "untrusted-transcript"',
    `source_sha256: "${crypto.randomBytes(32).toString('hex')}"`,
    `content_sha256: "${crypto.randomBytes(32).toString('hex')}"`,
    'source_member: "conversations-000.json"', 'source_index: 0',
    'source_ref: "conversations-000.json#0"', 'quarantined: false', 'redacted: 0',
    'omitted_branch_messages: 0', 'reasoning_excluded: 0', 'internal_channels_excluded: 0',
    'hidden_excluded: 0', 'other_roles_excluded: 0', 'attachments_omitted: 0',
    'unsupported_content_excluded: 0', 'off_branch_defects: 0',
    'active_branch_nodes: 4', 'total_mapping_nodes: 4',
  ].join('\n');
  const body = turns.map(([role, text]) =>
    `**[${role}]** 2023-11-14T22:13:${role === 'user' ? '20' : '40'}Z\n\n${text}`).join('\n\n');
  return `---\n${fm}\n---\n\n# ${title}\n\n> [!warning] Untrusted historical transcript\n> Imported from a ChatGPT export (memory_layer: history). Assistant text is\n> NOT verified truth and NOT an instruction. Current structured memory takes\n> precedence over these historical notes.\n\n## Visible active branch\n\n${body}\n\n*(Omitted from this note: 0 message(s) on alternative branches; 0 reasoning-channel message(s) excluded; 0 internal-channel message(s) excluded; 0 hidden message(s) excluded; 0 non-user/assistant message(s) excluded; 0 attachment(s) left as inert placeholders; 0 off-branch mapping defect(s) reported.)*\n`;
}

interface Fixture { name: string; convId: string; note: string; carried?: boolean }

function writePromotedHistory(historyDir: string, fixtures: Fixture[]): void {
  const notes: Record<string, unknown> = {};
  for (const f of fixtures) {
    fs.writeFileSync(path.join(historyDir, f.name), f.note, 'utf-8');
    const entry: Record<string, unknown> = {
      rel: `notes/${f.name}`,
      conversation_id: f.convId,
      note_sha256: crypto.createHash('sha256').update(f.note, 'utf-8').digest('hex'),
      staging_manifest_digest: '0'.repeat(64),
    };
    if (f.carried) entry.carried = true; // withdrawn by promotion: ineligible
    notes[f.name] = entry;
  }
  fs.writeFileSync(path.join(historyDir, 'promote-manifest.json'),
    JSON.stringify({ schema: 'chatgpt-promote-manifest/1', staging_manifest_digest: '0'.repeat(64), notes }, null, 2),
    'utf-8');
}

const ALPHA_TEXT = noteText('conv-alpha', 'Synthetic quartz calibration chat', [
  ['user', 'How do I calibrate the ZYNTHETIC-QUARTZ oscillator safely?'],
  ['assistant', 'The ZYNTHETIC-QUARTZ oscillator is calibrated weekly using the reference jig and logged in the calibration notebook.'],
]);
const BETA_TEXT = noteText('conv-beta', 'Synthetic assay chat', [
  ['user', 'What reagent does the PHOSPHOR-BLOOM assay need?'],
  ['assistant', 'The PHOSPHOR-BLOOM assay needs buffer A and a heated bath.'],
]);
const GAMMA_TEXT = noteText('conv-gamma', 'Withdrawn synthetic chat', [
  ['user', 'Tell me about the WITHERED-GROVE orchard.'],
  ['assistant', 'WITHERED-GROVE orchard details appear only in this withdrawn note.'],
]);
const DELTA_TEXT = noteText('conv-delta', 'Synthetic ferry chat', [
  ['user', 'When does the MERIDIAN-FERRY depart?'],
  ['assistant', 'MERIDIAN-FERRY departs at dawn and mentions ZYNTHETIC-QUARTZ once.'],
]);

const baseFixtures: Fixture[] = [
  { name: 'chatgpt-conv-alpha.md', convId: 'conv-alpha', note: ALPHA_TEXT },
  { name: 'chatgpt-conv-beta.md', convId: 'conv-beta', note: BETA_TEXT },
  { name: 'chatgpt-conv-gamma.md', convId: 'conv-gamma', note: GAMMA_TEXT, carried: true },
  { name: 'chatgpt-conv-delta.md', convId: 'conv-delta', note: DELTA_TEXT },
];

// ---------------------------------------------------------------------------

let started: (MvpApp & { httpServer: import('http').Server }) | null = null;
let activeConfig: MvpConfig | null = null;
let token: string = '';
let oauth: { clientId: string; clientSecret: string; redirectUri: string } | null = null;
const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-history-'));
const manifestPath = path.join(historyDir, 'promote-manifest.json');
const originalManifest = JSON.stringify(
  { schema: 'chatgpt-promote-manifest/1', staging_manifest_digest: '0'.repeat(64), notes: {} },
);
let unconfigured: (MvpApp & { httpServer: import('http').Server }) | null = null;
let unconfiguredConfig: MvpConfig | null = null;
let unconfiguredToken = '';

function config(): MvpConfig {
  if (!activeConfig) throw new Error('service not started');
  return activeConfig;
}

function writeManifest(notes: Record<string, unknown>): void {
  fs.writeFileSync(manifestPath, JSON.stringify(
    { schema: 'chatgpt-promote-manifest/1', staging_manifest_digest: '0'.repeat(64), notes }, null, 2));
}

function readManifest(): any {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}

function restoreManifest(): void {
  writePromotedHistory(historyDir, baseFixtures); // regenerate canonical fixture state
}

async function search(client: Client, query: string, limit?: number) {
  const res = await client.callTool({ name: 'search_history', arguments: limit === undefined ? { query } : { query, limit } });
  if (res.isError) return { isError: true as const, body: JSON.parse((res.content as any)[0].text) };
  return { isError: false as const, body: JSON.parse((res.content as any)[0].text) };
}

describe('search_history: local history retrieval through the authenticated MVP MCP', () => {
  it.skipIf(HTTP_SERVER_UNSUPPORTED)('boots the service with a synthetic promoted-history directory', async () => {
    writePromotedHistory(historyDir, baseFixtures);
    const port = await freePort();
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-hist-mem-'));
    tmpDirs.push(memoryDir, historyDir);
    activeConfig = makeConfig(memoryDir, port, historyDir);
    started = await startMvpService(activeConfig);
    oauth = await registerClient(started.app);
    const tokens = await ownerAuthorize(started.app, oauth);
    token = tokens.access_token;
    const client = await mcpClient(config(), token);
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['save_memory', 'retrieve_memory', 'export_memory', 'search_history']));
    await client.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('requires authentication: no or garbage token never reaches search_history', async () => {
    const noAuth = new Client({ name: 'noauth', version: '0' });
    const t1 = new StreamableHTTPClientTransport(new URL(MCP_PATH_URL(config())));
    await expect(noAuth.connect(t1)).rejects.toThrow();
    const garbage = new Client({ name: 'garbage', version: '0' });
    const t2 = new StreamableHTTPClientTransport(new URL(MCP_PATH_URL(config())),
      { requestInit: { headers: { Authorization: 'Bearer not-a-real-token' } } });
    await expect(garbage.connect(t2)).rejects.toThrow();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('finds the relevant conversation with provenance and untrusted/history labels', async () => {
    const client = await mcpClient(config(), token);
    const { isError, body } = await search(client, 'ZYNTHETIC-QUARTZ calibration');
    expect(isError).toBe(false);
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    const top = body.results[0];
    expect(top.conversation_id).toBe('conv-alpha');
    expect(top.source_path).toBe('chatgpt-conv-alpha.md');
    expect(top.created).toBe('2023-11-14T22:13:20Z');
    expect(top.memory_layer).toBe('history');
    expect(top.trust).toBe('untrusted-transcript');
    expect(body.disclaimer).toMatch(/not verified truth/);
    // assistant historical text is surfaced but labeled; ranking is deterministic
    expect(top.score).toBeGreaterThan(0);
    expect(top.matched_terms).toContain('zynthetic');
    expect(top.matched_terms).toContain('quartz');
    await client.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('never surfaces withdrawn (carried) or non-matching notes', async () => {
    const client = await mcpClient(config(), token);
    const withdrawn = await search(client, 'WITHERED-GROVE');
    expect(withdrawn.body.total_matches).toBe(0);
    expect(withdrawn.body.results).toHaveLength(0);
    const beta = await search(client, 'PHOSPHOR-BLOOM');
    expect(beta.body.results).toHaveLength(1);
    expect(beta.body.results[0].conversation_id).toBe('conv-beta');
    expect(beta.body.results.some((r: any) => r.conversation_id === 'conv-alpha')).toBe(false);
    await client.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('snippets are bounded, single-line, and contain the match', async () => {
    const client = await mcpClient(config(), token);
    const { body } = await search(client, 'reference jig');
    expect(body.results.length).toBeGreaterThan(0);
    const snippet: string = body.results[0].snippet;
    expect(snippet.length).toBeLessThanOrEqual(242); // 240 + ellipsis margin
    expect(snippet).not.toMatch(/[\r\n]/);
    expect(snippet.toLowerCase()).toContain('reference');
    await client.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('internal reasoning content from the importer contract is never searchable', async () => {
    const client = await mcpClient(config(), token);
    const { body } = await search(client, 'INTERNAL-REASONING-MARKER thoughts');
    expect(body.total_matches).toBe(0); // no eligible note contains internal channels
    // importer-contract invariant: eligible promoted notes never carry
    // reasoning-channel content, and search never indexes boilerplate
    const alpha = fs.readFileSync(path.join(historyDir, 'chatgpt-conv-alpha.md'), 'utf-8');
    expect(alpha).not.toContain('INTERNAL-REASONING-MARKER');
    expect(body.skipped_ineligible).toBe(1); // exactly the withdrawn gamma entry
    await client.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('limit bounds and deterministic scoring order', async () => {
    const client = await mcpClient(config(), token);
    const { body } = await search(client, 'ZYNTHETIC-QUARTZ', 1);
    expect(body.returned).toBe(1);
    const scores = body.results.map((r: any) => r.score);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
    await client.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a tampered note is fail-closed ineligible and its content is never served', async () => {
    const notePath = path.join(historyDir, 'chatgpt-conv-alpha.md');
    fs.appendFileSync(notePath, '\ntampered after promotion\n');
    const client = await mcpClient(config(), token);
    const { body } = await search(client, 'ZYNTHETIC-QUARTZ');
    expect(body.results.some((r: any) => r.conversation_id === 'conv-alpha')).toBe(false);
    expect(body.skipped_ineligible).toBeGreaterThanOrEqual(1);
    await client.close();
    restoreManifest(); // restore canonical fixture state
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a removed note is excluded and counted ineligible', async () => {
    fs.rmSync(path.join(historyDir, 'chatgpt-conv-beta.md'));
    const client = await mcpClient(config(), token);
    const { body } = await search(client, 'PHOSPHOR-BLOOM');
    expect(body.total_matches).toBe(0);
    expect(body.skipped_ineligible).toBeGreaterThanOrEqual(1);
    await client.close();
    restoreManifest();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a human-edited note (hash drift) is ineligible and its file is never modified by the service', async () => {
    const notePath = path.join(historyDir, 'chatgpt-conv-delta.md');
    const humanBytes = fs.readFileSync(notePath, 'utf-8') + '\n<!-- human vault edit -->\n';
    fs.writeFileSync(notePath, humanBytes, 'utf-8');
    const client = await mcpClient(config(), token);
    const { body } = await search(client, 'MERIDIAN-FERRY');
    expect(body.results.some((r: any) => r.conversation_id === 'conv-delta')).toBe(false);
    await client.close();
    expect(fs.readFileSync(notePath, 'utf-8')).toBe(humanBytes); // source untouched
    restoreManifest();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a newly promoted note becomes searchable on the next query (no stale index)', async () => {
    const note = noteText('conv-new', 'Newly promoted chat', [
      ['user', 'What is the LUMEN-ARCHIVE index?'],
      ['assistant', 'LUMEN-ARCHIVE is a synthetic promoted note added after startup.'],
    ]);
    fs.writeFileSync(path.join(historyDir, 'chatgpt-conv-new.md'), note, 'utf-8');
    const man = readManifest();
    man.notes['chatgpt-conv-new.md'] = {
      rel: 'notes/chatgpt-conv-new.md', conversation_id: 'conv-new',
      note_sha256: crypto.createHash('sha256').update(note, 'utf-8').digest('hex'),
      staging_manifest_digest: '0'.repeat(64),
    };
    writeManifest(man.notes);
    const client = await mcpClient(config(), token);
    const { body } = await search(client, 'LUMEN-ARCHIVE');
    expect(body.results).toHaveLength(1);
    expect(body.results[0].conversation_id).toBe('conv-new');
    await client.close();
    fs.rmSync(path.join(historyDir, 'chatgpt-conv-new.md'));
    restoreManifest();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('unsafe manifest entries (path traversal, symlink) are ignored safely', async () => {
    const outside = path.join(os.tmpdir(), 'mvp-history-outside-' + crypto.randomBytes(4).toString('hex'));
    fs.writeFileSync(outside, 'decoy content', 'utf-8');
    const man = readManifest();
    man.notes['../evil.md'] = { rel: 'notes/../evil.md', conversation_id: 'evil', note_sha256: '0'.repeat(64) };
    const linkName = 'chatgpt-conv-beta.md';
    const betaPath = path.join(historyDir, linkName);
    fs.rmSync(betaPath);
    fs.symlinkSync(outside, betaPath);
    writeManifest(man.notes);
    const client = await mcpClient(config(), token);
    const { body } = await search(client, 'PHOSPHOR-BLOOM');
    expect(body.total_matches).toBe(0); // symlinked note ineligible
    expect(body.results.some((r: any) => r.source_path === '../evil.md')).toBe(false);
    await client.close();
    fs.rmSync(betaPath);
    fs.rmSync(outside);
    restoreManifest();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('malformed queries and limits are rejected safely (bounded errors)', async () => {
    const client = await mcpClient(config(), token);
    const badCalls: any[] = [
      { name: 'search_history', arguments: { query: '' } },
      { name: 'search_history', arguments: { query: 'x'.repeat(201) } },
      { name: 'search_history', arguments: { query: 'ok', limit: 21 } },
      { name: 'search_history', arguments: { query: 'ok', limit: 0 } },
      { name: 'search_history', arguments: { query: 'ok', limit: 'five' } },
      { name: 'search_history', arguments: {} },
    ];
    for (const call of badCalls) {
      let rejected = false;
      try {
        const res = await client.callTool(call);
        rejected = res.isError === true;
      } catch {
        rejected = true; // SDK-level validation error is also a safe rejection
      }
      expect(rejected, JSON.stringify(call.arguments)).toBe(true);
    }
    // a valid call still works right after the rejections
    const { body } = await search(client, 'ZYNTHETIC-QUARTZ');
    expect(body.ok).toBe(true);
    await client.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('a malformed/missing manifest yields an explicit bounded error, fact memory unaffected', async () => {
    fs.writeFileSync(manifestPath, '{"schema": "garbage"', 'utf-8');
    const client = await mcpClient(config(), token);
    const res = await client.callTool({ name: 'search_history', arguments: { query: 'anything' } });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content as any)[0].text);
    expect(body.error).toBe('history-not-available');
    // fact memory keeps working in the same authenticated session
    const save = await client.callTool({ name: 'save_memory', arguments: {
      subject: 'SynthOwner', predicate: 'works_at', object: 'Memory Company', source: 'chatgpt' } });
    expect(JSON.parse((save.content as any)[0].text).ok).toBe(true);
    const retrieve = await client.callTool({ name: 'retrieve_memory', arguments: { subject: 'SynthOwner' } });
    expect(JSON.parse((retrieve.content as any)[0].text).facts).toHaveLength(1);
    await client.close();
    restoreManifest();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('restart reproduces the same eligible results (rebuild from the authoritative manifest)', async () => {
    const client = await mcpClient(config(), token);
    const before = (await search(client, 'ZYNTHETIC-QUARTZ')).body;
    await client.close();
    started!.httpServer.close();
    await started!.close();
    const port = await freePort();
    activeConfig = makeConfig(config().memoryDir, port, historyDir);
    started = await startMvpService(activeConfig);
    oauth = await registerClient(started.app); // fresh registration after restart
    const fresh = await ownerAuthorize(started.app, oauth!);
    const client2 = await mcpClient(config(), fresh.access_token);
    const after = (await search(client2, 'ZYNTHETIC-QUARTZ')).body;
    expect(after.results).toEqual(before.results);
    expect(after.skipped_ineligible).toEqual(before.skipped_ineligible);
    await client2.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('unconfigured history yields an explicit bounded result; fact memory unaffected', async () => {
    const port = await freePort();
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-hist-mem2-'));
    tmpDirs.push(memoryDir);
    unconfiguredConfig = makeConfig(memoryDir, port, undefined);
    unconfigured = await startMvpService(unconfiguredConfig);
    const client = await mcpClient(unconfiguredConfig, (await ownerAuthorize(unconfigured.app, await registerClient(unconfigured.app))).access_token);
    const { isError, body } = await search(client, 'ZYNTHETIC-QUARTZ');
    expect(isError).toBe(false);
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(false);
    expect(body.results).toHaveLength(0);
    expect(body.note).toMatch(/MVP_HISTORY_DIR/);
    const save = await client.callTool({ name: 'save_memory', arguments: { subject: 'S2', predicate: 'p', object: 'o' } });
    expect(JSON.parse((save.content as any)[0].text).ok).toBe(true);
    const retrieve = await client.callTool({ name: 'retrieve_memory', arguments: { subject: 'S2' } });
    expect(JSON.parse((retrieve.content as any)[0].text).facts).toHaveLength(1);
    unconfiguredToken = 'used';
    await client.close();
  });

  it('measured tiny synthetic retrieval proof (132 synthetic eligible notes)', async () => {
    const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-history-big-'));
    tmpDirs.push(bigDir);
    const fixtures: Fixture[] = [];
    for (let i = 0; i < 132; i++) {
      const note = noteText(`conv-bulk-${i}`, `Bulk synthetic chat ${i}`, [
        ['user', `Question number ${i} about TOPIC-${i % 7} details`],
        ['assistant', `Answer number ${i}: TOPIC-${i % 7} has ${i} reference points recorded.`],
      ]);
      fixtures.push({ name: `chatgpt-conv-bulk-${i}.md`, convId: `conv-bulk-${i}`, note });
    }
    writePromotedHistory(bigDir, fixtures);
    const timings: number[] = [];
    let first = '';
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      const res = searchHistory(bigDir, 'TOPIC-3 reference points', 5);
      timings.push(performance.now() - t0);
      if (run === 0) first = JSON.stringify(res.results.map((r: any) => r.conversation_id));
      expect(res.ok).toBe(true);
      expect(res.returned).toBe(5);
    }
    const again = JSON.stringify(searchHistory(bigDir, 'TOPIC-3 reference points', 5).results.map((r: any) => r.conversation_id));
    expect(again).toBe(first); // deterministic: same order across rebuilds
    console.log('[history-timing] 132 synthetic notes, 3 cold rebuild+search calls (ms):',
      timings.map(t => t.toFixed(1)).join(', '));
  });
});

afterAll(async () => {
  if (started) { started.httpServer.close(); await started.close(); }
  if (unconfigured) { unconfigured.httpServer.close(); await unconfigured.close(); }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.MVP_MEMORY_DIR;
  delete process.env.MVP_BASE_URL;
  delete process.env.MVP_OWNER_EMAIL;
  delete process.env.MVP_OWNER_PASSWORD;
  delete process.env.MVP_HISTORY_DIR;
  // Set by a service test, which does not run where the HTTP server is unsupported (native Windows).
  if (!HTTP_SERVER_UNSUPPORTED) expect(unconfiguredToken).toBe('used');
  expect(originalManifest.length).toBeGreaterThan(0);
});

function MCP_PATH_URL(cfg: MvpConfig): string {
  return `http://127.0.0.1:${cfg.port}${MVP_MCP_PATH}`;
}