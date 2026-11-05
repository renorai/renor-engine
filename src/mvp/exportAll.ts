import fs from 'fs/promises';
import path from 'path';
import type Database from '../db/sqlite';
import { listRetiredFacts, parseLedgerEvents, resolveLedgerPath } from '../memory/lifecycle';
import { DAILY_FILE_RE } from '../memory/dailyNote';
import { dailyEntriesForExport, retiredForExport, type MemoryMapContext } from '../memorymap/memoryMap';
import { parseNote } from '../indexer/parser';
import { handoffNoteEnabled } from '../memory/handoff';
import { allReplacementRecords, replacementIndex, type ReplacementIndex, type ReplacementRecord } from '../memorymap/replacements';
import { learningDbPath, learningRetentionDays } from '../learning/settings';
import { LearningLog, type LearningExport } from '../learning/store';
import { observeEnabled, observationsForExport } from './observations';

// ---------------------------------------------------------------------------
// export_memory: everything one workspace holds, in one documented Markdown format ("renor-export/v1").
//
// The reply is two text blocks: a JSON manifest, then the Markdown document. The document is made of sections in
// a fixed order:
//   ledger         the fact ledger, byte for byte (what export_memory returned before this format)
//   daily-entries  every entry of every daily log (remember, remember_note), one item each
//   notes          every other live Markdown note (imports, hand-written notes), one item each, full text
//   retired        everything retired and not restored: notes, entries, facts, with when it was retired
// Nothing is summarised: an item carries the stored text and every piece of metadata the engine keeps for it.
// A reply is bounded (RENOR_EXPORT_MAX_BYTES); what does not fit is deferred and named in the manifest
// (`nextSection`, `nextItem`), never dropped. A reply for one section reads only the files that section needs.
// What the export leaves out is named in the manifest too (`notExported`).
// ---------------------------------------------------------------------------

export const EXPORT_FORMAT_VERSION = 'renor-export/v1';
export const EXPORT_SECTIONS = ['ledger', 'daily-entries', 'notes', 'retired'] as const;
export type ExportSection = typeof EXPORT_SECTIONS[number] | 'observations';

/**
 * What the export leaves out, named in every manifest (`notExported`) so a reader can see the gap instead of trusting
 * "everything". Keep this in step with the sections above and with docs/architecture/EXPORT-FORMAT.md.
 */
export const NOT_EXPORTED: ReadonlyArray<{ kind: string; what: string; reason: string }> = [
  { kind: 'agentRequests', what: 'ask_agent questions and answers (the agent_requests table)', reason: 'no section for them yet' },
  { kind: 'importReceipts', what: 'the receipt of each applied import (.renor-imports/<batchId>.json)', reason: 'undo_import reads them; no section for them yet' },
  { kind: 'activity', what: 'the write activity behind memory_map events and whats_new (the write_events table)', reason: 'no section for it yet' },
  { kind: 'agentState', what: 'connected agent names, read cursors and live leases (known_agents, agent_cursors, agent_leases)', reason: 'connection state, not memory' },
  { kind: 'searchHistory', what: 'the promoted history directory that search_history reads (MVP_HISTORY_DIR)', reason: 'configured outside the memory folder' },
  { kind: 'searchIndex', what: 'the search index and embeddings', reason: 'derived: index_memory rebuilds them from the exported files' },
  { kind: 'sharingStore', what: 'the sharing choice, sender state and optional text examples in .memory-index/sharing/', reason: 'consent state and sender credentials are local controls, not portable memory; the learningLog manifest field separately exports learning.sqlite' },
  { kind: 'otherFiles', what: 'files in the memory folder that are not Markdown (.md), dot-folders other than the retired area, and symbolic links', reason: 'the export carries Markdown notes only' },
];

/**
 * Named in notExported only where RENOR_HANDOFF_NOTE is on: with it off there is no handoff note and no table, and the
 * manifest is the one it was without it.
 */
export const HANDOFF_NOT_EXPORTED = {
  kind: 'handoffNotes',
  what: 'the handoff note of each repository and branch (the handoff_notes table)',
  reason: 'session status, not memory: it expires after 7 days and stays out of every read',
} as const;

/** NOT_EXPORTED, and the handoff notes where RENOR_HANDOFF_NOTE is on. */
export function notExported(env: NodeJS.ProcessEnv = process.env): ReadonlyArray<{ kind: string; what: string; reason: string }> {
  return handoffNoteEnabled(env) ? [...NOT_EXPORTED, HANDOFF_NOT_EXPORTED] : NOT_EXPORTED;
}

