import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember } from '../../src/memory/lifecycle';
import { ledgerEventIds } from '../../src/retrieval/ledgerLiveness';
import { createReadScope, type ScopedHit } from '../../src/mvp/readScope';
import { traceStatements } from '../helpers/traceStatements';
import { removeTestDir } from '../helpers/removeDb';

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];

const openDbs: Database.Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) removeTestDir(d);
});

/** A database with one event per scope for the same subject and predicate, plus a closed one in scope:work. */
async function fixture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'read-scope-'));
  tmpDirs.push(vault);
  const db: Database.Database = openDb(path.join(vault, 'index.db'));
  openDbs.push(db);
  runMigrations(db);
  const save = async (object: string, scope?: string) =>
    (await remember(db, vault, LEDGER, { subject: 'meeting', predicate: 'time', object, ...(scope ? { scope } : {}) })).eventId;
  const workOld = await save('WORKOLD', 'scope:work');
  const work = await save('WORKNEW', 'scope:work');
  const launch = await save('LAUNCHNEW', 'project:launch');
  const global = await save('GLOBALNEW');
  const factId = (event: string) => (db.prepare('SELECT id FROM facts WHERE event_id = ?').get(event) as { id: number }).id;
  return { db, vault, workOld, work, launch, global, factId };
}

const block = (id: string, object: string) =>
  `## ${id} · 2026-10-02T00:00:00.000Z\n- kind: store\n- subject: meeting\n- predicate: time\n- object: ${object}\n- source: test\n`;
const hit = (over: Partial<ScopedHit> & { text: string }): ScopedHit => ({ notePath: 'System/Memory Events Ledger.md', ...over });
const sameNotePath = (h: ScopedHit) => h.notePath;

describe('ledgerEventIds', () => {
  it('lists the ids on event headers, lower-cased, in order', () => {
    expect(ledgerEventIds({ text: `${block('MEM_AAA1', 'x')}\n${block('mem_Bbb2', 'y')}` })).toEqual(['mem_aaa1', 'mem_bbb2']);
  });

  it('reads CRLF text the same way', () => {
    expect(ledgerEventIds({ text: block('MEM_AAA1', 'x').replace(/\n/g, '\r\n') })).toEqual(['mem_aaa1']);
  });

  it('falls back to the heading path only for a chunk that carries no header of its own', () => {
    expect(ledgerEventIds({ text: '- object: tail of a long value', headingPath: 'Memory Events Ledger > MEM_CCC3 · 2026-10-02T00:00:00.000Z' })).toEqual(['mem_ccc3']);
    expect(ledgerEventIds({ text: block('MEM_AAA1', 'x'), headingPath: 'Ledger > MEM_ZZZ9' })).toEqual(['mem_aaa1']);
  });

  it('finds nothing in prose, or in a heading that only resembles an event header', () => {
    expect(ledgerEventIds({ text: 'An ordinary note mentions MEM_AAA1 in prose.' })).toEqual([]);
    expect(ledgerEventIds({ text: '## MEM_AAA1 rollout notes\n\nbody' })).toEqual([]);
    expect(ledgerEventIds({ text: '# Plan', headingPath: 'Plan' })).toEqual([]);
  });
});

