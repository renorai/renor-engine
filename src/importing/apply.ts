import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import Database from '../db/sqlite';
import { openDb } from '../db/client';
import { runMigrations } from '../db/schema';
import { hashContent } from '../indexer/hasher';
import { markVectorsUnfinished } from '../embeddings/vectorIndex';
import { assertConfinedTarget, assertHandleInside } from '../memory/confinedWrite';
import { withAppendLock } from '../memory/durableAppend';
import { appendLedgerEvent, parseLedgerEvents, replayLedger, DEFAULT_LEDGER_REL } from '../memory/lifecycle';
import { ImportPlan, PlannedEvent, PlannedNote } from './plan';
import { ImportBundle } from './types';
import { secretGuardEnabled } from '../extraction/secretGuard';
import { refuseFlaggedPlan } from './secretScreen';
import { nameIsOpenFile, nameKind } from '../memory/sameFile';

/**
 * The write layer.
 *
 * Two layers are written deliberately:
 *
 *  1. **Canonical** — Markdown notes under an additive namespace plus ledger events.
 *     This is what the engine treats as durable: the index is derived and rebuildable,
 *     the ledger survives `rm index.db`, and the workspace's own reads (fact list and
 *     graph) are built only from lifecycle facts.
 *  2. **Derived index rows** — the source's own parse of notes/chunks/entities, copied
 *     so the workspace shows real counts and lexical recall works **without any
 *     re-chunking, re-embedding or re-extraction**. This is a deliberate exception to
 *     "the index is derived": the derived rows are written only *after* the canonical
 *     bytes exist, and each copied note's `note_hash` is the hash of the exact bytes
 *     written, which is the engine's own condition for "unchanged — skip". Vectors are
 *     never transferred (an embedding is model-bound) and no embedding call is made here:
 *     an index whose vectors are in a model's space is marked unfinished in the same commit
 *     (`markVectorsUnfinished`), so the workspace's own model embeds exactly the copied
 *     chunks, once, before semantic search reads the index again.
 */


/** A final measured-size refusal. applyImportPlan compensates canonical and derived writes before rethrowing it. */
export class ImportStorageLimitError extends Error {}

export interface ApplyOptions {
  /** Destination workspace memory directory (the workspace's canonical store). */
  memoryDir: string;
  /** Ledger path relative to the memory dir; defaults to the engine's own default. */
  ledgerRelPath?: string;
  /** Derived index path; defaults to `<memoryDir>/.memory-index/index.db`. */
  dbPath?: string;
  /** Canonical layer only: no note/chunk/entity rows are copied. */
  canonicalOnly?: boolean;
  /** Overrides the clock for tests. */
  now?: () => Date;
  /** Journal ownership after exclusive creation, before bytes are written. May throw to roll back. */
  onNoteCreated?: (note: PlannedNote) => void;
  /** Journal an identical note this import found and therefore re-asserted without writing. */
  onNoteUnchanged?: (note: PlannedNote) => void;
  /** Final canonical-size check while the SQLite transaction is still open. Throwing rolls the whole import back. */
  validateBeforeCommit?: () => void | Promise<void>;
}

export interface ApplyResult {
  namespace: string;
  notesWritten: number;
  notesUnchanged: number;
  notesConflicting: number;
  /** Relative paths of notes that were not written because the destination differs. */
  conflicts: string[];
  eventsAppended: number;
  eventsAlreadyPresent: number;
  ledgerReplayed: number;
  indexRows: {
    notesInserted: number;
    notesUpdated: number;
    chunksInserted: number;
    chunksAlreadyPresent: number;
    entitiesInserted: number;
    entitiesAlreadyPresent: number;
  };
  /** Measured from the destination index after the writes — never inferred. */
  destination: {
    notes: number;
    chunks: number;
    entities: number;
    facts: number;
    currentFacts: number;
    ftsRows: number;
  } | null;
}

/**
 * What this invocation created, so a failure can undo exactly that and nothing else.
 * `files` are the note files this run wrote where nothing existed before; `dirs` are the
 * directories this run had to create, outermost first.
 */
interface CreatedPaths {
  files: string[];
  dirs: string[];
}

/** Where the run was when it failed — the only source of the failure's wording. */
type ApplyPhase = 'notes' | 'ledger-read' | 'ledger' | 'index' | 'replay' | 'copy';

