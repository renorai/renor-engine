import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { engineSearchMemory } from '../../src/mvp/engine';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { EvidenceExtractor } from '../../src/evidence/secondPass';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * The same notes, indexed again, answer every read the same, byte for byte.
 *
 * index_memory indexes several notes at once, and an embedding provider answers each one after its own delay (a real
 * one does: hundreds of milliseconds that vary per request), so every pass stores the notes' vectors in another order,
 * and chunk row ids can differ too. Reads used to break score ties by exactly that order (sqlite-vec picks among
 * equally near vectors by where it stored them, FTS5 gives equal BM25 scores in row-id order, a name two notes share
 * resolved to the note written first), so the same question over the same memory answered differently after a
 * re-index, and two runs of a benchmark disagreed for no reason in the code under test.
 *
 * Synthetic data only: a temporary vault, loopback, the deterministic eval-hash embeddings delayed per file by a hash
 * of the run and the text. The vault has no wikilinks: a link is resolved against the notes already indexed when its
 * note is, so which links resolve still depends on the order. That is not a tie, and it is not fixed here.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const RUNS = 4;
const TIMEOUT_MS = 180_000;

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_DB_PATH', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER',
  'RENOR_SEARCH_EVIDENCE', 'RENOR_READ_HONESTY', 'RENOR_CONTEXT_RELEVANCE',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

/** Eval-hash vectors, each file's after a delay of 0-39 ms that differs per run: the notes finish in another order. */
class DelayedProvider extends EvalHashEmbeddingProvider {
  constructor(private readonly run: number) { super(); }
  async embed(texts: string[]): Promise<number[][]> {
    const digest = crypto.createHash('sha256').update(`${this.run}\n${texts.join('\n')}`).digest();
    await new Promise(resolve => setTimeout(resolve, digest[0] % 40));
    return super.embed(texts);
  }
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

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'index-order-determinism', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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

/** Notes whose chunks tie on purpose: shared sections and sentences, repeated daily entries, one title on two notes. */
async function writeVault(dir: string): Promise<void> {
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const shared = '## Notes\n\nNothing else to add here yet.\n\n## Review\n\nReviewed by the team on Friday.\n';
  ['Atlas', 'Beacon', 'Comet', 'Delta', 'Ember', 'Falcon', 'Garnet', 'Harbor'].forEach((name, i) => {
    write(`Projects/${name}.md`, [
      '---', `status: ${i % 2 ? 'active' : 'paused'}`, `tags: [project, ${name.toLowerCase()}]`, '---', `# ${name}`, '',
      '## Goal', '', `${name} ships the ${['sync', 'search', 'billing', 'import'][i % 4]} service for the memory engine.`, '',
      '## Decision', '', `We deploy ${name} on Fly.io first and keep Postgres managed.`, '', shared,
    ].join('\n'));
  });
  // Two notes titled Comet next to each other, and two that share an alias.
  write('Projects/Comet notes.md', '# Comet\n\nLoose notes about the Comet rollout.\n\n' + shared);
  write('Archive/Atlas.md', '---\naliases: [launchpad]\n---\n# Atlas\n\nThe archived Atlas plan from last year.\n\n' + shared);
  write('Archive/Beacon.md', '---\naliases: [launchpad]\n---\n# Beacon\n\nOld Beacon sketch.\n\n' + shared);
  for (const person of ['Ana', 'Bruno', 'Carla', 'Davi', 'Elis', 'Fabio']) {
    write(`People/${person}.md`, `# ${person}\n\nPrefers async updates over meetings.\n\n## Contact\n\nReach out on the team chat.\n`);
  }
  for (let d = 1; d <= 9; d++) {
    write(`Memory/Daily/2026-09-0${d}.md`, [
      '---', 'kind: note', `updated: 2026-09-0${d}`, '---', `# 2026-09-0${d}`, '',
      '- [09:00:00] (mcp) standup: nothing blocking',
      '- [10:30:00] (mcp) reviewed the deployment checklist',
      `- [17:00:00] (mcp) wrapped up the day ${d % 3 === 0 ? 'early' : 'late'}`, '',
    ].join('\n'));
  }
  for (const rock of ['Quartz', 'Pumice', 'Basalt', 'Granite', 'Obsidian', 'Marble', 'Slate', 'Shale']) {
    write(`Geology/${rock}.md`, `# ${rock}\n\n${rock} rock sample.\n`);
  }
  // Remembered facts: the ledger every run replays.
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-order-seed-'));
  const seed = openDb(path.join(seedDir, 'seed.db'));
  runMigrations(seed);
  for (const [subject, predicate, object] of [['Atlas', 'status', 'shipping'], ['Beacon', 'status', 'paused'], ['Rowan', 'dog_name', 'Rex']]) {
    await remember(seed, dir, DEFAULT_LEDGER_REL, { subject, predicate, object, statement: `${subject} ${predicate} is ${object}.` });
  }
  seed.close();
  fs.rmSync(seedDir, { recursive: true, force: true });
  // One modification time for every file, long ago: no recency boost, one session date, the same in every run.
  const then = new Date('2025-01-01T00:00:00.000Z');
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) fs.utimesSync(path.join(entry.parentPath, entry.name), then, then);
  }
}

