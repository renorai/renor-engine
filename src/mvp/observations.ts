import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from '../db/sqlite';
import { encodeTokens } from '../indexer/tokenizer';
import { scanSecrets } from '../extraction/secretScanner';
import { normalizeScope } from './scope';

export const OBSERVE_METHOD = 'renor/observe' as const;
export const OBSERVE_DEFAULT_OFF_REASON = 'The owner requires the write-side eval to beat today first.';
export const DEFAULT_OBSERVATION_RETENTION_DAYS = 90;
export const DEFAULT_OBSERVATION_MAX_ROWS = 20_000;
export const OBSERVATION_IDLE_MS = 30 * 60_000;

const byteLimited = (max: number) => z.string().superRefine((value, ctx) => {
  if (Buffer.byteLength(value, 'utf8') > max) ctx.addIssue({ code: 'custom', message: `Must be at most ${max} UTF-8 bytes` });
});
const ObserveParamsSchema = z.object({
  session_id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  event: z.enum(['session_start', 'prompt', 'tool', 'session_end']),
  client: z.string().min(1),
  ts: z.string().datetime({ offset: true }),
  cwd_scope: z.string().optional(),
  text: byteLimited(8192).optional(),
  tool: z.object({
    name: z.string().min(1),
    input_summary: byteLimited(1024).optional(),
    ok: z.boolean().optional(),
    files: z.array(z.string()).max(20).optional(),
  }).optional(),
});

// MCP request schemas validate only method/params; the SDK validates jsonrpc/id separately.
export const ObserveRequestSchema = z.object({ method: z.literal(OBSERVE_METHOD), params: ObserveParamsSchema });
export const ObserveRequest = ObserveRequestSchema;
export type ObserveParams = z.infer<typeof ObserveParamsSchema>;
export type ObserveRequest = z.infer<typeof ObserveRequestSchema>;
export interface ObserveResult { ok: true; stored: boolean; duplicate: boolean; redactions: number }

export interface ObservationStoreOptions { now?: Date | string; retentionDays?: number; maxRows?: number }
export interface ObservationExportRow {
  id: string; session_id: string; seq: number; event: ObserveParams['event']; client: string; ts: string;
  received_at: string; cwd_scope: string | null; text: string | null; tool: NonNullable<ObserveParams['tool']> | null; retired: boolean;
}
export interface ObservationHit {
  id: string; path: string; notePath: string; title: string; score: number; content: string; text: string;
  reason: 'observation'; source: 'observation'; session_date: string; cwd_scope: string | null;
}
interface StoredRow {
  id: number; session_id: string; seq: number; event: ObserveParams['event']; client: string; ts: string; received_at: string;
  cwd_scope: string | null; text: string | null; tool_json: string | null; retired: number;
}

export function observeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|on|true|yes)$/i.test(env.RENOR_OBSERVE?.trim() ?? '');
}

export interface ObservationSource {
  listSession(workspace: string, session_id: string): ObserveParams[];
}

function ensureTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      event TEXT NOT NULL, client TEXT NOT NULL, ts TEXT NOT NULL, received_at TEXT NOT NULL,
      cwd_scope TEXT, text TEXT, tool_json TEXT, retired INTEGER NOT NULL DEFAULT 0,
      UNIQUE(workspace, session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS observations_workspace_received ON observations(workspace, received_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(content, workspace UNINDEXED, observation_id UNINDEXED);
    CREATE TABLE IF NOT EXISTS observation_summaries (
      workspace TEXT NOT NULL, session_id TEXT NOT NULL, cwd_scope TEXT NOT NULL, completed_at TEXT NOT NULL,
      note_path TEXT NOT NULL, summary TEXT NOT NULL, handoff TEXT NOT NULL,
      PRIMARY KEY(workspace, session_id)
    );
    CREATE INDEX IF NOT EXISTS observation_summaries_scope_completed
      ON observation_summaries(workspace, cwd_scope, completed_at DESC, session_id DESC);
  `);
}

const compact = (value: string) => value.trim().replace(/[ \t]+/g, ' ');
const bullet = (value: string) => `- ${value}`;
function counted(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'));
}

/** Pure rendering: no model, clock, database row id, or nondeterministic ordering enters the bytes. */
export function buildObservationSummary(rows: ObserveParams[]): { summary: string; handoff: string; scope: string } | null {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  if (!ordered.length) return null;
  const prompts = ordered.filter(row => row.event === 'prompt' && row.text !== undefined).map(row => compact(row.text!)).filter(Boolean);
  const tools = ordered.filter(row => row.event === 'tool' && row.tool).map(row => row.tool!);
  const files = counted(tools.flatMap(tool => tool.files ?? []));
  const toolCounts = counted(tools.map(tool => tool.name));
  const failures = ordered.filter(row => row.event === 'tool' && row.tool?.ok === false).map(row => {
    const detail = compact(row.text ?? row.tool?.input_summary ?? 'no detail');
    return `${row.tool!.name}: ${detail}`;
  });
  const next = ordered.filter(row => row.event === 'prompt' && row.text).flatMap(row => row.text!.split(/\r?\n/))
    .map(compact).filter(line => /^(?:TODO\b|FIXME\b|next:)/i.test(line));
  const scope = ordered.map(row => row.cwd_scope?.trim()).filter((value): value is string => Boolean(value)).at(-1) ?? 'global';
  const summary = [
    '# Session observation summary', '', '## Prompts', `First: ${prompts[0] ?? '(none)'}`, `Last: ${prompts.at(-1) ?? '(none)'}`, '',
    `## Files touched (${files.length})`, ...(files.length ? files.slice(0, 10).map(([name, count]) => bullet(`${name} (${count})`)) : ['- (none)']), '',
    '## Tools used', ...(toolCounts.length ? toolCounts.map(([name, count]) => bullet(`${name}: ${count}`)) : ['- (none)']), '',
    '## Failed tool events', ...(failures.length ? failures.map(bullet) : ['- (none)']), '',
    '## TODO / FIXME / next', ...(next.length ? next.map(bullet) : ['- (none)']), '',
  ].join('\n');
  const handoffLines = ['Where we left off', `Last prompt: ${prompts.at(-1) ?? '(none)'}`,
    `Last files: ${files.slice(0, 3).map(([name]) => name).join(', ') || '(none)'}`,
    `Open failures: ${failures.join('; ') || '(none)'}`];
  while (encodeTokens(handoffLines.join('\n')) > 400) {
    const index = handoffLines.reduce((longest, line, i) => line.length > handoffLines[longest].length ? i : longest, 1);
    if (handoffLines[index].length <= 20) break;
    handoffLines[index] = `${handoffLines[index].slice(0, Math.max(16, handoffLines[index].length - 40))}…`;
  }
  return { summary, handoff: handoffLines.join('\n'), scope };
}

function finishSession(db: Database.Database, workspace: string, sessionId: string, completedAt: string): boolean {
  const rendered = buildObservationSummary(createObservationSource(db).listSession(workspace, sessionId));
  if (!rendered) return false;
  const digest = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 20);
  const scope = normalizeScope(rendered.scope);
  const scopeDir = scope === 'global' ? 'Global' : scope.slice(scope.indexOf(':') + 1).replace(/[^A-Za-z0-9._-]/g, '-');
  const relative = path.join('Memory', 'Scopes', scopeDir, 'Observe Summaries', `${digest}.md`);
  const note = `---\nsource: observe-summary\nscope: ${scope}\n---\n\n${rendered.summary}`;
  const result = db.prepare(`INSERT OR IGNORE INTO observation_summaries
    (workspace,session_id,cwd_scope,completed_at,note_path,summary,handoff) VALUES (?,?,?,?,?,?,?)`)
    .run(workspace, sessionId, scope, completedAt, relative, note, rendered.handoff);
  if (result.changes === 0) return false;
  const target = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(target, note, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { db.prepare('DELETE FROM observation_summaries WHERE workspace=? AND session_id=?').run(workspace, sessionId); throw error; }
  return true;
}

