import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { productEvidenceReport, type ProductEvidenceAttachment } from '../../src/evidence/attach';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * What every stranger's agent reads from a workspace: the tool list, the errors and the save
 * receipts (new-user re-check, 2026-10-03, finding N9). It is addressed to that agent, so it may
 * not carry the founder's name as its example or details only the operator can act on.
 * Driven through the real MCP tools over the authenticated Streamable HTTP endpoint. Synthetic
 * data only (mkdtemp memory dirs, loopback, no embedding provider).
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const HOOK_TIMEOUT_MS = 30_000;

// Everything the workspaces below set or clear, restored afterwards so no embedding provider (or
// anything else from the developer's shell) leaks in and no setting leaks out.
const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

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

function makeConfig(memoryDir: string, authRoot: string, port: number): MvpConfig {
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  delete process.env.MVP_HISTORY_DIR;
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'agent-facing-text', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorizeRes = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorizeRes.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({
    ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
  }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  return tokens.body.access_token;
}

/** A fresh authenticated service on its own memory dir. */
async function startWorkspace() {
  const dirs = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-agent-text-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-')),
  ];
  const port = await freePort();
  const config = makeConfig(dirs[0], dirs[1], port);
  const started = await startMvpService(config);
  const token = await authorize(started.app);
  const client = new Client({ name: 'agent-facing-text', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  return {
    client,
    /** The tool result as an agent sees it. A protocol-level rejection is not a result: it throws, failing the test. */
    async call(name: string, args: Record<string, unknown>) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as any)[0].text as string;
      return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
    },
    async close() {
      await client.close();
      await new Promise<void>(resolve => started.httpServer.close(() => resolve()));
      started.db?.close?.();
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Workspace = Awaited<ReturnType<typeof startWorkspace>>;

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('agent-facing text names no real person', () => {
  let ws: Workspace;
  beforeAll(async () => { ws = await startWorkspace(); }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('no tool description or argument description uses the founder as its example', async () => {
    const { tools } = await ws.client.listTools();
    const texts = tools.flatMap(tool => [
      tool.description ?? '',
      ...Object.values((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>)
        .map(property => property.description ?? ''),
    ]);
    expect(texts.length).toBeGreaterThan(tools.length);
    expect(texts.filter(text => /\bRowan\b/.test(text))).toEqual([]);

    // The subject arguments still carry an example, only not a person's name.
    for (const name of ['save_memory', 'retrieve_memory']) {
      const subject = (tools.find(tool => tool.name === name)?.inputSchema.properties as any)?.subject?.description;
      expect(subject, `${name} describes its subject`).toMatch(/e\.g\. "user"/);
    }
  });

  it('retrieve_memory without a subject asks for one without naming the founder', async () => {
    const res = await ws.call('retrieve_memory', {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain('needs the "subject" argument');
    expect(res.text).toContain('e.g. "user"');
    expect(res.text).not.toMatch(/\bRowan\b/);
  });
});

// What every connected client reads at every connection, whatever skill its user installed. A user's agents once logged
// every event they handled, so reads returned echoes of those logs and rarely changed a decision (feedback 2026-10-06;
// the skill that says the same to a new install is pinned in tests/agent-skill-tools.test.ts).
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the server instructions ask for a read at the decision and a write of the why', () => {
  let ws: Workspace;
  let instructions: string;
  beforeAll(async () => {
    ws = await startWorkspace();
    instructions = ws.client.getInstructions() ?? '';
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('reads again before a decision and before a review, not only at the start', () => {
    expect(instructions).toMatch(/call get_context with the current request before answering/);
    expect(instructions).toMatch(
      /Call it again before you decide something an earlier session may have settled and before you review another agent's work, with that choice or topic as the query/,
    );
    expect(instructions).toMatch(/reading once at the start is not enough/);
  });

  it('keeps the why next to the board: decisions, root causes and corrections, not status', () => {
    expect(instructions).toMatch(/Renor is the place for the why, next to your board or tracker, not a copy of it/);
    expect(instructions).toMatch(/save decisions with their reason, root causes and corrections, not status, progress or event logs/);
    // What the user asks to have remembered is still saved: the rule is about what an agent logs on its own.
    expect(instructions).toMatch(/To save anything, call remember with one argument, statement/);
    expect(instructions).toContain('When the user says to remember or save something, they mean this tool, not your own memory.');
    expect(instructions).toMatch(/when you save on your own/);
  });

  it('cites an earlier entry instead of restating it, and saves nothing that only repeats one', () => {
    expect(instructions).toMatch(/Cite an earlier entry by its subject or task instead of restating it, and save nothing that only repeats one/);
  });

  it('keeps the structured-fact and correction guidance, now said plain-first', () => {
    expect(instructions).toContain('Only for a value that stays current until it changes');
    expect(instructions).toContain('saving the same subject, predicate and scope again replaces the value and keeps the old one in history');
  });

  it('is addressed to any agent: no real person named, no setting only the operator can change', () => {
    expect(instructions).not.toMatch(/\bRowan\b/);
    expect(instructions).not.toMatch(/RENOR_|MVP_|API_KEY/);
  });
});

// The empty `skippedNonUtf8Names` list the re-check saw on every save left with the incremental refresh
// (found in review); this keeps it from coming back.
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a save receipt carries no empty operator detail', () => {
  let ws: Workspace;
  beforeAll(async () => { ws = await startWorkspace(); }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a note save reports the index refresh without an empty list of unreadable file names', async () => {
    const res = await ws.call('remember', { statement: 'The quokka migration is planned for spring.' });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ ok: true, mode: 'note', indexed: true });
    expect(res.body.index).toMatchObject({ errors: 0 });
    expect(res.body.index.indexed).toBeGreaterThanOrEqual(1);
    expect(res.body.index).not.toHaveProperty('skippedNonUtf8Names');
  });
});

describe('the evidence note speaks to the agent, not to the operator', () => {
  // Every reason a search can skip the evidence pass for. The note is what an agent reads; an
  // environment variable or "set a key" is an instruction only whoever runs the host can follow.
  const SKIP_REASONS: Array<NonNullable<ProductEvidenceAttachment['reason']>> = [
    'flag-off', 'mode-off', 'intent', 'no-sessions', 'extractor-unavailable', 'extractor-parse-error', 'extractor-error',
  ];

  for (const reason of SKIP_REASONS) {
    it(`${reason}: no environment variable, key or setting to change`, () => {
      const { note } = productEvidenceReport({ status: 'skipped', reason });
      expect(note).not.toMatch(/RENOR_|OLLAMA|API_KEY|=0\b|=off\b/i);
      expect(note).not.toMatch(/set a key|turn the table on/i);
      expect(note).toMatch(/nothing is missing|retrieval is unaffected/i);
    });
  }

  it('a deployment without an evidence model still says so, and that nothing is broken', () => {
    const report = productEvidenceReport({ status: 'skipped', reason: 'extractor-unavailable' });
    expect(report.state).toBe('unavailable');
    expect(report.note).toMatch(/no evidence model configured/i);
    expect(report.note).toMatch(/nothing is broken/i);
  });
});
