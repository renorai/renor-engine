import Database from '../db/sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanSecrets } from '../extraction/secretScanner';
import {
  CANDIDATE_KINDS,
  LEARNING_DDL,
  LEARNING_SCHEMA_NAME,
  LEARNING_SCHEMA_VERSION,
  LEARNING_TABLES,
  OUTCOME_BASES,
  OUTCOME_VALUES,
  TERM_COLUMNS,
} from './schema';

/**
 * The learning log: one SQLite file per memory folder, written by the MCP tools when RENOR_LEARNING_LOG is on (tap.ts) and
 * read by the learner through `exportLog()`. It is separate from product analytics (telemetry.ts) and from the index, so
 * deleting the index never deletes it and deleting the log never touches memory.
 *
 * The secret that makes the keys is written once, in the `meta` table, when the log is created; `exportLog()` never includes
 * it, and `deleteAll()` replaces it, so keys made before a delete cannot be matched to keys made after one.
 */

const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;

type Outcome = (typeof OUTCOME_VALUES)[number];
type Basis = (typeof OUTCOME_BASES)[number];

export interface LearningLogOptions {
  retentionDays: number;
  rawQueries: boolean;
  /** Create the file when it is missing. The management commands pass false: they never make a log that was never written. */
  create?: boolean;
  now?: () => number;
}

export interface CandidateRecord {
  /** 1-based position in the reply; null for a candidate the reply did not serve (the ranker scored or presented it, and the budget cut it). */
  rank: number | null;
  kind: (typeof CANDIDATE_KINDS)[number];
  memoryKey: string | null;
  subjectKey: string | null;
  sectionKey: string | null;
  score: number | null;
  /** The score before any term (rankingTrace.ts). */
  base: number | null;
  /** One number per RANKING_TERMS entry, in that order; null when the candidate was not traced. */
  terms: number[] | null;
  poolRank: number | null;
  windowPos: number | null;
  budgetKept: boolean | null;
  reason: string | null;
  matched: boolean | null;
  current: boolean | null;
  /**
   * The text the reply served for this candidate. The store never writes it; the tap hands it to the sharing example store
   * when, and only when, the user has chosen to share data (src/sharing/examples.ts).
   */
  text?: string | null;
}

export interface RetrievalRecord {
  at?: number;
  tool: string;
  actor: string;
  sessionKey: string | null;
  agentKey: string | null;
  queryKey: string | null;
  queryText: string | null;
  queryRedacted: boolean;
  scopeKey: string | null;
  retrieval: string | null;
  ranker: string;
  model: string | null;
  build: string | null;
  /** Every candidate of the read: the served ones first, in the order the reply served them (rank set), then the rest (rank null). */
  candidates: CandidateRecord[];
  ms: number;
  replyTokens: number | null;
  relevant: boolean | null;
  truncated: boolean | null;
  /** RENOR_CONTEXT_LEAN_ITEMS was on for this reply: its memories carry no note path, so their candidates are unkeyed. */
  leanItems: boolean;
}

export interface MemoryOpRecord {
  at?: number;
  actor: string;
  sessionKey: string | null;
  agentKey: string | null;
  tool: string;
  op: string;
  kind: string;
  memoryKey: string | null;
  subjectKey: string | null;
  replacedKey: string | null;
  ms: number;
}

export interface FeedbackRecord {
  at?: number;
  actor: string;
  sessionKey: string | null;
  agentKey: string | null;
  tool: string;
  target: string;
  memoryKey: string | null;
  subjectKey: string | null;
  /** False for a cite the engine inferred from the agent's own behaviour; default true (the agent named it). */
  observed?: boolean;
}

export interface OutcomeRecord {
  at?: number;
  sessionKey: string | null;
  /** An opaque reference the caller owns (a task id, a run id). It is keyed before it is stored; NULL when there is none. */
  taskRef: string | null;
  outcome: Outcome;
  basis: Basis;
}

export interface PruneReport {
  retrievals: number;
  candidates: number;
  memory_ops: number;
  feedback: number;
  outcomes: number;
}

export interface LearningExport {
  schema: typeof LEARNING_SCHEMA_NAME;
  version: typeof LEARNING_SCHEMA_VERSION;
  exportedAt: string;
  /** The window the rows are inside: the retention in force for this export. Whether a query was kept is in the rows themselves. */
  retentionDays: number;
  tables: Record<(typeof LEARNING_TABLES)[number], Array<Record<string, unknown>>>;
}