/** Completes sessions whose newest receipt is at least thirty minutes old. Safe to call repeatedly. */
export function finalizeIdleObservationSessions(db: Database.Database, workspace: string, now: Date | string = new Date()): number {
  if (!observeEnabled()) return 0;
  ensureTables(db);
  const at = validNow(now); const cutoff = new Date(new Date(at).getTime() - OBSERVATION_IDLE_MS).toISOString();
  const sessions = db.prepare(`SELECT session_id FROM observations WHERE workspace=? GROUP BY session_id
    HAVING MAX(received_at)<=? AND session_id NOT IN (SELECT session_id FROM observation_summaries WHERE workspace=?)
    ORDER BY session_id`).all(workspace, cutoff, workspace) as Array<{ session_id: string }>;
  return sessions.filter(row => finishSession(db, workspace, row.session_id, at)).length;
}

/** The hosted process owns this unref'ed sweep; it cannot keep shutdown alive. */
const sweeps = new WeakMap<Database.Database, Map<string, NodeJS.Timeout>>();
/** One timer per database and workspace: the MCP server is built per request in stateless mode, so repeat calls return the running timer. */
export function startObservationIdleSweep(db: Database.Database, workspace: string): NodeJS.Timeout | null {
  if (!observeEnabled()) return null;
  const running = sweeps.get(db)?.get(workspace);
  if (running) return running;
  const timer = setInterval(() => { try { finalizeIdleObservationSessions(db, workspace); } catch { /* next sweep retries */ } }, 60_000);
  timer.unref();
  const byWorkspace = sweeps.get(db) ?? new Map<string, NodeJS.Timeout>();
  byWorkspace.set(workspace, timer); sweeps.set(db, byWorkspace);
  return timer;
}

export function latestObservationHandoff(db: Database.Database, workspace: string, scope?: string): { text: string; date: string; sessionId: string } | null {
  if (!observeEnabled()) return null;
  try {
    ensureTables(db);
    // No scope given (the SessionStart hook sends none): the newest summary of any scope, rather than only `global`.
    const row = db.prepare(`SELECT handoff,completed_at,session_id FROM observation_summaries
      WHERE workspace=? ${scope === undefined ? '' : 'AND cwd_scope=?'} ORDER BY completed_at DESC,session_id DESC LIMIT 1`)
      .get(...(scope === undefined ? [workspace] : [workspace, normalizeScope(scope)])) as
      { handoff: string; completed_at: string; session_id: string } | undefined;
    return row ? { text: row.handoff, date: row.completed_at, sessionId: row.session_id } : null;
  } catch { return null; }
}

function safeString(value: string): { value: string | undefined; flagged: boolean } {
  return scanSecrets(value) ? { value: undefined, flagged: true } : { value, flagged: false };
}

function screenParams(params: ObserveParams): { params?: ObserveParams; redactions: number; refused: boolean } {
  let redactions = 0;
  const screen = (value: string, required: boolean): string | undefined => {
    const result = safeString(value);
    if (result.flagged) redactions++;
    return required && result.flagged ? undefined : result.value;
  };
  const session_id = screen(params.session_id, true);
  const event = screen(params.event, true);
  const client = screen(params.client, true);
  const ts = screen(params.ts, true);
  const cwd_scope = params.cwd_scope === undefined ? undefined : screen(params.cwd_scope, true);
  const text = params.text === undefined ? undefined : screen(params.text, false);
  if (params.cwd_scope !== undefined && cwd_scope === undefined) return { redactions, refused: true };
  let tool: ObserveParams['tool'];
  if (params.tool) {
    const name = screen(params.tool.name, true);
    if (name === undefined) return { redactions, refused: true };
    const input_summary = params.tool.input_summary === undefined ? undefined : screen(params.tool.input_summary, false);
    const files = params.tool.files?.flatMap(file => {
      const clean = screen(file, false);
      return clean === undefined ? [] : [clean];
    });
    tool = {
      name,
      ...(input_summary === undefined ? {} : { input_summary }),
      ...(params.tool.ok === undefined ? {} : { ok: params.tool.ok }),
      ...(files === undefined ? {} : { files }),
    };
  }
  if ([session_id, event, client, ts].some(value => value === undefined)) return { redactions, refused: true };
  return {
    params: {
      session_id: session_id!, seq: params.seq, event: event as ObserveParams['event'], client: client!, ts: ts!,
      ...(cwd_scope === undefined ? {} : { cwd_scope }), ...(text === undefined ? {} : { text }),
      ...(tool === undefined ? {} : { tool }),
    },
    redactions,
    refused: false,
  };
}

