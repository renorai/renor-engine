/**
 * I6 ship gate, over the real MCP surfaces (synthetic fixtures only): with RENOR_HANDOFF_NOTE on, a handoff note is
 * written and read back through `handoff_note`, and no other tool ever returns it: get_context, search_memory,
 * search_text, retrieve_memory, lookup_entity, memory_map, read_memory, whats_new, search_history and export_memory on
 * the hosted engine (gateway-shaped and self-hosted), and every tool of the self-hosted stdio server (`renor-engine mcp`).
 * With the flag off the tool is not listed. The gateway-proxied run is tests/memory/gateway-handoff.test.ts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { openDb } from '../../src/db/client';
import { named, realStdioConnection, restoreEnv, startWorkspace, type Harness } from '../helpers/hiveHarness';
import { INSIDE, MARK, NOTE, REPO, everyReadReply } from '../helpers/handoffReads';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

afterAll(restoreEnv);

function expectNoNote(replies: Array<[string, string]>) {
  expect(replies.length).toBeGreaterThan(20);
  for (const [what, text] of replies) {
    expect(text, what).not.toContain(INSIDE);
    expect(text, what).not.toContain('run the parser tests');
  }
}

/** Only handoff_notes holds the note: no note, chunk, FTS, fact, entity or event row does. */
function expectOnlyHandoffTableHoldsIt(dbPath: string) {
  const db = openDb(dbPath);
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name);
    const holding: string[] = [];
    for (const table of tables) {
      let rows: unknown[];
      try { rows = db.prepare(`SELECT * FROM "${table}"`).all(); } catch { continue; }
      if (JSON.stringify(rows, (_k, v) => (Buffer.isBuffer(v) ? v.toString('latin1') : v)).includes(INSIDE)) holding.push(table);
    }
    expect(holding).toEqual(['handoff_notes']);
  } finally { db.close(); }
}

function markdownHolding(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (!/\.db(-wal|-shm)?$/.test(entry.name) && fs.readFileSync(p, 'latin1').includes(INSIDE)) found.push(p);
    }
  };
  walk(dir);
  return found;
}

async function seedAndWrite(ws: Harness, client: Client) {
  // Ordinary memory beside it, so the reads have something to return.
  expect((await ws.call(client, 'remember', { statement: 'The Fjord project stores its data in SQLite.' })).isError).toBe(false);
  expect((await ws.call(client, 'remember', { statement: 'Fjord parser', subject: 'Fjord', predicate: 'parser', object: 'hand-written' })).isError).toBe(false);
  const wrote = await ws.call(client, 'handoff_note', { action: 'write', repo: REPO, branch: 'main', note: NOTE });
  expect(wrote.isError, wrote.raw).toBe(false);
  expect(wrote.body).toMatchObject({ ok: true, action: 'write', repo: 'remote:github.com/acme/fjord', branch: 'main' });
  expect((await ws.call(client, 'index_memory', {})).isError).toBe(false);
}

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('handoff_note on the hosted engine', () => {
  it('is not listed, and not callable, with RENOR_HANDOFF_NOTE unset (default off)', async () => {
    delete process.env.RENOR_HANDOFF_NOTE;
    const ws = await startWorkspace();
    try {
      const client = await ws.connect(named('claude-code'));
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).not.toContain('handoff_note');
      const res = await client.callTool({ name: 'handoff_note', arguments: { action: 'read', repo: REPO, branch: 'main' } }).catch(err => ({ isError: true, err }));
      expect((res as { isError?: boolean }).isError).toBe(true);
      await client.close();
    } finally { await ws.close(); }
  });

  for (const selfHosted of [false, true]) {
    it(`${selfHosted ? 'self-hosted' : 'gateway-shaped'}: written and read back by repo and branch; no other read tool returns it`, async () => {
      process.env.RENOR_HANDOFF_NOTE = '1';
      const ws = await startWorkspace({ selfHosted });
      try {
        const headers = selfHosted ? {} : named('claude-code');
        const writer = await ws.connect(headers, selfHosted ? 'claude-code' : undefined);
        await seedAndWrite(ws, writer);
        const reader = await ws.connect(selfHosted ? {} : named('codex'), selfHosted ? 'codex' : undefined);

        const read = await ws.call(reader, 'handoff_note', { action: 'read', repo: 'https://github.com/acme/fjord', branch: 'main' });
        expect(read.body).toMatchObject({ found: true, note: NOTE, writer: selfHosted ? 'claude-code' : 'claude-code' });
        expect(read.body.shown).toMatch(/^Handoff note for main, written \d{4}-\d\d-\d\d \d\d:\d\d UTC \(today\) by claude-code\./);
        expect((await ws.call(reader, 'handoff_note', { action: 'read', repo: REPO, branch: 'feature/x' })).body.found).toBe(false);
        expect((await ws.call(reader, 'handoff_note', { action: 'read', repo: 'git@github.com:acme/other.git', branch: 'main' })).body.found).toBe(false);

        for (const client of [writer, reader]) expectNoNote(await everyReadReply(client));
        expectOnlyHandoffTableHoldsIt(ws.config.dbPath);
        expect(markdownHolding(ws.memoryDir)).toEqual([]);

        // Control: the same words saved as a memory ARE found by these reads, so the absence above is not a blind check.
        // search_memory is semantic only, and this workspace has no embedding provider, so it returns no hits to anyone;
        // its path is covered by the stdio run below (eval-hash vectors) and by the table scan (no chunk holds the note).
        await ws.call(writer, 'remember', { statement: 'Control otterline: the Fjord parser refactor is planned.' });
        const control = (await everyReadReply(writer, ['otterline'])).filter(([, text]) => text.includes('otterline')).map(([what]) => what.split(' ')[0]);
        for (const tool of ['get_context', 'search_text', 'memory_map', 'read_memory', 'export_memory']) expect(control).toContain(tool);

        // Overwrite: still one note, the new one.
        await ws.call(reader, 'handoff_note', { action: 'write', repo: REPO, branch: 'main', note: `Replaced ${INSIDE}: tests pass, next the docs.` });
        const after = await ws.call(writer, 'handoff_note', { action: 'read', repo: REPO, branch: 'main' });
        expect(after.body).toMatchObject({ found: true, writer: selfHosted ? 'codex' : 'codex' });
        expect(after.body.note).not.toContain('halfway');
        const db = openDb(ws.config.dbPath);
        try { expect(db.prepare('SELECT COUNT(*) AS c FROM handoff_notes').get()).toEqual({ c: 1 }); } finally { db.close(); }

        // Refusals say why and write nothing.
        const long = await ws.call(writer, 'handoff_note', { action: 'write', repo: REPO, branch: 'main', note: Array(201).fill('word').join(' ') });
        expect(long.isError).toBe(true);
        expect(long.raw).toMatch(/201 words; at most 200/);
        await writer.close(); await reader.close();
      } finally { await ws.close(); delete process.env.RENOR_HANDOFF_NOTE; }
    }, 60_000);
  }
});

