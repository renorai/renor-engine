import { RANKING_TERMS } from '../retrieval/rankingTrace';

/**
 * The learning log's on-disk contract, version 2 (docs/learning/FEEDBACK-LOG.md is the prose version).
 *
 * The log holds identifiers, keyed hashes and numbers about what the agent retrieved, what it wrote, what it cited and what
 * outcomes were reported. It never holds memory text, a subject or predicate in clear, a path in clear, a credential or a
 * query in clear. The one exception is `query_text`, which exists only when RENOR_LEARNING_RAW_QUERY is on, and then only when
 * the secret scanner does not flag the query (`query_redacted` says when it did).
 *
 * Every `*_key` column is a keyed hash (HMAC-SHA256, 128 bits) under a secret that is random per log and never exported:
 * the same memory, query or session gets the same key within one log, and different keys in any other log.
 *
 * Version 2 adds, for every candidate the ranker scored or presented, its base score and one numeric column per additive term
 * the ranker applied (`term_*`, from RANKING_TERMS), so that base + the terms is the score it ranked by and the weights can be
 * refitted from the log. It also records the candidate's rank in the scored pool, its position in the presented window and
 * whether the budget kept it. Version 1 was never released; a version 1 file is refused, not migrated.
 */

export const LEARNING_SCHEMA_NAME = 'renor-learning-log';
export const LEARNING_SCHEMA_VERSION = 2;

/** The ranking procedure that ordered a reply. The shipped product ranking is `baseline`; a learned ranker writes its own name. */
export const RANKER_BASELINE = 'baseline';

/** Tools whose successful replies are recorded as retrievals (one row each, with its candidates). */
export const RETRIEVAL_TOOLS = ['get_context', 'search_memory', 'retrieve_memory'] as const;
/** Tools whose successful calls are recorded as memory operations or, for the save tools, as explicit citations too. */
export const WRITE_TOOLS = [
  'remember', 'save_memory', 'remember_note', 'retire_memory', 'restore_memory', 'delete_retired_memory', 'read_memory',
] as const;
export const SAVE_TOOLS = ['remember', 'save_memory', 'remember_note'] as const;

/** Who made the call: the agent over MCP, or the owner's dashboard (the platform acting for the owner). */
export const ACTORS = ['agent', 'dashboard'] as const;
/** What a candidate or an operation refers to. `unkeyed`: the reply named nothing a memory key can be made from. */
export const CANDIDATE_KINDS = ['fact', 'note', 'unkeyed'] as const;
export const OPERATION_KINDS = ['fact', 'note', 'event', 'unkeyed'] as const;
export const OPERATIONS = ['create', 'supersede', 'delete', 'restore', 'erase', 'retrieve'] as const;
export const CITE_TARGETS = ['note', 'event', 'subject', 'unkeyed'] as const;
export const OUTCOME_VALUES = ['success', 'failure', 'partial', 'unknown'] as const;
/**
 * Where an outcome came from. `verifier` (a check that ran) and `user` (the owner said so) are observed. `proxy` is anything
 * inferred from behaviour, such as "no correction followed"; it is stored with observed = 0 and is never a success by itself.
 */
export const OUTCOME_BASES = ['verifier', 'user', 'proxy'] as const;

/** The column of each ranker term in `candidates`: `term_<name>`, in RANKING_TERMS order. */
export const TERM_COLUMNS = RANKING_TERMS.map(term => `term_${term}`);

/** The tables, in the order an export lists them. `meta` holds the schema name, its version, the creation instant and the key secret. */
export const LEARNING_TABLES = ['retrievals', 'candidates', 'memory_ops', 'feedback', 'outcomes'] as const;

const list = (values: readonly string[]): string => values.map(value => `'${value}'`).join(', ');

/**
 * Where a call came from, already reduced to closed lists (src/sharing/context.ts) before it is written: the AI application's family
 * (never its declared name), the engine's released version, and the tool set the connection had. Added to version 2 in place
 * (2026-11-08): the columns are nullable, a log made before them gets them on open (store.ts addCallContext) and its older rows read null.
 */
export const CALL_CONTEXT_COLUMNS = ['app', 'release', 'profile'] as const;
const CALL_CONTEXT_DDL = `app TEXT,                                  -- the AI application's family (sharing/context.ts appFamily), never its name
  release TEXT,                              -- the engine's released version as major.minor, NULL otherwise
  profile TEXT                               -- the connection's tool set: full, coding, lean, custom`;

