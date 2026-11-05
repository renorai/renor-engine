import { z } from 'zod';
import type Database from '../db/sqlite';
import { scanSecrets } from '../extraction/secretScanner';
import { normalizeScope } from './scope';

export const OBSERVE_METHOD = 'renor/observe' as const;
export const OBSERVE_DEFAULT_OFF_REASON = 'The owner requires the write-side eval to beat today first.';
export const DEFAULT_OBSERVATION_RETENTION_DAYS = 90;
export const DEFAULT_OBSERVATION_MAX_ROWS = 20_000;

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
  `);
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

function prune(db: Database.Database, workspace: string, receivedAt: string, retentionDays: number, maxRows: number): void {
  const cutoff = new Date(new Date(receivedAt).getTime() - retentionDays * 86_400_000).toISOString();
  const expired = db.prepare('SELECT id FROM observations WHERE workspace = ? AND received_at < ?').all(workspace, cutoff) as Array<{ id: number }>;
  const remove = db.prepare('DELETE FROM observations WHERE id = ?');
  const removeText = db.prepare('DELETE FROM observations_fts WHERE observation_id = ?');
  for (const row of expired) { removeText.run(String(row.id)); remove.run(row.id); }
  const excess = db.prepare('SELECT id FROM observations WHERE workspace = ? ORDER BY received_at DESC, id DESC LIMIT -1 OFFSET ?')
    .all(workspace, maxRows) as Array<{ id: number }>;
  for (const row of excess) { removeText.run(String(row.id)); remove.run(row.id); }
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
    return db.prepare('UPDATE observations SET retired = ? WHERE workspace = ? AND session_id = ? AND seq = ?')
      .run(Number(retired), workspace, match[1], Number(match[2])).changes > 0;
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
  return chosen.map(row => `observation:${row.session_id}:${row.seq}`);
}
