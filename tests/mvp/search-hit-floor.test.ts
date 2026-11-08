import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { SEARCH_RELEVANCE_GUIDANCE } from '../../src/mvp/contextRelevance';
import { SESSION_EXPAND_REASON } from '../../src/retrieval/orchestrator';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { CALIBRATED_BAR, CalibratedIdentityProvider } from '../helpers/calibratedIdentityProvider';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * search_memory's operator floor (mvp/hitFloor.ts), over the real MCP surface in memory.
 *
 * The provider embeds with the deterministic lexical hash and declares the calibrated hosted identity, so the bar
 * the engine resolves is the real one while nothing leaves this process. Its cosines are the lexical overlap of a note
 * with the query, which the notes below are written to make different: the tests read the similarities the response
 * shows and place their floors between them, so they hold for any hash.
 */

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
  'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL',
  'RENOR_SEARCH_HIT_FLOOR', 'RENOR_SEARCH_HIT_FLOOR_KEEP', 'RENOR_CONTEXT_RELEVANCE', 'RENOR_CONTEXT_RELEVANCE_MIN', 'RENOR_SEARCH_EVIDENCE', 'RENOR_READ_HONESTY', 'RENOR_READER_LAYOUT',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const cleanups: Array<() => Promise<void>> = [];
const dirs: string[] = [];

// A hit's score carries a recency boost read off the clock, which moves in the tenth decimal between two calls; the
// comparisons below are of whole responses, so the clock stands still.
const NOW = Date.now() + 60_000;
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Notes whose overlap with QUERY falls from four of its five words to none. */
const QUERY = 'alpha bravo charlie delta echo';
const NOTES: Record<string, string> = {
  'alpha.md': 'alpha bravo charlie delta',
  'beta.md': 'alpha bravo xray yankee zulu',
  'gamma.md': 'alpha one two three four five six',
  'omega.md': 'nothing here shares a word with the question',
};

function writeNotes(memoryDir: string): void {
  fs.mkdirSync(path.join(memoryDir, 'Notes'), { recursive: true });
  for (const [file, text] of Object.entries(NOTES)) fs.writeFileSync(path.join(memoryDir, 'Notes', file), `${text}\n`);
}

async function serve(provider: EmbeddingProvider | null, populate: (memoryDir: string) => void = writeNotes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-hit-floor-'));
  dirs.push(root);
  const memoryDir = path.join(root, 'memory');
  const authRoot = path.join(root, 'auth');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });
  populate(memoryDir);
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    MVP_EMBEDDING_PROVIDER: 'none',
    RENOR_SEARCH_EVIDENCE: '0',
  });
  const app = createMvpApp(loadMvpConfig(), provider);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'search-hit-floor', version: '0.1.0' });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await app.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0].text;
    if (res.isError) throw new Error(`${name} ${JSON.stringify(args)}: ${text}`);
    return JSON.parse(text);
  };
  await call('index_memory', {});
  return { call, client };
}

type Hit = { notePath: string; text: string; reason: string; similarity?: number; score: number; weak_match?: true };
type Body = { hits: Hit[]; relevance?: Record<string, unknown>; floor?: { similarity: number; withheld: number }; [key: string]: unknown };

