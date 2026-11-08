import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import type Database from '../../src/db/sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { loadMvpConfig, DEFAULT_LEDGER_REL, type MvpConfig } from '../../src/mvp/config';
import { MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { freePort, startMvpServiceOnFreePort } from '../helpers/mvpPort';
import {
  attachEngine,
  engineIndex,
  engineIndexChanged,
  engineRememberNote,
  engineSearchMemory,
  engineSearchText,
  FULL_VAULT_CHECK_MS,
  TIMESTAMP_TICK_MS,
  type Engine,
} from '../../src/mvp/engine';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { remember, replayLedger, resolveLedgerPath } from '../../src/memory/lifecycle';
import { buildMemoryMap, restoreMemory, retireMemory, type MemoryMapContext } from '../../src/memorymap/memoryMap';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Saving a note must cost what changed, not what the workspace holds. A note-mode save used to
 * read and hash every file in the memory directory on every call, so latency grew with every note.
 * It now stats every file and reads only those that changed since this process last reconciled them
 * (all of them, once, on its first save), indexing the changed files at the same time; and a ledger
 * that fact-mode saves keep appending to is indexed by what is new in it, not whole (see
 * tests/indexer/pipeline-incremental-chunks.test.ts). These tests pin both halves: the work is
 * bounded (reads, embeddings), and the index a save leaves behind is the one a full pass over the
 * same files produces, including for edits, new files, renames and deletes made outside the engine,
 * and for an edit that leaves a file's size and modification time as they were. A file's stamp is its
 * modification time, change time, size and inode, and a file changed within a clock tick of a scan is not
 * trusted by it, so the tests that count reads scan from a minute after their files were written (as a
 * real vault's files are older than a tick) and the tick rule is pinned on its own.
 * Synthetic notes only.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const tmpDirs: string[] = [];
const services: Array<MvpApp & { httpServer: import('http').Server }> = [];
const dbs: Database.Database[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
    await s.close();
  }
  while (dbs.length) dbs.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.RENOR_NEWEST_FIRST;
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Lets what a test wrote age past a timestamp tick without waiting for the tick: the clock the engine reads moves
 * forward (the files keep the times the file system gave them) and goes on running. A real wait here was
 * TIMESTAMP_TICK_MS of idle time in a test that has five seconds. `useRealTimers` puts the clock back.
 */
function agePastATick(writtenAt: number): void {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(Math.max(Date.now(), writtenAt + TIMESTAMP_TICK_MS + 100));
}

/** The repo's deterministic hash embeddings (no model), counting what they are asked to embed. */
class StubProvider extends EvalHashEmbeddingProvider {
  texts: string[] = [];
  failNext = 0;
  async embed(texts: string[]): Promise<number[][]> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('synthetic embedding outage');
    }
    this.texts.push(...texts);
    return super.embed(texts);
  }
}

