import fs from 'fs';
import path from 'path';
import { openReadOnlyDb } from '../db/client';
import { BUNDLE_FORMAT, ImportBundle, ImportChunk, ImportEntity, ImportFact, ImportNote } from './types';
import { isVendorKind, readVendorSource, vendorSourcesEnabled } from './sources/vendor';

/**
 * Source adapters.
 *
 * A source is **read-only input**. Nothing here writes to a source, and a source
 * index is never merged into a destination index — the durable artifact is the
 * content, and the destination's own store is what a workspace reads.
 */

export interface SourceFilter {
  /** Relative-path prefixes to include. Empty = include everything not excluded. */
  include: string[];
  /** Relative-path prefixes to exclude. Applied after `include`. */
  exclude: string[];
  /** Cap on selected notes (bounded first runs). */
  limit?: number;
}

export interface RenorIndexSourceOptions extends SourceFilter {
  /** Path to a Renor-shaped SQLite index (`.memory-index/index.db`). Opened read-only. */
  dbPath: string;
  /** Prefix stripped from stored absolute paths to build relative paths. */
  sourceRoot: string;
  /**
   * Directory tree holding the source's original Markdown, when it is reachable.
   * Defaults to `sourceRoot`. A note whose original bytes are found is carried
   * byte-for-byte (and its chunk line ranges stay truthful); otherwise the parse is
   * reconstructed from chunk text and the bundle reports it.
   */
  contentRoot?: string;
  /** Label recorded as the bundle's source (defaults to the index's basename chain). */
  label?: string;
}

/** Relative path with forward slashes, or the input unchanged when it is not under the root. */
export function toRelative(sourceRoot: string, absolutePath: string): string {
  const root = path.resolve(sourceRoot);
  const abs = path.resolve(absolutePath);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return absolutePath;
  return rel.split(path.sep).join('/');
}

function matchesPrefix(relPath: string, prefixes: string[]): boolean {
  return prefixes.some(prefix => {
    const clean = prefix.replace(/^(\.?\/)+/, '').replace(/\/+$/, '');
    return relPath === clean || relPath.startsWith(clean + '/');
  });
}

/** Selection is explicit: a path must pass `include` (when given) and survive `exclude`. */
export function isSelected(relPath: string, filter: SourceFilter): boolean {
  if (filter.include.length > 0 && !matchesPrefix(relPath, filter.include)) return false;
  if (filter.exclude.length > 0 && matchesPrefix(relPath, filter.exclude)) return false;
  return true;
}

interface SourceNoteRow {
  path: string;
  title: string;
  kind: string | null;
  modified_at: string;
  frontmatter_json: string;
}

interface SourceChunkRow {
  note_path: string;
  heading_path: string;
  text: string;
  token_count: number;
  start_line: number;
  end_line: number;
}

interface SourceFactRow {
  subject: string | null;
  predicate: string;
  object_text: string | null;
  scope: string | null;
  valid_from: string;
  valid_to: string | null;
  source_path: string;
}

interface SourceEntityRow {
  type: string;
  canonical_name: string;
  aliases_json: string;
  confidence: number;
}

/**
 * Read a Renor-shaped index (any store that uses the engine's `notes`/`chunks`/`facts`
 * tables, including another Renor workspace or the personal brain) as an import bundle.
 *
 * The database is opened `readonly` so a source can never be written by an import —
 * including the WAL side files a write-capable open would touch.
 */
