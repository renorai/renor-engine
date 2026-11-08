import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EvidenceCache } from '../../src/evidence/evidenceCache';
import {
  EvidenceExtractor,
  parseEvidenceItems,
  renderEvidencePrompt,
  loadEvidenceSessionsFromVault,
} from '../../src/evidence/secondPass';
import { evidenceGate, hasEvidenceIntent, resolveEvidenceMode } from '../../src/evidence/gate';
import { removeTestDir } from '../helpers/removeDb';
import {
  attachSearchEvidence,
  evidenceItemsToFactRows,
  EVIDENCE_HIT_PATH,
  searchEvidenceEnabled,
} from '../../src/evidence/attach';

const tmpDirs: string[] = [];
function tmpCachePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  tmpDirs.push(dir);
  return path.join(dir, 'evidence-cache.db');
}
const openCaches: EvidenceCache[] = [];
/** A cache in a new temporary directory, closed by afterEach before its directory is removed. */
function openCache(): EvidenceCache {
  const cache = new EvidenceCache(tmpCachePath());
  openCaches.push(cache);
  return cache;
}
afterEach(() => {
  for (const cache of openCaches.splice(0)) cache.close();
  for (const d of tmpDirs.splice(0)) removeTestDir(d);
});

const ITEMS_JSON = JSON.stringify({ items: [{ item: 'camping trip', action: 'went on', amount: '3 days', date: '2023/05/29' }] });

function fakeChat(content = ITEMS_JSON) {
  const fn = vi.fn(async () => ({ content, promptTokens: 1000, completionTokens: 50, latencyMs: 123 }));
  return Object.assign(fn, { calls: 0 });
}

describe('evidence session hydration', () => {
  it('hydrates complete source notes in rank order instead of retrieved chunks', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-vault-'));
    tmpDirs.push(vault);
    const paths = Array.from({ length: 15 }, (_, i) => path.join(vault, `s${i}.md`));
    for (let i = 0; i < paths.length; i++) fs.writeFileSync(paths[i], `# S${i}\n\nfull source ${i}`);
    const hits = Array.from({ length: 20 }, (_, i) => ({
      notePath: paths[i % 15], text: `retrieved chunk ${i}`, session_date: '2023/05/29',
    }));
    const selected = await loadEvidenceSessionsFromVault(hits, vault, { maxSessions: 12, charCap: 6000 });
    expect(selected).toHaveLength(12);
    expect(selected.map(s => s.stem)).toEqual(paths.slice(0, 12));
    expect(selected[0].text).toContain('full source 0');
    expect(selected[0].text).not.toContain('retrieved chunk 0');
  });

  it('hydrates 20 distinct notes by default and caps further candidates', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-default-vault-'));
    tmpDirs.push(vault);
    const paths = Array.from({ length: 21 }, (_, i) => path.join(vault, `s${i}.md`));
    for (const notePath of paths) fs.writeFileSync(notePath, '# Session\n\nsource body');
    const selected = await loadEvidenceSessionsFromVault(paths.map(notePath => ({ notePath, text: '' })), vault);
    expect(selected).toHaveLength(20);
    expect(selected.map(s => s.stem)).toEqual(paths.slice(0, 20));
  });

  it('caps the complete note body', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-vault-'));
    tmpDirs.push(vault);
    const a = path.join(vault, 'a.md');
    const b = path.join(vault, 'b.md');
    fs.writeFileSync(a, '# A\n\n' + 'x'.repeat(7000));
    fs.writeFileSync(b, '# B\n\nshort');
    const selected = await loadEvidenceSessionsFromVault([
      { notePath: a, text: 'tiny chunk' }, { notePath: b, text: 'other chunk' },
    ], vault, { maxSessions: 12, charCap: 6000 });
    expect(selected).toHaveLength(2);
    expect(selected[0].text.endsWith('…[truncated]')).toBe(true);
    expect(selected[0].text.length).toBe(6000 + ' …[truncated]'.length);
    expect(selected[1].text).toContain('short');
  });

  it('skips unreadable hits and backfills later readable source notes', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-vault-'));
    tmpDirs.push(vault);
    const a = path.join(vault, 'a.md');
    const b = path.join(vault, 'b.md');
    fs.writeFileSync(a, '# A\n\nalpha');
    fs.writeFileSync(b, '# B\n\nbeta');
    const selected = await loadEvidenceSessionsFromVault([
      { notePath: path.join(vault, 'missing.md'), text: 'virtual' },
      { notePath: a, text: 'chunk a' },
      { notePath: b, text: 'chunk b' },
    ], vault, { maxSessions: 2, charCap: 6000 });
    expect(selected.map(s => s.stem)).toEqual([a, b]);
  });

  it('rejects invalid caps', async () => {
    await expect(loadEvidenceSessionsFromVault([], '/tmp', { maxSessions: 0 })).rejects.toThrow(/maxSessions/);
    await expect(loadEvidenceSessionsFromVault([], '/tmp', { charCap: 0 })).rejects.toThrow(/charCap/);
  });
});

