import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { appendLedgerEvent, parseLedgerEvents, replayLedger } from '../../src/memory/lifecycle';
import { readBundleSource, readSource } from '../../src/importing/source';
import { buildImportPlan } from '../../src/importing/plan';
import { applyImportPlan, ImportStorageLimitError } from '../../src/importing/apply';
import { renderNoteMarkdown } from '../../src/importing/serialize';
import { run as runCli } from '../../src/importing/cli';
import { BUNDLE_FORMAT, ImportBundle } from '../../src/importing/types';

/**
 * Import-safety regressions.
 *
 * Three defects, all of them in the *selection* and *failure* paths rather than in what a
 * successful import carries:
 *
 *  - **F2** a rejected import rolled back the ledger and the projection but left the
 *    canonical Markdown this same run had just written, reported that outcome as if
 *    nothing had survived, and blamed the ledger replay for errors that were not replay
 *    errors.
 *  - **F4** a `bundle:` source ignored `--include`/`--exclude`/`--limit` completely, so
 *    `--exclude Private` imported the private notes anyway.
 *  - **F4-C** a malformed bundle (non-numeric `tokenCount`) reached the write layer,
 *    failed there as a chunk-insert constraint error, and was reported as a ledger
 *    replay rejection — after the note file was already on disk.
 *
 * All data is SYNTHETIC and isolated: every fixture builds its own temporary bundle,
 * workspace and ledger. No vault, tenant, network or credential is touched.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];
/** Permission-based controls do not bite as root, so they must show as skipped, not passed. */
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

