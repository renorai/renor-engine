import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { engineSearchMemory, engineSearchText } from '../../src/mvp/engine';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { seedNewerFacts } from '../helpers/seedFacts';
import { startMvpServiceOnFreePort } from '../helpers/mvpPort';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * A saved fact must be findable at once, before anyone runs `index_memory`.
 *
 * The facts table is written by the save itself; the chunk index (full-text and embeddings) is
 * only as fresh as the last index run, and indexing on every write would re-chunk and re-embed
 * the whole ledger each time. So search reads current facts through the term index, and says so
 * (`index.stale`) while the semantic index is behind. Every call below is a real MCP call over
 * HTTP, with the deterministic eval-hash embeddings (no model, no network).
 */

// Each test boots a whole service (OAuth, MCP connect) and makes a dozen or more real calls; the first in a worker also pays
// the cold start. On a loaded 4-vCPU gate that alone can pass vitest's 5 s default, which bounds no product promise.
vi.setConfig({ testTimeout: 60_000 });

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const tmpDirs: string[] = [];
const stoppers: Array<() => Promise<void>> = [];

beforeEach(() => {
  process.env.RENOR_SEARCH_EVIDENCE = '0';
  delete process.env.RENOR_READ_HONESTY;
});

afterEach(async () => {
  while (stoppers.length) await stoppers.pop()!();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const name of ['MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'RENOR_SEARCH_EVIDENCE', 'RENOR_READ_HONESTY']) delete process.env[name];
});

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
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  return loadMvpConfig();
}

async function registerAndToken(app: Express): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'fact-visibility', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
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
  return tokens.body.access_token as string;
}

/** Eval-hash embeddings that count their calls, so a test can see whether a write embedded anything. */
class CountingProvider extends EvalHashEmbeddingProvider {
  calls = 0;
  async embed(texts: string[]) { this.calls += 1; return super.embed(texts); }
  async embedQuery(text: string) { this.calls += 1; return super.embedQuery(text); }
}

interface Session {
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  db: MvpApp['db'];
  engine: MvpApp['engine'];
  memoryDir: string;
  stop(): Promise<void>;
}

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-factvis-'));
  tmpDirs.push(dir);
  return dir;
}

