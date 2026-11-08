import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Express } from 'express';
import { loadMvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { FACTS_BUDGET_SHARE, buildAgentContext, replyTokens } from '../../src/mvp/agentMemory';
import { warmFactVectors } from '../../src/mvp/contextRelevance';
import type { Engine } from '../../src/mvp/engine';
import { identityLine } from '../../src/mvp/identity';
import { seedWorkspace } from '../../scripts/eval/relevance-calibration';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * get_context's facts lane on a returning user's workspace (first-week scout, findings F1 and F7).
 *
 * The lane used to count every word of the question, "in", "to" and "my" included, and to fill the budget before any
 * memory: "What time zone am I in?" returned ticket statuses ("in progress") and never the time zone, a question
 * nothing answers returned `zsh (oh-my-zsh)` on "my", and a dozen facts that each shared "Atlas" with the question cut
 * the note that answered it. The MCP tests run a keyword-only workspace (no embedding provider), which is what a
 * self-serve workspace runs; the relevance tests use the deterministic eval-hash embeddings. No model, no network.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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

async function token(app: Express): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'facts-lane', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorize.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({
    ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
  }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  return tokens.body.access_token as string;
}

type Fact = { subject: string; predicate: string; object: string; scope: string };
type Memory = { text: string; reason: string; session_date?: string };
type Context = { facts: Fact[]; memories: Memory[]; truncated: boolean; maxTokens: number; relevance?: { relevant: boolean } };

/** A keyword-only workspace (no embedding provider) behind the real MCP tools; calls run one at a time. */
async function keywordWorkspace(): Promise<(name: string, args?: Record<string, unknown>) => Promise<any>> {
  const memoryDir = tmp('facts-lane-');
  const port = await freePort();
  const saved = { ...process.env };
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(tmp('facts-lane-auth-'), 'clients.json'),
    MVP_BASE_URL: `http://127.0.0.1:${port}`,
    MVP_OWNER_EMAIL: OWNER_EMAIL,
    MVP_OWNER_PASSWORD: OWNER_PASSWORD,
    MVP_PORT: String(port),
    MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
    RENOR_SEARCH_EVIDENCE: '0',
  });
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.RENOR_READ_HONESTY;
  const config = loadMvpConfig();
  const service = await startMvpService(config, null);
  const client = new Client({ name: 'facts-lane', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${await token(service.app)}` } } },
  ));
  cleanups.push(async () => {
    await client.close();
    service.httpServer.closeAllConnections?.();
    service.httpServer.close();
    await service.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };
}

const factLine = (f: Fact) => `${f.subject} · ${f.predicate} · ${f.object}`;
const chars = (items: unknown[]) => items.reduce<number>((n, item) => n + JSON.stringify(item).length, 0);

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the facts lane matches the words of the question, not its stop words (F1)', () => {
  it("finds the time zone, not tickets that are 'in' progress, and nothing for a question never saved", async () => {
    // The scout's reproduction, verbatim (report §2, F1).
    const call = await keywordWorkspace();
    await call('remember', { statement: "I'm based in São Paulo.", subject: 'user', predicate: 'timezone', object: 'America/Sao_Paulo' });
    await call('remember', { statement: 'ATL-1 is in progress.', subject: 'ATL-1', predicate: 'status', object: 'in progress' });
    await call('remember', { statement: 'ATL-2 is in review.', subject: 'ATL-2', predicate: 'status', object: 'in review' });

    const timeZone = await call('get_context', { query: 'What time zone am I in?' }) as Context;
    expect(timeZone.facts.map(factLine)).toEqual(['user · timezone · America/Sao_Paulo']);

    await call('remember', { statement: 'My shell is zsh with oh-my-zsh.', subject: 'user', predicate: 'shell', object: 'zsh (oh-my-zsh)' });
    const dentist = await call('get_context', { query: 'Who is my dentist?' }) as Context;
    expect(dentist.facts).toEqual([]);
    expect(dentist.memories).toEqual([]);
    // The fact is still found by what it is about.
    const shell = await call('get_context', { query: 'Which shell do I use?' }) as Context;
    expect(shell.facts.map(factLine)).toEqual(['user · shell · zsh (oh-my-zsh)']);
  });

  it('keeps a two-letter word that names the topic (CI)', async () => {
    const call = await keywordWorkspace();
    await call('remember', { statement: 'Atlas CI runs on GitHub Actions.', subject: 'Atlas', predicate: 'ci', object: 'GitHub Actions' });
    for (let i = 0; i < 12; i++) {
      await call('remember', { statement: `Atlas service ${i} listens on port ${8000 + i}.`, subject: `Atlas service s${i}`, predicate: 'port', object: String(8000 + i) });
    }
    const ci = await call('get_context', { query: 'Which CI does Atlas use?' }) as Context;
    expect(ci.facts.map(factLine)[0]).toBe('Atlas · ci · GitHub Actions');
  });

  it('reads two neighbouring words as the key an agent wrote as one ("time zone" is `timezone`), never across a stop word', async () => {
    const call = await keywordWorkspace();
    await call('remember', { statement: 'The homelab runs Proxmox 8.', subject: 'homelab', predicate: 'hypervisor', object: 'Proxmox 8' });
    await call('remember', { statement: 'ATL-9 is todo.', subject: 'ATL-9', predicate: 'status', object: 'todo' });

    const lab = await call('get_context', { query: 'What runs in my home lab?' }) as Context;
    expect(lab.facts.map(factLine)).toEqual(['homelab · hypervisor · Proxmox 8']);
    // "to do" is two stop words, not the status `todo`.
    const today = await call('get_context', { query: 'What do I need to do today?' }) as Context;
    expect(today.facts).toEqual([]);
  });
});

/** The scout's persona up to day 4 (week-plan.mjs): the Atlas facts, the Fly.io decision record, and its reversal. */
async function atlasWeek(call: (name: string, args?: Record<string, unknown>) => Promise<any>): Promise<void> {
  const A = 'project:atlas';
  const facts: Array<[string, string, string, string, string?]> = [
    ['Atlas runs on Postgres 15 on AWS RDS.', 'Atlas', 'database', 'Postgres 15 (AWS RDS)', A],
    ['The Atlas backend is FastAPI on Python 3.12.', 'Atlas', 'backend_framework', 'FastAPI (Python 3.12)', A],
    ['Ravi is on call for Atlas this week.', 'Atlas', 'on_call', 'Ravi', A],
    ['Atlas ships a release every Tuesday.', 'Atlas', 'release_cadence', 'every Tuesday', A],
    ['The Atlas staging database host is staging-db.atlas.internal.', 'staging database', 'host', 'staging-db.atlas.internal', A],
    ['We decided to move Atlas deploys from Heroku to Fly.io.', 'Atlas project', 'deploy_target', 'Fly.io', A],
  ];
  for (const [statement, subject, predicate, object, scope] of facts) await call('remember', { statement, subject, predicate, object, ...(scope ? { scope } : {}) });
  await call('remember', {
    statement: 'Decision record (Atlas deploys): moving from Heroku to Fly.io to cut hosting cost (Heroku about $410/month vs Fly about $150/month) and to get a São Paulo region close to customers. Owner: Lena. Revisit after the load test on Thursday.',
    scope: A,
  });
  const later: Array<[string, string, string, string, string?]> = [
    ['The Atlas public API is rate limited to 600 requests per minute per tenant.', 'Atlas', 'api_rate_limit', '600 requests/min per tenant', A],
    ['Sofia is the product manager for Atlas.', 'Sofia', 'role', 'product manager for Atlas', A],
    ['Ravi owns Atlas billing.', 'Ravi', 'owns', 'Atlas billing', A],
    ['Homelab backups run nightly at 02:00 with restic to the Synology NAS.', 'homelab backups', 'schedule', 'nightly at 02:00 (restic to Synology)', 'project:homelab'],
    ['Atlas is on Postgres 16 now; we upgraded RDS last night.', 'Atlas', 'database', 'Postgres 16 (AWS RDS)', A],
    ['Atlas Postgres major version is 16.', 'Atlas', 'postgres_version', '16', A],
    ['We raised the Atlas API rate limit to 1200 requests per minute per tenant.', 'Atlas', 'api_rate_limit', '1200 requests/min per tenant'],
    ['Sofia is on call for Atlas starting today.', 'Atlas', 'on_call', 'Sofia', A],
    ["The Fly.io load test failed, so we're reversing the decision: Atlas stays on AWS and deploys to ECS Fargate.", 'Atlas', 'deploy_target', 'AWS ECS Fargate', A],
  ];
  for (const [statement, subject, predicate, object, scope] of later) await call('remember', { statement, subject, predicate, object, ...(scope ? { scope } : {}) });
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('facts do not crowd out the note that answers the question (F1)', () => {
  it('returns the Fly.io decision record within the default 800 tokens, with a dozen Atlas facts on file', async () => {
    const call = await keywordWorkspace();
    await atlasWeek(call);
    const body = await call('get_context', { query: 'Why did we consider moving Atlas to Fly.io?' }) as Context;
    expect(body.maxTokens).toBe(800);
    expect(body.memories.some(m => m.text.includes('$410/month'))).toBe(true);
    // The fact the question is about, not every fact that says "Atlas". The reversal fact also lists: its saved statement
    // names Fly.io and the decision it reverses, so it shares the question's words (statement words count, see
    // statement_words in migration 24). It costs about 47 tokens on this reply.
    expect(body.facts.map(factLine)).toEqual([
      'Atlas project · deploy_target · Fly.io',
      'Atlas · deploy_target · AWS ECS Fargate',
    ]);
  });

  it('keeps room for the memories when facts would fill the budget, and gives back what the memories leave', async () => {
    const call = await keywordWorkspace();
    await call('remember', { statement: 'Zebra survey: the herd crossed the river on Monday.' });
    // save_memory leaves the search index alone, so the note above is the only memory that matches.
    for (let i = 1; i <= 12; i++) await call('save_memory', { subject: `zebra ${i}`, predicate: 'stripe_count', object: `${30 + i} stripes, counted at the river crossing` });
    const maxTokens = 300;
    // Every get_context reply names the Renor that answered (`renor`, B1), inside max_tokens: the call adds what that
    // line costs, so the items get the room this budget gave them before it.
    const identity = replyTokens(`{"maxTokens":0,"renor":${JSON.stringify(identityLine(undefined))}}`) - replyTokens('{"maxTokens":0}');
    const body = await call('get_context', { query: 'zebra', max_tokens: maxTokens + identity }) as Context;
    expect(body.memories.map(m => m.text)).toEqual([expect.stringContaining('the herd crossed the river')]);
    // The note was small: the facts got the room it left, past their share.
    expect(chars(body.facts)).toBeGreaterThan(maxTokens * 4 * FACTS_BUDGET_SHARE);
    expect(chars(body.facts) + chars(body.memories)).toBeLessThanOrEqual(maxTokens * 4);
    expect(body.facts.length).toBeLessThan(12);
    expect(body.truncated).toBe(true);
  });
});

// --- the relevance signal (F7) --------------------------------------------------------------------------------------

/**
 * The eval-hash embeddings, taught one paraphrase: a question about where the user is "based" means their home city.
 * A semantic model knows that; the lexical stub needs to be told. Deterministic, no model.
 */
class ParaphraseProvider extends EvalHashEmbeddingProvider {
  async embedQuery(text: string): Promise<number[]> {
    return super.embedQuery(text.replace(/\bbased\b/gi, 'home city'));
  }
}

const RELEVANCE_SEED: Parameters<typeof seedWorkspace>[2] = {
  facts: [
    { subject: 'user', predicate: 'home_city', object: 'Lisbon' },
    { subject: 'user', predicate: 'dog_name', object: 'Biscuit' },
    { subject: 'Atlas', predicate: 'cloud_region', object: 'eu-west-1', scope: 'project:atlas' },
  ],
  notes: [{ slug: 'japan', date: '2026-08-20', text: 'Trip to Japan planned for April. Flights booked with TAP, landing in Tokyo on April 3rd.' }],
};

async function relevanceWorkspace(seed = RELEVANCE_SEED, { dated = false } = {}) {
  const root = tmp('facts-lane-relevance-');
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  const db = openDb(path.join(root, 'index.db'));
  cleanups.push(() => { db.close(); });
  runMigrations(db);
  const provider = new ParaphraseProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await seedWorkspace(db, memoryDir, seed);
  // `dated`: each note written on its own day, as a returning user's are, so newest first goes by day.
  if (dated) {
    const daily = path.join(memoryDir, 'Memory/Daily');
    for (const file of fs.readdirSync(daily)) {
      const day = new Date(`${file.slice(0, 10)}T09:00:00Z`);
      fs.utimesSync(path.join(daily, file), day, day);
    }
  }
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 2);
  const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'test:hash:256' };
  await warmFactVectors(db, provider);
  const ask = (query: string, env: Record<string, string>, scope?: string, maxTokens?: number) =>
    buildAgentContext(db, engine, memoryDir, { query, env: env as NodeJS.ProcessEnv, ...(scope ? { scope } : {}), ...(maxTokens ? { maxTokens } : {}) }) as Promise<Context>;
  return { ask };
}

const ARMED = { RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0.4' };

describe('a relevant verdict describes something in the response (F7)', () => {
  it('when the words find no fact, the fact closest in meaning stands in, so "relevant" is not about a fact left out', async () => {
    const w = await relevanceWorkspace();
    const body = await w.ask('Where am I based?', ARMED);
    expect(body.relevance?.relevant).toBe(true);
    expect(body.facts.map(factLine)).toEqual(['user · home_city · Lisbon']);
    // With the signal off the words alone decide, and they find no fact.
    const off = await w.ask('Where am I based?', { RENOR_CONTEXT_RELEVANCE: '0' });
    expect(off.facts).toEqual([]);
  });

  it('when the words find another fact, the closest one is listed after it, never in its place', async () => {
    const w = await relevanceWorkspace();
    // The home city is the closest fact to this question (two shared words to the dog's one) and what the verdict is
    // about, but the words found the dog. It used to be left out, and "relevant" was about a fact the response lacked.
    const body = await w.ask('Where am I based, and what is the dog called?', { ...ARMED, RENOR_CONTEXT_RELEVANCE_MIN: '0.3' });
    expect(body.relevance?.relevant).toBe(true);
    expect(body.facts.map(factLine)).toEqual(['user · dog_name · Biscuit', 'user · home_city · Lisbon']);
  });

  it('keeps that fact within max_tokens when the verdict reports it, though the facts the words found would fill it', async () => {
    const dog = ['breed: beagle from a breeder in Porto', 'vet: Dr Silva at the corner clinic', 'food: Orijen puppy formula',
      'walker: Ana on weekday mornings', 'birthday: the third of March', 'insurance: PetPlan basic cover', 'groomer: the shop on Rua Augusta',
      'park: Parque Eduardo VII', 'trainer: Rui on Saturdays', 'microchip: registered with SIRA', 'bed: the basket in the hall'];
    const w = await relevanceWorkspace({
      facts: [
        { subject: 'user', predicate: 'home_city', object: 'Lisbon' },
        ...dog.map(fact => ({ subject: 'user', predicate: `dog_${fact.split(':')[0]}`, object: fact.split(': ')[1] })),
      ],
      notes: [{ slug: 'japan', date: '2026-08-20', text: 'Trip to Japan planned for April. Flights booked with TAP, landing in Tokyo on April 3rd.' }],
    });
    const maxTokens = 200;
    const body = await w.ask('Where am I based, and what is the dog called?', { ...ARMED, RENOR_CONTEXT_RELEVANCE_MIN: '0.3' }, undefined, maxTokens);
    expect(body.relevance?.relevant).toBe(true);
    expect(body.facts.map(factLine)).toContain('user · home_city · Lisbon');
    expect(body.facts[0].predicate).toMatch(/^dog_/); // what the words found still comes first
    expect(chars(body.facts) + chars(body.memories)).toBeLessThanOrEqual(maxTokens * 4);
    expect(body.truncated).toBe(true);
  });

  it('a closest fact the verdict does not report takes only the room the rest leaves', async () => {
    // Notes about the dog are closer to this question than any fact is, so the verdict reports one of them; the home city
    // still clears the bar. It is listed when there is room for it, and never at the cost of anything else.
    // The closest of them (the walker) is the newest, so it leads the memories and the budget never has to make room for it.
    const dogNotes = ['Where is the dog leash? It is in the car.', 'What the vet called about: the dog is due for a booster.',
      'What is the dog food brand called? Orijen.', 'The dog groomer called; the appointment is Friday.',
      'Where the dog sleeps: the bed in the hall.', 'The dog walker is called Ana; where she parks is the side street.'];
    const w = await relevanceWorkspace({
      facts: RELEVANCE_SEED.facts,
      notes: dogNotes.map((text, i) => ({ slug: `dog-${i}`, date: `2026-09-2${i}`, text })),
    }, { dated: true });
    const query = 'Where am I based, and what is the dog called?';
    const env = { ...ARMED, RENOR_CONTEXT_RELEVANCE_MIN: '0.3' };
    const roomy = await w.ask(query, env);
    expect(roomy.relevance?.relevant).toBe(true);
    expect(roomy.facts.map(factLine)).toEqual(['user · dog_name · Biscuit', 'user · home_city · Lisbon']);
    // At every budget: what the response holds without the signal, and the home city only in the room that leaves.
    // max_tokens bounds the whole reply, and the verdict is part of it: the read without the signal has as much more room
    // as the verdict takes, give or take the few tokens by which a reply's pieces do not add up. From 224 the dog fact,
    // the note and the verdict fit together; below that the match comes first (the tests that follow).
    const memoryTexts = (body: Context) => body.memories.map(m => m.text);
    // The matches a budget cuts are cut by score, and listed newest first whatever was cut (agentMemory.ts applyBudget): more
    // room adds matches, each in its place in the list. What a reply holds with less room is in the reply with more, in the
    // same order; it used to be the head of that list, when the budget kept the newest matches.
    const inOrder = (less: string[], more: string[]) => less.length <= more.length && less.join('\u0000') === more.filter(text => less.includes(text)).join('\u0000');
    let listed = 0;
    let left = 0;
    for (let maxTokens = 224; maxTokens <= 416; maxTokens += 16) {
      const on = await w.ask(query, env, undefined, maxTokens);
      const verdict = replyTokens(JSON.stringify(on)) - replyTokens(JSON.stringify({ ...on, relevance: undefined }));
      const tight = await w.ask(query, { RENOR_CONTEXT_RELEVANCE: '0' }, undefined, maxTokens - verdict - 4);
      const off = await w.ask(query, { RENOR_CONTEXT_RELEVANCE: '0' }, undefined, maxTokens - verdict + 4);
      expect(inOrder(memoryTexts(tight), memoryTexts(on))).toBe(true);
      expect(inOrder(memoryTexts(on), memoryTexts(off))).toBe(true);
      expect(on.facts.slice(0, off.facts.length)).toEqual(off.facts);
      const extra = on.facts.slice(off.facts.length).map(factLine);
      expect(extra.length === 0 || extra.join() === 'user · home_city · Lisbon').toBe(true);
      expect(chars(on.facts) + chars(on.memories)).toBeLessThanOrEqual(maxTokens * 4);
      if (extra.length > 0) listed++;
      else left++;
    }
    expect(listed).toBeGreaterThan(0);
    expect(left).toBeGreaterThan(0);
  });

  it('keeps the note the verdict was judged on: newer notes listed before it make room, within max_tokens', async () => {
    // The scout's Fly.io case: the decision record is the best match, newer worklogs that say "Atlas" come first (newest
    // first), and the budget used to run out before the record while `relevant: true` reported the record's similarity.
    const worklog = (date: string) => `${date} Atlas worklog: reviewed the deploy dashboards, paired on the billing export, `
      + 'rotated the staging credentials, closed three tickets about webhook retries, updated the runbook for the nightly job, '
      + 'answered support questions about invoices, wrote notes for the planning meeting about capacity and the release train, '
      + 'chased the flaky integration suite, bumped two dependencies and drafted the incident summary for the queue backlog.';
    const w = await relevanceWorkspace({
      facts: [{ subject: 'Atlas', predicate: 'deploy_target', object: 'AWS ECS Fargate', scope: 'project:atlas' }],
      notes: [
        { slug: 'decision', date: '2026-09-24', text: 'Decision record: we considered moving Atlas to Fly.io to cut hosting cost (Heroku about $410/month vs Fly about $150/month).' },
        ...['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29'].map(date => ({ slug: date, date, text: worklog(date) })),
      ],
    }, { dated: true });
    const body = await w.ask('Why did we consider moving Atlas to Fly.io?', { ...ARMED, RENOR_CONTEXT_RELEVANCE_MIN: '0.45' });
    expect(body.relevance?.relevant).toBe(true);
    expect(body.memories.map(m => m.text)).toContainEqual(expect.stringContaining('$410/month'));
    expect(body.truncated).toBe(true);
    expect(chars(body.facts) + chars(body.memories)).toBeLessThanOrEqual(800 * 4);
    // Still newest first: what was cut to make room is a newer worklog listed before the record, not the record.
    const dates = body.memories.map(m => m.session_date ?? '');
    expect(dates).toEqual([...dates].sort().reverse());
    expect(body.memories.filter(m => m.text.includes('Atlas worklog')).length).toBeLessThan(5);
  });

  it('gives no verdict rather than one about a match too big for max_tokens on its own', async () => {
    const decision = 'Decision record: we considered moving Atlas to Fly.io to cut hosting cost, Heroku about $410/month vs Fly about '
      + '$150/month, to get a region close to our customers, to run the workers next to the database, to drop the review-app add-on '
      + 'that bills per branch, and to move the staging stack onto the same platform; the load test on Thursday decides it, and if '
      + 'it fails we stay on AWS, move the deploys to ECS Fargate and keep the RDS instance where it is, with the cost review in a month.';
    const w = await relevanceWorkspace({ facts: [], notes: [{ slug: 'decision', date: '2026-09-24', text: decision }] });
    const query = 'Why did we consider moving Atlas to Fly.io?';
    const tight = await w.ask(query, ARMED, undefined, 128);
    expect(tight.memories.map(m => m.text).join(' ')).not.toContain('$410/month');
    expect(tight).not.toHaveProperty('relevance');
    const roomy = await w.ask(query, ARMED);
    expect(roomy.relevance?.relevant).toBe(true);
    expect(roomy.memories.map(m => m.text).join(' ')).toContain('$410/month');
  });

  it('adds nothing when nothing on file is close enough, and only ever a fact of the scope read', async () => {
    const w = await relevanceWorkspace();
    const strict = { ...ARMED, RENOR_CONTEXT_RELEVANCE_MIN: '0.95' };
    const below = await w.ask('Where am I based?', strict);
    const off = await w.ask('Where am I based?', { RENOR_CONTEXT_RELEVANCE: '0' });
    expect(below.relevance?.relevant).toBe(false);
    expect(below.facts).toEqual([]);
    expect(below.memories.map(m => m.text)).toEqual(off.memories.map(m => m.text));

    const atlas = await w.ask('Where am I based?', ARMED, 'project:atlas');
    expect(atlas.facts.every(f => f.scope === 'project:atlas')).toBe(true);
    expect(JSON.stringify(atlas)).not.toContain('Lisbon');
  });
});