export const LEARNING_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS retrievals (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,                       -- unix ms
  tool TEXT NOT NULL CHECK (tool IN (${list(RETRIEVAL_TOOLS)})),
  actor TEXT NOT NULL CHECK (actor IN (${list(ACTORS)})),
  session_key TEXT,                          -- keyed hash of the MCP session; NULL when the server keeps none
  agent_key TEXT,                            -- keyed hash of the agent name the connection presented ('unnamed' when none)
  query_key TEXT,                            -- keyed hash of the normalized query; NULL when the call had none
  query_text TEXT,                           -- the raw query: RENOR_LEARNING_RAW_QUERY only, never when query_redacted = 1
  query_redacted INTEGER NOT NULL DEFAULT 0 CHECK (query_redacted IN (0, 1)),
  scope_key TEXT,                            -- keyed hash of the normalized scope ('global' when none was named)
  retrieval TEXT,                            -- the reply's retrieval mode, when it names one
  ranker TEXT NOT NULL,                      -- which procedure ordered the candidates (RANKER_BASELINE for the shipped one)
  model TEXT,                                -- embedding model identity (<provider>:<model>:<dims>); NULL when keyword only
  build TEXT,                                -- commit of the running build, NULL when unstamped
  served INTEGER NOT NULL,                   -- candidates the reply served (rows in candidates with a rank)
  ms REAL NOT NULL,                          -- wall time of the handler
  reply_tokens INTEGER,                      -- o200k tokens of the whole reply, as the max_tokens budget counts them
  relevant INTEGER CHECK (relevant IS NULL OR relevant IN (0, 1)),   -- the engine's own verdict, when it judged
  truncated INTEGER CHECK (truncated IS NULL OR truncated IN (0, 1)),
  lean_items INTEGER NOT NULL DEFAULT 0 CHECK (lean_items IN (0, 1)),  -- RENOR_CONTEXT_LEAN_ITEMS was on: no note paths in the reply
  ${CALL_CONTEXT_DDL}
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  retrieval_id INTEGER NOT NULL REFERENCES retrievals(id) ON DELETE CASCADE,
  rank INTEGER,                              -- 1-based position in the reply (facts first, then memories, as served); NULL when not served
  kind TEXT NOT NULL CHECK (kind IN (${list(CANDIDATE_KINDS)})),
  memory_key TEXT,                           -- fact: scope + subject + predicate; note: the note path
  subject_key TEXT,                          -- fact only: the subject within its scope (joins cites that name it, in that scope)
  section_key TEXT,                          -- note only: the heading path inside the note, when there is one
  score REAL,                                -- the score the candidate was ranked by: the reply's, or base + terms when not served
  base REAL,                                 -- the score before any term: a cosine, 0.3 for a graph hit, the fact lane's, 0 for a statement; NULL when untraced
  ${TERM_COLUMNS.map(column => `${column} REAL NOT NULL DEFAULT 0,`).join('\n  ')}
  pool_rank INTEGER,                         -- 1-based rank in the scored pool (score order, before the window cut); NULL when not scored
  window_pos INTEGER,                        -- 1-based position in the order the reply presents its hits, before any budget cut; NULL when not presented
  budget_kept INTEGER CHECK (budget_kept IS NULL OR budget_kept IN (0, 1)),   -- 1 kept by max_tokens, 0 cut; NULL when the read had no budget
  reason TEXT,                               -- the lane that matched (fact, fts, semantic, semantic+content+recency, ...)
  matched INTEGER CHECK (matched IS NULL OR matched IN (0, 1)),   -- 0: the reply marked it as not matched
  current INTEGER CHECK (current IS NULL OR current IN (0, 1))    -- retrieve_memory: 0 for a superseded value
);

CREATE TABLE IF NOT EXISTS memory_ops (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN (${list(ACTORS)})),
  session_key TEXT,
  agent_key TEXT,
  tool TEXT NOT NULL CHECK (tool IN (${list(WRITE_TOOLS)})),
  op TEXT NOT NULL CHECK (op IN (${list(OPERATIONS)})),
  kind TEXT NOT NULL CHECK (kind IN (${list(OPERATION_KINDS)})),
  memory_key TEXT,
  subject_key TEXT,
  replaced_key TEXT,                         -- supersede only: the memory identity whose value the new save replaces
  ms REAL NOT NULL,
  ${CALL_CONTEXT_DDL}
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN (${list(ACTORS)})),
  session_key TEXT,
  agent_key TEXT,
  tool TEXT NOT NULL CHECK (tool IN (${list(SAVE_TOOLS)})),
  kind TEXT NOT NULL CHECK (kind IN ('cite')),   -- the explicit cites argument of a save
  target TEXT NOT NULL CHECK (target IN (${list(CITE_TARGETS)})),
  memory_key TEXT,
  subject_key TEXT,
  observed INTEGER NOT NULL DEFAULT 1 CHECK (observed IN (0, 1))
);

CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  session_key TEXT,
  task_key TEXT,                             -- keyed hash of an opaque task reference the caller supplies; NULL when none
  outcome TEXT NOT NULL CHECK (outcome IN (${list(OUTCOME_VALUES)})),
  basis TEXT NOT NULL CHECK (basis IN (${list(OUTCOME_BASES)})),
  observed INTEGER NOT NULL CHECK (observed IN (0, 1))   -- 1 unless basis = proxy
);

CREATE INDEX IF NOT EXISTS retrievals_at ON retrievals (at);
CREATE INDEX IF NOT EXISTS candidates_retrieval ON candidates (retrieval_id, rank);
CREATE INDEX IF NOT EXISTS candidates_memory ON candidates (memory_key);
CREATE INDEX IF NOT EXISTS memory_ops_at ON memory_ops (at);
CREATE INDEX IF NOT EXISTS memory_ops_memory ON memory_ops (memory_key);
CREATE INDEX IF NOT EXISTS feedback_at ON feedback (at);
CREATE INDEX IF NOT EXISTS outcomes_at ON outcomes (at);
`;