describe('handoff_note on the self-hosted stdio server (renor-engine mcp, built dist/cli.js)', () => {
  it('listed only with the flag; written and read back; no stdio search or read tool returns it', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-stdio-'));
    try {
      const off = await realStdioConnection(vault, 'claude-code');
      try {
        expect(await off.listTools()).not.toContain('handoff_note');
        expect((await off.call('handoff_note', { action: 'read', repo: REPO, branch: 'main' })).isError).toBe(true);
      } finally { await off.close(); }

      const on = await realStdioConnection(vault, 'claude-code', { RENOR_HANDOFF_NOTE: '1' });
      try {
        expect(await on.listTools()).toContain('handoff_note');
        expect((await on.call('note', { text: 'The Fjord project stores its data in SQLite.' })).isError).toBe(false);
        expect((await on.call('remember_fact', { subject: 'Fjord', predicate: 'parser', object: 'hand-written' })).isError).toBe(false);
        const wrote = await on.call('handoff_note', { action: 'write', repo: REPO, branch: 'main', note: NOTE });
        expect(wrote.isError, wrote.raw).toBe(false);
        const read = await on.call('handoff_note', { action: 'read', repo: 'https://github.com/acme/fjord.git', branch: 'main' });
        expect(read.body).toMatchObject({ found: true, note: NOTE, writer: 'claude-code' });
        expect((await on.call('handoff_note', { action: 'read', repo: REPO, branch: 'dev' })).body.found).toBe(false);
        const replies: Array<[string, string]> = [];
        for (const query of [MARK, 'Fjord parser next step', 'handoff note']) {
          for (const name of ['search', 'keyword', 'evidence']) replies.push([`${name} ${query}`, (await on.call(name, { query })).raw]);
        }
        for (const name of ['Fjord', MARK]) {
          replies.push([`entity ${name}`, (await on.call('entity', { name })).raw]);
          replies.push([`facts ${name}`, (await on.call('facts', { entityName: name })).raw]);
        }
        replies.push(['status', (await on.call('status', {})).raw]);
        replies.push(['whats_new', (await on.call('whats_new', { include_own: true })).raw]);
        for (const [what, text] of replies) {
          expect(text, what).not.toContain(INSIDE);
          expect(text, what).not.toContain('run the parser tests');
        }
      } finally { await on.close(); }
      expectOnlyHandoffTableHoldsIt(path.join(vault, '.semantic-memory', 'index.db'));
      expect(markdownHolding(vault)).toEqual([]);
    } finally { fs.rmSync(vault, { recursive: true, force: true }); }
  }, 60_000);
});
