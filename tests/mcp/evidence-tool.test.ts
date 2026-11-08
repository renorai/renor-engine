import { describe, it, expect, afterEach, vi } from 'vitest';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { createMcpTools } from '../../src/mcp/server';
import { resolveEvidenceToolOptions } from '../../src/evidence/options';
import type { EvidenceChat } from '../../src/evidence/secondPass';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tmpPath } from '../helpers/tmpPath';
import { hitList } from '../helpers/hitList';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

const DB = tmpPath('test-mcp-evidence.db');
const tmpDirs: string[] = [];
afterEach(() => {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpCachePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-evidence-'));
  tmpDirs.push(dir);
  return path.join(dir, 'evidence-cache.db');
}

function seedDb() {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-evidence-vault-'));
  tmpDirs.push(vaultPath);
  const notePath = path.join(vaultPath, 's.md');
  fs.writeFileSync(notePath, '# Session\n\nWe went camping for 3 days near the lake.\n\nFULL_NOTE_ONLY_MARKER');

  const db = openDb(DB);
  runMigrations(db);
  db.prepare("INSERT INTO notes VALUES (?,?,?,?,?,?)")
    .run(notePath, 'S', 'longmemeval-session', 'h1', '2026-03-30T00:00:00.000Z', JSON.stringify({ session_date: '2023/05/29' }));
  db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
    .run(notePath, '', 'We went camping for 3 days near the lake.', 0, 2, 10, 'h1');
  const idx = new VectorIndex(db, 4);
  idx.initTable();
  idx.upsert((db.prepare('SELECT id FROM chunks LIMIT 1').get() as any).id, [1, 0, 0, 0]);
  return { db, idx, vaultPath };
}

const ITEMS_JSON = JSON.stringify({ items: [{ item: 'camping trip', action: 'went on', amount: '3 days', date: '2023/05/29' }] });

function toolWith(db: any, idx: any, evidence: any, vaultPath: string) {
  const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.9, 0, 0, 0]]) };
  const tools = createMcpTools(db, idx, provider as any, { vaultPath, memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: DEFAULT_LEDGER_REL }, evidence);
  return {
    provider,
    // These tests read `search` as a hit list, which is its default shape (see hitList).
    tools: { ...tools, search: async (args: Parameters<typeof tools.search>[0]) => hitList(await tools.search(args)) },
  };
}

function fakeChat(): EvidenceChat & { mock: any } {
  return vi.fn(async () => ({ content: ITEMS_JSON, promptTokens: 1200, completionTokens: 40, latencyMs: 900 })) as any;
}