function writeNote(memoryDir: string, rel: string, content: string) {
  const abs = path.join(memoryDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function seedNotes(memoryDir: string, count: number) {
  for (let i = 0; i < count; i++) {
    writeNote(
      memoryDir,
      `Notes/topic-${String(i).padStart(3, '0')}.md`,
      `---\ntags: [seed]\n---\n# Topic ${i}\n\nSeed note ${i} about gateway tenants and deploys. See [[topic-${String((i + 1) % count).padStart(3, '0')}]].\n`,
    );
  }
}

interface Workspace {
  memoryDir: string;
  config: MvpConfig;
  db: Database.Database;
  engine: Engine;
  provider: StubProvider;
  ctx: MemoryMapContext;
}

async function workspace(notes: number, seedFiles?: (memoryDir: string) => void): Promise<Workspace> {
  const memoryDir = tmp('note-save-');
  seedNotes(memoryDir, notes);
  seedFiles?.(memoryDir);
  const config = { memoryDir, ledgerRelPath: DEFAULT_LEDGER_REL } as MvpConfig;
  const db = openDb(path.join(tmp('note-save-db-'), 'index.db'));
  dbs.push(db);
  runMigrations(db);
  const provider = new StubProvider();
  const engine = attachEngine(db, { embeddingProvider: 'none' } as MvpConfig, provider);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await engineIndex(db, config, engine);
  log.mockRestore();
  provider.texts = [];
  const ctx: MemoryMapContext = {
    db,
    memoryDir,
    ledgerRelPath: DEFAULT_LEDGER_REL,
    indexOptions: { embeddingProvider: provider, vectorIndex: engine.vectorIndex! },
  };
  return { memoryDir, config, db, engine, provider, ctx };
}

/**
 * When a scan starts if it starts a minute after everything the test wrote: the files are then far outside the
 * clock tick a stamp cannot be trusted within, as a real vault's files are.
 */
const aMinuteLater = () => Date.now() + 60_000;

/**
 * What `remember` does in note mode (server.ts indexSavedNote): append, then check the day's note and the ledger, the
 * two files a note save writes. The vault is not walked within FULL_VAULT_CHECK_MS of its last full check, so an edit
 * made outside the engine is not seen then (index_memory is, and so is a save that comes after that window).
 */
async function saveNote(ws: Workspace, text: string, date?: string, scanStart = aMinuteLater()) {
  const note = await engineRememberNote(ws.config, text, date, 'test');
  return engineIndexChanged(ws.db, ws.config, ws.engine, scanStart, {
    touched: [path.join(ws.memoryDir, note.file), resolveLedgerPath(ws.memoryDir, DEFAULT_LEDGER_REL)],
  });
}

/**
 * A full scan: what a search or background job finishes with, and the first pass of a process. It walks the vault and
 * checks every file's stamp, so it sees an edit, rename or delete made outside the engine; a save does not (see below).
 */
function fullScan(ws: Workspace, scanStart = aMinuteLater()) {
  return engineIndexChanged(ws.db, ws.config, ws.engine, scanStart);
}

function fts(ws: Workspace, term: string) {
  return (engineSearchText(ws.db, ws.memoryDir, term, 50) as { results: Array<{ notePath: string }> }).results;
}

/**
 * The note-derived index, order-free: the same whichever way it was built. Left out on purpose:
 * the `_mcp_` lifecycle pseudo-note (only a database that ran `remember` holds it) and wikilink
 * relations, which resolve only to notes already indexed, so even two full passes can differ.
 */
function indexSnapshot(db: Database.Database, vectors: boolean) {
  const rows = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
  const chunks = rows('SELECT note_path, heading_path, text, start_line, end_line, token_count, chunk_hash FROM chunks')
    .map((r) => JSON.stringify(r)).sort();
  const snapshot = {
    notes: rows("SELECT path, title, kind, note_hash, frontmatter_json FROM notes WHERE path != '_mcp_'").map((r) => JSON.stringify(r)).sort(),
    chunks,
    entities: rows("SELECT type, canonical_name, aliases_json, source_note FROM entities WHERE source_note != '_mcp_'")
      .map((r) => JSON.stringify(r)).sort(),
    facts: rows("SELECT predicate, object_text, source_path FROM facts WHERE source_path != '_mcp_'")
      .map((r) => JSON.stringify(r)).sort(),
    vectorCount: (db.prepare('SELECT COUNT(*) c FROM chunk_embeddings').get() as { c: number }).c,
  };
  if (!vectors) delete (snapshot as Partial<typeof snapshot>).vectorCount;
  return snapshot;
}

/** Every chunk's stored vector is the embedding of the chunk's current text. */
async function vectorsMatchText(ws: Workspace): Promise<boolean> {
  const chunks = ws.db.prepare('SELECT id, text FROM chunks').all() as Array<{ id: number; text: string }>;
  const wanted = await new EvalHashEmbeddingProvider().embed(chunks.map((c) => c.text));
  return chunks.every((c, i) => {
    const stored = ws.engine.vectorIndex!.get(c.id);
    return !!stored && stored.every((x, j) => Math.abs(x - wanted[i][j]) < 1e-5);
  });
}

/** A full `indexVault` pass over the index a save left behind changes nothing: the save already saw what it would. */
async function expectFullPassToFindNothing(ws: Workspace) {
  const before = indexSnapshot(ws.db, true);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stats = await engineIndex(ws.db, ws.config, ws.engine);
  log.mockRestore();
  expect(stats.errors).toBe(0);
  expect(indexSnapshot(ws.db, true)).toEqual(before);
  expect(await vectorsMatchText(ws)).toBe(true);
}

const notesDir = (ws: Workspace, name: string) => path.join(ws.memoryDir, 'Notes', name);

describe('a note save sees what happened to the vault outside the engine, as a full pass does', () => {
  // Each save here is made more than FULL_VAULT_CHECK_MS after the previous check, so it walks the vault: these tests pin what
  // a save sees, as they did before the window. The clock is faked, so the window holds without waiting for it.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  async function saveNote(ws: Workspace, text: string, date?: string, scanStart = aMinuteLater()) {
    vi.setSystemTime(Date.now() + FULL_VAULT_CHECK_MS + 1_000);
    const note = await engineRememberNote(ws.config, text, date, 'test');
    return engineIndexChanged(ws.db, ws.config, ws.engine, scanStart, {
      touched: [path.join(ws.memoryDir, note.file), resolveLedgerPath(ws.memoryDir, DEFAULT_LEDGER_REL)],
    });
  }
  it('an edit to another note is searchable after the next save, and the old text is gone', async () => {
    const ws = await workspace(8);
    await saveNote(ws, 'First save: the engine now knows every file.');
    expect(fts(ws, 'zebrafish')).toHaveLength(0);
    expect(fts(ws, 'Seed note 2 ').map((h) => h.notePath)).toEqual([path.join('Notes', 'topic-002.md')]);

    fs.writeFileSync(notesDir(ws, 'topic-002.md'), '# Topic 2\n\nA note about zebrafish migrations.\n');
    await saveNote(ws, 'Second save, after an edit made outside the engine.');
    expect(fts(ws, 'zebrafish').map((h) => h.notePath)).toEqual([notesDir(ws, 'topic-002.md')].map((f) => path.relative(ws.memoryDir, f)));
    expect(fts(ws, 'Seed note 2 ')).toHaveLength(0);
    expect(await vectorsMatchText(ws)).toBe(true);
    await expectFullPassToFindNothing(ws);
  });

  it('a new file is indexed by the next save', async () => {
    const ws = await workspace(5);
    await saveNote(ws, 'First save.');
    fs.writeFileSync(notesDir(ws, 'brand-new.md'), '# Brand new\n\nA note about narwhals.\n');
    await saveNote(ws, 'Second save.');
    expect(fts(ws, 'narwhals')).toHaveLength(1);
    await expectFullPassToFindNothing(ws);
  });

  it('a renamed note is found under its new path by the next save, as a full pass would find it', async () => {
    const ws = await workspace(5);
    await saveNote(ws, 'First save.');
    expect(fts(ws, 'Seed note 3 ').map((h) => h.notePath)).toEqual([path.join('Notes', 'topic-003.md')]);
    fs.renameSync(notesDir(ws, 'topic-003.md'), notesDir(ws, 'renamed-quokka.md'));
    const saved = await saveNote(ws, 'Second save, after a rename made outside the engine.');
    expect(saved.errors).toBe(0);
    expect(fts(ws, 'Seed note 3 ').map((h) => h.notePath)).toContain(path.join('Notes', 'renamed-quokka.md'));
    await expectFullPassToFindNothing(ws);
  });

  it('a deleted note makes the save neither fail nor change anything, as with a full pass (its rows stay until removed)', async () => {
    const ws = await workspace(5);
    await saveNote(ws, 'First save.');
    fs.unlinkSync(notesDir(ws, 'topic-004.md'));
    const saved = await saveNote(ws, 'Second save, after a delete made outside the engine.');
    expect(saved.errors).toBe(0);
    await expectFullPassToFindNothing(ws);
  });

  it('the first save in a process verifies every file once, and the next reads only what changed', async () => {
    const ws = await workspace(20);
    const reads = async (run: () => Promise<unknown>) => {
      const spy = vi.spyOn(fsp, 'readFile');
      await run();
      const read = spy.mock.calls.map((c) => String(c[0])).filter((p) => p.endsWith('.md'));
      spy.mockRestore();
      return read;
    };
    const first = await reads(() => saveNote(ws, 'First save.'));
    expect(first.filter((p) => p.includes('topic-'))).toHaveLength(20);

    fs.writeFileSync(notesDir(ws, 'topic-005.md'), '# Topic 5\n\nEdited outside the engine.\n');
    const second = await reads(() => saveNote(ws, 'Second save.'));
    expect(second.filter((p) => p.includes('topic-')).map((p) => path.basename(p))).toEqual(['topic-005.md']);

    const third = await reads(() => saveNote(ws, 'Third save.'));
    expect(third.some((p) => p.includes('topic-'))).toBe(false); // the edited file is reconciled and not read again
  });

  it('an edit that keeps the file\'s modification time is still seen, by its size', async () => {
    const ws = await workspace(5);
    const file = notesDir(ws, 'topic-002.md');
    const whole = new Date('2026-01-01T00:00:00Z'); // a whole second, so the same time can be put back exactly
    fs.utimesSync(file, whole, whole);
    const mtimeMs = fs.statSync(file).mtimeMs;
    await saveNote(ws, 'First save.'); // reconciles the file at this time and size
    fs.writeFileSync(file, '# Topic 2\n\nA much longer note about axolotls and their habitats.\n');
    fs.utimesSync(file, whole, whole);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeMs); // only the size differs now
    await saveNote(ws, 'Second save.');
    expect(fts(ws, 'axolotls')).toHaveLength(1);
  });

  // The review's case: a rewrite of the same length with the modification time put back (rsync -t, cp -p,
  // a sync client, an editor that restores it). Size and modification time say nothing changed.
  const ALPHA = '# Note\n\nalpha codeword.\n';
  const BRAVO = '# Note\n\nbravo codeword.\n'; // as long as ALPHA
  const WHOLE_SECOND = new Date('2026-01-01T00:00:00Z'); // so the same time can be put back exactly
  const withAlphaNote = (ws: Workspace) => {
    const file = notesDir(ws, 'topic-002.md');
    fs.utimesSync(file, WHOLE_SECOND, WHOLE_SECOND);
    return { file, before: fs.statSync(file) };
  };

  it('an equal-length edit that puts the modification time back is seen by the next save, as a save runs it', async () => {
    const ws = await workspace(5, (dir) => writeNote(dir, 'Notes/topic-002.md', ALPHA));
    const { file, before } = withAlphaNote(ws);
    await saveNote(ws, 'First save.', undefined, Date.now());
    expect(fts(ws, 'alpha')).toHaveLength(1);

    fs.writeFileSync(file, BRAVO);
    fs.utimesSync(file, WHOLE_SECOND, WHOLE_SECOND);
    const after = fs.statSync(file);
    expect({ mtimeMs: after.mtimeMs, size: after.size }).toEqual({ mtimeMs: before.mtimeMs, size: before.size });
    await saveNote(ws, 'Second save.', undefined, Date.now());
    expect(fts(ws, 'bravo')).toHaveLength(1);
    expect(fts(ws, 'alpha')).toHaveLength(0);
    await expectFullPassToFindNothing(ws);
  });

  it('...and when the file is old enough to be trusted by its stamp, the stamp shows it: the change time moved', async () => {
    const ws = await workspace(5, (dir) => writeNote(dir, 'Notes/topic-002.md', ALPHA));
    const { file, before } = withAlphaNote(ws);
    await saveNote(ws, 'First save.'); // from a minute later: the file is old, so its stamp is recorded and trusted
    await new Promise((resolve) => setTimeout(resolve, 50)); // the rewrite's change time falls in a later clock tick

    fs.writeFileSync(file, BRAVO);
    fs.utimesSync(file, WHOLE_SECOND, WHOLE_SECOND);
    const after = fs.statSync(file);
    expect({ mtimeMs: after.mtimeMs, size: after.size, ino: after.ino }).toEqual({ mtimeMs: before.mtimeMs, size: before.size, ino: before.ino });
    expect(after.ctimeMs).toBeGreaterThan(before.ctimeMs);
    await saveNote(ws, 'Second save.');
    expect(fts(ws, 'bravo')).toHaveLength(1);
    expect(fts(ws, 'alpha')).toHaveLength(0);
    await expectFullPassToFindNothing(ws);
  });

  it('a file replaced by another of the same size and modification time, as an editor\'s atomic save does, is seen', async () => {
    const ws = await workspace(5, (dir) => writeNote(dir, 'Notes/topic-002.md', ALPHA));
    const { file, before } = withAlphaNote(ws);
    await saveNote(ws, 'First save.');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const incoming = path.join(ws.memoryDir, 'incoming.tmp');
    fs.writeFileSync(incoming, BRAVO);
    fs.utimesSync(incoming, WHOLE_SECOND, WHOLE_SECOND);
    fs.renameSync(incoming, file);
    const after = fs.statSync(file);
    expect({ mtimeMs: after.mtimeMs, size: after.size }).toEqual({ mtimeMs: before.mtimeMs, size: before.size });
    expect(after.ino).not.toBe(before.ino);
    await saveNote(ws, 'Second save.');
    expect(fts(ws, 'bravo')).toHaveLength(1);
    expect(fts(ws, 'alpha')).toHaveLength(0);
    await expectFullPassToFindNothing(ws);
  });

  it('a file whose rows were dropped from the index is indexed again by the next save, though it has not changed', async () => {
    const ws = await workspace(5);
    await saveNote(ws, 'First save.');
    ws.db.prepare('DELETE FROM notes WHERE path = ?').run(notesDir(ws, 'topic-001.md')); // as retiring a note does
    expect(fts(ws, 'Seed note 1 ')).toHaveLength(0);
    await saveNote(ws, 'Second save.');
    expect(fts(ws, 'Seed note 1 ')).toHaveLength(1);
  });

  it('what has not changed is not read again: a file touched without a change is verified once, then left alone', async () => {
    const ws = await workspace(6);
    await saveNote(ws, 'First save.');
    const file = notesDir(ws, 'topic-001.md');
    const yesterday = new Date(Date.now() - 86_400_000);
    fs.utimesSync(file, yesterday, yesterday); // a touch: same bytes, new modification time
    const spy = vi.spyOn(fsp, 'readFile');
    await saveNote(ws, 'Second save.');
    await saveNote(ws, 'Third save.');
    const reads = spy.mock.calls.map((c) => String(c[0])).filter((p) => p === file);
    spy.mockRestore();
    expect(reads).toHaveLength(1);
    await expectFullPassToFindNothing(ws);
  });
});

