import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from '../db/sqlite';
import * as z from 'zod';
import { parseMarkdownImportNote } from './markdown';
import { isSelected } from './source';
import { BUNDLE_FORMAT, type ImportBundle } from './types';
import { buildImportPlan, type ImportPlan } from './plan';
import { applyImportPlan, ImportStorageLimitError, isEmptyLeftover, type ApplyResult } from './apply';
import { retireMemory, type MemoryMapContext } from '../memorymap/memoryMap';
import { isBlankOrInvisible } from '../memory/invisibleText';
import { assertNoUnstorableControls } from '../memory/controls';
import { SecretRefusedError } from '../extraction/secretGuard';
import { refusal } from '../toolRefusal';
import { IMPORT_JOURNAL_DIR } from './forgetImported';
import { measureMarkdownBytes } from '../mvp/storedSize';
import { JournalLog, journalLogName, readJournalLog, removeJournalLog } from './journalLog';

// Fits the existing 1 MiB HTTP ceiling even with JSON escaping. Count UTF-8
// bytes, including paths, before parsing/selection. Refuse rather than slice.
export const IMPORT_LIMITS = { fileBytes: 64 * 1024, batchBytes: 128 * 1024, files: 100 };
const PREVIEW_MS = 15 * 60 * 1000;
const batchIdSchema = z.string().uuid('batchId must be the batchId returned by preview_import (a UUID)');
/** Zod's default for a missing field says only "expected array, received undefined"; say what to send instead. */
function required(message: string) { return (issue: { input?: unknown }) => (issue.input === undefined ? message : undefined); }
export const importPreviewSchema = {
  label: z.string().min(1).max(200).describe('Name for this import; notes go to Imported/<label>/. It is a folder name: letters (any alphabet), digits, "-" and "_" are kept; spaces and punctuation become "-".'),
  files: z.array(z.object({
    relativePath: z.string({ error: required("files[] entries need relativePath: the file's path inside the folder, e.g. notes/idea.md") }).min(1).max(512),
    markdown: z.string({ error: required("files[] entries need markdown: the file's full text") })
      .max(IMPORT_LIMITS.fileBytes, 'This file is over 64 KiB. Split it into several smaller .md files (by heading) or leave it out.'),
  }).strict(), { error: required('files is required: an array of { relativePath, markdown } holding each file\'s text. The server cannot read your disk; read each file yourself and send its text.') })
    .min(1).max(IMPORT_LIMITS.files, 'Too many files: send at most 100 per call, then call preview_import again for the next group.'),
  include: z.array(z.string().min(1).max(512)).max(100).optional().describe('Only these folder or file path prefixes, e.g. "Projects" (prefixes, not globs)'),
  exclude: z.array(z.string().min(1).max(512)).max(100).optional().describe('Leave these folder or file path prefixes out, e.g. "Private" (prefixes, not globs)'),
  stage: z.boolean().optional().describe('false: check only. Same answer without a batchId; nothing is held, so nothing can be applied from it'),
};
export const importBatchSchema = { batchId: batchIdSchema };
type PreviewInput = { label: string; files: Array<{ relativePath: string; markdown: string }>; include?: string[]; exclude?: string[]; stage?: boolean };
interface Preview { expiresAt: number; bundle: ImportBundle; plan: ImportPlan }
interface Manifest {
  batchId: string;
  state: 'applying' | 'applied' | 'failed' | 'undone';
  created: Array<{ relPath: string; hash: string; retired?: boolean }>;
  /** Identical live notes this batch asserted. Absent in old receipts, which retain creator-only undo behavior. */
  reasserted?: Array<{ relPath: string; hash: string; retired?: boolean }>;
  result?: ApplyResult;
}
interface TenantState { previews: Map<string, Preview>; chain: Promise<unknown> }
const states = new WeakMap<Database.Database, TenantState>();
function state(db: Database.Database): TenantState {
  let value = states.get(db);
  if (!value) { value = { previews: new Map(), chain: Promise.resolve() }; states.set(db, value); }
  return value;
}
function serial<T>(db: Database.Database, fn: () => Promise<T>): Promise<T> {
  const tenant = state(db);
  const result = tenant.chain.then(fn, fn);
  tenant.chain = result.then(() => undefined, () => undefined);
  return result;
}
function invalidUnicode(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}
/**
 * The folder name Imported/<label> uses. A name the old pattern accepted ([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}) maps to
 * itself, so a re-import lands on the same notes. Only letters, digits, marks, '-' and '_' survive (in NFC, so "café" is
 * one folder however it was typed): no '/', '.', '\\', control character or anything else that changes the target.
 */
