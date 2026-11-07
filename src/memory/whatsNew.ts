import type Database from '../db/sqlite';
import { normalizeScope, savedScopeSqlPredicate, scopeSpellings } from '../mvp/scope';
import { listRequestsPage, REQUEST_PAGE_LIMIT } from './requests';

/** How many items one call returns. A full page comes with a cursor for the rest. */
export const WHATS_NEW_LIMIT = 50;

/** The page a call returns when it names no `limit` and RENOR_WHATS_NEW_PAGE is unset. A full page carries a cursor for the rest. */
export const WHATS_NEW_DEFAULT_PAGE = 5;

/**
 * The page a call returns when it names no `limit`: RENOR_WHATS_NEW_PAGE, 1 to 50. Unset, it is 5 (WHATS_NEW_DEFAULT_PAGE);
 * RENOR_WHATS_NEW_PAGE=50 restores the earlier 50-item page. A value that is not a whole number from 1 to 50 fails the call
 * rather than quietly reading 50: an arm must never run with a lever silently off.
 */
export function whatsNewPageFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RENOR_WHATS_NEW_PAGE ?? '').trim();
  if (raw === '') return WHATS_NEW_DEFAULT_PAGE;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= WHATS_NEW_LIMIT)) throw new Error(`RENOR_WHATS_NEW_PAGE takes a whole number from 1 to ${WHATS_NEW_LIMIT}, not ${raw}`);
  return n;
}
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * At most this many open requests lead a reply (the newest); the rest are counted (`more_requests`). list_requests
 * returns the same page: the rest come up as these are answered or closed.
 */
export const WHATS_NEW_REQUEST_LIMIT = REQUEST_PAGE_LIMIT;

/** One feed item carries this many characters of another agent's text. list_requests still returns the full question. */
export const WHATS_NEW_EXCERPT_CHARS = 240;

function excerpt(text: string | null): string | null {
  if (text === null) return null;
  let end = 0;
  let count = 0;
  for (const point of text) {
    if (count === WHATS_NEW_EXCERPT_CHARS) break;
    end += point.length;
    count++;
  }
  return text.slice(0, end);
}

export interface WhatsNewItem {
  kind: string;
  at: string;
  source: string;
  scope: string | null;
  summary: string | null;
  /** Set on an open request. Absent on a write-log row. */
  requestId?: string;
  /** Set when the text is another agent's words, not an instruction. Own writes are unmarked. */
  untrusted?: true;
}

export interface WhatsNewResult {
  items: WhatsNewItem[];
  as_of: string;
  /** Set when this call finished the window. The next call without a cursor starts after it. */
  next_since: string | null;
  /** Set when the page was full. Pass it back so the rest of the window is not skipped. */
  cursor: string | null;
  /** Set when more open requests are waiting than lead the reply: how many more (list_requests shows them). */
  more_requests?: number;
  /** Set with more_requests: "N older requests not shown; use list_requests with before=<id>". */
  more_requests_hint?: string;
}

interface Row {
  id: number;
  action: string;
  summary: string | null;
  created_at: string;
  author: string | null;
  scope: string | null;
}

// A sixth part, "peek", marks a window opened with an explicit `since`: its pages never move the mark either.
function cursorOf(floorAt: string, floorId: number, beforeAt: string, beforeId: number, asOf: string, peek: boolean): string {
  const parts = [floorAt, String(floorId), beforeAt, String(beforeId), asOf];
  if (peek) parts.push('peek');
  return parts.join('|');
}

function parseCursor(cursor: string): { floorAt: string; floorId: number; beforeAt: string; beforeId: number; asOf: string; peek: boolean } {
  const parts = cursor.split('|');
  if ((parts.length !== 5 && !(parts.length === 6 && parts[5] === 'peek')) || !parts[0] || !parts[2] || !parts[4]) {
    throw new Error('whats_new cursor is not one this workspace issued');
  }
  const floorId = Number(parts[1]);
  const beforeId = Number(parts[3]);
  if (!Number.isInteger(floorId) || !Number.isInteger(beforeId)) {
    throw new Error('whats_new cursor is not one this workspace issued');
  }
  return { floorAt: parts[0], floorId, beforeAt: parts[2], beforeId, asOf: parts[4], peek: parts.length === 6 };
}

/**
 * What was saved after this agent's mark, newest first. The mark moves to `as_of` only when the
 * page was not full, so a bounded reply cannot skip the rest. An explicit `since` is a peek: it
 * never moves the mark, so writes between the mark and `since` are still shown by the next plain call. This agent's own rows are left out
 * unless `includeOwn`. The first call, with no mark, starts seven days back.
 */