describe('a note save checks the files it wrote, not the vault', () => {
  // The clock is frozen, so every save is inside FULL_VAULT_CHECK_MS of the last full check unless a test moves it on.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('within FULL_VAULT_CHECK_MS an edit made outside the engine is not seen by a save; index_memory (a full pass) sees it', async () => {
    const ws = await workspace(8);
    await saveNote(ws, 'First save.');
    fs.writeFileSync(notesDir(ws, 'topic-002.md'), '# Topic 2\n\nA note about zebrafish migrations.\n');
    await saveNote(ws, 'Second save, after an edit made outside the engine.');
    expect(fts(ws, 'zebrafish')).toHaveLength(0);
    expect(fts(ws, 'Seed note 2 ').map((h) => h.notePath)).toEqual([path.join('Notes', 'topic-002.md')]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await engineIndex(ws.db, ws.config, ws.engine);
    log.mockRestore();
    expect(fts(ws, 'zebrafish').map((h) => h.notePath)).toEqual([path.join('Notes', 'topic-002.md')]);
    expect(fts(ws, 'Seed note 2 ')).toHaveLength(0);
    await expectFullPassToFindNothing(ws);
  });

  it('a save more than FULL_VAULT_CHECK_MS after the last full check walks the vault and sees the edit', async () => {
    const ws = await workspace(40);
    await saveNote(ws, 'First save, which walks the vault.');
    fs.writeFileSync(notesDir(ws, 'topic-002.md'), '# Topic 2\n\nA note about zebrafish migrations.\n');
    vi.setSystemTime(Date.now() + FULL_VAULT_CHECK_MS - 1_000);
    await saveNote(ws, 'A save just inside the window.');
    expect(fts(ws, 'zebrafish')).toHaveLength(0);

    vi.setSystemTime(Date.now() + 2_000);
    const stat = vi.spyOn(fs, 'statSync');
    await saveNote(ws, 'A save just outside the window.');
    const statCalls = stat.mock.calls.length;
    stat.mockRestore();
    expect(statCalls).toBeGreaterThanOrEqual(40); // the walk stats every note
    expect(fts(ws, 'zebrafish').map((h) => h.notePath)).toEqual([path.join('Notes', 'topic-002.md')]);
  });

  it('a clock that steps back is not a recent check: the next save walks the vault and sees the edit', async () => {
    const ws = await workspace(30);
    await saveNote(ws, 'First save, which walks the vault.');
    vi.setSystemTime(Date.now() + 5_000);
    await saveNote(ws, 'A save five seconds later, inside the window.');
    fs.writeFileSync(notesDir(ws, 'topic-003.md'), '# Topic 3\n\nA note about zebrafish migrations.\n');
    vi.setSystemTime(Date.now() - 20_000); // before the last check: not an age the window can vouch for
    await saveNote(ws, 'A save after the clock stepped back.');
    expect(fts(ws, 'zebrafish').map((h) => h.notePath)).toEqual([path.join('Notes', 'topic-003.md')]);
  });

  it('on a 500-note vault a save stats two files and never loads the list of note paths', async () => {
    const ws = await workspace(500);
    await saveNote(ws, 'The first save in a process walks the vault (pinned above).');
    // The row-count precondition: the query a save must not run returns every note, so its absence means something.
    const indexed = ws.db.prepare("SELECT COUNT(*) AS c FROM notes WHERE note_hash != ''").pluck().get() as number;
    expect(indexed).toBeGreaterThanOrEqual(500);

    const note = await engineRememberNote(ws.config, 'A note saved in a 500-note vault.', undefined, 'test');
    const stat = vi.spyOn(fs, 'statSync');
    const prepare = vi.spyOn(ws.db, 'prepare');
    const pass = await engineIndexChanged(ws.db, ws.config, ws.engine, aMinuteLater(), {
      touched: [path.join(ws.memoryDir, note.file), resolveLedgerPath(ws.memoryDir, DEFAULT_LEDGER_REL)],
    });
    const statCalls = stat.mock.calls.length;
    const pathListQueries = prepare.mock.calls.filter(([sql]) => String(sql).includes("SELECT path FROM notes WHERE note_hash != ''"));
    stat.mockRestore();
    prepare.mockRestore();

    expect(pathListQueries).toHaveLength(0);
    expect(statCalls).toBeLessThanOrEqual(2); // the day's note and the ledger, whatever the vault holds
    expect(pass).toMatchObject({ errors: 0 });
    expect(fts(ws, 'A note saved in a 500-note vault')).toHaveLength(1);
  });
});

