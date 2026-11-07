import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { hashContent } from '../../src/indexer/hasher';
import { replayLedger, factsFor, appendLedgerEvent, parseLedgerEvents } from '../../src/memory/lifecycle';
import { readRenorIndexSource, readBundleSource, readSource } from '../../src/importing/source';
import { buildImportPlan, streamKey } from '../../src/importing/plan';
import { applyImportPlan } from '../../src/importing/apply';
import { renderNoteMarkdown } from '../../src/importing/serialize';
import { deterministicEventId, toCanonicalInstant, tryNormalizeScope } from '../../src/importing/facts';
import { readExistingStreams } from '../../src/importing/existing';
import { run as runCli } from '../../src/importing/cli';

/**
 * Memory-import regression tests.
 *
 * All data is SYNTHETIC. Nothing here reads a personal vault, a product tenant or the
 * private brain: the fixtures build their own source index, their own content tree and
 * their own destination workspace, so the suite runs with no network and no credentials.
 */

const LEDGER = 'System/Memory Events Ledger.md';
// readRenorIndexSource's options type requires both path filters; empty means "every note".
const ALL_NOTES = { include: [], exclude: [] };
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function mkdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

interface SyntheticNote {
  rel: string;
  content: string;
  title: string;
  chunks: Array<{ headingPath: string; text: string; startLine: number; endLine: number; tokenCount: number }>;
  entities?: Array<{ type: string; name: string }>;
  frontmatter?: Record<string, unknown>;
}

/** A synthetic source workspace: content tree + an index over it. */
function buildSyntheticSource(notes: SyntheticNote[], opts: { withContent?: boolean } = {}) {
  const root = mkdir('import-source-');
  const contentRoot = path.join(root, 'content');
  const dbDir = path.join(root, 'store', '.memory-index');
  const dbPath = path.join(dbDir, 'index.db');
  const db = openDb(dbPath);
  runMigrations(db);

  const insertNote = db.prepare(
    `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEntity = db.prepare(
    `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
     VALUES (?, ?, '[]', ?, 1, ?)`,
  );

  // The lifecycle's synthetic note row owns lifecycle entities, exactly as the engine's
  // own `resolveLifecycleEntity` does. It is never importable as a document.
  insertNote.run('_mcp_', 'lifecycle', 'system', 'synthetic', '2026-01-01T00:00:00.000Z', '{}');

  for (const note of notes) {
    const absolute = path.join(contentRoot, note.rel);
    if (opts.withContent !== false) write(absolute, note.content);
    insertNote.run(
      absolute,
      note.title,
      null,
      hashContent(note.content),
      '2026-01-02T03:04:05.000Z',
      JSON.stringify(note.frontmatter ?? {}),
    );
    for (const chunk of note.chunks) {
      insertChunk.run(
        absolute,
        chunk.headingPath,
        chunk.text,
        chunk.startLine,
        chunk.endLine,
        chunk.tokenCount,
        hashContent(chunk.text),
      );
    }
    for (const entity of note.entities ?? []) {
      insertEntity.run(entity.type, entity.name, absolute, '2026-01-02T03:04:05.000Z');
    }
  }
  db.close();

  return { root, contentRoot, dbPath, sourceRoot: contentRoot };
}

/** The lifecycle sentinel owns lifecycle entities, so the FK target must exist. */
function ensureLifecycleNote(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
     VALUES ('_mcp_', 'lifecycle', 'system', 'synthetic', '2026-01-01T00:00:00.000Z', '{}')`,
  ).run();
}