/** Characters per reply: well under the MCP result limits this codebase works to. */
const DEFAULT_MAX_CHARS = 600_000;

function maxChars(): number {
  const raw = Number(process.env.RENOR_EXPORT_MAX_BYTES);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_CHARS;
}

/**
 * A line separator a reader may honor as a line break: \n, \r, U+2028, U+2029 and U+0085 (NEXT LINE), and the C0 controls
 * that Python's str.splitlines() also breaks on: VT, FF, FS, GS and RS (U+000B, U+000C, U+001C to U+001E).
 */
const LINE_SEPARATOR = /[\n\r\u000b\u000c\u001c\u001d\u001e\u2028\u2029\u0085]/;

/**
 * The start of a line the exporter writes as a section or item header (`# renor-export/v1 ·`, `## note:`, `## entry:`,
 * `## retired:`, `## fact:`). A line of user text inside a fence that starts this way is escaped with one more backslash
 * (`\## note:`), so no line of the document that a naive reader takes as a header is in fact the user's text. The escape is
 * one-to-one: the writer adds a backslash to every line that matches, backslashes included, so a reader removes exactly one
 * from each line matching the same pattern with a backslash in front (see docs/architecture/EXPORT-FORMAT.md).
 */
const HEADER_START = '(?=# renor-export\\/v1 \u00b7|## (?:note:|entry:|retired:|fact:))';
const HEADER_LIKE = new RegExp(`(^|[\\n\\r\\u000b\\u000c\\u001c\\u001d\\u001e\\u2028\\u2029\\u0085])(\\\\*)${HEADER_START}`, 'g');

/** The text inside a fence as the export writes it: header-like lines escaped; nothing else changes. */
function escapeFenceText(text: string): string {
  return text.replace(HEADER_LIKE, (_match, sep: string, slashes: string) => `${sep}\\${slashes}`);
}

/** A body in a fence one backtick longer than any run in it, so no line of the body closes the fence. */
function fenced(text: string): string {
  const body = escapeFenceText(text);
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}${body.endsWith('\n') ? '' : '\n'}${fence}\n`;
}

const escapedSeparator = (ch: string): string => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;

/**
 * A string that must stay on one line of the export document: JSON-quoted, with every line separator
 * escaped to \uXXXX. JSON.stringify already escapes \n and \r but leaves U+2028, U+2029 and U+0085 raw,
 * and a raw separator in a key or value starts a line the exporter never wrote (a forged `## note:`
 * header, a new field). A JSON reader decodes the escape back to the stored character.
 */
function oneLine(s: unknown): string {
  return JSON.stringify(s).replace(/[\u2028\u2029\u0085]/g, escapedSeparator);
}

/**
 * A token interpolated into a document line — an item header id or a note path (`## note:${rel}`) — held
 * to one line: every line separator becomes \uXXXX in place, so no stored path can start a line the
 * exporter never wrote (a forged `## note:` header or section title). A normal path is unchanged.
 */
function oneLineToken(s: string): string {
  return s.replace(/[\n\r\u000b\u000c\u001c\u001d\u001e\u2028\u2029\u0085]/g, escapedSeparator);
}

/**
 * One metadata line: a single-line string as written, anything else as JSON, so no value changes the
 * layout. The KEY is held to the same rule: a YAML double-quoted frontmatter key may carry an escaped
 * newline (gray-matter decodes it to a real one), and an unchecked key would forge a line of the document.
 */
function field(key: string, value: unknown): string {
  const safeKey = LINE_SEPARATOR.test(key) ? oneLine(key) : key;
  const plain = typeof value === 'string' && !LINE_SEPARATOR.test(value);
  return `- ${safeKey}: ${plain ? value : oneLine(value)}\n`;
}

/**
 * `- finalNewline: absent` for a note whose bytes do not end in a newline. fenced() closes the body on a line of its own,
 * so a reader who takes the body between the fences gets one newline more than the note holds; this line says the last
 * one is not part of it. A daily entry or a retired entry is a statement, not file bytes, so it never carries one.
 */
function fileEnding(text: string): string {
  return text.endsWith('\n') ? '' : field('finalNewline', 'absent');
}

function scopeOf(rel: string): string {
  return /^Memory\/Scopes\/([^/]+)\//.exec(rel)?.[1] ?? 'global';
}

/**
 * Every key the exporter writes on a note or a retired note, before or after its front matter: its header, its
 * replacement lines and its finalNewline marker. A front-matter key with one of these names would print a second line of
 * that name, and a reader would take the forged one for the export's (`- finalNewline: absent` strips a real final
 * newline). Keys only a daily entry or a fact carries (`source`, `at`, `subject`, ...) are not here: no front matter reaches
 * those items, so an ordinary `source:` key stays as it is. Add a key here when a note item gets a new line.
 */