/** The order an export lists each table in: ids where a table has one, otherwise its key. */
const ORDER: Record<(typeof LEARNING_TABLES)[number], string> = {
  retrievals: 'id',
  candidates: 'retrieval_id, id',
  memory_ops: 'id',
  feedback: 'id',
  outcomes: 'id',
};

/** The columns the sharing projection reads (src/sharing/project.ts), per table: exportServedWindow selects these and nothing else. */
export const SHARING_COLUMNS = {
  retrievals: ['id', 'at', 'tool', 'session_key', 'agent_key', 'query_key', 'retrieval', 'ranker', 'model', 'build', 'served', 'reply_tokens', 'relevant', 'truncated'],
  candidates: ['id', 'retrieval_id', 'rank', 'kind', 'memory_key', 'subject_key', 'score', 'reason', 'matched', 'current'],
  memory_ops: ['id', 'at', 'session_key', 'agent_key', 'tool', 'op', 'kind', 'memory_key', 'subject_key', 'replaced_key'],
  feedback: ['id', 'at', 'session_key', 'agent_key', 'tool', 'memory_key', 'subject_key', 'observed'],
} as const;

/** Ids of one table fit below this, so `tableIndex * span + id` is one safe integer. */
export const LEARNING_CURSOR_SPAN = 2 ** 40;

const flag = (value: boolean | null): number | null => (value === null ? null : value ? 1 : 0);

const OUTCOME_OBSERVED: Record<Basis, 0 | 1> = { verifier: 1, user: 1, proxy: 0 };

export class LearningLog {
  private secret: Buffer;
  private lastPrune: number;

  private constructor(
    readonly file: string,
    private readonly db: Database.Database,
    secret: Buffer,
    private readonly retentionDays: number,
    readonly rawQueries: boolean,
    private readonly now: () => number,
  ) {
    this.secret = secret;
    // Zero makes the first read or write enforce retention immediately.
    this.lastPrune = 0;
  }