interface Run {
  /** Every read, as the exact text an agent receives (or, for the CLI and the evidence pass, the exact bytes they use). */
  answers: Record<string, string>;
  /** The notes in the order the vector table stores their chunks' vectors: what the delays change. */
  storedOrder: string[];
  /** How many entities each of NAMES matches by name or alias. */
  entitiesNamed: Record<string, number>;
}

// The last three share no word with any note: every chunk ties at the edge of the semantic window.
const QUESTIONS = ['nothing else to add', 'async updates over meetings', 'what is the deployment plan', 'standup blocking', 'my dog', 'zebra quantum', 'walrus origami', 'xylophone nebula'];
const KEYWORDS = ['nothing else to add', 'billing', 'standup', 'reviewed', 'prefers'];
const NAMES = ['Comet', 'launchpad', 'Atlas', 'Proj', 'Ana'];

async function indexAndRead(memoryDir: string, run: number): Promise<Run> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-order-run-'));
  const port = await freePort();
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_DB_PATH = path.join(root, 'index.db');
  process.env.MVP_AUTH_STATE_PATH = path.join(root, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'RENOR_READ_HONESTY', 'RENOR_CONTEXT_RELEVANCE']) delete process.env[key];
  process.env.RENOR_SEARCH_EVIDENCE = '0'; // the evidence pass is driven below, with a recording stand-in for the model
  const config = loadMvpConfig();
  const service = await startMvpService(config, new DelayedProvider(run));
  const client = new Client({ name: 'index-order-determinism', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL(MVP_MCP_PATH, `http://127.0.0.1:${port}`),
      { requestInit: { headers: { Authorization: `Bearer ${await authorize(service.app)}` } } },
    ));
    // Sequential: one stateless MCP server answers every call.
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      return (res.content as Array<{ text: string }>)[0].text;
    };
    const indexed = JSON.parse(await call('index_memory'));
    expect(indexed.errors, JSON.stringify(indexed)).toBe(0);

    const answers: Record<string, string> = {};
    for (const query of QUESTIONS) {
      answers[`get_context ${query}`] = await call('get_context', { query, max_tokens: 4000 });
      answers[`search_memory ${query}`] = await call('search_memory', { query });
    }
    for (const query of KEYWORDS) answers[`search_text ${query}`] = await call('search_text', { query });
    for (const name of NAMES) answers[`lookup_entity ${name}`] = await call('lookup_entity', { name });
    // `renor search --json`: the benchmark client's transport, which prints these fields of retrieveContext's hits.
    const provider = service.engine.provider!;
    for (const query of ['nothing else to add', 'zebra quantum', 'what is the deployment plan']) {
      const { hits } = await retrieveContext(service.db, service.engine.vectorIndex!, provider, query, 20);
      answers[`cli search ${query}`] = JSON.stringify({ hits: hits.map(h => ({ notePath: h.notePath, score: h.score, reason: h.reason, text: h.text, ...(h.session_date ? { session_date: h.session_date } : {}) })) });
    }
    // The evidence pass: which sessions it chose, in which order, is the prompt its model would receive.
    const prompts: string[] = [];
    const chat = async (req: { messages: Array<{ content: string }> }) => {
      prompts.push(req.messages[0].content);
      return { content: '{"items":[]}', latencyMs: 1 };
    };
    await engineSearchMemory(service.db, service.engine, memoryDir, 'what is the deployment plan', 20, undefined, {
      options: { mode: 'always', model: 'stand-in', maxSessions: 12, charCap: 6000, chat: chat as any },
      extractor: new EvidenceExtractor({ chat: chat as any }),
    });
    expect(prompts).toHaveLength(1);
    answers['evidence prompt'] = prompts[0];

    const storedOrder = (service.db.prepare(
      'SELECT c.note_path FROM chunk_embeddings_rowids r JOIN chunks c ON c.id = r.rowid ORDER BY r.chunk_id, r.chunk_offset',
    ).pluck().all() as string[]).filter((note, i, all) => all.indexOf(note) === i);
    const named = service.db.prepare(
      `SELECT COUNT(DISTINCT e.id) FROM entities e LEFT JOIN json_each(e.aliases_json) a
       WHERE e.canonical_name = ? COLLATE NOCASE OR lower(a.value) = lower(?)`,
    ).pluck();
    const entitiesNamed = Object.fromEntries(NAMES.map(name => [name, named.get(name, name) as number]));
    return { answers, storedOrder, entitiesNamed };
  } finally {
    await client.close();
    service.httpServer.closeAllConnections?.();
    await new Promise<void>(resolve => service.httpServer.close(() => resolve()));
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the same vault indexed concurrently, again and again, answers every read the same', () => {
  let memoryDir: string;
  const runs: Run[] = [];

  beforeAll(async () => {
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-order-vault-'));
    await writeVault(memoryDir);
    for (let run = 1; run <= RUNS; run++) runs.push(await indexAndRead(memoryDir, run));
  }, TIMEOUT_MS);

  afterAll(() => {
    fs.rmSync(memoryDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('the runs stored the notes in different orders (otherwise this test proves nothing)', () => {
    expect(new Set(runs.map(r => r.storedOrder.join('\n'))).size).toBeGreaterThan(1);
  });

  it('the reads meet equal scores and shared names (otherwise this test proves nothing)', () => {
    const scores = (key: string, list: 'hits' | 'results') =>
      (JSON.parse(runs[0].answers[key])[list] as Array<{ score: number }>).map(h => h.score);
    const repeats = (values: number[]) => values.length - new Set(values).size;
    expect(repeats(scores('search_text nothing else to add', 'results'))).toBeGreaterThan(0);
    expect(repeats(scores('search_memory zebra quantum', 'hits'))).toBeGreaterThan(0);
    expect(repeats(scores('search_memory async updates over meetings', 'hits'))).toBeGreaterThan(0);
    expect(runs[0].entitiesNamed).toMatchObject({ Comet: 2, launchpad: 2 });
  });

  it('every answer of every run is byte-identical to the first run\'s', () => {
    expect(Object.keys(runs[0].answers)).toHaveLength(QUESTIONS.length * 2 + KEYWORDS.length + NAMES.length + 3 + 1);
    const differing = runs.slice(1).map(run => Object.keys(runs[0].answers).filter(key => run.answers[key] !== runs[0].answers[key]));
    expect(differing).toEqual(runs.slice(1).map(() => []));
  });

  it('settles a tie by place in every run: equal scores by note path, a shared name to the first note by path', () => {
    for (const run of runs) {
      const results = JSON.parse(run.answers['search_text nothing else to add']).results as Array<{ notePath: string; score: number }>;
      for (let i = 1; i < results.length; i++) {
        if (results[i].score === results[i - 1].score) expect(results[i - 1].notePath < results[i].notePath).toBe(true);
      }
      expect(JSON.parse(run.answers['lookup_entity Comet']).entity.sourceNote).toBe('Projects/Comet notes.md');
      expect(JSON.parse(run.answers['lookup_entity launchpad']).entity.sourceNote).toBe('Archive/Atlas.md');
    }
  });
});