const EXPORTER_KEYS = new Set([
  'kind', 'id', 'path', 'scope', 'title', 'modifiedAt', 'storedAt', 'savedAt', 'retiredAt',
  'replacedBy', 'replacedAt', 'replaces', 'finalNewline',
]);
/** The name a colliding front-matter key is written under; a key that already starts with it is escaped too, so the map stays one-to-one. */
const FRONTMATTER_PREFIX = 'frontmatter.';

/** A front-matter key as the export writes it: unchanged, unless it would collide with an exporter key or the prefix. */
function frontmatterKey(key: string): string {
  return EXPORTER_KEYS.has(key) || key.startsWith(FRONTMATTER_PREFIX) ? `${FRONTMATTER_PREFIX}${key}` : key;
}

function frontmatterFields(rel: string, text: string): { title: string; lines: string } {
  const note = parseNote(rel, text);
  const lines = Object.entries(note.frontmatter).map(([k, v]) => field(frontmatterKey(k), v)).join('');
  return { title: note.title, lines };
}

async function liveFiles(root: string, ledgerAbs: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dirAbs: string, relDir: string): Promise<void> {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dirAbs, e.name), rel);
      else if (e.isFile() && e.name.endsWith('.md') && path.resolve(root, rel) !== ledgerAbs) out.push(rel);
    }
  }
  await walk(root, '');
  return out.sort();
}

/** The sections a reply builds. A section a reply does not carry is not read at all, and its count is null in the manifest. */
interface Built {
  items: Partial<Record<ExportSection, string[]>>;
  /** The ledger file's text, when the ledger section is built. */
  ledger?: string;
  ledgerEvents?: number;
}

interface Replacements { index: ReplacementIndex; records: ReplacementRecord[] }

/**
 * The lines an item carries for a replacement (memorymap/replacements.ts): `replacedBy`, `replacedAt` and, when recorded,
 * `replacedSource` (and `replacedNote` when it differs) on a memory a live correction replaced, `replaces` on a correction, as
 * the ids of the memories it replaces. Nothing for a memory no replacement touches, so a workspace without one exports exactly
 * what it did. Empty when no replacement state was loaded, which happens only when no section that carries these lines is built.
 */
function replacementFields(rep: Replacements | undefined, id: string): string {
  if (!rep) return '';
  const replaced = rep.index.replacedBy(id);
  // Every link a live correction made, also one a newer correction took over: the journal keeps it, so the export does.
  const replaces = [...new Set(rep.records.filter(r => r.by === id).map(r => r.old))];
  const by = replaced
    ? field('replacedBy', replaced.by) + field('replacedAt', replaced.at)
      + (replaced.source ? field('replacedSource', replaced.source) : '')
      + (replaced.note ? field('replacedNote', replaced.note) : '')
    : '';
  return `${by}${replaces.length > 0 ? field('replaces', replaces) : ''}`;
}

/**
 * Builds the sections named in `wanted` and no others: a notes page reads note files, a daily-entries page reads daily
 * files, and only the ledger section reads the ledger. The replacement state is loaded only when an item needs its lines.
 */