const PHASE_DESCRIPTION: Record<ApplyPhase, string> = {
  notes: 'writing the imported notes failed',
  'ledger-read': 'reading the destination ledger failed',
  ledger: 'appending the carried events to the ledger failed',
  index: 'the destination index could not be opened or migrated',
  replay: 'the ledger replay rejected the carried events',
  copy: 'copying the source parse into the destination index failed',
};

export async function applyImportPlan(
  plan: ImportPlan,
  _bundle: ImportBundle,
  options: ApplyOptions,
): Promise<ApplyResult> {
  // RENOR_SECRET_GUARD (default ON): a plan that still holds a note or fact that looks like a secret is refused
  // whole, here, before the first directory, file, ledger event or index row. buildImportPlan leaves such items
  // out, so this catches a plan built with the guard off, or by another caller.
  if (secretGuardEnabled()) refuseFlaggedPlan(plan);

  const memoryDir = path.resolve(options.memoryDir);
  const dbPath = options.dbPath ?? path.join(memoryDir, '.memory-index', 'index.db');
  const ledgerRelPath = options.ledgerRelPath ?? DEFAULT_LEDGER_REL;
  const ledgerPath = path.join(memoryDir, ...ledgerRelPath.split('/'));

  let notesWritten = 0;
  let notesUnchanged = 0;
  let notesConflicting = 0;
  /** Destination paths that already hold different content: never written, never indexed. */
  const skippedConflicts = new Set<string>();
  const conflicts: string[] = [];

  // Compensation state. Every path in `created` was absent before this invocation, so
  // removing it cannot lose memory the operator or another writer owns.
  const created: CreatedPaths = { files: [], dirs: [] };
  let phase: ApplyPhase = 'notes';
  let priorLedger: string | null = null;
  let appendedLedger: string | null = null;
  // Set immediately before this invocation's first append. A failed read or parse must
  // never enter ledger compensation: no ledger bytes have been touched yet.
  let ledgerTouched = false;
  let db: Database.Database | null = null;
  let committed = false;
  let ledgerReplayed = 0;
  let eventsAppended = 0;
  let eventsAlreadyPresent = 0;
  let indexRows: ApplyResult['indexRows'] = {
    notesInserted: 0,
    notesUpdated: 0,
    chunksInserted: 0,
    chunksAlreadyPresent: 0,
    entitiesInserted: 0,
    entitiesAlreadyPresent: 0,
  };

  try {
    // A first vault import can target a workspace that has no memory directory
    // yet. Create the root before creating tracked additive subdirectories.
    ensureDirTracked(memoryDir, memoryDir, created);
    for (const planned of plan.notes) {
      const target = path.join(memoryDir, ...planned.relPath.split('/'));
      const dir = path.dirname(target);
      if (!isInside(memoryDir, target)) {
        throw new Error(`refusing to write outside the memory directory: ${planned.relPath}`);
      }
      assertNoLinkBelow(memoryDir, dir);
      ensureDirTracked(memoryDir, dir, created);
      // Exclusive create: this run owns the file only if this run is what brought it into
      // existence. A plain `writeFile` decides ownership from an `ENOENT` read that the
      // write does not repeat, so anything appearing in that window is overwritten and then
      // deleted by the compensation — and `writeFile` follows a symlink, so a dangling link
      // at the planned path would have the import write outside the memory directory and
      // then remove the link. `wx` makes the create atomic, so ownership is observed rather
      // than assumed, and only a path this run created is ever recorded for removal. An empty
      // leftover of an earlier import killed between that create and its write is replaced
      // instead of reported as a conflict (openEmptyLeftover); the containment check below
      // still runs on whichever handle it gets, before anything is written or recorded.
      const handle = (await openExclusive(target)) ?? (await openEmptyLeftover(target));
      if (handle) {
        // A directory swapped for a link after assertNoLinkBelow would have the open land elsewhere: ask the kernel where
        // the file is before anything is written or recorded (src/memory/confinedWrite.ts).
        try {
          await assertHandleInside(handle, await fs.realpath(memoryDir), planned.relPath);
        } catch (err) {
          await handle.close().catch(() => undefined);
          throw err;
        }
        // From here the file exists because of THIS run, so it is this run's to remove if
        // anything later fails.
        created.files.push(target);
        try {
          options.onNoteCreated?.(planned);
          await handle.writeFile(planned.content, 'utf8');
          // Durable before the import is acknowledged, like every other acknowledged Markdown write (adv-crashsafe-1012 F3).
          await handle.sync();
        } finally {
          await handle.close();
        }
        notesWritten += 1;
        continue;
      }
      // Something is already at the path, and the import is additive: it is never written
      // to. A path this run did not create — including a symlink, which must not be written
      // through even when it points back inside the memory directory — is a conflict the
      // operator resolves, and it is skipped for the index too.
      const existing = await fs.lstat(target);
      if (!existing.isFile()) {
        notesConflicting += 1;
        skippedConflicts.add(target);
        conflicts.push(planned.relPath);
        continue;
      }
      const onDisk = await fs.readFile(target, 'utf8');
      if (onDisk === planned.content) {
        options.onNoteUnchanged?.(planned);
        notesUnchanged += 1;
        continue;
      }
      notesConflicting += 1;
      skippedConflicts.add(target);
      conflicts.push(planned.relPath);
    }

    phase = 'ledger-read';
    // Snapshot the durable authority before any append. Only ENOENT means no ledger;
    // permission and other read failures propagate so an existing ledger is never
    // mistaken for absence and later removed by rollback. Parse IDs from the same bytes
    // that compensation will restore, avoiding a second read with a different outcome.
    // A ledger reached through a link, or a link itself, is refused before a byte is read from or written to it.
    await assertConfinedTarget(memoryDir, path.relative(memoryDir, ledgerPath));
    priorLedger = readFileOrNull(ledgerPath);
    const existingLedgerIds = new Set(
      parseLedgerEvents(priorLedger ?? '').map(event => event.id.toUpperCase()),
    );
    // `appendLedgerEvent` creates the ledger's directory chain itself. Record the
    // directories that are missing now, so a rollback cannot leave an empty tree behind.
    for (const dir of missingDirsUnder(memoryDir, path.dirname(ledgerPath))) created.dirs.push(dir);
    try {
      for (const event of plan.events) {
        const eventKey = event.id.toUpperCase();
        if (existingLedgerIds.has(eventKey)) {
          eventsAlreadyPresent += 1;
          continue;
        }
        // From this point the durable bytes may change, so and only so can rollback restore
        // the prior snapshot (or remove a ledger this invocation created from an absent path).
        phase = 'ledger';
        ledgerTouched = true;
        await appendLedgerEvent(memoryDir, ledgerRelPath, toLedgerEvent(event));
        existingLedgerIds.add(eventKey);
        eventsAppended += 1;
      }
    } finally {
      // Capture what this run actually left behind even when an append rejects. The
      // compare-before-restore guard must compare against these bytes, not `null`, after
      // an earlier event in the same plan was appended successfully.
      if (ledgerTouched) appendedLedger = readFileOrNull(ledgerPath);
    }

    phase = 'index';
    db = openDb(dbPath);
    runMigrations(db);

    // The append and the projection are ONE unit, in both directions.
    //
    // `replayLedger` applies events in a bare loop and each `applyEvent` commits its own
    // transaction, so a mid-loop rejection would leave the already-applied facts
    // committed. Restoring the ledger on top of that would remove the events while their
    // facts remain — and the engine's global preflight (K13) fails closed when the index
    // holds lifecycle facts whose event id is absent from the ledger. The result would be
    // a workspace that refuses to serve, which is worse than the rejection itself.
    // Wrapping the replay in one outer transaction makes the rollback real: the engine's
    // own `db.transaction` calls become savepoints inside it.
    phase = 'replay';
    db.exec('BEGIN IMMEDIATE');
    try {
      // The lifecycle projection is applied through the engine's own replay, so the
      // imported facts and the destination's existing facts obey one write path.
      ledgerReplayed = await replayLedger(db, memoryDir, ledgerRelPath);
      phase = 'copy';
      if (!options.canonicalOnly) {
        indexRows = copyParseRows(db, memoryDir, plan, skippedConflicts);
        // The copied chunks have no vector. The mark lands in this commit, so it and the chunks land together or not at
        // all; the next engine with the index's model embeds every chunk that has none, once (a running service starts
        // that job when the import returns).
        if (indexRows.chunksInserted > 0) markVectorsUnfinished(db);
      }
      // Canonical Markdown is now complete, but neither its index projection nor the files have committed as a unit.
      // This is the last point at which a measured workspace ceiling can reject and compensate every added byte.
      await options.validateBeforeCommit?.();
      db.exec('COMMIT');
      committed = true;
    } catch (err) {
      // A failed ROLLBACK must not hide the failure that caused it.
      try { db.exec('ROLLBACK'); } catch { /* the transaction is already unwound */ }
      throw err;
    }

    return {
      namespace: plan.namespace,
      notesWritten,
      notesUnchanged,
      notesConflicting,
      conflicts,
      eventsAppended,
      eventsAlreadyPresent,
      ledgerReplayed,
      indexRows,
      destination: measureDestination(db),
    };
  } catch (err) {
    // Past COMMIT the projection is durable and there is nothing to roll back; saying that
    // is the honest report, and it must not read like an ordinary failed import.
    if (committed) throw committedFailure(err);

    // One compensation for the whole unit. The projection is already unwound (rolled back
    // or never started), so what remains is the canonical layer this run added: its own
    // note bytes, its own directories, and the ledger bytes it appended to. Files the run
    // did not create — unchanged notes, conflicts, the operator's own files — are never
    // touched, and pruning is limited to directories that are empty afterwards.
    const restore: LedgerRestore = ledgerTouched
      ? await restoreLedger(ledgerPath, priorLedger, appendedLedger)
      : { restored: false };
    // A ledger that could not be restored still holds its carried events, and those events
    // are canonical: removing the notes they describe would leave a ledger pointing at
    // memory that no longer exists. Keep the notes so the canonical layer stays
    // self-consistent and recoverable, and report the residual instead of destroying it.
    const notesRemoved = ledgerTouched && !restore.restored ? 0 : compensateCreatedPaths(created);
    if (err instanceof ImportStorageLimitError && (!ledgerTouched || restore.restored)) throw err;
    throw new Error(rollbackMessage({ phase, err, notesRemoved, ledgerTouched, restore, eventsAppended }));
  } finally {
    try {
      db?.close();
    } catch (closeErr) {
      // A close failure after COMMIT is a post-commit failure: the writes are durable and
      // no rollback happened. Before COMMIT the primary failure is already propagating and
      // would be replaced by throwing here, so this one is dropped rather than allowed to
      // hide the real cause.
      if (committed) throw committedFailure(closeErr);
    }
  }
}

