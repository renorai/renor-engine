import { readerLayoutEnabled, readerLayoutEnabledFor, readerLayoutPage } from '../../retrieval/readerLayout.js';
import { readerDurationNamed } from '../../retrieval/questionSpan.js';
import { readerEventsNamed, readerEventsEnabled, noteTurnsLoader, vectorsMeanSomething, turnScorer } from '../../retrieval/readerEvents.js';
import { SEARCH_RELEVANCE_GUIDANCE } from '../contextRelevance.js';
import * as z from 'zod';
import { defaultSearchTopK } from '../../retrieval/orchestrator.js';
import { searchHitFloor, applyHitFloor, searchHitFloorKeep, markWeakMatch } from '../hitFloor.js';
import type { RetrievalProbe } from '../../retrieval/semantic.js';
import { engineSearchMemory, engineSearchText } from '../engine.js';
import { applyAnswerCheck } from '../answerCheck.js';
import { observeEnabled } from '../observations.js';
import { searchMemoryKeywordFallbackEnabled } from '../contextProfile.js';
import { markAuthority, markFactHits } from '../factMarkers.js';
import { ledgerNoteMatcher, withoutLedgerMetadata } from '../../retrieval/ledgerPresentation.js';
import { searchRelevance, headingForReply, keywordOrMatch, searchTextFallbackEnabled } from '../agentMemory.js';
import { withFactHits, indexNotice } from '../factsLane.js';
import { markRetrieved } from '../../callPhases.js';
import { withReplacements } from '../../memorymap/replacements.js';
import { labelMemoryText } from '../hiddenSpans.js';
import { searchItems } from '../readUsefulness.js';
import { EVENTS_HITS, DIGEST_HITS, SPAN_HITS, EVIDENCE_WAIT_STATES, EVIDENCE_DAILY_CAP_STATE, markStoredHit, SearchHit, shortScore, toolError, searchResult, callOrigin } from './shared.js';
import { layeredScopeEnabled, layeredView, layerItems } from '../layeredScope.js';
import type { ToolContext } from './setup.js';
import { newExplainTrace, explainReply, explainAdvertised, noteDrop, noteStage, EXPLAIN_ARG_DESCRIPTION } from '../../retrieval/explain.js';