async function buildSections(ctx: MemoryMapContext & { db: Database.Database }, wanted: readonly ExportSection[]): Promise<Built> {
  const built: Built = { items: {} };
  const root = path.resolve(ctx.memoryDir);
  const ledgerAbs = resolveLedgerPath(ctx.memoryDir, ctx.ledgerRelPath);

  if (wanted.includes('ledger')) {
    let ledger: string;
    try {
      ledger = await fs.readFile(ledgerAbs, 'utf-8');
    } catch (err) {
      // Only a genuinely absent ledger (pristine store) is an honest empty export; any other failure is an error.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      ledger = '';
    }
    let ledgerEvents: number;
    try { ledgerEvents = parseLedgerEvents(ledger).length; } catch { ledgerEvents = ledger.split('\n').filter((l) => l.startsWith('## ')).length; }
    built.ledger = ledger;
    built.ledgerEvents = ledgerEvents;
    // The ledger is split by line so it pages like the rest; joined, it is the file exactly.
    built.items.ledger = ledger === '' ? [] : ledger.split(/(?<=\n)/);
  }

  const needsReplacements = wanted.some((s) => s === 'daily-entries' || s === 'notes' || s === 'retired');
  const rep: Replacements | undefined = needsReplacements
    ? { index: await replacementIndex(ctx), records: await allReplacementRecords(ctx) }
    : undefined;

  if (wanted.includes('daily-entries') || wanted.includes('notes')) {
    const daily: string[] = [];
    const notes: string[] = [];
    for (const rel of await liveFiles(root, ledgerAbs)) {
      const isDaily = DAILY_FILE_RE.test(rel);
      if (!wanted.includes(isDaily ? 'daily-entries' : 'notes')) continue;
      const abs = path.join(root, ...rel.split('/'));
      const text = await fs.readFile(abs, 'utf-8');
      if (isDaily) {
        for (const e of dailyEntriesForExport(rel, text)) {
          daily.push(`## ${oneLineToken(e.id)}\n\n${field('kind', 'entry')}${field('path', rel)}${field('scope', scopeOf(rel))}${field('at', e.at)}${field('source', e.source)}${replacementFields(rep, e.id)}\n${fenced(e.text)}`);
        }
        continue;
      }
      const meta = frontmatterFields(rel, text);
      const modifiedAt = (await fs.stat(abs)).mtime.toISOString();
      notes.push(`## note:${oneLineToken(rel)}\n\n${field('kind', 'note')}${field('path', rel)}${field('scope', scopeOf(rel))}${field('title', meta.title)}${field('modifiedAt', modifiedAt)}${meta.lines}${replacementFields(rep, `note:${rel}`)}${fileEnding(text)}\n${fenced(text)}`);
    }
    if (wanted.includes('daily-entries')) built.items['daily-entries'] = daily;
    if (wanted.includes('notes')) built.items.notes = notes;
  }

  if (wanted.includes('retired')) {
    const retired: Array<{ at: string; text: string }> = [];
    for (const r of await retiredForExport(ctx)) {
      // A retired correction keeps the link it made, so a restore from this document knows what it replaces.
      const made = (rep?.records ?? []).filter(rec => rec.by === r.memoryId).map(rec => rec.old);
      const meta = r.kind === 'note' ? frontmatterFields(r.path, r.content) : { title: r.title, lines: '' };
      retired.push({
        at: r.retiredAt,
        text: `## ${oneLineToken(r.rid)}\n\n${field('kind', r.kind)}${field('id', r.memoryId)}${field('path', r.path)}${field('scope', scopeOf(r.path))}${field('title', r.title)}${field('retiredAt', r.retiredAt)}`
          + `${r.storedAt ? field('storedAt', r.storedAt) : ''}${r.savedAt ? field('savedAt', r.savedAt) : ''}${made.length > 0 ? field('replaces', made) : ''}${meta.lines}${r.kind === 'note' ? fileEnding(r.content) : ''}\n${fenced(r.content)}`,
      });
    }
    for (const f of listRetiredFacts(ctx.db)) {
      retired.push({
        at: f.retiredAt,
        text: `## ${oneLineToken(f.id)}\n\n${field('kind', 'fact')}${field('subject', f.subject)}${field('predicate', f.predicate)}${field('object', f.object)}${field('scope', f.scope)}`
          + `${field('validFrom', f.validFrom)}${field('retiredAt', f.retiredAt)}${field('retiredBy', f.retiredBy)}\n`,
      });
    }
    retired.sort((a, b) => b.at.localeCompare(a.at));
    built.items.retired = retired.map((r) => r.text);
  }
  return built;
}

export interface ExportReply { manifest: Record<string, unknown>; document: string }

/** The portable contents of learning.sqlite, when that optional log exists. */
function exportLearningLog(memoryDir: string): { file: string; data: LearningExport } | null {
  const file = learningDbPath(memoryDir);
  const log = LearningLog.open(file, { retentionDays: learningRetentionDays(), rawQueries: false, create: false });
  if (log === null) return null;
  try {
    return { file: '.memory-index/learning.sqlite', data: log.exportLog() };
  } finally {
    log.close();
  }
}

function sectionHeader(name: ExportSection, count: number, from: number): string {
  return `\n# ${EXPORT_FORMAT_VERSION} · ${name} (${count} item${count === 1 ? '' : 's'}${from > 0 ? `, continuing from item ${from}` : ''})\n\n`;
}

