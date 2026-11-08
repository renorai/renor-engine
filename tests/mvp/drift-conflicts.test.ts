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
import { replyTokens } from '../../src/mvp/agentMemory';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Multi-agent drift (first-week scout, finding F2), driven through the real MCP tools over the authenticated
 * Streamable HTTP endpoint of a keyword-only workspace (what a self-serve workspace runs: no embedding provider).
 * Synthetic data only.
 *
 * With several agents, one thing gets saved under two names ("Atlas project" / "Atlas") or in two scopes (a
 * correction saved without the project's scope goes to global), and both values stay current. Nothing merges them:
 * the save that creates the second one names the first (`possibleDuplicates`), and reads name the disagreement
 * (`conflicts`). Scope stays an isolation boundary: a call that names a scope is never told what another holds.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const HOOK_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'RENOR_READ_HONESTY',
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
  delete process.env.MVP_LEDGER_REL;
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.RENOR_READ_HONESTY;
  return loadMvpConfig();
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'drift-conflicts', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

/** A fresh keyword-only workspace. Calls are sequential: one shared stateless MCP server. */
async function startWorkspace() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-drift-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  const config = makeConfig(memoryDir, authRoot, await freePort());
  const service = await startMvpService(config);
  const token = await authorize(service.app);
  const client = new Client({ name: 'drift-conflicts', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as any)[0].text as string;
    expect(res.isError, `${name} ${JSON.stringify(args)}: ${text}`).not.toBe(true);
    return JSON.parse(text);
  };
  return {
    call,
    /** A fact-mode remember, as an agent makes it; `scope` omitted means the call names no scope. */
    remember: (statement: string, subject: string, predicate: string, object: string, scope?: string) =>
      call('remember', { statement, subject, predicate, object, ...(scope === undefined ? {} : { scope }) }),
    async close() {
      await client.close();
      service.httpServer.closeAllConnections?.();
      await new Promise<void>(resolve => service.httpServer.close(() => resolve()));
      await service.close();
      fs.rmSync(memoryDir, { recursive: true, force: true });
      fs.rmSync(authRoot, { recursive: true, force: true });
    },
  };
}

type Workspace = Awaited<ReturnType<typeof startWorkspace>>;

/** A value as the drift fields list it, without its time. */
const brief = (value: any) => `${value.subject} = ${value.object} [${value.scope}]`;
const conflictsOf = (body: any) => (body.conflicts ?? []).map((c: any) => `${c.predicate}: ${c.values.map(brief).join(' / ')}`);

