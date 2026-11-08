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
import { startMvpService, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { dailyDirForScope, normalizeScope } from '../../src/mvp/scope';
import { CONTEXT_BUDGET_KEEPS_NEWEST, CONTEXT_RELEVANCE_KEEPS_MATCH, NO_STRONG_MATCH, SEARCH_RELEVANCE_GUIDANCE } from '../../src/mvp/contextRelevance';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * The relevance signal as an agent meets it: over the authenticated MCP surface.
 * Synthetic memory dir, deterministic eval-hash embeddings, loopback only.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const tmpDirs: string[] = [];
const touchedEnv = ['RENOR_CONTEXT_RELEVANCE', 'RENOR_CONTEXT_RELEVANCE_MIN'];
const savedEnv = new Map(touchedEnv.map(k => [k, process.env[k]]));
let running: (MvpApp & { httpServer: import('http').Server }) | null = null;
let connected: Client | null = null;

afterEach(async () => {
  await connected?.close();
  connected = null;
  if (running) { running.httpServer.close(); await running.close(); running = null; }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
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

function makeConfig(memoryDir: string, port: number): MvpConfig {
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  tmpDirs.push(authRoot);
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  return loadMvpConfig();
}

async function connect(config: MvpConfig, app: MvpApp['app']): Promise<Client> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'relevance-test-client', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorize.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form')
    .send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  const client = new Client({ name: 'relevance-test-client', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } } },
  ));
  return client;
}

async function start(env: Record<string, string | undefined>, notes: string[] = []): Promise<Client> {
  for (const k of touchedEnv) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-relevance-'));
  tmpDirs.push(memoryDir);
  if (notes.length > 0) {
    const dir = path.join(memoryDir, dailyDirForScope(normalizeScope('global')));
    fs.mkdirSync(dir, { recursive: true });
    const taken = new Set<string>();
    notes.forEach((text, i) => {
      const date = `2026-09-${String((i % 28) + 1).padStart(2, '0')}`;
      const file = taken.has(date) ? `${date}-${i}.md` : `${date}.md`;
      taken.add(file);
      fs.writeFileSync(path.join(dir, file), `---\nkind: note\nupdated: ${date}\n---\n# ${date}\n\n- [09:00:00] (calibration) ${text}`, 'utf8');
    });
  }
  const config = makeConfig(memoryDir, await freePort());
  running = await startMvpService(config, new EvalHashEmbeddingProvider());
  connected = await connect(config, running.app);
  return connected;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text);

/**
 * save_memory stamps its ledger event with the wall clock and a random id ("## MEM_MUT44RJLVIYH89 · 2026-10-04T00:59:00.081Z"), and
 * the eval-hash embeddings put each word of the event in one of 256 buckets. Words of the stamp (the year, the id, the milliseconds,
 * in some hours the day and hour) land in the buckets of the question nothing answers below by chance: at the stamp above enough did
 * to lift its similarity to 0.344, over the 0.3 bar, and a miss came back relevant.
 * The tests that judge that question save through saveDogFact. It holds the clock and Math.random still for that one call, so the
 * embedded text is the same on every run, and checks that it did: a stamp made some other way would fail every run, not now and then.
 * This stamp is one where only the year's word falls in the question's buckets.
 */
const STAMP = { at: '2026-10-01T09:00:00.000Z', random: 0.123456789, eventId: 'MEM_MUPAZS004FZZZX' };

async function saveDogFact(client: Client): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(STAMP.at));
  const random = vi.spyOn(Math, 'random').mockReturnValue(STAMP.random);
  try {
    const saved = await call(client, 'save_memory', { subject: 'user', predicate: 'dog_name', object: 'Biscuit' });
    expect(saved).toMatchObject({ action: 'store', eventId: STAMP.eventId, created: { validFrom: STAMP.at } });
  } finally {
    random.mockRestore();
    vi.useRealTimers();
  }
}

/**
 * The same determinism as saveDogFact, for the fact the crowded-page case is judged on: the stamp is held fixed so
 * the embedded text is the same on every run, and checked so a stamp made some other way fails every run, not now
 * and then. This stamp is one where only the year's word falls in the question's buckets.
 */
const EDITOR_STAMP = { at: '2026-10-01T09:05:00.000Z', random: 0.987654321, eventId: 'MEM_MUPB67HCZK0000' };