/** Registers search_memory. */
export function registerSearchMemoryTool(ctx: ToolContext): void {
  const { db, config, engine, digests, usefulness, withSchemas, evidence, answerChecker, readerOf, relevanceGuidance, server, mapContext } = ctx;
  server.registerTool('search_memory', {
    title: 'Search memory by meaning (where enabled)',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Searches notes by meaning when memory_status reports semantic: true; else it returns no hits and says why (semantic-unavailable or semantic-rebuilding), so use search_text or get_context. rankedBy "session_date" (the default) is newest first, so hits[0] is the latest, not necessarily the best; "score" is best match first. Judge hits by score (higher is closer), not position. A conversation\'s hits on one date are one hit, opening with its date (its header alone is no hit); a time phrase in it is resolved below, counted from that session. A hit without session_date comes last; a fact\'s hit has no notePath. There is no `evidence` object when this deployment has no evidence model configured and the pass is not switched off: no second pass runs, and the hits are the whole result. When there is one, its items come first, outside rankedBy, with reason "evidence", and its state is "ok", "off", "not-applied" or "failed". Facts saved with remember are added outside rankedBy, within top_k; a writerConflict line on one means it replaced another agent\'s value. index.stale: the semantic index lags saved facts. A "replaced" hit\'s correction is listed before it (by: its id, source: who saved it).' + (evidence?.options.background ? EVIDENCE_WAIT_STATES : '') + (evidence?.options.dailyCap !== undefined ? EVIDENCE_DAILY_CAP_STATE : '') + (digests ? DIGEST_HITS : '') + (readerLayoutEnabled() && readerDurationNamed() ? SPAN_HITS : '') + (readerEventsNamed() ? EVENTS_HITS : '') + (relevanceGuidance ? SEARCH_RELEVANCE_GUIDANCE : ''),
    inputSchema: {
      query: z.string().min(1).max(500).describe('Natural language query'),
      top_k: z.number().int().min(1).max(50).optional().describe('Max matches (default 50), not counting the short statements the session expansion adds to them'),
      scope: z.string().optional().describe('Memory scope: "global" (default) or scope:<slug> / project:<slug>'),
      include_history: z.boolean().optional().describe('Also return superseded (corrected) memory events, labelled as historical. Default false: only current memory.'),
      ...(explainAdvertised(ctx.profile, ctx.toolProfile) ? { explain: z.boolean().optional().describe(EXPLAIN_ARG_DESCRIPTION) } : {}),
    },
  }, async (args, extra) => {
    try {
      const topK = args.top_k ?? defaultSearchTopK();
      const floor = searchHitFloor(engine.modelKey);
      const probe: RetrievalProbe = {};
      const explain = newExplainTrace((args as { explain?: boolean }).explain);
      if (explain) probe.explain = explain;
      const laidOut = readerLayoutEnabledFor(args.query);
      const semantic = await engineSearchMemory(db, engine, config.memoryDir, args.query, topK, args.scope, evidence, args.include_history === true, config.ledgerRelPath, probe, digests, undefined, floor > 0, laidOut);
      const observations = !semantic.ok && observeEnabled()
        ? semantic.hits.filter(hit => hit && typeof hit === 'object' && 'source' in hit && hit.source === 'observation') : [];
      if (observations.length > 0) {
        return searchResult({ ok: true }, {
          ok: true, hits: (observations as SearchHit[]).map(markStoredHit), fallback: 'keyword',
          notice: `${semantic.notice ?? 'Semantic search is unavailable.'} These are keyword observations.`,
          ...(args.scope ? { scope: args.scope } : {}),
        }, withSchemas);
      }
      // With semantic search unavailable or rebuilding, answer with keyword hits and say so, rather than an empty refusal.
      const keyword = !semantic.ok && (semantic.error === 'semantic-unavailable' || semantic.error === 'semantic-rebuilding') && searchMemoryKeywordFallbackEnabled()
        ? engineSearchText(db, config.memoryDir, args.query.slice(0, 200), topK, args.scope, false, config.ledgerRelPath) : undefined;
      // A sentence-style query is almost never one exact phrase in a note: as search_text does, search the words with OR over the stemmed index when the phrase finds nothing.
      const anyWord = keyword?.ok && (keyword.results as unknown[]).length === 0 && searchTextFallbackEnabled()
        ? engineSearchText(db, config.memoryDir, args.query.slice(0, 200), topK, args.scope, false, config.ledgerRelPath, undefined, keywordOrMatch(args.query.slice(0, 200)), true) : undefined;
      const keywordHits = anyWord?.ok && (anyWord.results as unknown[]).length > 0 ? anyWord : keyword;
      if (keywordHits?.ok && (keywordHits.results as unknown[]).length > 0) {
        return searchResult(keywordHits, { ok: true, hits: keywordHits.results, fallback: 'keyword', notice: `${semantic.notice ?? 'Semantic search is unavailable.'} These are keyword matches (search_text).`, scope: args.scope }, withSchemas);
      }
      const body = semantic;
      let result: Record<string, unknown> = body;
      if (body.ok) {
        // Who saved each fact among the hits, marked before anything reads them (the verdict, the page, the floor).
        markAuthority(db, body.hits as SearchHit[], ledgerNoteMatcher(config));
        markFactHits(db, body.hits as SearchHit[], readerOf(extra), ledgerNoteMatcher(config));
        // Judged over the index's own hits, before the facts lane adds any, with top_k: the fact the verdict is judged
        // on is then listed by that lane when the page has room for it, so a relevant verdict always names a match the
        // response holds, and names it in relevance.fact when top_k leaves no room (agentMemory.ts).
        const verdict = searchRelevance(db, engine, config.memoryDir, {
          query: args.query, scope: args.scope, includeHistory: args.include_history === true, ledgerRelPath: config.ledgerRelPath,
        }, probe, body.hits as Array<{ notePath: string; headingPath?: string; text: string }>, topK);
        const hits = withFactHits(db, config, body.hits as SearchHit[], { query: args.query, scope: args.scope, match: 'any', limit: topK, dated: true, reader: readerOf(extra) }, verdict.listFact ? [verdict.listFact] : []);
        markRetrieved(); // the matches and the facts are in hand: what follows builds the reply
        // Filter the completed page without backfilling. If the operator raises the floor above the relevance
        // bar and removes the closest chunk, withhold its verdict: the unchanged tool guidance promises the match.
        const floored = floor === 0 ? null : applyHitFloor(hits, floor, searchHitFloorKeep());
        // RENOR_LAYERED_SCOPE (off by default), with no scope passed: another project's hits are left out, or labelled when the
        // query names that project or no other hit is left (layeredScope.ts).
        if (explain) {
          if (floored) {
            const kept = new Set<unknown>(floored.hits);
            for (const hit of hits) if (!kept.has(hit)) noteDrop(explain, (hit as { chunkId?: number }).chunkId ?? hit.notePath, 'floor');
            explain.floor = floor;
          }
          noteStage(explain, 'reply', floored ? floored.hits.length : hits.length);
        }
        const unlayered = floored ? floored.hits : hits;
        const page = args.scope === undefined && layeredScopeEnabled()
          ? layerItems(layeredView(db, callOrigin(extra, config), args.query), [], unlayered, f => f, hit => hit as { notePath: string; text: string; headingPath?: string }).memories
          : unlayered;
        let shownVerdict = verdict;
        // At the model's calibrated floor a relevant closest match already clears the floor, so the normal path
        // needs no second fact-lane assessment. Only a floor above its reported cosine could have removed it.
        if (floored && floored.withheld > 0 && verdict.relevance?.relevant
          && (verdict.relevance.similarity === null || floor > verdict.relevance.similarity)) {
          const filteredVerdict = searchRelevance(db, engine, config.memoryDir, {
            query: args.query, scope: args.scope, includeHistory: args.include_history === true, ledgerRelPath: config.ledgerRelPath,
          }, probe, page as Array<{ notePath: string; headingPath?: string; text: string }>, topK);
          // Only a removed chunk loses its verdict. A fact already listed or named must stay as it was: freed slots
          // are not backfilled, so re-judging with that extra room must not drop relevance.fact for an unlisted fact.
          if (!filteredVerdict.relevance) shownVerdict = {};
        }
        // The event of a fact is read from the ledger's heading, which is taken off below.
        const layout = readerLayoutPage(body.rankedBy, (await withReplacements(mapContext(), withoutLedgerMetadata(page, ledgerNoteMatcher(config)), { limit: Math.max(page.length, topK) })).map(labelMemoryText), ledgerNoteMatcher(config), { query: args.query, turnsOf: readerEventsEnabled() ? noteTurnsLoader(db) : undefined, scoreTurns: readerEventsEnabled() && vectorsMeanSomething(engine.provider?.identity?.kind) && probe.queryVector && engine.vectorIndex ? turnScorer(engine.vectorIndex, probe.queryVector) : undefined }, laidOut);
        result = {
          ...body,
          rankedBy: layout.rankedBy,
          hits: layout.hits.map(markStoredHit).map(shortScore).map(headingForReply).map(hit => floored ? markWeakMatch(hit, floor) : hit),
          ...indexNotice(db, true, config, args.scope),
          ...(shownVerdict.relevance ? { relevance: shownVerdict.relevance } : {}),
          ...(floored ? { floor: { similarity: floor, withheld: floored.withheld } } : {}),
        };
        result = await applyAnswerCheck(result, args.query, answerChecker);
        if (explain) result = { ...result, explain: explainReply(explain) };
        // What the read served is the page the caller is shown, floor included: a hit the floor left out was not served, and
        // a page it left empty served nothing, whatever the verdict judged over every hit.
        usefulness.measure('search_memory', () => {
          const served = searchItems(db, ledgerNoteMatcher(config), page, result.relevance);
          return floored && served.items.length === 0 ? { ...served, relevant: false } : served;
        });
      }
      return searchResult(body, result, withSchemas);
    } catch (err) {
      return toolError(err);
    }
  });
}