// The report's reproduction (first-week scout, section 2, F2), call for call.
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the F2 reproduction: the duplicate is named when it is saved, the conflict when it is read', () => {
  let ws: Workspace;
  const receipts: any[] = [];
  beforeAll(async () => {
    ws = await startWorkspace();
    receipts.push(await ws.remember('Rate limit is 600/min.', 'Atlas', 'api_rate_limit', '600/min', 'project:atlas'));
    receipts.push(await ws.remember('We raised it to 1200/min.', 'Atlas', 'api_rate_limit', '1200/min'));
    receipts.push(await ws.remember('Move deploys to Fly.io.', 'Atlas project', 'deploy_target', 'Fly.io'));
    receipts.push(await ws.remember('Reversed: we stay on ECS.', 'Atlas', 'deploy_target', 'AWS ECS Fargate'));
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a save with nothing related to it carries no possibleDuplicates', () => {
    expect(receipts[0]).not.toHaveProperty('possibleDuplicates');
    expect(receipts[2]).not.toHaveProperty('possibleDuplicates'); // Atlas has no deploy_target yet
  });

  it('a correction saved without the project scope names the value it did not supersede, with its scope', () => {
    const receipt = receipts[1];
    expect(receipt).toMatchObject({ ok: true, action: 'store', closed: null, scope: 'global' });
    expect(receipt.possibleDuplicates.map(brief)).toEqual(['Atlas = 600/min [project:atlas]']);
    expect(Object.keys(receipt.possibleDuplicates[0]).sort()).toEqual(['object', 'scope', 'subject', 'validFrom']);
    expect(receipt).not.toHaveProperty('possibleDuplicatesTotal');
  });

  it('a reversal saved under another name for the project names the decision it reverses', () => {
    const receipt = receipts[3];
    expect(receipt).toMatchObject({ action: 'store', closed: null, scope: 'global' });
    expect(receipt.possibleDuplicates.map(brief)).toEqual(['Atlas project = Fly.io [global]']);
  });

  it('retrieve_memory rows say their scope and the two current values are named as a conflict', async () => {
    const body = await ws.call('retrieve_memory', { subject: 'Atlas', predicate: 'api_rate_limit' });
    expect(body.facts.map((f: any) => `${f.object} [${f.scope}] current:${f.current}`)).toEqual([
      '1200/min [global] current:true', '600/min [project:atlas] current:true',
    ]);
    expect(conflictsOf(body)).toEqual(['api_rate_limit: Atlas = 1200/min [global] / Atlas = 600/min [project:atlas]']);
  });

  it('get_context names both drifts, newest value first in each', async () => {
    const body = await ws.call('get_context', { query: 'Where do we deploy Atlas?' });
    expect(conflictsOf(body)).toEqual([
      'deploy_target: Atlas = AWS ECS Fargate [global] / Atlas project = Fly.io [global]',
      'api_rate_limit: Atlas = 1200/min [global] / Atlas = 600/min [project:atlas]',
    ]);
    const values = body.conflicts[0].values;
    expect(Object.keys(values[0]).sort()).toEqual(['object', 'scope', 'subject', 'validFrom']);
    expect(values[0].validFrom > values[1].validFrom).toBe(true);
  });

  it('the scoped read stays inside its scope: it is not told what global holds', async () => {
    const body = await ws.call('get_context', { query: 'What is the Atlas API rate limit?', scope: 'project:atlas' });
    expect(body.facts.map((f: any) => `${f.subject} | ${f.object} [${f.scope}]`)).toEqual(['Atlas | 600/min [project:atlas]']);
    expect(body).not.toHaveProperty('conflicts');
    expect(JSON.stringify(body)).not.toContain('1200');
    const scoped = await ws.call('retrieve_memory', { subject: 'Atlas', predicate: 'api_rate_limit', scope: 'project:atlas' });
    expect(scoped.facts.map((f: any) => `${f.object} [${f.scope}]`)).toEqual(['600/min [project:atlas]']);
    expect(scoped).not.toHaveProperty('conflicts');
    expect(JSON.stringify(scoped)).not.toContain('1200');
  });

  it('following the receipt closes the loop: the correction saved in that scope supersedes it and nothing disagrees', async () => {
    const receipt = await ws.remember('We raised it to 1200/min.', 'Atlas', 'api_rate_limit', '1200/min', 'project:atlas');
    expect(receipt).toMatchObject({ action: 'supersede', closed: { object: '600/min' }, scope: 'project:atlas' });
    const scoped = await ws.call('get_context', { query: 'What is the Atlas API rate limit?', scope: 'project:atlas' });
    expect(scoped.facts.map((f: any) => f.object)).toEqual(['1200/min']);
    // Two current copies of one value (global and project:atlas) are no longer a disagreement.
    const everywhere = await ws.call('retrieve_memory', { subject: 'Atlas', predicate: 'api_rate_limit' });
    expect(everywhere.facts.map((f: any) => `${f.object} [${f.scope}]`).sort()).toEqual(['1200/min [global]', '1200/min [project:atlas]']);
    expect(everywhere).not.toHaveProperty('conflicts');
  });
});

