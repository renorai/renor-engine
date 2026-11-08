import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { createMcpTools } from '../../src/mcp/server';
import { engineSearchText } from '../../src/mvp/engine';
import { indexVault } from '../../src/indexer/pipeline';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { tmpPath } from '../helpers/tmpPath';
import { hitList } from '../helpers/hitList';
import { removeDb, removeTestDir } from '../helpers/removeDb';

/**
 * Regression: an agent searching memory by a hyphenated identifier.
 *
 * `chunks_fts` indexes chunk text and heading path only — `note_path` is UNINDEXED
 * and `parseNote` drops YAML frontmatter — so the identifiers agents actually search
 * with (task ids, slugs, file names) were unretrievable: `keyword` returned `[]`
 * while plain words from the same note returned hits. These tests drive the real
 * tools over a real indexed vault, so they fail if either the index or the tool
 * path regresses.
 */

const DB = tmpPath('test-hyphen-identifier-recall.db');
const vaults: string[] = [];
const openDbs: Array<ReturnType<typeof openDb>> = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  removeDb(DB);
  for (const v of vaults.splice(0)) removeTestDir(v);
});

/** A vault written to disk and indexed through the real pipeline, as a user would. */
async function indexedVault(files: Record<string, string>) {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-vault-'));
  vaults.push(vaultPath);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(vaultPath, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  const db = openDb(DB);
  openDbs.push(db);
  runMigrations(db);
  await indexVault(db, vaultPath, {}, 1);
  const vectorIndex = new VectorIndex(db, 4);
  vectorIndex.initTable();
  const mcpTools = createMcpTools(
    db,
    vectorIndex,
    { embed: vi.fn(), dimensions: 4 } as any,
    { vaultPath, memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: DEFAULT_LEDGER_REL }
  );
  // These tests run well-formed queries and read `keyword` as a hit list (see hitList).
  const tools = {
    ...mcpTools,
    keyword: async (args: Parameters<typeof mcpTools.keyword>[0]) => hitList(await mcpTools.keyword(args)),
  };
  return { db, vaultPath, tools };
}

const PROSE = 'Ordinary prose about bunnies, gates and deploy units.';

describe('hyphenated identifier recall through the keyword tool', () => {
  it('finds the note whose path/slug carries the identifier', async () => {
    const { db, tools } = await indexedVault({
      'data/space-bunny-eval-1001/report.md': `# Report\n\n${PROSE}\n`,
    });

    const control = await tools.keyword({ query: 'bunnies' });
    expect(control.length, 'plain words from the same note already matched — the control').toBeGreaterThan(0);

    const bySlug = await tools.keyword({ query: 'space-bunny-eval-1001' });
    expect(bySlug.length, 'the hyphenated slug must find the note that carries it').toBeGreaterThan(0);
    expect(bySlug[0].notePath).toContain('space-bunny-eval-1001');
    expect(bySlug[0].reason).toBe('note-identity');
    db.close();
  });

  it('finds the note whose frontmatter carries the identifier', async () => {
    const { db, tools } = await indexedVault({
      'notes/alpha-report.md': `---\nid: space-bunny-eval-1002\n---\n\n# Report\n\n${PROSE}\n`,
    });

    const byFrontmatter = await tools.keyword({ query: 'space-bunny-eval-1002' });
    expect(byFrontmatter.length).toBeGreaterThan(0);
    expect(byFrontmatter[0].notePath).toContain('alpha-report.md');
    db.close();
  });

  it('still finds an identifier that is in the prose, as a BM25 hit', async () => {
    const { db, tools } = await indexedVault({
      'notes/report.md': `# Report\n\nThe id is space-bunny-eval-1003 and ${PROSE}\n`,
    });

    const hits = await tools.keyword({ query: 'space-bunny-eval-1003' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].reason, 'prose hits keep their BM25 provenance').toBe('fts');
    db.close();
  });

  it('does not treat LIKE metacharacters in an identifier as wildcards', async () => {
    const { db, tools } = await indexedVault({
      'notes/MVP_MCP_JSON.md': `# Real\n\n${PROSE}\n`,
      'notes/MVPXMCPXJSON.md': `# Decoy\n\n${PROSE}\n`,
      'notes/100%-done.md': `# Pct\n\n${PROSE}\n`,
      'notes/1000-done.md': `# Thousand\n\n${PROSE}\n`,
    });
    const underscore = await tools.keyword({ query: 'MVP_MCP_JSON' });
    expect(underscore.map((h: any) => path.basename(h.notePath))).toEqual(['MVP_MCP_JSON.md']);
    const percent = await tools.keyword({ query: '100%-done' });
    expect(percent.map((h: any) => path.basename(h.notePath))).toEqual(['100%-done.md']);
    db.close();
  });

  it('does not turn fragments, extensions or directory words into "every note"', async () => {
    const { db, tools } = await indexedVault({
      'data/qx-hyphen-id-4242/report.md': `# Report\n\n${PROSE}\n`,
      'notes/alpha.md': `# Alpha\n\n${PROSE}\n`,
    });
    for (const q of ['md', '.md', 'notes', 'OR', '4242', 'qx-hyphen', 'hyphen-id-4242']) {
      expect(await tools.keyword({ query: q }), q).toEqual([]);
    }
    const exact = await tools.keyword({ query: 'qx-hyphen-id-4242' });
    expect(exact.map((h: any) => h.notePath.replace(/^.*?(?=data\/)/, ''))).toEqual(['data/qx-hyphen-id-4242/report.md']);
    db.close();
  });

  it('returns the named note beside a prose hit that merely tokenizes the same words', async () => {
    const { db, tools } = await indexedVault({
      'notes/collision-prose.md': `# Prose\n\nSee collision id 55 for details.\n`,
      'data/collision-id-55/note.md': `# Named\n\n${PROSE}\n`,
    });
    const hits = await tools.keyword({ query: 'collision-id-55' });
    const paths = hits.map((h: any) => h.notePath);
    expect(paths.some((p: string) => p.endsWith('data/collision-id-55/note.md'))).toBe(true);
    expect(hits[0].reason, 'prose hits keep rank 1').toBe('fts');
    db.close();
  });

  it('returns [] when the identifier is genuinely nowhere in the index', async () => {
    const { db, tools } = await indexedVault({ 'notes/report.md': `# Report\n\n${PROSE}\n` });
    const hits = await tools.keyword({ query: 'space-bunny-eval-9999' });
    expect(hits).toEqual([]);
    db.close();
  });
});

describe('hyphenated identifier recall through the alpha search_text path', () => {
  it('engineSearchText falls back to note identity instead of returning []', async () => {
    const { db, vaultPath } = await indexedVault({
      'data/space-bunny-eval-1005/report.md': `# Report\n\n${PROSE}\n`,
    });

    const body = engineSearchText(db, vaultPath, 'space-bunny-eval-1005', 20);
    expect(body.ok).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect((body.results[0] as any).reason).toBe('note-identity');
    db.close();
  });

  it('engineSearchText still returns BM25 hits for prose identifiers', async () => {
    const { db, vaultPath } = await indexedVault({
      'notes/report.md': `# Report\n\nThe id is space-bunny-eval-1006 and ${PROSE}\n`,
    });

    const body = engineSearchText(db, vaultPath, 'space-bunny-eval-1006', 20);
    expect(body.results.length).toBeGreaterThan(0);
    expect((body.results[0] as any).reason).toBe('fts');
    db.close();
  });

  it('keeps an in-scope named note when the only prose hit is out of scope', async () => {
    const { db, vaultPath } = await indexedVault({
      'notes/out-of-scope.md': `# Out\n\nSee collision scope 88.\n`,
      'Memory/Scopes/alpha/collision-scope-88.md': `# Named\n\n${PROSE}\n`,
    });
    const body = engineSearchText(db, vaultPath, 'collision-scope-88', 20, 'alpha');
    expect(body.results.map((r: any) => r.notePath).join()).toContain('collision-scope-88');
    db.close();
  });

  it('applies scope before the identity limit', async () => {
    const files: Record<string, string> = {
      'Memory/Scopes/alpha/zz-scope-id-77.md': `---\nid: scoped-id-77\n---\n\n# In\n\n${PROSE}\n`,
    };
    for (let i = 0; i < 21; i++) files[`A/out-${i}/scoped-id-77.md`] = `# Out\n\n${PROSE}\n`;
    const { db, vaultPath } = await indexedVault(files);
    for (const k of [1, 20]) {
      const body = engineSearchText(db, vaultPath, 'scoped-id-77', k, 'alpha');
      expect(body.results.map((r: any) => r.notePath).join(), `topK=${k}`).toContain('zz-scope-id-77');
    }
    db.close();
  });
});

describe('a full prose page is never shortened by the named note', () => {
  const files = () => {
    const f: Record<string, string> = { 'Memory/Scopes/alpha/zz-full-id-77.md': `# Named\n\n${PROSE}\n` };
    for (let i = 0; i < 21; i++) f[`notes/full-${i}.md`] = `# Prose\n\nzz full id 77.\n`;
    return f;
  };

  it('keyword returns the whole prose page plus the named note', async () => {
    const { db, tools } = await indexedVault(files());
    const hits = await tools.keyword({ query: 'zz-full-id-77' });
    expect(hits.filter((h: any) => h.reason === 'fts')).toHaveLength(20);
    expect(hits.some((h: any) => h.notePath.endsWith('zz-full-id-77.md'))).toBe(true);
    expect(hits[0].reason).toBe('fts');
    db.close();
  });

  it('engineSearchText returns the whole prose page plus the named note', async () => {
    const { db, vaultPath } = await indexedVault(files());
    const body = engineSearchText(db, vaultPath, 'zz-full-id-77', 20);
    expect(body.results.filter((r: any) => r.reason === 'fts')).toHaveLength(20);
    expect(body.results.some((r: any) => r.notePath.endsWith('zz-full-id-77.md'))).toBe(true);
    db.close();
  });

  it('a named note whose own body ranks beyond topK is still returned in scope', async () => {
    const f: Record<string, string> = {
      'Memory/Scopes/alpha/zz-ranked-id-77.md': '# Named\n\nzz ranked id 77. ' + 'ordinary filler '.repeat(300),
    };
    for (let i = 0; i < 21; i++) f[`Memory/Scopes/alpha/ranked-${i}.md`] = '# Prose\n\nzz ranked id 77.\n';
    const { db, vaultPath } = await indexedVault(f);
    const body = engineSearchText(db, vaultPath, 'zz-ranked-id-77', 20, 'alpha');
    expect(body.results.some((r: any) => r.notePath.endsWith('zz-ranked-id-77.md'))).toBe(true);
    db.close();
  });
});

describe('identifier stems ending in punctuation', () => {
  it('finds notes/literally-100%.md by its exact stem', async () => {
    const { db, tools } = await indexedVault({
      'notes/literally-100%.md': `# T\n\n${PROSE}\n`,
      'notes/1000.md': `# U\n\n${PROSE}\n`,
    });
    const hits = await tools.keyword({ query: 'literally-100%' });
    expect(hits.map((h: any) => path.basename(h.notePath))).toEqual(['literally-100%.md']);
    db.close();
  });
});
