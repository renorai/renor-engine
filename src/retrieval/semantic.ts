import type { ExplainTrace } from './explain.js';
import Database from '../db/sqlite';
import { inReadSnapshot } from '../db/readCache';
import { prepareOnce } from '../db/statements';
import { VectorIndex } from '../embeddings/vectorIndex';

export interface SemanticHit {
  notePath: string; chunkId: number; headingPath: string;
  text: string; score: number; startLine: number; endLine: number;
}

/**
 * Out-param for get_context's relevance signal: the query embedding, so it is not paid for twice, and
 * (set by engineSearchMemory) the best raw cosine among the semantic hits that were actually returned,
 * with that hit as a memory lists it (absent when it shows as nothing), so the response can be made to hold it, and
 * every such hit with the raw cosine it matched at, so a budget can tell the matches above the relevance bar.
 */
export interface RetrievalProbe {
  queryVector?: number[];
  topSimilarity?: number | null;
  topHit?: { notePath: string; headingPath?: string; text: string };
  /** Every returned semantic hit that shows as something, as a memory lists it, with its raw cosine (set by engineSearchMemory). */
  similarities?: Array<{ notePath: string; headingPath?: string; text: string; similarity: number }>;
  /** Set by a caller that asked for `explain`: the read records its stage counts and dropped ids here (explain.ts). */
  explain?: ExplainTrace;
}

interface EmbeddingProviderLike {
  embed(texts: string[]): Promise<number[][]>;
  embedQuery?(text: string): Promise<number[]>;
}

/** Where a chunk is: its note, and its id, which within that note rises in document order. */
export interface ChunkPlace { notePath: string; chunkId: number }

/**
 * Note path, then chunk id: the order of chunks whose scores are equal. A note's chunks are written top to bottom (by
 * the indexer, and by the importer, which copies them in that order), so within one note the id is the chunk's place,
 * the same in every index of the same notes. Across notes ids are not: they follow the order indexing wrote the notes
 * in, which concurrent indexing does not fix.
 */
export function byPlace(a: ChunkPlace, b: ChunkPlace): number {
  if (a.notePath !== b.notePath) return a.notePath < b.notePath ? -1 : 1;
  return a.chunkId - b.chunkId;
}

/** Highest score first; equal scores by place (`byPlace`). */
export function byScoreThenPlace(a: ChunkPlace & { score: number }, b: ChunkPlace & { score: number }): number {
  return b.score - a.score || byPlace(a, b);
}

/**
 * Which chunks a read shows, for a read that shows only some (a scoped read). It is asked before every cut of the read's
 * window, never after, so a chunk the read does not show never takes the place of one it does.
 */
export type ChunkFilter = (hit: { notePath: string; chunkId: number; headingPath: string; text: string }) => boolean;

/** A read that shows only some chunks: which ones (`shows`), and the ids of all of them (the same answer, at once). */
export interface ChunkScope {
  shows: ChunkFilter;
  chunkIds: () => number[];
}

export async function semanticSearch(
  db: Database.Database,
  vectorIndex: VectorIndex,
  provider: EmbeddingProviderLike,
  query: string,
  topK: number,
  probe?: RetrievalProbe,
  /** Only the chunks it shows are candidates: the nearest `topK` of them, however many others are nearer. */
  scope?: ChunkScope,
): Promise<SemanticHit[]> {
  // A fresh/empty memory has nothing to compare against. Avoid paying the
  // provider/network cost for a query embedding that cannot produce a hit.
  // Ask vec0's rowid shadow table, not the virtual table: `SELECT ... FROM chunk_embeddings` without a
  // MATCH walks every vector (milliseconds at 10,000 notes, growing with the index) to learn "not empty".
  // `chunk_embeddings_rowids` holds one row per stored vector.
  const hasVectors = prepareOnce(db, 'SELECT 1 FROM chunk_embeddings_rowids LIMIT 1').get();
  if (!hasVectors || topK <= 0) return [];

  const queryEmbedding = provider.embedQuery
    ? await provider.embedQuery(query)
    : (await provider.embed([query]))[0];
  if (probe) probe.queryVector = queryEmbedding;
  // The chunks of the `k` nearest vectors (of those `among` names, when it is given), best first, and how many vectors
  // were read: more than `k` when the farthest of them is tied, and the cut is made by place, not by where vectors are
  // stored; fewer only when there are no more.
  const nearest = (k: number, among?: number[]): { vectors: number; chunks: SemanticHit[] } => {
    const hits = vectorIndex.search(queryEmbedding, k, among);
    if (hits.length === 0) return { vectors: 0, chunks: [] };

    const scoreMap = new Map(hits.map(h => [h.chunkId, h.score]));

    const rows = prepareOnce(
      db,
      `SELECT id, note_path, heading_path, text, start_line, end_line FROM chunks WHERE id IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify(hits.map(h => h.chunkId))) as Array<{ id: number; note_path: string; heading_path: string; text: string; start_line: number; end_line: number }>;

    return {
      vectors: hits.length,
      chunks: rows
        .map(r => ({ notePath: r.note_path, chunkId: r.id, headingPath: r.heading_path, text: r.text, score: scoreMap.get(r.id) ?? 0, startLine: r.start_line, endLine: r.end_line }))
        .sort(byScoreThenPlace),
    };
  };
  // The query is embedded: nothing below waits for anything, so the nearest chunks are read in one transaction (inReadSnapshot).
  return inReadSnapshot(db, () => {
    if (!scope) return nearest(topK).chunks.slice(0, topK);
    // Judged before the cut: when fewer than `topK` of the nearest chunks are shown (other chunks are nearer), the nearest
    // of the shown chunks themselves are read instead, so however many others are nearer, none takes their places.
    const first = nearest(topK);
    const shown = first.chunks.filter(scope.shows);
    if (shown.length >= topK || first.vectors < topK) return shown.slice(0, topK);
    return nearest(topK, scope.chunkIds()).chunks.slice(0, topK);
  });
}