  /** Opens the log at `file`, creating it (owner-only) when `create` is set. Returns null when there is no log and none may be made. */
  static open(file: string, options: LearningLogOptions): LearningLog | null {
    const now = options.now ?? Date.now;
    if (options.create !== true && !fs.existsSync(file)) return null;
    // Owner-only, like the index (db/client.ts). Tighten an existing file too: it may have been
    // restored with a permissive umask and it contains linkable pseudonymous activity.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600));
    fs.chmodSync(file, 0o600);
    const db = new Database(file);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      // Deleted rows are overwritten, not left in free pages: a delete means the content is gone from the file.
      db.pragma('secure_delete = ON');
      db.pragma('busy_timeout = 5000');
      db.exec(LEARNING_DDL);
      const secret = ensureMeta(db, now());
      return new LearningLog(file, db, secret, options.retentionDays, options.rawQueries, now);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /**
   * A keyed hash of `parts` under this log's secret, 128 bits in hex. `kind` separates the namespaces (memory, query, session...);
   * the parts are JSON-encoded, so ["a b"] and ["a", "b"] cannot collide.
   */
  key(kind: string, ...parts: string[]): string {
    return createHmac('sha256', this.secret).update(JSON.stringify([kind, ...parts])).digest('hex').slice(0, 32);
  }

  recordRetrieval(record: RetrievalRecord): number {
    const at = record.at ?? this.now();
    // The raw query is written only by a log opened with rawQueries, and never when the secret scanner flags it: the check
    // lives here, at the write, so no caller can keep a query by passing it in.
    // query_redacted means one thing: the scanner flagged a query that the opt-in would have kept.
    const raw = record.queryText;
    const flagged = raw !== null && this.rawQueries && scanSecrets(raw) !== null;
    const keepRaw = raw !== null && this.rawQueries && !flagged;
    const queryRedacted = record.queryRedacted || flagged;
    return this.write(() => {
      const info = this.db.prepare(
        `INSERT INTO retrievals (at, tool, actor, session_key, agent_key, query_key, query_text, query_redacted, scope_key, retrieval,
           ranker, model, build, served, ms, reply_tokens, relevant, truncated, lean_items)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        at, record.tool, record.actor, record.sessionKey, record.agentKey, record.queryKey, keepRaw ? raw : null,
        queryRedacted ? 1 : 0, record.scopeKey, record.retrieval, record.ranker, record.model, record.build,
        record.candidates.filter(candidate => candidate.rank !== null).length, record.ms, record.replyTokens, flag(record.relevant),
        flag(record.truncated), record.leanItems ? 1 : 0,
      );
      const id = Number(info.lastInsertRowid);
      const columns = [
        'retrieval_id', 'rank', 'kind', 'memory_key', 'subject_key', 'section_key', 'score', 'base', ...TERM_COLUMNS,
        'pool_rank', 'window_pos', 'budget_kept', 'reason', 'matched', 'current',
      ];
      const insert = this.db.prepare(`INSERT INTO candidates (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
      for (const candidate of record.candidates) {
        const terms = candidate.terms ?? TERM_COLUMNS.map(() => 0);
        insert.run(
          id, candidate.rank, candidate.kind, candidate.memoryKey, candidate.subjectKey, candidate.sectionKey, candidate.score,
          candidate.base, ...terms, candidate.poolRank, candidate.windowPos, flag(candidate.budgetKept), candidate.reason,
          flag(candidate.matched), flag(candidate.current),
        );
      }
      return id;
    });
  }

  recordMemoryOp(record: MemoryOpRecord): void {
    this.write(() => {
      this.db.prepare(
        `INSERT INTO memory_ops (at, actor, session_key, agent_key, tool, op, kind, memory_key, subject_key, replaced_key, ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.at ?? this.now(), record.actor, record.sessionKey, record.agentKey, record.tool, record.op, record.kind,
        record.memoryKey, record.subjectKey, record.replacedKey, record.ms,
      );
    });
  }

  /** An explicit cite: the caller named this memory as what the save builds on. Always observed: the agent said so. */
  recordFeedback(record: FeedbackRecord): void {
    this.write(() => {
      this.db.prepare(
        `INSERT INTO feedback (at, actor, session_key, agent_key, tool, kind, target, memory_key, subject_key, observed)
         VALUES (?, ?, ?, ?, ?, 'cite', ?, ?, ?, ?)`,
      ).run(
        record.at ?? this.now(), record.actor, record.sessionKey, record.agentKey, record.tool, record.target,
        record.memoryKey, record.subjectKey, record.observed === false ? 0 : 1,
      );
    });
  }

  /** Whether a retrieval in this session served this memory or subject within `windowMs` of the log's clock. Keyed hashes only. */
  servedWithin(sessionKey: string | null, memoryKey: string | null, subjectKey: string | null, windowMs: number): boolean {
    if (sessionKey === null || (memoryKey === null && subjectKey === null)) return false;
    const row = this.db.prepare(
      `SELECT 1 FROM candidates c JOIN retrievals r ON r.id = c.retrieval_id
       WHERE r.session_key = ? AND r.at >= ? AND c.rank IS NOT NULL AND (c.memory_key = ? OR c.subject_key = ?) LIMIT 1`,
    ).get(sessionKey, this.now() - windowMs, memoryKey, subjectKey);
    return row !== undefined;
  }

  /** An outcome of a task. `observed` follows from the basis: a proxy is inferred and is never observed. */
  recordOutcome(record: OutcomeRecord): void {
    this.write(() => {
      this.db.prepare(
        `INSERT INTO outcomes (at, session_key, task_key, outcome, basis, observed) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        record.at ?? this.now(), record.sessionKey, record.taskRef === null ? null : this.key('task', record.taskRef),
        record.outcome, record.basis, OUTCOME_OBSERVED[record.basis],
      );
    });
  }

  /** Deletes what is older than the retention window. Runs when the log opens and then hourly while it is written to. */
  prune(): PruneReport {
    const now = this.now();
    this.lastPrune = now;
    const cutoff = now - this.retentionDays * DAY_MS;
    return this.db.transaction((): PruneReport => {
      const candidates = this.db.prepare(
        'DELETE FROM candidates WHERE retrieval_id IN (SELECT id FROM retrievals WHERE at < ?)',
      ).run(cutoff).changes;
      const retrievals = this.db.prepare('DELETE FROM retrievals WHERE at < ?').run(cutoff).changes;
      const memory_ops = this.db.prepare('DELETE FROM memory_ops WHERE at < ?').run(cutoff).changes;
      const feedback = this.db.prepare('DELETE FROM feedback WHERE at < ?').run(cutoff).changes;
      const outcomes = this.db.prepare('DELETE FROM outcomes WHERE at < ?').run(cutoff).changes;
      return { retrievals, candidates, memory_ops, feedback, outcomes };
    })();
  }

  /**
   * Every row inside the retention window, and nothing else: the key secret stays in the file and never leaves it. Rows older
   * than the window are left out even before a prune has deleted them.
   */
  exportLog(): LearningExport {
    this.maybePrune();
    const tables = {} as LearningExport['tables'];
    const cutoff = this.cutoff();
    for (const table of LEARNING_TABLES) {
      tables[table] = table === 'candidates'
        ? this.db.prepare(
          `SELECT * FROM candidates WHERE retrieval_id IN (SELECT id FROM retrievals WHERE at >= ?) ORDER BY ${ORDER.candidates}`,
        ).all(cutoff) as Array<Record<string, unknown>>
        : this.db.prepare(`SELECT * FROM ${table} WHERE at >= ? ORDER BY ${ORDER[table]}`).all(cutoff) as Array<Record<string, unknown>>;
    }
    return {
      schema: LEARNING_SCHEMA_NAME,
      version: LEARNING_SCHEMA_VERSION,
      exportedAt: new Date(this.now()).toISOString(),
      retentionDays: this.retentionDays,
      tables,
    };
  }

  /**
   * The sharing sender's bounded read (src/sharing/project.ts projectFromLog): the rows with `at` in (after, until], inside the
   * retention window, with only the SERVED candidates (rank set) of those retrievals, and only the columns the projection reads
   * (SHARING_COLUMNS; outcomes are not shared). Same shape as exportLog(), so the projection reads either; this one holds a time
   * slice of a few columns, never the whole log.
   */
  exportServedWindow(after: number, until: number): LearningExport {
    this.maybePrune();
    const from = Math.max(after, this.cutoff() - 1);
    const tables = { outcomes: [] } as unknown as LearningExport['tables'];
    for (const table of ['retrievals', 'candidates', 'memory_ops', 'feedback'] as const) {
      const columns = SHARING_COLUMNS[table].join(', ');
      tables[table] = table === 'candidates'
        ? this.db.prepare(
          `SELECT ${columns} FROM candidates WHERE rank IS NOT NULL AND retrieval_id IN (SELECT id FROM retrievals WHERE at > ? AND at <= ?) ORDER BY ${ORDER.candidates}`,
        ).all(from, until) as Array<Record<string, unknown>>
        : this.db.prepare(`SELECT ${columns} FROM ${table} WHERE at > ? AND at <= ? ORDER BY ${ORDER[table]}`).all(from, until) as Array<Record<string, unknown>>;
    }
    return {
      schema: LEARNING_SCHEMA_NAME,
      version: LEARNING_SCHEMA_VERSION,
      exportedAt: new Date(this.now()).toISOString(),
      retentionDays: this.retentionDays,
      tables,
    };
  }

  /**
   * Where a slice of at most about `limit` rows per table ends: the smallest, over retrievals, memory_ops and feedback, of the
   * time of the `limit`-th row with `at` in (after, until] inside the retention window, or `until` when every table has fewer.
   * Always above `after`. A slice ends on a time, so rows sharing that time are all in it.
   */
  sliceEnd(after: number, until: number, limit: number): number {
    const from = Math.max(after, this.cutoff() - 1);
    let end = until;
    for (const table of ['retrievals', 'memory_ops', 'feedback'] as const) {
      const row = this.db.prepare(`SELECT at FROM ${table} WHERE at > ? AND at <= ? ORDER BY at LIMIT 1 OFFSET ?`)
        .get(from, until, Math.max(0, limit - 1)) as { at: number } | undefined;
      if (row !== undefined) end = Math.min(end, row.at);
    }
    return Math.max(end, Math.min(after + 1, until));
  }

  /**
   * Each session's span and counts over the retention window, done in SQLite (no row is held here): the sessions whose LAST event
   * is in (after, until], oldest last first. `limit` caps how many; the sessions sharing the last one's time are all kept.
   * `first_tool` is the tool of its earliest event (retrievals before memory_ops, then by id, on a tie); `saves` counts the
   * create/supersede operations of `saveTools`; `empty` the retrievals that served nothing.
   */
  sessionSpans(after: number, until: number, saveTools: readonly string[], limit = Number.MAX_SAFE_INTEGER): Array<{
    first: number; last: number; first_tool: string; reads: number; saves: number; empty: number;
  }> {
    this.maybePrune();
    const cutoff = this.cutoff();
    const tools = saveTools.map(() => '?').join(', ');
    const events = `WITH ev AS (
        SELECT session_key AS k, at, 0 AS src, id, tool, 1 AS rd, 0 AS sv, CASE WHEN served = 0 THEN 1 ELSE 0 END AS em
          FROM retrievals WHERE session_key IS NOT NULL AND at >= ?
        UNION ALL
        SELECT session_key, at, 1, id, tool, 0, CASE WHEN tool IN (${tools}) AND op IN ('create', 'supersede') THEN 1 ELSE 0 END, 0
          FROM memory_ops WHERE session_key IS NOT NULL AND at >= ?
      ), ranked AS (
        SELECT k, at, tool, rd, sv, em, ROW_NUMBER() OVER (PARTITION BY k ORDER BY at, src, id) AS n FROM ev
      ), spans AS (
        SELECT k, MIN(at) AS first, MAX(at) AS last, SUM(rd) AS reads, SUM(sv) AS saves, SUM(em) AS empty,
          MAX(CASE WHEN n = 1 THEN tool END) AS first_tool
        FROM ranked GROUP BY k
      )`;
    const params = [cutoff, ...saveTools, cutoff];
    let end = until;
    if (limit < Number.MAX_SAFE_INTEGER) {
      const row = this.db.prepare(`${events} SELECT last FROM spans WHERE last > ? AND last <= ? ORDER BY last LIMIT 1 OFFSET ?`)
        .get(...params, after, until, Math.max(0, limit - 1)) as { last: number } | undefined;
      if (row !== undefined) end = row.last;
    }
    return this.db.prepare(`${events}
      SELECT first, last, reads, saves, empty, first_tool FROM spans WHERE last > ? AND last <= ? ORDER BY last, first`)
      .all(...params, after, end) as Array<{ first: number; last: number; first_tool: string; reads: number; saves: number; empty: number }>;
  }

  /** What a paged export names in the manifest in place of the rows: the schema, the window and the rows per table. */
  exportSummary(): Omit<LearningExport, 'tables'> & { rows: Record<(typeof LEARNING_TABLES)[number], number> } {
    return {
      schema: LEARNING_SCHEMA_NAME,
      version: LEARNING_SCHEMA_VERSION,
      exportedAt: new Date(this.now()).toISOString(),
      retentionDays: this.retentionDays,
      rows: this.counts(),
    };
  }

  /**
   * Up to `limit` rows of the export after `cursor`, the tables in LEARNING_TABLES order and each by id. The cursor is a
   * keyset position, not a row count: `tableIndex * LEARNING_CURSOR_SPAN + the last id read`, so a row written, or one
   * aged out, between two pages moves nothing that was already read and nothing is repeated. The start is cursor 0. Each
   * row comes with the cursor that continues after it. exportLog() holds every row at once; this holds one page.
   */
  exportRowsAfter(
    cursor: number,
    limit: number,
  ): Array<{ table: (typeof LEARNING_TABLES)[number]; row: Record<string, unknown>; cursor: number }> {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || Math.floor(cursor / LEARNING_CURSOR_SPAN) >= LEARNING_TABLES.length) {
      throw new Error(`invalid learning-log cursor ${cursor}`);
    }
    const cutoff = this.cutoff();
    const out: Array<{ table: (typeof LEARNING_TABLES)[number]; row: Record<string, unknown>; cursor: number }> = [];
    let index = Math.floor(cursor / LEARNING_CURSOR_SPAN);
    let lastId = cursor % LEARNING_CURSOR_SPAN;
    for (; index < LEARNING_TABLES.length && out.length < limit; index++, lastId = 0) {
      const table = LEARNING_TABLES[index];
      const take = limit - out.length;
      const rows = (table === 'candidates'
        ? this.db.prepare(
          'SELECT * FROM candidates WHERE id > ? AND retrieval_id IN (SELECT id FROM retrievals WHERE at >= ?) ORDER BY id LIMIT ?',
        ).all(lastId, cutoff, take)
        : this.db.prepare(`SELECT * FROM ${table} WHERE id > ? AND at >= ? ORDER BY id LIMIT ?`).all(lastId, cutoff, take)) as Array<Record<string, unknown>>;
      for (const row of rows) out.push({ table, row, cursor: index * LEARNING_CURSOR_SPAN + Number(row.id) });
    }
    return out;
  }

  /** Row counts inside the retention window. */
  counts(): Record<(typeof LEARNING_TABLES)[number], number> {
    this.maybePrune();
    const cutoff = this.cutoff();
    const count = (table: string): number => {
      const row = (table === 'candidates'
        ? this.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE retrieval_id IN (SELECT id FROM retrievals WHERE at >= ?)').get(cutoff)
        : this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE at >= ?`).get(cutoff)) as { n: number };
      return row.n;
    };
    return Object.fromEntries(LEARNING_TABLES.map(table => [table, count(table)])) as Record<(typeof LEARNING_TABLES)[number], number>;
  }

  private cutoff(): number {
    return this.now() - this.retentionDays * DAY_MS;
  }

  /**
   * Removes every row and replaces the key secret, then shrinks the file. A running server keeps its open handle: it writes
   * into the same file, under the new secret after a restart, and the deleted rows are gone from the file either way.
   */
  deleteAll(): void {
    const secret = randomBytes(32);
    this.db.transaction(() => {
      for (const table of ['candidates', 'retrievals', 'memory_ops', 'feedback', 'outcomes']) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'secret'`).run(secret.toString('hex'));
    })();
    this.secret = secret;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
    } catch {
      // Another connection holds the file. The rows are gone and secure_delete has overwritten them.
    }
  }

