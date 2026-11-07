import Database from '../db/sqlite';
import { boundContentDate } from '../retrieval/orchestrator';

/**
 * C0 structured-row store (ADR-0003 §4): one shared row shape for the typed
 * fact / event / preference extraction lanes. Every row is provenance-backed
 * (source_path FK → notes ON DELETE CASCADE, exact source chunk id) and dated
 * from note content (valid_from); unknown dates stay NULL and are never
 * fabricated. Supersession is identity-keyed only — blanket newest-wins is
 * REJECTED (N18 KILL), and a NULL-date identity collision never supersedes in
 * v1 (both rows stay current).
 */

export type RowKind = 'fact' | 'event' | 'preference';

/** Lane payload schemas (research inventories §1, v1 only). */
export interface FactPayload { value: string; unit?: string; verb?: string; object: string; event?: string }
export interface EventPayload { when: string; event: string; entities?: string[] }
export interface PreferencePayload { statement: string; kind?: string }
export type StructuredRowPayload = FactPayload | EventPayload | PreferencePayload;

export interface NewStructuredRow {
  rowKind: RowKind;
  sourcePath: string;
  sourceChunkId: number;
  sourceHash: string;
  scope?: string;
  extractionVersion: string;
  /** Content date (frontmatter session_date/date, else modified_at). NULL = unknown, never `now`. */
  validFrom: string | null;
  payload: StructuredRowPayload;
}

export interface StoredStructuredRow {
  id: number;
  rowKind: RowKind;
  sourcePath: string;
  sourceChunkId: number;
  sourceHash: string;
  scope: string;
  extractionVersion: string;
  validFrom: string | null;
  validTo: string | null;
  payload: StructuredRowPayload;
  dedupeKey: string;
  /** Times a re-extraction of the same identity adjudicated `identical` (C2). */
  confirmCount: number;
}

export class ProvenanceError extends Error {}

/** NFKD → fold Latin diacritics → keep letters/numbers/marks from every script → lowercase → collapse.
 *
 * Letters and numbers are kept from EVERY script (`\p{L}`/`\p{N}`), never an
 * ASCII range. The previous `[^\x20-\x7E]` + `[^a-z0-9]` pair deleted every
 * non-Latin character, so two distinct memories written in Chinese, Japanese,
 * Cyrillic, Greek, Arabic, Hebrew or Devanagari both normalized to `''` and
 * shared one identity — and `decision-model` then called one `identical` to the
 * other, folding the candidate into the existing row's confirm_count instead of
 * storing it. Silent data loss.
 *
 * Combining marks are folded ONLY after a Latin base letter, which is what keeps
 * the existing accent folding (`Café` → `cafe`) without destroying the marks
 * that ARE letters in other scripts. A blanket `\p{M}` strip looks equivalent on
 * Latin but merges meaning-changing pairs in scripts this bug report names:
 * `が`/`か`, `ぱ`/`は`, `की`/`क`, `मिल`/`मील`, `น้ำ`/`นำ` (measured; pinned by test).
 * To go back to the blanket strip, delete only the lookbehind (making the two
 * mark clauses `\p{M}` in both places).
 *
 * `\p{L}` is `a-zA-Z` and `\p{N}` is `0-9` within ASCII, so ASCII identities are
 * unchanged. `\p{C}` (control, format, private-use, unassigned) is REMOVED rather
 * than treated as a separator, matching what the old `[^\x20-\x7E]` filter did to
 * those characters — so every ASCII input stays byte-identical, including one
 * carrying a control character. That preserves one pre-existing quirk: a control
 * character between two word characters glues them (`'a\u0000b'` → `ab`);
 * separating instead would move ASCII identities, so it is left out of scope.
 *
 * Values with no letters or numbers (punctuation, symbols, emoji) still normalize
 * to `''`, exactly as before. Dataset-free. */