describe('what a file\'s stamp is made of, and when a scan may trust it', () => {
  type Stat = { mtimeMs: number; ctimeMs: number; size: number; ino: number };
  const T = Date.parse('2026-01-01T00:00:00Z');
  const DAY = 86_400_000;
  /** A stat that is old on every count: the scan below trusts it. */
  const stat = (over: Partial<Stat> = {}): Stat => ({ mtimeMs: T, ctimeMs: T + DAY, size: 24, ino: 4242, ...over });

  /**
   * Scan twice, the second time over different bytes of the same length, showing the walk the stats this test
   * says instead of the file's own: whether the second scan sees the new bytes then depends on nothing but
   * the stat it was shown and how near its start was to the file's times.
   */
  async function seesRewrite(first: Stat, second: Stat, scanStart: number): Promise<boolean> {
    const ws = await workspace(3, (dir) => writeNote(dir, 'Notes/topic-001.md', '# Note\n\nalpha codeword.\n'));
    const file = notesDir(ws, 'topic-001.md');
    const real = fs.statSync;
    let shown = first;
    vi.spyOn(fs, 'statSync').mockImplementation(((p: unknown, ...rest: unknown[]) =>
      String(p) === file ? { ...shown } : (real as (...a: unknown[]) => unknown)(p, ...rest)) as typeof fs.statSync);
    await fullScan(ws, scanStart);
    fs.writeFileSync(file, '# Note\n\nbravo codeword.\n');
    shown = second;
    await fullScan(ws, scanStart);
    return fts(ws, 'bravo').length === 1;
  }

  const aged = () => aMinuteLater();
  it.each([
    ['an identical stat on an old file is trusted: the next scan does not read it', stat(), stat(), aged, false],
    ['a different modification time', stat(), stat({ mtimeMs: T + 1_000 }), aged, true],
    ['a different change time', stat(), stat({ ctimeMs: T + 2 * DAY }), aged, true],
    ['a different size', stat(), stat({ size: 25 }), aged, true],
    ['a different inode', stat(), stat({ ino: 4243 }), aged, true],
    // Within a tick of the scan a second write could leave the stat as it was, so the stat vouches for nothing.
    ['an identical stat, modified within a tick of the scan', stat({ mtimeMs: T }), stat({ mtimeMs: T }), () => T + 500, true],
    ['an identical stat, changed within a tick of the scan (modified long before)', stat({ mtimeMs: T - DAY, ctimeMs: T }), stat({ mtimeMs: T - DAY, ctimeMs: T }), () => T + 500, true],
    ['an identical stat whose times are exactly a tick before the scan is trusted', stat({ mtimeMs: T, ctimeMs: T }), stat({ mtimeMs: T, ctimeMs: T }), () => T + TIMESTAMP_TICK_MS, false],
    ['...and one millisecond nearer is not', stat({ mtimeMs: T, ctimeMs: T }), stat({ mtimeMs: T, ctimeMs: T }), () => T + TIMESTAMP_TICK_MS - 1, true],
    ['a time a little ahead of the scan (a clock that runs fast) counts as near', stat({ mtimeMs: T + 500 }), stat({ mtimeMs: T + 500 }), () => T, true],
    ['a time far ahead of the scan is no nearer than one far behind', stat({ mtimeMs: T + 60_000, ctimeMs: T + 60_000 }), stat({ mtimeMs: T + 60_000, ctimeMs: T + 60_000 }), () => T, false],
    ['a stat that failed (no times, size -1) is never trusted', stat({ mtimeMs: NaN, ctimeMs: NaN, size: -1, ino: -1 }), stat({ mtimeMs: NaN, ctimeMs: NaN, size: -1, ino: -1 }), aged, true],
  ] as Array<[string, Stat, Stat, () => number, boolean]>)('%s', async (_name, first, second, scanStart, seen) => {
    expect(await seesRewrite(first, second, scanStart())).toBe(seen);
  });

  it('a file changed within a clock tick of a scan is read again by the next scan, and once it is older it is read no more', async () => {
    const ws = await workspace(4);
    const file = notesDir(ws, 'topic-001.md');
    const real = fs.statSync(file);
    const justAfter = Math.max(real.mtimeMs, real.ctimeMs) + 500; // a scan that starts 0.5 s after the file was written
    const readsOf = async (scanStart: number) => {
      const spy = vi.spyOn(fsp, 'readFile');
      await fullScan(ws, scanStart);
      const reads = spy.mock.calls.filter((c) => String(c[0]) === file).length;
      spy.mockRestore();
      return reads;
    };
    // The file never changes, yet it is read by every scan that starts too near its times, then by the first one
    // that finds it old, which is the first to record it, and by none after.
    expect([
      await readsOf(justAfter),
      await readsOf(justAfter),
      await readsOf(aMinuteLater()),
      await readsOf(aMinuteLater()),
    ]).toEqual([1, 1, 1, 0]);
  });
});

