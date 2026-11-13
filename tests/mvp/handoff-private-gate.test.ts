/**
 * I6 private gate, for firstmate on the owner's laptop. Skipped unless RENOR_HANDOFF_PRIVATE_DIR names a memory folder.
 * Nothing here reads the original: the folder is copied to a temp directory, the copy is served by the hosted engine
 * with RENOR_HANDOFF_NOTE on, a synthetic handoff note is written into the copy, and every read path is run with the
 * built-in queries plus each line of RENOR_HANDOFF_PRIVATE_QUERIES (the owner's own wording, one query per line). The
 * copy is deleted afterwards. It prints one line, `HANDOFF-PRIVATE-GATE replies=<n> leaks=<k>`, and passes only at 0
 * leaks. No memory text is printed; only the tool and arguments of a leaking reply.
 *
 *   cd engine && RENOR_HANDOFF_PRIVATE_DIR=~/path/to/memory RENOR_HANDOFF_PRIVATE_QUERIES=~/path/to/queries.txt \
 *     npx vitest run tests/mvp/handoff-private-gate.test.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { named, restoreEnv, startWorkspace } from '../helpers/hiveHarness';
import { INSIDE, NOTE, REPO, everyReadReply } from '../helpers/handoffReads';
import { removeTempDirsAfterAll } from '../helpers/tmpCleanup';

removeTempDirsAfterAll();

afterAll(restoreEnv);
const SOURCE = process.env.RENOR_HANDOFF_PRIVATE_DIR;
const QUERIES = process.env.RENOR_HANDOFF_PRIVATE_QUERIES;

describe.skipIf(!SOURCE)('handoff note: private gate on a copy of a real workspace', () => {
  it('no read path returns the note', async () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-private-'));
    fs.cpSync(SOURCE!, copy, { recursive: true });
    const queries = QUERIES ? fs.readFileSync(QUERIES, 'utf8').split('\n').map(q => q.trim()).filter(Boolean) : [];
    process.env.RENOR_HANDOFF_NOTE = '1';
    const ws = await startWorkspace({ memoryDir: copy });
    try {
      const client = await ws.connect(named('firstmate-gate'));
      expect((await ws.call(client, 'handoff_note', { action: 'write', repo: REPO, branch: 'main', note: NOTE })).isError).toBe(false);
      expect((await ws.call(client, 'index_memory', {})).isError).toBe(false);
      const replies = await everyReadReply(client, queries);
      const leaks = replies.filter(([, text]) => text.includes(INSIDE)).map(([what]) => what);
      process.stderr.write(`HANDOFF-PRIVATE-GATE replies=${replies.length} leaks=${leaks.length}\n`);
      expect(leaks).toEqual([]);
      await client.close();
    } finally { await ws.close(); delete process.env.RENOR_HANDOFF_NOTE; }
  }, 600_000);
});