/** Starts the service on `memoryDir` (a restart is a second call on the same directory). */
async function boot(memoryDir: string, provider: EmbeddingProvider | null = new EvalHashEmbeddingProvider()): Promise<Session> {
  // A probed port is only a hint: another process can bind it before the service does, so a taken port is probed again.
  const { started: service, config } = await startMvpServiceOnFreePort(port => makeConfig(memoryDir, port), provider);
  // A test that seeds thousands of facts in this process blocks the server's event loop for seconds. Node then runs the
  // server's 5 s keep-alive timer only after the client has written its next request on the idle socket, closes that
  // socket under it, and the call fails with ECONNRESET. No idle timeout here: stop() closes every connection itself.
  service.httpServer.keepAliveTimeout = 0;
  const client = new Client({ name: 'fact-visibility', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${await registerAndToken(service.app)}` } } },
  ));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await client.close();
    service.httpServer.closeAllConnections?.();
    service.httpServer.close();
    await service.close();
  };
  stoppers.push(stop);
  return {
    // One call at a time: the stateless JSON transport shares a single McpServer.
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0].text);
    },
    db: service.db,
    engine: service.engine,
    memoryDir,
    stop,
  };
}

/**
 * Saves a fact with `save_memory`, which does not refresh the search index. `remember` does, on this base
 * (it indexes the vault after every fact save so the user's own words are searchable), so a fact it saves
 * is already in the index; `save_memory` leaves the state these tests are about, and so does a `remember`
 * whose refresh fails.
 */
const save = (s: Session, subject: string, predicate: string, object: string, scope?: string) =>
  s.call('save_memory', { subject, predicate, object, ...(scope === undefined ? {} : { scope }) });

/** A fact hit's subject, predicate or object, read from the one form a fact is shown in: `subject — predicate: object`. */
const field = (hit: { text: string }, name: 'subject' | 'predicate' | 'object') =>
  /^(.*?) — ([^:\n]*): (.*)$/s.exec(hit.text)?.[{ subject: 1, predicate: 2, object: 3 }[name]];
/**
 * The remembered facts among hits, each by the moment it was saved. No read names the ledger or an event (a hit of a fact,
 * or of its event, has an empty note path and heading), so that is how one is told from a note, and which one it is.
 */
const moments = (hits: Array<{ notePath: string; session_date?: string }>) => hits.filter(h => h.notePath === '').map(h => h.session_date);
const factHits = (hits: Array<{ reason: string; text: string }>) => hits.filter(h => h.reason === 'fact');

const POSTGRES = { subject: 'production database', predicate: 'engine_and_extension', object: 'Postgres 16 with pgvector' };

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a saved fact is found before any index_memory (real MCP)', () => {
  it('search_text finds it by value, subject, predicate or any words of it, and nothing else', async () => {
    const s = await boot(workspace());
    const saved = await save(s, POSTGRES.subject, POSTGRES.predicate, POSTGRES.object);

    for (const query of ['Postgres', 'pgvector', 'production database', 'database engine', 'engine_and_extension', 'Postgres 16']) {
      const { ok, results } = await s.call('search_text', { query });
      expect(ok, query).toBe(true);
      expect(results, query).toHaveLength(1);
      expect(results[0], query).toMatchObject({ notePath: '', headingPath: '', reason: 'fact', session_date: saved.created.validFrom });
      expect(moments(results), query).toEqual([saved.created.validFrom]);
      expect(field(results[0], 'subject')).toBe(POSTGRES.subject);
      expect(field(results[0], 'predicate')).toBe(POSTGRES.predicate);
      expect(field(results[0], 'object')).toBe(POSTGRES.object);
    }
    // A keyword search needs every word: another version, or an unrelated term, is not this fact.
    for (const query of ['Postgres 17', 'kubernetes', 'production kubernetes']) {
      expect((await s.call('search_text', { query })).results, query).toEqual([]);
    }
  });

  it('search_memory returns it first, dated by when it was saved, without displacing an indexed note', async () => {
    const dir = workspace();
    fs.mkdirSync(path.join(dir, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Notes', 'staging.md'), '# Staging\n\nStaging deploy uses make deploy-staging.\n');
    const s = await boot(dir);
    await s.call('index_memory');
    const saved = await save(s, POSTGRES.subject, POSTGRES.predicate, POSTGRES.object);

    const body = await s.call('search_memory', { query: 'which database engine do we run in production?' });
    expect(body.ok).toBe(true);
    expect(body.hits[0]).toMatchObject({ notePath: '', headingPath: '', reason: 'fact', session_date: saved.created.validFrom });
    expect(moments(body.hits)).toEqual([saved.created.validFrom]);
    expect(body.hits.map((h: any) => h.notePath)).toContain('Notes/staging.md');
  });

  it('get_context finds a fact whose subject is a slug, by the words in the slug', async () => {
    const s = await boot(workspace());
    await save(s, 'zebra-stripe-spec', 'owner', 'Marta');
    await save(s, 'billing_webhook', 'retry_limit', '5');

    const owner = await s.call('get_context', { query: 'who owns the stripe spec?' });
    expect(owner.facts.map((f: any) => f.object)).toEqual(['Marta']);
    const retries = await s.call('get_context', { query: 'how many webhook retries are allowed?' });
    expect(retries.facts.map((f: any) => f.object)).toEqual(['5']);
  });

  it('survives a restart, and a rebuilt index.db, because the ledger is replayed into the facts table', async () => {
    const dir = workspace();
    const first = await boot(dir);
    const saved = await save(first, POSTGRES.subject, POSTGRES.predicate, POSTGRES.object);
    await first.stop();

    const second = await boot(dir);
    const check = async (s: Session, label: string) => {
      const text = await s.call('search_text', { query: 'pgvector' });
      expect(moments(text.results), `${label}: search_text`).toEqual([saved.created.validFrom]);
      const memory = await s.call('search_memory', { query: 'which database engine do we run in production?' });
      expect(moments(memory.hits), `${label}: search_memory`).toEqual([saved.created.validFrom]);
      const context = await s.call('get_context', { query: 'which database engine do we run in production?' });
      expect(context.facts.map((f: any) => f.object), `${label}: get_context`).toEqual([POSTGRES.object]);
    };
    await check(second, 'restarted');
    await second.stop();

    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dir, '.memory-index', `index.db${suffix}`), { force: true });
    await check(await boot(dir), 'index rebuilt from the ledger');
  }, 60_000);

  it('after index_memory the results are the indexed ones: the fact is not repeated', async () => {
    const s = await boot(workspace());
    const saved = await save(s, POSTGRES.subject, POSTGRES.predicate, POSTGRES.object);
    await s.call('index_memory');

    const text = await s.call('search_text', { query: 'Postgres' });
    expect(text.results).toHaveLength(1);
    expect(text.results[0].reason).toBe('fts');
    expect(moments(text.results)).toEqual([saved.created.validFrom]);
    const memory = await s.call('search_memory', { query: 'which database engine do we run in production?' });
    expect(factHits(memory.hits)).toEqual([]);
    expect(moments(memory.hits)).toEqual([saved.created.validFrom]);
  });

  it('a fact saved with remember is returned once, whether or not that save refreshed the index', async () => {
    const s = await boot(workspace());
    const saved = await s.call('remember', {
      statement: `${POSTGRES.subject} ${POSTGRES.predicate} ${POSTGRES.object}`,
      subject: POSTGRES.subject,
      predicate: POSTGRES.predicate,
      object: POSTGRES.object,
    });
    expect(saved.ok).toBe(true);

    expect(moments((await s.call('search_text', { query: 'pgvector' })).results)).toEqual([saved.created.validFrom]);
    expect(moments((await s.call('search_memory', { query: 'which database engine do we run in production?' })).hits)).toEqual([saved.created.validFrom]);
    expect((await s.call('get_context', { query: 'which database engine do we run in production?' })).facts.map((f: any) => f.object)).toEqual([POSTGRES.object]);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a table of ten thousand newer facts (real MCP)', () => {
  it('finds a fact saved before all of them, and one saved after, through all three tools', async () => {
    const s = await boot(workspace());
    const needle = await save(s, 'Zürich-stripe-spec', 'owner', '東京 Marta Quasar');
    seedNewerFacts(s.db, 10_050); // a heavy user's table: every one of these is newer than the needle

    expect(moments((await s.call('search_text', { query: '東京 Quasar' })).results)).toEqual([needle.created.validFrom]);
    expect(moments((await s.call('search_memory', { query: 'which person is the owner, Marta Quasar?' })).hits)).toEqual([needle.created.validFrom]);
    const context = await s.call('get_context', { query: 'who owns the stripe spec in 東京?' });
    expect(context.facts.map((f: any) => f.object)).toEqual(['東京 Marta Quasar']);

    // A fact saved now is dated before the seeded ones too, and is just as findable.
    const later = await save(s, 'billing', 'retry_policy', 'exponential backoff');
    expect(moments((await s.call('search_text', { query: 'exponential backoff' })).results)).toEqual([later.created.validFrom]);
  }, 120_000);

  it('answers a word that every fact has with the newest facts, through all three tools', async () => {
    const s = await boot(workspace());
    await save(s, 'billing', 'owner', 'Marta Quasar'); // older than all of them, and without the word
    seedNewerFacts(s.db, 10_050);
    // seedNewerFacts writes no ledger event, so the facts are compared by their object text.
    const objects = (hits: Array<{ text: string }>) => hits.map(h => field(h, 'object'));
    const expected = (s.db.prepare(`SELECT object_text AS o FROM facts WHERE valid_to IS NULL AND object_text LIKE 'seeded value %' ORDER BY valid_from DESC, id DESC LIMIT 5`).all() as Array<{ o: string }>).map(r => r.o);
    expect(expected).toHaveLength(5);

    const text = await s.call('search_text', { query: 'seeded', top_k: 5 });
    expect(objects(text.results)).toEqual(expected);
    const memory = await s.call('search_memory', { query: 'seeded value', top_k: 5 });
    expect(objects(memory.hits.filter((h: any) => h.reason === 'fact')).slice(0, 5)).toEqual(expected);
    const context = await s.call('get_context', { query: 'seeded' });
    expect(context.facts.slice(0, 5).map((f: any) => f.object)).toEqual(expected);
    // The fact that has none of the words is not made up to fill a slot.
    expect(JSON.stringify([text.results, memory.hits, context.facts])).not.toContain('Marta Quasar');
  }, 120_000);

  it('indexes the facts a release without the term index wrote, when the service starts', async () => {
    const dir = workspace();
    const first = await boot(dir);
    const saved = await save(first, POSTGRES.subject, POSTGRES.predicate, POSTGRES.object);
    first.db.prepare('DELETE FROM fact_terms').run(); // what an older release leaves behind: facts, no rows
    expect(moments((await first.call('search_text', { query: 'pgvector' })).results)).toEqual([]);
    await first.stop();

    const second = await boot(dir);
    expect(moments((await second.call('search_text', { query: 'pgvector' })).results)).toEqual([saved.created.validFrom]);
  }, 60_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a corrected fact is never returned as current', () => {
  const ask = async (s: Session) => ({
    text: await s.call('search_text', { query: 'MySQL' }),
    postgres: await s.call('search_text', { query: 'Postgres' }),
    memory: await s.call('search_memory', { query: 'MySQL database' }),
    context: await s.call('get_context', { query: 'which database do we run in production?', max_tokens: 4000 }),
  });

  it('hides the closed value before and after indexing, and shows only the live event', async () => {
    const s = await boot(workspace());
    await save(s, POSTGRES.subject, POSTGRES.predicate, 'MySQL 8');
    const fix = await save(s, POSTGRES.subject, POSTGRES.predicate, POSTGRES.object);
    expect(fix.closed.object).toBe('MySQL 8');

    for (const indexed of [false, true]) {
      if (indexed) await s.call('index_memory');
      const { text, postgres, memory, context } = await ask(s);
      const label = indexed ? 'indexed' : 'unindexed';
      expect(JSON.stringify(text.results), label).not.toContain('MySQL 8');
      expect(JSON.stringify(memory.hits), label).not.toContain('MySQL 8');
      expect(JSON.stringify(context.memories), label).not.toContain('MySQL 8');
      expect(moments(postgres.results), label).toEqual([fix.created.validFrom]);
      expect(context.facts.map((f: any) => f.object), label).toEqual([POSTGRES.object]);
    }
    // History is the caller's explicit request, and stays labelled.
    const history = await s.call('search_memory', { query: 'MySQL database', include_history: true });
    expect(JSON.stringify(history.hits)).toContain('MySQL 8');
    expect(factHits(history.hits).map(h => field(h, 'object'))).not.toContain('MySQL 8');
  });

  it('A then B then A leaves only the last event live', async () => {
    const s = await boot(workspace());
    await save(s, POSTGRES.subject, POSTGRES.predicate, 'MySQL 8');
    await save(s, POSTGRES.subject, POSTGRES.predicate, POSTGRES.object);
    const back = await save(s, POSTGRES.subject, POSTGRES.predicate, 'MySQL 8');

    for (const indexed of [false, true]) {
      if (indexed) await s.call('index_memory');
      const { text, postgres } = await ask(s);
      expect(moments(text.results), `indexed=${indexed}`).toEqual([back.created.validFrom]);
      expect(postgres.results, `indexed=${indexed}`).toEqual([]);
    }
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('scoped reads do not widen', () => {
  const TOKENS = { GLOBALNET: 'global', ALPHACODE: 'scope:alpha', BETACODE: 'project:beta' } as const;
  // [what the caller passes, the scope it means]; undefined means every scope.
  const SCOPES: Array<[string | undefined, string | undefined]> = [
    [undefined, undefined], ['global', 'global'], ['', 'global'],
    ['scope:alpha', 'scope:alpha'], ['alpha', 'scope:alpha'], ['project:beta', 'project:beta'],
  ];

  it('search_text, search_memory and get_context return exactly the facts of the requested scope', async () => {
    const s = await boot(workspace());
    await save(s, 'wifi', 'network_name', 'GLOBALNET');
    await save(s, 'vault', 'door_code', 'ALPHACODE', 'scope:alpha');
    await save(s, 'vault', 'door_code', 'BETACODE', 'project:beta');

    for (const [given, meant] of SCOPES) {
      for (const [token, owner] of Object.entries(TOKENS)) {
        const expected = meant === undefined || meant === owner;
        const scope = given === undefined ? {} : { scope: given };
        // What each tool returns as memory; get_context also echoes the query, which is not a result.
        const answers = {
          search_text: (await s.call('search_text', { query: token, ...scope })).results,
          search_memory: (await s.call('search_memory', { query: token, ...scope })).hits,
          get_context: (({ facts, memories }) => ({ facts, memories }))(await s.call('get_context', { query: token, ...scope })),
        };
        for (const [tool, returned] of Object.entries(answers)) {
          expect(JSON.stringify(returned).includes(token), `${tool} scope=${JSON.stringify(given)} token=${token}`).toBe(expected);
        }
      }
    }
  }, 60_000);

  it('a read is told the index is behind only by events of the scope it reads', async () => {
    const s = await boot(workspace());
    await save(s, 'wifi', 'network_name', 'GLOBALNET');
    await s.call('index_memory');
    await save(s, 'vault', 'door_code', 'ALPHACODE', 'scope:alpha');

    const behind = async (scope?: string) => (await s.call('get_context', { query: 'GLOBALNET ALPHACODE', ...(scope === undefined ? {} : { scope }) })).index?.stale === true;
    expect(await behind()).toBe(true); // an unscoped read sees the unindexed alpha fact
    expect(await behind('global')).toBe(false); // a global read cannot see it, and learns nothing of it
    expect(await behind('scope:alpha')).toBe(true); // the alpha read returns alpha's ledger events once they are indexed
    expect(await behind('project:beta')).toBe(false); // a scope with no events has nothing to wait for
    await s.call('index_memory');
    expect(await behind('scope:alpha')).toBe(false);
    await save(s, 'wifi', 'guest_network', 'GUESTNET');
    expect(await behind('global')).toBe(true);
    expect(await behind('scope:alpha')).toBe(false); // the newest alpha event is indexed
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('index.stale says when saved facts are not in the semantic index', () => {
  it('appears after a save, goes away after index_memory, and returns with the next save', async () => {
    const s = await boot(workspace());
    const stale = async () => {
      const memory = await s.call('search_memory', { query: 'which database engine do we run in production?' });
      const context = await s.call('get_context', { query: 'what datastore do we use?' });
      return [memory.index?.stale, context.index?.stale];
    };
    expect(await stale()).toEqual([undefined, undefined]); // nothing saved yet

    await save(s, POSTGRES.subject, POSTGRES.predicate, POSTGRES.object);
    expect(await stale()).toEqual([true, true]);
    const context = await s.call('get_context', { query: 'what datastore do we use?' });
    expect(context.index.detail).toContain('index_memory');

    await s.call('index_memory');
    expect(await stale()).toEqual([undefined, undefined]);

    await save(s, 'staging', 'deploy_command', 'make deploy-staging');
    expect(await stale()).toEqual([true, true]);
  });

  it('is not reported by search_text, by a profile read, or when there is no embedding provider', async () => {
    const withProvider = await boot(workspace());
    await save(withProvider, POSTGRES.subject, POSTGRES.predicate, POSTGRES.object);
    expect((await withProvider.call('search_text', { query: 'Postgres' })).index).toBeUndefined();
    expect((await withProvider.call('get_context', {})).index).toBeUndefined();

    const keywordOnly = await boot(workspace(), null);
    await save(keywordOnly, POSTGRES.subject, POSTGRES.predicate, POSTGRES.object);
    expect((await keywordOnly.call('get_context', { query: 'which database engine do we run?' })).index).toBeUndefined();
    expect(moments((await keywordOnly.call('search_text', { query: 'Postgres' })).results)).toHaveLength(1);
    expect(await keywordOnly.call('search_memory', { query: 'database' })).toMatchObject({ ok: false, error: 'semantic-unavailable' });
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a workspace with no saved facts is untouched', () => {
  it('answers exactly what the index alone answers, with no new fields', async () => {
    const dir = workspace();
    fs.mkdirSync(path.join(dir, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Notes', 'drinks.md'), '# Drinks\n\nRowan likes mango juice.\n');
    fs.writeFileSync(path.join(dir, 'Notes', 'other.md'), '# Other\n\nRandom hardware notes.\n');
    const s = await boot(dir);
    await s.call('index_memory');

    const text = await s.call('search_text', { query: 'mango' });
    expect(text.results.length).toBeGreaterThan(0);
    // The one thing search_text adds to a note hit is its date (session_date, as search_memory gives it); the fact lane adds nothing.
    for (const hit of text.results) expect(hit.session_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const withoutDates = JSON.parse(JSON.stringify(text, (key, value) => (key === 'session_date' ? undefined : value)));
    expect(withoutDates).toEqual(JSON.parse(JSON.stringify(engineSearchText(s.db, dir, 'mango', 20))));

    // Scores carry a clock-dependent recency boost, so compare what each hit says, not its score.
    const shape = (hits: any[]) => hits.map(h => [h.notePath, h.headingPath, h.reason, h.text]);
    const memory = await s.call('search_memory', { query: 'mango juice' });
    const direct = await engineSearchMemory(s.db, s.engine, dir, 'mango juice', 20);
    expect(Object.keys(memory)).toEqual(Object.keys(direct));
    expect(shape(memory.hits)).toEqual(shape(direct.hits as any[]));

    const context = await s.call('get_context', { query: 'who likes mango juice?' });
    expect(Object.keys(context)).toEqual(['ok', 'query', 'scope', 'retrieval', 'facts', 'rankedBy', 'memories', 'truncated', 'maxTokens', 'renor']); // rankedBy is main's; renor is on every reply (B1); no `index` field
    expect(context.facts).toEqual([]);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('saving a fact with save_memory costs nothing in the index', () => {
  const count = (s: Session, table: string) => (s.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  // The first lifecycle write adds the synthetic `_mcp_` note that owns lifecycle entities; it is not a file.
  const notes = (s: Session) => (s.db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE path != '_mcp_'`).get() as { c: number }).c;

  it('embeds nothing and writes no chunk, however large the indexed workspace is', async () => {
    const dir = workspace();
    fs.mkdirSync(path.join(dir, 'Notes'), { recursive: true });
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, 'Notes', `note-${i}.md`), `# Note ${i}\n\nSynthetic note number ${i} about topic ${i}.\n`);
    const provider = new CountingProvider();
    const s = await boot(dir, provider);
    await s.call('index_memory');
    const chunks = count(s, 'chunks');
    const indexedNotes = notes(s);
    expect(chunks).toBeGreaterThanOrEqual(40);
    const before = provider.calls;

    for (let i = 0; i < 5; i++) await save(s, `service ${i}`, 'owner', `Team ${i}`);
    expect(provider.calls).toBe(before);
    expect(count(s, 'chunks')).toBe(chunks);
    expect(notes(s)).toBe(indexedNotes);

    // The counter is live: a note-mode save does re-walk and re-embed (the cost a fact save avoids).
    await s.call('remember', { statement: 'Plain note that is not one fact.' });
    expect(provider.calls).toBeGreaterThan(before);
  }, 60_000);
});

