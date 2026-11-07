import { saveMomentMode } from '../saveMoment.js';
import { pinnedRulesEnabled } from '../pinnedRules.js';
import * as z from 'zod';
import { OUT_HIT } from '../outputSchemas.js';
import { ruleApprovalsEnabled } from '../ruleApprovals.js';
import { sessionIndexEnabled } from '../sessionIndex.js';
import { captureServerOn } from '../../extraction/captureModel.js';
import { engineStatus } from '../engine.js';
import { identityLine } from '../identity.js';
import { envFlagOn, captureFlagsOn, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers memory_status. */
export function registerMemoryStatusTool(ctx: ToolContext): void {
  const { db, config, engine, digests, toolProfile, jsonResult, server } = ctx;
  // The capture_features field is in the advertised schema only where a server capture feature is on when the server is built,
  // so the tool list of a workspace without them is what it always was (the same rule as pending_rule_notes above).
  const captureSchemaOn = saveMomentMode() !== 'off' || envFlagOn('RENOR_STATUS_LEDGER') || pinnedRulesEnabled();
  server.registerTool('memory_status', {
    title: 'Index statistics',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Counts of what this workspace holds: notes (files; a daily log is one note per day), chunks (index size), entities, facts (superseded values included), and whether semantic search can answer now (semantic): while the embeddings are being built (after a provider is configured or changed, or notes are imported) semantic is false and embeddingRebuild counts the chunks left, and keyword search works meanwhile. The engine\'s own ledger is not counted as a note, entity or fact. With semantic search configured, chunksWithoutVectors counts the chunks search by meaning cannot find yet because they have no vector (a save whose embedding failed: the next save or search embeds them; imported notes not embedded yet). No embeddings API call.',
    inputSchema: {},
    outputSchema: z.looseObject({
      notes: z.number(),
      chunks: z.number(),
      entities: z.number(),
      facts: z.number(),
      relations: z.number(),
      embeddingDims: z.number().nullable(),
      semantic: z.boolean(),
      ...(captureSchemaOn ? { capture_features: z.object({
        save_moment: z.enum(['off', 'instructions', 'tool', 'both']),
        status_ledger: z.boolean(),
        pinned_rules: z.boolean(),
        rule_approvals: z.boolean(),
        session_index: z.boolean(),
        capture_server: z.boolean(),
      }).optional() } : {}),
      embeddingRebuild: z.object({ chunksLeft: z.number(), chunks: z.number() }).optional(),
      chunksWithoutVectors: z.number().optional(),
      storage: z.looseObject({
        vectors: z.number(),
        ledgerBytes: z.number(),
        vectorMirror: z.looseObject({
          copy: z.enum(['f32', 'none']), rows: z.number(), bytes: z.number(), capBytes: z.number(), overCapSearches: z.number(),
          simd: z.boolean(),
        }).optional(),
      }).optional(),
      degraded: z.object({ keyword: z.string().optional(), semantic: z.string().optional() }).optional(),
      renor: z.string(),
      // In the schema only for a connection on the coding profile, so the full set's tools/list is byte-identical to before.
      ...(toolProfile === 'coding' ? { tool_profile: z.string().optional() } : {}),
      digests: OUT_HIT.optional(),
    }),
  }, async (_args, extra) => {
    try {
      const captureFeatures = {
        save_moment: saveMomentMode(),
        status_ledger: envFlagOn('RENOR_STATUS_LEDGER'),
        pinned_rules: pinnedRulesEnabled(),
        rule_approvals: ruleApprovalsEnabled(),
        session_index: sessionIndexEnabled(),
        capture_server: captureServerOn(),
      };
      const captureOn = captureFlagsOn();
      const body = {
        ...engineStatus(db, engine, config),
        // Present only where a server capture feature is switched on, so a workspace without them reports what it always did (the same rule as digests below).
        ...(captureOn ? { capture_features: captureFeatures } : {}),
        renor: identityLine(extra?.requestInfo?.headers),
        // Named only on a connection that chose the coding profile (?tools=coding): the full set reports what it always did.
        ...(toolProfile === 'coding' ? { tool_profile: 'coding' } : {}),
      };
      // Present only where write-time digests are switched on, so a workspace without them reports what it always did.
      return jsonResult(digests ? { ...body, digests: digests.worker.status() } : body);
    } catch (err) {
      return toolError(err);
    }
  });
}