export function readRenorIndexSource(options: RenorIndexSourceOptions): ImportBundle {
  // Through the sanctioned opener (`src/db/client.ts`), which enforces read-only at the
  // SQLite level so an import can never write to the store it is reading.
  const db = openReadOnlyDb(options.dbPath);
  try {
    const filter: SourceFilter = {
      include: options.include ?? [],
      exclude: options.exclude ?? [],
      limit: options.limit,
    };

    const allNotes = db.prepare(
      'SELECT path, title, kind, modified_at, frontmatter_json FROM notes',
    ).all() as SourceNoteRow[];

    const selected: Array<{ row: SourceNoteRow; rel: string }> = [];
    let filteredOut = 0;
    for (const row of allNotes) {
      const rel = toRelative(options.sourceRoot, row.path);
      if (!isSelected(rel, filter)) {
        filteredOut += 1;
        continue;
      }
      // The lifecycle's synthetic `_mcp_` row is not a note document.
      if (rel === '_mcp_') {
        filteredOut += 1;
        continue;
      }
      selected.push({ row, rel });
    }
    selected.sort((a, b) => a.rel.localeCompare(b.rel));
    const limited = options.limit !== undefined && options.limit >= 0
      ? selected.slice(0, options.limit)
      : selected;

    const chunksByNote = new Map<string, ImportChunk[]>();
    const entitiesByNote = new Map<string, ImportEntity[]>();
    const contentsByNote = new Map<string, string>();
    const chunkStmt = db.prepare(
      'SELECT note_path, heading_path, text, token_count, start_line, end_line FROM chunks WHERE note_path = ? ORDER BY id',
    );
    // The lifecycle sentinel owns canonical entities; carrying those would duplicate
    // the destination's own lifecycle entity for the same subject.
    const entityStmt = db.prepare(
      `SELECT type, canonical_name, aliases_json, confidence FROM entities
        WHERE source_note = ? AND source_note != '_mcp_'`,
    );
    const contentRoot = path.resolve(options.contentRoot ?? options.sourceRoot);
    for (const { row, rel } of limited) {
      const rows = chunkStmt.all(row.path) as SourceChunkRow[];
      chunksByNote.set(row.path, rows.map(r => ({
        headingPath: r.heading_path ?? '',
        text: r.text,
        tokenCount: r.token_count,
        // The same span rule as the bundle adapter: a coordinate that cannot be a citation
        // is dropped rather than inherited into the destination's `chunks` rows.
        ...normalizedSpan(r.start_line, r.end_line),
      })));
      const entityRows = entityStmt.all(row.path) as SourceEntityRow[];
      entitiesByNote.set(row.path, entityRows.map(e => ({
        type: e.type,
        canonicalName: e.canonical_name,
        aliases: parseAliases(e.aliases_json),
        confidence: typeof e.confidence === 'number' ? e.confidence : 1,
      })));
      // Prefer the source's own bytes: they are the source of truth, they keep the
      // stored chunk line ranges truthful, and copying a document is not re-parsing it.
      const original = readOriginalContent(contentRoot, rel);
      if (original !== null) contentsByNote.set(row.path, original);
    }

    const notes: ImportNote[] = limited.map(({ row, rel }) => ({
      sourcePath: row.path,
      relPath: rel,
      title: row.title,
      kind: row.kind ?? null,
      modifiedAt: row.modified_at,
      frontmatter: parseFrontmatter(row.frontmatter_json),
      chunks: chunksByNote.get(row.path) ?? [],
      entities: entitiesByNote.get(row.path) ?? [],
      originalContent: contentsByNote.get(row.path),
    }));

    // Only CURRENT facts are carried: a superseded value is history the destination
    // would have to replay in order, and the source's own ledger is the authority for
    // its lifecycle. Carrying closed rows would duplicate history under new ids.
    const factsAvailable = (db.prepare(
      'SELECT count(*) AS c FROM facts WHERE valid_to IS NULL',
    ).get() as { c: number }).c;

    const factRows = db.prepare(
      `SELECT e.canonical_name AS subject, f.predicate AS predicate, f.object_text AS object_text,
              f.scope AS scope, f.valid_from AS valid_from, f.valid_to AS valid_to,
              f.source_path AS source_path
         FROM facts f
         JOIN entities e ON e.id = f.subject_entity_id
        WHERE f.valid_to IS NULL AND f.object_text IS NOT NULL AND e.canonical_name IS NOT NULL
        ORDER BY f.valid_from DESC, f.id DESC`,
    ).all() as SourceFactRow[];

    const selectedNotePaths = new Set(limited.map(({ row }) => row.path));
    const facts: ImportFact[] = [];
    for (const row of factRows) {
      const isLedgerFact = row.source_path === '_mcp_';
      // Ledger-derived facts are the owner's explicitly stated memory: a small, global,
      // high-value set. They are carried by default (the point of an import is to see
      // what Renor already holds) and skipped only when the caller excludes them.
      if (isLedgerFact) {
        if (matchesPrefix('_mcp_', filter.exclude) || matchesPrefix('ledger', filter.exclude)) continue;
      } else if (!selectedNotePaths.has(row.source_path)) {
        continue;
      }
      facts.push({
        subject: String(row.subject),
        predicate: String(row.predicate),
        object: String(row.object_text),
        scope: row.scope ?? 'global',
        validFrom: row.valid_from,
        sourcePath: row.source_path,
        origin: isLedgerFact ? 'ledger' : 'note',
        ledgerSource: isLedgerFact ? 'import:renor-index' : 'import:renor-index',
      });
    }

    return {
      format: BUNDLE_FORMAT,
      sourceLabel: options.label ?? 'renor-index',
      notes,
      facts,
      stats: {
        notesAvailable: allNotes.length,
        notesSelected: notes.length,
        notesFilteredOut: filteredOut + (selected.length - limited.length),
        notesWithOriginalBytes: notes.filter(n => n.originalContent !== undefined).length,
        chunksSelected: notes.reduce((sum, n) => sum + n.chunks.length, 0),
        factsAvailable,
        factsSelected: facts.length,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * The source note's original bytes, when the content tree is reachable. Returns null
 * when the file is absent, so the caller falls back to reconstruction and reports it.
 */
function readOriginalContent(contentRoot: string, relPath: string): string | null {
  const candidate = path.resolve(contentRoot, relPath);
  const root = path.resolve(contentRoot);
  const rel = path.relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    return fs.readFileSync(candidate, 'utf8');
  } catch {
    return null;
  }
}

function parseAliases(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Read a `renor-memory-export/v1` JSONL bundle written by any provider.
 * One JSON record per line: `{"type":"note",…}` / `{"type":"fact",…}` / `{"type":"meta",…}`.
 *
 * `filter` is applied HERE, in the adapter, exactly as the index adapter applies it —
 * `include`/`exclude` select note records by `relPath`, `limit` caps the selection, and
 * `_mcp_`/`ledger` in `exclude` drops the owner's ledger-derived facts. An adapter that
 * returned everything would make the CLI's selection flags a silent no-op, and
 * `--exclude Private` would import the private notes anyway. `filter` is optional so the
 * adapter can still be used as a plain bundle reader.
 */
export function readBundleSource(
  filePath: string,
  filter: SourceFilter = { include: [], exclude: [] },
): ImportBundle {
  const include = filter.include ?? [];
  const exclude = filter.exclude ?? [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsedNotes: ImportNote[] = [];
  const parsedFacts: ImportFact[] = [];
  let sourceLabel = path.basename(filePath, path.extname(filePath));
  let format = BUNDLE_FORMAT;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let record: Record<string, unknown> | null | undefined;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`bundle line ${i + 1} is not valid JSON`);
    }
    if (record?.type === 'meta') {
      if (typeof record.format === 'string') format = record.format;
      if (typeof record.source === 'string') sourceLabel = record.source;
      continue;
    }
    if (record?.type === 'note') {
      // Every field that reaches canonical bytes is validated where it is read: `String(x)`
      // accepted anything, so a malformed record became the literal text `[object Object]`,
      // which is then written into Markdown, indexed, and (for a fact) recorded in the
      // ledger as though it were memory.
      const note = `note ${bundleLabel(record.relPath ?? record.path)}`;
      const at = bundleWhere(note, i);
      const relPathFromRecord = record.relPath ?? record.path;
      parsedNotes.push({
        sourcePath: bundleString(record.path, '', 'path', at),
        relPath: bundleString(relPathFromRecord, '', 'relPath', at),
        title: bundleString(record.title, '', 'title', at),
        kind: typeof record.kind === 'string' ? record.kind : null,
        modifiedAt: bundleString(record.modifiedAt, '', 'modifiedAt', at),
        frontmatter: record.frontmatter && typeof record.frontmatter === 'object' ? record.frontmatter as Record<string, unknown> : {},
        chunks: Array.isArray(record.chunks)
          ? record.chunks.map((c: Record<string, unknown> | null | undefined, index: number): ImportChunk => {
            const chunk = bundleWhere(note, i, `chunk ${index}`);
            return {
              headingPath: bundleString(c?.headingPath, '', 'headingPath', chunk),
              text: bundleString(c?.text, '', 'text', chunk),
              tokenCount: bundleNumber(c?.tokenCount, 0, 'tokenCount', chunk),
              // Spans must survive the round trip: they are the only fallback for a chunk
              // whose text cannot be located, so dropping them would silently make a
              // bundle-sourced import behave differently from a direct index read. A span
              // that cannot be a citation — negative, fractional, or reversed — is dropped
              // here instead of being inherited as a coordinate.
              ...normalizedSpan(c?.startLine, c?.endLine),
            };
          })
          : [],
        entities: Array.isArray(record.entities)
          ? record.entities.map((e: Record<string, unknown> | null | undefined, index: number): ImportEntity => {
            const entity = bundleWhere(note, i, `entity ${index}`);
            return {
              type: bundleString(e?.type, 'note', 'type', entity),
              canonicalName: bundleString(e?.canonicalName, '', 'canonicalName', entity),
              aliases: Array.isArray(e?.aliases)
                ? e.aliases.map((a: unknown, aliasIndex: number) => (
                  bundleString(a, '', `alias ${aliasIndex}`, entity)
                ))
                : [],
              confidence: bundleNumber(e?.confidence, 1, 'confidence', entity),
            };
          })
          : [],
        originalContent: typeof record.originalContent === 'string' ? record.originalContent : undefined,
      });
      continue;
    }
    if (record?.type === 'fact') {
      // `String(x)` on a fact field fabricated `[object Object]` as a canonical ledger value.
      const at = bundleWhere('fact', i);
      parsedFacts.push({
        subject: bundleString(record.subject, '', 'subject', at),
        predicate: bundleString(record.predicate, '', 'predicate', at),
        object: bundleString(record.object, '', 'object', at),
        scope: String(record.scope ?? 'global'),
        validFrom: String(record.validFrom ?? ''),
        sourcePath: String(record.sourcePath ?? ''),
        origin: record.origin === 'ledger' ? 'ledger' : 'note',
        eventId: typeof record.eventId === 'string' ? record.eventId : undefined,
        closedEvent: (record.closedEvent ?? null) as string | null, // carried unvalidated, as before
        ledgerSource: typeof record.ledgerSource === 'string' ? record.ledgerSource : undefined,
      });
      continue;
    }
    throw new Error(`bundle line ${i + 1} has unknown record type ${JSON.stringify(record?.type)}`);
  }

  if (format !== BUNDLE_FORMAT) {
    throw new Error(`unsupported bundle format ${JSON.stringify(format)}; expected ${BUNDLE_FORMAT}`);
  }

  // Selection, in the same order and with the same rule the index adapter uses: the index
  // adapter sorts by relative path BEFORE applying `limit`, so a bundle is sorted here too
  // and `--limit N` selects the same records whichever order the provider wrote them in.
  const selection: SourceFilter = { include, exclude };
  const selected: ImportNote[] = [];
  let notesFilteredOut = 0;
  for (const note of parsedNotes) {
    if (!isSelected(note.relPath, selection)) {
      notesFilteredOut += 1;
      continue;
    }
    selected.push(note);
  }
  selected.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const notes = filter.limit !== undefined && filter.limit >= 0
    ? selected.slice(0, filter.limit)
    : selected;
  notesFilteredOut += selected.length - notes.length;

  // Facts follow the notes: a note-derived fact for a note that was not selected is not
  // carried, and the owner's ledger-derived facts (`_mcp_`) are carried by default and
  // dropped only when explicitly excluded — the same rule the index adapter applies.
  // Both a note's source path and its relative path count as naming it, because a
  // provider may write either.
  const selectedPaths = new Set<string>();
  for (const note of notes) {
    selectedPaths.add(note.sourcePath);
    selectedPaths.add(note.relPath);
  }
  const facts: ImportFact[] = [];
  for (const fact of parsedFacts) {
    if (fact.sourcePath === '_mcp_') {
      if (matchesPrefix('_mcp_', exclude) || matchesPrefix('ledger', exclude)) continue;
      facts.push(fact);
      continue;
    }
    // A fact that names no path at all carries no note association that selection could
    // be applied to; one that names a path must belong to a selected note.
    if (fact.sourcePath !== '' && !selectedPaths.has(fact.sourcePath)) continue;
    facts.push(fact);
  }

  return {
    format,
    sourceLabel,
    notes,
    facts,
    stats: {
      notesAvailable: parsedNotes.length,
      notesSelected: notes.length,
      notesFilteredOut,
      notesWithOriginalBytes: notes.filter(n => n.originalContent !== undefined).length,
      chunksSelected: notes.reduce((sum, n) => sum + n.chunks.length, 0),
      factsAvailable: parsedFacts.length,
      factsSelected: facts.length,
    },
  };
}

/** A label for a record whose own identity may be malformed, safe to print in an error. */
function bundleLabel(raw: unknown): string {
  return typeof raw === 'string' ? JSON.stringify(raw) : JSON.stringify(raw ?? '');
}

/**
 * A string field of a bundle record, validated where the record is read.
 *
 * An absent/null field keeps its default, so existing bundles stay readable; a
 * present-but-non-string field is refused, naming the line, the record and the field.
 */
function bundleString(raw: unknown, fallback: string, field: string, where: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') {
    throw new Error(
      `${where} has an invalid ${field} ${JSON.stringify(raw)}: expected a string`,
    );
  }
  return raw;
}

/** Where a bundle record's field lives, so a malformed value is named precisely. */
function bundleWhere(origin: string, lineIndex: number, part?: string): string {
  return `bundle line ${lineIndex + 1}: ${origin}${part ? ` ${part}` : ''}`;
}

/**
 * A line span, or nothing when it cannot be a citation.
 *
 * A negative or fractional span was copied verbatim and could be inherited into
 * `chunks.start_line`/`end_line` and handed back as a citation range, so a span that is not
 * a non-negative, ordered integer pair is treated exactly like "text not located": unknown.
 */
function normalizedSpan(
  startLine: unknown,
  endLine: unknown,
): { startLine?: number; endLine?: number } {
  if (typeof startLine !== 'number' || typeof endLine !== 'number') return {};
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return {};
  if (startLine < 0 || endLine < startLine) return {};
  return { startLine, endLine };
}

/**
 * A numeric field of a bundle record, validated where the record is read.
 *
 * `Number(record.field ?? default)` accepted anything: a malformed `tokenCount` became
 * `NaN`, travelled through the plan, and only failed at the write layer as
 * `NOT NULL constraint failed: chunks.token_count` — after canonical note bytes had been
 * written, and reported as a *ledger replay* rejection. Invalid input is a property of the
 * bundle, so it is rejected here, before any write, naming the line, the note and the
 * field. An absent/null field keeps its default, so existing bundles stay readable.
 */
function bundleNumber(raw: unknown, fallback: number, field: string, where: string): number {
  if (raw === undefined || raw === null) return fallback;
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${where} has an invalid ${field} ${JSON.stringify(raw)}: expected a non-negative finite number`,
    );
  }
  return value;
}

/** Open a source from a `kind:path` spec. */
export function readSource(
  spec: string,
  filter: SourceFilter & { sourceRoot?: string; contentRoot?: string; label?: string },
): ImportBundle {
  const separator = spec.indexOf(':');
  if (separator < 0) {
    throw new Error('source must be given as kind:path (for example renor-index:/path/index.db)');
  }
  const kind = spec.slice(0, separator);
  const target = spec.slice(separator + 1);
  if (kind === 'renor-index') {
    return readRenorIndexSource({
      dbPath: target,
      sourceRoot: filter.sourceRoot ?? path.dirname(path.dirname(target)),
      contentRoot: filter.contentRoot,
      include: filter.include,
      exclude: filter.exclude,
      limit: filter.limit,
      label: filter.label,
    });
  }
  if (kind === 'bundle') {
    return readBundleSource(target, {
      include: filter.include,
      exclude: filter.exclude,
      limit: filter.limit,
    });
  }
  if (isVendorKind(kind) && vendorSourcesEnabled()) {
    return readVendorSource(kind, target, { include: filter.include, exclude: filter.exclude, limit: filter.limit });
  }
  throw new Error(`unknown source kind ${JSON.stringify(kind)}; expected renor-index or bundle`);
}