afterEach(() => {
  vi.restoreAllMocks();
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

/** A JSONL bundle with the given records (the `meta` record is added first). */
function writeBundle(records: Array<Record<string, unknown>>, source = 'fixture-export'): string {
  const dir = mkdir('import-bundle-');
  const file = path.join(dir, 'export.jsonl');
  const lines = [JSON.stringify({ type: 'meta', format: BUNDLE_FORMAT, source }), ...records.map(r => JSON.stringify(r))];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

function noteRecord(relPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'note',
    path: `/src/${relPath}`,
    relPath,
    title: path.basename(relPath, '.md'),
    modifiedAt: '2026-01-02T03:04:05.000Z',
    chunks: [{ headingPath: path.basename(relPath, '.md'), text: `# ${relPath}\n\nBody of ${relPath}.`, tokenCount: 5 }],
    entities: [],
    ...extra,
  };
}

function ledgerFactRecord(predicate: string, object: string, validFrom: string): Record<string, unknown> {
  return {
    type: 'fact',
    subject: 'Renor',
    predicate,
    object,
    scope: 'global',
    validFrom,
    sourcePath: '_mcp_',
    origin: 'ledger',
  };
}

/** An initialized destination workspace (empty memory dir + its derived index). */
function buildEmptyWorkspace(): { memoryDir: string; dbPath: string } {
  const memoryDir = mkdir('import-dest-');
  const dbPath = path.join(memoryDir, '.memory-index', 'index.db');
  const db = openDb(dbPath);
  runMigrations(db);
  db.close();
  return { memoryDir, dbPath };
}

/** Seed the destination the way the engine does: a ledger event, projected by replay. */
async function seedLedgerFact(
  workspace: { memoryDir: string; dbPath: string },
  seed: { id: string; subject: string; predicate: string; object: string; validFrom: string },
): Promise<void> {
  await appendLedgerEvent(workspace.memoryDir, LEDGER, {
    id: seed.id,
    at: seed.validFrom,
    kind: 'store',
    subject: seed.subject,
    predicate: seed.predicate,
    object: seed.object,
    closedEvent: null,
    source: 'fixture',
    scope: 'global',
  });
  const db = openDb(workspace.dbPath);
  try {
    await replayLedger(db, workspace.memoryDir, LEDGER);
  } finally {
    db.close();
  }
}

function ledgerPathOf(memoryDir: string): string {
  return path.join(memoryDir, ...LEDGER.split('/'));
}

/** Destination index counts. `source_path = '_mcp_'` is the lifecycle's own rows. */
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

/**
 * Every entry in the workspace except the derived index directory.
 *
 * The index is derived and `rebuild` re-derives it, so it is deliberately outside the
 * "nothing this run created survives" claim; the canonical layer (notes, ledger) is
 * inside it.
 */
function listWorkspace(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (rel === '.memory-index') continue;
      out.push(rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(root, '');
  return out;
}

/**
 * Note files (relative paths), excluding directories and symlink entries: a link the
 * operator owns is not a note this import wrote, even when it sits at a planned path.
 */
function listWorkspaceFiles(root: string): string[] {
  return listWorkspace(root).filter(p => {
    const stat = fs.lstatSync(path.join(root, ...p.split('/')));
    return stat.isFile() && !stat.isSymbolicLink();
  });
}

/** Markdown paths (relative to the workspace root) inside an imported namespace. */
function listImportedMarkdown(root: string, namespace = 'Imported'): string[] {
  return listWorkspaceFiles(root).filter(p => p.startsWith(`${namespace}/`) && p.endsWith('.md'));
}

/* ------------------------------------------------------------------ F4: selection */

describe('import safety — a bundle source honours selection (F4)', () => {
  it('applies include/exclude to bundle notes and to the ledger facts the CLI can exclude', () => {
    const file = writeBundle([
      noteRecord('Projects/Alpha/plan.md'),
      noteRecord('Private/secret.md'),
      ledgerFactRecord('primary_goal', 'durable memory', '2026-01-05T00:00:00.000Z'),
    ]);

    // The measured defect: every flag was a silent no-op on this path, so `Private` was
    // carried and `_mcp_` (the owner's ledger facts) came along despite the exclusion.
    const selected = readSource(`bundle:${file}`, {
      include: ['Projects/Alpha'],
      exclude: ['Private', '_mcp_'],
    });

    expect(selected.notes.map(n => n.relPath)).toEqual(['Projects/Alpha/plan.md']);
    expect(selected.facts).toHaveLength(0);
    expect(selected.stats.notesAvailable).toBe(2);
    expect(selected.stats.notesSelected).toBe(1);
    expect(selected.stats.notesFilteredOut).toBe(1);
    expect(selected.stats.factsAvailable).toBe(1);
    expect(selected.stats.factsSelected).toBe(0);
  });

  it('honours --limit on a bundle and counts the records it left out', () => {
    // Deliberately named so lexical and numeric order agree: this test is about the cap,
    // not about which record sorts first.
    const file = writeBundle([
      noteRecord('A/alpha.md'),
      noteRecord('A/beta.md'),
      noteRecord('A/zeta.md'),
    ]);

    const all = readSource(`bundle:${file}`, { include: [], exclude: [] });
    expect(all.notes).toHaveLength(3);
    expect(all.stats.notesFilteredOut).toBe(0);

    const limited = readSource(`bundle:${file}`, { include: [], exclude: [], limit: 2 });
    expect(limited.notes.map(n => n.relPath)).toEqual(['A/alpha.md', 'A/beta.md']);
    expect(limited.stats.notesFilteredOut).toBe(1);
    expect(limited.stats.chunksSelected).toBe(2);
  });

  it('selects the same records with --limit whatever order the bundle lists them in', () => {
    // The index adapter sorts by relative path before applying `limit`. A bundle is the same
    // corpus in another vessel, so `--limit N` must not depend on the provider's write order
    // (a bundle is a JSONL file, and nothing guarantees a sorted one).
    const ascending = writeBundle([
      noteRecord('A/alpha.md'), noteRecord('M/mid.md'), noteRecord('Z/zed.md'),
    ]);
    const shuffled = writeBundle([
      noteRecord('Z/zed.md'), noteRecord('A/alpha.md'), noteRecord('M/mid.md'),
    ]);
    const fromAscending = readSource(`bundle:${ascending}`, { include: [], exclude: [], limit: 1 });
    const fromShuffled = readSource(`bundle:${shuffled}`, { include: [], exclude: [], limit: 1 });
    expect(fromAscending.notes.map(n => n.relPath)).toEqual(['A/alpha.md']);
    expect(fromShuffled.notes.map(n => n.relPath)).toEqual(['A/alpha.md']);
    // And without a limit the selection is likewise order-independent.
    expect(readSource(`bundle:${shuffled}`, { include: [], exclude: [] }).notes.map(n => n.relPath))
      .toEqual(['A/alpha.md', 'M/mid.md', 'Z/zed.md']);
  });

  it('never carries a note-derived fact whose note was filtered out', () => {
    const file = writeBundle([
      noteRecord('Projects/Alpha/plan.md'),
      noteRecord('Private/secret.md'),
      {
        type: 'fact', subject: 'Alpha', predicate: 'status', object: 'shipping', scope: 'global',
        validFrom: '2026-01-05T00:00:00.000Z', sourcePath: '/src/Projects/Alpha/plan.md', origin: 'note',
      },
      {
        type: 'fact', subject: 'Secret', predicate: 'status', object: 'hidden', scope: 'global',
        validFrom: '2026-01-05T00:00:00.000Z', sourcePath: '/src/Private/secret.md', origin: 'note',
      },
    ]);

    const selected = readSource(`bundle:${file}`, { include: [], exclude: ['Private'] });
    expect(selected.notes.map(n => n.relPath)).toEqual(['Projects/Alpha/plan.md']);
    // The private note's own fact is dropped with its note; the selected note's fact stays.
    expect(selected.facts.map(f => f.subject)).toEqual(['Alpha']);
  });

  it('keeps the plain one-argument bundle reader working, including its fail-closed errors', () => {
    const file = writeBundle([noteRecord('Notes/a.md')]);
    // A signature change that made `filter` required would break every existing caller.
    const bundle = readBundleSource(file);
    expect(bundle.notes).toHaveLength(1);
    expect(bundle.stats).toMatchObject({ notesAvailable: 1, notesSelected: 1, notesFilteredOut: 0 });

    const dir = mkdir('import-bundle-bad-');
    const badFormat = path.join(dir, 'format.jsonl');
    fs.writeFileSync(badFormat, `${JSON.stringify({ type: 'meta', format: 'someone-elses/v9' })}\n`, 'utf8');
    expect(() => readBundleSource(badFormat)).toThrow(/unsupported bundle format/);

    const badJson = path.join(dir, 'json.jsonl');
    fs.writeFileSync(badJson, '{not json}\n', 'utf8');
    expect(() => readBundleSource(badJson)).toThrow(/not valid JSON/);
  });

  it('imports nothing that --exclude removed, and says how many records it left out', async () => {
    const file = writeBundle([
      noteRecord('Projects/Alpha/plan.md'),
      noteRecord('Private/secret.md'),
      ledgerFactRecord('primary_goal', 'durable memory', '2026-01-05T00:00:00.000Z'),
    ]);
    const destination = buildEmptyWorkspace();

    const argv = [
      '--from', `bundle:${file}`,
      '--to', destination.memoryDir,
      '--include', 'Projects/Alpha',
      '--exclude', 'Private',
      '--exclude', '_mcp_',
      '--apply',
      '--json',
    ];
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const exitCode = await runCli(argv);
    vi.restoreAllMocks();

    expect(errors).toEqual([]);
    expect(exitCode).toBe(0);
    // The private note is not on disk, and the excluded ledger fact was not carried.
    // The default namespace is `Imported/<bundle basename>`.
    expect(listImportedMarkdown(destination.memoryDir)).toEqual(['Imported/export/Projects/Alpha/plan.md']);
    expect(countsAt(destination.dbPath).currentLifecycleFacts).toBe(0);
    const summary = JSON.parse(logs.join('\n'));
    expect(summary.selection).toEqual({ include: ['Projects/Alpha'], exclude: ['Private', '_mcp_'], limit: null });
    // Measured, not echoed back from the flags: an ignored filter must be visible as 0.
    expect(summary.counts.notesFilteredOut).toBe(1);
    expect(summary.counts.factsFilteredOut).toBe(1);
    expect(summary.counts.eventsToAppend).toBe(0);
  });

  it('reports the selection in the human-readable summary too', async () => {
    const file = writeBundle([noteRecord('Projects/Alpha/plan.md'), noteRecord('Private/secret.md')]);
    const destination = buildEmptyWorkspace();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    const exitCode = await runCli([
      '--from', `bundle:${file}`,
      '--to', destination.memoryDir,
      '--exclude', 'Private',
    ]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toMatch(/selection\s+: 1 note\(s\) and 0 fact\(s\) left out/);
  });
});

/* ------------------------------------------------- F4-C: malformed input at parse time */

describe('import safety — a malformed bundle is rejected where it is read (F4-C)', () => {
  it('rejects a non-numeric tokenCount at parse time, naming the line, note and field', () => {
    const file = writeBundle([
      noteRecord('A/ok.md'),
      // `Number("eight")` used to become NaN and reach the write layer.
      noteRecord('B/broken.md', { chunks: [{ headingPath: 'B', text: '# B', tokenCount: 'eight' }] }),
    ]);
    expect(() => readBundleSource(file)).toThrow(/invalid tokenCount/);
    expect(() => readBundleSource(file)).toThrow(/bundle line 3/);
    expect(() => readBundleSource(file)).toThrow(/B\/broken\.md/);
    // A negative count is not a count either.
    const negative = writeBundle([noteRecord('C/neg.md', { chunks: [{ headingPath: 'C', text: '# C', tokenCount: -1 }] })]);
    expect(() => readBundleSource(negative)).toThrow(/invalid tokenCount/);
    const empty = writeBundle([noteRecord('D/empty.md', { chunks: [{ headingPath: 'D', text: '# D', tokenCount: '' }] })]);
    expect(() => readBundleSource(empty)).toThrow(/invalid tokenCount/);
  });

  it('rejects a non-numeric confidence at parse time', () => {
    const file = writeBundle([
      noteRecord('A/agent.md', { entities: [{ type: 'concept', canonicalName: 'Alpha', aliases: [], confidence: 'high' }] }),
    ]);
    expect(() => readBundleSource(file)).toThrow(/invalid confidence/);
    expect(() => readBundleSource(file)).toThrow(/A\/agent\.md/);
  });

  it('still accepts the shapes existing bundles use', () => {
    const file = writeBundle([
      // Absent fields keep their defaults; numeric strings were accepted before and are
      // still accepted, so the validation is a boundary rather than a format change.
      noteRecord('A/absent.md', { chunks: [{ headingPath: 'A', text: '# A' }], entities: [{ type: 'note', canonicalName: 'A' }] }),
      noteRecord('B/strings.md', { chunks: [{ headingPath: 'B', text: '# B', tokenCount: '7' }], entities: [{ type: 'note', canonicalName: 'B', aliases: [], confidence: '0.5' }] }),
      noteRecord('C/nulls.md', { chunks: [{ headingPath: 'C', text: '# C', tokenCount: null }], entities: [{ type: 'note', canonicalName: 'C', confidence: null }] }),
    ]);
    const bundle = readBundleSource(file);
    expect(bundle.notes[0].chunks[0].tokenCount).toBe(0);
    expect(bundle.notes[0].entities[0].confidence).toBe(1);
    expect(bundle.notes[1].chunks[0].tokenCount).toBe(7);
    expect(bundle.notes[1].entities[0].confidence).toBe(0.5);
    expect(bundle.notes[2].chunks[0].tokenCount).toBe(0);
    expect(bundle.notes[2].entities[0].confidence).toBe(1);
  });

  it('writes nothing at all when the CLI is handed a malformed bundle', async () => {
    const file = writeBundle([
      noteRecord('Projects/Alpha/plan.md'),
      noteRecord('B/broken.md', { chunks: [{ headingPath: 'B', text: '# B', tokenCount: 'eight' }] }),
    ]);
    const destination = buildEmptyWorkspace();
    const before = listWorkspace(destination.memoryDir);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const exitCode = await runCli(['--from', `bundle:${file}`, '--to', destination.memoryDir, '--apply', '--json']);
    vi.restoreAllMocks();

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/source read failed: .*invalid tokenCount/);
    // Rejected before the plan, so not one canonical byte was written and no events exist.
    expect(listWorkspace(destination.memoryDir)).toEqual(before);
    expect(fs.existsSync(ledgerPathOf(destination.memoryDir))).toBe(false);
    expect(countsAt(destination.dbPath).facts).toBe(0);
  });
});

/** The rejection of `promise`; fails the test if it resolves instead (the cases below must be refused). */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/* ------------------------------------------------------------ F2: rejection compensation */

describe('import safety — a rejected import leaves nothing it created (F2)', () => {
  it.each([
    ['opening', 1],
    ['opening', 2],
    ['appending', 1],
    ['appending', 2],
  ] as const)('restores the ledger when %s fails on carried event %i', async (failure, failAt) => {
    const file = writeBundle([
      noteRecord('Projects/Import/new.md'),
      ledgerFactRecord('aa_first', 'first carried value', '2026-01-10T00:00:00.000Z'),
      ledgerFactRecord('bb_second', 'second carried value', '2026-01-11T00:00:00.000Z'),
    ]);
    const destination = buildEmptyWorkspace();
    await seedLedgerFact(destination, {
      id: 'mem_seed0001', subject: 'Renor', predicate: 'zz_existing', object: 'keep me',
      validFrom: '2026-01-09T00:00:00.000Z',
    });
    const ledgerPath = ledgerPathOf(destination.memoryDir);
    const ledgerBefore = fs.readFileSync(ledgerPath, 'utf8');
    const countsBefore = countsAt(destination.dbPath);
    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    const realOpen = fsp.open.bind(fsp);
    let ledgerOpen = 0;
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await (realOpen as (...openArgs: Parameters<typeof fsp.open>) => ReturnType<typeof fsp.open>)(...args);
      if (path.resolve(String(args[0])) !== path.resolve(ledgerPath) || ++ledgerOpen !== failAt) return handle;
      if (failure === 'opening') {
        await handle.close();
        throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });
      }
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'appendFile') {
            return async () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fsp.open);

    const err = await rejectionOf(applyImportPlan(plan, bundle, destination));

    expect(err.message).toMatch(/appending the carried events to the ledger failed/);
    expect(err.message).toMatch(/the ledger was restored/);
    expect(err.message).not.toMatch(/refusing to overwrite newer canonical memory/);
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore);
    expect(listImportedMarkdown(destination.memoryDir)).toEqual([]);
    expect(countsAt(destination.dbPath)).toEqual(countsBefore);
  });

  it('never restores a pre-erasure ledger snapshot when erasure wins during rollback', async () => {
    const file = writeBundle([ledgerFactRecord('zz_contested', 'old value', '2026-01-01T00:00:00.000Z')]);
    const destination = buildEmptyWorkspace();
    await seedLedgerFact(destination, {
      id: 'mem_seed0001', subject: 'Renor', predicate: 'zz_contested', object: 'newer value',
      validFrom: '2026-01-09T00:00:00.000Z',
    });
    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    const ledgerPath = ledgerPathOf(destination.memoryDir);
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
      const result = exec.call(this, sql);
      if (sql === 'ROLLBACK') {
        const current = fs.readFileSync(ledgerPath, 'utf8');
        const erased = current.replace(
          /\n## mem_seed0001 · [^\n]+\n[\s\S]*?(?=\n## |$)/,
          '\n## mem_seed0001 · 2026-10-14T12:00:00.000Z\n- kind: erase\n- original_digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n- source: erased\n',
        );
        fs.writeFileSync(ledgerPath, erased, 'utf8');
      }
      return result;
    });

    const err = await rejectionOf(applyImportPlan(plan, bundle, destination));

    expect(err.message).toMatch(/refusing to overwrite newer canonical memory/);
    expect(parseLedgerEvents(fs.readFileSync(ledgerPath, 'utf8'))).toContainEqual(expect.objectContaining({
      id: 'MEM_SEED0001', kind: 'erase', originalDigest: 'a'.repeat(64),
    }));
  });

  it('never restores a pre-erasure ledger snapshot when erasure lands between the snapshot and the first append', async () => {
    // The import reads its rollback snapshot before it appends. An erasure that rewrites the ledger in between leaves a
    // ledger that ends in this import's appends (so the "changed after this import appended" check passes), while the
    // snapshot still holds the erased fact. Restoring it would write the erased content back.
    const file = writeBundle([
      ledgerFactRecord('aa_first', 'first carried value', '2026-01-10T00:00:00.000Z'),
      ledgerFactRecord('bb_second', 'second carried value', '2026-01-11T00:00:00.000Z'),
    ]);
    const destination = buildEmptyWorkspace();
    await seedLedgerFact(destination, {
      id: 'mem_seed0001', subject: 'Renor', predicate: 'zz_erased', object: 'erased secret value',
      validFrom: '2026-01-09T00:00:00.000Z',
    });
    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    const ledgerPath = ledgerPathOf(destination.memoryDir);
    const realOpen = fsp.open.bind(fsp);
    let ledgerOpen = 0;
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      if (path.resolve(String(args[0])) === path.resolve(ledgerPath)) {
        ledgerOpen += 1;
        if (ledgerOpen === 1) {
          // The erasure wins the race: the fact's event becomes a content-free tombstone before the first append.
          const current = fs.readFileSync(ledgerPath, 'utf8');
          fs.writeFileSync(ledgerPath, current.replace(
            /\n## mem_seed0001 · [^\n]+\n[\s\S]*?(?=\n## |$)/,
            '\n## mem_seed0001 · 2026-10-14T12:00:00.000Z\n- kind: erase\n- original_digest: ' + 'a'.repeat(64) + '\n- source: erased\n',
          ), 'utf8');
        }
        if (ledgerOpen === 2) throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });
      }
      return (realOpen as (...openArgs: Parameters<typeof fsp.open>) => ReturnType<typeof fsp.open>)(...args);
    }) as typeof fsp.open);

    const err = await rejectionOf(applyImportPlan(plan, bundle, destination));

    expect(err.message).toMatch(/appending the carried events to the ledger failed/);
    const after = fs.readFileSync(ledgerPath, 'utf8');
    expect(after).not.toContain('erased secret value');
    expect(parseLedgerEvents(after)).toContainEqual(expect.objectContaining({ id: 'MEM_SEED0001', kind: 'erase' }));
    expect(err.message).toMatch(/refusing to overwrite newer canonical memory/);
    // The report names the likely causes, so an operator does not read it as corruption.
    expect(err.message).toMatch(/another save, or an erasure/);
  });

  it('removes the note files and the directories this run created when the replay rejects', async () => {
    const file = writeBundle([
      noteRecord('Projects/Alpha/plan.md'),
      noteRecord('Projects/Beta/beta.md'),
      ledgerFactRecord('aa_fresh', 'new value', '2026-01-05T00:00:00.000Z'),
      // Older than the destination's own value: replay rejects this, after the event above
      // has already been applied — the case where a naive rollback leaves a fact whose
      // ledger event no longer exists.
      ledgerFactRecord('zz_contested', 'old value', '2026-01-01T00:00:00.000Z'),
    ]);
    const destination = buildEmptyWorkspace();
    await seedLedgerFact(destination, {
      id: 'mem_seed0001', subject: 'Renor', predicate: 'zz_contested', object: 'newer value',
      validFrom: '2026-01-09T00:00:00.000Z',
    });
    const ledgerBefore = fs.readFileSync(ledgerPathOf(destination.memoryDir), 'utf8');
    const workspaceBefore = listWorkspace(destination.memoryDir);
    const indexBefore = countsAt(destination.dbPath);

    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    // Forced without the ledger-aware skip, so the plan really carries the contested stream.
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    expect(plan.notes).toHaveLength(2);
    expect(plan.events.map(e => e.predicate)).toEqual(['aa_fresh', 'zz_contested']);

    const err = await rejectionOf(applyImportPlan(plan, bundle, destination));
    expect(err.message).toMatch(/rolled back/);
    expect(err.message).toMatch(/the ledger replay rejected the carried events/);
    // The canonical layer: the two note files this run wrote are gone, and so is the tree
    // it created for them. Before the fix both files survived and the retry re-embedded them.
    expect(listImportedMarkdown(destination.memoryDir)).toEqual([]);
    expect(fs.existsSync(path.join(destination.memoryDir, 'Imported'))).toBe(false);
    // Ledger byte-identical and the projection untouched.
    expect(fs.readFileSync(ledgerPathOf(destination.memoryDir), 'utf8')).toBe(ledgerBefore);
    expect(countsAt(destination.dbPath)).toEqual(indexBefore);
    expect(listWorkspace(destination.memoryDir)).toEqual(workspaceBefore);
  });

  it('compensates only what it created, preserving an unchanged note, a conflict and a foreign file', async () => {
    const file = writeBundle([
      noteRecord('Projects/Gamma/gamma.md'),
      noteRecord('Projects/Alpha/plan.md'),
      noteRecord('Projects/Beta/beta.md'),
      ledgerFactRecord('zz_contested', 'old value', '2026-01-01T00:00:00.000Z'),
    ]);
    const destination = buildEmptyWorkspace();
    await seedLedgerFact(destination, {
      id: 'mem_seed0001', subject: 'Renor', predicate: 'zz_contested', object: 'newer value',
      validFrom: '2026-01-09T00:00:00.000Z',
    });

    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });

    // Operator-owned state that the run must not touch: an identical note (unchanged), a
    // different note at an imported path (conflict), and an unrelated file in an existing
    // directory (foreign). The foreign file is what stops an over-eager directory prune.
    const alpha = plan.notes.find(n => n.relPath.endsWith('Projects/Alpha/plan.md'))!;
    write(path.join(destination.memoryDir, 'Imported/src/Projects/Alpha/plan.md'), renderNoteMarkdown(alpha.note).content);
    write(path.join(destination.memoryDir, 'Imported/src/Projects/Beta/beta.md'), '# operator notes\n');
    write(path.join(destination.memoryDir, 'Imported/src/Projects/Foreign/keep.md'), '# unrelated\n');

    const before = listWorkspace(destination.memoryDir);
    const err = await rejectionOf(applyImportPlan(plan, bundle, destination));
    expect(err.message).toMatch(/rolled back/);

    // The one note this run created is gone; nothing else changed by a byte.
    expect(listImportedMarkdown(destination.memoryDir)).toEqual([
      'Imported/src/Projects/Alpha/plan.md',
      'Imported/src/Projects/Beta/beta.md',
      'Imported/src/Projects/Foreign/keep.md',
    ]);
    expect(listWorkspace(destination.memoryDir)).toEqual(before);
    expect(fs.readFileSync(path.join(destination.memoryDir, 'Imported/src/Projects/Beta/beta.md'), 'utf8'))
      .toBe('# operator notes\n');
    expect(fs.readFileSync(path.join(destination.memoryDir, 'Imported/src/Projects/Foreign/keep.md'), 'utf8'))
      .toBe('# unrelated\n');
  });

  it('leaves no residue on a retry, so a rejected import is not destructive when repeated', async () => {
    const file = writeBundle([
      noteRecord('Projects/Gamma/gamma.md'),
      ledgerFactRecord('zz_contested', 'old value', '2026-01-01T00:00:00.000Z'),
    ]);
    const destination = buildEmptyWorkspace();
    await seedLedgerFact(destination, {
      id: 'mem_seed0001', subject: 'Renor', predicate: 'zz_contested', object: 'newer value',
      validFrom: '2026-01-09T00:00:00.000Z',
    });
    const workspaceBefore = listWorkspace(destination.memoryDir);
    const indexBefore = countsAt(destination.dbPath);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
      const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
      await expect(applyImportPlan(plan, bundle, destination)).rejects.toThrow(/rolled back/);
    }
    // Two rejections in a row leave the workspace exactly where it started: no accumulated
    // orphan notes, no ledger drift, no index rows (before the fix the second run found and
    // re-chunked the orphans the first run had left behind).
    expect(listWorkspace(destination.memoryDir)).toEqual(workspaceBefore);
    expect(countsAt(destination.dbPath)).toEqual(indexBefore);
  });

  it('names the failure that actually happened instead of blaming the ledger replay', async () => {
    // A programmatic caller can still hand the write layer a non-finite count; the point
    // here is the REPORTING contract: an index-copy failure is not a replay rejection.
    const bundle: ImportBundle = {
      format: BUNDLE_FORMAT,
      sourceLabel: 'fixture',
      notes: [{
        sourcePath: '/src/Projects/Alpha/plan.md',
        relPath: 'Projects/Alpha/plan.md',
        title: 'Alpha',
        kind: null,
        modifiedAt: '2026-01-02T03:04:05.000Z',
        frontmatter: {},
        chunks: [{ headingPath: 'Alpha', text: '# Alpha\n\nShip it.', tokenCount: Number.NaN }],
        entities: [],
      }],
      facts: [],
      stats: {
        notesAvailable: 1, notesSelected: 1, notesFilteredOut: 0, notesWithOriginalBytes: 0,
        chunksSelected: 1, factsAvailable: 0, factsSelected: 0,
      },
    };
    const destination = buildEmptyWorkspace();
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });

    const err = await rejectionOf(applyImportPlan(plan, bundle, destination));
    expect(err.message).toMatch(/rolled back/);
    expect(err.message).toMatch(/copying the source parse into the destination index failed/);
    expect(err.message).not.toMatch(/ledger replay rejected/);
    expect(err.message).toMatch(/chunks\.token_count/);
    // And the note this run had already written is compensated away.
    expect(listImportedMarkdown(destination.memoryDir)).toEqual([]);
  });

  it('compensates a note-write failure that happens before the ledger is touched', async () => {
    const file = writeBundle([noteRecord('Projects/Gamma/gamma.md'), noteRecord('Projects/Alpha/plan.md')]);
    const destination = buildEmptyWorkspace();
    // A regular FILE where the second note needs a directory: creating the note fails with
    // ENOTDIR, after the first note has already been written.
    write(path.join(destination.memoryDir, 'Imported/src/Projects/Alpha'), 'operator file, not a directory\n');

    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    const err = await rejectionOf(applyImportPlan(plan, bundle, destination));

    expect(err.message).toMatch(/rolled back/);
    expect(err.message).toMatch(/writing the imported notes failed/);
    expect(err.message).toMatch(/ENOTDIR/);
    expect(err.message).not.toMatch(/ledger replay rejected/);
    // The ledger was never touched, so the message must not claim it was restored.
    expect(err.message).not.toMatch(/ledger was restored/);
    expect(fs.existsSync(ledgerPathOf(destination.memoryDir))).toBe(false);
    // Only the file this run created is gone; the operator's file stays byte-identical.
    expect(listImportedMarkdown(destination.memoryDir)).toEqual([]);
    expect(fs.readFileSync(path.join(destination.memoryDir, 'Imported/src/Projects/Alpha'), 'utf8'))
      .toBe('operator file, not a directory\n');
    expect(fs.existsSync(path.join(destination.memoryDir, 'Imported/src/Projects/Gamma'))).toBe(false);
  });
});

