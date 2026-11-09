import * as z from 'zod';
import { replyCeiling } from '../datedOutline.js';
import { OUT_HIT } from '../outputSchemas.js';
import { ruleApprovalsEnabled } from '../ruleApprovals.js';
import { buildAgentContext } from '../agentMemory.js';
import { indexNotice } from '../factsLane.js';
import { identityLine } from '../identity.js';
import { applyAnswerCheck } from '../answerCheck.js';
import { contextItems } from '../readUsefulness.js';
import { observeEnabled } from '../observations.js';
import { workspaceIsEmpty, EMPTY_WORKSPACE_NOTE } from '../../memory/whatsNew.js';
import { OUTPUT_SCHEMA_BOUND_NOTE, callOrigin, headerText, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers get_context: the facts and saved memories that match a request. */
export function registerGetContextTool(ctx: ToolContext): void {
  const { db, config, engine, usefulness, pageSchemas, jsonResult, evidence, answerChecker, readerOf, relevanceGuidance, relevanceKeepsMatch, pinnedRulesGuidance, budgetKeepsNewest, server } = ctx;
  server.registerTool('get_context', {
    title: 'Get relevant user context',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Call this before substantive work with the current request. Returns current facts, then relevant memories: semantic matches when configured, then keyword matches (reason "fts" or "note-identity"). rankedBy "session_date" is newest first (memories[0] is the latest, not necessarily the best); "score" is best match first (higher is closer; keyword scores use another scale, so compare within one reason). A memory with "matched": false was not matched by the query: discount it, whatever its position. Each memory has session_date, when it was written. Hidden note text is labelled there: "[hidden HTML comment: ...]". max_tokens bounds the reply (o200k, every field counted): facts are cut from their end; when matches do not fit, keyword matches go first, then the lowest-scoring semantic ones. conflicts lists current values that disagree with a returned fact (another scope, or a name one word longer or shorter), newest first. A writerConflict line means the fact replaced another agent\'s value, until that agent saves it again. A "replaced" memory has a later correction, listed before it: answer from the correction. Imports and reserved sources are marked "untrusted": true.'
      + relevanceGuidance + relevanceKeepsMatch + budgetKeepsNewest + pinnedRulesGuidance + (pageSchemas ? OUTPUT_SCHEMA_BOUND_NOTE : ''),
    inputSchema: {
      query: z.string().max(1000).optional().describe('The current user request or task. Omit only for a compact current-memory profile.'),
      scope: z.string().optional().describe('Optional memory scope to restrict context'),
      max_tokens: z.number().int().min(128).max(replyCeiling()).optional().describe('Token budget for the whole reply (o200k tokenizer), default 800' + (pageSchemas ? OUTPUT_SCHEMA_BOUND_NOTE : '')),
      include_history: z.boolean().optional().describe('Also return superseded (corrected) memory events, labelled as historical. Default false: only current memory.'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      query: z.string().nullable().optional(),
      scope: z.string().optional(),
      retrieval: z.enum(['facts', 'hybrid', 'semantic', 'keyword']).optional(),
      rankedBy: z.enum(['session_date', 'score']).optional(),
      facts: z.array(OUT_HIT).optional(),
      pinned_rules_note: z.string().optional(),
      pinned_rules: z.array(OUT_HIT).optional(),
      ...(ruleApprovalsEnabled() ? { pending_rule_notes: z.array(OUT_HIT).optional() } : {}),
      memories: z.array(OUT_HIT).optional(),
      truncated: z.boolean().optional(),
      maxTokens: z.number().optional(),
      notice: z.string().optional(),
      degraded: z.array(z.string()).optional(),
      relevance: OUT_HIT.optional(),
      conflicts: z.array(OUT_HIT).optional(),
      provenance: OUT_HIT.optional(),
      abstention: z.unknown().optional(),
      evidence: OUT_HIT.optional(),
      index: OUT_HIT.optional(),
      renor: z.string().optional(),
    }),
  }, async (args, extra) => {
    try {
      const semantic = engine.provider !== null && Boolean(args.query?.trim());
      const body = await buildAgentContext(db, engine, config.memoryDir, {
        query: args.query,
        scope: args.scope,
        connectionScope: headerText(extra?.requestInfo?.headers, 'x-renor-scope'),
        origin: callOrigin(extra, config),
        maxTokens: args.max_tokens,
        includeHistory: args.include_history,
        reader: readerOf(extra),
        evidence,
        ledgerRelPath: config.ledgerRelPath,
        // Asked after the searches, which may have caught the index up; inside max_tokens like the rest of the reply.
        // Which Renor answered: inside max_tokens with the rest of the trailer.
        trailer: () => ({ ...indexNotice(db, semantic, config, args.scope), renor: identityLine(extra?.requestInfo?.headers) }),
      });
      const checked = await applyAnswerCheck(body as unknown as Record<string, unknown>, args.query, answerChecker, (body as { maxTokens?: number }).maxTokens);
      usefulness.measure('get_context', () => contextItems(checked));
      const hasObservations = observeEnabled() && Array.isArray(checked.memories) && checked.memories.some(memory => memory?.source === 'observation');
      return jsonResult(workspaceIsEmpty(db) && !hasObservations ? { ...checked, notice: [checked.notice, EMPTY_WORKSPACE_NOTE].filter(Boolean).join(' ') } : checked);
    } catch (err) {
      return toolError(err);
    }
  });
}