  /**
   * Removes every link to a permanently erased memory. The erase operation itself is deliberately
   * not keyed: retaining the old HMAC beside its secret would let a later holder confirm a guess
   * about data the owner erased.
   */
  eraseMemory(memoryKey: string): void {
    this.write(() => {
      this.db.prepare('DELETE FROM candidates WHERE memory_key = ?').run(memoryKey);
      this.db.prepare('DELETE FROM feedback WHERE memory_key = ?').run(memoryKey);
      this.db.prepare('DELETE FROM memory_ops WHERE memory_key = ? OR replaced_key = ?').run(memoryKey, memoryKey);
    });
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private write<T>(fn: () => T): T {
    this.maybePrune();
    return this.db.transaction(fn)();
  }

  private maybePrune(): void {
    if (this.now() - this.lastPrune >= PRUNE_EVERY_MS) this.prune();
  }
}

/** Reads the meta table, makes it on first use, and returns the key secret. Refuses a file that is not this log's version. */
function ensureMeta(db: Database.Database, now: number): Buffer {
  const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
  const meta = new Map(rows.map(row => [row.key, row.value]));
  if (meta.size === 0) {
    const secret = randomBytes(32).toString('hex');
    db.transaction(() => {
      const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      put.run('schema', LEARNING_SCHEMA_NAME);
      put.run('version', String(LEARNING_SCHEMA_VERSION));
      put.run('created_at', new Date(now).toISOString());
      put.run('secret', secret);
    })();
    return Buffer.from(secret, 'hex');
  }
  if (meta.get('schema') !== LEARNING_SCHEMA_NAME || meta.get('version') !== String(LEARNING_SCHEMA_VERSION)) {
    throw new Error(`the learning log file is not a version-${LEARNING_SCHEMA_VERSION} Renor learning log; refusing to use it`);
  }
  const secret = Buffer.from(meta.get('secret') ?? '', 'hex');
  if (secret.length !== 32) throw new Error('the learning log has no usable key secret; refusing to use it');
  return secret;
}

const open = new Map<string, LearningLog>();

/** The one log a process writes per file: the MCP sessions of one memory folder share it. */
export function learningLogAt(settings: { dbPath: string; retentionDays: number; rawQueries: boolean }): LearningLog {
  const cached = open.get(settings.dbPath);
  if (cached) return cached;
  const log = LearningLog.open(settings.dbPath, { retentionDays: settings.retentionDays, rawQueries: settings.rawQueries, create: true });
  if (log === null) throw new Error('the learning log could not be created');
  open.set(settings.dbPath, log);
  return log;
}

export function closeLearningLogs(): void {
  for (const log of open.values()) log.close();
  open.clear();
}