const MAX_LABEL_BYTES = 200;
export function folderLabel(raw: string): string {
  const kept = raw.normalize('NFC').replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '-').replace(/^[^\p{L}\p{N}]+/u, '');
  const label = [...kept].slice(0, 64).join('');
  if (!label) throw refusal('invalid_argument', 'label needs at least one letter or digit, e.g. "chatgpt-memory" (it becomes a folder name).');
  if (Buffer.byteLength(label, 'utf8') > MAX_LABEL_BYTES) throw refusal('field_too_long', `label is too long as a folder name (over ${MAX_LABEL_BYTES} bytes in UTF-8); shorten it.`);
  return label;
}
function validatePath(rel: string, i: number): void {
  const at = `files[${i}]: `;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw refusal('unsafe_path', `${at}relativePath must be relative to the folder you are importing (e.g. notes/CLAUDE.md), not an absolute path.`);
  if (rel.includes('\\')) throw refusal('unsafe_path', `${at}use / between folders in relativePath, not a backslash.`);
  if (rel.split('/').some(part => !part || part === '.' || part === '..' || part.trim() !== part)) {
    throw refusal('unsafe_path', `${at}relativePath cannot hold .., . or empty folder names, or a name with leading or trailing spaces; use a path like notes/idea.md.`);
  }
  if (invalidUnicode(rel) || /[:\x00-\x1f\x7f]/.test(rel)) throw refusal('unsafe_path', `${at}relativePath has a character that cannot be imported (colon, control character or invalid Unicode); rename the file.`);
  if (rel.split('/').some(part => Buffer.byteLength(part, 'utf8') > 255)) throw refusal('unsafe_path', `${at}a file or folder name in relativePath is over 255 bytes; shorten it.`);
  if (rel.endsWith('.')) throw refusal('unsupported_import_format', `${at}relativePath cannot end with a dot; the name must end in .md.`);
  if (!rel.endsWith('.md')) {
    throw refusal('unsupported_import_format', /\.md$/i.test(rel)
      ? `${at}rename the extension to lowercase .md.`
      : `${at}only .md files can be imported. Leave attachments out; send text or JSON as Markdown (a \`\`\`json fence works) under a .md name.`);
  }
}
/** Check ancestors too. The tenant process is the only authorized vault writer. */
function safeTarget(root: string, rel: string): string {
  let current = fs.realpathSync(root);
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = fs.lstatSync(current);
      if (i < parts.length - 1 && (!stat.isDirectory() || stat.isSymbolicLink())) throw refusal('unsafe_path', 'Unsafe import destination ancestor');
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  return current;
}
function inspect(ctx: MemoryMapContext, plan: ImportPlan) {
  const conflicts: string[] = [];
  const unchangedPaths: string[] = [];
  for (const note of plan.notes) {
    const target = safeTarget(ctx.memoryDir, note.relPath);
    try {
      const stat = fs.lstatSync(target);
      // An empty file here is an interrupted earlier import's leftover: apply replaces it, so it is not a conflict.
      if (isEmptyLeftover(stat)) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(target, 'utf8') !== note.content) conflicts.push(note.relPath);
      else unchangedPaths.push(note.relPath);
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  return { conflicts, unchangedPaths, toWrite: plan.notes.length - unchangedPaths.length - conflicts.length };
}
function journalPath(ctx: MemoryMapContext, batchId: string): string {
  batchIdSchema.parse(batchId);
  const target = safeTarget(ctx.memoryDir, `${IMPORT_JOURNAL_DIR}/${batchId}.json`);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw refusal('unsafe_path', 'Unsafe import journal');
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  return target;
}
/** The sidecar log of a batch, beside its manifest (journalLog.ts). */
function journalLogPath(ctx: MemoryMapContext, batchId: string): string {
  return path.join(path.dirname(journalPath(ctx, batchId)), journalLogName(batchId));
}
function writeJournal(ctx: MemoryMapContext, manifest: Manifest) {
  const target = journalPath(ctx, manifest.batchId);
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  // Synced before the rename: the journal is what undo_import and a restart trust to name the notes this batch created.
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(manifest));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  // A manifest that is no longer applying holds every note, so the batch's log is only a duplicate of it now.
  if (manifest.state !== 'applying') removeJournalLog(path.join(path.dirname(target), journalLogName(manifest.batchId)));
}
function readJournal(ctx: MemoryMapContext, batchId: string): Manifest | undefined {
  try { return JSON.parse(fs.readFileSync(journalPath(ctx, batchId), 'utf8')) as Manifest; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw err; }
}
function manifests(ctx: MemoryMapContext): Manifest[] {
  const dir = safeTarget(ctx.memoryDir, '.renor-imports');
  try {
    return fs.readdirSync(dir).flatMap(name => {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) return [];
      return [JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Manifest];
    });
  } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
}
/** Dry run: bounded, expiring staging in tenant-local memory; no memory writes. */
export async function previewImport(ctx: MemoryMapContext, input: PreviewInput) {
  const parsed = z.object(importPreviewSchema).strict().parse(input);
  // "./notes/a.md" is the same file as "notes/a.md".
  const args = { ...parsed, files: parsed.files.map(file => ({ ...file, relativePath: file.relativePath.replace(/^(\.\/)+/, '') })) };
  const label = folderLabel(args.label);
  for (const prefix of [...(args.include ?? []), ...(args.exclude ?? [])]) {
    if (prefix.split('/').includes('..')) throw new Error('include/exclude prefixes are folder paths inside the import, like "Projects"; they cannot contain "..".');
  }
  let bytes = 0;
  const paths = new Set<string>();
  for (const [i, file] of args.files.entries()) {
    validatePath(file.relativePath, i);
    if (paths.has(file.relativePath)) throw refusal('duplicate_import_path', `files[${i}]: the same relativePath was sent twice; send each file once.`);
    paths.add(file.relativePath);
    const size = Buffer.byteLength(file.markdown, 'utf8');
    bytes += size + Buffer.byteLength(file.relativePath, 'utf8');
    if (size > IMPORT_LIMITS.fileBytes) throw refusal('import_too_large', `files[${i}]: over 64 KiB. Split it into several smaller .md files (by heading) or leave it out.`);
    if (bytes > IMPORT_LIMITS.batchBytes) throw refusal('import_too_large', 'Import is over 128 KiB in total, paths included. Send fewer files per call: call preview_import again for each group; every call gets its own batchId and applies on its own.');
    if (invalidUnicode(file.markdown)) throw refusal('invalid_text', `files[${i}]: the text has invalid Unicode; send plain UTF-8 Markdown.`);
    // A control character is refused as it is in a note or a statement (memory/controls.ts): the note is
    // written into the vault and indexed, so what the preview admits the workspace holds afterwards.
    try {
      assertNoUnstorableControls(`files[${i}] (${file.relativePath})`, file.markdown);
    } catch (err) {
      throw refusal('invalid_text', err instanceof Error ? err.message : String(err));
    }
  }
  const skipped: Array<{ relativePath: string; reason: string }> = [];
  const notes = args.files.flatMap(file => {
    if (file.relativePath.split('/').some(part => part.startsWith('.') || part === 'node_modules')) {
      skipped.push({ relativePath: file.relativePath, reason: "hidden or node_modules path (a name starts with '.'); to import it, resend under a path without the leading '.' folder, e.g. memory/note.md" }); return [];
    }
    if (!isSelected(file.relativePath, { include: args.include ?? [], exclude: args.exclude ?? [] })) {
      skipped.push({ relativePath: file.relativePath, reason: 'selection' }); return [];
    }
    if (isBlankOrInvisible(file.markdown)) { skipped.push({ relativePath: file.relativePath, reason: 'empty note' }); return []; }
    return [parseMarkdownImportNote(file.relativePath, file.relativePath, file.markdown, new Date().toISOString())];
  });
  const bundle: ImportBundle = {
    format: BUNDLE_FORMAT, sourceLabel: label, notes, facts: [],
    stats: { notesAvailable: args.files.length, notesSelected: notes.length, notesFilteredOut: skipped.length,
      notesWithOriginalBytes: notes.length, chunksSelected: notes.reduce((sum, note) => sum + note.chunks.length, 0), factsAvailable: 0, factsSelected: 0 },
  };
  const plan = buildImportPlan(bundle, { namespace: `Imported/${label}`, label, eventSource: 'import:markdown' });
  const { conflicts, unchangedPaths, toWrite } = inspect(ctx, plan);
  const report = { namespace: plan.namespace, counts: plan.counts, conflicts, unchanged: unchangedPaths.length, toWrite, skipped, limits: IMPORT_LIMITS,
    // RENOR_SECRET_GUARD on: the notes the plan left out because they look like a secret, by path and field, never text.
    ...(plan.skipped.secretGuard ? { secretGuard: plan.skipped.secretGuard } : {}) };
  // A check holds nothing: a reviewer can check every batch of a large import before choosing, which the
  // bounded staging below (8 previews, 15 minutes) could not hold, and the notes leave the process with the reply.
  // It also names the notes already there unchanged, so a reviewer is not offered them as new.
  if (args.stage === false) return { ok: true, staged: false, ...report, unchangedPaths };
  const previews = state(ctx.db).previews;
  for (const [id, preview] of previews) if (preview.expiresAt <= Date.now()) previews.delete(id);
  if (previews.size >= 8) throw refusal('too_many_previews', 'Too many pending previews (8). Call apply_import for one of them, or wait up to 15 minutes for the rest to expire.');
  const batchId = crypto.randomUUID();
  const expiresAt = Date.now() + PREVIEW_MS;
  previews.set(batchId, { bundle, plan, expiresAt });
  return { ok: true, batchId, expiresAt: new Date(expiresAt).toISOString(), ...report };
}
export function applyHostedImport(ctx: MemoryMapContext, batchId: string, storageLimitBytes?: number) {
  return serial(ctx.db, async () => {
    const existing = readJournal(ctx, batchId);
    if (existing?.state === 'applied') return { ok: true, batchId, ...existing.result };
    if (existing?.state === 'undone') throw refusal('batch_already_applied', 'This batch was undone. Call preview_import again for a new batchId.');
    if (existing) throw refusal('batch_already_applied', 'This batch did not finish applying and cannot be applied again. Call undo_import with this batchId, then preview_import again.');
    const preview = state(ctx.db).previews.get(batchId);
    if (!preview || preview.expiresAt <= Date.now()) throw refusal('batch_not_found', 'Preview missing or expired; preview this batch again');
    inspect(ctx, preview.plan);
    const manifest: Manifest = { batchId, state: 'applying', created: [], reasserted: [] };
    writeJournal(ctx, manifest);
    state(ctx.db).previews.delete(batchId);
    // Each note is logged as it is journalled (journalLog.ts); the manifest is rewritten in full once, when the batch ends.
    const log = new JournalLog(journalLogPath(ctx, batchId));
    try {
      const result = await applyImportPlan(preview.plan, preview.bundle, {
        memoryDir: ctx.memoryDir, dbPath: ctx.db.name, ledgerRelPath: ctx.ledgerRelPath,
        onNoteCreated(note) {
          manifest.created.push({ relPath: note.relPath, hash: note.contentHash });
          log.append({ list: 'created', relPath: note.relPath, hash: note.contentHash });
        },
        onNoteUnchanged(note) {
          manifest.reasserted!.push({ relPath: note.relPath, hash: note.contentHash });
          log.append({ list: 'reasserted', relPath: note.relPath, hash: note.contentHash });
        },
        ...(storageLimitBytes === undefined ? {} : { validateBeforeCommit: async () => {
          const bytes = await measureMarkdownBytes(ctx.memoryDir);
          if (bytes > storageLimitBytes) {
            throw new ImportStorageLimitError(`Renor: this workspace would store ${bytes.toLocaleString('en-US')} bytes of Markdown; the storage limit is ${storageLimitBytes.toLocaleString('en-US')} bytes. This memory write was not run.`);
          }
        } }),
      });
      log.close();
      manifest.result = result;
      manifest.state = 'applied';
      writeJournal(ctx, manifest);
      return { ok: true, batchId, ...result, recall: ctx.indexOptions.embeddingProvider && result.indexRows.chunksInserted > 0
        ? 'Keyword recall is ready through search_text. The new notes are embedded in the background: search by meaning finds them once memory_status says semantic: true. No structured facts were generated.'
        : 'Keyword recall is ready through search_text; no embeddings or structured facts were generated.' };
    } catch (err) {
      log.close(); manifest.state = 'failed'; writeJournal(ctx, manifest);
      if (err instanceof ImportStorageLimitError) throw refusal('storage_limit', err.message);
      throw err;
    }
  });
}
// The owner changed what is on disk since the import, or the secret guard will not move the note (it stays live):
// keep it and carry on undoing the rest of the batch.
const UNDO_PRESERVES = new Set([
  'imported note changed; preserved', 'memory path goes through a symbolic link', 'Unsafe import destination ancestor',
]);
type UndoTarget = { state: 'gone' } | { state: 'preserved' } | { state: 'file'; hash: string };
/** Files can change independently of the journal. Inspect them without letting one bad path abort the batch. */
function inspectUndoTarget(ctx: MemoryMapContext, relPath: string): UndoTarget {
  try {
    const target = safeTarget(ctx.memoryDir, relPath);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return { state: 'gone' };
    if (!stat.isFile() || stat.isSymbolicLink()) return { state: 'preserved' };
    const bytes = fs.readFileSync(target, 'utf8');
    return { state: 'file', hash: crypto.createHash('sha256').update(bytes, 'utf8').digest('hex') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'gone' };
    return { state: 'preserved' };
  }
}
/** Uses the existing journalled retirement, including FTS/vector removal. */
export function undoHostedImport(ctx: MemoryMapContext, batchId: string) {
  return serial(ctx.db, async () => {
    const manifest = readJournal(ctx, batchId);
    if (!manifest) throw refusal('batch_not_found', 'No applied batch has this batchId: it was only previewed (never applied), or it belongs to another workspace. undo_import only reverses an applied batch.');
    // A batch that crashed while applying keeps its notes in its log, not its manifest (journalLog.ts). They move into the
    // manifest before anything is undone, and the batch is then a failed one whose manifest is whole. A batch with no log
    // is left as it is: an older engine wrote its notes into the manifest itself.
    if (manifest.state === 'applying') {
      const logged = readJournalLog(journalLogPath(ctx, batchId));
      if (logged) {
        manifest.created = logged.filter(entry => entry.list === 'created').map(({ relPath, hash }) => ({ relPath, hash }));
        manifest.reasserted = logged.filter(entry => entry.list === 'reasserted').map(({ relPath, hash }) => ({ relPath, hash }));
        manifest.state = 'failed';
        writeJournal(ctx, manifest);
      }
    }
    const preserved: string[] = [];
    const preservedReasons: Record<string, string> = {};
    let retired = 0;
    const all = manifests(ctx);
    for (const note of manifest.created) {
      if (note.retired) continue;
      // A batch can find a created note unchanged only after its creator wrote it, so no wall-clock ordering field is
      // needed (and clock rollback cannot reverse ownership).
      const heldLater = all.some(other =>
        other.batchId !== batchId && other.state === 'applied'
        && other.reasserted?.some(item => !item.retired && item.relPath === note.relPath && item.hash === note.hash));
      if (heldLater) {
        const target = inspectUndoTarget(ctx, note.relPath);
        if (target.state === 'preserved') { preserved.push(note.relPath); continue; }
        if (target.state === 'file' && target.hash === note.hash) {
          preserved.push(note.relPath);
          preservedReasons[note.relPath] = 'kept: re-asserted by a later import';
          note.retired = true; // This creator released its assertion; the later batch now owns final retirement.
          writeJournal(ctx, manifest);
          continue;
        }
        if (target.state === 'gone') {
          note.retired = true;
          writeJournal(ctx, manifest);
          continue;
        }
      }
      let outcome: 'gone' | 'retired';
      try {
        const target = inspectUndoTarget(ctx, note.relPath);
        if (target.state === 'gone') outcome = 'gone';
        else if (target.state === 'preserved') { preserved.push(note.relPath); continue; }
        else { await retireMemory(ctx, `note:${note.relPath}`, note.hash); outcome = 'retired'; }
      } catch (err) {
        if (err instanceof SecretRefusedError || (err instanceof Error && UNDO_PRESERVES.has(err.message))) { preserved.push(note.relPath); continue; }
        throw err;
      }
      // Outside the try: a journal fault must abort the undo, never read as a preserved note.
      note.retired = true;
      if (outcome === 'retired') retired++;
      writeJournal(ctx, manifest);
    }
    for (const note of manifest.reasserted ?? []) {
      if (note.retired) continue;
      const creatorUndone = all.some(other => other.batchId !== batchId && other.state === 'undone'
        && other.created.some(item => item.relPath === note.relPath && item.hash === note.hash));
      const heldElsewhere = all.some(other => other.batchId !== batchId && other.state === 'applied'
        && other.reasserted?.some(item => !item.retired && item.relPath === note.relPath && item.hash === note.hash));
      if (creatorUndone && !heldElsewhere) {
        const target = inspectUndoTarget(ctx, note.relPath);
        if (target.state === 'preserved') { preserved.push(note.relPath); continue; }
        try {
          if (target.state === 'file') {
            await retireMemory(ctx, `note:${note.relPath}`, note.hash);
            retired++;
          }
        } catch (err) {
          if (err instanceof SecretRefusedError || (err instanceof Error && UNDO_PRESERVES.has(err.message))) {
            preserved.push(note.relPath);
            continue;
          }
          throw err;
        }
      }
      note.retired = true;
      writeJournal(ctx, manifest);
    }
    manifest.state = 'undone';
    writeJournal(ctx, manifest);
    return { ok: true, batchId, retired, preserved, ...(Object.keys(preservedReasons).length ? { preservedReasons } : {}), alreadyUndone: retired === 0 && preserved.length === 0 };
  });
}
