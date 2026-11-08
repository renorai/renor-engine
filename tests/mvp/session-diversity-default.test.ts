import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { startWorkspace, restoreWorkspaceEnv, type Workspace } from '../helpers/mvpWorkspace';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { SESSION_EXPAND_REASON } from '../../src/retrieval/orchestrator';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * RENOR_SESSION_DIVERSITY defaults to a cap of 2 chunks per note (2026-10-07). It is for one conversation or one document
 * crowding out the others, so these tests pin both halves through the real MCP tools, nothing set in the environment:
 * a document of many sections is held to 2 matches, and what a person saved is still handed back by search_memory however
 * many other saves share its note: the entries of a day's log, and the events of the ledger. With the cap counted by note
 * path alone the saved statements stopped coming back (twelve tests of the read-back failed; see
 * docs/evals/results/SESSION-DIVERSITY-DEFAULT-20261007.md). Eval-hash embeddings: no model, no network.
 */

const ENV = ['RENOR_SESSION_DIVERSITY', 'RENOR_SESSION_EXPAND', 'RENOR_SESSION_EXPAND_TOKENS'] as const;
const savedEnv = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
let ws: Workspace | null = null;

afterEach(async () => {
  await ws?.close();
  ws = null;
  restoreWorkspaceEnv();
  vi.restoreAllMocks();
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

async function workspace(): Promise<Workspace> {
  for (const name of ENV) delete process.env[name];
  ws = await startWorkspace(() => new EvalHashEmbeddingProvider());
  return ws;
}

type Hit = { notePath: string; text: string; reason: string };
async function search(w: Workspace, query: string, topK = 20): Promise<Hit[]> {
  const res = await w.call('search_memory', { query, top_k: topK });
  expect(res.isError, JSON.stringify(res.body)).toBe(false);
  return res.body.hits as Hit[];
}

const perNote = (hits: Hit[]) => {
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.notePath, (counts.get(h.notePath) ?? 0) + 1);
  return counts;
};

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a saved statement is still returned by search_memory with the cap on by default', () => {
  const QUERY = 'who owns the deploy window rollback';
  const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  // Six entries that say every word of the question, and a seventh that says only some of them: the weakest match.
  const STRONG = NAMES.map(name => `Note ${name}: who owns the deploy window rollback? ${name} owns the deploy window rollback.`);
  const WEAK = 'Note zorblax: the rollback owner is Sofia.';

  it('every one of seven entries saved on one day comes back, the weakest included', async () => {
    const w = await workspace();
    for (const statement of [...STRONG, WEAK]) {
      const saved = await w.call('remember', { statement });
      expect(saved.isError, JSON.stringify(saved.body)).toBe(false);
      expect(saved.body.mode).toBe('note');
    }
    const hits = await search(w, QUERY);
    for (const statement of [...STRONG, WEAK]) {
      expect(hits.some(h => h.text.includes(statement)), statement).toBe(true);
    }
    // They are seven entries of one daily note: more than the 2 a note may hold, because an entry is a memory of its own.
    const daily = [...perNote(hits)].filter(([notePath]) => /(^|\/)Daily\/\d{4}-\d{2}-\d{2}\.md$/.test(notePath));
    expect(daily).toHaveLength(1);
    expect(daily[0][1]).toBeGreaterThanOrEqual(7);
  });

  it('every saved fact statement comes back too: the ledger is one file, and each event of it is its own memory', async () => {
    const w = await workspace();
    // The fields of each fact share no word with the question, so the facts lane (which matches the fields) has nothing to
    // add: only the ledger events found by meaning can return the statements, and they all belong to the one ledger note.
    const facts = NAMES.map((name, i) => ({
      statement: `Note ${name}: who owns the deploy window rollback? ${name} owns the deploy window rollback.`,
      subject: `person ${i}`, predicate: 'role', object: `holder ${i}`,
    }));
    for (const fact of facts) {
      const saved = await w.call('remember', { ...fact, scope: 'project:atlas' });
      expect(saved.isError, JSON.stringify(saved.body)).toBe(false);
      expect(saved.body.mode).toBe('fact');
    }
    const hits = await search(w, QUERY);
    for (const fact of facts) {
      expect(hits.some(h => h.text.includes(fact.statement)), fact.statement).toBe(true);
    }
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a document of many sections holds at most 2 matches by default', () => {
  const SECTIONS = ['Deploys', 'Rollbacks', 'Contacts', 'Queues', 'Hosting', 'Incidents'];
  const DOCS = ['atlas-runbook.md', 'orion-runbook.md'];

  async function withDocuments(): Promise<Workspace> {
    const w = await workspace();
    const dir = path.join(w.memoryDir, 'Imported');
    fs.mkdirSync(dir, { recursive: true });
    for (const doc of DOCS) {
      const project = doc.split('-')[0];
      const body = SECTIONS.map(heading => `## ${heading}\n\nThe ${project} deploy and rollback procedure for ${heading.toLowerCase()}: follow the ${project} deploy checklist and the rollback steps.`).join('\n\n');
      fs.writeFileSync(path.join(dir, doc), `---\ndate: 2026-09-20\n---\n# ${project} runbook\n\n${body}\n`);
    }
    const indexed = await w.call('index_memory');
    expect(indexed.isError, JSON.stringify(indexed.body)).toBe(false);
    return w;
  }

  const QUERY = 'what is the deploy and rollback procedure and checklist';
  const counts = (hits: Hit[]) => DOCS.map(doc => hits.filter(h => h.notePath.endsWith(doc)).length);

  it('with nothing set: at most 2 of the matches of each document, whatever the session expansion adds', async () => {
    const w = await withDocuments();
    const hits = await search(w, QUERY);
    const matches = hits.filter(h => h.reason !== SESSION_EXPAND_REASON);
    expect(counts(matches).every(n => n >= 1 && n <= 2), JSON.stringify(counts(matches))).toBe(true);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('with the expansion off, the whole reply holds at most 2 hits of each document; 0 restores every section', async () => {
    const w = await withDocuments();
    process.env.RENOR_SESSION_EXPAND = '0';
    expect(counts(await search(w, QUERY)).every(n => n >= 1 && n <= 2)).toBe(true);
    process.env.RENOR_SESSION_DIVERSITY = '0';
    // The cap off is the window as it was: every section of both documents, as before the default.
    expect(counts(await search(w, QUERY))).toEqual([SECTIONS.length, SECTIONS.length]);
  });

  it.each([undefined, '0'])('get_context is byte-identical to the uncapped main path at every budget (expansion=%s), while search remains capped', async expansion => {
    const w = await withDocuments();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    // Main has an uncapped default. Explicit 0 selects that same pre-existing path, including the budget cut,
    // relevance, expansion and reply serialization. Compare the entire reply, not just its hit count.
    if (expansion === undefined) delete process.env.RENOR_SESSION_EXPAND;
    else process.env.RENOR_SESSION_EXPAND = expansion;
    const budgets = [400, 800, 1200, 2000, 4000];
    process.env.RENOR_SESSION_DIVERSITY = '0';
    const onMain = [];
    for (const max_tokens of budgets) {
      const reply = await w.call('get_context', { query: QUERY, max_tokens });
      expect(reply.isError).toBe(false);
      onMain.push(JSON.stringify(reply));
    }
    expect(JSON.parse(onMain.at(-1)!).body.memories.length).toBeGreaterThan(2);
    for (const unset of [undefined, '', '   ']) {
      if (unset === undefined) delete process.env.RENOR_SESSION_DIVERSITY;
      else process.env.RENOR_SESSION_DIVERSITY = unset;
      for (const [i, max_tokens] of budgets.entries()) {
        const reply = await w.call('get_context', { query: QUERY, max_tokens });
        expect(JSON.stringify(reply), `default=${String(unset)}, budget=${max_tokens}`).toBe(onMain[i]);
      }
      expect(counts((await search(w, QUERY)).filter(h => h.reason !== SESSION_EXPAND_REASON))).toEqual([2, 2]);
    }
    // An explicitly armed cap keeps the behavior main already supported.
    process.env.RENOR_SESSION_DIVERSITY = '1';
    const armed = await w.call('get_context', { query: QUERY, max_tokens: 4000 });
    expect(armed.isError).toBe(false);
    expect(armed.body.memories.filter((m: { reason: string }) => m.reason.startsWith('semantic'))).toHaveLength(2);
    expect(JSON.stringify(armed)).not.toBe(onMain.at(-1));
  });

  it('an explicit 3 wins over the default', async () => {
    const w = await withDocuments();
    process.env.RENOR_SESSION_EXPAND = '0';
    process.env.RENOR_SESSION_DIVERSITY = '3';
    expect(counts(await search(w, QUERY))).toEqual([3, 3]);
  });
});