describe('createReadScope: hits', () => {
  it('judges a ledger event by the scope it was saved in, whatever the ledger path says', async () => {
    const f = await fixture();
    const events = [
      hit({ text: block(f.work.toUpperCase(), 'WORKNEW') }),
      hit({ text: block(f.launch, 'LAUNCHNEW') }),
      hit({ text: block(f.global, 'GLOBALNEW') }),
    ];
    const objects = (scope: Parameters<typeof createReadScope>[1]) =>
      createReadScope(f.db, scope).hits(events, sameNotePath).map(h => /object: (\w+)/.exec(h.text)![1]);
    expect(objects('global')).toEqual(['GLOBALNEW']);
    expect(objects('scope:work')).toEqual(['WORKNEW']);
    expect(objects('project:launch')).toEqual(['LAUNCHNEW']);
    // A named scope is its slug, as for a note's path: the same slug under the other kind is the same scope.
    expect(objects('project:work')).toEqual(['WORKNEW']);
    expect(objects('scope:launch')).toEqual(['LAUNCHNEW']);
    expect(objects('scope:nothing-here')).toEqual([]);
  });

  it('resolves an event whose header spells the id in lower case', async () => {
    const f = await fixture();
    const lower = hit({ text: block(f.work.toLowerCase(), 'WORKNEW') });
    expect(createReadScope(f.db, 'scope:work').hits([lower], sameNotePath)).toEqual([lower]);
    expect(createReadScope(f.db, 'global').hits([lower], sameNotePath)).toEqual([]);
  });

  it('judges a superseded event by its scope too, so history never crosses scopes', async () => {
    const f = await fixture();
    const labelled = hit({ text: `[Superseded memory event; historical evidence only]\n${block(f.workOld, 'WORKOLD')}` });
    expect(createReadScope(f.db, 'scope:work').hits([labelled], sameNotePath)).toEqual([labelled]);
    expect(createReadScope(f.db, 'global').hits([labelled], sameNotePath)).toEqual([]);
    expect(createReadScope(f.db, 'project:launch').hits([labelled], sameNotePath)).toEqual([]);
  });

  it('judges a chunk cut below its header by the id in its heading path', async () => {
    const f = await fixture();
    const tail = hit({ text: '- object: the rest of a very long value', headingPath: `Memory Events Ledger > ${f.launch} · 2026-10-02T00:00:00.000Z` });
    expect(createReadScope(f.db, 'project:launch').hits([tail], sameNotePath)).toEqual([tail]);
    expect(createReadScope(f.db, 'global').hits([tail], sameNotePath)).toEqual([]);
  });

  it('shows a chunk that carries events of two scopes to neither: it is whole or it is dropped', async () => {
    const f = await fixture();
    const mixed = hit({ text: `${block(f.work, 'WORKNEW')}${block(f.global, 'GLOBALNEW')}` });
    for (const scope of ['global', 'scope:work', 'project:launch'] as const) {
      expect(createReadScope(f.db, scope).hits([mixed], sameNotePath), scope).toEqual([]);
    }
    const sameScope = hit({ text: `${block(f.workOld, 'WORKOLD')}${block(f.work, 'WORKNEW')}` });
    expect(createReadScope(f.db, 'scope:work').hits([sameScope], sameNotePath)).toEqual([sameScope]);
  });

  it('leaves a note to its path, including a note whose heading merely looks like an event id', async () => {
    const f = await fixture();
    const scoped = hit({ notePath: 'Memory/Scopes/work/Notes/plan.md', text: '## MEM_PLAN rollout', headingPath: 'Plan > MEM_PLAN rollout' });
    const plain = hit({ notePath: 'People/Ada.md', text: 'Ada likes mango.' });
    expect(createReadScope(f.db, 'scope:work').hits([scoped, plain], sameNotePath)).toEqual([scoped]);
    expect(createReadScope(f.db, 'project:work').hits([scoped, plain], sameNotePath)).toEqual([scoped]); // a path names a slug, not a kind
    expect(createReadScope(f.db, 'global').hits([scoped, plain], sameNotePath)).toEqual([plain]);
    expect(createReadScope(f.db, 'scope:other').hits([scoped, plain], sameNotePath)).toEqual([]);
  });

  it('judges the path the caller names, not the stored one', async () => {
    const f = await fixture();
    const stored = hit({ notePath: '/vault/Memory/Scopes/work/Notes/a.md', text: 'a note' });
    expect(createReadScope(f.db, 'scope:work').hits([stored], () => 'Memory/Scopes/work/Notes/a.md')).toEqual([stored]);
    expect(createReadScope(f.db, 'scope:work').hits([stored], () => 'Notes/a.md')).toEqual([]);
  });

  it('judges a lifecycle fact offered as a hit by the scope on its row', async () => {
    const f = await fixture();
    const fact = (event: string) => hit({ notePath: '_mcp_', chunkId: -f.factId(event), text: 'meeting\'s time is X.' });
    expect(createReadScope(f.db, 'scope:work').hits([fact(f.work), fact(f.global)], sameNotePath)).toEqual([fact(f.work)]);
    expect(createReadScope(f.db, 'global').hits([fact(f.work), fact(f.global)], sameNotePath)).toEqual([fact(f.global)]);
    expect(createReadScope(f.db, 'project:launch').hits([fact(f.work), fact(f.global)], sameNotePath)).toEqual([]);
    expect(createReadScope(f.db, 'project:work').hits([fact(f.work), fact(f.global)], sameNotePath)).toEqual([fact(f.work)]);
  });

  it('drops a lifecycle fact whose row is gone, in every scope', async () => {
    const f = await fixture();
    const gone = hit({ notePath: '_mcp_', chunkId: -987654, text: 'a fact that no longer exists' });
    for (const scope of ['global', 'scope:work'] as const) expect(createReadScope(f.db, scope).hits([gone], sameNotePath), scope).toEqual([]);
  });
});