export function readWhatsNew(db: Database.Database, args: {
  agent: string;
  scope?: string;
  includeOwn?: boolean;
  since?: string;
  cursor?: string;
  now?: Date;
  limit?: number;
}): WhatsNewResult {
  const limit = args.limit ?? WHATS_NEW_LIMIT;
  const now = (args.now ?? new Date()).toISOString();
  // One scope has several spellings (atlas, scope:atlas, project:atlas): read all of them and keep one mark.
  const scope = args.scope !== undefined && args.scope.trim() !== '' ? normalizeScope(args.scope) : null;
  const scopeKey = scope ? scopeSpellings(scope)[0] : '';
  const page = args.cursor ? parseCursor(args.cursor) : null;
  let floorAt: string;
  let floorId: number;
  let asOf: string;
  let beforeAt: string | null = null;
  let beforeId: number | null = null;
  let peek = false;
  if (page) {
    peek = page.peek;
    floorAt = page.floorAt;
    floorId = page.floorId;
    asOf = page.asOf;
    beforeAt = page.beforeAt;
    beforeId = page.beforeId;
  } else if (args.since) {
    peek = true;
    floorAt = args.since;
    floorId = -1;
    asOf = now;
  } else {
    const stored = db.prepare(
      'SELECT last_at, last_id FROM agent_cursors WHERE agent = ? AND scope = ?',
    ).get(args.agent, scopeKey) as { last_at: string; last_id: number } | undefined;
    if (stored) {
      floorAt = stored.last_at;
      floorId = stored.last_id;
    } else {
      floorAt = new Date(Date.parse(now) - WEEK_MS).toISOString();
      floorId = -1;
    }
    asOf = now;
  }

  const params: Array<string | number> = [floorAt, floorAt, floorId, asOf];
  let beforeSql = '';
  if (beforeAt !== null && beforeId !== null) {
    beforeSql = ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    params.push(beforeAt, beforeAt, beforeId);
  }
  let ownSql = '';
  if (!args.includeOwn) {
    ownSql = ' AND (author IS NULL OR author != ?)';
    params.push(args.agent);
  }
  let scopeSql = '';
  if (scope) {
    // A row written without a scope (before migration 19, or a note retire/restore) is global.
    const saved = savedScopeSqlPredicate(scope, "COALESCE(scope, 'global')");
    scopeSql = ` AND ${saved.sql}`;
    params.push(...saved.params);
  }
  params.push(limit + 1);
  const rows = db.prepare(
    `SELECT id, action, summary, created_at, author, scope FROM write_events
      WHERE (created_at > ? OR (created_at = ? AND id > ?))
        AND created_at < ?
        ${beforeSql}${ownSql}${scopeSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  ).all(...params) as Row[];
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  const logged: WhatsNewItem[] = kept.map((row) => {
    const source = row.author && row.author !== '' ? row.author : 'unnamed';
    const other = Boolean(row.author && row.author !== '' && row.author !== args.agent);
    return {
      kind: row.action,
      at: row.created_at,
      source,
      scope: row.scope,
      summary: excerpt(row.summary),
      ...(other ? { untrusted: true as const } : {}),
    };
  });
  // Open requests stay at the front of the first page until they are answered or closed.
  // A later cursor page does not repeat them.
  const waiting = args.cursor ? { requests: [] } : listRequestsPage(db, { agent: args.agent, status: 'open', scope: args.scope });
  const open: WhatsNewItem[] = waiting.requests.map((request) => ({
    kind: 'request',
    at: request.created_at,
    source: request.from_agent,
    scope: request.scope,
    summary: excerpt(request.question),
    requestId: request.id,
    untrusted: true,
  }));
  const extra = waiting.more_requests
    ? { more_requests: waiting.more_requests, more_requests_hint: waiting.more_requests_hint }
    : {};
  const items = [...open, ...logged];
  if (more) {
    const last = kept[kept.length - 1];
    return { items, as_of: asOf, next_since: null, cursor: cursorOf(floorAt, floorId, last.created_at, last.id, asOf, peek), ...extra };
  }
  if (peek) return { items, as_of: asOf, next_since: asOf, cursor: null, ...extra };
  db.prepare(
    `INSERT INTO agent_cursors (agent, scope, last_at, last_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(agent, scope) DO UPDATE SET last_at = excluded.last_at, last_id = excluded.last_id`,
  ).run(args.agent, scopeKey, asOf, -1);
  return { items, as_of: asOf, next_since: asOf, cursor: null, ...extra };
}

/** The one line an empty workspace adds to get_context and whats_new; it goes with the first save. */
export const EMPTY_WORKSPACE_NOTE = 'Renor is empty. Save decisions, root causes and corrections with remember before you finish.';

/** True while the workspace holds no note and no fact. Both lookups stop at the first row. */
export function workspaceIsEmpty(db: Database.Database): boolean {
  return db.prepare('SELECT NOT EXISTS (SELECT 1 FROM notes) AND NOT EXISTS (SELECT 1 FROM facts)').pluck().get() === 1;
}
