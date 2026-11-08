import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { startWorkspace, restoreWorkspaceEnv, type Workspace } from '../helpers/mvpWorkspace';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * STANDING TEST (adv-crashsafe-1012, F5). apply_import used to create each note with an exclusive open and only then
 * journal and write it, so a SIGKILL in that window left a 0-byte file that no journal named. The same import sent again
 * then reported the note as a "conflict" and never wrote it; undo_import could not remove it, and the only way out was
 * retire_memory on a path nobody mentioned. The note is still created with an exclusive open, and the containment check
 * runs on that handle before any byte is written (a temp file and hard link would put the bytes in a different inode from
 * the one checked). So a kill between the create and the write still leaves an empty note at the planned path; a retry
 * now adopts such an empty leftover (openEmptyLeftover) and writes it, instead of reporting a conflict. An empty file the
 * retry cannot open for writing (EACCES) is still a conflict, and so is any hard-linked or symlinked file.
 * The leftover is reproduced by creating the empty file the way the killed apply left it.
 */
let ws: Workspace | undefined;
afterEach(async () => { await ws?.close(); ws = undefined; restoreWorkspaceEnv(); });

describe('an import retried after a crash left an empty note at its path', () => {
  it.skipIf(HTTP_SERVER_UNSUPPORTED)('writes the note instead of reporting it as a conflict with an empty file', async () => {
    ws = await startWorkspace(() => null);
    const dir = path.join(ws.memoryDir, 'Imported/rt/a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'two.md'), '');
    const files = [{ relativePath: 'a/one.md', markdown: '# One\n\nretry zebra1\n' }, { relativePath: 'a/two.md', markdown: '# Two\n\nretry zebra2\n' }];
    const preview = await ws.call('preview_import', { label: 'rt', files });
    expect(preview.body.conflicts).toEqual([]);
    const applied = await ws.call('apply_import', { batchId: preview.body.batchId });
    expect(applied.body.notesConflicting).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'two.md'), 'utf8')).toContain('zebra2');
  });

  it('reports an empty leftover it cannot open for writing as a conflict, and writes the rest', async ({ skip }) => {
    if (process.getuid?.() === 0) skip('requires a non-root process so file permissions deny writes');
    ws = await startWorkspace(() => null);
    const dir = path.join(ws.memoryDir, 'Imported/rt/c');
    fs.mkdirSync(dir, { recursive: true });
    const locked = path.join(dir, 'one.md');
    fs.writeFileSync(locked, '');
    fs.chmodSync(locked, 0o400);
    const files = [{ relativePath: 'c/one.md', markdown: '# One\n\nlocked zebra4\n' }, { relativePath: 'c/two.md', markdown: '# Two\n\nlocked zebra5\n' }];
    try {
      const preview = await ws.call('preview_import', { label: 'rt', files });
      const applied = await ws.call('apply_import', { batchId: preview.body.batchId });
      expect(applied.body.notesConflicting).toBe(1);
      expect(fs.readFileSync(path.join(dir, 'two.md'), 'utf8')).toContain('zebra5');
      expect(fs.readFileSync(locked, 'utf8')).toBe('');
    } finally {
      fs.chmodSync(locked, 0o644);
    }
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('does not adopt an empty leftover that is hard-linked to a file outside the memory directory', async () => {
    ws = await startWorkspace(() => null);
    const dir = path.join(ws.memoryDir, 'Imported/rt/b');
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(path.dirname(ws.memoryDir), 'shared-empty.md');
    fs.writeFileSync(outside, '');
    fs.linkSync(outside, path.join(dir, 'one.md'));
    const files = [{ relativePath: 'b/one.md', markdown: '# One\n\nlink zebra3\n' }];
    const preview = await ws.call('preview_import', { label: 'rt', files });
    const applied = await ws.call('apply_import', { batchId: preview.body.batchId });
    expect(applied.body.notesConflicting).toBe(1);
    expect(fs.readFileSync(outside, 'utf8')).toBe('');
    expect(fs.readFileSync(path.join(dir, 'one.md'), 'utf8')).toBe('');
  });
});