describe('createReadScope: has', () => {
  it('judges one hit as hits() does: an event by its scope whatever path is named, a note by the path named', async () => {
    const f = await fixture();
    const scope = createReadScope(f.db, 'scope:work');
    const ledger = 'System/Memory Events Ledger.md';
    const ours = hit({ text: block(f.work, 'WORKNEW') });
    const theirs = hit({ text: block(f.global, 'GLOBALNEW') });
    expect(scope.has(ours, ledger)).toBe(true);
    expect(scope.has(theirs, ledger)).toBe(false);
    expect(scope.has(ours, 'Memory/Scopes/other/ledger.md')).toBe(true); // the path of a ledger decides nothing
    const note = hit({ notePath: '/vault/Memory/Scopes/work/Notes/a.md', text: 'a note' });
    expect(scope.has(note, 'Memory/Scopes/work/Notes/a.md')).toBe(true);
    expect(scope.has(note, 'Notes/a.md')).toBe(false);
    const all = [ours, theirs, note];
    const pathOf = (h: ScopedHit) => (h === note ? 'Memory/Scopes/work/Notes/a.md' : ledger);
    expect(scope.hits(all, pathOf)).toEqual(all.filter(h => scope.has(h, pathOf(h))));
  });

  it('judges a lifecycle fact by its row, as hits() does', async () => {
    const f = await fixture();
    const fact = (event: string) => hit({ notePath: '_mcp_', chunkId: -f.factId(event), text: 'a fact' });
    expect(createReadScope(f.db, 'scope:work').has(fact(f.work), '_mcp_')).toBe(true);
    expect(createReadScope(f.db, 'scope:work').has(fact(f.global), '_mcp_')).toBe(false);
    expect(createReadScope(f.db, 'global').has(fact(f.global), '_mcp_')).toBe(true);
  });
});

describe('createReadScope: chunkIds', () => {
  it('lists every chunk of the index the scope holds, exactly the ones has() admits', async () => {
    const f = await fixture();
    const stored = (rel: string) => `/vault/${rel}`;
    const chunks: Array<{ notePath: string; text: string; headingPath?: string }> = [
      { notePath: LEDGER, text: block(f.work, 'WORKNEW') },
      { notePath: LEDGER, text: block(f.workOld, 'WORKOLD') },
      { notePath: LEDGER, text: block(f.launch, 'LAUNCHNEW') },
      { notePath: LEDGER, text: block(f.global, 'GLOBALNEW') },
      { notePath: LEDGER, text: block(f.work.toLowerCase(), 'WORKNEW') },
      { notePath: LEDGER, text: `${block(f.work, 'WORKNEW')}${block(f.global, 'GLOBALNEW')}` }, // a legacy chunk of two scopes
      { notePath: LEDGER, text: '- object: the rest of a very long value', headingPath: `Memory Events Ledger > ${f.launch} · 2026-10-02T00:00:00.000Z` },
      { notePath: LEDGER, text: '# Memory Events Ledger\n\nAppend-only durable record of memory events.' },
      { notePath: 'People/Ada.md', text: `Pasted from the ledger:\n${block(f.work, 'WORKNEW')}` }, // judged by the event
      { notePath: 'People/Bob.md', text: 'Bob likes mango; see mem_notes for more.' },
      { notePath: 'Memory/Scopes/work/Notes/plan.md', text: '## MEM_PLAN rollout', headingPath: 'Plan > MEM_PLAN rollout' },
      { notePath: 'Memory/Scopes/work/Notes/a.md', text: 'a note of work' },
      { notePath: 'Memory/Scopes/launch/Notes/b.md', text: 'a note of the launch' },
    ];
    const insertNote = f.db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, null, 'h', '2026-10-02T00:00:00.000Z', '{}')");
    const insertChunk = f.db.prepare(
      'INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, ?, 0, 1, 5, ?)',
    );
    const rows = chunks.map((c, i) => {
      insertNote.run(stored(c.notePath), c.notePath);
      const chunkId = Number(insertChunk.run(stored(c.notePath), c.headingPath ?? '', c.text, `chunk-${i}`).lastInsertRowid);
      return { ...c, notePath: stored(c.notePath), chunkId };
    });
    const shown = (stored: string) => stored.slice('/vault/'.length);
    for (const name of ['global', 'scope:work', 'project:launch', 'project:work', 'scope:nothing-here'] as const) {
      const scope = createReadScope(f.db, name);
      const expected = rows.filter(r => scope.has(r, shown(r.notePath))).map(r => r.chunkId);
      expect(scope.chunkIds(shown).sort((a, b) => a - b), name).toEqual(expected);
    }
    // And the answers are the ones the scope rules give, not only the same as has():
    const ids = (name: Parameters<typeof createReadScope>[1]) =>
      createReadScope(f.db, name).chunkIds(shown).map(id => rows.find(r => r.chunkId === id)!.text.slice(0, 18)).sort();
    expect(ids('scope:work')).toEqual([
      block(f.work, '').slice(0, 18), block(f.workOld, '').slice(0, 18), block(f.work.toLowerCase(), '').slice(0, 18),
      '## MEM_PLAN rollou', 'Pasted from the le', 'a note of work',
    ].sort());
  });
});

