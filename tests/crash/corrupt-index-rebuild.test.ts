import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { factsFor, resolveLedgerPath } from '../../src/memory/lifecycle';
import { startWorkspace, restoreWorkspaceEnv, authorize, type Workspace } from '../helpers/mvpWorkspace';

/**
 * STANDING TEST (adv-crashsafe-1012, F4). The index is documented as derived and rebuildable from the ledger and the
 * Markdown ("Derived index ... rebuildable from the ledger", mvp/cli.ts), and a MISSING index.db does rebuild. A damaged
 * one (torn by a full disk or a bad write) used to make start-up throw "database disk image is malformed" / "file is not
 * a database", so the unit crash-looped until someone deleted index.db by hand. Now a damaged index is set aside, with its
 * bytes kept, and rebuilt exactly like a missing one. The ledger is never touched. The check that the rebuild lost nothing
 * is export_memory: byte-identical to the export taken before the damage. The pending agent requests, the what's-new
 * cursors and the known connection names are NOT in the ledger, so they are read out of the damaged file and written back.
 */
type Started = Awaited<ReturnType<typeof startMvpService>>;

let ws: Workspace | undefined;
let restarted: Started | undefined;
// These tests compare two whole exports; at the shipped sharing default the export also carries a learning log stamped with its own export time.
beforeEach(() => { process.env.RENOR_SHARING_DEFAULT = 'off'; });
afterEach(async () => {
  delete process.env.RENOR_SHARING_DEFAULT;
  if (restarted) await stopService(restarted).catch(() => undefined);
  await ws?.close().catch(() => undefined);
  ws = undefined;
  restarted = undefined;
  restoreWorkspaceEnv();
});

async function stopService(service: { httpServer: import('http').Server; close(): Promise<void> }): Promise<void> {
  service.httpServer.closeAllConnections?.();
  await new Promise<void>(resolve => service.httpServer.close(() => resolve()));
  await service.close();
}

/**
 * The whole export_memory reply (manifest and document), asked of a running service over its own MCP endpoint. Each call
 * registers its own OAuth client name: the owner's client store refuses a second registration under one name.
 */