// Memory scout finding 13 (renor-newuser-scout-memory-1002, S9), call for call: the same two-scope contradiction read
// with the opt-in read-honesty lane armed. The lane replaces get_context's conflicts with its own, and it used to
// compare one scope at a time, so it answered `conflicts: []` with both values side by side in facts.
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the read-honesty lane names a two-scope contradiction as get_context does (scout finding 13)', () => {
  let ws: Workspace;
  const query = 'how many retries does the deploy bot get?';
  /** get_context with RENOR_READ_HONESTY armed, as an operator arms it: the service reads the flag per request. */
  const armed = async (args: Record<string, unknown>) => {
    process.env.RENOR_READ_HONESTY = '1';
    try {
      return await ws.call('get_context', args);
    } finally {
      delete process.env.RENOR_READ_HONESTY;
    }
  };
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.call('remember', { statement: 'global retry = 3', subject: 'deploy bot', predicate: 'retry_count', object: '3', source: 'scout-session-2' });
    await ws.call('remember', { statement: 'project retry = 9', subject: 'deploy bot', predicate: 'retry_count', object: '9', source: 'scout-session-2', scope: 'project:renor' });
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a read that names no scope names both values, each with its scope, newest first', async () => {
    const unarmed = await ws.call('get_context', { query });
    expect(conflictsOf(unarmed)).toEqual(['retry_count: deploy bot = 9 [project:renor] / deploy bot = 3 [global]']);
    const body = await armed({ query });
    expect(body.facts.map((f: any) => `${f.object} [${f.scope}]`)).toEqual(['9 [project:renor]', '3 [global]']);
    expect(body.conflicts).toHaveLength(1);
    const [conflict] = body.conflicts;
    expect(conflict).toMatchObject({ subject: 'deploy bot', predicate: 'retry_count', values: ['9', '3'] });
    expect(conflict.newer).toMatchObject({ value: '9', scope: 'project:renor' });
    expect(conflict.older).toMatchObject({ value: '3', scope: 'global' });
    expect(conflict.statement).toMatch(/"9" \([^)]*scope project:renor[^)]*\) is newer than "3" \([^)]*scope global[^)]*\)/);
    expect(body.abstention).toBeNull();
  });

  it('a scoped read is not told what the other scope holds', async () => {
    for (const [scope, own, other] of [['project:renor', '9', '3'], ['global', '3', '9']] as const) {
      const body = await armed({ query, scope });
      expect(body.facts.map((f: any) => `${f.object} [${f.scope}]`), scope).toEqual([`${own} [${scope}]`]);
      expect(body.conflicts, scope).toEqual([]);
      expect(JSON.stringify(body), scope).not.toContain(`retry = ${other}`);
    }
  });
});

