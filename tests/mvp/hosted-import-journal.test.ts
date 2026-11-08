import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startWorkspace, restoreWorkspaceEnv, type Workspace } from '../helpers/mvpWorkspace';
import { IMPORT_JOURNAL_DIR, forgetImportedNotes } from '../../src/importing/forgetImported';
import { journalLogName } from '../../src/importing/journalLog';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * The import journal of a batch that applied, or did not finish applying (hosted.ts, journalLog.ts). Every reader that
 * reads the journal sees the notes a batch created, however the batch ended: as one whole manifest, as a manifest an
 * older engine wrote with its notes in it, or as a manifest that says applying plus the log a crash left beside it.
 */
let ws: Workspace | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await ws?.close();
  ws = undefined;
  restoreWorkspaceEnv();
});

const notes = [1, 2, 3].map(n => ({ relativePath: `a/note-${n}.md`, markdown: `# Note ${n}\n\njournal zebra${n}\n` }));
const journalDir = () => path.join(ws!.memoryDir, IMPORT_JOURNAL_DIR);
const notePath = (n: number) => path.join(ws!.memoryDir, 'Imported', 'crash', 'a', `note-${n}.md`);
const manifestOf = (batchId: string) => JSON.parse(fs.readFileSync(path.join(journalDir(), `${batchId}.json`), 'utf8')) as {
  state: string; created: Array<{ relPath: string; hash: string; retired?: boolean }>; reasserted?: unknown[]; result?: unknown;
};

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the import journal of a batch', () => {
  it('leaves one whole manifest when it applied, and no log', async () => {
    ws = await startWorkspace(() => null);
    const preview = await ws.call('preview_import', { label: 'crash', files: notes });
    const batchId = preview.body.batchId as string;
    const applied = await ws.call('apply_import', { batchId });
    expect(applied.body.notesWritten).toBe(3);
    expect(fs.readdirSync(journalDir())).toEqual([`${batchId}.json`]);
    const manifest = manifestOf(batchId);
    expect(manifest.state).toBe('applied');
    expect(manifest.created.map(n => n.relPath)).toEqual(notes.map(n => `Imported/crash/${n.relativePath}`));
  });

  it('after a crash cut the second note\'s line, the first note is journalled and the cut note is outside the journal', async () => {
    ws = await startWorkspace(() => null);
    const preview = await ws.call('preview_import', { label: 'crash', files: notes });
    const batchId = preview.body.batchId as string;
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-crash-'));
    const realWrite = fs.writeSync.bind(fs) as unknown as (fd: number, buffer: Buffer, offset: number, length: number) => number;
    let lines = 0;
    // The crash is injected in the append itself: half of the second line reaches the disk, and what is on disk is copied
    // at that moment, before the engine's own rollback runs.
    const spy = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buffer: any, offset: any, length: any) => {
      const isLogLine = Buffer.isBuffer(buffer) && buffer.toString('utf8', offset, offset + length).startsWith('{"list":');
      if (!isLogLine || ++lines !== 2) return realWrite(fd, buffer, offset, length);
      realWrite(fd, buffer, offset, Math.floor(length / 2));
      fs.cpSync(path.join(ws!.memoryDir, 'Imported'), path.join(snapshot, 'Imported'), { recursive: true });
      fs.cpSync(journalDir(), path.join(snapshot, IMPORT_JOURNAL_DIR), { recursive: true });
      throw new Error('simulated crash');
    }) as typeof fs.writeSync);
    const failed = await ws.callRaw('apply_import', { batchId });
    spy.mockRestore();
    expect(failed.isError).toBe(true);
    // Put back what was on disk at the crash, not the state the rollback of the failed apply left.
    fs.rmSync(path.join(ws.memoryDir, 'Imported'), { recursive: true, force: true });
    fs.cpSync(path.join(snapshot, 'Imported'), path.join(ws.memoryDir, 'Imported'), { recursive: true });
    fs.rmSync(journalDir(), { recursive: true, force: true });
    fs.cpSync(path.join(snapshot, IMPORT_JOURNAL_DIR), journalDir(), { recursive: true });
    fs.rmSync(snapshot, { recursive: true, force: true });

    expect(manifestOf(batchId).state).toBe('applying');
    const log = fs.readFileSync(path.join(journalDir(), journalLogName(batchId)), 'utf8');
    expect(log.endsWith('\n')).toBe(false);
    expect(log.split('\n')[0]).toContain('Imported/crash/a/note-1.md');
    expect(fs.readFileSync(notePath(2), 'utf8')).toBe(''); // created, not journalled: the one note outside the journal

    const undone = await ws.call('undo_import', { batchId });
    expect(undone.body.retired).toBe(1);
    expect(fs.existsSync(notePath(1))).toBe(false);
    expect(fs.existsSync(notePath(2))).toBe(true); // outside the journal, so undo leaves it alone
    expect(manifestOf(batchId).state).toBe('undone');
    expect(fs.readdirSync(journalDir())).toEqual([`${batchId}.json`]);
    const again = await ws.callRaw('apply_import', { batchId });
    expect(again.isError).toBe(true);
  });

  it('whose manifest an older engine left applying, with its notes in it and no log, is undone from those notes', async () => {
    ws = await startWorkspace(() => null);
    const preview = await ws.call('preview_import', { label: 'crash', files: notes });
    const batchId = preview.body.batchId as string;
    await ws.call('apply_import', { batchId });
    const { created } = manifestOf(batchId);
    // The shape an older engine left when it stopped while applying: the notes in the manifest, the state still applying.
    fs.writeFileSync(path.join(journalDir(), `${batchId}.json`), JSON.stringify({ batchId, state: 'applying', created, reasserted: [] }));
    const undone = await ws.call('undo_import', { batchId });
    expect(undone.body.retired).toBe(3);
    expect(notes.every((_, i) => !fs.existsSync(notePath(i + 1)))).toBe(true);
    expect(manifestOf(batchId).state).toBe('undone');
  });

  it('whose log has a damaged complete line stops undo before it retires anything', async () => {
    ws = await startWorkspace(() => null);
    const preview = await ws.call('preview_import', { label: 'crash', files: notes });
    const batchId = preview.body.batchId as string;
    await ws.call('apply_import', { batchId });
    fs.writeFileSync(path.join(journalDir(), `${batchId}.json`), JSON.stringify({ batchId, state: 'applying', created: [], reasserted: [] }));
    fs.writeFileSync(path.join(journalDir(), journalLogName(batchId)),
      `${JSON.stringify({ list: 'created', relPath: 'Imported/crash/a/note-1.md', hash: 'x' })}\nnot a journal line\n`);
    const refused = await ws.callRaw('undo_import', { batchId });
    expect(refused.isError).toBe(true);
    expect(refused.texts.join(' ')).toContain('undo_import stopped before changing anything');
    expect(fs.existsSync(notePath(1))).toBe(true);
    expect(manifestOf(batchId).state).toBe('applying');
  });

  it('whose log is removed when forget rewrites its manifest, so a path forget removed does not survive in the journal directory', async () => {
    ws = await startWorkspace(() => null);
    const preview = await ws.call('preview_import', { label: 'crash', files: notes });
    const batchId = preview.body.batchId as string;
    await ws.call('apply_import', { batchId });
    const logFile = path.join(journalDir(), journalLogName(batchId));
    const { created } = manifestOf(batchId);
    fs.writeFileSync(logFile, created.map(n => `${JSON.stringify({ list: 'created', relPath: n.relPath, hash: n.hash })}\n`).join(''));
    await forgetImportedNotes(ws.memoryDir, new Set(['Imported/crash/a/note-2.md']));
    expect(manifestOf(batchId).created.map(n => n.relPath)).toEqual(['Imported/crash/a/note-1.md', 'Imported/crash/a/note-3.md']);
    expect(fs.existsSync(logFile)).toBe(false);
  });
});