async function saveEditorFact(client: Client): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(EDITOR_STAMP.at));
  const random = vi.spyOn(Math, 'random').mockReturnValue(EDITOR_STAMP.random);
  try {
    const saved = await call(client, 'save_memory', { subject: 'user', predicate: 'preferred_editor', object: 'Neovim' });
    expect(saved).toMatchObject({ action: 'store', eventId: EDITOR_STAMP.eventId });
  } finally {
    random.mockRestore();
    vi.useRealTimers();
  }
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('get_context relevance over MCP', () => {
  it('leaves the tool description and instructions untouched, and the response without a relevance field, by default', async () => {
    const client = await start({});
    const tools = (await client.listTools()).tools;
    const tool = tools.find(t => t.name === 'get_context')!;
    expect(tool.description).not.toContain('relevance');
    expect(tools.find(t => t.name === 'search_memory')!.description).not.toContain('relevance');
    expect(client.getInstructions() ?? '').not.toContain('relevance');
    await call(client, 'save_memory', { subject: 'user', predicate: 'dog_name', object: 'Biscuit' });
    await call(client, 'index_memory', {});
    expect(await call(client, 'get_context', { query: 'What is my dog name?' })).not.toHaveProperty('relevance');
    expect(await call(client, 'search_memory', { query: 'What is my dog name?' })).not.toHaveProperty('relevance');
  });

  it('tells agents about the signal and returns it when armed', async () => {
    const client = await start({ RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0.3' });
    const tool = (await client.listTools()).tools.find(t => t.name === 'get_context')!;
    expect(tool.description).toContain('If the result has relevance.relevant === false');
    expect(client.getInstructions()).toContain('If the result has relevance.relevant === false');
    // The one case in which max_tokens does not drop the item that ranks last first is told where the budget is described.
    expect(tool.description).toContain(CONTEXT_RELEVANCE_KEEPS_MATCH);
    expect(client.getInstructions()).not.toContain(CONTEXT_RELEVANCE_KEEPS_MATCH);
    // And what the budget keeps first: the newest match above that bar.
    expect(tool.description).toContain(CONTEXT_BUDGET_KEEPS_NEWEST);
    expect(client.getInstructions()).not.toContain(CONTEXT_BUDGET_KEEPS_NEWEST);

    await saveDogFact(client);
    await call(client, 'index_memory', {});

    // Fact vectors fill in the background after the first call; until then a "no match" verdict is withheld.
    const settled = async (query: string) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const body = await call(client, 'get_context', { query });
        if (body.relevance) return body;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`no relevance verdict for "${query}"`);
    };
    const hit = await settled('What is my dog name?');
    expect(hit.relevance).toMatchObject({ relevant: true, bar: 0.3 });
    const miss = await settled('quantum chromodynamics gluon lagrangian');
    expect(miss.relevance).toMatchObject({ relevant: false, bar: 0.3 });
    expect(miss.relevance.reason).toMatch(/no stored fact or note closely matches/);
  });

  it('gives search_memory the same verdict over its hits, said in one sentence of its description (findings inventory 7)', async () => {
    const client = await start({ RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0.3' });
    const tool = (await client.listTools()).tools.find(t => t.name === 'search_memory')!;
    expect((tool.description ?? '').endsWith(SEARCH_RELEVANCE_GUIDANCE)).toBe(true);
    await saveDogFact(client);
    await call(client, 'index_memory', {});
    const searched = async (query: string) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const body = await call(client, 'search_memory', { query });
        if (body.relevance) return body;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`no relevance verdict for "${query}"`);
    };
    const hit = await searched('What is my dog name?');
    expect(hit.relevance).toMatchObject({ relevant: true, bar: 0.3 });
    expect(hit.hits.length).toBeGreaterThan(0);
    // A question never saved still gets its nearest hits, now with a verdict that none of them answers it.
    const miss = await searched('quantum chromodynamics gluon lagrangian');
    expect(miss.hits.length).toBeGreaterThan(0);
    expect(miss.relevance).toEqual({ relevant: false, reason: NO_STRONG_MATCH, similarity: expect.any(Number), bar: 0.3 });
  });

  /**
   * The end of the intermittency: a workspace busy enough that a search's page is all note chunks about the question's
   * own subject. The fact lane is then the better lane, and the page holds neither the fact (the facts lane ranks by
   * the query's words and top_k leaves it no room) nor its ledger event (boilerplate that does not rank, which is why
   * the fact lane exists). Before the fix `relevant: true` was measured over the bar and then withheld, so the
   * response carried no `relevance` at all: the agent could not tell "the answer is on file" from "cannot judge". On a
   * workspace with fewer notes the same query and the same fact did carry the verdict, which is what made it read as
   * intermittent rather than absent.
   *
   * A full page cannot take one more hit without breaking the tool's own promise that the hits are at most top_k, so the
   * verdict names the fact (`relevance.fact`) instead of the page carrying top_k + 1.
   */
  it('still reports the verdict on a page of notes about the same subject, and the page stays inside top_k', async () => {
    // The bar sits between the two lanes on this fixture (the best note chunk 0.365, the fact rendering 0.516), so a
    // relevant verdict can only be the fact lane's: the question is which lane the page holds, not whether one clears.
    const client = await start({ RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0.4' }, Array.from({ length: 24 },
      (_, i) => `Standup ${i}: my favorite editor setup discussion, notes about the editor theme and keymap.`));
    await saveEditorFact(client);
    await call(client, 'index_memory', {});
    const searched = async (query: string, args: Record<string, unknown> = {}) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const body = await call(client, 'search_memory', { query, ...args });
        if (body.relevance) return body;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`no relevance verdict for "${query}"`);
    };
    for (const top_k of [8, 20]) {
      const found = await searched('what is my favorite editor', { top_k });
      expect(found.relevance, `top_k ${top_k}`).toMatchObject({ relevant: true, similarity: 0.516, bar: 0.4 });
      // The response says what the verdict is about, and the page never passes top_k.
      expect(found.relevance.fact, `top_k ${top_k}`).toEqual({ subject: 'user', predicate: 'preferred_editor', object: 'Neovim', scope: 'global' });
      expect(found.hits.length, `top_k ${top_k}`).toBeLessThanOrEqual(top_k);
    }
    // Where the page can hold the fact, the verdict is the plain one the tool has always sent and the page carries the
    // fact's own event (the ledger chunk), so no name is needed.
    const room = await searched('what is my favorite editor', { top_k: 50 });
    expect(room.relevance).toMatchObject({ relevant: true, similarity: 0.516, bar: 0.4 });
    expect(room.relevance).not.toHaveProperty('fact');
    expect(room.hits.some((hit: { text: string }) => hit.text.includes('Neovim'))).toBe(true);
    expect(room.hits.length).toBeLessThanOrEqual(50);
    // A question never saved is still told so on the same page, and names nothing.
    const miss = await searched('quantum chromodynamics gluon lagrangian');
    expect(miss.relevance).toMatchObject({ relevant: false, reason: NO_STRONG_MATCH, bar: 0.4 });
    expect(miss.relevance).not.toHaveProperty('fact');
  });

  /**
   * The lane only ever adds something: a query whose verdict the page already held, or whose "not relevant" is about
   * the store, answers exactly as it did before the verdict could name a fact. Measured over the live tool by running
   * the same query with the lane armed and disarmed on one server: the hits are the same list, in the same order, with
   * the same values — the only difference is the `relevance` key itself. (Scores are rounded because the recency boost
   * moves them by ~1e-10 between two calls, which is not what this is about.)
   */
  it('answers a query that already carried a verdict exactly as the lane without naming a fact would', async () => {
    const client = await start({ RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0.3' });
    await saveDogFact(client);
    await call(client, 'index_memory', {});
    const settled = async (query: string) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const body = await call(client, 'search_memory', { query });
        if (body.relevance) return body;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`no relevance verdict for "${query}"`);
    };
    const hitsOf = (body: { hits: Array<Record<string, unknown>> }) => JSON.stringify(body.hits.map(hit =>
      Object.fromEntries(Object.entries(hit).map(([k, v]) => [k, k === 'score' ? Number(v).toFixed(6) : v]))));

    for (const query of ['What is my dog name?', 'quantum chromodynamics gluon lagrangian']) {
      const armed = await settled(query);
      // With the lane disarmed the reply is the one a build that could not name a fact returned, minus the verdict.
      process.env.RENOR_CONTEXT_RELEVANCE = '0';
      const disarmed = await call(client, 'search_memory', { query });
      process.env.RENOR_CONTEXT_RELEVANCE = '1';
      expect(armed.relevance, query).toBeDefined();
      expect(disarmed).not.toHaveProperty('relevance');
      expect(hitsOf(armed), query).toBe(hitsOf(disarmed));
    }
  });
});