function validNow(now?: Date | string): string {
  const value = now instanceof Date ? now : now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(value.getTime())) throw new Error('Invalid observation clock');
  return value.toISOString();
}

/** The summary is a derived copy of the observations it came from, so it leaves with them: its row and its vault note. */
function dropSummaries(db: Database.Database, workspace: string, where: string, ...args: unknown[]): void {
  try {
    const rows = db.prepare(`SELECT session_id, note_path FROM observation_summaries WHERE workspace = ? AND ${where}`).all(workspace, ...args) as Array<{ session_id: string; note_path: string }>;
    for (const row of rows) {
      db.prepare('DELETE FROM observation_summaries WHERE workspace = ? AND session_id = ?').run(workspace, row.session_id);
      const root = path.resolve(workspace); const target = path.resolve(root, row.note_path);
      if (target.startsWith(root + path.sep)) { try { fs.rmSync(target, { force: true }); } catch { /* the row is gone; the note is unreadable by the index */ } }
    }
  } catch { /* a database that never had summaries has none to drop */ }
}
const NO_OBSERVATIONS_LEFT = 'NOT EXISTS (SELECT 1 FROM observations o WHERE o.workspace = observation_summaries.workspace AND o.session_id = observation_summaries.session_id)';

function prune(db: Database.Database, workspace: string, receivedAt: string, retentionDays: number, maxRows: number): void {
  const cutoff = new Date(new Date(receivedAt).getTime() - retentionDays * 86_400_000).toISOString();
  const expired = db.prepare('SELECT id FROM observations WHERE workspace = ? AND received_at < ?').all(workspace, cutoff) as Array<{ id: number }>;
  const remove = db.prepare('DELETE FROM observations WHERE id = ?');
  const removeText = db.prepare('DELETE FROM observations_fts WHERE observation_id = ?');
  for (const row of expired) { removeText.run(String(row.id)); remove.run(row.id); }
  const excess = db.prepare('SELECT id FROM observations WHERE workspace = ? ORDER BY received_at DESC, id DESC LIMIT -1 OFFSET ?')
    .all(workspace, maxRows) as Array<{ id: number }>;
  for (const row of excess) { removeText.run(String(row.id)); remove.run(row.id); }
  dropSummaries(db, workspace, NO_OBSERVATIONS_LEFT);
  dropSummaries(db, workspace, 'completed_at < ?', cutoff);
}

function contentFor(params: ObserveParams): string {
  return [params.text, params.tool?.name, params.tool?.input_summary, ...(params.tool?.files ?? [])]
    .filter((part): part is string => Boolean(part)).join('\n');
}

export function storeObservation(db: Database.Database, workspace: string, params: ObserveParams, options: ObservationStoreOptions = {}): ObserveResult {
  if (!observeEnabled()) return { ok: true, stored: false, duplicate: false, redactions: 0 };
  const validated = ObserveParamsSchema.safeParse(params);
  if (!validated.success) return { ok: true, stored: false, duplicate: false, redactions: 0 };
  const safeWorkspace = safeString(workspace);
  const screened = screenParams(validated.data);
  const redactions = screened.redactions + Number(safeWorkspace.flagged);
  if (safeWorkspace.flagged || screened.refused || !screened.params) return { ok: true, stored: false, duplicate: false, redactions };
  try {
    if (typeof options.now === 'string' && safeString(options.now).flagged) return { ok: true, stored: false, duplicate: false, redactions: 1 };
    const receivedAt = validNow(options.now);
    const retentionDays = options.retentionDays ?? DEFAULT_OBSERVATION_RETENTION_DAYS;
    const maxRows = options.maxRows ?? DEFAULT_OBSERVATION_MAX_ROWS;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || !Number.isInteger(maxRows) || maxRows < 1) {
      return { ok: true, stored: false, duplicate: false, redactions };
    }
    const clean = screened.params;
    ensureTables(db);
    const inserted = db.transaction(() => {
      const result = db.prepare(`INSERT INTO observations (workspace, session_id, seq, event, client, ts, received_at, cwd_scope, text, tool_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace, session_id, seq) DO NOTHING`).run(safeWorkspace.value, clean.session_id,
        clean.seq, clean.event, clean.client, clean.ts, receivedAt, clean.cwd_scope ?? null, clean.text ?? null,
        clean.tool ? JSON.stringify(clean.tool) : null);
      if (result.changes === 0) return false;
      const inserted = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
      const content = contentFor(clean);
      if (content) db.prepare('INSERT INTO observations_fts(content, workspace, observation_id) VALUES (?, ?, ?)')
        .run(content, safeWorkspace.value, String(inserted.id));
      prune(db, safeWorkspace.value!, receivedAt, retentionDays, maxRows);
      return true;
    })();
    // The observation is already stored; a failed summary write (disk, permissions) must not turn that into stored:false.
    try {
      if (inserted && clean.event === 'session_end') finishSession(db, safeWorkspace.value!, clean.session_id, receivedAt);
      else finalizeIdleObservationSessions(db, safeWorkspace.value!, receivedAt);
    } catch { /* the idle sweep retries unfinished sessions */ }
    return { ok: true, stored: inserted, duplicate: !inserted, redactions };
  } catch {
    return { ok: true, stored: false, duplicate: false, redactions };
  }
}