/**
 * `open(path, 'wx')`, or `null` when something already exists at the path.
 * Exposed as a function so the exclusivity is one decision in one place, not a flag each
 * caller has to remember.
 */
async function openExclusive(target: string): Promise<Awaited<ReturnType<typeof fs.open>> | null> {
  // On Windows 'wx' follows a dangling link at the name and creates its target outside: a taken name is taken, link or not.
  if ((await nameKind(target)) !== 'absent') return null;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(target, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  // A link planted after the check above: the name is taken (by the link), and nothing was created here that this import
  // may later remove by that name (#1563).
  if (!(await nameIsOpenFile(handle, target))) {
    await handle.close();
    return null;
  }
  return handle;
}

/**
 * Opens an empty leftover of an earlier import for writing, or returns `null` when the path holds anything else. An
 * earlier import created each note before writing it, so a kill between the two left an empty file that no journal
 * named; a retry replaces it, holding nothing to lose, instead of reporting a conflict. The open never creates and never
 * follows a link (O_NOFOLLOW), a hard-linked file is refused (a write would reach its other name too), and the size is
 * checked on the open descriptor, so the file written is the file that was checked. The caller still runs the
 * containment check on the handle before anything is written or recorded. The check and the open are two calls, so a file
 * another writer put at that exact instant would be written; an import is additive and runs on the owner's own workspace,
 * so that window is accepted.
 */
async function openEmptyLeftover(target: string): Promise<fs.FileHandle | null> {
  if (!isEmptyLeftover(await fs.lstat(target))) return null;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(target, fsSync.constants.O_WRONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK);
  } catch (err) {
    if (['ELOOP', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw err;
  }
  const opened = await handle.stat();
  if (!isEmptyLeftover(opened) || opened.nlink !== 1 || !(await nameIsOpenFile(handle, target))) {
    await handle.close();
    return null;
  }
  return handle;
}

/** An empty regular file (not a symlink, not a directory): what an interrupted import leaves at a note's path. */
export function isEmptyLeftover(stat: fsSync.Stats): boolean {
  return stat.isFile() && stat.size === 0;
}

/** A failure after the import committed: durable writes that were deliberately not rolled back. */
function committedFailure(err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(
    'import committed but the run failed afterwards, so no rollback was performed and the imported '
    + `notes, ledger events and index rows remain as written (${detail})`,
  );
}

/**
 * The failure text. It names the step that actually failed and what was undone, so an
 * operator is never told "the ledger replay rejected the carried events" for a chunk
 * insert or a bad destination index, and never told the ledger was restored when it was not.
 */
function rollbackMessage(args: {
  phase: ApplyPhase;
  err: unknown;
  notesRemoved: number;
  ledgerTouched: boolean;
  restore: LedgerRestore;
  eventsAppended: number;
}): string {
  const { phase, err, notesRemoved, ledgerTouched, restore, eventsAppended } = args;
  const detail = err instanceof Error ? err.message : String(err);
  const compensated: string[] = [];
  if (notesRemoved > 0) compensated.push(`the ${notesRemoved} note file(s) this run created were removed`);
  if (ledgerTouched) compensated.push(ledgerOutcome(restore, eventsAppended));
  compensated.push('no facts were applied');
  return `import rolled back: ${PHASE_DESCRIPTION[phase]}, so ${compensated.join(', ')} (${detail})`;
}

/**
 * What happened to the ledger, stated exactly.
 *
 * The two failure branches are different states and must not be described with one
 * sentence: with events actually appended, those events are canonical and will replay, so
 * the notes are kept to keep the two layers consistent; with nothing appended, the ledger's
 * state is simply unverified (an append that failed part-way may still have written bytes),
 * and the notes are kept rather than removed against a ledger nobody has read back.
 */
function ledgerOutcome(restore: LedgerRestore, eventsAppended: number): string {
  if (restore.restored) return 'the ledger was restored to its previous contents';
  const cause = restore.error ?? 'unknown error';
  if (eventsAppended > 0) {
    return 'the LEDGER COULD NOT BE RESTORED'
      + ` (${cause}), so the ${eventsAppended} event(s) this run appended remain and WILL replay: the note`
      + ' files this run created were left in place so the canonical notes and ledger stay consistent,'
      + ' and the destination needs its own repair';
  }
  return 'the LEDGER COULD NOT BE RESTORED'
    + ` (${cause}) and its state could not be verified, so the note files this run created were left in`
    + ' place rather than removed against a ledger that was not read back; the destination needs its own repair';
}

/**
 * Refuse a destination directory whose chain under the memory directory holds a symbolic link: the writes below it would
 * land wherever the link points. The memory directory itself may be a link, it is where the operator put the vault. A
 * directory that does not exist yet is fine.
 */
function assertNoLinkBelow(root: string, dir: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return;
  let current = path.resolve(root);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let st: fsSync.Stats;
    try {
      st = fsSync.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to write below ${JSON.stringify(path.relative(path.resolve(root), current))}: it is a symbolic link`);
    }
  }
}

/**
 * `mkdir -p` that records every directory THIS run had to create.
 *
 * `fs.mkdir(dir, {recursive:true})` reports only the first directory it created, which is
 * not enough to prune the chain again; and compensation must be able to tell a directory
 * it made from one that was already there.
 */
function ensureDirTracked(root: string, dir: string, created: CreatedPaths): void {
  const base = path.resolve(root);
  const target = path.resolve(dir);
  const relative = path.relative(base, target);
  if (relative === '') {
    // The memory directory itself: create it when absent, but never claim it for removal.
    fsSync.mkdirSync(target, { recursive: true, mode: 0o700 });
    return;
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fsSync.mkdirSync(target, { recursive: true });
    return;
  }
  for (const missing of missingDirsUnder(base, target)) {
    try {
      fsSync.mkdirSync(missing, { mode: 0o700 });
      created.dirs.push(missing);
    } catch (err) {
      // Created between the check and the mkdir: it is not this run's to remove.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
}

/** Directory chain under `root` that does not exist yet, outermost first. */
function missingDirsUnder(root: string, dir: string): string[] {
  const base = path.resolve(root);
  const target = path.resolve(dir);
  const relative = path.relative(base, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return [];
  const missing: string[] = [];
  let current = base;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fsSync.existsSync(current)) missing.push(current);
  }
  return missing;
}

/**
 * Remove what this run created: its own note files, then its own directories deepest-first
 * and only while they are empty. Nothing recursive is ever removed — a directory that has
 * picked up any other entry is left exactly as it is.
 */
function compensateCreatedPaths(created: CreatedPaths): number {
  let removed = 0;
  for (const file of created.files) {
    try {
      fsSync.unlinkSync(file);
      removed += 1;
    } catch {
      // Already gone: the compensation is idempotent.
    }
  }
  const dirs = [...created.dirs].sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length || b.length - a.length,
  );
  for (const dir of dirs) {
    try {
      if (fsSync.readdirSync(dir).length === 0) fsSync.rmdirSync(dir);
    } catch {
      // Not empty, or already gone: leave it.
    }
  }
  return removed;
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fsSync.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The outcome of the rollback's ledger restore, so the report can be the truth. */
interface LedgerRestore {
  restored: boolean;
  error?: string;
}

/**
 * Exact restore of the prior ledger bytes, or removal when it did not exist before.
 * Returns the OUTCOME rather than swallowing it: a run that could not restore the ledger
 * still holds the carried events, and must say so instead of claiming a clean rollback.
 */
function restoreLedger(ledgerPath: string, prior: string | null, appended: string | null): Promise<LedgerRestore> {
  // Under the lock every ledger writer takes (appends, and the erasure's rewrite in lifecycle.ts), so no writer can
  // change the ledger between the checks below and the restore.
  return withAppendLock(ledgerPath, async () => restoreLedgerLocked(ledgerPath, prior, appended));
}

function restoreLedgerLocked(ledgerPath: string, prior: string | null, appended: string | null): LedgerRestore {
  try {
    // Compensation owns only the bytes it appended. If another lifecycle writer changed the
    // ledger afterwards (especially by replacing a fact with an erase tombstone), restoring
    // this import's older snapshot would resurrect that writer's deleted canonical content.
    if (readFileOrNull(ledgerPath) !== appended) {
      return { restored: false, error: 'the ledger changed while this import ran (another save, or an erasure); refusing to overwrite newer canonical memory' };
    }
    // The snapshot was read before the appends, without the lock. Only appends may have happened since: then the snapshot
    // is a prefix of what this run left. Anything else (an erasure rewrote the ledger in between) makes the snapshot stale,
    // and restoring it would write erased content back.
    if (prior !== null && (appended === null || !appended.startsWith(prior))) {
      return { restored: false, error: 'the ledger changed while this import ran (another save, or an erasure); refusing to overwrite newer canonical memory' };
    }
    if (prior === null) {
      if (fsSync.existsSync(ledgerPath)) fsSync.unlinkSync(ledgerPath);
      return { restored: !fsSync.existsSync(ledgerPath) };
    }
    fsSync.writeFileSync(ledgerPath, prior, 'utf8');
    return { restored: fsSync.readFileSync(ledgerPath, 'utf8') === prior };
  } catch (err) {
    return { restored: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function toLedgerEvent(event: PlannedEvent) {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    subject: event.subject,
    predicate: event.predicate,
    object: event.object,
    closedEvent: null,
    source: event.source,
    scope: event.scope,
  };
}

/**
 * Copy the source's parse of notes, chunks and entities into the destination index.
 * Facts and relations are deliberately NOT copied: the dashboard's fact list and graph
 * read lifecycle facts only, and relations carry no foreign key (they would fail
 * silently). Note-derived entities whose `source_note` is the lifecycle sentinel are
 * skipped so the destination's own lifecycle entity is never duplicated.
 */
function copyParseRows(
  db: Database.Database,
  memoryDir: string,
  plan: ImportPlan,
  skippedConflicts: Set<string>,
): ApplyResult['indexRows'] {
  const counters: ApplyResult['indexRows'] = {
    notesInserted: 0,
    notesUpdated: 0,
    chunksInserted: 0,
    chunksAlreadyPresent: 0,
    entitiesInserted: 0,
    entitiesAlreadyPresent: 0,
  };

  const findNote = db.prepare('SELECT note_hash FROM notes WHERE path = ?');
  const insertNote = db.prepare(
    `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
     VALUES (@path, @title, @kind, @noteHash, @modifiedAt, @frontmatterJson)`,
  );
  const updateNote = db.prepare(
    `UPDATE notes SET title = @title, kind = @kind, note_hash = @noteHash,
       modified_at = @modifiedAt, frontmatter_json = @frontmatterJson WHERE path = @path`,
  );
  const countChunks = db.prepare('SELECT count(*) AS c FROM chunks WHERE note_path = ?');
  const insertChunk = db.prepare(
    `INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
     VALUES (@notePath, @headingPath, @text, @startLine, @endLine, @tokenCount, @chunkHash)`,
  );
  const findEntity = db.prepare(
    'SELECT id FROM entities WHERE canonical_name = ? AND type = ? AND source_note = ?',
  );
  const insertEntity = db.prepare(
    `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
     VALUES (@type, @canonicalName, @aliasesJson, @sourceNote, @confidence, @updatedAt)`,
  );

  const run = db.transaction(() => {
    for (const planned of plan.notes) {
      const target = path.join(memoryDir, ...planned.relPath.split('/'));
      // A path that was not written (conflict, or a file the operator owns) gets no
      // index rows: otherwise the row would carry the source's hash and chunk text for
      // bytes that are not on disk, which both breaks search honesty and makes the next
      // index pass see a change and re-chunk and re-embed the note.
      if (skippedConflicts.has(target)) continue;
      // The note row must hash the bytes on disk: this is exactly the engine's
      // "unchanged, skip" condition, so the note is never re-chunked or re-embedded.
      const noteHash = hashContent(planned.content);
      const modifiedAt = safeMtime(target);
      const note = planned.note;
      const row = {
        path: target,
        title: note.title || path.basename(planned.relPath),
        kind: note.kind,
        noteHash,
        modifiedAt,
        frontmatterJson: JSON.stringify(note.frontmatter ?? {}),
      };
      const existing = findNote.get(target) as { note_hash: string } | undefined;
      if (!existing) {
        insertNote.run(row);
        counters.notesInserted += 1;
      } else if (existing.note_hash !== noteHash) {
        // The file on disk is authoritative for the row, so re-sync rather than leave a
        // stale hash that would make a later index pass re-process this note.
        updateNote.run(row);
        counters.notesUpdated += 1;
      }

      const chunkCount = (countChunks.get(target) as { c: number }).c;
      if (chunkCount > 0) {
        counters.chunksAlreadyPresent += note.chunks.length;
      } else {
        for (let i = 0; i < note.chunks.length; i += 1) {
          const chunk = note.chunks[i];
          const lines = planned.chunkLines[i] ?? { startLine: 0, endLine: 0 };
          insertChunk.run({
            notePath: target,
            headingPath: chunk.headingPath,
            text: chunk.text,
            startLine: lines.startLine,
            endLine: lines.endLine,
            tokenCount: chunk.tokenCount,
            chunkHash: hashContent(chunk.text),
          });
          counters.chunksInserted += 1;
        }
      }

      for (const entity of note.entities) {
        if (!entity.canonicalName.trim()) continue;
        const found = findEntity.get(entity.canonicalName, entity.type, target) as { id: number } | undefined;
        if (found) {
          counters.entitiesAlreadyPresent += 1;
          continue;
        }
        insertEntity.run({
          type: entity.type || 'note',
          canonicalName: entity.canonicalName,
          aliasesJson: JSON.stringify(entity.aliases ?? []),
          sourceNote: target,
          confidence: typeof entity.confidence === 'number' ? entity.confidence : 1,
          updatedAt: new Date().toISOString(),
        });
        counters.entitiesInserted += 1;
      }
    }
  });
  run();

  return counters;
}

function safeMtime(filePath: string): string {
  try {
    return fsSync.statSync(filePath).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function measureDestination(db: Database.Database): ApplyResult['destination'] {
  const scalar = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
  try {
    return {
      notes: scalar('SELECT count(*) AS c FROM notes'),
      chunks: scalar('SELECT count(*) AS c FROM chunks'),
      entities: scalar('SELECT count(*) AS c FROM entities'),
      facts: scalar('SELECT count(*) AS c FROM facts'),
      currentFacts: scalar(`SELECT count(*) AS c FROM facts WHERE valid_to IS NULL AND source_path = '_mcp_'`),
      ftsRows: scalar('SELECT count(*) AS c FROM chunks_fts'),
    };
  } catch {
    return null;
  }
}
