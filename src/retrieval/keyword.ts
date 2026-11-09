import type Database from '../db/sqlite';
import { databaseStamp } from '../db/readCache';
import { prepareOnce } from '../db/statements';
import { byPlace } from './semantic';
import { words } from '../memory/factTerms';

/** A chunk full-text search matched, with its BM25 score as `bm25()` gives it (lower is a better match). */
export interface KeywordHit {
  chunkId: number;
  notePath: string;
  headingPath: string;
  text: string;
  score: number;
}

const ROWS = 'SELECT c.id AS chunkId, c.note_path AS notePath, c.heading_path AS headingPath, c.text, f.score AS score';

/**
 * get_context's first keyword window is `topK * 10` (60 for the 6 it asks) and the next read, when that window is
 * turned away, is four times that (240). A wider page is a walk toward every match; keeping its text is not worth it.
 */
const CACHED_PAGE_LIMIT = 256;
/** Distinct pages kept per connection. The oldest goes when another is kept. */
const CACHED_PAGE_COUNT = 256;

interface CachedPage { stamp: string; hits: KeywordHit[] }
const cachedPages = new WeakMap<Database.Database, Map<string, CachedPage>>();

function copyHits(hits: KeywordHit[]): KeywordHit[] {
  return hits.map(hit => ({ chunkId: hit.chunkId, notePath: hit.notePath, headingPath: hit.headingPath, text: hit.text, score: hit.score }));
}

/**
 * The `limit` chunks that best match an FTS5 `match` expression, best first, and of equal scores by place (byPlace).
 * BM25 ties often (one sentence in several notes, one word once in chunks of one length), and FTS5 gives ties in
 * row-id order, which is the order indexing wrote the notes in: concurrent indexing does not fix it.
 *
 * Ranked and cut inside the full-text query, which reads no chunk row, one row past the page: joining `chunks` before
 * the cut would read the text of every matching chunk (thousands, for a common word) to keep a few. Only when that
 * extra row scores like the last one does the page end inside a tie; then every chunk with that score is read, so the
 * tie is cut by place too.
 *
 * The same page is kept until this connection or another writes. The stamp is taken before the ranking and the page is
 * kept only when that stamp is still current: a write during the ranking is stored under neither stamp, and nothing is
 * kept inside a transaction. Callers may change the hits they are given, so both the kept page and a hit are copies.
 */
export function keywordSearch(db: Database.Database, match: string, limit: number, stem = false): KeywordHit[] {
  if (limit < 1) return [];
  const key = `${keywordIndexTable(db, stem)}\0${limit}\0${match}`;
  const before = limit <= CACHED_PAGE_LIMIT ? databaseStamp(db) : null;
  if (before !== null) {
    const held = cachedPages.get(db)?.get(key);
    if (held && held.stamp === before) return copyHits(held.hits);
  }
  const rows = rankKeywordHits(db, match, limit, stem);
  if (before !== null && databaseStamp(db) === before) {
    let pages = cachedPages.get(db);
    if (!pages) cachedPages.set(db, pages = new Map());
    if (!pages.has(key) && pages.size >= CACHED_PAGE_COUNT) pages.delete(pages.keys().next().value as string);
    pages.set(key, { stamp: before, hits: copyHits(rows) });
  }
  return rows;
}


/** The one off switch for the three keyword defaults (OR query, stemmed index, search_text fallback): exactly `0` restores all three. */
export function keywordDefaultsOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.RENOR_KEYWORD_DEFAULTS ?? '').trim() === '0';
}

/** Question words no keyword expression is built from (the OR expression of H11b, the keyword variants). */
export const FTS_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'which', 'who', 'where', 'when',
  'why', 'how', 'do', 'does', 'did', 'to', 'for', 'of', 'in', 'on', 'at', 'with', 'and',
  'or', 'my', 'your', 'our', 'their', 'his', 'her', 'it', 'this', 'that', 'about',
  // Two-letter words that never name a topic. Not every two-letter word: CI, DB, AI, Go or IP often are the topic.
  'am', 'as', 'be', 'by', 'he', 'if', 'me', 'so', 'up', 'we',
]);

/**
 * H11b (default on; RENOR_KEYWORD_OR_ALL=0 restores the legacy path): the keyword lane issues one FTS expression, the
 * question's content words joined by OR (BM25 ranks rare words highest), instead of the variants. Pre-registered in
 * data/renor-goal-better-temporal-2/prereg/H11b-H18-H12.md.
 */
export function keywordOrAll(env: NodeJS.ProcessEnv = process.env): boolean {
  return !keywordDefaultsOff(env) && (env.RENOR_KEYWORD_OR_ALL ?? '').trim() !== '0';
}