describe('createReadScope: chunkIds over a long ledger', () => {
  it('asks for the scopes of the ledger\'s events all at once, and answers exactly as has() does one chunk at a time', async () => {
    const f = await fixture();
    const scopes = ['scope:work', 'project:launch', undefined, 'scope:other'] as const;
    const events: string[] = [];
    for (let i = 0; i < 90; i++) {
      const scope = scopes[i % scopes.length];
      events.push((await remember(f.db, f.vault, LEDGER, { subject: `thing ${i}`, predicate: 'state', object: `value ${i}`, ...(scope ? { scope } : {}) })).eventId);
    }
    const stored = (rel: string) => `/vault/${rel}`;
    const insertNote = f.db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, null, 'h', '2026-10-02T00:00:00.000Z', '{}')");
    const insertChunk = f.db.prepare(
      'INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, ?, 0, 1, 5, ?)',
    );
    const chunks = [
      // One chunk per event, as the chunker cuts the ledger; one of them cut below its header; and ids that are no event.
      ...events.map(id => ({ notePath: LEDGER, text: block(id, 'v') })),
      { notePath: LEDGER, text: '- object: tail of a long value', headingPath: `Memory Events Ledger > ${events[1]} · 2026-10-02T00:00:00.000Z` },
      { notePath: LEDGER, text: block('MEM_NEVERSAVED', 'v') },
      { notePath: 'Memory/Scopes/work/Notes/a.md', text: 'a note of work' },
      { notePath: 'People/Ada.md', text: 'a global note' },
    ].map((c, i) => {
      insertNote.run(stored(c.notePath), c.notePath);
      const chunkId = Number(insertChunk.run(stored(c.notePath), (c as { headingPath?: string }).headingPath ?? '', c.text, `long-${i}`).lastInsertRowid);
      return { ...c, notePath: stored(c.notePath), chunkId };
    });
    const shown = (path: string) => path.slice('/vault/'.length);
    for (const name of ['global', 'scope:work', 'project:launch', 'project:other', 'scope:nothing-here'] as const) {
      const scope = createReadScope(f.db, name);
      const expected = chunks.filter(c => createReadScope(f.db, name).has(c, shown(c.notePath))).map(c => c.chunkId);
      expect(scope.chunkIds(shown).sort((a, b) => a - b), name).toEqual(expected);
    }
    // The pass asks the lifecycle layer once for every event, not once for each: a handful of statements, not ninety.
    const { plans } = traceStatements(f.db, () => createReadScope(f.db, 'scope:work').chunkIds(shown));
    const perEvent = plans.filter(p => /WHERE event_id = \? AND source_path = \?/.test(p.sql));
    expect(perEvent.length).toBeLessThanOrEqual(2); // the one id that names no event, and the one cut below its header
    expect(plans.some(p => /FROM facts WHERE source_path = \? AND event_id IS NOT NULL/.test(p.sql))).toBe(true);
  });
});