// The review of the fix above: a value current in a third scope had no scope anywhere in the armed reply (only newer and
// older carried one), and a value saved in many scopes grew the conflicts without bound, past max_tokens. The lane names
// every value with its scope, eight at most as get_context's default conflicts list, cuts them to the reply's budget,
// and counts what it does not name.
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the read-honesty lane names every value with its scope, within the reply budget', () => {
  let ws: Workspace;
  const TEAMS = 200;
  /** get_context with RENOR_READ_HONESTY armed, as an operator arms it: the service reads the flag per request. */
  const armed = async (args: Record<string, unknown>) => {
    process.env.RENOR_READ_HONESTY = '1';
    try {
      return await ws.call('get_context', args);
    } finally {
      delete process.env.RENOR_READ_HONESTY;
    }
  };
  /** Every side a lane conflict names, as value [scope]. */
  const named = (conflict: any) => [conflict.newer, conflict.older, ...(conflict.alsoCurrent ?? [])].map((s: any) => `${s.value} [${s.scope}]`);
  /** A team's value, a phrase as values often are: the lane's uncut list of 200 of them outgrew any budget. */
  const shards = (team: number) => `${team} shards on the team-${team} build hosts`;
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.remember('global retry = 3', 'deploy bot', 'retry_count', '3');
    await ws.remember('project retry = 9', 'deploy bot', 'retry_count', '9', 'project:renor');
    await ws.remember('atlas retry = 5', 'deploy bot', 'retry_count', '5', 'project:atlas');
    for (let team = 1; team <= TEAMS; team++) {
      await ws.remember(`Team ${team} runs the build cache as ${shards(team)}.`, 'build cache', 'shard_count', shards(team), `scope:team-${team}`);
    }
    // One subject saved differently in a project for twenty predicates, the way a project overrides its defaults.
    await ws.remember('The release train freezes on Fridays at 18:00.', 'release train', 'freeze_window', 'Friday 18:00');
    await ws.remember('In renor the release train freezes on Thursdays at noon.', 'release train', 'freeze_window', 'Thursday 12:00', 'project:renor');
    for (let gate = 1; gate < 20; gate++) {
      await ws.remember(`Release gate ${gate} is owned by the platform team.`, 'release train', `gate_${gate}_owner`, 'platform team');
      await ws.remember(`In renor, release gate ${gate} is owned by the renor team.`, 'release train', `gate_${gate}_owner`, 'renor team', 'project:renor');
    }
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('three scopes: every value is named with its scope, newest first, in the fields and the statement', async () => {
    const body = await armed({ query: 'how many retries does the deploy bot get?' });
    expect(body.conflicts).toHaveLength(1);
    const [conflict] = body.conflicts;
    expect(conflict.values).toEqual(['5', '9', '3']);
    expect(named(conflict)).toEqual(['5 [project:atlas]', '9 [project:renor]', '3 [global]']);
    expect(conflict).not.toHaveProperty('total');
    expect(conflict.statement).toMatch(
      /^Contradiction on deploy bot \/ retry_count: "5" \([^)]*scope project:atlas[^)]*\) is newer than "9" \([^)]*scope project:renor[^)]*\); also current: "3" \([^)]*scope global[^)]*\)\. All 3 are current/,
    );
  });

  it(`${TEAMS} scopes: the newest values, each with its scope, inside the reply budget, and how many there are`, async () => {
    const query = 'how many shards does the build cache use?';
    const newest = (n: number) => Array.from({ length: n }, (_, i) => `${shards(TEAMS - i)} [scope:team-${TEAMS - i}]`);
    // A budget that holds the whole reply: as many values as get_context's default conflicts list, eight, each with its
    // scope, newest first, and how many there are.
    const roomy = await armed({ query, max_tokens: 4000 });
    expect(replyTokens(JSON.stringify(roomy))).toBeLessThanOrEqual(4000);
    expect(roomy.conflicts).toHaveLength(1);
    expect(named(roomy.conflicts[0])).toEqual(newest(8));
    expect(roomy.conflicts[0].total).toBe(TEAMS);
    expect(roomy.conflicts[0].statement).toContain(` and ${TEAMS - 8} more. All ${TEAMS} are current`);
    // A smaller budget names fewer of them, newest first, and still counts them all: the values past the two that
    // disagree are the least of what the lane says, so the reply's items take its room before them. The fact the
    // contradiction is about is in the reply with it, and everything is inside max_tokens, counted as the engine counts
    // tokens (the lane used to cut its conflicts to a budget of characters of their own, past max_tokens:
    // tests/mvp/honesty-lane-budget.test.ts).
    for (const maxTokens of [800, 1200, 2000]) {
      const body = await armed({ query, max_tokens: maxTokens });
      expect(replyTokens(JSON.stringify(body)), `${maxTokens}`).toBeLessThanOrEqual(maxTokens);
      expect(body.conflicts, `${maxTokens}`).toHaveLength(1);
      const [conflict] = body.conflicts;
      const n = named(conflict).length;
      expect(n, `${maxTokens}`).toBeGreaterThanOrEqual(2);
      expect(named(conflict), `${maxTokens}`).toEqual(newest(n));
      expect(conflict.total, `${maxTokens}`).toBe(TEAMS);
      expect(conflict.statement, `${maxTokens}`).toContain(`${n > 2 ? ' and ' : 'also current: '}${TEAMS - n} more. All ${TEAMS} are current`);
      expect(body.facts.some((f: any) => f.subject === 'build cache'), `${maxTokens}`).toBe(true);
    }
    // A budget too small for a fact and the two values that disagree (about 440 tokens in this reply) names neither,
    // and the reply says it was cut.
    for (const maxTokens of [128, 300]) {
      const body = await armed({ query, max_tokens: maxTokens });
      expect(replyTokens(JSON.stringify(body)), `${maxTokens}`).toBeLessThanOrEqual(maxTokens);
      expect(body.conflicts, `${maxTokens}`).toEqual([]);
      expect(body.facts.some((f: any) => f.subject === 'build cache'), `${maxTokens}`).toBe(false);
      expect(body.abstention, `${maxTokens}`).toBeNull();
      expect(body.truncated, `${maxTokens}`).toBe(true);
    }
  });

  it('a subject saved differently in a project for many predicates: the read is told about the facts it returns', async () => {
    const query = 'when is the freeze window?';
    const body = await armed({ query });
    expect(JSON.stringify(body.conflicts).length).toBeLessThanOrEqual(800 * 4);
    expect(body.facts.map((f: any) => `${f.predicate} = ${f.object} [${f.scope}]`)).toEqual([
      'freeze_window = Thursday 12:00 [project:renor]', 'freeze_window = Friday 18:00 [global]',
    ]);
    expect(body.conflicts.map((c: any) => `${c.predicate}: ${named(c).join(' / ')}`)).toEqual([
      'freeze_window: Thursday 12:00 [project:renor] / Friday 18:00 [global]',
    ]);
    // The same contradiction get_context names with the lane off.
    expect(conflictsOf(await ws.call('get_context', { query }))).toEqual([
      'freeze_window: release train = Thursday 12:00 [project:renor] / release train = Friday 18:00 [global]',
    ]);
  });
});

