import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { askAgent, answerRequest, closeRequest, listRequests } from '../../src/memory/requests';
import { readWhatsNew } from '../../src/memory/whatsNew';
import { removeTestDir } from '../helpers/removeDb';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const dirs: string[] = [];
const handles: ReturnType<typeof openDb>[] = [];

function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requests-'));
  dirs.push(dir);
  const database = openDb(path.join(dir, 'renor.db'));
  handles.push(database);
  runMigrations(database);
  return database;
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) removeTestDir(dir);
});

describe('requests between agents', () => {
  it('ask, list, answer, then close, and a third agent cannot answer or close', () => {
    const database = db();
    const asked = askAgent(database, { from: 'firstmate', to: 'richard', request: 'Which port is the preview on?', now: NOW });
    expect(asked.status).toBe('open');
    expect(listRequests(database, { agent: 'richard', status: 'open' }).map((row) => row.question)).toEqual(['Which port is the preview on?']);
    expect(listRequests(database, { agent: 'grokbot', status: 'open' })).toEqual([]);
    expect(() => answerRequest(database, { agent: 'grokbot', id: asked.id, answer: '4177', now: NOW })).toThrow(/only the agent this request is for/);
    expect(() => closeRequest(database, { agent: 'grokbot', id: asked.id, now: NOW })).toThrow(/only the agent this request is for/);
    const answered = answerRequest(database, { agent: 'richard', id: asked.id, answer: '4177', now: NOW });
    expect(answered).toMatchObject({ status: 'answered', answer: '4177', answered_at: NOW.toISOString() });
    expect(listRequests(database, { agent: 'richard', status: 'open' })).toEqual([]);
    const closed = closeRequest(database, { agent: 'richard', id: asked.id, now: new Date('2026-10-08T13:00:00.000Z') });
    expect(closed.status).toBe('closed');
    expect(closed.closed_at).toBe('2026-10-08T13:00:00.000Z');
  });

  it('the asker can close its own request', () => {
    const database = db();
    const asked = askAgent(database, { from: 'firstmate', to: 'richard', request: 'Drop this.', now: NOW });
    const closed = closeRequest(database, { agent: 'firstmate', id: asked.id, now: NOW });
    expect(closed.status).toBe('closed');
    expect(listRequests(database, { agent: 'richard', status: 'open' })).toEqual([]);
  });

  it('a scope sees only that scope, and an explicit to lists that agent', () => {
    const database = db();
    askAgent(database, { from: 'firstmate', to: 'richard', request: 'atlas', scope: 'project:atlas', now: NOW });
    askAgent(database, { from: 'firstmate', to: 'richard', request: 'global', now: NOW });
    expect(listRequests(database, { agent: 'richard', status: 'open', scope: 'project:atlas' }).map((row) => row.question)).toEqual(['atlas']);
    for (const spelling of ['atlas', 'scope:atlas', 'Project:Atlas']) {
      expect(listRequests(database, { agent: 'richard', status: 'open', scope: spelling }).map((row) => row.question), spelling).toEqual(['atlas']);
    }
    expect(listRequests(database, { agent: 'richard', status: 'open', scope: 'global' }).map((row) => row.question)).toEqual(['global']);
    expect(listRequests(database, { agent: 'firstmate', status: 'open', to: 'richard' }).map((row) => row.question).sort()).toEqual(['atlas', 'global']);
  });

  it('open requests for the caller come first in whats_new and leave once answered', () => {
    const database = db();
    database.prepare(
      'INSERT INTO write_events (note_path, action, summary, created_at, author, scope) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('_memory_ledger_', 'store', 'a fact', '2026-10-08T01:00:00.000Z', 'grokbot', 'global');
    const asked = askAgent(database, { from: 'grokbot', to: 'firstmate', request: 'Please check the build.', now: NOW });
    const page = readWhatsNew(database, { agent: 'firstmate', now: NOW });
    expect(page.items[0]).toMatchObject({ kind: 'request', source: 'grokbot', summary: 'Please check the build.', requestId: asked.id });
    expect(page.items[1]).toMatchObject({ kind: 'store', summary: 'a fact' });
    answerRequest(database, { agent: 'firstmate', id: asked.id, answer: 'It passed.', now: NOW });
    const after = readWhatsNew(database, { agent: 'firstmate', now: new Date('2026-10-08T13:00:00.000Z') });
    expect(after.items.some((item) => item.kind === 'request')).toBe(false);
  });

  it('an answer cannot land on a request another handle closed between its read and its write', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'requests-race-')), 'renor.db');
    dirs.push(path.dirname(file));
    const first = openDb(file);
    handles.push(first);
    runMigrations(first);
    const second = openDb(file);
    handles.push(second);
    const asked = askAgent(first, { from: 'firstmate', to: 'richard', request: 'Which port?', now: NOW });
    // Close on the second handle right after answerRequest's SELECT, before its UPDATE.
    const real = first.prepare.bind(first);
    let closedOnce = false;
    const proxy = new Proxy(first, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop, target);
        return (sql: string) => {
          const statement = real(sql);
          if (closedOnce || !/^\s*SELECT/i.test(sql) || !/agent_requests/.test(sql)) return statement;
          return new Proxy(statement, {
            get(st, key) {
              if (key !== 'get') return Reflect.get(st, key, st);
              return (...a: unknown[]) => {
                const found = (st.get as (...x: unknown[]) => unknown)(...a);
                closedOnce = true;
                closeRequest(second, { agent: 'firstmate', id: asked.id, now: NOW });
                return found;
              };
            },
          });
        };
      },
    });
    expect(() => answerRequest(proxy, { agent: 'richard', id: asked.id, answer: '4177', now: NOW })).toThrow(/a closed request cannot be answered/);
    expect(closedOnce).toBe(true);
    expect(first.prepare('SELECT status, answer, answered_at FROM agent_requests WHERE id = ?').get(asked.id)).toEqual({ status: 'closed', answer: null, answered_at: null });
    first.close();
    second.close();
  });
});
