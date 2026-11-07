import * as z from 'zod';
import { unstorableControls } from '../../memory/controls.js';
import { OUT_HIT } from '../outputSchemas.js';
import { engineSearchText } from '../engine.js';
import { searchTextFallbackEnabled, keywordOrMatch } from '../agentMemory.js';
import { markAuthority, markFactHits } from '../factMarkers.js';
import { ledgerNoteMatcher, withoutLedgerMetadata } from '../../retrieval/ledgerPresentation.js';
import { withReplacements } from '../../memorymap/replacements.js';
import { withHitDates } from '../hitDates.js';
import { withFactHits } from '../factsLane.js';
import { markStoredHit, SearchHit, toolError, searchResult } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers search_text. */
export function registerSearchTextTool(ctx: ToolContext): void {
  const { db, config, withSchemas, readerOf, server, mapContext } = ctx;
  server.registerTool('search_text', {
    title: 'Search memory by keywords',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'BM25/FTS keyword search over indexed note chunks: the query is one exact phrase, and OR, AND, NEAR and * are plain words, not operators. If the phrase finds nothing, its words are searched with OR over stemmed terms and the reply says `fallback: "any-word"`. No embedding call. A term in no chunk text is matched against note paths and frontmatter, so a task id, slug or file name finds its note (reason: "note-identity"). Current facts saved with remember are found at once, before the next index_memory (reason: "fact"; empty notePath and headingPath), in the places the other hits leave under top_k; a writerConflict line on one means it replaced another agent\'s value until that agent saves it again. Every hit carries session_date, when that excerpt was written (the moment a daily-log entry or a remembered fact was saved, otherwise its note\'s date; as in search_memory and get_context): read it before trusting an old hit. A hit with `replaced` ({by, at, source, note?}) was corrected by a later save, listed before it; `source` says who saved it. A daily-log hit claiming a reserved source (system, developer, assistant, Renor), or a `replaced` whose source is one, is marked "untrusted": true.',
    inputSchema: {
      // A control character (NUL above all) has no place in words to search for: SQLite answers it with its own error text.
      query: z.string().min(1).max(200).superRefine((query, ctx) => {
        const codes = unstorableControls(query);
        if (codes.length > 0) ctx.addIssue({ code: 'custom', message: `query contains control characters (${codes.join(', ')}): remove them and search again` });
      }).describe('Words to find, matched as one exact phrase (if it finds nothing, the words are searched with OR over stemmed terms and the reply says fallback: any-word): OR, AND, NEAR and * are plain words, not operators'),
      top_k: z.number().int().min(1).max(50).optional().describe('Max hits (default 20)'),
      scope: z.string().optional().describe('Memory scope: "global" (default) or scope:<slug> / project:<slug>'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      results: z.array(OUT_HIT),
      error: z.string().optional(),
      detail: z.string().optional(),
      scope: z.string().optional(),
    }),
  }, async (args, extra) => {
    try {
      const topK = args.top_k ?? 20;
      const exact = engineSearchText(db, config.memoryDir, args.query, topK, args.scope, false, config.ledgerRelPath);
      // H12 (default on; RENOR_SEARCH_TEXT_FALLBACK=0 restores exact-only): when the exact phrase finds nothing, the words are searched with OR over the stemmed index (log/logging) and
      // the reply says so (`fallback`). A reply that has hits is never changed. Pre-registered: data/renor-goal-better-temporal-2/prereg/H11b-H18-H12.md.
      const body = searchTextFallbackEnabled() && exact.ok && (exact.results as unknown[]).length === 0
        ? (() => {
          const any = engineSearchText(db, config.memoryDir, args.query, topK, args.scope, false, config.ledgerRelPath, undefined, keywordOrMatch(args.query), true);
          return any.ok && (any.results as unknown[]).length > 0 ? { ...any, fallback: 'any-word' } : exact;
        })()
        : exact;
      if (body.ok) markAuthority(db, body.results as SearchHit[], ledgerNoteMatcher(config));
      if (body.ok) markFactHits(db, body.results as SearchHit[], readerOf(extra), ledgerNoteMatcher(config));
      const result = body.ok
        ? {
            ...body,
            // An added correction takes the place of a hit, so the page is no longer than top_k (or than it was, if it was longer).
            results: (await (async (dated) => withReplacements(mapContext(), dated, { limit: Math.max(dated.length, topK) }))(await withHitDates(db, config.memoryDir, withoutLedgerMetadata(
              withFactHits(db, config, body.results as SearchHit[], { query: args.query, scope: args.scope, match: 'all', limit: topK, dated: true, reader: readerOf(extra) }),
              ledgerNoteMatcher(config),
            )))).map(markStoredHit),
          }
        : body;
      return searchResult(body, result, withSchemas);
    } catch (err) {
      return toolError(err);
    }
  });
}