// The scout's week: the same drifts made inside one project, and across projects.
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('scope is an isolation boundary for both fields', () => {
  let ws: Workspace;
  const receipts: Record<string, any> = {};
  beforeAll(async () => {
    ws = await startWorkspace();
    await ws.remember("I'm based in São Paulo, so use America/Sao_Paulo for times.", 'user', 'timezone', 'America/Sao_Paulo');
    await ws.remember('The Atlas staging database host is staging-db.atlas.internal.', 'staging database', 'host', 'staging-db.atlas.internal', 'project:atlas');
    await ws.remember('We decided to move Atlas deploys from Heroku to Fly.io.', 'Atlas project', 'deploy_target', 'Fly.io', 'project:atlas');
    receipts.reversal = await ws.remember("The Fly.io load test failed, so we're reversing the decision: Atlas stays on AWS and deploys to ECS Fargate.", 'Atlas', 'deploy_target', 'AWS ECS Fargate', 'project:atlas');
    receipts.kestrelHost = await ws.remember('The Kestrel staging database host is kestrel-staging.supabase.co.', 'staging database', 'host', 'kestrel-staging.supabase.co', 'project:kestrel');
    receipts.lisbon = await ws.remember("I'm in Lisbon this week for a conference, use Europe/Lisbon for times.", 'user', 'timezone', 'Europe/Lisbon', 'project:kestrel');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a drift inside one project is named to a save, a get_context and a retrieve_memory in that project', async () => {
    expect(receipts.reversal.possibleDuplicates.map(brief)).toEqual(['Atlas project = Fly.io [project:atlas]']);
    const context = await ws.call('get_context', { query: 'Where do we deploy Atlas?', scope: 'project:atlas' });
    expect(conflictsOf(context)).toEqual(['deploy_target: Atlas = AWS ECS Fargate [project:atlas] / Atlas project = Fly.io [project:atlas]']);
    const retrieved = await ws.call('retrieve_memory', { subject: 'Atlas', predicate: 'deploy_target', scope: 'project:atlas' });
    expect(conflictsOf(retrieved)).toEqual(['deploy_target: Atlas = AWS ECS Fargate [project:atlas] / Atlas project = Fly.io [project:atlas]']);
  });

  it('a save in one project is not told what another project or global holds', () => {
    expect(receipts.kestrelHost).not.toHaveProperty('possibleDuplicates'); // project:atlas has the same subject and predicate
    expect(receipts.lisbon).not.toHaveProperty('possibleDuplicates'); // global has the same subject and predicate
    expect(JSON.stringify(receipts.kestrelHost)).not.toContain('atlas.internal');
    expect(JSON.stringify(receipts.lisbon)).not.toContain('Sao_Paulo');
  });

  it('reads in one project are not told what another project or global holds', async () => {
    for (const [args, absent] of [
      [{ query: 'What is the staging database host?', scope: 'project:atlas' }, 'kestrel-staging'],
      [{ query: 'What is the staging database host?', scope: 'project:kestrel' }, 'atlas.internal'],
      [{ query: 'What time zone am I in? timezone', scope: 'project:kestrel' }, 'Sao_Paulo'],
    ] as const) {
      const body = await ws.call('get_context', args);
      expect(body, JSON.stringify(args)).not.toHaveProperty('conflicts');
      expect(JSON.stringify(body), JSON.stringify(args)).not.toContain(absent);
    }
    for (const [args, absent] of [
      [{ subject: 'staging database', scope: 'project:atlas' }, 'kestrel-staging'],
      [{ subject: 'user', scope: 'project:kestrel' }, 'Sao_Paulo'],
      [{ subject: 'user', scope: 'global' }, 'Lisbon'],
    ] as const) {
      const body = await ws.call('retrieve_memory', args);
      expect(body.facts.length, JSON.stringify(args)).toBe(1);
      expect(body, JSON.stringify(args)).not.toHaveProperty('conflicts');
      expect(JSON.stringify(body), JSON.stringify(args)).not.toContain(absent);
    }
  });

  it('a read that names no scope sees every scope and names the values each scope holds', async () => {
    const timezone = await ws.call('retrieve_memory', { subject: 'user', predicate: 'timezone' });
    expect(conflictsOf(timezone)).toEqual(['timezone: user = Europe/Lisbon [project:kestrel] / user = America/Sao_Paulo [global]']);
    const host = await ws.call('get_context', { query: 'What is the staging database host?' });
    expect(conflictsOf(host)).toEqual(['host: staging database = kestrel-staging.supabase.co [project:kestrel] / staging database = staging-db.atlas.internal [project:atlas]']);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('what is and is not named', () => {
  let ws: Workspace;
  beforeAll(async () => { ws = await startWorkspace(); }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a correction in the same subject, predicate and scope supersedes: no duplicate, no conflict', async () => {
    await ws.remember('Atlas runs on Postgres 15.', 'Atlas', 'database', 'Postgres 15', 'project:atlas');
    const receipt = await ws.remember('Atlas is on Postgres 16 now.', 'Atlas', 'database', 'Postgres 16', 'project:atlas');
    expect(receipt.action).toBe('supersede');
    expect(receipt).not.toHaveProperty('possibleDuplicates');
    const body = await ws.call('retrieve_memory', { subject: 'Atlas', predicate: 'database', include_history: true });
    expect(body.facts.map((f: any) => `${f.object} current:${f.current} [${f.scope}]`)).toEqual([
      'Postgres 16 current:true [project:atlas]', 'Postgres 15 current:false [project:atlas]',
    ]);
    expect(body).not.toHaveProperty('conflicts');
  });

  it('the same value under a related name is a duplicate when saved, but nothing disagrees when read', async () => {
    await ws.remember('Kestrel uses bun.', 'Kestrel', 'package_manager', 'bun', 'project:kestrel');
    const receipt = await ws.remember('The Kestrel app uses Bun.', 'Kestrel app', 'package_manager', 'Bun', 'project:kestrel');
    expect(receipt.possibleDuplicates.map(brief)).toEqual(['Kestrel = bun [project:kestrel]']);
    const body = await ws.call('get_context', { query: 'Kestrel package manager', scope: 'project:kestrel' });
    expect(body.facts.length).toBe(2);
    expect(body).not.toHaveProperty('conflicts');
  });

  it('values that differ only in case, accents or punctuation do not disagree', async () => {
    await ws.remember('Home is São Paulo.', 'home', 'city', 'São Paulo');
    await ws.remember('Home is sao paulo.', 'home', 'city', 'sao paulo!', 'scope:travel');
    const body = await ws.call('retrieve_memory', { subject: 'home', predicate: 'city' });
    expect(body.facts.length).toBe(2);
    expect(body).not.toHaveProperty('conflicts');
  });

  it('a possessive, a name longer by two words, a word that only starts the same, another predicate: none is related', async () => {
    await ws.remember('Ravi is an engineer.', 'Ravi', 'role', 'engineer');
    const manager = await ws.remember("Ravi's manager is a director.", "Ravi's manager", 'role', 'director');
    await ws.remember('Atlas is owned by Lena.', 'Atlas', 'owner', 'Lena');
    const service = await ws.remember('The Atlas service shipments is owned by Ravi.', 'Atlas service shipments', 'owner', 'Ravi');
    const atlassian = await ws.remember('Atlassian is owned by its founders.', 'Atlassian', 'owner', 'its founders');
    const region = await ws.remember('Atlas project deploys in sa-east-1.', 'Atlas project', 'deploy_region', 'sa-east-1');
    for (const receipt of [manager, service, atlassian, region]) expect(receipt, JSON.stringify(receipt)).not.toHaveProperty('possibleDuplicates');
    for (const subject of ['Ravi', 'Atlas']) {
      const body = await ws.call('retrieve_memory', { subject });
      expect(body, subject).not.toHaveProperty('conflicts');
    }
  });

  it('a point-in-time read names no conflicts: it is not about the values current now', async () => {
    await ws.remember('Feature flags live in LaunchDarkly.', 'Atlas', 'flags_service', 'LaunchDarkly', 'project:atlas');
    await ws.remember('Feature flags moved to Unleash.', 'Atlas', 'flags_service', 'Unleash');
    const now = await ws.call('retrieve_memory', { subject: 'Atlas', predicate: 'flags_service' });
    expect(conflictsOf(now)).toEqual(['flags_service: Atlas = Unleash [global] / Atlas = LaunchDarkly [project:atlas]']);
    const asOf = await ws.call('retrieve_memory', { subject: 'Atlas', predicate: 'flags_service', as_of: new Date(Date.now() + 60_000).toISOString() });
    expect(asOf.facts.length).toBe(2);
    expect(asOf).not.toHaveProperty('conflicts');
  });

  it('conflicts are about the facts the response returns: a fact the budget cut names none', async () => {
    const long = (what: string) => `${what}, ${'with a long explanation of the decision '.repeat(6)}`.trim();
    await ws.remember('The billing queue is RabbitMQ.', 'billing queue', 'technology', long('RabbitMQ'));
    await ws.remember('The billing queue service is SNS.', 'billing queue service', 'technology', long('SNS'));
    await ws.remember('The ingest queue is Kafka.', 'ingest queue', 'technology', 'Kafka'); // newer, so listed first
    await ws.remember('The ingest queue service is SQS.', 'ingest queue service', 'technology', 'SQS');
    const query = 'ingest billing queue technology';
    const full = await ws.call('get_context', { query, max_tokens: 4000 });
    expect(full.facts.length).toBe(4);
    expect(conflictsOf(full).map((c: string) => c.split(' = ')[0])).toEqual(['technology: ingest queue service', 'technology: billing queue service']);
    // How many facts a small budget keeps is the budget's own rule; what matters is that the newest (ingest) fact is kept
    // and both billing facts are cut. The whole reply counts against it, conflicts included (live dogfood D9), so the
    // budget is one that holds a fact and the conflict it names.
    const cut = await ws.call('get_context', { query, max_tokens: 200 });
    expect(cut.facts[0].subject).toBe('ingest queue service');
    expect(cut.facts.every((f: any) => f.subject.startsWith('ingest '))).toBe(true);
    expect(cut.truncated).toBe(true);
    // The kept fact names its related values (its pair, kept or cut); the cut billing facts name nothing.
    expect(conflictsOf(cut)).toEqual(['technology: ingest queue service = SQS [global] / ingest queue = Kafka [global]']);
  });

  it('a long list is cut to the newest eight, and says how many there are', async () => {
    for (let i = 1; i <= 10; i++) {
      await ws.remember(`Meeting room ${i} is booked by team ${i}.`, 'meeting room', 'booked_by', `team ${i}`, `scope:floor-${i}`);
    }
    const receipt = await ws.remember('The meeting room is booked by nobody.', 'meeting room', 'booked_by', 'nobody');
    expect(receipt.possibleDuplicates.length).toBe(8);
    expect(receipt.possibleDuplicatesTotal).toBe(10);
    expect(receipt.possibleDuplicates[0].object).toBe('team 10'); // newest first
    const body = await ws.call('retrieve_memory', { subject: 'meeting room' });
    expect(body.conflicts.length).toBe(1);
    expect(body.conflicts[0].values.length).toBe(8);
    expect(body.conflicts[0].total).toBe(11);
    expect(body.conflicts[0].values[0].object).toBe('nobody');
  });
});