describe('MCP evidence tool', () => {
  it.skipIf(HTTP_SERVER_UNSUPPORTED)('mode off returns hits only and never calls the extractor', async () => {
    const { db, idx, vaultPath } = seedDb();
    const chat = fakeChat();
    const { tools } = toolWith(db, idx, { mode: 'off', model: 'gemma4:31b', maxSessions: 12, charCap: 6000, cachePath: tmpCachePath(), chat }, vaultPath);
    const res = await tools.evidence({ query: 'How many days was the camping trip?' });
    expect(res.evidence).toEqual({ status: 'skipped', reason: 'mode-off' });
    expect(res.hits.length).toBeGreaterThanOrEqual(1);
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('auto gating skips non-aggregate questions unless forced', async () => {
    const { db, idx, vaultPath } = seedDb();
    const chat = fakeChat();
    const { tools } = toolWith(db, idx, { mode: 'auto', model: 'gemma4:31b', maxSessions: 12, charCap: 6000, cachePath: tmpCachePath(), chat }, vaultPath);
    const skipped = await tools.evidence({ query: "What is my dog's name?" });
    expect(skipped.evidence).toEqual({ status: 'skipped', reason: 'intent' });
    expect(chat).not.toHaveBeenCalled();

    const forced = await tools.evidence({ query: "What is my dog's name?", force: true });
    expect(forced.evidence.status).toBe('ok');
    expect(forced.evidence.items).toHaveLength(1);
    expect(chat).toHaveBeenCalledTimes(1);
    db.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('runs on aggregate intent and replays the second identical question from cache', async () => {
    const { db, idx, vaultPath } = seedDb();
    const chat = fakeChat();
    const { tools } = toolWith(db, idx, { mode: 'auto', model: 'gemma4:31b', maxSessions: 12, charCap: 6000, cachePath: tmpCachePath(), chat }, vaultPath);
    const first = await tools.evidence({ query: 'How many days did the camping trip last?' });
    expect(first.evidence.status).toBe('ok');
    expect(first.evidence.fromCache).toBe(false);
    expect(first.evidence.items![0].amount).toBe('3 days');
    expect(first.evidence.sessions![0].chars).toBeGreaterThan(0);
    const prompt = (chat as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('FULL_NOTE_ONLY_MARKER');

    const second = await tools.evidence({ query: 'How many days did the camping trip last?' });
    expect(second.evidence.fromCache).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('degraded mode returns hits with an explicit reason when no extractor is configured', async () => {
    const { db, idx, vaultPath } = seedDb();
    const { tools } = toolWith(db, idx, { mode: 'always', model: 'gemma4:31b', maxSessions: 12, charCap: 6000 }, vaultPath);
    const res = await tools.evidence({ query: 'How many days did the camping trip last?' });
    expect(res.evidence).toEqual({ status: 'skipped', reason: 'extractor-unavailable' });
    db.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('degrades the dedicated evidence tool to an explicit parse-error skip instead of aborting search', async () => {
    const { db, idx, vaultPath } = seedDb();
    const chat = vi.fn(async () => ({ content: '{"items": [}]', latencyMs: 5 })) as any;
    const { tools } = toolWith(db, idx, { mode: 'always', model: 'gemma4:31b', maxSessions: 12, charCap: 6000, cachePath: tmpCachePath(), chat }, vaultPath);
    const res = await tools.evidence({ query: 'How many days did the camping trip last?' });
    expect(res.evidence.status).toBe('skipped');
    expect(res.evidence.reason).toBe('extractor-parse-error');
    expect(res.hits.length).toBeGreaterThanOrEqual(1);
    expect(chat.mock.calls.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('default search calls the extractor (ship default ON); kill switch RENOR_SEARCH_EVIDENCE=0 turns it off', async () => {
    const previous = process.env.RENOR_SEARCH_EVIDENCE;
    process.env.RENOR_SEARCH_EVIDENCE = '0';
    const { db, idx, vaultPath } = seedDb();
    const chat = fakeChat();
    const { tools } = toolWith(db, idx, { mode: 'always', model: 'gemma4:31b', maxSessions: 12, charCap: 6000, cachePath: tmpCachePath(), chat }, vaultPath);
    const hits = await tools.search({ query: 'How many days did the camping trip last?' });
    expect(hits.every((h: { reason?: string }) => h.reason !== 'evidence')).toBe(true);
    expect(chat).not.toHaveBeenCalled();

    process.env.RENOR_SEARCH_EVIDENCE = '1';
    const withEvidence = await tools.search({ query: 'How many days did the camping trip last?' });
    expect(withEvidence[0].reason).toBe('evidence');
    expect(withEvidence[0].text).toContain('camping trip');
    expect(withEvidence[0].text).not.toMatch(/^\[Session date:/);
    expect(chat).toHaveBeenCalledTimes(1);
    if (previous === undefined) delete process.env.RENOR_SEARCH_EVIDENCE;
    else process.env.RENOR_SEARCH_EVIDENCE = previous;
    db.close();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('the shipped default sends nothing, even forced; always extracts intent and non-intent queries; both off switches suppress calls', async () => {
    const previous = process.env.RENOR_SEARCH_EVIDENCE;
    delete process.env.RENOR_SEARCH_EVIDENCE;
    const { db, idx, vaultPath } = seedDb();
    try {
      const chat = fakeChat();
      // Empty env exercises real defaults without ambient keys or model calls.
      const defaults = resolveEvidenceToolOptions({ dbPath: db.name }, {});
      expect(defaults.mode).toBe('off');
      expect(defaults.maxSessions).toBe(20);
      expect(defaults.model).toBe('gemma4:31b');
      const unset = toolWith(db, idx, { ...defaults, chat, cachePath: tmpCachePath() }, vaultPath).tools;
      const unsetHits = await unset.search({ query: 'How many days did the camping trip last?' });
      expect(unsetHits.every((h: { reason?: string }) => h.reason !== 'evidence')).toBe(true);
      expect((await unset.evidence({ query: 'How many camping trips?', force: true })).evidence).toEqual({ status: 'skipped', reason: 'mode-off' });
      expect(chat).not.toHaveBeenCalled();

      const resolved = resolveEvidenceToolOptions({ dbPath: db.name }, { RENOR_EVIDENCE_MODE: 'always' });
      expect(resolved.mode).toBe('always');
      const { tools } = toolWith(db, idx, { ...resolved, chat, cachePath: tmpCachePath() }, vaultPath);
      const withEvidence = await tools.search({ query: 'How many days did the camping trip last?' });
      expect(withEvidence[0].reason).toBe('evidence');
      const nonIntent = await tools.search({ query: 'What is my favorite campsite snack?' });
      expect(nonIntent[0].reason).toBe('evidence');
      expect(chat).toHaveBeenCalledTimes(2);

      process.env.RENOR_SEARCH_EVIDENCE = '0';
      const hitsOff = await tools.search({ query: 'Where did I camp?' });
      expect(hitsOff.every((h: { reason?: string }) => h.reason !== 'evidence')).toBe(true);
      expect(chat).toHaveBeenCalledTimes(2);

      delete process.env.RENOR_SEARCH_EVIDENCE;
      const off = resolveEvidenceToolOptions({ dbPath: db.name }, { RENOR_EVIDENCE_MODE: 'off' });
      const disabled = toolWith(db, idx, { ...off, chat, cachePath: tmpCachePath() }, vaultPath).tools;
      const modeOff = await disabled.search({ query: 'How many camping trips?' });
      expect(modeOff.every((h: { reason?: string }) => h.reason !== 'evidence')).toBe(true);
      const forcedOff = await disabled.evidence({ query: 'How many camping trips?', force: true });
      expect(forcedOff.evidence).toEqual({ status: 'skipped', reason: 'mode-off' });
      expect(chat).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined) delete process.env.RENOR_SEARCH_EVIDENCE;
      else process.env.RENOR_SEARCH_EVIDENCE = previous;
      db.close();
    }
  });
});
