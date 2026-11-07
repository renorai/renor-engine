import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { remember, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { appendDailyMemory } from '../../src/memory/writer';
import {
  buildMemoryMap,
  memoryPathTree,
  recallFileTreeOn,
  readMemory,
  retireMemory,
  restoreMemory,
  type MemoryMapContext,
} from '../../src/memorymap/memoryMap';

/**
 * The memory map is the dashboard's read model: every node and link must come from something the
 * workspace actually stores, and retirement must be a reversible move that takes the text out of
 * retrieval. Synthetic vault only.
 */

function write(vault: string, rel: string, content: string) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function ftsHits(db: Database.Database, term: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM chunks_fts WHERE chunks_fts MATCH ?').get(term) as { c: number }).c;
}

// The secret guard is on by default. These tests store fixture text that the guard refuses (a credential-shaped or an
// identifier-shaped sentence that is incidental to what each test checks), so they run with it explicitly off.
const SAVED_GUARD = process.env.RENOR_SECRET_GUARD;
beforeAll(() => { process.env.RENOR_SECRET_GUARD = '0'; });
afterAll(() => { if (SAVED_GUARD === undefined) delete process.env.RENOR_SECRET_GUARD; else process.env.RENOR_SECRET_GUARD = SAVED_GUARD; });

describe('memory map', () => {
  let vault: string;
  let db: Database.Database;
  let ctx: MemoryMapContext;

  beforeEach(async () => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memmap-vault-'));
    db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    ctx = { db, memoryDir: vault, ledgerRelPath: DEFAULT_LEDGER_REL, indexOptions: {} };

    write(vault, 'Projects/Gateway plan.md',
      '---\ntags: [infra, deploy]\nstatus: active\nupdated: 2026-09-30\n---\n# Gateway plan\n\nThe Gateway runs on the alpha VM. See [[Merge rules]].\n');
    write(vault, 'Projects/Merge rules.md',
      '---\ntags: process\n---\n# Merge rules\n\nCritical PRs need the owner. Quokkafern is the codeword.\n');
    await appendDailyMemory(vault, '2026-10-01', { text: 'Prefers short answers from agents', source: 'claude' });
    await appendDailyMemory(vault, '2026-10-01', { text: 'The Gateway deploy renames dist', source: 'cursor' });
    await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Gateway', predicate: 'hosted_on', object: 'alpha VM' });
    await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Gateway', predicate: 'hosted_on', object: 'GCE demo-host-1' });
    await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Renor', predicate: 'components', object: 'Engine and Gateway' });
    await indexVault(db, vault, {});
  });

  afterEach(() => {
    db.close();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('lists notes and daily entries as memories, never the ledger', async () => {
    const map = await buildMemoryMap(ctx);
    const titles = map.memories.map((m) => m.title).sort();
    expect(titles).toEqual(['Gateway plan', 'Merge rules', 'Prefers short answers from agents', 'The Gateway deploy renames dist']);
    expect(map.memories.some((m) => m.path === DEFAULT_LEDGER_REL)).toBe(false);

    const entry = map.memories.find((m) => m.kind === 'entry' && m.source === 'claude')!;
    expect(entry.path).toBe('Memory/Daily/2026-10-01.md');
    expect(entry.at.startsWith('2026-10-01T')).toBe(true);

    const note = map.memories.find((m) => m.title === 'Gateway plan')!;
    expect(note.tags).toEqual(['infra', 'deploy']);
    expect(note.status).toBe('active');
    // Frontmatter is metadata, not text.
    expect(note.excerpt).not.toMatch(/tags|status/);
  });

  it('lists ledger facts with their history, and frontmatter is never a fact', async () => {
    const map = await buildMemoryMap(ctx);
    const hosted = map.facts.filter((f) => f.subject === 'Gateway' && f.predicate === 'hosted_on');
    expect(hosted.map((f) => [f.object, f.validTo === null])).toEqual([
      ['GCE demo-host-1', true],
      ['alpha VM', false],
    ]);
    expect(map.facts.some((f) => ['tags', 'status', 'updated', 'owner'].includes(f.predicate))).toBe(false);
    expect(map.things.map((t) => t.name).sort()).toEqual(['Gateway', 'Renor']);
  });

  it('every link is grounded: tags, wikilinks, literal mentions, and facts naming another thing', async () => {
    const map = await buildMemoryMap(ctx);
    const gatewayThing = map.things.find((t) => t.name === 'Gateway')!.id;
    const renorThing = map.things.find((t) => t.name === 'Renor')!.id;
    const plan = 'note:Projects/Gateway plan.md';
    const rules = 'note:Projects/Merge rules.md';
    const has = (s: string, t: string, kind: string) => map.links.some((l) => l.source === s && l.target === t && l.kind === kind);

    expect(has(plan, 'topic:infra', 'tag')).toBe(true);
    expect(has(rules, 'topic:process', 'tag')).toBe(true);
    expect(has(plan, rules, 'wikilink')).toBe(true);
    expect(has(plan, gatewayThing, 'mention')).toBe(true);
    // "Merge rules" never says Gateway or Renor: no invented link.
    expect(map.links.some((l) => l.source === rules && l.kind === 'mention')).toBe(false);
    // Renor's current fact names the Gateway.
    expect(map.links.some((l) => l.source === renorThing && l.target === gatewayThing && l.kind === 'fact' && l.label === 'components')).toBe(true);
    expect(map.topics.find((t) => t.name === 'infra')?.memories).toBe(1);
  });

  it('reads one memory in full, with metadata apart from text', async () => {
    const detail = await readMemory(ctx, 'note:Projects/Gateway plan.md');
    expect(detail.text).toContain('The Gateway runs on the alpha VM.');
    expect(detail.text).not.toContain('status: active');
    expect(detail.metadata.status).toBe('active');
    expect(detail.facts.some((f) => f.predicate === 'tags')).toBe(false);

    const map = await buildMemoryMap(ctx);
    const entry = map.memories.find((m) => m.kind === 'entry' && m.source === 'cursor')!;
    const entryDetail = await readMemory(ctx, entry.id);
    expect(entryDetail.text).toBe('The Gateway deploy renames dist');
  });

  it('refuses paths outside the vault, hidden directories and the ledger', async () => {
    await expect(readMemory(ctx, 'note:../outside.md')).rejects.toThrow(/escapes/);
    await expect(readMemory(ctx, 'note:.trash/renor-retired/x.md')).rejects.toThrow(/hidden/);
    await expect(retireMemory(ctx, `note:${DEFAULT_LEDGER_REL}`)).rejects.toThrow(/ledger/);
    await expect(readMemory(ctx, 'bogus:x')).rejects.toThrow(/unknown memory id/);
  });

  it('retiring a note moves it out of retrieval; restoring brings back the same bytes', async () => {
    const id = 'note:Projects/Merge rules.md';
    const original = fs.readFileSync(path.join(vault, 'Projects/Merge rules.md'), 'utf8');
    expect(ftsHits(db, 'Quokkafern')).toBe(1);

    const receipt = await retireMemory(ctx, id);
    expect(receipt.action).toBe('retired');
    expect(fs.existsSync(path.join(vault, 'Projects/Merge rules.md'))).toBe(false);
    expect(ftsHits(db, 'Quokkafern')).toBe(0);
    // A full reindex does not resurrect it (.trash is ignored by the walker).
    await indexVault(db, vault, {});
    expect(ftsHits(db, 'Quokkafern')).toBe(0);

    let map = await buildMemoryMap(ctx);
    expect(map.memories.some((m) => m.id === id)).toBe(false);
    expect(map.retired.map((r) => r.memoryId)).toEqual([id]);
    expect(map.retired[0].id).toMatch(/^retired:[0-9a-f]{16}$/);
    expect(map.events.find((e) => e.action === 'retire')?.memoryId).toBe(id);
    // The wikilink to a retired note is gone, not dangling.
    expect(map.links.some((l) => l.target === id)).toBe(false);

    const restored = await restoreMemory(ctx, id);
    expect(restored.action).toBe('restored');
    expect(fs.readFileSync(path.join(vault, 'Projects/Merge rules.md'), 'utf8')).toBe(original);
    expect(ftsHits(db, 'Quokkafern')).toBe(1);
    map = await buildMemoryMap(ctx);
    expect(map.retired).toEqual([]);
    expect(map.memories.some((m) => m.id === id)).toBe(true);
    await expect(restoreMemory(ctx, id)).rejects.toThrow(/no retired memory/);
  });

  it('a daily entry filed under a future date is dated by its write time, so it does not list first (review S1)', async () => {
    // remember_note({ text, date: "2099-01-01" }) files the entry under the 2099 file name. Its header is the time it was
    // written; the file is written at T0, and an ordinary entry at T1 > T0. The map must date the 2099 entry by T0.
    const T0 = '2026-10-06T22:36:20.000Z';
    const T1 = '2026-10-06T22:37:09.000Z';
    const future = 'Memory/Daily/2099-01-01.md';
    const ordinary = 'Memory/Daily/2026-10-06.md';
    await appendDailyMemory(vault, '2099-01-01', { text: 'Quillmoor staging uses a separate Supabase project.', source: 'claude' }, undefined, { time: '22:36:20' });
    await appendDailyMemory(vault, '2026-10-06', { text: 'Quillmoor kickoff call with the bakery owner.', source: 'claude' }, undefined, { time: '22:37:09' });
    fs.utimesSync(path.join(vault, future), new Date(T0), new Date(T0));
    fs.utimesSync(path.join(vault, ordinary), new Date(T1), new Date(T1));
    await indexVault(db, vault, {});

    const map = await buildMemoryMap(ctx);
    const futureEntry = map.memories.find((m) => m.path === future)!;
    const ordinaryEntry = map.memories.find((m) => m.path === ordinary)!;
    expect(futureEntry.at).toBe(T0);
    expect(ordinaryEntry.at).toBe(T1);
    expect(map.memories.indexOf(ordinaryEntry)).toBeLessThan(map.memories.indexOf(futureEntry));
    expect(map.memories.map((m) => m.at).join(' ')).not.toContain('2099');
    // Reading it one by one shows the same date the list does.
    expect((await readMemory(ctx, futureEntry.id)).memory.at).toBe(T0);
  });

  it('retiring a daily entry removes only that line, and restore puts it back', async () => {
    const before = await buildMemoryMap(ctx);
    const target = before.memories.find((m) => m.kind === 'entry' && m.source === 'claude')!;
    const other = before.memories.find((m) => m.kind === 'entry' && m.source === 'cursor')!;
    const dailyAbs = path.join(vault, 'Memory/Daily/2026-10-01.md');

    await retireMemory(ctx, target.id);
    const after = fs.readFileSync(dailyAbs, 'utf8');
    expect(after).not.toContain('Prefers short answers');
    expect(after).toContain('The Gateway deploy renames dist');
    expect(ftsHits(db, '"short answers"')).toBe(0);

    const mid = await buildMemoryMap(ctx);
    expect(mid.memories.some((m) => m.id === target.id)).toBe(false);
    // The retired entry keeps its original save time, so history does not move.
    expect(mid.retired.find((r) => r.memoryId === target.id)?.savedAt).toBe(target.at);
    expect(mid.memories.some((m) => m.id === other.id)).toBe(true);
    await expect(retireMemory(ctx, target.id)).rejects.toThrow(/not found/);

    await restoreMemory(ctx, target.id);
    expect(fs.readFileSync(dailyAbs, 'utf8')).toContain('Prefers short answers from agents');
    expect(ftsHits(db, '"short answers"')).toBe(1);
    const back = await buildMemoryMap(ctx);
    expect(back.memories.some((m) => m.id === target.id)).toBe(true);
  });

  it('restore never overwrites a file that took the retired note’s place', async () => {
    const id = 'note:Projects/Merge rules.md';
    await retireMemory(ctx, id);
    write(vault, 'Projects/Merge rules.md', '# Merge rules\n\nA newer note.\n');
    await expect(restoreMemory(ctx, id)).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(path.join(vault, 'Projects/Merge rules.md'), 'utf8')).toContain('A newer note.');
  });

  // --- Regression tests for the independent review (Codex, round 1) ---

  it('refuses a symlinked directory, including one that aliases the ledger', async () => {
    fs.symlinkSync(path.join(vault, 'System'), path.join(vault, 'Alias'));
    await expect(retireMemory(ctx, 'note:Alias/Memory Events Ledger.md')).rejects.toThrow(/symbolic link/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memmap-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), '# Secret\n\nOutside the vault.\n');
    fs.symlinkSync(outside, path.join(vault, 'Out'));
    await expect(readMemory(ctx, 'note:Out/secret.md')).rejects.toThrow(/symbolic link/);
    fs.rmSync(outside, { recursive: true, force: true });
    // The ledger itself is never a memory.
    await expect(retireMemory(ctx, `note:${DEFAULT_LEDGER_REL}`)).rejects.toThrow(/ledger/);
  });

  it('refuses hidden directories at any depth', async () => {
    write(vault, 'Projects/.trash/private.md', '# Private\n\nIgnored by the indexer.\n');
    await expect(readMemory(ctx, 'note:Projects/.trash/private.md')).rejects.toThrow(/hidden/);
    await expect(retireMemory(ctx, 'note:Projects/.trash/private.md')).rejects.toThrow(/hidden/);
  });

  it('retiring an entry in a large daily log keeps every other byte', async () => {
    const daily = path.join(vault, 'Memory/Daily/2026-10-01.md');
    // Larger than a whole-memory read (512 KiB), and more entries than the map lists for one day (500): 600 fillers of
    // about 1 KB. Each entry is a chunk to index, so it is their number, not their bytes, that the index passes pay for.
    // Fillers at 00:00:00 never sort ahead of the real entries: on a tie the sort keeps file order,
    // and the real entries come first in the file.
    const filler = Array.from({ length: 600 }, (_, i) => `- [00:00:00] (bulk) filler entry number ${i} ${'lorem ipsum dolor sit amet '.repeat(36)}`).join('\n');
    fs.appendFileSync(daily, `\n${filler}\n- [23:59:59] (claude) The very last entry stays`);
    expect(fs.statSync(daily).size).toBeGreaterThan(600_000);
    await indexVault(db, vault, {});
    const map = await buildMemoryMap(ctx);
    const target = map.memories.find((m) => m.kind === 'entry' && m.source === 'cursor')!;
    await retireMemory(ctx, target.id);
    const after = fs.readFileSync(daily, 'utf8');
    expect(after).toContain('The very last entry stays');
    expect(after).toContain('filler entry number 599 ');
    expect(after).not.toContain('The Gateway deploy renames dist');
  });

  it('a save that lands during a retire is never lost', async () => {
    const map = await buildMemoryMap(ctx);
    const target = map.memories.find((m) => m.kind === 'entry' && m.source === 'claude')!;
    await Promise.all([
      retireMemory(ctx, target.id),
      appendDailyMemory(vault, '2026-10-01', { text: 'Concurrent save one', source: 'pi' }),
      appendDailyMemory(vault, '2026-10-01', { text: 'Concurrent save two', source: 'pi' }),
    ]);
    const after = fs.readFileSync(path.join(vault, 'Memory/Daily/2026-10-01.md'), 'utf8');
    expect(after).toContain('Concurrent save one');
    expect(after).toContain('Concurrent save two');
    expect(after).not.toContain('Prefers short answers');
    expect(fs.readdirSync(path.join(vault, 'Memory/Daily')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('restoring a daily entry puts it back in its own place, however often it is retired', async () => {
    const daily = path.join(vault, 'Memory/Daily/2026-10-03.md');
    write(vault, 'Memory/Daily/2026-10-03.md', '---\nkind: note\n---\n# 2026-10-03\n\n- [08:00:00] (claude) morning\n- [12:00:00] (claude) noon\n- [18:00:00] (claude) evening');
    await indexVault(db, vault, {});
    const original = fs.readFileSync(daily, 'utf8');
    const noon = (await buildMemoryMap(ctx)).memories.find((m) => m.title === 'noon')!;

    await retireMemory(ctx, noon.id);
    await restoreMemory(ctx, noon.id);
    expect(fs.readFileSync(daily, 'utf8')).toBe(original);

    for (let cycle = 0; cycle < 5; cycle++) {
      await retireMemory(ctx, noon.id);
      await restoreMemory(ctx, noon.id);
    }
    expect(fs.readFileSync(daily, 'utf8')).toBe(original);
    expect((await buildMemoryMap(ctx)).memories.filter((m) => m.title === 'noon')).toHaveLength(1);
  });

  it('restoring an entry whose neighbours were retired in the meantime still puts it in time order', async () => {
    const daily = path.join(vault, 'Memory/Daily/2026-10-03.md');
    write(vault, 'Memory/Daily/2026-10-03.md', '---\nkind: note\n---\n# 2026-10-03\n\n- [08:00:00] (claude) morning\n- [12:00:00] (claude) noon\n- [18:00:00] (claude) evening');
    await indexVault(db, vault, {});
    const original = fs.readFileSync(daily, 'utf8');
    const idOf = async (title: string) => (await buildMemoryMap(ctx)).memories.find((m) => m.title === title)!.id;
    const morning = await idOf('morning');
    const noon = await idOf('noon');

    // noon was between morning and evening; morning goes next, so when noon comes back first, morning must
    // not land after it.
    await retireMemory(ctx, noon);
    await retireMemory(ctx, morning);
    await restoreMemory(ctx, noon);
    expect(fs.readFileSync(daily, 'utf8').split('\n').filter((l) => l.startsWith('- ['))).toEqual([
      '- [12:00:00] (claude) noon',
      '- [18:00:00] (claude) evening',
    ]);
    await restoreMemory(ctx, morning);
    expect(fs.readFileSync(daily, 'utf8')).toBe(original);
  });

  it('identical entries are one memory: retiring it removes every copy, restore puts every copy back', async () => {
    const daily = path.join(vault, 'Memory/Daily/2026-10-02.md');
    write(vault, 'Memory/Daily/2026-10-02.md', '---\nkind: note\n---\n# 2026-10-02\n\n- [09:00:00] (claude) Twin statement\n- [09:00:00] (claude) Twin statement');
    await indexVault(db, vault, {});
    const twins = (await buildMemoryMap(ctx)).memories.filter((m) => m.title === 'Twin statement');
    expect(twins).toHaveLength(1);

    await retireMemory(ctx, twins[0].id);
    expect(fs.readFileSync(daily, 'utf8')).not.toContain('Twin statement');
    expect(ftsHits(db, '"Twin statement"')).toBe(0);

    await restoreMemory(ctx, twins[0].id);
    expect((fs.readFileSync(daily, 'utf8').match(/Twin statement/g) ?? []).length).toBe(2);
    expect((await buildMemoryMap(ctx)).memories.filter((m) => m.title === 'Twin statement')).toHaveLength(1);
  });

  it('a multi-line entry is retired whole, continuation included', async () => {
    await appendDailyMemory(vault, '2026-10-01', { text: 'Meeting notes\nThe secret code is ScarletOtter', source: 'claude' });
    await indexVault(db, vault, {});
    expect(ftsHits(db, 'ScarletOtter')).toBe(1);
    const entry = (await buildMemoryMap(ctx)).memories.find((m) => m.title.startsWith('Meeting notes'))!;
    const detail = await readMemory(ctx, entry.id);
    expect(detail.text).toContain('ScarletOtter');
    await retireMemory(ctx, entry.id);
    expect(ftsHits(db, 'ScarletOtter')).toBe(0);
    expect(fs.readFileSync(path.join(vault, 'Memory/Daily/2026-10-01.md'), 'utf8')).not.toContain('ScarletOtter');
    await restoreMemory(ctx, entry.id);
    expect(ftsHits(db, 'ScarletOtter')).toBe(1);
  });

  it('an interrupted note retirement is settled, never left unrestorable', async () => {
    const id = 'note:Projects/Merge rules.md';
    // Crash after the journal record, before the move: the note never left.
    const journal = path.join(vault, '.trash/renor-retired/retired.jsonl');
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.appendFileSync(journal, JSON.stringify({ rid: 'retired:00000000000000aa', id, kind: 'note', path: 'Projects/Merge rules.md', title: 'Merge rules', retiredAt: '2026-10-01T00:00:00.000Z', storedAt: '.trash/renor-retired/files/Projects/Merge rules.md' }) + '\n');
    let map = await buildMemoryMap(ctx);
    expect(map.retired).toEqual([]);
    expect(map.memories.some((m) => m.id === id)).toBe(true);
    // The next retire settles the stale record and then really retires it; restore brings it back.
    await retireMemory(ctx, id);
    map = await buildMemoryMap(ctx);
    expect(map.retired.map((r) => r.memoryId)).toEqual([id]);
    await restoreMemory(ctx, id);
    expect(fs.existsSync(path.join(vault, 'Projects/Merge rules.md'))).toBe(true);
    expect(ftsHits(db, 'Quokkafern')).toBe(1);
  });

  it('a path-qualified wikilink reaches that exact note; an ambiguous bare name links nothing', async () => {
    write(vault, 'Projects/Target.md', '# Target\n\nThe projects target.\n');
    write(vault, 'Elsewhere/Target.md', '# Target\n\nAnother target.\n');
    write(vault, 'Projects/Pointer.md', '# Pointer\n\nSee [[Projects/Target]] and [[Target]].\n');
    await indexVault(db, vault, {});
    const map = await buildMemoryMap(ctx);
    const from = map.links.filter((l) => l.source === 'note:Projects/Pointer.md' && l.kind === 'wikilink').map((l) => l.target);
    expect(from).toEqual(['note:Projects/Target.md']);
  });

  // --- Regression tests for the independent review (Codex, round 2) ---

  it('the map never lists a note reached through a symlink, even one indexed before the swap', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memmap-outside-'));
    fs.writeFileSync(path.join(outside, 'Merge rules.md'), '# Merge rules\n\nOUTSIDE-SECRET\n');
    fs.renameSync(path.join(vault, 'Projects'), path.join(vault, 'Projects-real'));
    fs.symlinkSync(outside, path.join(vault, 'Projects'));
    const map = await buildMemoryMap(ctx);
    expect(JSON.stringify(map)).not.toContain('OUTSIDE-SECRET');
    expect(map.memories.some((m) => m.path.startsWith('Projects/'))).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses to journal or move through a symlinked retired area', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memmap-outside-'));
    fs.symlinkSync(outside, path.join(vault, '.trash'));
    await expect(retireMemory(ctx, 'note:Projects/Merge rules.md')).rejects.toThrow(/not a plain directory|not inside the vault/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(vault, 'Projects/Merge rules.md'))).toBe(true);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('a crash between an entry rewrite and the index update is repaired by the next operation', async () => {
    const target = (await buildMemoryMap(ctx)).memories.find((m) => m.kind === 'entry' && m.source === 'claude')!;
    const daily = path.join(vault, 'Memory/Daily/2026-10-01.md');
    // Simulate: journal written, file rewritten, process died before indexFile.
    const journal = path.join(vault, '.trash/renor-retired/retired.jsonl');
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const line = fs.readFileSync(daily, 'utf8').split('\n').find((l) => l.includes('Prefers short answers'))!;
    fs.appendFileSync(journal, JSON.stringify({ rid: 'retired:00000000000000bb', id: target.id, kind: 'entry', path: 'Memory/Daily/2026-10-01.md', title: 'x', retiredAt: '2026-10-01T00:00:00.000Z', block: line.trim(), copies: 1 }) + '\n');
    fs.writeFileSync(daily, fs.readFileSync(daily, 'utf8').split('\n').filter((l) => l !== line).join('\n'));
    expect(ftsHits(db, '"short answers"')).toBe(1); // stale index: the bug window
    const other = (await buildMemoryMap(ctx)).memories.find((m) => m.title === 'Gateway plan')!;
    await retireMemory(ctx, other.id); // any retire/restore runs reconcile first
    expect(ftsHits(db, '"short answers"')).toBe(0);
  });

  it('a crash after a note left the index but before it moved puts it back in retrieval', async () => {
    const id = 'note:Projects/Merge rules.md';
    const journal = path.join(vault, '.trash/renor-retired/retired.jsonl');
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.appendFileSync(journal, JSON.stringify({ rid: 'retired:00000000000000cc', id, kind: 'note', path: 'Projects/Merge rules.md', title: 'Merge rules', retiredAt: '2026-10-01T00:00:00.000Z', storedAt: '.trash/renor-retired/files/00000000000000cc/Projects/Merge rules.md' }) + '\n');
    db.prepare('DELETE FROM notes WHERE path = ?').run(path.join(vault, 'Projects/Merge rules.md'));
    expect(ftsHits(db, 'Quokkafern')).toBe(0); // dropped from the index, never moved
    await retireMemory(ctx, (await buildMemoryMap(ctx)).memories.find((m) => m.kind === 'entry')!.id);
    expect(ftsHits(db, 'Quokkafern')).toBe(1);
  });

  it('a restore interrupted after the move completes on retry instead of failing', async () => {
    const id = 'note:Projects/Merge rules.md';
    await retireMemory(ctx, id);
    const rid = (await buildMemoryMap(ctx)).retired[0].id;
    // Simulate: the file was moved back, then the process died before indexing and journalling.
    const storedRoot = path.join(vault, '.trash/renor-retired/files', rid.slice('retired:'.length));
    fs.renameSync(path.join(storedRoot, 'Projects/Merge rules.md'), path.join(vault, 'Projects/Merge rules.md'));
    const receipt = await restoreMemory(ctx, rid);
    expect(receipt.action).toBe('restored');
    expect(ftsHits(db, 'Quokkafern')).toBe(1);
    expect((await buildMemoryMap(ctx)).retired).toEqual([]);
  });

  it('retiring two notes that lived at the same path keeps both restorable', async () => {
    const id = 'note:Projects/Merge rules.md';
    await retireMemory(ctx, id);
    write(vault, 'Projects/Merge rules.md', '# Merge rules\n\nSecond version, Wombatlace.\n');
    await indexVault(db, vault, {});
    await retireMemory(ctx, id);
    const retired = (await buildMemoryMap(ctx)).retired;
    expect(retired.map((r) => r.memoryId)).toEqual([id, id]);
    // By memory id it is ambiguous; by retirement id each one restores its own bytes.
    await expect(restoreMemory(ctx, id)).rejects.toThrow(/more than once/);
    // The map lists newest first: restoring the first entry brings back the second version.
    await restoreMemory(ctx, retired[0].id);
    expect(fs.readFileSync(path.join(vault, 'Projects/Merge rules.md'), 'utf8')).toContain('Wombatlace');
    // The older one is still safe in the retired area, and restore will not overwrite the path.
    await expect(restoreMemory(ctx, retired[1].id)).rejects.toThrow(/already exists/);
    expect((await buildMemoryMap(ctx)).retired.map((r) => r.id)).toEqual([retired[1].id]);
  });

  // --- Regression tests for the independent review (Codex, round 3) ---

  it('a torn last journal line never swallows the next retirement', async () => {
    const journal = path.join(vault, '.trash/renor-retired/retired.jsonl');
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, '{"rid":"retired:00000000000000dd","id":"note:X.md","kin');
    await retireMemory(ctx, 'note:Projects/Merge rules.md');
    expect((await buildMemoryMap(ctx)).retired.map((r) => r.memoryId)).toEqual(['note:Projects/Merge rules.md']);
    await restoreMemory(ctx, 'note:Projects/Merge rules.md');
    expect(ftsHits(db, 'Quokkafern')).toBe(1);
  });

  it('an index pass racing a retirement never brings the retired text back', async () => {
    const target = (await buildMemoryMap(ctx)).memories.find((m) => m.kind === 'entry' && m.source === 'claude')!;
    await Promise.all([
      indexVault(db, vault, {}),
      retireMemory(ctx, target.id),
      indexVault(db, vault, {}),
    ]);
    await indexVault(db, vault, {});
    expect(ftsHits(db, '"short answers"')).toBe(0);
  });

  it('a multi-line statement whose next line looks like an entry stays one memory, and reads back exactly', async () => {
    const statement = 'Meeting notes\n- [08:30:00] (alice) Private launch code Lynxquill';
    await appendDailyMemory(vault, '2026-10-01', { text: statement, source: 'claude' });
    await indexVault(db, vault, {});
    const hits = (await buildMemoryMap(ctx)).memories.filter((m) => m.excerpt.includes('Lynxquill') || m.title.startsWith('Meeting notes'));
    expect(hits).toHaveLength(1);
    expect((await readMemory(ctx, hits[0].id)).text).toBe(statement);
    await retireMemory(ctx, hits[0].id);
    expect(ftsHits(db, 'Lynxquill')).toBe(0);
  });

  it('an entry whose first line holds U+2028, U+2029 or a lone CR is still its own memory, and survives retiring its neighbour', async () => {
    // Built, never typed: these are the characters that corrupt source files and editors. `.` does not
    // match them, so such an entry stopped being one and was folded into the entry above it.
    const odd: Array<[string, string]> = [
      ['Quill one', `Quill${String.fromCharCode(0x2028)}one`],
      ['Quill two', `Quill${String.fromCharCode(0x2029)}two`],
      ['Quill three', 'Quill\rthree'],
    ];
    await appendDailyMemory(vault, '2026-10-04', { text: 'Neighbour above', source: 'claude' });
    for (const [, text] of odd) await appendDailyMemory(vault, '2026-10-04', { text, source: 'claude' });
    await appendDailyMemory(vault, '2026-10-04', { text: 'Neighbour below', source: 'claude' });
    await indexVault(db, vault, {});

    const dayEntries = async () => (await buildMemoryMap(ctx)).memories
      .filter((m) => m.kind === 'entry' && m.path === 'Memory/Daily/2026-10-04.md');
    const day = await dayEntries();
    expect(day.map((m) => m.title).sort()).toEqual(['Neighbour above', 'Neighbour below', ...odd.map(([title]) => title)].sort());
    for (const [title, text] of odd) {
      expect((await readMemory(ctx, day.find((m) => m.title === title)!.id)).text).toBe(text);
    }

    // Retiring the neighbour above takes that one entry, not the three after it.
    await retireMemory(ctx, day.find((m) => m.title === 'Neighbour above')!.id);
    const left = await dayEntries();
    expect(left.map((m) => m.title).sort()).toEqual(['Neighbour below', ...odd.map(([title]) => title)].sort());
    for (const [title, text] of odd) {
      expect((await readMemory(ctx, left.find((m) => m.title === title)!.id)).text).toBe(text);
    }

    // Each odd entry also makes the trip through the retirement journal and back, exactly as it was.
    for (const [title, text] of odd) {
      const entry = (await dayEntries()).find((m) => m.title === title)!;
      await retireMemory(ctx, entry.id);
      expect((await dayEntries()).some((m) => m.title === title)).toBe(false);
      await restoreMemory(ctx, entry.id);
      const back = (await dayEntries()).find((m) => m.title === title)!;
      expect((await readMemory(ctx, back.id)).text).toBe(text);
    }
    expect((await dayEntries()).map((m) => m.title).sort()).toEqual(['Neighbour below', ...odd.map(([title]) => title)].sort());
  });

  it('the entry view returns every statement exactly as said, escape or not, and so does a retire and restore', async () => {
    // The writer keeps a later line that starts like an entry behind a backslash; the reader gives the words
    // back. Whatever a statement holds, what comes out is what went in.
    const BS = '\\';
    const cu = (...codes: number[]) => String.fromCharCode(...codes);
    const E = '- [08:30:00] (alice) secret';
    const statements = [
      `ex1 Meeting\n${E}`,
      `ex2 already escaped\n${BS}${E}\n${BS}${BS}${E}`,
      `ex3 indented look-alikes\n  ${E}\n\t${E}`,
      `ex4 crlf\r\n${E}\r\nend`,
      'ex5 trailing carriage return\r',
      `ex6 only a line separator below\n${cu(0x2028)}`,
      `ex7 only a no-break space below\n${cu(0xa0)}`,
      'ex8 trailing spaces   ',
      '\n\nex9 starts with blank lines',
      `ex10 blank line, then\n\n${E}`,
      `ex11 several\n${E}\n${E}\n${BS}${E}`,
      `${E} ex12 the first line itself is shaped like one`,
    ];
    for (const text of statements) await appendDailyMemory(vault, '2026-10-05', { text, source: 'claude' });
    await indexVault(db, vault, {});

    // The map's title: whitespace collapsed, cut at 90 characters with an ellipsis.
    const collapsed = (text: string) => {
      const t = text.replace(/\s+/g, ' ').trim();
      return t.length <= 90 ? t : `${t.slice(0, 89)}\u2026`;
    };
    const dayEntries = async () => (await buildMemoryMap(ctx)).memories
      .filter((m) => m.kind === 'entry' && m.path === 'Memory/Daily/2026-10-05.md');
    const readAll = async () => {
      const day = await dayEntries();
      expect(day).toHaveLength(statements.length); // one entry per save: nothing forged, nothing merged
      for (const text of statements) {
        const entry = day.find((m) => m.title === collapsed(text));
        expect(entry, JSON.stringify(text)).toBeDefined();
        expect(entry!.source, JSON.stringify(text)).toBe('claude');
        expect((await readMemory(ctx, entry!.id)).text, JSON.stringify(text)).toBe(text);
      }
    };
    await readAll();

    for (const text of statements) {
      const entry = (await dayEntries()).find((m) => m.title === collapsed(text))!;
      await retireMemory(ctx, entry.id);
      expect((await dayEntries()).some((m) => m.title === collapsed(text))).toBe(false);
      await restoreMemory(ctx, entry.id);
    }
    await readAll();
  });

  it('a note written before the escape existed reads back exactly as stored, beside an entry that has the escape', async () => {
    const BS = '\\';
    const E = '- [08:30:00] (alice) secret';
    // An older build's day: the user's own backslashes in front of entry-shaped lines, and an indented one.
    // Nothing in it is marked, so nothing in it may be taken for the writer's escape.
    const legacyText = `Legacy slash\n${BS}${E}\n${BS}${BS}${E}\n  ${E}`;
    const secondLegacy = `Second legacy entry\n${BS}${E}`;
    write(vault, 'Memory/Daily/2026-09-20.md',
      `---\nkind: note\nupdated: 2026-09-20\n---\n# 2026-09-20\n\n- [08:00:00] (claude) ${legacyText}\n- [09:00:00] (cursor) ${secondLegacy}\n`);
    // Today's build appends, to the same day, an entry that does need the escape.
    const fresh = `Fresh\n${E}\n${BS}${E}`;
    await appendDailyMemory(vault, '2026-09-20', { text: fresh, source: 'claude' });
    await indexVault(db, vault, {});

    const day = async () => (await buildMemoryMap(ctx)).memories
      .filter((m) => m.kind === 'entry' && m.path === 'Memory/Daily/2026-09-20.md');
    const expected: Array<[string, string, string]> = [
      ['Legacy slash', legacyText, 'claude'],
      ['Second legacy', secondLegacy, 'cursor'],
      ['Fresh', fresh, 'claude'], // the writer's mark is not part of the source name a reader sees
    ];
    const check = async () => {
      const entries = await day();
      expect(entries).toHaveLength(expected.length);
      for (const [prefix, text, source] of expected) {
        const entry = entries.find((m) => m.title.startsWith(prefix))!;
        expect(entry, prefix).toBeDefined();
        expect(entry.source, prefix).toBe(source);
        expect((await readMemory(ctx, entry.id)).text, prefix).toBe(text);
      }
    };
    await check();

    for (const [prefix] of expected) {
      const entry = (await day()).find((m) => m.title.startsWith(prefix))!;
      await retireMemory(ctx, entry.id);
      await restoreMemory(ctx, entry.id);
    }
    await check();
  });
});

describe('RENOR_RECALL_FILE_TREE lever', () => {
  it('groups memories by folder, sorted, and is off unless set', () => {
    expect(memoryPathTree([{ path: 'b/x.md' }, { path: 'a/y.md' }, { path: 'a/z.md' }, { path: 'top.md' }]))
      .toEqual([{ dir: '.', memories: 1 }, { dir: 'a', memories: 2 }, { dir: 'b', memories: 1 }]);
    expect(recallFileTreeOn({})).toBe(false);
    expect(recallFileTreeOn({ RENOR_RECALL_FILE_TREE: '0' })).toBe(false);
    expect(recallFileTreeOn({ RENOR_RECALL_FILE_TREE: '1' })).toBe(true);
  });
});
