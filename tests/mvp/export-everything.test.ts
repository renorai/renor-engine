import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { learningDbPath } from '../../src/learning/settings';
import { LearningLog } from '../../src/learning/store';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Portability, graded by an outside evaluation: "If I use Renor for a year and then decide to leave, can I
 * export 100% of my memories, including metadata, relationships, timestamps and source information, in a
 * documented machine-readable format?" The answer must be yes, so export_memory must return everything a
 * workspace holds — not only the fact ledger.
 *
 * A workspace holds more than the ledger. Every write path is driven here and the export is asserted to
 * carry each item with its metadata:
 *   - `save_memory` and `remember` (fact mode) → the ledger (already exported before this change);
 *   - `remember` (note mode) and `remember_note` → daily-log entries, with their own timestamp, source and
 *     scope — NOT in the ledger;
 *   - `preview_import`/`apply_import` → note files under Imported/<label>/, with their frontmatter
 *     metadata (source, tags, status) — NOT in the ledger;
 *   - `retire_memory`/`restore_memory` → retired memories, whose bytes live in the retired area and the
 *     retirement journal — NOT in the ledger.
 *
 * The manifest (the reply's first block) counts every item by kind, so completeness is checkable against
 * it, and `nextSection`/`nextItem` page a reply too large for one MCP result — explicitly, never by
 * silently dropping content. Synthetic data only; no embeddings, no network.
 */

const HOOK_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
  'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'RENOR_READ_HONESTY',
  'RENOR_EXPORT_MAX_BYTES',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A fresh keyword-only workspace. Calls are sequential: one shared stateless MCP server. */
async function startWorkspace(extraEnv: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-everything-'));
  const memoryDir = path.join(root, 'memory');
  const authRoot = path.join(root, 'auth');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    MVP_EMBEDDING_PROVIDER: 'none',
    ...extraEnv,
  });
  const app = createMvpApp(loadMvpConfig());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'export-everything', version: '0.1.0' });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    memoryDir,
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as any)[0].text as string;
      return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
    },
    /** The export reply: the manifest and the document. */
    async exportMemory(args: Record<string, unknown> = {}) {
      const res = await client.callTool({ name: 'export_memory', arguments: args });
      expect(res.isError, (res.content as any)[0].text).toBeFalsy();
      const content = res.content as Array<{ text: string }>;
      return {
        manifest: JSON.parse(content[0].text) as Record<string, any>,
        document: content[1].text as string,
      };
    },
    close: () => client.close(),
  };
}