export function normDedupeValue(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/(?<=\p{Script=Latin})\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\p{C}+/gu, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

/** The read side's word separator: the SAME class `normDedupeValue` uses above, so a query
 *  is cut into words exactly as the text it must match is. `\p{L}`/`\p{N}`/`\p{M}` cover
 *  every script; both are exactly `a-z`/`0-9`/nothing within ASCII, so an ASCII query is
 *  cut into byte-identical words.
 *
 *  Splitting on the ASCII range instead (`[^a-z0-9]`) deletes every non-ASCII letter, and a
 *  word that is *entirely* non-ASCII is deleted whole rather than shortened: `não` became
 *  `n`+`o`, `東京` became nothing, `東京都` became nothing. A read then lost the identity of
 *  the very facts it was written to find — measured on this repo's read paths in
 *  `tests/context/readSideUnicodeTokens.test.ts`: a `東京都` query scored every row 0, so
 *  `大阪に通っている` (newer, irrelevant) outranked `東京都に住んでいる`, and the query
 *  scoped to no row at all, returning the whole table.
 *
 *  `numeric` additionally keeps `.` and `%` inside a word, so a measurement stays one word
 *  ("3.5%", "42 Wh"). Both variants were the pre-existing ASCII classes plus `\p{L}\p{N}\p{M}`
 *  widened from `a-z0-9`, so no ASCII word changes.
 *
 *  Deliberately NOT NFKD-folded, unlike `normDedupeValue`: the read side matches its terms
 *  with `includes()` against the RAW stored text (`rowSearchText` + `indexOf`), so folding
 *  here would stop a term from matching the very row it names. Marks are kept as word
 *  characters for the same reason the write side keeps them for non-Latin scripts. */
const WORD_SEPARATOR = /[^\p{L}\p{N}\p{M}]+/u;
const WORD_SEPARATOR_NUMERIC = /[^\p{L}\p{N}\p{M}.%]+/u;

/** The one form the read side matches on: NFC, then lowercased. Applied to BOTH the query
 *  and the text it is matched against, so a query matches a stored fact however either was
 *  spelled. Stored payloads are never normalized (they are written as given), and NFC is
 *  *not* the same string as NFD — macOS-authored text, pasted filenames and Obsidian on Mac
 *  all produce NFD — so an NFC query term would otherwise miss an NFD fact (`café` vs
 *  `café`) that a raw substring test cannot bridge. ASCII is NFC-stable, so this is
 *  identity on every ASCII input. NOT NFKD and NOT accent-folded: the match is a raw
 *  `includes()`, so folding a term would stop it matching the very row it names, which is
 *  also why the write side's `normDedupeValue` folding cannot be reused here. */
export function matchForm(text: string): string {
  return (text ?? '').normalize('NFC').toLowerCase();
}

/** Lowercased NFC words of `text` in order, repeats included — callers de-duplicate. A query
 *  and the stored text it is matched against are both put in `matchForm`, so the cut cannot
 *  differ by side. */
export function splitWords(text: string, numeric = false): string[] {
  return matchForm(text).split(numeric ? WORD_SEPARATOR_NUMERIC : WORD_SEPARATOR);
}

/** dedupe_key per ADR §4: fact (value, object), event (when, event), pref (statement). */
export function dedupeKeyFor(row: NewStructuredRow): string {
  switch (row.rowKind) {
    case 'fact': {
      const p = row.payload as FactPayload;
      return `fact|${normDedupeValue(p.value)}|${normDedupeValue(p.object)}`;
    }
    case 'event': {
      const p = row.payload as EventPayload;
      return `event|${normDedupeValue(p.when)}|${normDedupeValue(p.event)}`;
    }
    case 'preference': {
      const p = row.payload as PreferencePayload;
      return `pref|${normDedupeValue(p.statement)}`;
    }
  }
}

function assertProvenance(row: NewStructuredRow): void {
  if (!row.sourcePath || !row.sourcePath.trim()) {
    throw new ProvenanceError(`structured row (${row.rowKind}) rejected: missing source_path`);
  }
  if (!Number.isInteger(row.sourceChunkId) || row.sourceChunkId <= 0) {
    throw new ProvenanceError(
      `structured row (${row.rowKind}) from ${row.sourcePath} rejected: missing source_chunk_id`,
    );
  }
}

function parsePayload(_rowKind: RowKind, raw: string): StructuredRowPayload {
  return JSON.parse(raw) as StructuredRowPayload;
}

export interface InsertStructuredRowsOptions {
  /**
   * Skip identity-keyed supersession. Used by the C2 cross-note `identical`
   * confirm write (factsWritePath): the confirming note's row must coexist
   * with the original's — superseding it would close the fact on the note
   * that still asserts it (and deletion of either note would then lose it).
   */
  skipSupersession?: boolean;
}

/**
 * Insert rows with identity-keyed supersession (ADR-0003 §4.1). A new row
 * supersedes a current row only when they share (row_kind, scope, dedupe_key)
 * AND both content dates are known AND the new source is not older. When
 * either date is NULL (unknown), supersession never fires: both rows stay
 * current and the composer orders them deterministically.
 *
 * Same-identity double-insert from the SAME source cannot occur: migration
 * v11's partial UNIQUE index (current rows only) closes the check-then-act
 * race across `await model.decide`, and a lost race is re-checked here and
 * skipped (the winning writer's row already covers the identity) instead of
 * double-inserting. Cross-note coexistence (different source_path) is
 * preserved by the index's source_path column.
 */
export function insertStructuredRows(
  db: Database.Database,
  rows: NewStructuredRow[],
  opts: InsertStructuredRowsOptions = {},
): void {
  const insert = db.prepare(`
    INSERT INTO structured_rows
      (row_kind, source_path, source_hash, source_chunk_id, scope, extraction_version,
       valid_from, valid_to, payload_json, dedupe_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `);
  // A content date is only as late as its file's write time. Rows stored before this bound existed are bounded the same
  // way wherever they are read, including here, so a stale future date cannot outrank a normal later update.
  const findCurrent = db.prepare(`
    SELECT r.id, r.valid_from, n.modified_at
    FROM structured_rows r LEFT JOIN notes n ON n.path = r.source_path
    WHERE r.row_kind = ? AND r.scope = ? AND r.dedupe_key = ? AND r.valid_to IS NULL
  `);
  const writeTime = db.prepare('SELECT modified_at FROM notes WHERE path = ?');
  const supersede = db.prepare('UPDATE structured_rows SET valid_to = ? WHERE id = ?');

  db.transaction(() => {
    for (const row of rows) {
      assertProvenance(row);
      const validFrom = boundContentDate(
        row.validFrom,
        (writeTime.get(row.sourcePath) as { modified_at: string } | undefined)?.modified_at,
      );
      const dedupeKey = dedupeKeyFor(row);
      const scope = row.scope ?? 'global';
      const now = new Date().toISOString();
      if (validFrom !== null && !opts.skipSupersession) {
        for (const existing of findCurrent.all(row.rowKind, scope, dedupeKey) as Array<{ id: number; valid_from: string | null; modified_at: string | null }>) {
          // Supersede only on identity collision with known dates on both
          // sides; the newer (or same-date re-extraction) source wins.
          const existingFrom = boundContentDate(existing.valid_from, existing.modified_at);
          if (existingFrom !== null && validFrom >= existingFrom) {
            supersede.run(validFrom, existing.id);
          }
        }
      }
      try {
        insert.run(
          row.rowKind,
          row.sourcePath,
          row.sourceHash,
          row.sourceChunkId,
          scope,
          row.extractionVersion,
          validFrom,
          JSON.stringify(row.payload),
          dedupeKey,
          now,
        );
      } catch (err) {
        const code = (err as { code?: string })?.code ?? '';
        const message = err instanceof Error ? err.message : String(err);
        if (code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(message)) {
          // Lost a same-identity insert race against a concurrent writer for
          // this source (migration v11 partial UNIQUE index). Re-check: a
          // current row already covers the identity from this source — skip
          // instead of double-inserting; anything else is a real error.
          const dupe = db
            .prepare(
              `SELECT id FROM structured_rows
               WHERE row_kind = ? AND scope = ? AND dedupe_key = ? AND source_path = ? AND valid_to IS NULL LIMIT 1`
            )
            .get(row.rowKind, scope, dedupeKey, row.sourcePath);
          if (dupe) continue;
        }
        throw err;
      }
    }
  })();
}

/** Edit path (ADR-0003 §4.2): re-index of a note deletes its rows; re-extraction repopulates. */
export function deleteStructuredRowsForSource(db: Database.Database, sourcePath: string): void {
  db.prepare('DELETE FROM structured_rows WHERE source_path = ?').run(sourcePath);
}

/**
 * Same edit path, scoped to one lane.
 *
 * The whole-source delete removes every row kind for a note. With more than
 * one lane armed, the second lane's cleanup deleted the first lane's fresh
 * rows and the third deleted both. The cache key is per lane
 * (source_hash + extraction_version), so stale-row cleanup is too.
 */
export function deleteStructuredRowsForSourceKind(
  db: Database.Database,
  sourcePath: string,
  rowKind: RowKind,
): void {
  db.prepare('DELETE FROM structured_rows WHERE source_path = ? AND row_kind = ?')
    .run(sourcePath, rowKind);
}

/**
 * Current-only read joined to the live notes table: a row whose source_path no
 * longer resolves to a live note is never returned (provenance guard), even if
 * a connection without the FK pragma leaked orphans into the table.
 */
export function readCurrentRowsForNotes(
  db: Database.Database,
  notePaths: string[],
  opts: { includeSuperseded?: boolean } = {},
): StoredStructuredRow[] {
  if (notePaths.length === 0) return [];
  const placeholders = notePaths.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT r.id, r.row_kind, r.source_path, r.source_hash, r.source_chunk_id,
            r.scope, r.extraction_version, r.valid_from, r.valid_to, r.payload_json, r.dedupe_key,
            r.confirm_count, n.modified_at
     FROM structured_rows r
     JOIN notes n ON n.path = r.source_path
     WHERE ${opts.includeSuperseded ? '1 = 1' : 'r.valid_to IS NULL'} AND r.source_path IN (${placeholders})
     ORDER BY r.id`
  ).all(...notePaths) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    rowKind: r.row_kind as RowKind,
    sourcePath: r.source_path as string,
    sourceChunkId: r.source_chunk_id as number,
    sourceHash: r.source_hash as string,
    scope: r.scope as string,
    extractionVersion: r.extraction_version as string,
    validFrom: boundContentDate((r.valid_from as string | null) ?? null, r.modified_at as string),
    validTo: (r.valid_to as string | null) ?? null,
    payload: parsePayload(r.row_kind as RowKind, r.payload_json as string),
    dedupeKey: r.dedupe_key as string,
    confirmCount: (r.confirm_count as number | undefined) ?? 1,
  }));
}