/* ------------------------------------------- D1: exclusive create / path ownership */

describe('import safety — a planned path this run did not create is never written through', () => {
  it('reports a symlink at a planned path as a conflict instead of writing through it', async () => {
    const file = writeBundle([noteRecord('Projects/Alpha/plan.md')]);
    const destination = buildEmptyWorkspace();
    const outside = mkdir('import-outside-');
    const outsideTarget = path.join(outside, 'target.md');
    const link = path.join(destination.memoryDir, 'Imported/src/Projects/Alpha/plan.md');
    write(path.join(destination.memoryDir, 'Imported/src/Projects/Alpha/.keep'), 'keep\n');
    fs.symlinkSync(outsideTarget, link);

    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    const result = await applyImportPlan(plan, bundle, destination);

    expect(result.notesWritten).toBe(0);
    expect(result.notesConflicting).toBe(1);
    expect(result.conflicts).toEqual(['Imported/src/Projects/Alpha/plan.md']);
    // The import neither wrote through the link nor removed it.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(outsideTarget);
    expect(fs.existsSync(outsideTarget)).toBe(false);
  });

  it('never removes a symlink while compensating a failed import', async () => {
    const file = writeBundle([
      noteRecord('Projects/Gamma/gamma.md'),
      noteRecord('Projects/Alpha/plan.md'),
      ledgerFactRecord('zz_contested', 'old value', '2026-01-01T00:00:00.000Z'),
    ]);
    const destination = buildEmptyWorkspace();
    await seedLedgerFact(destination, {
      id: 'mem_seed0001', subject: 'Renor', predicate: 'zz_contested', object: 'newer value',
      validFrom: '2026-01-09T00:00:00.000Z',
    });
    const outside = mkdir('import-outside-');
    const outsideTarget = path.join(outside, 'target.md');
    const link = path.join(destination.memoryDir, 'Imported/src/Projects/Alpha/plan.md');
    write(path.join(destination.memoryDir, 'Imported/src/Projects/Alpha/.keep'), 'keep\n');
    fs.symlinkSync(outsideTarget, link);

    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    await expect(applyImportPlan(plan, bundle, destination)).rejects.toThrow(/rolled back/);

    // The link was never this run's to remove, and nothing was written through it.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(outsideTarget);
    expect(fs.existsSync(outsideTarget)).toBe(false);
    // The note this run DID create is still compensated away.
    expect(listImportedMarkdown(destination.memoryDir)).toEqual([]);
  });

  it('leaves a regular file already at a planned path untouched and reports the conflict', async () => {
    // The guard for the exclusive create: a plain regular file at the path is a conflict,
    // never an overwrite. (The create itself is exclusive, so a file that appears during the
    // run is also EEXIST rather than a clobber — see the symlink and no-residue controls.)
    const file = writeBundle([noteRecord('Projects/Alpha/plan.md')]);
    const destination = buildEmptyWorkspace();
    write(path.join(destination.memoryDir, 'Imported/src/Projects/Alpha/plan.md'), 'concurrent writer\n');

    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    const result = await applyImportPlan(plan, bundle, destination);
    expect(result.notesWritten).toBe(0);
    expect(result.notesConflicting).toBe(1);
    expect(fs.readFileSync(path.join(destination.memoryDir, 'Imported/src/Projects/Alpha/plan.md'), 'utf8'))
      .toBe('concurrent writer\n');
  });
});