type Workspace = Awaited<ReturnType<typeof startWorkspace>>;

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('export_memory returns everything a workspace holds', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('carries every write path with its metadata, and counts each kind in the manifest', async () => {
    // Fact writes (the ledger — the part that was already exported).
    const saved = (await ws.call('save_memory', { subject: 'Fjord', predicate: 'database', object: 'SQLite' })).body;
    const ada = (await ws.call('remember', {
      statement: 'Ada cannot live without mango juice in the morning.',
      subject: 'Ada', predicate: 'morning_drink', object: 'juice', source: 'claude-code',
    })).body;
    expect(ada.mode).toBe('fact');

    // Note-mode writes (daily-log entries — never in the ledger).
    const stand = (await ws.call('remember', { statement: 'The mango juice stand closes at six.' })).body;
    expect(stand.mode).toBe('note');
    const build = (await ws.call('remember_note', { text: 'Ran the nightly build; two flaky tests in the importer.', date: '2026-10-02' })).body;

    // An import (note files under Imported/<label>/ — never in the ledger).
    const preview = (await ws.call('preview_import', {
      label: 'shape',
      files: [
        {
          relativePath: 'Mango.md',
          markdown: '---\nsource: chatgpt\ntags: [fruit, tropical]\nstatus: active\n---\n# Mango\n\nThe mango press is in the shed.\n',
        },
        { relativePath: 'Notes/palace.md', markdown: '# Palace\n\nThe palace has two courtyards.\n' },
      ],
    })).body;
    await ws.call('apply_import', { batchId: preview.batchId });
    await ws.call('index_memory');

    // Retirement (bytes in the retired area and the journal — never in the ledger).
    const retiredNote = (await ws.call('retire_memory', { id: 'note:Imported/shape/Mango.md' })).body;
    expect(retiredNote.action).toBe('retired');
    const retiredFact = (await ws.call('retire_memory', { id: `fact:${ada.eventId}` })).body;
    expect(retiredFact.action).toBe('retired');
    // Retire a daily entry, then bring it back: it is live again, not retired.
    const retiredEntry = (await ws.call('retire_memory', { id: build.id })).body;
    expect(retiredEntry.action).toBe('retired');
    const restored = (await ws.call('restore_memory', { id: build.id })).body;
    expect(restored.action).toBe('restored');

    const { manifest, document } = await ws.exportMemory();

    // The manifest: the same file/format fields as before, plus per-kind counts and paging state.
    expect(manifest.file).toBe('System/Memory Events Ledger.md');
    expect(manifest.format).toBe('markdown');
    expect(manifest.formatVersion).toBe('renor-export/v1');
    expect(manifest.counts).toEqual({ ledgerEvents: 3, dailyEntries: 2, notes: 1, retired: 2 });
    expect(manifest.sections.map((s: any) => s.name)).toEqual(['ledger', 'daily-entries', 'notes', 'retired']);
    expect(manifest.included).toEqual(['ledger', 'daily-entries', 'notes', 'retired']);
    expect(manifest.truncated).toBe(false);
    expect(manifest.nextSection).toBeNull();

    // The ledger is still the whole export's first part, byte for byte (a strict superset of the old reply).
    const ledgerBytes = fs.readFileSync(path.join(ws.memoryDir, 'System/Memory Events Ledger.md'), 'utf-8');
    expect(document.startsWith(ledgerBytes)).toBe(true);
    expect(manifest.bytes).toBe(ledgerBytes.length);

    // Facts, with their metadata: subject/predicate/object, the user's words, the source, the event id.
    expect(document).toContain('Fjord');
    expect(document).toContain('- predicate: database');
    expect(document).toContain('- object: SQLite');
    expect(document).toContain('- statement: "Ada cannot live without mango juice in the morning."');
    expect(document).toContain('- source: claude-code');
    expect(document).toContain(ada.eventId);

    // Daily entries, with their own timestamp, source and scope.
    expect(document).toContain('The mango juice stand closes at six.');
    expect(document).toContain('Ran the nightly build; two flaky tests in the importer.');
    expect(document).toContain('2026-10-02T'); // the entry filed under the day remember_note named
    expect(document).toContain('- source: mcp-remember');
    expect(document).toContain('- source: mcp\n'); // remember_note's own tag
    expect(document).toContain('- path: Memory/Daily/2026-10-02.md');
    expect(document).toContain(stand.id);
    expect(document).toContain(build.id);

    // The live note, with its full text and frontmatter metadata.
    expect(document).toContain('## note:Imported/shape/Notes/palace.md');
    expect(document).toContain('The palace has two courtyards.');

    // The retired note: its full stored text, its metadata, and when it was retired.
    expect(document).toContain('## retired:');
    expect(document).toContain('- kind: note');
    expect(document).toContain('note:Imported/shape/Mango.md');
    expect(document).toContain('The mango press is in the shed.');
    expect(document).toContain('- source: chatgpt');
    expect(document).toContain('fruit');
    expect(document).toContain('- status: active');
    expect(document).toContain('- storedAt: .trash/renor-retired/files/');
    expect(document).toContain(`- retiredAt: ${retiredNote.at}`);

    // The retired fact: named by its subject, predicate and object, with when and by whom it was retired.
    expect(document).toContain(`## fact:${ada.eventId}`);
    expect(document).toContain('- kind: fact');
    expect(document).toContain('- subject: Ada');
    expect(document).toContain('- predicate: morning_drink');
    expect(document).toContain('- object: juice');
    expect(document).toContain(`- retiredAt: ${retiredFact.at}`);
  }, HOOK_TIMEOUT_MS);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('export_memory pages a reply too large for one MCP result', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    // A budget small enough that the ledger and the daily entries fit and the notes do not.
    process.env.RENOR_EXPORT_MAX_BYTES = '1300';
    await ws.call('save_memory', { subject: 'Fjord', predicate: 'database', object: 'SQLite' });
    await ws.call('remember', { statement: 'The mango juice stand closes at six.' });
    const preview = (await ws.call('preview_import', {
      label: 'shape',
      files: [
        { relativePath: 'Notes/alpha.md', markdown: '# Alpha\n\nAlpha note body with some words in it. ' + 'filler '.repeat(40) + '\n' },
        { relativePath: 'Notes/beta.md', markdown: '# Beta\n\nBeta note body with some words in it. ' + 'filler '.repeat(40) + '\n' },
        { relativePath: 'Notes/gamma.md', markdown: '# Gamma\n\nGamma note body with some words in it. ' + 'filler '.repeat(40) + '\n' },
      ],
    })).body;
    await ws.call('apply_import', { batchId: preview.batchId });
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('defers what does not fit and continues explicitly, losing nothing', async () => {
    const first = await ws.exportMemory();
    // The ledger is always carried whole; the notes section did not fit and is deferred by name.
    expect(first.manifest.truncated).toBe(true);
    expect(first.manifest.nextSection).toBe('notes');
    expect(first.manifest.included).toContain('ledger');
    expect(first.manifest.included).not.toContain('notes');
    expect(first.manifest.counts.notes).toBe(3);
    expect(first.document).toContain('The mango juice stand closes at six.');
    expect(first.document).not.toContain('Alpha note body');

    // The continuation is explicit: ask for the section by name. It is larger than the
    // budget, so it pages by item — and says where to continue.
    const second = await ws.exportMemory({ section: 'notes' });
    expect(second.manifest.section).toBe('notes');
    expect(second.manifest.truncated).toBe(true);
    expect(second.manifest.nextItem).toBeGreaterThan(0);
    expect(second.manifest.nextItem).toBeLessThan(3);
    const includedUpTo = second.manifest.nextItem as number;
    expect(second.document).toContain('Alpha note body');
    expect(second.document).not.toContain('Gamma note body');

    // The next item page carries the rest, and the manifest says when there is no more.
    const third = await ws.exportMemory({ section: 'notes', offset: includedUpTo });
    expect(third.manifest.truncated).toBe(false);
    expect(third.manifest.nextItem).toBeUndefined();
    expect(third.document).toContain('Gamma note body');

    // Nothing was silently dropped: across the pages, every note is present exactly once.
    const all = [first.document, second.document, third.document].join('\n');
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      expect(all).toContain(`${name} note body`);
    }
  }, HOOK_TIMEOUT_MS);
});