function searchTerms(query: string): string[] { return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]; }
function asHit(row: StoredRow, content: string, score: number): ObservationHit {
  const date = row.ts.slice(0, 10);
  const text = `[Observation · ${date}]\n${content}`;
  const path = `observations/${encodeURIComponent(row.session_id)}/${row.seq}`;
  return {
    id: `observation:${row.session_id}:${row.seq}`,
    path, notePath: path,
    title: `${row.event} · ${row.client}`, score, content: text, text, reason: 'observation', source: 'observation',
    session_date: date, cwd_scope: row.cwd_scope,
  };
}

export function searchObservations(db: Database.Database, workspace: string, query: string, limit = 10, options: ObservationStoreOptions = {}, scope?: string): ObservationHit[] {
  if (safeString(workspace).flagged || safeString(query).flagged || (typeof options.now === 'string' && safeString(options.now).flagged) ||
      !Number.isInteger(limit) || limit < 1) return [];
  const terms = searchTerms(query);
  if (!terms.length) return [];
  try {
    const receivedAt = validNow(options.now);
    ensureTables(db);
    prune(db, workspace, receivedAt, options.retentionDays ?? DEFAULT_OBSERVATION_RETENTION_DAYS,
      options.maxRows ?? DEFAULT_OBSERVATION_MAX_ROWS);
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    let scopeClause = '';
    const scopeParams: string[] = [];
    if (scope !== undefined) {
      const normalizedScope = normalizeScope(scope);
      if (normalizedScope === 'global') {
        scopeClause = ` AND (o.cwd_scope IS NULL OR trim(o.cwd_scope) = '' OR lower(trim(o.cwd_scope)) = 'global')`;
      } else {
        const slug = normalizedScope.slice(normalizedScope.indexOf(':') + 1);
        scopeClause = ` AND lower(trim(o.cwd_scope)) IN (?, ?)`;
        scopeParams.push(normalizedScope, slug);
      }
    }
    const rows = db.prepare(`SELECT o.id, o.session_id, o.seq, o.event, o.client, o.ts, o.received_at,
      o.cwd_scope, o.text, o.tool_json, o.retired, f.content, bm25(observations_fts) AS rank
      FROM observations_fts f JOIN observations o ON o.id = CAST(f.observation_id AS INTEGER)
      WHERE observations_fts MATCH ? AND f.workspace = ? AND o.workspace = ? AND o.retired = 0
      ${scopeClause} ORDER BY rank ASC, o.received_at DESC, o.id DESC LIMIT ?`)
      .all(match, workspace, workspace, ...scopeParams, Math.min(limit, 100)) as Array<StoredRow & { content: string; rank: number }>;
    return rows.map(row => asHit(row, row.content, -row.rank));
  } catch { return []; }
}

function exportRow(row: StoredRow): ObservationExportRow {
  return {
    id: `observation:${row.session_id}:${row.seq}`, session_id: row.session_id, seq: row.seq, event: row.event,
    client: row.client, ts: row.ts, received_at: row.received_at, cwd_scope: row.cwd_scope, text: row.text,
    tool: row.tool_json ? JSON.parse(row.tool_json) as NonNullable<ObserveParams['tool']> : null, retired: row.retired !== 0,
  };
}