/* -------------------------------------------- D2: string fields are validated too */

describe('import safety — a malformed record cannot fabricate canonical content', () => {
  it('rejects a non-string field instead of writing "[object Object]"', () => {
    const badChunkText = writeBundle([noteRecord('A/x.md', { chunks: [{ headingPath: 'A', text: { nested: true }, tokenCount: 3 }] })]);
    expect(() => readBundleSource(badChunkText)).toThrow(/has an invalid text/);
    expect(() => readBundleSource(badChunkText)).toThrow(/chunk 0/);

    const badFactObject = writeBundle([{ type: 'fact', subject: 'A', predicate: 'p', object: ['a', 'b'] }]);
    expect(() => readBundleSource(badFactObject)).toThrow(/has an invalid object/);
    expect(() => readBundleSource(badFactObject)).toThrow(/bundle line 2: fact/);

    const badRelPath = writeBundle([{ type: 'note', path: '/src/a.md', relPath: { a: 1 }, chunks: [] }]);
    expect(() => readBundleSource(badRelPath)).toThrow(/has an invalid relPath/);

    const badEntityName = writeBundle([noteRecord('A/x.md', { entities: [{ type: 'note', canonicalName: ['A'] }] })]);
    expect(() => readBundleSource(badEntityName)).toThrow(/has an invalid canonicalName/);

    const badAlias = writeBundle([noteRecord('A/x.md', { entities: [{ type: 'note', canonicalName: 'A', aliases: ['ok', 7] }] })]);
    expect(() => readBundleSource(badAlias)).toThrow(/has an invalid alias 1/);

    // None of them reached the point of fabricating content.
    let message = '';
    try { readBundleSource(badChunkText); } catch (err) { message = (err as Error).message; }
    expect(message).not.toMatch(/\[object Object\]/);
  });

  it('keeps every field optional with defaults, so existing bundles still read', () => {
    const file = writeBundle([
      { type: 'note', relPath: 'A/minimal.md' },
      { type: 'fact', subject: 'A', predicate: 'p', object: 'o' },
    ]);
    const bundle = readBundleSource(file);
    expect(bundle.notes[0]).toMatchObject({ sourcePath: '', title: '', chunks: [], entities: [] });
    expect(bundle.facts[0]).toMatchObject({ subject: 'A', predicate: 'p', object: 'o' });
  });
});