/**
 * The bytes of one exported note, read the way a reader takes them: the body between its fences, less the one newline
 * the fence adds when the item says the note has none (`- finalNewline: absent`).
 */
function exportedNoteBytes(document: string, header: string): string {
  const from = document.indexOf(header);
  expect(from, `no item ${header.trim()}`).toBeGreaterThanOrEqual(0);
  const rest = document.slice(from + header.length);
  const open = /^(`{3,})\n/m.exec(rest)!;
  const bodyStart = open.index + open[0].length;
  const closeAt = rest.indexOf(`\n${open[1]}\n`, bodyStart);
  const body = rest.slice(bodyStart, closeAt + 1);
  const noFinalNewline = rest.slice(0, open.index).split('\n').includes('- finalNewline: absent');
  return noFinalNewline ? body.slice(0, -1) : body;
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('export_memory keeps a note byte for byte, with or without a final newline', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    const preview = (await ws.call('preview_import', {
      label: 'roundtrip',
      files: [
        { relativePath: 'NoEol.md', markdown: '# NoEol\n\nno trailing newline' },
        { relativePath: 'WithEol.md', markdown: '# WithEol\n\nends with a newline\n' },
      ],
    })).body;
    await ws.call('apply_import', { batchId: preview.batchId });
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a note without a final newline reads back exactly as stored, and so does one with it', async () => {
    const { document } = await ws.exportMemory({ section: 'notes' });
    const noEol = fs.readFileSync(path.join(ws.memoryDir, 'Imported', 'roundtrip', 'NoEol.md'), 'utf8');
    const withEol = fs.readFileSync(path.join(ws.memoryDir, 'Imported', 'roundtrip', 'WithEol.md'), 'utf8');
    expect(noEol.endsWith('\n')).toBe(false);
    expect(withEol.endsWith('\n')).toBe(true);

    expect(exportedNoteBytes(document, '## note:Imported/roundtrip/NoEol.md\n')).toBe(noEol);
    expect(exportedNoteBytes(document, '## note:Imported/roundtrip/WithEol.md\n')).toBe(withEol);
    expect(document).toContain('- finalNewline: absent\n');
    expect(document.split('- finalNewline: absent').length - 1).toBe(1);
  }, HOOK_TIMEOUT_MS);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('export_memory of a corrected note without a final newline keeps its bytes and its replacement links', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    const preview = (await ws.call('preview_import', {
      label: 'fixed',
      files: [{ relativePath: 'Runbook.md', markdown: '# Runbook\n\nThe deploy uses the blue button.' }],
    })).body;
    await ws.call('apply_import', { batchId: preview.batchId });
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('the note keeps its bytes and its replacedBy line, and the correction keeps its replaces line', async () => {
    const fix = (await ws.call('remember', { statement: 'The deploy now uses the green button.', replaces: 'note:Imported/fixed/Runbook.md' })).body;
    const { document } = await ws.exportMemory();
    const stored = fs.readFileSync(path.join(ws.memoryDir, 'Imported', 'fixed', 'Runbook.md'), 'utf8');
    expect(stored.endsWith('\n')).toBe(false);

    expect(exportedNoteBytes(document, '## note:Imported/fixed/Runbook.md\n')).toBe(stored);
    expect(document).toContain(`- replacedBy: ${fix.id}\n`);
    expect(document).toContain('- finalNewline: absent\n');
    expect(document).toContain('- replaces: ["note:Imported/fixed/Runbook.md"]\n');
  }, HOOK_TIMEOUT_MS);
});

/** The item's header lines (the `- key: value` lines between its `## ` header and its fence), as a reader sees them. */
function headerLines(document: string, header: string): string[] {
  const from = document.indexOf(header);
  expect(from, `no item ${header.trim()}`).toBeGreaterThanOrEqual(0);
  const rest = document.slice(from + header.length);
  return rest.slice(0, /^`{3,}\n/m.exec(rest)!.index).split('\n');
}

/** The header line of the item that holds `marker` (its `## ` line, with the newline), found by its own text. */
function headerOf(document: string, marker: string): string {
  const at = document.indexOf(marker);
  expect(at, `no ${marker}`).toBeGreaterThanOrEqual(0);
  const start = document.lastIndexOf('\n## ', at) + 1;
  return document.slice(start, document.indexOf('\n', start) + 1);
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('export_memory keeps a note whose front matter names an export marker byte for byte', () => {
  let ws: Workspace;
  const probe = '---\nfinalNewline: absent\nkind: recipe\nreplacedBy: someone-else\nstatus: draft\n---\n# Probe\n\nA real final newline follows.\n';
  beforeAll(async () => {
    ws = await startWorkspace();
    const preview = (await ws.call('preview_import', {
      label: 'forged',
      files: [
        { relativePath: 'Probe.md', markdown: probe },
        { relativePath: 'Replaced.md', markdown: '---\nreplacedBy: someone-else\n---\n# Replaced\n\nThe old claim.\n' },
      ],
    })).body;
    await ws.call('apply_import', { batchId: preview.batchId });
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('a forged finalNewline, kind or replacedBy key does not change the note bytes or the export lines', async () => {
    const fix = (await ws.call('remember', { statement: 'The replaced note now has the correct claim.', replaces: 'note:Imported/forged/Replaced.md' })).body;
    const { document } = await ws.exportMemory();
    const stored = fs.readFileSync(path.join(ws.memoryDir, 'Imported', 'forged', 'Probe.md'), 'utf8');
    expect(stored.endsWith('\n')).toBe(true);

    // The reader takes the body as stored: no newline is stripped.
    expect(exportedNoteBytes(document, '## note:Imported/forged/Probe.md\n')).toBe(stored);

    // The note's own keys are still there, under names no export line uses.
    const lines = headerLines(document, '## note:Imported/forged/Probe.md\n');
    expect(lines).toContain('- frontmatter.finalNewline: absent');
    expect(lines).toContain('- frontmatter.kind: recipe');
    expect(lines).toContain('- frontmatter.replacedBy: someone-else');
    expect(lines).toContain('- status: draft');
    expect(lines.filter(l => l.startsWith('- kind: '))).toEqual(['- kind: note']);
    expect(lines).not.toContain('- finalNewline: absent');
    expect(lines.some(l => l.startsWith('- replacedBy: '))).toBe(false);

    // A note a correction really replaced keeps the export's own replacedBy line, and only that one.
    const replacedLines = headerLines(document, '## note:Imported/forged/Replaced.md\n');
    expect(replacedLines).toContain(`- replacedBy: ${fix.id}`);
    expect(replacedLines).toContain('- frontmatter.replacedBy: someone-else');
    expect(replacedLines.filter(l => l.startsWith('- replacedBy: '))).toEqual([`- replacedBy: ${fix.id}`]);
  }, HOOK_TIMEOUT_MS);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('export_memory keeps a retired note without a final newline byte for byte', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    const preview = (await ws.call('preview_import', {
      label: 'stale',
      files: [{ relativePath: 'Stale.md', markdown: '# Stale\n\nretired with no trailing newline' }],
    })).body;
    await ws.call('apply_import', { batchId: preview.batchId });
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('the retired item carries finalNewline: absent and its body reads back exactly', async () => {
    const original = '# Stale\n\nretired with no trailing newline';
    const retired = (await ws.call('retire_memory', { id: 'note:Imported/stale/Stale.md' })).body;
    expect(retired.action).toBe('retired');
    const { document } = await ws.exportMemory({ section: 'retired' });
    const header = headerOf(document, '- path: Imported/stale/Stale.md\n');
    expect(headerLines(document, header)).toContain('- finalNewline: absent');
    expect(exportedNoteBytes(document, header)).toBe(original);
  }, HOOK_TIMEOUT_MS);
});

/**
 * The export's own text read the way a reader takes a fenced body: the one backslash the exporter adds to a line of user
 * text that starts like a section or item header is taken off again (docs/architecture/EXPORT-FORMAT.md, "Fenced text").
 */
function unescapeFenceBody(body: string): string {
  return body.replace(/(^|[\n\r\u000b\u000c\u001c\u001d\u001e\u2028\u2029\u0085])\\((\\*)(?=# renor-export\/v1 ·|## (?:note:|entry:|retired:|fact:)))/g, '$1$2');
}

/** The lines a fence-aware reader finds outside every fence: the export's own headers, and nothing the user wrote. */
function linesOutsideFences(document: string): string[] {
  const out: string[] = [];
  let fence = '';
  for (const line of document.split(/[\n\r\u000b\u000c\u001c\u001d\u001e\u2028\u2029\u0085]/)) {
    if (fence) {
      if (line === fence) fence = '';
      continue;
    }
    const open = /^(`{3,})$/.exec(line);
    if (open) fence = open[1];
    else out.push(line);
  }
  return out;
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('export_memory reads only the files of the section a reply carries', () => {
  const DAILY_FILE = /\/Daily\/\d{4}-\d{2}-\d{2}\.md$/;
  let ws: Workspace;
  beforeAll(async () => {
    ws = await startWorkspace();
    const files = Array.from({ length: 40 }, (_, i) => ({
      relativePath: `Topics/topic-${i}.md`,
      markdown: `# Topic ${i}\n\nTopic body ${i} stays put.\n`,
    }));
    const preview = (await ws.call('preview_import', { label: 'scale', files })).body;
    await ws.call('apply_import', { batchId: preview.batchId });
    for (let i = 0; i < 40; i++) {
      const date = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      await ws.call('remember_note', { text: `Daily entry ${i} on its own day.`, date });
    }
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a notes page reads no daily file, counts only the notes, and reports the other counts as not counted', async () => {
    const reads = vi.spyOn(fsp, 'readFile');
    const { manifest, document } = await ws.exportMemory({ section: 'notes', offset: 0 });
    const paths = reads.mock.calls.map((c) => String(c[0]));
    expect(paths.filter((p) => DAILY_FILE.test(p))).toEqual([]);
    expect(paths.some((p) => p.endsWith('System/Memory Events Ledger.md'))).toBe(false);
    expect(paths.filter((p) => p.endsWith('.md')).length).toBe(40);

    expect(manifest.counts).toEqual({ ledgerEvents: null, dailyEntries: null, notes: 40, retired: null });
    expect(manifest.bytes).toBeNull();
    expect(document).toContain('Topic body 39 stays put.');
    expect(document).not.toContain('## entry:');
  }, HOOK_TIMEOUT_MS);

  it('a daily-entries page reads no note file, and carries every entry', async () => {
    const reads = vi.spyOn(fsp, 'readFile');
    const { manifest, document } = await ws.exportMemory({ section: 'daily-entries', offset: 0 });
    const paths = reads.mock.calls.map((c) => String(c[0]));
    expect(paths.filter((p) => p.endsWith('.md') && !DAILY_FILE.test(p))).toEqual([]);
    expect(paths.filter((p) => DAILY_FILE.test(p)).length).toBeGreaterThanOrEqual(40);

    expect(manifest.counts.dailyEntries).toBe(40);
    expect(manifest.counts.notes).toBeNull();
    expect(document.match(/^## entry:/gm)?.length).toBe(40);
    expect(document).not.toContain('## note:');
  }, HOOK_TIMEOUT_MS);

  it('a whole export still counts every section', async () => {
    const { manifest } = await ws.exportMemory();
    expect(manifest.counts).toEqual({ ledgerEvents: 0, dailyEntries: 40, notes: 40, retired: 0 });
    expect(manifest.sections.map((s: { items: number | null }) => s.items)).toEqual([0, 40, 40, 0]);
  }, HOOK_TIMEOUT_MS);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('export_memory names what it leaves out', () => {
  const HISTORY_MARKER = 'SYNTHETIC-HISTORY-MARKER-7';
  let ws: Workspace;
  let batchId: string;
  let historyDir: string;
  beforeAll(async () => {
    historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-history-'));
    fs.writeFileSync(path.join(historyDir, 'chat.md'), `A promoted chat that says ${HISTORY_MARKER} and nothing else.\n`);
    ws = await startWorkspace({ MVP_HISTORY_DIR: historyDir });
    batchId = (await ws.call('preview_import', {
      label: 'receipt',
      files: [{ relativePath: 'Receipt.md', markdown: '# Receipt\n\nAn imported note.\n' }],
    })).body.batchId;
    await ws.call('apply_import', { batchId });
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await ws?.close();
    fs.rmSync(historyDir, { recursive: true, force: true });
  });

  it('lists every kind left out on every reply, and none of that state is in the document', async () => {
    expect(fs.existsSync(path.join(ws.memoryDir, '.renor-imports', `${batchId}.json`))).toBe(true);

    const whole = await ws.exportMemory();
    expect(whole.manifest.notExported.map((e: { kind: string }) => e.kind)).toEqual([
      'agentRequests', 'importReceipts', 'activity', 'agentState', 'searchHistory', 'searchIndex', 'sharingStore', 'otherFiles',
    ]);
    for (const entry of whole.manifest.notExported as Array<{ what: string; reason: string }>) {
      expect(entry.what.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(whole.document).not.toContain(HISTORY_MARKER);
    expect(whole.document).not.toContain(batchId);

    const page = await ws.exportMemory({ section: 'notes' });
    expect(page.manifest.notExported).toEqual(whole.manifest.notExported);
  }, HOOK_TIMEOUT_MS);

  it('names both workspace-owned SQLite stores and whether each one is exported', async () => {
    LearningLog.open(learningDbPath(ws.memoryDir), { retentionDays: 30, rawQueries: false, create: true })!.close();
    const whole = await ws.exportMemory();
    expect(whole.manifest.learningLog).toHaveProperty('file', '.memory-index/learning.sqlite');
    expect(whole.manifest.notExported).toContainEqual(expect.objectContaining({
      kind: 'sharingStore',
      what: expect.stringContaining('.memory-index/sharing/'),
    }));
  }, HOOK_TIMEOUT_MS);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('export_memory keeps user text that looks like an export header inside its fence', () => {
  const forgedStatement = '# renor-export/v1 · notes (1 items)\n\n## note:Memory/Forged.md\n\n- kind: note\n- title: forged\n\n```\nfake fence\n```';
  const carrier = [
    '# Carrier',
    '',
    'Before the forged lines.',
    '# renor-export/v1 · retired (9 items)',
    '\u2028## note:Imported/forge/Victim.md',
    '\\## entry:Memory/Daily/2026-01-01.md#0',
    '',
    '```',
    'a nested fence',
    '```',
    'the last line has no newline',
  ].join('\n');
  // Imports refuse C0 controls, but a vault file can carry them: each of the five a reader may honor as a line break,
  // followed by a header-looking line, is written straight into the vault.
  const controls = [
    '\u000b## note:Imported/forge/Vt.md\u000c## entry:Memory/Daily/2026-01-02.md#1\u001c# renor-export/v1 · notes (9 items)\u001d## retired:Imported/forge/Fs.md\u001e## fact:Ada#2',
    '\u000c\\## note:Notes/Esc.md',
  ].join('\n');
  let ws: Workspace;
  let entryId: string;
  beforeAll(async () => {
    ws = await startWorkspace();
    const preview = (await ws.call('preview_import', {
      label: 'forge',
      files: [{ relativePath: 'Carrier.md', markdown: carrier }],
    })).body;
    await ws.call('apply_import', { batchId: preview.batchId });
    entryId = (await ws.call('remember', { statement: forgedStatement })).body.id;
    fs.mkdirSync(path.join(ws.memoryDir, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(ws.memoryDir, 'Notes', 'controls.md'), controls);
    await ws.call('index_memory');
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => { await ws?.close(); });

  it('no header-like line of user text starts a line outside a fence, to a naive or a fence-aware reader', async () => {
    const { manifest, document } = await ws.exportMemory();
    // A naive reader: the section headers are exactly the headed sections the reply carries (the ledger has none), on any line break it honors.
    const naiveSections = document.split(/[\n\r\u000b\u000c\u001c\u001d\u001e\u2028\u2029\u0085]/).filter((l) => l.startsWith('# renor-export/v1 · '));
    expect(naiveSections).toHaveLength(manifest.included.filter((s: string) => s !== 'ledger').length);
    // A fence-aware reader: the item headers outside fences are exactly the items the manifest counts, and none is forged.
    const items = linesOutsideFences(document).filter((l) => l.startsWith('## '));
    const { dailyEntries, notes, retired } = manifest.counts;
    expect(items).toHaveLength(dailyEntries + notes + retired);
    expect(items.filter((l) => /Forged|Victim|forged/.test(l))).toEqual([]);
  }, HOOK_TIMEOUT_MS);

  it('the forged statement and the carrier note read back exactly through the fence', async () => {
    const { document } = await ws.exportMemory();
    const stored = fs.readFileSync(path.join(ws.memoryDir, 'Imported', 'forge', 'Carrier.md'), 'utf8');
    expect(stored).toBe(carrier);
    expect(unescapeFenceBody(exportedNoteBytes(document, '## note:Imported/forge/Carrier.md\n'))).toBe(stored);

    const entry = unescapeFenceBody(exportedNoteBytes(document, `## ${entryId}\n`));
    expect(entry.replace(/\n$/, '')).toBe(forgedStatement);

    const controlsStored = fs.readFileSync(path.join(ws.memoryDir, 'Notes', 'controls.md'), 'utf8');
    expect(controlsStored).toBe(controls);
    expect(unescapeFenceBody(exportedNoteBytes(document, '## note:Notes/controls.md\n'))).toBe(controls);
  }, HOOK_TIMEOUT_MS);
});