describe('evidence parsing (fail-fast)', () => {
  it('parses minified JSON and fenced JSON', () => {
    expect(parseEvidenceItems(ITEMS_JSON)).toHaveLength(1);
    expect(parseEvidenceItems('```json\n' + ITEMS_JSON + '\n```')).toHaveLength(1);
  });

  it('throws on malformed JSON and on a missing items list', () => {
    expect(() => parseEvidenceItems('{"items": [}]')).toThrow(/malformed JSON/);
    expect(() => parseEvidenceItems('{"items": [')).toThrow(/JSON object/);
    expect(() => parseEvidenceItems('{"foo": 1}')).toThrow(/items list/);
    expect(() => parseEvidenceItems('no object here')).toThrow(/JSON object/);
    expect(() => parseEvidenceItems('{"items":[null]}')).toThrow(/must be an object/);
    expect(() => parseEvidenceItems('{"items":[{"item":""}]}')).toThrow(/non-empty item/);
  });
});

describe('content-addressed cache', () => {
  it('roundtrips, ignores duplicate puts, and counts hits', () => {
    const cache = openCache();
    const key = EvidenceCache.computeKey('gemma4:31b', 'prompt');
    expect(cache.get(key)).toBeNull();
    cache.put(key, {
      items: [{ item: 'a' }],
      sessions: [{ stem: '/v/a.md', chars: 10 }],
      model: 'gemma4:31b',
      question: 'q',
      promptTokens: 10,
      completionTokens: 2,
      createdAt: '2026-09-19T00:00:00.000Z',
    });
    cache.put(key, {
      items: [{ item: 'SHOULD NOT OVERWRITE' }],
      sessions: [],
      model: 'gemma4:31b',
      question: 'q',
      promptTokens: 10,
      completionTokens: 2,
      createdAt: '2026-09-19T00:00:01.000Z',
    });
    const got = cache.get(key)!;
    expect(got.items).toEqual([{ item: 'a' }]);
    const stats = cache.stats();
    expect(stats.entries).toBe(1);
    expect(stats.hits).toBe(1);
    cache.close();
  });

  it('keys differ when the prompt, model, or session content changes', () => {
    const a = EvidenceCache.computeKey('gemma4:31b', renderEvidencePrompt('q', [{ stem: 's', text: 'text one' }]));
    const same = EvidenceCache.computeKey('gemma4:31b', renderEvidencePrompt('q', [{ stem: 's', text: 'text one' }]));
    const otherText = EvidenceCache.computeKey('gemma4:31b', renderEvidencePrompt('q', [{ stem: 's', text: 'text two' }]));
    const otherModel = EvidenceCache.computeKey('other-model', renderEvidencePrompt('q', [{ stem: 's', text: 'text one' }]));
    expect(a).toBe(same);
    expect(a).not.toBe(otherText);
    expect(a).not.toBe(otherModel);
  });
});