/** The FTS expression of H11b: each content word quoted, joined by OR. */
export function keywordOrMatch(query: string): string {
  const terms = [...new Set(words(query).filter(word => !FTS_STOP_WORDS.has(word)))];
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

/** Searches a Porter-stemmed copy by default; RENOR_KEYWORD_STEM=0 or RENOR_KEYWORD_DEFAULTS=0 restores the legacy unstemmed index. */
function stemEnabled(): boolean {
  return !keywordDefaultsOff() && (process.env.RENOR_KEYWORD_STEM ?? '').trim() !== '0';
}

const stemReady = new WeakSet<Database.Database>();

/**
 * The FTS table the keyword lane reads. Off (`RENOR_KEYWORD_STEM=0`): `chunks_fts`, untouched. On (default): `chunks_fts_stem`, an external-content
 * FTS5 table over the same chunks with the `porter unicode61` tokenizer, created and filled once per workspace on first use
 * (existing workspaces need no migration) and kept in sync by triggers. If it cannot be built (read-only database), the
 * lane falls back to `chunks_fts`.
 */
export function keywordIndexTable(db: Database.Database, forceStem = false): string {
  if (!forceStem && !stemEnabled()) return 'chunks_fts';
  if (stemReady.has(db)) return 'chunks_fts_stem';
  try {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts_stem'`).get();
    if (!exists) {
      db.transaction(() => {
        db.prepare(`CREATE VIRTUAL TABLE chunks_fts_stem USING fts5(text, heading_path, note_path UNINDEXED, content='chunks', content_rowid='id', tokenize='porter unicode61')`).run();
        db.prepare(`INSERT INTO chunks_fts_stem(chunks_fts_stem) VALUES ('rebuild')`).run();
        db.prepare(`CREATE TRIGGER chunks_fts_stem_insert AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts_stem(rowid, text, heading_path, note_path) VALUES (new.id, new.text, new.heading_path, new.note_path);
        END`).run();
        db.prepare(`CREATE TRIGGER chunks_fts_stem_delete AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts_stem(chunks_fts_stem, rowid, text, heading_path, note_path) VALUES ('delete', old.id, old.text, old.heading_path, old.note_path);
        END`).run();
        db.prepare(`CREATE TRIGGER chunks_fts_stem_update AFTER UPDATE ON chunks BEGIN
          INSERT INTO chunks_fts_stem(chunks_fts_stem, rowid, text, heading_path, note_path) VALUES ('delete', old.id, old.text, old.heading_path, old.note_path);
          INSERT INTO chunks_fts_stem(rowid, text, heading_path, note_path) VALUES (new.id, new.text, new.heading_path, new.note_path);
        END`).run();
      })();
    }
    stemReady.add(db);
    return 'chunks_fts_stem';
  } catch {
    // Another connection won the first build: the table exists now, so this handle reads it too instead of the legacy table.
    try {
      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts_stem'`).get()) {
        stemReady.add(db);
        return 'chunks_fts_stem';
      }
    } catch { /* unreadable: fall back below */ }
    return 'chunks_fts';
  }
}

function rankKeywordHits(db: Database.Database, match: string, limit: number, stem = false): KeywordHit[] {
  const fts = keywordIndexTable(db, stem);
  // The page is the `limit` best rows, read with one more ranked row that is not returned: its score (`next`) says whether
  // the page ends inside a tie. The ranking is read once, and the extra row costs no chunk text and no row of its own.
  const paged = prepareOnce(
    db,
    `WITH ranked AS MATERIALIZED (
       SELECT rowid AS rid, bm25(${fts}) AS score
       FROM ${fts}
       WHERE ${fts} MATCH ?
       ORDER BY score
       LIMIT ?
     )
     SELECT c.id AS chunkId, c.note_path AS notePath, c.heading_path AS headingPath, c.text, r.score AS score,
       (SELECT score FROM ranked ORDER BY score LIMIT 1 OFFSET ?) AS next
     FROM ranked r
     JOIN chunks c ON c.id = r.rid
     ORDER BY r.score
     LIMIT ?`,
  ).all(match, limit + 1, limit, limit) as Array<KeywordHit & { next: number | null }>;
  const page: KeywordHit[] = paged.map(({ chunkId, notePath, headingPath, text, score }) => ({ chunkId, notePath, headingPath, text, score }));
  const edge = page.length === limit && paged[0].next === page[limit - 1].score ? page[limit - 1].score : null;
  const rows = edge === null ? page : [
    ...page.filter(hit => hit.score < edge),
    ...prepareOnce(
      db,
      `${ROWS}
       FROM (
         SELECT rowid, bm25(${fts}) AS score
         FROM ${fts}
         WHERE ${fts} MATCH ?
       ) f
       JOIN chunks c ON c.id = f.rowid
       WHERE f.score = ?`,
    ).all(match, edge) as KeywordHit[],
  ];
  return rows.sort((a, b) => a.score - b.score || byPlace(a, b)).slice(0, limit);
}
