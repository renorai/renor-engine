import Database from './sqlite';
import { createLogger } from '../mvp/log';

const log = createLogger('engine', { stderr: true });

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      const ddl = [
        `CREATE TABLE IF NOT EXISTS notes (
          path TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          kind TEXT,
          note_hash TEXT NOT NULL,
          modified_at TEXT NOT NULL,
          frontmatter_json TEXT NOT NULL DEFAULT '{}'
        )`,
        `CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
          heading_path TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          token_count INTEGER NOT NULL,
          chunk_hash TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS entities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          canonical_name TEXT NOT NULL,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          source_note TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
          confidence REAL NOT NULL DEFAULT 1.0,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject_entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
          predicate TEXT NOT NULL,
          object_text TEXT,
          object_entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
          source_path TEXT NOT NULL,
          source_chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          valid_from TEXT NOT NULL,
          valid_to TEXT,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          relation TEXT NOT NULL,
          target_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          source_note TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0
        )`,
        `CREATE TABLE IF NOT EXISTS write_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          note_path TEXT NOT NULL,
          action TEXT NOT NULL,
          summary TEXT,
          created_at TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_chunks_note ON chunks(note_path)`,
        `CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(canonical_name)`,
        `CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_path)`,
        `CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id)`,
        `CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id)`,
        `CREATE INDEX IF NOT EXISTS idx_entities_source_note ON entities(source_note)`,
        `CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_entity_id)`,
      ];
      for (const sql of ddl) db.prepare(sql).run();
    },
  },
  {
    version: 2,
    name: 'uniqueness_constraints',
    up: (db) => {
      db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique ON relations(source_entity_id, relation, target_entity_id)`).run();
      db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_unique ON facts(subject_entity_id, predicate, object_text)`).run();
    },
  },
  {
    version: 3,
    name: 'fts5_chunks',
    up: () => {
      // Intentionally left as no-op — superseded by migration 4
    },
  },
  {
    version: 4,
    name: 'fts5_chunks_fixed',
    up: (db) => {
      // Drop any partial v3 artefacts
      db.prepare(`DROP TABLE IF EXISTS chunks_fts`).run();
      db.prepare(`DROP TRIGGER IF EXISTS chunks_fts_insert`).run();
      db.prepare(`DROP TRIGGER IF EXISTS chunks_fts_delete`).run();
      db.prepare(`DROP TRIGGER IF EXISTS chunks_fts_update`).run();

      db.prepare(`
        CREATE VIRTUAL TABLE chunks_fts
        USING fts5(text, heading_path, note_path UNINDEXED, content='chunks', content_rowid='id')
      `).run();
      // Populate from existing chunks
      db.prepare(`INSERT INTO chunks_fts(rowid, text, heading_path, note_path) SELECT id, text, heading_path, note_path FROM chunks`).run();
      // Triggers to keep FTS in sync with chunks table
      db.prepare(`
        CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, text, heading_path, note_path) VALUES (new.id, new.text, new.heading_path, new.note_path);
        END
      `).run();
      db.prepare(`
        CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text, heading_path, note_path) VALUES ('delete', old.id, old.text, old.heading_path, old.note_path);
        END
      `).run();
      db.prepare(`
        CREATE TRIGGER chunks_fts_update AFTER UPDATE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text, heading_path, note_path) VALUES ('delete', old.id, old.text, old.heading_path, old.note_path);
          INSERT INTO chunks_fts(rowid, text, heading_path, note_path) VALUES (new.id, new.text, new.heading_path, new.note_path);
        END
      `).run();
    },
  },
  {
    version: 5,
    name: '5_facts_event_id',
    up: (db: Database.Database) => {
      const cols = (db.prepare('PRAGMA table_info(facts)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('event_id')) {
        db.exec('ALTER TABLE facts ADD COLUMN event_id TEXT');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_event ON facts(event_id)');
      }
    },
  },
  {
    version: 6,
    name: '6_lifecycle_event_identity',
    up: (db: Database.Database) => {
      // B1: uniqueness is event identity, not (subject, predicate, object).
      // The v2 index made A→B→A supersession impossible (replay and even the
      // live write threw UNIQUE) — closed history may legitimately repeat a
      // value. Replace it with the engine's real invariant: at most ONE
      // current (valid_to IS NULL) fact per (subject_entity_id, predicate).
      db.prepare('DROP INDEX IF EXISTS idx_facts_unique').run();
      const now = new Date().toISOString();
      // Repair pre-existing violations of that invariant — SCOPED to canonical
      // lifecycle facts (source_path '_mcp_'): only lifecycle streams are
      // single-current by design. Extracted/frontmatter facts may legitimately
      // hold multiple current values per (entity, predicate) and are NOT
      // touched. Deterministically keep the newest current fact per
      // (subject, predicate) and close the rest. NOTE (K12): this interim
      // choice is made without ledger access (migrations are DB-only); the
      // startup replay that follows canonicalizes every lifecycle stream from
      // ledger order (reconcileStreamCurrent) BEFORE readiness, so any
      // non-canonical survivor/valid_to this repair leaves is corrected there.
      db.prepare(`
        UPDATE facts SET valid_to = ?, updated_at = ?
        WHERE source_path = '_mcp_' AND id IN (
          SELECT id FROM (
            SELECT f.id AS id,
                   ROW_NUMBER() OVER (
                     PARTITION BY f.subject_entity_id, f.predicate
                     ORDER BY f.valid_from DESC, f.id DESC
                   ) AS rn
            FROM facts f WHERE f.valid_to IS NULL AND f.source_path = '_mcp_'
          ) WHERE rn > 1
        )
      `).run(now, now);
      db.prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_current ON facts(subject_entity_id, predicate) WHERE valid_to IS NULL AND source_path = '_mcp_'`
      ).run();
      // B1 replay idempotency: byte-identical events dedup, a reused event id
      // with a conflicting payload fails explicitly instead of being skipped.
      db.exec(`
        CREATE TABLE IF NOT EXISTS applied_ledger_events (
          event_id TEXT PRIMARY KEY,
          digest TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 7,
    name: '7_scope_lifecycle_current_index',
    up: (db: Database.Database) => {
      // Repair pass (Astra A1/Kimi K3): the first Gate1A candidate's migration 6
      // scoped the single-current index to ALL facts, which silently rejected
      // legitimate extracted/frontmatter facts sharing (entity, predicate) and
      // (in its duplicate repair) closed unrelated current rows. Re-scope the
      // index to canonical lifecycle facts only (source_path '_mcp_'). This
      // also upgrades DBs that already applied the candidate's globally-scoped
      // migration 6. Limitation (documented in GATE1A-EVIDENCE.md): duplicate
      // non-lifecycle current rows that the candidate's global v6 repair
      // already closed cannot be un-closed; recovery is a rebuild/reindex,
      // which re-extracts them from the source notes.
      db.prepare('DROP INDEX IF EXISTS idx_facts_current').run();
      db.prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_current ON facts(subject_entity_id, predicate) WHERE valid_to IS NULL AND source_path = '_mcp_'`
      ).run();
    },
  },
  {
    version: 8,
    name: '8_facts_scope',
    up: (db: Database.Database) => {
      // Optional product scope on lifecycle facts. Missing/legacy = 'global'.
      // Uniqueness becomes (subject_entity_id, predicate, scope) for current
      // _mcp_ facts so the same subject+predicate can coexist across scopes.
      const cols = (db.prepare('PRAGMA table_info(facts)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('scope')) {
        db.exec(`ALTER TABLE facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
      }
      db.prepare('DROP INDEX IF EXISTS idx_facts_current').run();
      db.prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_current ON facts(subject_entity_id, predicate, scope) WHERE valid_to IS NULL AND source_path = '_mcp_'`
      ).run();
    },
  },

  {
    version: 9,
    name: '9_structured_rows',
    up: (db: Database.Database) => {
      // C0 (ADR-0003 §4): one provenance-backed structured-row store for the
      // fact/event/preference extraction lanes. Every row traces to its source
      // note via source_path FK ON DELETE CASCADE — the legacy `facts` table
      // (v1) has no FK and the watcher's unlink handler orphans rows today
      // (src/watcher/watcher.ts), so this migration also performs a one-time
      // purge of already-orphaned legacy fact rows.
      db.exec(`
        CREATE TABLE IF NOT EXISTS structured_rows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          row_kind TEXT NOT NULL CHECK (row_kind IN ('fact', 'event', 'preference')),
          source_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
          source_hash TEXT NOT NULL,
          source_chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
          scope TEXT NOT NULL DEFAULT 'global',
          extraction_version TEXT NOT NULL,
          valid_from TEXT,
          valid_to TEXT,
          payload_json TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_structured_rows_source ON structured_rows(source_path)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_structured_rows_current ON structured_rows(row_kind, scope, dedupe_key) WHERE valid_to IS NULL`);
      // One-time orphan purge: rows in the legacy (FK-less) `facts` table whose
      // source note no longer resolves can never be composed (no provenance);
      // remove them instead of carrying a permanent live defect.
      const hasFacts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facts'").get();
      if (hasFacts) {
        db.prepare('DELETE FROM facts WHERE source_path NOT IN (SELECT path FROM notes)').run();
      }
    },
  },

  {
    version: 10,
    name: '10_structured_rows_confirm_count',
    up: (db: Database.Database) => {
      // C2 facts write-path: confirm count for dedupe adjudication (HYP card
      // plan step 2 — dedupe on (value, NFKD-ASCII-lowercased object) with a
      // confirm count). Identical re-extraction bumps the count instead of
      // writing a duplicate row.
      const cols = (db.prepare('PRAGMA table_info(structured_rows)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('confirm_count')) {
        db.exec('ALTER TABLE structured_rows ADD COLUMN confirm_count INTEGER NOT NULL DEFAULT 1');
      }
    },
  },
  {
    version: 11,
    name: '11_structured_rows_current_identity_unique',
    up: (db: Database.Database) => {
      // C2 review fix (P2): close the check-then-act race across `await
      // model.decide` — concurrent same-identity inserts from the same source
      // note can no longer double-insert. Partial index: only current rows
      // (valid_to IS NULL) participate, so closed/superseded history may
      // legitimately repeat an identity, and the source_path column keeps
      // cross-note NULL-date coexistence intact. Pre-repair: deterministically
      // close any pre-existing same-source duplicate current rows (keep the
      // lowest id — the same row the dedupe adjudication reads first), so the
      // index creation cannot fail on legacy data.
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE structured_rows SET valid_to = ?
        WHERE valid_to IS NULL AND id IN (
          SELECT id FROM (
            SELECT r.id AS id,
                   ROW_NUMBER() OVER (
                     PARTITION BY r.row_kind, r.scope, r.dedupe_key, r.source_path
                     ORDER BY r.id
                   ) AS rn
            FROM structured_rows r WHERE r.valid_to IS NULL
          ) WHERE rn > 1
        )
      `).run(now);
      db.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_structured_rows_current_identity
        ON structured_rows(row_kind, scope, dedupe_key, source_path)
        WHERE valid_to IS NULL
      `).run();
    },
  },

  {
    version: 12,
    name: '12_lane_runs',
    up: (db: Database.Database) => {
      // #189: the zero-yield half of the ADR-0003 §4.2 lane cache.
      //
      // The row-based half lives in structured_rows: a CURRENT row for
      // (source_path, row_kind, source_hash, extraction_version) means "this
      // lane is done for these bytes". A lane that RUNS and produces nothing
      // leaves no row, so that half cannot record it and every later pass over
      // the same unchanged note calls the extractor again — repeated model
      // calls and rate-limit exposure for a note that yielded nothing.
      //
      // This table is the checkpoint of the last COMPLETED run of one lane on
      // one note. It is deliberately NOT a row in structured_rows: that table
      // is the scored side of the eval boundary, and a marker row there would
      // be served as an extracted fact.
      //
      // `max_rows_written` is what a COMPLETED run's adjudicated writes
      // returned, kept as a MAXIMUM over the runs of one key. It is deliberately
      // NOT a count read back out of structured_rows: that was a snapshot of
      // mutable DB state, and a delayed writer could overwrite a truthful
      // nonzero record with a stale zero (primary review B1 at head aeb388e),
      // suppressing the lane for bytes that do yield rows. It is also
      // deliberately monotone (never lowered): two concurrent runs can disagree
      // about the same bytes — the extractor is a model — and the later-finishing
      // one must not be able to erase a positive outcome with a zero (review B1
      // at head 9397d50). 0 therefore means "no completed run for these bytes
      // ever wrote a row", which is the safe direction to skip on.
      //
      // Key shape is the same cache key plus the lane, so a zero-yield fact
      // lane can never suppress events or preferences on the same bytes.
      // Growth is bounded by the armed lanes being default-off and by the
      // indexer only touching changed notes; one row per (note, lane,
      // content-version) is the ceiling.
      db.exec(`
        CREATE TABLE IF NOT EXISTS lane_runs (
          source_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
          row_kind TEXT NOT NULL CHECK (row_kind IN ('fact', 'event', 'preference')),
          source_hash TEXT NOT NULL,
          extraction_version TEXT NOT NULL,
          max_rows_written INTEGER NOT NULL,
          completed_at TEXT NOT NULL,
          PRIMARY KEY (source_path, row_kind, source_hash, extraction_version)
        )
      `);
    },
  },

  {
    version: 13,
    name: '13_note_identity_fts',
    up: (db: Database.Database) => {
      // An identifier that NAMES a note (slug, file name, frontmatter id) is not in
      // chunk text, so chunks_fts cannot find it. Index it once, per note, with `-_.%`
      // as token characters: `space-bunny-eval-1001` is then a single whole token and
      // a query for it matches exactly that token — not `4242`, not `md`.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS note_identity_fts
        USING fts5(ident, tokenize = "unicode61 tokenchars '-_.%'")
      `);
      const ident = (n: string) => `(
        ${n}.path || ' ' || CASE WHEN ${n}.path LIKE '%.md' THEN substr(${n}.path, 1, length(${n}.path) - 3) ELSE ${n}.path END
        || ' ' || CASE WHEN json_valid(${n}.frontmatter_json)
             THEN coalesce((SELECT group_concat(value, ' ') FROM json_tree(${n}.frontmatter_json) WHERE type = 'text'), '')
             ELSE '' END
      )`;
      db.exec(`
        DROP TRIGGER IF EXISTS note_identity_fts_insert;
        DROP TRIGGER IF EXISTS note_identity_fts_update;
        DROP TRIGGER IF EXISTS note_identity_fts_delete;
        CREATE TRIGGER note_identity_fts_insert AFTER INSERT ON notes BEGIN
          INSERT INTO note_identity_fts(rowid, ident) VALUES (new.rowid, ${ident('new')});
        END;
        CREATE TRIGGER note_identity_fts_update AFTER UPDATE OF path, frontmatter_json ON notes BEGIN
          DELETE FROM note_identity_fts WHERE rowid = old.rowid;
          INSERT INTO note_identity_fts(rowid, ident) VALUES (new.rowid, ${ident('new')});
        END;
        CREATE TRIGGER note_identity_fts_delete AFTER DELETE ON notes BEGIN
          DELETE FROM note_identity_fts WHERE rowid = old.rowid;
        END;
      `);
      db.exec(`DELETE FROM note_identity_fts`);
      db.exec(`INSERT INTO note_identity_fts(rowid, ident) SELECT n.rowid, ${ident('n')} FROM notes n`);
    },
  },

  {
    version: 14,
    name: '14_fact_terms',
    up: (db: Database.Database) => {
      // Lifecycle facts are found by the words in them. This inverted index (memory/factTerms.ts)
      // lets a search read the rows of the query's words instead of every fact. The write path fills
      // it in the transaction that writes a fact and ensureFactTerms fills it for facts that already
      // exist, so the migration only creates the schema.
      db.exec(`
        CREATE TABLE IF NOT EXISTS fact_terms (
          term TEXT NOT NULL,
          scope TEXT NOT NULL,
          fact_id INTEGER NOT NULL,
          PRIMARY KEY (term, scope, fact_id)
        ) WITHOUT ROWID
      `);
      // The current lifecycle facts in time order (every scope, and one scope), for a read of the newest
      // with no query: read backwards, they need no sort. Ascending, so a new fact appends to them.
      // Partial, so note-derived facts never touch them.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_lifecycle_recent ON facts(valid_from, id) WHERE valid_to IS NULL AND source_path = '_mcp_'`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_lifecycle_scope_recent ON facts(scope, valid_from, id) WHERE valid_to IS NULL AND source_path = '_mcp_'`);
    },
  },

  {
    version: 15,
    name: '15_notes_unfinished',
    up: (db: Database.Database) => {
      // A file whose last index pass did not finish (its embedding failed) keeps an empty note hash until a later
      // pass finishes it (indexer/pipeline.ts). A search asks whether there is one (mvp/engine.ts, UNFINISHED_FILES):
      // partial, so the answer comes from those few rows, usually none, not from every note.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_unfinished ON notes(path) WHERE note_hash = ''`);
    },
  },

  {
    version: 16,
    name: '16_foreign_key_indexes',
    up: (db: Database.Database) => {
      // Every index pass replaces a note's entity, and a pass over an edited or appended note deletes the chunks it
      // replaces. Each deleted row makes SQLite find the rows whose foreign keys point at it, and these three columns
      // had no index, so every save read every fact (and every structured row) once per row it deleted. A table
      // older than these columns has no such key to look up, and gets no index.
      const has = (table: string, column: string) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
      if (has('facts', 'source_chunk_id')) db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_source_chunk ON facts(source_chunk_id)`);
      if (has('facts', 'object_entity_id')) db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_object_entity ON facts(object_entity_id)`);
      if (has('structured_rows', 'source_chunk_id')) {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_structured_rows_source_chunk ON structured_rows(source_chunk_id)`);
      }
    },
  },

  {
    version: 17,
    name: '17_retired_facts',
    up: (db: Database.Database) => {
      // A retired lifecycle fact (memory/lifecycle.ts, retireFact) leaves `facts` for this table, row and id unchanged,
      // so no read of `facts` can return it and restore puts back the same row. Like `facts`, it is derived from the
      // ledger's retire and restore events and rebuilt by a replay. `fact_retirements` lists those events, whose
      // ledger text a search never shows (retrieval/ledgerLiveness.ts).
      db.exec(`
        CREATE TABLE IF NOT EXISTS retired_facts (
          id INTEGER PRIMARY KEY,
          subject_entity_id INTEGER NOT NULL,
          predicate TEXT NOT NULL,
          object_text TEXT,
          confidence REAL NOT NULL,
          valid_from TEXT NOT NULL,
          valid_to TEXT,
          updated_at TEXT NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          scope TEXT NOT NULL,
          retire_event_id TEXT NOT NULL,
          retired_at TEXT NOT NULL,
          retired_by TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_retired_facts_stream ON retired_facts(subject_entity_id, predicate)`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS fact_retirements (
          event_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          target TEXT NOT NULL,
          at TEXT NOT NULL,
          source TEXT NOT NULL
        )
      `);
    },
  },

  {
    version: 18,
    name: '18_fact_author',
    up: (db: Database.Database) => {
      // Who wrote a lifecycle fact and a write event. Null on rows saved before a connection key had a name.
      // A table this database does not have (a partial legacy schema) is left alone.
      const add = (table: string, column: string) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (cols.length > 0 && !cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      };
      add('facts', 'author');
      add('retired_facts', 'author');
      add('write_events', 'author');
    },
  },

  {
    version: 19,
    name: '19_whats_new_cursor',
    up: (db: Database.Database) => {
      const cols = db.prepare('PRAGMA table_info(write_events)').all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some(c => c.name === 'scope')) db.exec('ALTER TABLE write_events ADD COLUMN scope TEXT');
      db.exec(`CREATE TABLE IF NOT EXISTS agent_cursors (
        agent TEXT NOT NULL,
        scope TEXT NOT NULL,
        last_at TEXT NOT NULL,
        last_id INTEGER NOT NULL,
        PRIMARY KEY (agent, scope)
      )`);
    },
  },

  {
    version: 20,
    name: '20_agent_requests',
    up: (db: Database.Database) => {
      // A request is a record. Nothing here runs a tool or writes a memory.
      db.exec(`CREATE TABLE IF NOT EXISTS agent_requests (
        id TEXT PRIMARY KEY,
        scope TEXT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'closed')),
        created_at TEXT NOT NULL,
        answered_at TEXT,
        closed_at TEXT
      )`);
    },
  },

  {
    version: 21,
    name: '21_known_agents',
    up: (db: Database.Database) => {
      // The connection names (x-renor-agent, set by the gateway from each key's label) this workspace has seen:
      // who ask_agent can address. ask_agent's hourly limit counts agent_requests by sender.
      db.exec(`CREATE TABLE IF NOT EXISTS known_agents (
        agent TEXT PRIMARY KEY,
        first_seen TEXT NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS agent_requests_from_at ON agent_requests (from_agent, created_at)');
    },
  },

  {
    version: 22,
    name: '22_agent_leases',
    up: (db: Database.Database) => {
      // One live stdio process per hive name. The holder is pid:nonce; a dead pid may be replaced.
      db.exec(`CREATE TABLE IF NOT EXISTS agent_leases (
        agent TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        seen_at TEXT NOT NULL
      )`);
    },
  },

  {
    version: 23,
    name: '23_index_state',
    up: (db: Database.Database) => {
      // Small facts about the index itself that must survive a crash: `reindex_pending` is set when the rows of a moved
      // folder were removed, and cleared only once the folder is indexed again (see outsideRoot.ts).
      db.exec(`CREATE TABLE IF NOT EXISTS index_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
    },
  },

  {
    // Versions 22 (agent_leases) and 23 (index_state) are taken on main; this clock migration follows them.
    version: 24,
    name: '24_note_index_clock',
    up: (db: Database.Database) => {
      // Observation time, independent of a note's content-date window and of rows indexing can replace/delete.
      db.exec(`CREATE TABLE IF NOT EXISTS note_index_clock (
        scope TEXT PRIMARY KEY,
        observed_at TEXT NOT NULL
      )`);
      // Existing indexes already carry the indexer's own stamp in updated_at. Never seed from valid_from:
      // that can be a content date in the future. Scope spellings stay compatible with savedScopeSqlPredicate.
      db.exec(`INSERT INTO note_index_clock (scope, observed_at)
        SELECT COALESCE(scope, 'global'), MAX(updated_at) FROM facts WHERE source_path <> '_mcp_'
        GROUP BY COALESCE(scope, 'global')
        ON CONFLICT(scope) DO UPDATE SET observed_at = MAX(note_index_clock.observed_at, excluded.observed_at)`);
    },
  },

  {
    version: 25,
    name: '25_fact_statement_words',
    up: (db: Database.Database) => {
      // The words of the statement a lifecycle fact was saved with (memory/factTerms.ts `statementTerms`), so the facts
      // lane can count them toward a question's words. Null on a fact with no statement (save_memory) and on rows saved
      // before this column; the replay backfills those from the ledger (lifecycle.ts `backfillStatementWords`).
      // A table this database does not have (a partial legacy schema) is left alone.
      const add = (table: string, column: string) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (cols.length > 0 && !cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      };
      add('facts', 'statement_words');
      add('retired_facts', 'statement_words');
    },
  },

  {
    version: 26,
    name: '26_fact_writers',
    up: (db: Database.Database) => {
      // Who saved each lifecycle fact (memory/writerConflicts.ts): the writer its connection authenticated, and the values
      // it replaced that their writers have not confirmed yet. Keyed by the fact's event, so retiring and restoring a
      // fact (which keep the event) keep its row, and a replay of the ledger writes it again. A fact with no row was saved
      // before this table: its writer is its source and it has no open displacements.
      db.exec(`
        CREATE TABLE IF NOT EXISTS fact_writers (
          event_id TEXT PRIMARY KEY,
          writer TEXT NOT NULL,
          displaced TEXT NOT NULL DEFAULT '[]'
        )
      `);
    },
  },

  {
    version: 27,
    name: '27_erased_facts',
    up: (db: Database.Database) => {
      // Content-free receipts for fact erasures. The authoritative tombstone is in the ledger; this projection makes
      // retries and restore refusals cheap without retaining subject, predicate, object, statement, scope, or source.
      db.exec(`CREATE TABLE IF NOT EXISTS erased_facts (
        event_id TEXT PRIMARY KEY,
        original_digest TEXT NOT NULL,
        erased_at TEXT NOT NULL
      )`);
    },
  },

  {
    version: 28,
    name: '28_erased_facts_closes',
    up: (db: Database.Database) => {
      // The closing link of an erasure (event ids and a time, no content), kept here as well as in the tombstone: a retry that
      // has to redo a lost rewrite cannot read it from the facts tables, which a restart may have reconciled without it.
      const cols = db.prepare('PRAGMA table_info(erased_facts)').all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'closes')) db.exec('ALTER TABLE erased_facts ADD COLUMN closes TEXT');
      if (!cols.some(c => c.name === 'closed_at')) db.exec('ALTER TABLE erased_facts ADD COLUMN closed_at TEXT');
    },
  },
  {
    version: 29,
    name: '29_facts_event_nocase_index',
    up: (db: Database.Database) => {
      // Additive only: the event lookup of search_memory (mvp/readUsefulness.ts) compares event ids without case through this
      // index. No row is rewritten; the index holds one entry per fact, as the unique index on event_id does. A vault recorded
      // at version 8 with the first facts table has no event_id, and migration 5 never runs for it again: the index waits for
      // the column, as migration 5 does, so the engine boots on such a vault.
      const cols = (db.prepare('PRAGMA table_info(facts)').all() as { name: string }[]).map((c) => c.name);
      if (cols.includes('event_id')) db.exec('CREATE INDEX IF NOT EXISTS idx_facts_event_nocase ON facts(event_id COLLATE NOCASE)');
    },
  },
  {
    version: 30,
    name: '30_standing_rule_approvals',
    up: (db: Database.Database) => {
      db.exec(`CREATE TABLE IF NOT EXISTS standing_rule_approvals (
        rule_key TEXT PRIMARY KEY,
        event_id TEXT,
        approved_at TEXT NOT NULL,
        via TEXT NOT NULL
      )`);
    },
  },

];

export function runMigrations(db: Database.Database): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`).run();

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  let currentVersion = row?.version ?? 0;

  // If DB has no version but has tables (existing install), assume v1
  if (currentVersion === 0) {
    const hasNotes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").get();
    if (hasNotes) {
      migrations[0].up(db);
      currentVersion = 1;
    }
  }

  const debug = process.env.RENOR_LOG_LEVEL === 'debug';
  const startedAt = Date.now();
  let applied = 0;
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    db.transaction(() => {
      migration.up(db);
      if (currentVersion === 0 && migration.version === 1) {
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
      } else {
        db.prepare('UPDATE schema_version SET version = ?').run(migration.version);
      }
    })();
    currentVersion = migration.version;
    applied += 1;
    if (debug) log.info('migration_applied', { version: migration.version, name: migration.name });
  }
  // One summary line instead of one stderr line per migration: MCP clients show stderr to the user.
  if (applied > 0 && !debug) log.info('database_ready', { migrations: applied, ms: Date.now() - startedAt });
}
