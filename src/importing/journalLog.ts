import fs from 'fs';
import path from 'path';
import { refusal } from '../toolRefusal';
import { syncDirectorySync } from '../memory/durableAppend';

/**
 * The import journal's sidecar: `.renor-imports/<batchId>.jsonl`, one line per note a batch created or re-asserted.
 *
 * A batch that is applying writes each note here as the note is journalled: one short append and one fsync. The batch's
 * manifest (`<batchId>.json`) still says `applying` and holds no notes. When the batch finishes, or fails, the manifest is
 * rewritten in full with every note and this log is removed (hosted.ts). A finished batch is therefore one JSON file, as it
 * was before, and only a batch that did not finish is a manifest plus a log. The old whole-manifest rewrite per note cost
 * bytes that grew with the square of the batch.
 *
 * Crash: a line counts once its newline is on disk. A crash in the middle of a line leaves a cut last line, which is ignored:
 * the note it names is the one being written, outside the journal, exactly as with the rewrite. A complete line that does not
 * parse is not a cut, so it is an error: undo_import stops before it changes anything, rather than leave a note it cannot name.
 */
export type JournalListName = 'created' | 'reasserted';
export interface JournalLogEntry { list: JournalListName; relPath: string; hash: string }

/** The log's file name for a batch, beside its manifest. */
export function journalLogName(batchId: string): string {
  return `${batchId}.jsonl`;
}

/** Opened on the first append, so a batch that writes no note creates no file. Each line is fsynced before the next. */
export class JournalLog {
  private fd: number | null = null;

  constructor(private readonly file: string) {}

  append(entry: JournalLogEntry): void {
    if (this.fd === null) this.fd = openLog(this.file);
    const bytes = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
    for (let done = 0; done < bytes.length;) done += fs.writeSync(this.fd, bytes, done, bytes.length - done);
    fs.fsyncSync(this.fd);
  }

  /** Idempotent. The bytes were fsynced when they were appended, so a failed close loses nothing. */
  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try { fs.closeSync(fd); } catch { /* every appended line is already on disk */ }
  }
}

function openLog(file: string): number {
  const isNew = !fs.existsSync(file);
  // O_NOFOLLOW: a log reached through a symbolic link is refused, as a manifest is.
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(file, flags, 0o600);
  if (isNew) {
    // The new name is durable before its first line is acknowledged.
    // On Windows a directory cannot be fsynced and NTFS already journals the new name: syncDirectorySync says so (#1563).
    syncDirectorySync(path.dirname(file));
  }
  return fd;
}

/** The log's entries in the order they were appended, or undefined when the batch has no log. */
export function readJournalLog(file: string): JournalLogEntry[] | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw refusal('unsafe_path', 'Unsafe import journal');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  // The text after the last newline: empty when the log ends whole, otherwise the cut line a crash left.
  lines.pop();
  return lines.map((line, i) => parseEntry(line, i + 1));
}

function parseEntry(line: string, lineNo: number): JournalLogEntry {
  let value: Partial<JournalLogEntry> | undefined;
  try { value = JSON.parse(line) as Partial<JournalLogEntry>; } catch { value = undefined; }
  if (!value || (value.list !== 'created' && value.list !== 'reasserted') || typeof value.relPath !== 'string' || typeof value.hash !== 'string') {
    throw new Error(`an import journal line (${lineNo}) cannot be read; undo_import stopped before changing anything`);
  }
  return { list: value.list, relPath: value.relPath, hash: value.hash };
}

/**
 * Removes a log that no longer records an applying batch. Best effort: a finished batch's manifest holds the same notes,
 * so a log that survives a crash is ignored by every reader of that batch.
 */
export function removeJournalLog(file: string): void {
  try { fs.unlinkSync(file); } catch { /* absent, or left for the next manifest rewrite to remove */ }
}