describe('note-mode save indexes what changed, not the whole vault', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the same few files and embeds one text whether the workspace holds 5 notes or 60', async () => {
    const reads: Record<number, string[]> = {};
    const embedded: Record<number, number> = {};
    for (const size of [5, 60]) {
      const ws = await workspace(size);
      await saveNote(ws, 'The first save in a process verifies every file once (pinned below).');
      ws.provider.texts = [];
      const spy = vi.spyOn(fsp, 'readFile');
      await saveNote(ws, `Synthetic decision recorded in a ${size}-note workspace`);
      reads[size] = spy.mock.calls.map((c) => String(c[0])).filter((p) => p.endsWith('.md'));
      embedded[size] = ws.provider.texts.length;
      spy.mockRestore();
    }
    expect(reads[60]).toHaveLength(reads[5].length);
    expect(reads[60].length).toBeLessThanOrEqual(3);
    expect(reads[60].some((p) => p.includes('topic-'))).toBe(false);
    expect(embedded).toEqual({ 5: 1, 60: 1 });
  });

  it('a note save after fact saves embeds the new ledger event, not the whole ledger', async () => {
    const embedded: Record<number, string[]> = {};
    for (const events of [5, 60]) {
      const ws = await workspace(5);
      for (let i = 0; i < events; i++) {
        await remember(ws.db, ws.memoryDir, DEFAULT_LEDGER_REL, { subject: `Service ${i % 7}`, predicate: 'status', object: `state ${i}` });
      }
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await engineIndex(ws.db, ws.config, ws.engine);
      log.mockRestore();
      ws.provider.texts = [];

      await remember(ws.db, ws.memoryDir, DEFAULT_LEDGER_REL, { subject: 'Gateway', predicate: 'hosted_on', object: 'alpha VM' });
      await saveNote(ws, `A note saved after ${events} ledger events`);
      embedded[events] = ws.provider.texts;
      expect(await vectorsMatchText(ws)).toBe(true);
    }
    // The daily note, and the one ledger event that is new: the same two whatever the ledger holds.
    expect(embedded[5]).toHaveLength(2);
    expect(embedded[60]).toHaveLength(2);
    expect(embedded[60].some((t) => t.includes('hosted_on'))).toBe(true);
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('the remember tool takes that path: a note save over MCP does not walk the workspace', async () => {
    const memoryDir = tmp('note-save-mcp-');
    seedNotes(memoryDir, 40);
    const seeded = Date.now();
    const { started, config } = await startMvpServiceOnFreePort((port) => mcpConfig(memoryDir, port), new StubProvider());
    services.push(started);
    const client = await mcpClient(config, await registerAndToken(started.app));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(parse(await client.callTool({ name: 'index_memory', arguments: {} })).ok).toBe(true);
    log.mockRestore();

    // The first save in a process verifies every file once; the next reads only what changed. The notes are as old
    // as a real workspace's by then: a file changed within a clock tick of a scan is read again by the next. The
    // service's start counts toward that tick (it writes no note), so a start that a busy host slows down is not
    // followed by a whole tick more.
    agePastATick(seeded);
    parse(await client.callTool({ name: 'remember', arguments: { statement: 'A first note, to warm the service up.', source: 'test' } }));
    const spy = vi.spyOn(fsp, 'readFile');
    const saved = parse(await client.callTool({
      name: 'remember',
      arguments: { statement: 'The launch codename is Project Firefly.', source: 'test' },
    }));
    const read = spy.mock.calls.map((c) => String(c[0])).filter((p) => p.endsWith('.md'));
    spy.mockRestore();

    expect(saved).toMatchObject({ ok: true, mode: 'note', indexed: true });
    expect(read.some((p) => p.includes('topic-'))).toBe(false);
    expect(read.length).toBeLessThanOrEqual(3);
    const found = parse(await client.callTool({ name: 'search_text', arguments: { query: 'Firefly' } }));
    expect(found.results).toHaveLength(1);
    await client.close();
  });

  it('leaves the index a full pass over the same files would build: saves, supersession, ledger, retire and restore', async () => {
    const ws = await workspace(12);
    await remember(ws.db, ws.memoryDir, DEFAULT_LEDGER_REL, { subject: 'Gateway', predicate: 'hosted_on', object: 'alpha VM' });
    await remember(ws.db, ws.memoryDir, DEFAULT_LEDGER_REL, { subject: 'Gateway', predicate: 'hosted_on', object: 'GCE demo-host-1' });

    // remember_note appends without indexing; a later save must still bring that file in.
    await engineRememberNote(ws.config, 'Backfilled quokkafern entry', '2026-01-05', 'test');
    expect(fts(ws, 'quokkafern')).toHaveLength(0);

    await saveNote(ws, 'First durable note about the tangerine rollout');
    await saveNote(ws, 'Second durable note about the persimmon rollout');
    expect(fts(ws, 'quokkafern')).toHaveLength(1);
    expect(fts(ws, 'tangerine')).toHaveLength(1);
    // The fact-mode saves appended to the ledger and never indexed it; the note save did.
    expect(fts(ws, 'GCE demo-host-1').map((h) => h.notePath)).toEqual([DEFAULT_LEDGER_REL]);

    // Retire one entry, save again, then restore it: the index follows each step.
    const entry = (await buildMemoryMap(ws.ctx)).memories.find((m) => m.kind === 'entry' && m.title.includes('tangerine'))!;
    await retireMemory(ws.ctx, entry.id);
    expect(fts(ws, 'tangerine')).toHaveLength(0);
    await saveNote(ws, 'Third durable note about the kumquat rollout');
    expect(fts(ws, 'tangerine')).toHaveLength(0);
    await restoreMemory(ws.ctx, entry.id);
    await saveNote(ws, 'Fourth durable note about the mandarin rollout');
    expect(fts(ws, 'tangerine')).toHaveLength(1);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const full = openDb(path.join(tmp('note-save-full-'), 'index.db'));
    dbs.push(full);
    runMigrations(full);
    const fullEngine = attachEngine(full, { embeddingProvider: 'none' } as MvpConfig, new StubProvider());
    await indexVault(full, ws.memoryDir, { embeddingProvider: new StubProvider(), vectorIndex: fullEngine.vectorIndex! }, 4);
    // A rebuild replays the ledger as well: its lifecycle facts decide which ledger events are still live.
    await replayLedger(full, ws.memoryDir, DEFAULT_LEDGER_REL);
    log.mockRestore();

    expect(indexSnapshot(ws.db, true)).toEqual(indexSnapshot(full, true));
    expect(await vectorsMatchText(ws)).toBe(true);

    process.env.RENOR_NEWEST_FIRST = '0';
    for (const query of ['tangerine rollout', 'kumquat', 'Gateway hosted on', 'quokkafern']) {
      expect(engineSearchText(ws.db, ws.memoryDir, query, 50)).toEqual(engineSearchText(full, ws.memoryDir, query, 50));
      const incremental = await engineSearchMemory(ws.db, ws.engine, ws.memoryDir, query, 50);
      const rebuilt = await engineSearchMemory(full, { ...ws.engine, vectorIndex: fullEngine.vectorIndex }, ws.memoryDir, query, 50);
      const keyOf = (r: { hits: unknown[] }) => (r.hits as Array<{ notePath: string; text: string }>)
        .map((h) => `${h.notePath}\n${h.text}`).sort();
      expect(keyOf(incremental)).toEqual(keyOf(rebuilt));
    }
  });

  it('a file that fails to index stays pending and is retried by the next save', async () => {
    const ws = await workspace(3);
    await engineRememberNote(ws.config, 'Backfilled mangosteen entry', '2026-02-02', 'test');
    ws.provider.failNext = 1; // the first file embedded in the next save fails
    const first = await saveNote(ws, 'Todays note about the pomelo rollout');
    expect(first.errors).toBe(1);
    expect(first.indexed).toBeGreaterThanOrEqual(1);

    const second = await engineIndexChanged(ws.db, ws.config, ws.engine);
    expect(second.errors).toBe(0);
    expect(fts(ws, 'mangosteen')).toHaveLength(1);
    expect(fts(ws, 'pomelo')).toHaveLength(1);
    expect(await vectorsMatchText(ws)).toBe(true);
  });

  it('indexes the daily note and the ledger at the same time, so a save waits on one embedding round trip, not two', async () => {
    const ws = await workspace(5);
    await saveNote(ws, 'A first note, to warm the workspace up.');
    await remember(ws.db, ws.memoryDir, DEFAULT_LEDGER_REL, { subject: 'Gateway', predicate: 'codeword', object: 'quokkaberry' });

    // A provider whose embeddings arrive only when the test lets them, to see what waits on it at once.
    const waiting: Array<() => void> = [];
    const embed = ws.provider.embed.bind(ws.provider);
    ws.provider.embed = (texts) => new Promise((resolve, reject) => {
      waiting.push(() => embed(texts).then(resolve, reject));
    });

    const saving = saveNote(ws, 'A note saved while the ledger has changed');
    await vi.waitFor(() => expect(waiting).toHaveLength(2)); // the daily note and the ledger, both on the provider
    waiting.splice(0).forEach((release) => release());
    expect(await saving).toMatchObject({ total: 2, indexed: 2, errors: 0 });
    expect(fts(ws, 'quokkaberry').map((h) => h.notePath)).toEqual([DEFAULT_LEDGER_REL]);
  });

  it('applies the vault ignore rules as a full pass does: an ignored ledger stays out of the index', async () => {
    const ws = await workspace(3, (dir) => writeNote(dir, '.semanticignore', 'System/\n'));
    await saveNote(ws, 'The first save in a process walks the vault.');
    await remember(ws.db, ws.memoryDir, DEFAULT_LEDGER_REL, { subject: 'Gateway', predicate: 'codeword', object: 'zanzibar' });
    // The second save checks the ledger it names, without the walk: the ignore rule still keeps the ledger out.
    await saveNote(ws, 'A note that is not about the ledger');
    expect(fts(ws, 'zanzibar')).toHaveLength(0);
    // The ledger's text is in no chunk: the ignore rule kept it out of the index, as the walk does.
    expect(ws.db.prepare("SELECT COUNT(*) FROM chunks WHERE text LIKE '%zanzibar%'").pluck().get()).toBe(0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await engineIndex(ws.db, ws.config, ws.engine);
    log.mockRestore();
    expect(fts(ws, 'zanzibar')).toHaveLength(0);
  });

  it('an unchanged workspace costs nothing: a second pass embeds nothing', async () => {
    const ws = await workspace(10);
    await saveNote(ws, 'Only one thing changed here');
    ws.provider.texts = [];
    const again = await engineIndexChanged(ws.db, ws.config, ws.engine);
    expect(again.errors).toBe(0);
    expect(ws.provider.texts).toHaveLength(0);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a fact-mode save indexes what changed too, not the whole workspace', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A workspace of 40 notes and a ledger of `events` fact saves, served over MCP; `save(i)` then calls `remember`
   * (fact mode) for real and records what the call embeds, reads and costs.
   */
  async function factWorkspace(events: number) {
    const memoryDir = tmp(`fact-save-${events}-`);
    seedNotes(memoryDir, 40);
    // Where the index and the ledger live does not depend on the port the service will take.
    const seedConfig = mcpConfig(memoryDir, await freePort());
    fs.mkdirSync(path.dirname(seedConfig.dbPath), { recursive: true });
    const seedDb = openDb(seedConfig.dbPath);
    runMigrations(seedDb);
    for (let i = 0; i < events; i++) {
      await remember(seedDb, memoryDir, seedConfig.ledgerRelPath, {
        subject: `Seed ${i % 50}`, predicate: 'status', object: `state ${i}`, statement: `Seeded statement number ${i}.`,
      });
    }
    seedDb.close();
    const provider = new StubProvider();
    const { started, config } = await startMvpServiceOnFreePort((port) => mcpConfig(memoryDir, port), provider);
    services.push(started);
    const client = await mcpClient(config, await registerAndToken(started.app));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(parse(await client.callTool({ name: 'index_memory', arguments: {} })).ok).toBe(true);
    log.mockRestore();

    const call = async (i: number) => parse(await client.callTool({
      name: 'remember',
      arguments: {
        statement: `Fact ${i}: the gateway codeword is quokkafern${i}.`,
        subject: `Gateway ${i}`, predicate: 'codeword', object: `quokkafern${i}`, source: 'test',
      },
    }));
    const run = { texts: [] as number[], reads: [] as string[][], cpuMs: [] as number[], wallMs: [] as number[] };
    const save = async (i: number) => {
      provider.texts = [];
      const spy = vi.spyOn(fsp, 'readFile');
      const cpu0 = process.cpuUsage();
      const t0 = performance.now();
      const receipt = await call(i);
      run.wallMs.push(performance.now() - t0);
      const cpu = process.cpuUsage(cpu0);
      run.cpuMs.push((cpu.user + cpu.system) / 1000);
      run.reads.push(spy.mock.calls.map((c) => String(c[0])).filter((p) => p.endsWith('.md')));
      spy.mockRestore();
      run.texts.push(provider.texts.length);
      expect(receipt).toMatchObject({ ok: true, mode: 'fact', action: 'store' });
      expect(receipt.warning).toBeUndefined();

      // Read back at once, by the user's words, as before: keyword and semantic search both reach the fact.
      const keyword = parse(await client.callTool({ name: 'search_text', arguments: { query: `quokkafern${i}` } }));
      expect(keyword.results.some((h: { text: string }) => h.text.includes(`quokkafern${i}`))).toBe(true);
      const semantic = parse(await client.callTool({ name: 'search_memory', arguments: { query: `gateway codeword quokkafern${i}` } }));
      expect(semantic.hits.some((h: { text: string }) => h.text.includes(`quokkafern${i}`))).toBe(true);
    };
    return { call, save, run, client, ledger: path.join(memoryDir, config.ledgerRelPath) };
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  it('embeds the new event and reads the ledger alone per save, at 100 events or at 1000, and costs the same', async () => {
    const small = await factWorkspace(100);
    const large = await factWorkspace(1000);
    // Both workspaces are as old as a real one by their first save, which verifies every file once; the next two warm the rest up.
    agePastATick(Date.now());
    for (const i of [-1, -2, -3]) {
      for (const ws of [small, large]) expect(await ws.call(i)).toMatchObject({ ok: true, mode: 'fact', action: 'store' });
    }
    // The two take turns (small then large, then large then small), so both are measured at the same moments: a busy
    // host raises CPU time too (a shared core, a lower clock), and all of one workspace's saves before all of the
    // other's compared a quiet moment with a busy one, which failed a healthy save at 3.8 times.
    for (let i = 0; i < 7; i++) {
      for (const ws of i % 2 ? [large, small] : [small, large]) await ws.save(i);
    }
    await small.client.close();
    await large.client.close();
    for (const { run, ledger } of [small, large]) {
      // One text, the event just saved (it used to be the whole ledger and a share of the vault), from the one file it is in.
      expect(run.texts).toEqual(run.texts.map(() => 1));
      expect(run.reads.flat()).toEqual(run.reads.flat().map(() => ledger));
      expect(run.reads.every((r) => r.length === 1)).toBe(true);
    }
    // CPU time rather than wall time, which a busy host stretches: a save over ten times the events costs about the
    // same (it used to cost about eight times as much; this allows three).
    expect(median(large.run.cpuMs)).toBeLessThan(3 * median(small.run.cpuMs));
  }, 120_000);
});

// ------------------------------- MCP plumbing (as engine-tools.test.ts) ---------------------

function mcpConfig(memoryDir: string, port: number): MvpConfig {
  const authRoot = tmp('note-save-auth-');
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.MVP_DB_PATH;
  return loadMvpConfig();
}

async function registerAndToken(app: Express) {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'note-save-test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorizeRes = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorizeRes.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({
    ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
  }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  return tokens.body.access_token as string;
}

async function mcpClient(config: MvpConfig, token: string) {
  const client = new Client({ name: 'note-save-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

function parse(res: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((res.content as { text: string }[])[0].text);
}