export function observationsForExport(db: Database.Database, workspace: string): ObservationExportRow[] {
  if (safeString(workspace).flagged) return [];
  try {
    ensureTables(db);
    prune(db, workspace, new Date().toISOString(), DEFAULT_OBSERVATION_RETENTION_DAYS, DEFAULT_OBSERVATION_MAX_ROWS);
    return (db.prepare(`SELECT id, session_id, seq, event, client, ts, received_at, cwd_scope, text, tool_json, retired
      FROM observations WHERE workspace = ? ORDER BY received_at, id`).all(workspace) as StoredRow[]).map(exportRow);
  } catch { return []; }
}

export function createObservationSource(db: Database.Database): ObservationSource {
  return {
    listSession(workspace: string, session_id: string): ObserveParams[] {
      if (!observeEnabled() || safeString(workspace).flagged || safeString(session_id).flagged) return [];
      try {
        const cutoff = new Date(Date.now() - DEFAULT_OBSERVATION_RETENTION_DAYS * 86_400_000).toISOString();
        ensureTables(db);
        const rows = db.prepare(`SELECT session_id, seq, event, client, ts, cwd_scope, text, tool_json
          FROM observations WHERE workspace = ? AND session_id = ? AND retired = 0 AND received_at >= ?
          ORDER BY seq ASC`).all(workspace, session_id, cutoff) as Array<{
          session_id: string; seq: number; event: ObserveParams['event']; client: string; ts: string;
          cwd_scope: string | null; text: string | null; tool_json: string | null;
        }>;
        return rows.flatMap(row => {
          const candidate = ObserveParamsSchema.safeParse({
            session_id: row.session_id,
            seq: row.seq,
            event: row.event,
            client: row.client,
            ts: row.ts,
            ...(row.cwd_scope === null ? {} : { cwd_scope: row.cwd_scope }),
            ...(row.text === null ? {} : { text: row.text }),
            ...(row.tool_json === null ? {} : { tool: JSON.parse(row.tool_json) }),
          });
          if (!candidate.success) return [];
          const screened = screenParams(candidate.data);
          return screened.refused || !screened.params ? [] : [screened.params];
        });
      } catch {
        return [];
      }
    },
  };
}

export function setObservationRetired(db: Database.Database, workspace: string, id: string, retired: boolean): boolean {
  if (safeString(workspace).flagged || safeString(id).flagged) return false;
  const match = /^observation:(.*):(\d+)$/.exec(id);
  if (!match) return false;
  try {
    ensureTables(db);
    prune(db, workspace, new Date().toISOString(), DEFAULT_OBSERVATION_RETENTION_DAYS, DEFAULT_OBSERVATION_MAX_ROWS);
    const changed = db.prepare('UPDATE observations SET retired = ? WHERE workspace = ? AND session_id = ? AND seq = ?')
      .run(Number(retired), workspace, match[1], Number(match[2])).changes > 0;
    if (changed && retired) dropSummaries(db, workspace, 'session_id = ?', match[1]);
    return changed;
  } catch { return false; }
}

/** Permanently delete retired observations (row and full-text copy). One id, or every retired row when `id` is omitted, optionally narrowed to `only`. Touches nothing when the table was never created. */
export function purgeRetiredObservations(db: Database.Database, workspace: string, id?: string, only?: readonly string[]): string[] {
  if (safeString(workspace).flagged) return [];
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'observations'`).get();
  if (!exists) return [];
  const rows = db.prepare('SELECT id, session_id, seq FROM observations WHERE workspace = ? AND retired = 1').all(workspace) as Array<{ id: number; session_id: string; seq: number }>;
  const listed = only ? new Set(only) : null;
  const chosen = rows.filter(row => {
    const memoryId = `observation:${row.session_id}:${row.seq}`;
    return id !== undefined ? memoryId === id : listed === null || listed.has(memoryId);
  });
  const removeText = db.prepare('DELETE FROM observations_fts WHERE observation_id = ?');
  const remove = db.prepare('DELETE FROM observations WHERE id = ?');
  db.transaction(() => { for (const row of chosen) { removeText.run(String(row.id)); remove.run(row.id); } })();
  dropSummaries(db, workspace, NO_OBSERVATIONS_LEFT);
  return chosen.map(row => `observation:${row.session_id}:${row.seq}`);
}