/* --------------------------------------------- D3: a span must be a citation */

describe('import safety — a line span that cannot be a citation is dropped', () => {
  const ORIGINAL = '# Alpha\n\nText the chunks do not contain.\n';
  const UNLOCATABLE = 'nowhere in the note';

  function bundleWithSpan(startLine: unknown, endLine: unknown): ImportBundle {
    const file = writeBundle([noteRecord('Projects/Alpha/plan.md', {
      originalContent: ORIGINAL,
      chunks: [{ headingPath: 'A', text: UNLOCATABLE, tokenCount: 3, startLine, endLine }],
    })]);
    return readSource(`bundle:${file}`, { include: [], exclude: [] });
  }

  it('drops negative, fractional and reversed spans', () => {
    for (const [startLine, endLine] of [[-5, 3.7], [5, 2], [-1, -1]] as const) {
      const bundle = bundleWithSpan(startLine, endLine);
      expect(bundle.notes[0].chunks[0].startLine).toBeUndefined();
      expect(bundle.notes[0].chunks[0].endLine).toBeUndefined();
      const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
      // Unknown span, never the bogus coordinate handed back as a citation.
      expect(plan.notes[0].chunkLines).toEqual([{ startLine: 0, endLine: 0 }]);
      expect(plan.notes[0].chunksSpanInherited).toBe(0);
    }
  });

  it('still inherits a valid span for an unlocatable chunk', () => {
    // The control: the guard must not break the inheritance the adapter exists to keep.
    const bundle = bundleWithSpan(1, 3);
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    expect(plan.notes[0].chunkLines).toEqual([{ startLine: 1, endLine: 3 }]);
    expect(plan.notes[0].chunksSpanInherited).toBe(1);
  });
});