// floorSetting and keepSetting are test harness settings, never MCP arguments. The baseline exposes raw scores via a tiny
// floor. Unless a test asks for it, the closest hits are not protected (keep 0), so these tests judge the plain floor.
const search = async (call: Awaited<ReturnType<typeof serve>>['call'], args: Record<string, unknown> = {}): Promise<Body> => {
  const { floorSetting = 0.000001, keepSetting = 0, ...toolArgs } = args;
  process.env.RENOR_SEARCH_HIT_FLOOR = String(floorSetting);
  process.env.RENOR_SEARCH_HIT_FLOOR_KEEP = String(keepSetting);
  return call('search_memory', { query: QUERY, ...toolArgs });
};

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the shipped default', () => {
  it('uses 0.63 for Vertex-768 without a caller argument and 0 restores the old response shape', async () => {
    const { call } = await serve(new CalibratedIdentityProvider());
    delete process.env.RENOR_SEARCH_HIT_FLOOR;
    const body = await call('search_memory', { query: QUERY }) as Body;
    expect(body.floor).toMatchObject({ similarity: 0.63 });
    expect(body.floor!.withheld).toBeGreaterThan(0);
    expect(body.hits.length).toBeGreaterThan(0);
    // Below the floor only the closest three note hits may stay (the default keep); the plain floor leaves none below it.
    const below = body.hits.filter(hit => hit.similarity !== undefined && hit.similarity < 0.63);
    const judged = body.hits.filter(hit => hit.similarity !== undefined);
    const best = judged.map(hit => hit.similarity!).sort((a, b) => b - a).slice(0, 3);
    expect(judged.length).toBeLessThanOrEqual(Math.max(3, judged.filter(hit => hit.similarity! >= 0.63).length));
    for (const hit of below) expect(best).toContain(hit.similarity);
    const plain = await search(call, { floorSetting: 0.63 });
    for (const hit of plain.hits) if (hit.similarity !== undefined) expect(hit.similarity).toBeGreaterThanOrEqual(0.63);
    const off = await search(call, { floorSetting: 0 });
    expect(off).not.toHaveProperty('floor');
    expect(off.hits.length).toBeGreaterThan(plain.hits.length);
    for (const hit of off.hits) expect(hit).not.toHaveProperty('similarity');
    const context = await call('get_context', { query: QUERY });
    process.env.RENOR_SEARCH_HIT_FLOOR = '1';
    expect(await call('get_context', { query: QUERY })).toEqual(context);
  }, 60_000);

  it('keep 3 on a real page is an ordered sub-list of the unfloored page and a super-list of the plain floor, and labels the weak ones', async () => {
    const { call } = await serve(new CalibratedIdentityProvider());
    const off = await search(call, { floorSetting: 0 });
    const plain = await search(call, { floorSetting: 0.63 });
    const kept = await search(call, { floorSetting: 0.63, keepSetting: 3 });
    const key = (hit: Hit) => `${hit.notePath}\n${hit.text}`;
    const inOrder = (small: Hit[], big: Hit[]) => { let at = 0; return small.every(hit => { at = big.findIndex((b, i) => i >= at && key(b) === key(hit)) + 1; return at > 0; }); };
    expect(inOrder(kept.hits, off.hits)).toBe(true);
    expect(inOrder(plain.hits, kept.hits)).toBe(true);
    const best = kept.hits.filter(hit => hit.similarity !== undefined).map(hit => hit.similarity!).sort((a, b) => b - a).slice(0, 3);
    for (const hit of kept.hits) {
      const weak = hit.similarity !== undefined && hit.similarity < 0.63;
      expect(hit.weak_match === true, key(hit)).toBe(weak);
      if (weak) expect(best).toContain(hit.similarity);
    }
    for (const hit of plain.hits) expect(hit).not.toHaveProperty('weak_match');
  }, 60_000);

  it.each([
    ['hash', () => new EvalHashEmbeddingProvider()],
    ['other model', () => Object.assign(new EvalHashEmbeddingProvider(), { identity: { kind: 'vertex', model: 'other-model' }, dimensions: 768 })],
    ['other dimensions', () => Object.assign(new EvalHashEmbeddingProvider(), { identity: { kind: 'vertex', model: 'gemini-embedding-001' }, dimensions: 256 })],
  ] as const)('defaults off for %s, while an explicit operator setting enables filtering', async (_name, provider) => {
    const { call } = await serve(provider());
    delete process.env.RENOR_SEARCH_HIT_FLOOR;
    const body = await call('search_memory', { query: QUERY }) as Body;
    expect(body).not.toHaveProperty('floor');
    expect(body.hits).toHaveLength(Object.keys(NOTES).length);
    for (const hit of body.hits) expect(hit).not.toHaveProperty('similarity');
    expect(await search(call, { floorSetting: 0 })).toEqual(body);
    const strict = await search(call, { floorSetting: 1 });
    expect(strict.hits).toEqual([]);
    expect(strict.floor).toEqual({ similarity: 1, withheld: body.hits.length });
    // With the default keep, a floor of 1 still leaves the closest three.
    delete process.env.RENOR_SEARCH_HIT_FLOOR_KEEP;
    process.env.RENOR_SEARCH_HIT_FLOOR = '1';
    const kept = await call('search_memory', { query: QUERY }) as Body;
    expect(kept.hits).toHaveLength(3);
    expect(kept.floor).toEqual({ similarity: 1, withheld: body.hits.length - 3 });
  }, 60_000);

  it('leaves semantic-unavailable responses untouched', async () => {
    const { call } = await serve(null, () => {});
    const ask = async (floor: string) => {
      process.env.RENOR_SEARCH_HIT_FLOOR = floor;
      try { await call('search_memory', { query: QUERY }); } catch (error) { return String(error); }
      return undefined;
    };
    expect(await ask('0.63')).toEqual(await ask('0'));
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('operator floor', () => {
  it('shows each hit found by meaning in a note with its own similarity, rounded to three places', async () => {
    const { call } = await serve(new CalibratedIdentityProvider());
    const shown = await search(call, { floorSetting: 0.000001 });
    const judged = shown.hits.filter(hit => hit.similarity !== undefined);
    expect(judged.length).toBeGreaterThanOrEqual(3);
    for (const hit of judged) {
      expect(hit.notePath).toMatch(/^Notes\//);
      expect(Math.round(hit.similarity! * 1000) / 1000).toBe(hit.similarity);
      // The composite score is the cosine plus boosts: never below it, and not what a floor judges.
      expect(hit.score).toBeGreaterThanOrEqual(hit.similarity!);
    }
    // Three places, not fewer: some similarity here has a third decimal.
    expect(judged.some(hit => Math.round(hit.similarity! * 100) / 100 !== hit.similarity)).toBe(true);
    // The number shown is the cosine, not the score: a fresh note's score carries a recency boost on top of it.
    expect(judged.some(hit => hit.score > hit.similarity! + 0.0005)).toBe(true);
  }, 60_000);

  it('only removes: filtered pages retain their original order and never use boosted scores', async () => {
    const { call } = await serve(new CalibratedIdentityProvider());
    const all = await search(call, { floorSetting: 0.000001 });
    const sims = [...new Set(all.hits.map(h => h.similarity).filter((s): s is number => s !== undefined))].sort((a, b) => a - b);
    expect(sims.length).toBeGreaterThanOrEqual(3);
    // Each similarity itself (a hit equal to the floor stays), a hair above each, and a floor above them all.
    const floors = sims.slice(0, -1).map((s, i) => (s + sims[i + 1]) / 2).concat(1);
    for (const floor of floors) {
      const body = await search(call, { floorSetting: floor });
      const expected = all.hits.filter(h => h.similarity === undefined || h.similarity >= floor);
      expect(body.hits, `floor ${floor}`).toEqual(expected);
      expect(body.floor, `floor ${floor}`).toEqual({ similarity: floor, withheld: all.floor!.withheld + all.hits.length - expected.length });
      // Other response fields stay; a verdict for a removed chunk is withheld.
      const { hits: _a, floor: _b, ...rest } = body;
      const { hits: _c, floor: _d, ...restAll } = all;
      delete rest.relevance; delete restAll.relevance;
      expect(rest, `floor ${floor}`).toEqual(restAll);
    }
  }, 120_000);

  it('withholds a positive chunk verdict when an operator floor removes its match', async () => {
    const { call } = await serve(new CalibratedIdentityProvider());
    const all = await search(call, { floorSetting: 0.000001 });
    expect(all.relevance).toMatchObject({ relevant: true });
    const judged = all.hits.filter(h => h.similarity !== undefined);
    expect(judged.length).toBeGreaterThanOrEqual(3);
    const strict = await search(call, { floorSetting: 1 });
    // The floor took every note out, so a positive verdict must not promise an absent match.
    expect(strict.hits.filter(h => h.similarity !== undefined)).toEqual([]);
    expect(strict.floor).toEqual({ similarity: 1, withheld: all.floor!.withheld + judged.length });
    expect(strict.relevance).toBeUndefined();
  }, 60_000);

  it('does not judge what has no similarity of its own, a saved fact among it, and counts only what it took out', async () => {
    const { call } = await serve(new CalibratedIdentityProvider());
    await call('remember', { statement: 'The alpha bravo charlie delta echo drill is on Fridays.', subject: 'alpha bravo drill', predicate: 'day', object: 'Friday' });
    const all = await search(call, { floorSetting: 0.000001 });
    const about = (body: Body) => body.hits.filter(h => /Friday/.test(h.text));
    expect(about(all).length).toBeGreaterThan(0);
    for (const hit of about(all)) expect(hit.similarity, hit.text).toBeUndefined();
    const strict = await search(call, { floorSetting: 1 });
    expect(about(strict)).toEqual(about(all));
    // Every hit that survives a floor of 1 has no similarity of its own, and the count is of the ones taken out.
    for (const hit of strict.hits) expect(hit.similarity, hit.text).toBeUndefined();
    expect(strict.floor!.withheld).toBe(all.floor!.withheld + all.hits.filter(h => h.similarity !== undefined).length);
  }, 60_000);

  it('does not hand the room it frees to other hits: a full page loses hits, it does not gain facts', async () => {
    const { call } = await serve(new CalibratedIdentityProvider());
    // The fact matches the query's first word, so the facts lane would list it on a page that had room.
    await call('remember', { statement: 'Weekly rota.', subject: 'alpha', predicate: 'rota', object: 'Tuesday' });
    const full = await search(call, { floorSetting: 0.000001, top_k: 1 });
    expect(full.hits).toHaveLength(1);
    expect(full.hits[0].similarity).toBeDefined();
    const strict = await search(call, { floorSetting: 1, top_k: 1 });
    expect(strict.hits).toEqual([]);
    expect(strict.floor).toEqual({ similarity: 1, withheld: 1 });
  }, 60_000);

  it('adds no MCP argument, and keeps relevance guidance true when an operator hides the match', async () => {
    const { call, client } = await serve(new CalibratedIdentityProvider());
    const tool = (await client.listTools()).tools.find(t => t.name === 'search_memory')!;
    expect(tool.inputSchema.properties).not.toHaveProperty('min_similarity');
    expect(tool.description!.endsWith(SEARCH_RELEVANCE_GUIDANCE)).toBe(true);
    const all = await search(call);
    expect(all.relevance).toMatchObject({ relevant: true });
    const hidden = await search(call, { floorSetting: 1 });
    expect(hidden.hits).toEqual([]);
    expect(hidden).not.toHaveProperty('relevance');
  }, 60_000);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the read-usefulness measure with an operator floor', () => {
  // The engine counts what each read served (readUsefulness.ts), and an item is "used" only if a read served it: so it
  // counts the page the caller is shown. A hit the floor left out was not served.
  const spyOnReads = () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    return () => log.mock.calls
      .map(args => String(args[0]))
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as Record<string, any>)
      .filter(event => event.event === 'read' && event.tool === 'search_memory');
  };

  it('counts only what the floor leaves, including a surviving fact', async () => {
    const { call } = await serve(new CalibratedIdentityProvider());
    // A fact the floor never judges; saved before the spy, so only the searches below are measured.
    await call('remember', { statement: 'The alpha rota.', subject: 'alpha', predicate: 'rota', object: 'Tuesday' });
    const reads = spyOnReads();
    await search(call);
    await search(call, { floorSetting: 0.000001 });
    await search(call, { floorSetting: 1 });
    const [plain, zero, strict] = reads();
    expect(reads()).toHaveLength(3);
    expect(plain).toMatchObject({ relevant: true, judged: true });
    expect(plain.items).toBeGreaterThanOrEqual(3);
    expect(zero).toMatchObject({ relevant: true, judged: true, items: plain.items });
    // A floor of 1 takes every note out of the page; the fact stays, and it is the one item that read served.
    expect(strict).toMatchObject({ items: 1 });
    expect(strict.ids).toHaveLength(1);
  }, 60_000);

  it('does not call a page the floor left empty a relevant read, whatever the verdict says of what is on file', async () => {
    const { call } = await serve(new CalibratedIdentityProvider());
    const reads = spyOnReads();
    const all = await search(call, { floorSetting: 0.000001 });
    const none = await search(call, { floorSetting: 1 });
    expect(none.hits).toEqual([]);
    expect(none.relevance).toBeUndefined();
    const [servedAll, servedNone] = reads();
    expect(servedAll).toMatchObject({ relevant: true, judged: true });
    expect(servedAll.items).toBeGreaterThanOrEqual(3);
    // The reply served nothing, so it did not serve something relevant: the use rate is of reads that did.
    expect(servedNone).toMatchObject({ relevant: false, judged: false, items: 0, ids: [] });
  }, 60_000);
});

const ENGINE = path.resolve(__dirname, '../..');
const DAY_MS = 86_400_000;

/** A RenorBench suite: its vault with every note dated as its fixture says, and its dev questions. */
function renorBench(suite: 'v1' | 'v2') {
  const fixture = path.join(ENGINE, 'fixtures', 'eval', `renorbench-${suite}`);
  const populate = (memoryDir: string): void => {
    fs.cpSync(path.join(fixture, 'vault'), memoryDir, { recursive: true });
    const meta = JSON.parse(fs.readFileSync(path.join(fixture, 'fixture.json'), 'utf8')) as { relativeMtimeDays?: Record<string, number> };
    for (const [rel, days] of Object.entries(meta.relativeMtimeDays ?? {})) {
      const file = path.join(memoryDir, rel);
      const when = new Date(NOW - days * DAY_MS);
      if (fs.existsSync(file)) fs.utimesSync(file, when, when);
    }
  };
  const questions = fs.readFileSync(path.join(ENGINE, 'docs', 'evals', `renorbench-${suite}.dev.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; query: string });
  return { populate, questions };
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('on the pages the RenorBench dev questions get', () => {
  // Real pages hold what the small fixture does not: statements the session expansion added to the notes found (on v2,
  // most of a page), which a floor must follow to their notes rather than judge.
  for (const suite of ['v1', 'v2'] as const) {
    it(`${suite}: a floor leaves the page at 0 less the hits below it and the statements of a note that lost every match`, async () => {
      // The floor judges chunks, and the reader layout (readerLayout.ts) merges a session's chunks after it has: this test
      // compares pages chunk by chunk, so it reads them laid out as the floor leaves them.
      const { populate, questions } = renorBench(suite);
      const { call } = await serve(new CalibratedIdentityProvider(), populate);
      process.env.RENOR_READER_LAYOUT = '0'; // after serve(), which clears the keys above
      let expansionKept = 0;
      let expansionLeftOut = 0;
      let foundLeftOut = 0;
      for (const q of questions) {
        const all = await search(call, { query: q.query, floorSetting: 0.000001 });
        const sims = all.hits.map(h => h.similarity).filter((s): s is number => s !== undefined).sort((a, b) => a - b);
        if (sims.length === 0) continue;
        // Two floors a page: its median similarity, and a hair above its best (which takes out every hit found by meaning).
        const floors = [Math.max(0.000001, sims[Math.floor(sims.length / 2)] - 0.0006), Math.min(1, sims[sims.length - 1] + 0.0006)];
        for (const floor of floors) {
          const page = await search(call, { query: q.query, floorSetting: floor });
          const at = `${q.id} at ${floor}`;
          // The page is the page at 0 with hits taken out: the rest are the same hits, in the same order.
          const kept: Hit[] = [];
          const left: Hit[] = [];
          for (const hit of all.hits) (kept.length < page.hits.length && JSON.stringify(hit) === JSON.stringify(page.hits[kept.length]) ? kept : left).push(hit);
          expect(kept.length, `${at}: every hit of the page is a hit of the page at 0`).toBe(page.hits.length);
          const matched = new Set(kept.filter(h => h.reason !== SESSION_EXPAND_REASON).map(h => h.notePath));
          for (const hit of left) {
            const below = hit.similarity !== undefined && hit.similarity < floor;
            const orphaned = hit.reason === SESSION_EXPAND_REASON && !matched.has(hit.notePath);
            expect(below || orphaned, `${at}: why was ${hit.reason} ${hit.notePath} taken out`).toBe(true);
            if (orphaned) expansionLeftOut++; else foundLeftOut++;
          }
          for (const hit of kept) {
            expect(hit.similarity === undefined || hit.similarity >= floor, `${at}: ${hit.notePath} is below the floor`).toBe(true);
            if (hit.reason === SESSION_EXPAND_REASON) {
              expect(matched.has(hit.notePath), `${at}: a statement of ${hit.notePath} outlived its note's matches`).toBe(true);
              expansionKept++;
            }
          }
          expect(page.floor, at).toEqual({ similarity: floor, withheld: all.floor!.withheld + left.length });

        }
      }
      // Not vacuous: floors on these pages keep statements, take out statements, and take out hits found by meaning.
      expect(expansionKept).toBeGreaterThan(0);
      expect(expansionLeftOut).toBeGreaterThan(0);
      expect(foundLeftOut).toBeGreaterThan(0);
    }, 120_000);
  }
});