async function exportFrom(service: Pick<Started, 'app'>, port: number, label: string): Promise<string> {
  const token = await authorize(service.app, `export-${label}`);
  const client = new Client({ name: 'corrupt-index-test', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${port}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  try {
    const res = await client.callTool({ name: 'export_memory', arguments: {} });
    expect(res.isError).not.toBe(true);
    return JSON.stringify(res.content);
  } finally {
    await client.close();
  }
}

/** The set-aside index files: `index.db.corrupt-<stamp>` and the `-wal`/`-shm` moved beside it. Only the main file is listed here. */
function asideFiles(dbPath: string): string[] {
  const dir = path.dirname(dbPath);
  const base = `${path.basename(dbPath)}.corrupt-`;
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(base) && !f.endsWith('-wal') && !f.endsWith('-shm'))
    .map(f => path.join(dir, f));
}

const DAMAGES = [
  ['truncated to half its size', (f: string) => fs.truncateSync(f, Math.floor(fs.statSync(f).size / 2))],
  ['its header overwritten', (f: string) => { const b = fs.readFileSync(f); b.fill(0x41, 0, 200); fs.writeFileSync(f, b); }],
] as const;

for (const [name, damage] of DAMAGES) {
  describe(`an index.db ${name}`, () => {
    it('is set aside with its bytes kept, rebuilt from the ledger, and the export is byte-identical', async () => {
      ws = await startWorkspace(() => null);
      await ws.call('save_memory', { subject: 'Cardamom canary', predicate: 'value', object: 'cardamom1' });
      await ws.call('remember_note', { text: 'index damage canary cardamom2' });
      await ws.call('index_memory', {});
      const before = await exportFrom(ws.service, ws.config.port, 'before');
      await stopService(ws.service);

      const dbPath = ws.config.dbPath;
      const ledgerPath = resolveLedgerPath(ws.config.memoryDir, ws.config.ledgerRelPath);
      const ledgerBefore = fs.readFileSync(ledgerPath);
      for (const side of ['-wal', '-shm']) fs.rmSync(dbPath + side, { force: true });
      damage(dbPath);
      const damaged = fs.readFileSync(dbPath);

      restarted = await startMvpService(ws.config, null);   // today: rejects with the SQLite error
      expect(restarted.httpServer.listening).toBe(true);

      const asides = asideFiles(dbPath);
      expect(asides).toHaveLength(1);
      expect(fs.readFileSync(asides[0])).toEqual(damaged);
      expect(factsFor(restarted.db, 'Cardamom canary')).toHaveLength(1);
      expect(fs.readFileSync(ledgerPath)).toEqual(ledgerBefore);
      expect(await exportFrom(restarted, ws.config.port, 'after')).toBe(before);
    });
  });
}

describe('an index.db damaged with pending agent requests in it', () => {
  it('writes the requests, cursors and known connections back into the rebuilt index', async () => {
    ws = await startWorkspace(() => null);
    const db = ws.service.db;
    db.prepare(`INSERT INTO known_agents (agent, first_seen) VALUES ('claude-code', '2026-10-12T00:00:00Z')`).run();
    db.prepare(`INSERT INTO agent_requests (id, scope, from_agent, to_agent, question, status, created_at)
      VALUES ('req-1', 'default', 'claude-code', 'codex', 'is the export still identical?', 'open', '2026-10-12T00:00:01Z')`).run();
    db.prepare(`INSERT INTO agent_cursors (agent, scope, last_at, last_id) VALUES ('codex', 'default', '2026-10-12T00:00:02Z', 7)`).run();
    // Rows in a table the salvage does not read, so its pages can be damaged without touching the schema.
    for (let n = 0; n < 60; n++) {
      db.prepare(`INSERT INTO write_events (note_path, action, summary, created_at) VALUES ('p', 'a', ?, '2026-10-12T00:00:03Z')`).run(`v${n} ${'v'.repeat(1200)}`);
    }
    await ws.call('save_memory', { subject: 'Cardamom canary', predicate: 'value', object: 'cardamom1' });
    const before = await exportFrom(ws.service, ws.config.port, 'before');
    // The service also records each OAuth client name it has seen here, so compare with what the index held, not a literal.
    const knownBefore = db.prepare('SELECT agent FROM known_agents ORDER BY agent').all();
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const eventsRoot = (db.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'write_events'`).get() as { rootpage: number }).rootpage;
    await stopService(ws.service);

    const dbPath = ws.config.dbPath;
    // Overwrite the write_events root page: the file is still a database, its schema and the three tables still read.
    const fd = fs.openSync(dbPath, 'r+');
    fs.writeSync(fd, Buffer.alloc(pageSize, 0x41), 0, pageSize, (eventsRoot - 1) * pageSize);
    fs.closeSync(fd);

    restarted = await startMvpService(ws.config, null);
    expect(restarted.httpServer.listening).toBe(true);
    expect(asideFiles(dbPath)).toHaveLength(1);
    expect(restarted.db.prepare('SELECT id, from_agent, to_agent, status FROM agent_requests').all())
      .toEqual([{ id: 'req-1', from_agent: 'claude-code', to_agent: 'codex', status: 'open' }]);
    expect(restarted.db.prepare('SELECT agent, scope, last_id FROM agent_cursors').all())
      .toEqual([{ agent: 'codex', scope: 'default', last_id: 7 }]);
    expect(knownBefore).toContainEqual({ agent: 'claude-code' });
    expect(restarted.db.prepare('SELECT agent FROM known_agents ORDER BY agent').all()).toEqual(knownBefore);
    expect(factsFor(restarted.db, 'Cardamom canary')).toHaveLength(1);
    expect(await exportFrom(restarted, ws.config.port, 'after')).toBe(before);
  });
});

describe('an index.db damaged with no ledger to rebuild it from', () => {
  it('is not moved aside, and start-up refuses', async () => {
    ws = await startWorkspace(() => null);
    await ws.call('index_memory', {});
    await stopService(ws.service);
    const dbPath = ws.config.dbPath;
    fs.rmSync(resolveLedgerPath(ws.config.memoryDir, ws.config.ledgerRelPath), { force: true });
    fs.truncateSync(dbPath, Math.floor(fs.statSync(dbPath).size / 2));
    const damaged = fs.readFileSync(dbPath);

    await expect(startMvpService(ws.config, null)).rejects.toThrow(/no ledger to rebuild it from/);
    expect(fs.readFileSync(dbPath)).toEqual(damaged);
    expect(fs.readdirSync(path.dirname(dbPath)).filter(f => f.includes('.corrupt-'))).toHaveLength(0);
  });
});