function insertFact(
  dbPath: string,
  fact: { subject: string; predicate: string; object: string; sourcePath: string; validFrom: string; scope?: string },
): void {
  const db = new Database(dbPath);
  try {
    ensureLifecycleNote(db);
    const entityId = (() => {
      const found = db.prepare('SELECT id FROM entities WHERE canonical_name = ? LIMIT 1').get(fact.subject) as { id: number } | undefined;
      if (found) return found.id;
      const info = db.prepare(
        `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
         VALUES ('concept', ?, '[]', '_mcp_', 1, ?)`,
      ).run(fact.subject, '2026-01-01T00:00:00.000Z');
      return Number(info.lastInsertRowid);
    })();
    db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, scope)
       VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?)`,
    ).run(entityId, fact.predicate, fact.object, fact.sourcePath, fact.validFrom, fact.validFrom, fact.scope ?? 'global');
  } finally {
    db.close();
  }
}

/**
 * A synthetic destination workspace: empty memory dir, initialized index.
 *
 * A seed is written the way the engine itself writes one — a ledger event, projected by
 * replay — never as a bare `facts` row. A row with no ledger event is a state the
 * engine's own write path never produces, and it would make the additive-skip test
 * depend on a fixture artifact.
 */
async function buildDestination(seed?: { subject: string; predicate: string; object: string; validFrom: string }) {
  const memoryDir = mkdir('import-dest-');
  const dbPath = path.join(memoryDir, '.memory-index', 'index.db');
  const db = openDb(dbPath);
  runMigrations(db);
  db.close();
  if (seed) {
    await appendLedgerEvent(memoryDir, LEDGER, {
      id: 'mem_seed0001',
      at: seed.validFrom,
      kind: 'store',
      subject: seed.subject,
      predicate: seed.predicate,
      object: seed.object,
      closedEvent: null,
      source: 'fixture',
      scope: 'global',
    });
    const db2 = openDb(dbPath);
    try {
      await replayLedger(db2, memoryDir, LEDGER);
    } finally {
      db2.close();
    }
  }
  return { memoryDir, dbPath };
}

/**
 * Reads the destination the way the CLI does, through the PRODUCTION helper, so a
 * regression that dropped the ledger-aware half cannot hide behind the test's own query.
 */
function existingStreamsAt(dbPath: string, memoryDir: string): Set<string> {
  return readExistingStreams(dbPath, path.join(memoryDir, ...LEDGER.split('/')));
}

function countsAt(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    return {
      notes: one('SELECT count(*) AS c FROM notes'),
      chunks: one('SELECT count(*) AS c FROM chunks'),
      entities: one('SELECT count(*) AS c FROM entities'),
      facts: one('SELECT count(*) AS c FROM facts'),
      currentLifecycleFacts: one(`SELECT count(*) AS c FROM facts WHERE valid_to IS NULL AND source_path = '_mcp_'`),
      fts: one('SELECT count(*) AS c FROM chunks_fts'),
    };
  } finally {
    db.close();
  }
}

const NOTES: SyntheticNote[] = [
  {
    rel: 'Projects/Alpha/plan.md',
    title: 'Alpha plan',
    content: '# Alpha plan\n\nShip the first slice.\n\n## Risks\n\nLatency is the main risk.\n',
    chunks: [
      { headingPath: 'Alpha plan', text: '# Alpha plan\n\nShip the first slice.', startLine: 0, endLine: 4, tokenCount: 8 },
      { headingPath: 'Alpha plan > Risks', text: '## Risks\n\nLatency is the main risk.', startLine: 4, endLine: 7, tokenCount: 9 },
    ],
    entities: [{ type: 'note', name: 'Alpha plan' }],
  },
  {
    rel: 'Projects/Alpha/notes.md',
    title: 'Scratch',
    content: '# Scratch\n\nA second note.\n',
    chunks: [{ headingPath: 'Scratch', text: '# Scratch\n\nA second note.', startLine: 0, endLine: 2, tokenCount: 6 }],
  },
  {
    rel: 'Archive/old.md',
    title: 'Old',
    content: '# Old\n\nSuperseded material.\n',
    chunks: [{ headingPath: 'Old', text: '# Old\n\nSuperseded material.', startLine: 0, endLine: 2, tokenCount: 6 }],
  },
];

describe('memory import — source selection', () => {
  it('selects by explicit include/exclude and reports what it left out', () => {
    const source = buildSyntheticSource(NOTES);
    const bundle = readRenorIndexSource({
      dbPath: source.dbPath,
      sourceRoot: source.sourceRoot,
      contentRoot: source.contentRoot,
      include: ['Projects/Alpha'],
      exclude: ['Archive'],
    });
    expect(bundle.notes.map(n => n.relPath).sort()).toEqual([
      'Projects/Alpha/notes.md',
      'Projects/Alpha/plan.md',
    ]);
    expect(bundle.stats.notesAvailable).toBe(4);
    expect(bundle.stats.notesSelected).toBe(2);
    // the Archive note, plus the lifecycle sentinel which is never a document
    expect(bundle.stats.notesFilteredOut).toBe(2);
    expect(bundle.stats.chunksSelected).toBe(3);
  });

  it('carries the source bytes verbatim when the content tree is reachable', () => {
    const source = buildSyntheticSource(NOTES);
    const bundle = readRenorIndexSource({
      ...ALL_NOTES,
      dbPath: source.dbPath,
      sourceRoot: source.sourceRoot,
      contentRoot: source.contentRoot,
      include: ['Projects/Alpha'],
    });
    expect(bundle.stats.notesWithOriginalBytes).toBe(2);
    const plan = buildImportPlan(bundle, { namespace: 'Imported/x', label: 'x', eventSource: 'import:x' });
    expect(plan.counts.notesFromOriginalBytes).toBe(2);
    expect(plan.counts.notesReconstructed).toBe(0);
    // Byte-for-byte: the content written is exactly the source file.
    const planned = plan.notes.find(n => n.relPath.endsWith('plan.md'))!;
    expect(planned.content).toBe(NOTES[0].content);
    // Spans located in the bytes written, not the source's stored spans (which the
    // real index does not keep aligned with its own chunk text).
    expect(planned.chunkLines).toEqual([{ startLine: 0, endLine: 3 }, { startLine: 4, endLine: 7 }]);
    expect(planned.chunksNotLocated).toBe(0);
  });

  it('falls back to reconstruction when there are no original bytes, and says so', () => {
    const source = buildSyntheticSource(NOTES, { withContent: false });
    const bundle = readRenorIndexSource({
      ...ALL_NOTES,
      dbPath: source.dbPath,
      sourceRoot: source.sourceRoot,
      contentRoot: source.contentRoot,
      include: ['Projects/Alpha/plan.md'],
    });
    expect(bundle.stats.notesWithOriginalBytes).toBe(0);
    const plan = buildImportPlan(bundle, { namespace: 'Imported/x', label: 'x', eventSource: 'import:x' });
    expect(plan.counts.notesReconstructed).toBe(1);
    const rendered = renderNoteMarkdown(bundle.notes[0]);
    expect(rendered.fromOriginalBytes).toBe(false);
    // The reconstruction carries every chunk's text and its heading structure.
    expect(rendered.content).toContain('Ship the first slice.');
    expect(rendered.content).toContain('## Risks');
    expect(rendered.content).toContain('Latency is the main risk.');
  });

  it('honours --limit and the lifecycle sentinel is never imported as a note', () => {
    const source = buildSyntheticSource(NOTES);
    const bundle = readRenorIndexSource({
      ...ALL_NOTES,
      dbPath: source.dbPath,
      sourceRoot: source.sourceRoot,
      contentRoot: source.contentRoot,
      limit: 2,
    });
    expect(bundle.notes).toHaveLength(2);
    expect(bundle.notes.map(n => n.relPath)).not.toContain('_mcp_');
    // filtered = the lifecycle sentinel + the one note dropped by --limit
    expect(bundle.stats.notesFilteredOut).toBe(2);
  });
});

describe('memory import — chunk spans describe the bytes written', () => {
  it('slices the written content back to each chunk, including across blank-line runs', () => {
    const note = {
      sourcePath: '/source/Doc.md',
      relPath: 'Doc.md',
      title: 'Doc',
      kind: null,
      modifiedAt: '2026-01-01T00:00:00.000Z',
      frontmatter: {},
      entities: [],
      chunks: [
        { headingPath: 'Doc', text: '# Doc\n\nFirst part.', tokenCount: 5 },
        { headingPath: 'Doc', text: 'Second part after a blank run.', tokenCount: 6 },
        { headingPath: 'Doc > Later', text: '## Later\n\nTail section.', tokenCount: 5 },
      ],
    };
    // Reconstruction path — the path where a blank-line collapse used to shift every
    // later span, because spans were computed before the bytes were finalised.
    const rendered = renderNoteMarkdown(note);
    expect(rendered.fromOriginalBytes).toBe(false);
    expect(rendered.chunksNotLocated).toBe(0);
    const lines = rendered.content.split('\n');
    rendered.chunkLines.forEach((span, index) => {
      const textLines = note.chunks[index].text.split('\n').filter(Boolean);
      const slice = lines.slice(span.startLine, span.endLine).join('\n');
      expect(slice).toContain(textLines[0].trim());
      expect(slice).toContain(textLines[textLines.length - 1].trim());
    });
  });

  it('locates spans in the original bytes rather than trusting the source index', () => {
    const original = '# Note\n\nalpha line\n\nbeta line\n';
    const note = {
      sourcePath: '/source/N.md',
      relPath: 'N.md',
      title: 'Note',
      kind: null,
      modifiedAt: '2026-01-01T00:00:00.000Z',
      frontmatter: {},
      entities: [],
      originalContent: original,
      // Deliberately wrong spans, like a real index (only 475 of 594 sampled stored
      // spans contained their own chunk text).
      chunks: [
        { headingPath: 'Note', text: 'alpha line', tokenCount: 2, startLine: 99, endLine: 99 },
        { headingPath: 'Note', text: 'beta line', tokenCount: 2, startLine: 99, endLine: 99 },
      ],
    };
    const rendered = renderNoteMarkdown(note);
    expect(rendered.fromOriginalBytes).toBe(true);
    expect(rendered.content).toBe(original);
    expect(rendered.chunksNotLocated).toBe(0);
    const lines = original.split('\n');
    expect(lines.slice(rendered.chunkLines[0].startLine, rendered.chunkLines[0].endLine).join('\n')).toBe('alpha line');
    expect(lines.slice(rendered.chunkLines[1].startLine, rendered.chunkLines[1].endLine).join('\n')).toBe('beta line');
  });

  it('reports an unknown span, never a source coordinate, when reconstructing', () => {
    const note = {
      sourcePath: '/source/X.md',
      relPath: 'X.md',
      title: 'X',
      kind: null,
      modifiedAt: '2026-01-01T00:00:00.000Z',
      frontmatter: {},
      entities: [],
      // No original bytes: the written file's coordinates differ from the source's, so
      // inheriting the source span here would point at unrelated text.
      chunks: [
        { headingPath: 'X', text: 'kept chunk text', tokenCount: 2 },
        { headingPath: 'X', text: '   ', tokenCount: 2, startLine: 40, endLine: 41 },
      ],
    };
    const rendered = renderNoteMarkdown(note);
    expect(rendered.fromOriginalBytes).toBe(false);
    // Reconstruction writes every chunk it has, so an unlocatable chunk is the one
    // whose text is not content at all.
    expect(rendered.chunksNotLocated).toBe(1);
    expect(rendered.chunksSpanInherited).toBe(0);
    expect(rendered.chunkLines[1]).toEqual({ startLine: 0, endLine: 0 });
  });

  it('falls back to the source span and reports it when the text cannot be located', () => {
    const note = {
      sourcePath: '/source/X.md',
      relPath: 'X.md',
      title: 'X',
      kind: null,
      modifiedAt: '2026-01-01T00:00:00.000Z',
      frontmatter: {},
      entities: [],
      originalContent: '# X\n\nsomething else entirely\n',
      chunks: [{ headingPath: 'X', text: 'text that is not in the file', tokenCount: 2, startLine: 3, endLine: 4 }],
    };
    const rendered = renderNoteMarkdown(note);
    expect(rendered.chunksNotLocated).toBe(1);
    // Original bytes are on disk, so the source's own span is valid for them and is
    // inherited — but the count makes it distinguishable from a located span.
    expect(rendered.chunksSpanInherited).toBe(1);
    expect(rendered.chunkLines[0]).toEqual({ startLine: 3, endLine: 4 });
  });
});

describe('memory import — the bundle is a round-trippable interface', () => {
  it('exports a bundle and imports it with identical results', async () => {
    const source = buildSyntheticSource(NOTES);
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'primary_goal', object: 'durable memory', sourcePath: '_mcp_', validFrom: '2026-01-05T10:00:00.000Z' });
    const dir = mkdir('import-roundtrip-');
    const bundleFile = path.join(dir, 'slice.jsonl');

    const exit = await runCli([
      '--from', `renor-index:${source.dbPath}`,
      '--source-root', source.sourceRoot,
      '--content-root', source.contentRoot,
      '--include', 'Projects/Alpha',
      '--to', path.join(dir, 'unused-memory-dir'),
      '--emit-bundle', bundleFile,
      '--json',
    ]);
    expect(exit).toBe(0);

    // The bundle is private material on disk: 0600, including on overwrite.
    // Windows has no POSIX mode bits: stat reports 0o666/0o777 whatever was asked, and chmod only toggles read-only.
    const posixModes = process.platform !== 'win32';
    if (posixModes) expect(fs.statSync(bundleFile).mode & 0o777).toBe(0o600);
    fs.chmodSync(bundleFile, 0o644);
    await runCli([
      '--from', `renor-index:${source.dbPath}`,
      '--source-root', source.sourceRoot,
      '--content-root', source.contentRoot,
      '--include', 'Projects/Alpha',
      '--to', path.join(dir, 'unused-memory-dir'),
      '--emit-bundle', bundleFile,
      '--json',
    ]);
    if (posixModes) expect(fs.statSync(bundleFile).mode & 0o777).toBe(0o600);

    const bundle = readBundleSource(bundleFile);
    expect(bundle.notes).toHaveLength(2);
    expect(bundle.notes.every(n => typeof n.originalContent === 'string')).toBe(true);
    expect(bundle.facts).toHaveLength(1);
    // Chunk metadata survives the round trip, including the spans the locator falls back
    // to — otherwise a bundle-sourced import behaves differently from a direct index read.
    const direct = readRenorIndexSource({
      ...ALL_NOTES,
      dbPath: source.dbPath,
      sourceRoot: source.sourceRoot,
      contentRoot: source.contentRoot,
      include: ['Projects/Alpha'],
    }).notes.find(n => n.relPath.endsWith('plan.md'))!;
    const viaBundle = bundle.notes.find(n => n.relPath.endsWith('plan.md'))!;
    expect(viaBundle.chunks.map(c => c.text)).toEqual(direct.chunks.map(c => c.text));
    expect(viaBundle.chunks[0].startLine).toBe(direct.chunks[0].startLine);
    expect(viaBundle.chunks[0].endLine).toBe(direct.chunks[0].endLine);

    const destination = await buildDestination();
    const result = await applyImportPlan(
      buildImportPlan(bundle, { namespace: 'Imported/x', label: 'x', eventSource: 'import:x' }),
      bundle,
      destination,
    );
    expect(result.notesWritten).toBe(2);
    expect(result.eventsAppended).toBe(1);
    expect(result.destination!.currentFacts).toBe(1);
    // The original bytes survived the round trip.
    expect(fs.readFileSync(path.join(destination.memoryDir, 'Imported/x/Projects/Alpha/plan.md'), 'utf8'))
      .toBe(NOTES[0].content);
  });
});

describe('memory import — default source root derivation', () => {
  it('derives the vault root from a vault-shaped index path, so originals are found', () => {
    // Vault-shaped layout: <root>/.memory-index/index.db with the content beside it.
    const root = mkdir('import-vault-shaped-');
    const dbPath = path.join(root, '.memory-index', 'index.db');
    const db = openDb(dbPath);
    runMigrations(db);
    db.prepare(
      `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
       VALUES ('_mcp_', 'lifecycle', 'system', 'synthetic', '2026-01-01T00:00:00.000Z', '{}')`,
    ).run();
    const notePath = path.join(root, 'Notes', 'a.md');
    write(notePath, '# A\n\nBody text here.\n');
    db.prepare(
      `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
       VALUES (?, 'A', NULL, ?, '2026-01-01T00:00:00.000Z', '{}')`,
    ).run(notePath, hashContent('# A\n\nBody text here.\n'));
    db.prepare(
      `INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
       VALUES (?, 'A', '# A\n\nBody text here.', 0, 3, 5, 'h')`,
    ).run(notePath);
    db.close();

    // No sourceRoot at all: `readSource` must derive the vault root from the index
    // path itself. The layout is deliberately non-trivial (the content sits beside the
    // index under a nested directory), so an index placed directly in the content root
    // could not make a missing default look like a working one.
    expect(dbPath.startsWith(root + path.sep)).toBe(true);
    const bundle = readSource(`renor-index:${dbPath}`, { include: [], exclude: [] });
    expect(bundle.notes).toHaveLength(1);
    expect(bundle.notes[0].relPath).toBe('Notes/a.md');
    expect(bundle.stats.notesWithOriginalBytes).toBe(1);

    // A wrong derivation would still return the note but silently reconstruct it, which
    // is the failure this test exists to catch.
    const wrongRoot = readRenorIndexSource({ ...ALL_NOTES, dbPath, sourceRoot: path.join(root, 'store') });
    expect(wrongRoot.stats.notesWithOriginalBytes).toBe(0);
  });
});

describe('memory import — facts carried as canonical events', () => {
  it('creates current lifecycle facts the dashboard reader can see, and skips a stream the destination holds', async () => {
    const source = buildSyntheticSource(NOTES);
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'primary_goal', object: 'durable memory', sourcePath: '_mcp_', validFrom: '2026-01-05T10:00:00.000Z' });
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'dog_name', object: 'Biscuit', sourcePath: '_mcp_', validFrom: '2026-01-01T10:00:00.000Z' });

    const destination = await buildDestination({ subject: 'Renor', predicate: 'dog_name', object: 'Biscuit', validFrom: '2026-01-09T00:00:00.000Z' });

    const bundle = readRenorIndexSource({
      ...ALL_NOTES,
      dbPath: source.dbPath,
      sourceRoot: source.sourceRoot,
      contentRoot: source.contentRoot,
    });
    const plan = buildImportPlan(bundle, {
      namespace: 'Imported/src',
      label: 'src',
      eventSource: 'import:src',
      // Read from the destination, so a mismatch between the code's key and what the
      // destination actually holds cannot hide behind a hand-written set.
      existingStreams: existingStreamsAt(destination.dbPath, destination.memoryDir),
    });
    // One event carried; the already-represented stream is skipped, not duplicated.
    expect(plan.events.map(e => e.predicate)).toEqual(['primary_goal']);
    expect(plan.skipped.events.some(s => /already represents/.test(s.reason))).toBe(true);

    return applyImportPlan(plan, bundle, destination).then(result => {
      expect(result.eventsAppended).toBe(1);
      expect(result.destination!.currentFacts).toBe(2);
      const db = new Database(destination.dbPath, { readonly: true });
      try {
        // The exact reader the dashboard's fact list and graph use.
        const rows = db.prepare(
          `SELECT e.canonical_name AS subject, f.predicate, f.object_text AS object
             FROM facts f JOIN entities e ON e.id = f.subject_entity_id
            WHERE f.valid_to IS NULL AND f.source_path = '_mcp_' ORDER BY f.predicate`,
        ).all() as Array<{ subject: string; predicate: string; object: string }>;
        expect(rows).toEqual([
          { subject: 'Renor', predicate: 'dog_name', object: 'Biscuit' },
          { subject: 'Renor', predicate: 'primary_goal', object: 'durable memory' },
        ]);
      } finally {
        db.close();
      }
    });
  });

  it('drops multi-valued streams with a counted reason instead of inventing a winner', () => {
    const source = buildSyntheticSource(NOTES);
    // Note-derived facts may legitimately be multi-valued (the engine scopes its
    // single-current index to lifecycle facts only), so the multi-valued case can only
    // come from a note.
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'tags', object: 'alpha', sourcePath: path.join(source.contentRoot, 'Projects/Alpha/plan.md'), validFrom: '2026-01-01T00:00:00.000Z' });
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'tags', object: 'beta', sourcePath: path.join(source.contentRoot, 'Projects/Alpha/plan.md'), validFrom: '2026-01-02T00:00:00.000Z' });
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'owner', object: 'Rowan', sourcePath: '_mcp_', validFrom: '2026-01-03T00:00:00.000Z' });

    const bundle = readRenorIndexSource({ ...ALL_NOTES, dbPath: source.dbPath, sourceRoot: source.sourceRoot, contentRoot: source.contentRoot });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    expect(plan.events.map(e => e.predicate)).toEqual(['owner']);
    expect(plan.counts.multiValuedFactsDropped).toBe(2);
    expect(plan.skipped.events[0].reason).toMatch(/multi-valued/);
  });

  it('derives the event id from every field replay compares, so a changed payload is a new event', () => {
    const base = { label: 'src', subject: 'Renor', predicate: 'goal', scope: 'global', at: '2026-01-01T00:00:00.000Z' };
    const a = deterministicEventId({ ...base, object: 'one' });
    const b = deterministicEventId({ ...base, object: 'two' });
    const c = deterministicEventId({ ...base, object: 'one', at: '2026-01-02T00:00:00.000Z' });
    const d = deterministicEventId({ ...base, object: 'one', label: 'other' });
    expect(a).toMatch(/^mem_[A-Za-z0-9]+$/);
    expect(new Set([a, b, c, d]).size).toBe(4);
    // Stable for the same payload — the property that makes a re-run a no-op.
    expect(deterministicEventId({ ...base, object: 'one' })).toBe(a);
  });

  it('rejects facts the lifecycle layer would reject, counting them by reason', () => {
    const source = buildSyntheticSource(NOTES);
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'owner', object: 'Rowan', sourcePath: '_mcp_', validFrom: 'not-a-date' });
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'state', object: 'ok', sourcePath: '_mcp_', validFrom: '2026-01-03T00:00:00.000Z', scope: '!!!' });
    const bundle = readRenorIndexSource({ ...ALL_NOTES, dbPath: source.dbPath, sourceRoot: source.sourceRoot, contentRoot: source.contentRoot });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    expect(plan.events).toHaveLength(0);
    expect(plan.skipped.events.map(s => s.reason).join(' ')).toMatch(/timestamp|scope/);
  });

  it('uses the engine scope rules and timestamp normalization', () => {
    expect(tryNormalizeScope('Sidebar Brand')).toBe('scope:sidebar-brand');
    expect(tryNormalizeScope('project:Recova')).toBe('project:recova');
    expect(tryNormalizeScope('!!!')).toBeNull();
    expect(toCanonicalInstant('2026-01-02T03:04:05Z')).toBe('2026-01-02T03:04:05.000Z');
    expect(toCanonicalInstant('2026-01-02T03:04:05.123Z')).toBe('2026-01-02T03:04:05.123Z');
    // A timezone-less datetime is ambiguous and the engine rejects it.
    expect(toCanonicalInstant('2026-01-02T03:04:05')).toBeNull();
  });
});

describe('memory import — apply is additive and idempotent', () => {
  it('writes notes, ledger and index rows, then a second run changes nothing', async () => {
    const source = buildSyntheticSource(NOTES);
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'primary_goal', object: 'durable memory', sourcePath: '_mcp_', validFrom: '2026-01-05T10:00:00.000Z' });
    const destination = await buildDestination();

    const bundle = readRenorIndexSource({
      ...ALL_NOTES,
      dbPath: source.dbPath,
      sourceRoot: source.sourceRoot,
      contentRoot: source.contentRoot,
      include: ['Projects/Alpha'],
    });
    const options = { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' };

    const first = await applyImportPlan(
      buildImportPlan(bundle, options),
      bundle,
      destination,
    );
    expect(first.notesWritten).toBe(2);
    expect(first.eventsAppended).toBe(1);
    expect(first.indexRows.chunksInserted).toBe(3);
    expect(first.indexRows.entitiesInserted).toBe(1);
    // 2 imported notes + the lifecycle sentinel row that replay creates; 2 imported
    // entities + the lifecycle entity for the carried fact's subject.
    expect(first.destination).toEqual({
      notes: 3, chunks: 3, entities: 2, facts: 1, currentFacts: 1, ftsRows: 3,
    });

    const afterFirst = countsAt(destination.dbPath);
    const ledgerAfterFirst = fs.readFileSync(path.join(destination.memoryDir, ...LEDGER.split('/')), 'utf8');

    const second = await applyImportPlan(buildImportPlan(bundle, options), bundle, destination);
    expect(second.notesWritten).toBe(0);
    expect(second.notesUnchanged).toBe(2);
    expect(second.eventsAppended).toBe(0);
    expect(second.eventsAlreadyPresent).toBe(1);
    expect(second.indexRows.chunksInserted).toBe(0);
    expect(second.indexRows.entitiesInserted).toBe(0);
    // The second run changes nothing the first run wrote.
    expect(countsAt(destination.dbPath)).toEqual(afterFirst);
    expect(second.destination).toEqual(first.destination);
    expect(fs.readFileSync(path.join(destination.memoryDir, ...LEDGER.split('/')), 'utf8')).toBe(ledgerAfterFirst);

    // The ledger grew by exactly one event across both runs.
    const ledger = fs.readFileSync(path.join(destination.memoryDir, ...LEDGER.split('/')), 'utf8');
    expect((ledger.match(/^## mem_/gm) ?? []).length).toBe(1);
  });

  it('sets note_hash to the hash of the exact bytes written, which is the skip condition', async () => {
    const source = buildSyntheticSource(NOTES);
    const destination = await buildDestination();
    const bundle = readRenorIndexSource({
      ...ALL_NOTES,
      dbPath: source.dbPath,
      sourceRoot: source.sourceRoot,
      contentRoot: source.contentRoot,
      include: ['Projects/Alpha/plan.md'],
    });
    await applyImportPlan(
      buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' }),
      bundle,
      destination,
    );

    const written = path.join(destination.memoryDir, 'Imported/src/Projects/Alpha/plan.md');
    const onDisk = fs.readFileSync(written, 'utf8');
    const db = new Database(destination.dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT note_hash FROM notes WHERE path = ?').get(written) as { note_hash: string };
      // This equality is exactly what makes indexVault skip the note (zero model calls),
      // so importing cannot trigger a re-chunk or a re-embedding later.
      expect(row.note_hash).toBe(hashContent(onDisk));
      expect(row.note_hash).toBe(hashContent(bundle.notes[0].originalContent!));
    } finally {
      db.close();
    }
  });

  it('never overwrites an existing note at the same path and reports the conflict', async () => {
    const source = buildSyntheticSource(NOTES);
    const destination = await buildDestination();
    const target = path.join(destination.memoryDir, 'Imported/src/Projects/Alpha/plan.md');
    write(target, '# Something the user wrote\n');

    const bundle = readRenorIndexSource({
      ...ALL_NOTES,
      dbPath: source.dbPath,
      sourceRoot: source.sourceRoot,
      contentRoot: source.contentRoot,
      include: ['Projects/Alpha/plan.md'],
    });
    const result = await applyImportPlan(
      buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' }),
      bundle,
      destination,
    );
    expect(result.notesConflicting).toBe(1);
    expect(result.notesWritten).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('# Something the user wrote\n');
  });

  it('canonical-only writes Markdown and the ledger without copying index rows', async () => {
    const source = buildSyntheticSource(NOTES);
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'primary_goal', object: 'durable memory', sourcePath: '_mcp_', validFrom: '2026-01-05T10:00:00.000Z' });
    const destination = await buildDestination();
    const bundle = readRenorIndexSource({
      ...ALL_NOTES,
      dbPath: source.dbPath,
      sourceRoot: source.sourceRoot,
      contentRoot: source.contentRoot,
      include: ['Projects/Alpha'],
    });
    const result = await applyImportPlan(
      buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' }),
      bundle,
      { ...destination, canonicalOnly: true },
    );
    expect(result.notesWritten).toBe(2);
    expect(result.indexRows.chunksInserted).toBe(0);
    expect(result.destination!.chunks).toBe(0);
    // The canonical layer still projects the fact, through the engine's own replay.
    expect(result.destination!.currentFacts).toBe(1);
    expect(fs.existsSync(path.join(destination.memoryDir, 'Imported/src/Projects/Alpha/plan.md'))).toBe(true);
  });

  it('recognizes a stream the destination LEDGER declares even with no current fact row', async () => {
    const source = buildSyntheticSource(NOTES);
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'dog_name', object: 'Biscuit', sourcePath: '_mcp_', validFrom: '2026-01-01T00:00:00.000Z' });
    const destination = await buildDestination();
    // Declared by the ledger but never projected into the index: the state right after a
    // hand-edited ledger, or after a replay that has not run yet.
    await appendLedgerEvent(destination.memoryDir, LEDGER, {
      id: 'mem_ledgeronly1', at: '2026-01-09T00:00:00.000Z', kind: 'store',
      subject: 'Renor', predicate: 'dog_name', object: 'Biscuit', closedEvent: null, source: 'fixture', scope: 'global',
    });
    expect(countsAt(destination.dbPath).currentLifecycleFacts).toBe(0);

    // Index-only knowledge would miss this stream entirely.
    const streams = readExistingStreams(destination.dbPath, path.join(destination.memoryDir, ...LEDGER.split('/')));
    expect(streams.has(streamKey('Renor', 'dog_name', 'global'))).toBe(true);

    const bundle = readRenorIndexSource({ ...ALL_NOTES, dbPath: source.dbPath, sourceRoot: source.sourceRoot, contentRoot: source.contentRoot });
    const plan = buildImportPlan(bundle, {
      namespace: 'Imported/src', label: 'src', eventSource: 'import:src', existingStreams: streams,
    });
    expect(plan.events).toHaveLength(0);
    expect(plan.skipped.events.some(s => /already represents/.test(s.reason))).toBe(true);
  });

  it('rolls the whole projection back when a carried event is rejected mid-replay', async () => {
    // Two carried events: the first applies (a new stream), the second is older than what
    // the destination already declares. The rejection lands after the first event has been
    // committed by the engine's per-event transaction, so this is the case where a naive
    // rollback would leave a fact whose ledger event no longer exists — which the engine's
    // startup preflight refuses to serve.
    const source = buildSyntheticSource(NOTES);
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'aa_new_stream', object: 'fresh', sourcePath: '_mcp_', validFrom: '2026-01-05T00:00:00.000Z' });
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'zz_contested', object: 'old value', sourcePath: '_mcp_', validFrom: '2026-01-01T00:00:00.000Z' });
    const destination = await buildDestination({ subject: 'Renor', predicate: 'zz_contested', object: 'newer value', validFrom: '2026-01-09T00:00:00.000Z' });
    const ledgerPath = path.join(destination.memoryDir, ...LEDGER.split('/'));
    const ledgerBefore = fs.readFileSync(ledgerPath, 'utf8');
    const factsBefore = countsAt(destination.dbPath);

    const bundle = readRenorIndexSource({ ...ALL_NOTES, dbPath: source.dbPath, sourceRoot: source.sourceRoot, contentRoot: source.contentRoot });

    // Forced through without the ledger-aware skip, so the plan really carries both.
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    expect(plan.events.map(e => e.predicate)).toEqual(['aa_new_stream', 'zz_contested']);

    await expect(applyImportPlan(plan, bundle, destination)).rejects.toThrow(/rolled back/);

    // Ledger restored exactly, and NOTHING projected — not even the event that succeeded.
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore);
    expect(countsAt(destination.dbPath)).toEqual(factsBefore);

    // And the destination still passes the plain startup path afterwards.
    const db = openDb(destination.dbPath);
    try {
      await expect(replayLedger(db, destination.memoryDir, LEDGER)).resolves.toBe(0);
      // Every event-backed lifecycle row must be explainable by the LEDGER — the
      // authority — never by the projection that is being checked.
      const ledgerEventIds = new Set(
        parseLedgerEvents(fs.readFileSync(ledgerPath, 'utf8')).map(e => e.id.toUpperCase()),
      );
      const projected = (db.prepare(
        `SELECT DISTINCT event_id FROM facts WHERE event_id IS NOT NULL AND source_path = '_mcp_'`,
      ).all() as Array<{ event_id: string }>).map(r => r.event_id.toUpperCase());
      expect(projected.filter(id => !ledgerEventIds.has(id))).toEqual([]);
      const stray = db.prepare(`SELECT count(*) AS c FROM facts WHERE predicate = 'aa_new_stream'`).get() as { c: number };
      expect(stray.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it('replays cleanly on a scratch copy — the rehearsal the startup gate needs', async () => {
    const source = buildSyntheticSource(NOTES);
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'primary_goal', object: 'durable memory', sourcePath: '_mcp_', validFrom: '2026-01-05T10:00:00.000Z' });
    const destination = await buildDestination({ subject: 'Renor', predicate: 'dog_name', object: 'Biscuit', validFrom: '2026-01-09T00:00:00.000Z' });

    const bundle = readRenorIndexSource({ ...ALL_NOTES, dbPath: source.dbPath, sourceRoot: source.sourceRoot, contentRoot: source.contentRoot });
    await applyImportPlan(
      buildImportPlan(bundle, {
        namespace: 'Imported/src',
        label: 'src',
        eventSource: 'import:src',
        existingStreams: existingStreamsAt(destination.dbPath, destination.memoryDir),
      }),
      bundle,
      destination,
    );

    // A copy of the destination, replayed from its own ledger: this is what the service
    // does at startup, and a rejection there is a readiness failure rather than a
    // skipped import row.
    const copy = await buildDestination();
    const copyLedger = path.join(destination.memoryDir, ...LEDGER.split('/'));
    write(path.join(copy.memoryDir, ...LEDGER.split('/')), fs.readFileSync(copyLedger, 'utf8'));
    const db = openDb(copy.dbPath);
    try {
      // The copy's ledger holds the seeded event plus the one the import carried.
      const applied = await replayLedger(db, copy.memoryDir, LEDGER);
      expect(applied).toBe(2);
      expect(factsFor(db, 'Renor')).toHaveLength(2);
      // Replaying twice is a no-op, not a duplicate.
      const again = await replayLedger(db, copy.memoryDir, LEDGER);
      expect(again).toBe(0);
      expect(factsFor(db, 'Renor')).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

describe('memory import — the bundle format', () => {
  it('reads a renor-memory-export/v1 bundle, so any provider can produce the input', () => {
    const dir = mkdir('import-bundle-');
    const file = path.join(dir, 'export.jsonl');
    const lines = [
      JSON.stringify({ type: 'meta', format: 'renor-memory-export/v1', source: 'other-provider' }),
      JSON.stringify({
        type: 'note',
        path: 'Notes/a.md',
        relPath: 'Notes/a.md',
        title: 'A',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        frontmatter: { tags: ['x'] },
        chunks: [{ headingPath: 'A', text: '# A\n\nBody.', tokenCount: 3 }],
        entities: [{ type: 'note', canonicalName: 'A', aliases: [] }],
      }),
      JSON.stringify({
        type: 'fact',
        subject: 'Rowan',
        predicate: 'lives_in',
        object: 'Brazil',
        scope: 'global',
        validFrom: '2026-01-01T00:00:00.000Z',
      }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const bundle = readBundleSource(file);
    expect(bundle.sourceLabel).toBe('other-provider');
    expect(bundle.notes).toHaveLength(1);
    expect(bundle.facts).toHaveLength(1);
    expect(bundle.notes[0].entities[0].canonicalName).toBe('A');

    const plan = buildImportPlan(bundle, { namespace: 'Imported/other-provider', label: 'other-provider', eventSource: 'import:other-provider' });
    expect(plan.counts.selectedNotes).toBe(1);
    expect(plan.counts.eventsToAppend).toBe(1);
    expect(plan.counts.notesReconstructed).toBe(1);
  });

  it('rejects an unknown bundle format and unparseable lines', () => {
    const dir = mkdir('import-bundle-bad-');
    const bad = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(bad, JSON.stringify({ type: 'meta', format: 'someone-elses/v9' }) + '\n', 'utf8');
    expect(() => readBundleSource(bad)).toThrow(/unsupported bundle format/);

    const broken = path.join(dir, 'broken.jsonl');
    fs.writeFileSync(broken, '{not json}\n', 'utf8');
    expect(() => readBundleSource(broken)).toThrow(/not valid JSON/);
  });
});

describe('memory import — CLI', () => {
  it('plans without writing, applies on --apply, and reports counts only', async () => {
    const source = buildSyntheticSource(NOTES);
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'primary_goal', object: 'durable memory', sourcePath: '_mcp_', validFrom: '2026-01-05T10:00:00.000Z' });
    const destination = await buildDestination();

    const argv = [
      '--from', `renor-index:${source.dbPath}`,
      '--source-root', source.sourceRoot,
      '--content-root', source.contentRoot,
      '--to', destination.memoryDir,
      '--include', 'Projects/Alpha',
      '--namespace', 'Imported/src',
      '--json',
    ];

    const planExit = await runCli(argv);
    expect(planExit).toBe(0);
    expect(countsAt(destination.dbPath).notes).toBe(0);
    expect(fs.existsSync(path.join(destination.memoryDir, 'Imported'))).toBe(false);

    const applyExit = await runCli([...argv, '--apply']);
    expect(applyExit).toBe(0);
    const after = countsAt(destination.dbPath);
    // 2 imported notes + the lifecycle sentinel row replay creates.
    expect(after.notes).toBe(3);
    expect(after.chunks).toBe(3);
    expect(after.currentLifecycleFacts).toBe(1);
  });

  it('fails loudly on a missing argument instead of importing something', async () => {
    expect(await runCli(['--from', 'renor-index:/nonexistent/index.db'])).toBe(2);
    expect(await runCli(['--to', '/tmp/whatever'])).toBe(2);
    expect(await runCli(['--from', 'nonsense:/tmp/x', '--to', '/tmp/y'])).toBe(1);
  });

  it('a second --apply run reports the same workspace counts', async () => {
    const source = buildSyntheticSource(NOTES);
    const destination = await buildDestination();
    const argv = [
      '--from', `renor-index:${source.dbPath}`,
      '--source-root', source.sourceRoot,
      '--content-root', source.contentRoot,
      '--to', destination.memoryDir,
      '--include', 'Projects/Alpha',
      '--apply',
      '--json',
    ];
    expect(await runCli(argv)).toBe(0);
    const first = countsAt(destination.dbPath);
    expect(await runCli(argv)).toBe(0);
    expect(countsAt(destination.dbPath)).toEqual(first);
  });
});