it.skipIf(HTTP_SERVER_UNSUPPORTED)('keeps relevance.fact when the floor frees slots but does not backfill its unlisted closest fact', async () => {
  const { call } = await serve(new EvalHashEmbeddingProvider(), memoryDir => {
    fs.mkdirSync(path.join(memoryDir, 'Notes'), { recursive: true });
    for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(memoryDir, 'Notes', `editor-${i}.md`),
      `Standup ${i}: my favorite editor setup discussion, notes about the editor theme and keymap.\n`);
  });
  process.env.RENOR_CONTEXT_RELEVANCE = '1';
  process.env.RENOR_CONTEXT_RELEVANCE_MIN = '0.4';
  await call('save_memory', { subject: 'user', predicate: 'preferred_editor', object: 'Neovim' });
  await call('index_memory', {});
  let before: Body | undefined;
  // The fact vector is embedded in the background; under a loaded gate that can take far longer than 500ms, so wait up
  // to ~15s (Date.now is mocked here, hence a count rather than a deadline) instead of racing it.
  for (let i = 0; i < 600; i++) {
    // A fill that failed once holds the backend off until Date.now passes retryAfter (30 s); with the clock frozen that
    // never happens and the fact stays unembedded. Move the clock on each lap so a failed fill is retried, not final.
    vi.spyOn(Date, 'now').mockReturnValue(NOW + i * 31_000);
    before = await search(call, { query: 'what is my favorite editor', top_k: 8, floorSetting: 0 });
    if (before.relevance?.fact) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  expect(before!.relevance).toMatchObject({ relevant: true, fact: { subject: 'user', predicate: 'preferred_editor', object: 'Neovim' } });
  const after = await search(call, { query: 'what is my favorite editor', top_k: 8, floorSetting: 1 });
  expect(after.hits).toEqual([]);
  expect(after.relevance).toEqual(before!.relevance);
  expect(after.floor).toMatchObject({ withheld: 8 });
}, 60_000);