describe('createReadScope: body', () => {
  const body = (f: Awaited<ReturnType<typeof fixture>>) =>
    `# Memory Events Ledger\n\nAppend-only durable record.\n\n${block(f.workOld.toUpperCase(), 'WORKOLD')}\n${block(f.work.toUpperCase(), 'WORKNEW')}\n${block(f.launch, 'LAUNCHNEW')}\n${block(f.global, 'GLOBALNEW')}`;
  const objects = (text: string) => [...text.matchAll(/- object: (\w+)/g)].map(m => m[1]);

  it('keeps the events saved in the scope, closed ones included, and drops every other scope\'s', async () => {
    const f = await fixture();
    expect(objects(createReadScope(f.db, 'scope:work').body(body(f)))).toEqual(['WORKOLD', 'WORKNEW']);
    expect(objects(createReadScope(f.db, 'project:work').body(body(f)))).toEqual(['WORKOLD', 'WORKNEW']);
    expect(objects(createReadScope(f.db, 'project:launch').body(body(f)))).toEqual(['LAUNCHNEW']);
    expect(objects(createReadScope(f.db, 'scope:launch').body(body(f)))).toEqual(['LAUNCHNEW']);
    expect(objects(createReadScope(f.db, 'global').body(body(f)))).toEqual(['GLOBALNEW']);
    expect(objects(createReadScope(f.db, 'scope:nothing-here').body(body(f)))).toEqual([]);
  });

  it('cuts a CRLF ledger the same way', async () => {
    const f = await fixture();
    const crlf = body(f).replace(/\n/g, '\r\n');
    expect(objects(createReadScope(f.db, 'project:launch').body(crlf))).toEqual(['LAUNCHNEW']);
  });

  it('shows nothing of a note that holds only other scopes\' events', async () => {
    const f = await fixture();
    expect(createReadScope(f.db, 'project:launch').body(`# Ledger\n\n${block(f.work, 'WORKNEW')}`)).toBe('');
  });

  it('returns any other text as it is', async () => {
    const f = await fixture();
    const prose = '# Notes\n\nNothing about a ledger here.\n\n## MEM_PLAN rollout\n\nmore prose\r\n';
    expect(createReadScope(f.db, 'scope:work').body(prose)).toBe(prose);
    const unknown = `# Notes\n\n${block('MEM_NOSUCHEVENT', 'quoted')}`;
    expect(createReadScope(f.db, 'scope:work').body(unknown)).toBe(unknown);
  });
});

// A body holds every event of the ledger and is cut on every read that hydrates it, so how it reaches SQLite is
// pinned alongside what it returns: no lookup per event (3,000 events cost ~13 ms of them), one query per read.
describe('createReadScope: how body reaches the database', () => {
  /** Every `get` and `all` the statements prepared from now on run, by SQL text. */
  function spyOnStatements(db: Database.Database) {
    const ran: Array<{ sql: string; method: 'get' | 'all' }> = [];
    const real = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      const statement = real(sql) as any;
      for (const method of ['get', 'all'] as const) {
        const original = statement[method].bind(statement);
        statement[method] = (...args: unknown[]) => { ran.push({ sql, method }); return original(...args); };
      }
      return statement;
    };
    return ran;
  }

  it('reads the ids of other scopes\' events once, however many events or notes it cuts', async () => {
    const f = await fixture();
    const ran = spyOnStatements(f.db);
    const scope = createReadScope(f.db, 'scope:work');
    const body = `# Memory Events Ledger\n\n${[f.workOld, f.work, f.launch, f.global].map((id, i) => block(id, `V${i}`)).join('\n')}`;
    expect([...scope.body(body).matchAll(/- object: (\w+)/g)].map(m => m[1])).toEqual(['V0', 'V1']);
    scope.body(body);
    scope.body(body);
    const eventStatements = ran.filter(r => /FROM facts/.test(r.sql));
    expect(eventStatements.filter(r => /WHERE event_id = \?/.test(r.sql)), 'one lookup per event').toEqual([]);
    expect(eventStatements.filter(r => /event_id FROM facts/.test(r.sql) && r.method === 'all')).toHaveLength(1);
  });

  it('asks the database nothing for a note that holds no events', async () => {
    const f = await fixture();
    const ran = spyOnStatements(f.db);
    const scope = createReadScope(f.db, 'scope:work');
    const note = '# Notes\n\nA plain note, with a heading that merely looks like an id.\n\n## MEM_PLAN rollout\n\nmore\n';
    expect(scope.body(note)).toBe(note);
    expect(ran.filter(r => /FROM facts/.test(r.sql))).toEqual([]);
  });
});

describe('createReadScope: a database without the lifecycle projection', () => {
  it('judges every hit by its path, as before the projection existed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-scope-'));
    tmpDirs.push(dir);
    const db = openDb(path.join(dir, 'index.db'));
    openDbs.push(db);
    db.exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, predicate TEXT, object_text TEXT)');
    const scope = createReadScope(db, 'scope:work');
    const note = hit({ notePath: 'Memory/Scopes/work/a.md', text: 'a note' });
    const event = hit({ text: block('MEM_AAA1', 'x') });
    expect(scope.hits([note, event], sameNotePath)).toEqual([note]);
    const text = block('MEM_AAA1', 'x');
    expect(scope.body(text)).toBe(text);
  });
});