/* ------------------------------- D4/D5: the residual and the post-commit outcome */

describe('import safety — the failure text reports the residual, and only the residual', () => {
  // chmod read-only/000 is not enforced on Windows (no POSIX file modes), so these two cannot fail the write there (#1563).
  it.skipIf(IS_ROOT || process.platform === 'win32')('reports an unverified ledger when the append and its restore both fail', async () => {
    const file = writeBundle([
      noteRecord('Projects/Gamma/gamma.md'),
      ledgerFactRecord('primary_goal', 'durable memory', '2026-01-05T00:00:00.000Z'),
    ]);
    const destination = buildEmptyWorkspace();
    await seedLedgerFact(destination, {
      id: 'mem_seed0001', subject: 'Renor', predicate: 'zz_other', object: 'seeded',
      validFrom: '2026-01-09T00:00:00.000Z',
    });
    const ledgerFile = ledgerPathOf(destination.memoryDir);
    const ledgerBefore = fs.readFileSync(ledgerFile, 'utf8');
    let err: Error | null = null;
    try {
      // Read-only ledger: the APPEND fails, and so does the restore that would undo it. Nothing
      // was appended, so the ledger is still byte-identical — the honest report is that its state
      // could not be verified, not that carried events remain.
      fs.chmodSync(ledgerFile, 0o444);
      const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
      const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
      err = await rejectionOf(applyImportPlan(plan, bundle, destination));
    } finally {
      fs.chmodSync(ledgerFile, 0o644);
    }

    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/rolled back/);
    expect(err!.message).toMatch(/LEDGER COULD NOT BE RESTORED/);
    expect(err!.message).toMatch(/EACCES/);
    expect(err!.message).toMatch(/state could not be verified/);
    // With nothing appended there is no orphaned event to protect, so the message must not
    // claim the carried events remain.
    expect(err!.message).not.toMatch(/remain and WILL replay/);
    // The one thing it must never do is claim a clean restore it did not achieve.
    expect(err!.message).not.toMatch(/the ledger was restored/);
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(ledgerBefore);
    // The notes are kept rather than removed against a ledger that was not read back.
    expect(listImportedMarkdown(destination.memoryDir)).toEqual(['Imported/src/Projects/Gamma/gamma.md']);
  });

  it.skipIf(IS_ROOT || process.platform === 'win32')('preserves an unreadable existing ledger and reports the read failure', async () => {
    const destination = buildEmptyWorkspace();
    await seedLedgerFact(destination, {
      id: 'mem_seed0001', subject: 'Renor', predicate: 'zz_existing', object: 'keep this ledger',
      validFrom: '2026-01-09T00:00:00.000Z',
    });
    const ledgerFile = ledgerPathOf(destination.memoryDir);
    const ledgerBefore = fs.readFileSync(ledgerFile, 'utf8');
    const countsBefore = countsAt(destination.dbPath);
    const file = writeBundle([noteRecord('Projects/Gamma/gamma.md')]);
    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    expect(plan.events).toEqual([]);

    let err: Error | null = null;
    try {
      // Parent stays writable, but the pre-existing canonical ledger cannot be read.
      fs.chmodSync(ledgerFile, 0o000);
      err = await rejectionOf(applyImportPlan(plan, bundle, destination));
    } finally {
      if (fs.existsSync(ledgerFile)) fs.chmodSync(ledgerFile, 0o644);
    }

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/EACCES/);
    expect(fs.existsSync(ledgerFile)).toBe(true);
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(ledgerBefore);
    expect(err!.message).toMatch(/reading the destination ledger failed/);
    expect(err!.message).not.toMatch(/ledger was restored/);
    expect(listImportedMarkdown(destination.memoryDir)).toEqual([]);
    expect(countsAt(destination.dbPath)).toEqual(countsBefore);
  });

  it('reports carried events that survived a failed restore as replaying, and keeps their notes', async () => {
    // The reviewer's P5 state: the append SUCCEEDS, then the run fails, and only the RESTORE
    // write fails. The ledger then still holds the carried events and the notes they describe are
    // kept, so the message must name that residual exactly instead of claiming a rollback.
    const file = writeBundle([
      noteRecord('Projects/Gamma/gamma.md'),
      // Older than the destination's own value: replay rejects it AFTER the append succeeded.
      ledgerFactRecord('zz_contested', 'old value', '2026-01-01T00:00:00.000Z'),
    ]);
    const destination = buildEmptyWorkspace();
    await seedLedgerFact(destination, {
      id: 'mem_seed0001', subject: 'Renor', predicate: 'zz_contested', object: 'newer value',
      validFrom: '2026-01-09T00:00:00.000Z',
    });
    const ledgerFile = ledgerPathOf(destination.memoryDir);
    const ledgerBefore = fs.readFileSync(ledgerFile, 'utf8');
    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    expect(plan.events.map(e => e.predicate)).toEqual(['zz_contested']);

    // Only the RESTORE's write is broken; the append goes through and the replay then rejects.
    const fsModule = fs as unknown as { writeFileSync: (...args: unknown[]) => void };
    const original = fsModule.writeFileSync;
    let err: Error | null = null;
    try {
      fsModule.writeFileSync = () => { throw new Error('EACCES: permission denied, open ledger'); };
      err = await rejectionOf(applyImportPlan(plan, bundle, destination));
    } finally {
      fsModule.writeFileSync = original;
    }

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/LEDGER COULD NOT BE RESTORED/);
    expect(err!.message).toMatch(/EACCES/);
    // With events actually appended, this is the strong residual: they are still canonical.
    expect(err!.message).toMatch(/remain and WILL replay/);
    expect(err!.message).not.toMatch(/the ledger was restored/);
    // The residual is real, and the note the events describe is kept with them.
    expect(fs.readFileSync(ledgerFile, 'utf8')).not.toBe(ledgerBefore);
    expect(fs.readFileSync(ledgerFile, 'utf8')).toContain('zz_contested');
    expect(listImportedMarkdown(destination.memoryDir)).toEqual(['Imported/src/Projects/Gamma/gamma.md']);
  });

  it('reports a post-COMMIT failure as committed, never as a rollback', async () => {
    const file = writeBundle([noteRecord('Projects/Alpha/plan.md')]);
    const destination = buildEmptyWorkspace();
    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });

    const db = openDb(destination.dbPath);
    const proto = Object.getPrototypeOf(db) as { close: () => void };
    const original = proto.close;
    let err: Error | null = null;
    try {
      proto.close = () => { throw new Error('SQLITE_BUSY: unable to close due to unfinalized statements'); };
      err = await rejectionOf(applyImportPlan(plan, bundle, destination));
    } finally {
      proto.close = original;
      db.close();
    }

    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/import committed but the run failed afterwards/);
    expect(err!.message).toMatch(/SQLITE_BUSY/);
    expect(err!.message).not.toMatch(/rolled back/);
    // The writes really did commit, which is why there is nothing to roll back.
    expect(listImportedMarkdown(destination.memoryDir)).toEqual(['Imported/src/Projects/Alpha/plan.md']);
    expect(countsAt(destination.dbPath).notes).toBeGreaterThan(0);
  });
});


describe('import storage ceiling', () => {
  it('rolls back every imported byte when the measured result would cross the limit', async () => {
    const file = writeBundle([noteRecord('Projects/Alpha/plan.md')]);
    const destination = buildEmptyWorkspace();
    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });

    await expect(applyImportPlan(plan, bundle, {
      ...destination,
      validateBeforeCommit: () => { throw new ImportStorageLimitError('storage limit'); },
    })).rejects.toThrow('storage limit');

    expect(listImportedMarkdown(destination.memoryDir)).toEqual([]);
    const db = openDb(destination.dbPath);
    try {
      expect((db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });
});