/**
 * The scout's other input for finding 4: a line saved with remember_note. It is a note, not a fact, so the facts lane
 * never sees it, and it waited for index_memory: `search_text("billing webhook")` answered `[]` right after the save.
 * It is indexed the way a note-mode remember indexes its line, by the same pass, and its receipt says so the same way.
 */
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a line saved with remember_note is found before any index_memory', () => {
  const BILLING = 'The billing webhook retries five times before it pages anyone.';
  const said = (hits: Array<{ text: string }>, words: string) => hits.filter(h => h.text.includes(words));

  /** Eval-hash embeddings that refuse every text to embed, as a provider that is down does; a query still embeds. */
  class DownProvider extends EvalHashEmbeddingProvider {
    async embed(): Promise<number[][]> { throw new Error('synthetic embedding outage'); }
  }

  it('search_text, search_memory and get_context find it at once, dated or scoped, and the receipt says it was indexed', async () => {
    const s = await boot(workspace());
    const saved = await s.call('remember_note', { text: BILLING });
    expect(said((await s.call('search_text', { query: 'billing webhook' })).results, BILLING)).toHaveLength(1);
    expect(said((await s.call('search_memory', { query: 'billing webhook retries' })).hits, BILLING)).toHaveLength(1);
    expect(said((await s.call('get_context', { query: 'billing webhook retries' })).memories, BILLING)).toHaveLength(1);
    expect(saved).toMatchObject({ ok: true, scope: 'global', indexed: true, index: { errors: 0 } });
    expect(saved.file).toMatch(/^Memory\/Daily\/\d{4}-\d{2}-\d{2}\.md$/);

    // A line filed under another day, and a line in a scope, the same way; the scope still holds its own.
    await s.call('remember_note', { text: 'Backfilled: the quokkafern audit closed.', date: '2026-01-05' });
    expect(said((await s.call('search_text', { query: 'quokkafern' })).results, 'quokkafern audit closed')).toHaveLength(1);
    expect((await s.call('remember_note', { text: 'The zephyrfly rollout slipped to November.', scope: 'project:renor' })).indexed).toBe(true);
    expect(said((await s.call('search_text', { query: 'zephyrfly', scope: 'project:renor' })).results, 'zephyrfly rollout')).toHaveLength(1);
    expect((await s.call('search_text', { query: 'zephyrfly', scope: 'global' })).results).toEqual([]);
  });

  it('a failed embedding leaves the line to keyword search, and the receipt says the refresh failed and why', async () => {
    const s = await boot(workspace(), new DownProvider());
    const saved = await s.call('remember_note', { text: BILLING });
    expect(said((await s.call('search_text', { query: 'billing webhook' })).results, BILLING)).toHaveLength(1);
    expect(saved).toMatchObject({
      ok: true, scope: 'global', indexed: false,
      index: { total: 1, indexed: 0, errors: 1 },
      warning: 'memory-saved-but-index-refresh-failed', detail: 'synthetic embedding outage',
    });
  });
});