export async function exportEverything(
  ctx: MemoryMapContext & { db: Database.Database },
  opts: { section?: ExportSection; offset?: number },
): Promise<ExportReply> {
  const budget = maxChars();
  const observationRows = observeEnabled() ? observationsForExport(ctx.db, path.resolve(ctx.memoryDir)) : [];
  const availableSections: readonly ExportSection[] = observationRows.length > 0
    ? [...EXPORT_SECTIONS, 'observations']
    : EXPORT_SECTIONS;
  // A whole export builds every section. A reply for one section builds that section only: the others are not read, so
  // their counts are null here (a whole export, with no `section`, counts them all).
  const wanted: readonly ExportSection[] = opts.section === undefined ? availableSections : [opts.section];
  const built = await buildSections(ctx, wanted);
  if (wanted.includes('observations')) {
    built.items.observations = observationRows.map((row) => {
      const content = [row.text, row.tool ? JSON.stringify(row.tool) : null].filter((part): part is string => part !== null && part.length > 0).join('\n');
      return `## ${oneLineToken(row.id)}\n\n${field('kind', 'observation')}${field('sessionId', row.session_id)}${field('sequence', String(row.seq))}`
        + `${field('event', row.event)}${field('client', row.client)}${field('at', row.ts)}${field('receivedAt', row.received_at)}`
        + `${row.cwd_scope === null ? '' : field('cwdScope', row.cwd_scope)}${field('retired', String(row.retired))}\n${fenced(content)}`;
    });
  }
  const count = (name: ExportSection): number | null => built.items[name]?.length ?? null;
  const counts = {
    ledgerEvents: built.ledgerEvents ?? null,
    dailyEntries: count('daily-entries'),
    notes: count('notes'),
    retired: count('retired'),
    ...(availableSections.includes('observations') ? { observations: count('observations') } : {}),
  };
  const sections = availableSections.map((name) => ({
    name,
    items: count(name),
    ...(name === 'ledger' ? { events: built.ledgerEvents ?? null } : {}),
  }));
  const nextAfter = (name: ExportSection): ExportSection | null => availableSections[availableSections.indexOf(name) + 1] ?? null;
  const base = {
    file: ctx.ledgerRelPath,
    format: 'markdown',
    formatVersion: EXPORT_FORMAT_VERSION,
    bytes: built.ledger?.length ?? null,
    counts,
    sections,
    notExported: notExported(),
    // learning.sqlite is user-owned workspace data, not a rebuildable search index. Export its
    // portable rows (never its private HMAC secret) alongside the Markdown memory document.
    learningLog: exportLearningLog(ctx.memoryDir),
  };

  let document = '';
  const included: ExportSection[] = [];
  let nextSection: ExportSection | null = null;
  let nextItem: number | undefined;
  let section: ExportSection | undefined;

  /** Emit items of one section from `from` while they fit; at least one, so a continuation always advances. */
  const emit = (name: ExportSection, from: number): number => {
    const items = built.items[name] ?? [];
    const joiner = name === 'ledger' ? '' : '\n';
    let i = from;
    let chunk = name === 'ledger' && from === 0 ? '' : sectionHeader(name, items.length, from);
    while (i < items.length) {
      const piece = items[i] + (name === 'ledger' ? '' : joiner);
      if (i > from && document.length + chunk.length + piece.length > budget) break;
      chunk += piece;
      i++;
    }
    document += chunk;
    return i;
  };

  if (opts.section === undefined) {
    // Whole sections while they fit. The ledger starts the reply and is paged by line only if it alone is too big.
    for (const name of availableSections) {
      const items = built.items[name] ?? [];
      const size = items.reduce((n, s) => n + s.length + 1, 0) + sectionHeader(name, items.length, 0).length;
      if (name === 'ledger' ? size <= budget : document.length + size <= budget) {
        if (name !== 'ledger' && items.length > 0) document += sectionHeader(name, items.length, 0) + items.join('\n');
        else if (name === 'ledger') document += built.ledger ?? '';
        if (items.length > 0 || name === 'ledger') included.push(name);
        continue;
      }
      if (name === 'ledger') {
        const end = emit('ledger', 0);
        included.push('ledger');
        nextSection = 'ledger';
        nextItem = end;
      } else {
        nextSection = name;
      }
      break;
    }
  } else {
    section = opts.section;
    const from = opts.offset ?? 0;
    const total = built.items[section]?.length ?? 0;
    if (from > total) throw new Error(`offset ${from} is past the end of ${section} (${total} item${total === 1 ? '' : 's'})`);
    const end = emit(section, from);
    included.push(section);
    if (end < total) { nextSection = section; nextItem = end; } else nextSection = nextAfter(section);
  }

  const truncated = section === undefined ? nextSection !== null : nextItem !== undefined;
  const manifest: Record<string, unknown> = {
    ...base,
    ...(section ? { section, offset: opts.offset ?? 0 } : {}),
    included,
    truncated,
    nextSection,
    ...(nextItem !== undefined ? { nextItem } : {}),
    documentChars: document.length,
  };
  return { manifest, document };
}