describe('EvidenceExtractor', () => {
  it('calls the model once on a miss, then replays from cache with zero calls', async () => {
    const chat = fakeChat();
    const extractor = new EvidenceExtractor({ chat, cache: openCache() });
    const sessions = [{ stem: '/v/a.md', date: '2023/05/29', text: 'we went camping for 3 days' }];

    const first = await extractor.extract('how many days did we camp?', sessions);
    expect(first.fromCache).toBe(false);
    expect(first.items[0].item).toBe('camping trip');
    expect(first.usage.promptTokens).toBe(1000);
    expect(chat).toHaveBeenCalledTimes(1);

    const second = await extractor.extract('how many days did we camp?', sessions);
    expect(second.fromCache).toBe(true);
    expect(second.items).toEqual(first.items);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('a session content change forces a fresh call', async () => {
    const chat = fakeChat();
    const cache = openCache();
    const extractor = new EvidenceExtractor({ chat, cache });
    await extractor.extract('q', [{ stem: '/v/a.md', text: 'v1' }]);
    await extractor.extract('q', [{ stem: '/v/a.md', text: 'v2' }]);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('does not cache a malformed response', async () => {
    const chat = fakeChat('{"items": [}]');
    const cache = openCache();
    const extractor = new EvidenceExtractor({ chat, cache });
    await expect(extractor.extract('q', [{ stem: '/v/a.md', text: 't' }])).rejects.toThrow(/malformed JSON/);
    expect(cache.stats().entries).toBe(0);
  });

  it('requires at least one session', async () => {
    const extractor = new EvidenceExtractor({ chat: fakeChat() });
    await expect(extractor.extract('q', [])).rejects.toThrow(/at least one session/);
  });
});

describe('gating', () => {
  it('resolves modes from env with the off default and rejects invalid values', () => {
    // Self-hosted: the pass sends notes to a provider, so it runs only when the user turns it on.
    expect(resolveEvidenceMode({})).toBe('off');
    expect(resolveEvidenceMode({ RENOR_EVIDENCE_MODE: '' })).toBe('off');
    expect(resolveEvidenceMode({ RENOR_EVIDENCE_MODE: '   ' })).toBe('off');
    expect(resolveEvidenceMode({ RENOR_EVIDENCE_MODE: 'auto' })).toBe('auto');
    expect(resolveEvidenceMode({ RENOR_EVIDENCE_MODE: 'always' })).toBe('always');
    expect(resolveEvidenceMode({ RENOR_EVIDENCE_MODE: ' Always ' })).toBe('always');
    expect(resolveEvidenceMode({ RENOR_EVIDENCE_MODE: 'on' })).toBe('always');
    expect(resolveEvidenceMode({ RENOR_EVIDENCE_MODE: 'OFF' })).toBe('off');
    expect(() => resolveEvidenceMode({ RENOR_EVIDENCE_MODE: 'sometimes' })).toThrow(/Invalid RENOR_EVIDENCE_MODE/);
  });

  it('runs on aggregate intent in auto, on force, and always in always', () => {
    expect(hasEvidenceIntent('How many days did the trip last?')).toBe(true);
    expect(hasEvidenceIntent('What is my dog\'s name?')).toBe(false);
    expect(evidenceGate('auto', 'What is my dog\'s name?')).toEqual({ run: false, reason: 'intent' });
    expect(evidenceGate('auto', 'What is my dog\'s name?', true)).toEqual({ run: true, reason: 'forced' });
    expect(evidenceGate('auto', 'How many books did I read?')).toEqual({ run: true, reason: 'intent' });
    expect(evidenceGate('always', 'anything')).toEqual({ run: true, reason: 'mode-always' });
    expect(evidenceGate('off', 'How many books did I read?', true)).toEqual({ run: false, reason: 'mode-off' });
  });
});

describe('search-path evidence attach', () => {
  it('is ON by default (2026-09-22 ship decision) and the kill switch restores off', () => {
    expect(searchEvidenceEnabled({})).toBe(true);
    expect(searchEvidenceEnabled({ RENOR_SEARCH_EVIDENCE: '1' })).toBe(true);
    expect(searchEvidenceEnabled({ RENOR_SEARCH_EVIDENCE: 'off' })).toBe(false);
    expect(searchEvidenceEnabled({ RENOR_SEARCH_EVIDENCE: '0' })).toBe(false);
  });

  it('does not rewrite ranked hits when the flag is off', async () => {
    const chat = fakeChat();
    const extractor = new EvidenceExtractor({ chat });
    const hits = [{
      notePath: '/v/a.md',
      chunkId: 1,
      headingPath: '',
      text: 'retrieved chunk',
      score: 0.9,
      reason: 'semantic',
    }];
    const attached = await attachSearchEvidence({
      query: 'How many days did we camp?',
      hits,
      vaultPath: '/v',
      options: { mode: 'always', model: 'gemma4:31b', maxSessions: 12, charCap: 6000, chat },
      extractor,
      enabled: false,
    });
    expect(attached.hits).toEqual(hits);
    expect(attached.evidence).toEqual({ status: 'skipped', reason: 'flag-off' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('prepends a synthetic evidence hit without rewriting stored chunk text', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-attach-'));
    tmpDirs.push(vault);
    const note = path.join(vault, 'a.md');
    fs.writeFileSync(note, '# A\n\nwe went camping for 3 days\nFULL_NOTE_ONLY_MARKER');
    const chat = fakeChat();
    const extractor = new EvidenceExtractor({ chat, cache: openCache() });
    const hits = [{
      notePath: note,
      chunkId: 1,
      headingPath: '',
      text: 'retrieved chunk',
      score: 0.9,
      reason: 'semantic',
      session_date: '2023/05/29',
    }];
    const first = await attachSearchEvidence({
      query: 'How many days did we camp?',
      hits,
      vaultPath: vault,
      options: { mode: 'always', model: 'gemma4:31b', maxSessions: 12, charCap: 6000, chat },
      extractor,
      enabled: true,
    });
    expect(first.hits[0].notePath).toBe(EVIDENCE_HIT_PATH);
    expect(first.hits[0].reason).toBe('evidence');
    expect(first.hits[0].text).toContain('camping trip');
    expect(first.hits[1].text).toBe('retrieved chunk');
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = (chat as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('FULL_NOTE_ONLY_MARKER');
    expect(prompt).not.toContain('retrieved chunk');

    const second = await attachSearchEvidence({
      query: 'How many days did we camp?',
      hits,
      vaultPath: vault,
      options: { mode: 'always', model: 'gemma4:31b', maxSessions: 12, charCap: 6000, chat },
      extractor,
      enabled: true,
    });
    expect(second.evidence.fromCache).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(evidenceItemsToFactRows(first.evidence.items ?? [])[0].object).toBe('camping trip');
  });

  it('keeps ranked hits when the evidence provider fails', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-attach-provider-fail-'));
    tmpDirs.push(vault);
    const note = path.join(vault, 'a.md');
    fs.writeFileSync(note, '# A\n\nwe went camping for 3 days');
    const chat = vi.fn(async () => { throw new Error('provider unavailable'); }) as any;
    const extractor = new EvidenceExtractor({ chat });
    const hits = [{
      notePath: note,
      chunkId: 1,
      headingPath: '',
      text: 'retrieved chunk',
      score: 0.9,
      reason: 'semantic',
    }];
    const attached = await attachSearchEvidence({
      query: 'How many days did we camp?',
      hits,
      vaultPath: vault,
      options: { mode: 'always', model: 'gemma4:31b', maxSessions: 12, charCap: 6000, chat },
      extractor,
      enabled: true,
    });
    expect(attached.hits).toEqual(hits);
    expect(attached.evidence.status).toBe('skipped');
    expect(attached.evidence.reason).toBe('extractor-error');
    expect(attached.evidence.error).toContain('provider unavailable');
  });

  it('keeps ranked hits when the extractor returns unparseable JSON', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-attach-bad-'));
    tmpDirs.push(vault);
    const note = path.join(vault, 'a.md');
    fs.writeFileSync(note, '# A\n\nwe went camping for 3 days');
    const chat = fakeChat('not json');
    const extractor = new EvidenceExtractor({ chat });
    const hits = [{
      notePath: note,
      chunkId: 1,
      headingPath: '',
      text: 'retrieved chunk',
      score: 0.9,
      reason: 'semantic',
    }];
    const attached = await attachSearchEvidence({
      query: 'How many days did we camp?',
      hits,
      vaultPath: vault,
      options: { mode: 'always', model: 'gemma4:31b', maxSessions: 12, charCap: 6000, chat },
      extractor,
      enabled: true,
    });
    expect(attached.hits).toEqual(hits);
    expect(attached.evidence.status).toBe('skipped');
    expect(attached.evidence.reason).toBe('extractor-parse-error');
    expect(chat.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
