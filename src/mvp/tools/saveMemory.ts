import * as z from 'zod';
import { refusal } from '../../toolRefusal.js';
import { autoCorrectionEnabled, detectCorrection } from '../../memory/autoCorrection.js';
import { remember, scopeFilterFor } from '../../memory/lifecycle.js';
import { possibleDuplicates } from '../../memory/factConflicts.js';
import { omittedWhenBlank, CITES_ARG, SCOPE_ARG, SOURCE_ARG_DESCRIPTION, OUT_CREATED_FACT, OUT_CLOSED_FACT, OUT_DUPLICATES, sourceOf, agentOf, callOrigin, oneLineHint, toolError } from './shared.js';
import { layeredScopeEnabled, recordSaveOrigin } from '../layeredScope.js';
import type { ToolContext } from './setup.js';

/** Registers save_memory: the lifecycle save of a value with its subject and predicate. */
export function registerSaveMemoryTool(ctx: ToolContext): void {
  const { db, config, usefulness, dreamer, jsonResult, readerOf, server } = ctx;
  server.registerTool('save_memory', {
    title: 'Save (or correct) a memory',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Structured save only: one fact as subject, predicate and object, e.g. save_memory({"subject": "Fjord", "predicate": "database", "object": "SQLite"}). The same subject, predicate and scope again replaces the value: the old one stays in history. A save by a different agent than the one that saved the current value still replaces it, but the replaced value is then shown in reads as a CONFLICT line (its writer and date) until that agent saves this subject and predicate again. The writer is the connection\'s authenticated agent name, never the source you pass. The receipt says store, supersede or nochange, and may list possibleDuplicates (see remember). All three fields are required and no sentence of yours is kept: to save plain words, or a fact with your words, call remember.',
    inputSchema: {
      // Optional in the schema so a call that lacks them reaches the handler and is told what to do (a plain save belongs
      // to remember), instead of the SDK's raw validation error. The handler still requires all three.
      subject: omittedWhenBlank(z.string().optional()).describe('Who/what the fact is about, e.g. "user"'),
      predicate: omittedWhenBlank(z.string().optional()).describe('The relationship, e.g. "works_at"'),
      object: omittedWhenBlank(z.string().optional()).describe('The value, e.g. "Memory Company"'),
      source: omittedWhenBlank(z.string().optional()).describe(SOURCE_ARG_DESCRIPTION),
      scope: SCOPE_ARG,
      cites: CITES_ARG,
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      action: z.enum(['store', 'supersede', 'nochange']),
      eventId: z.string(),
      subject: z.string(),
      predicate: z.string(),
      closed: OUT_CLOSED_FACT,
      alsoClosed: OUT_CLOSED_FACT,
      created: OUT_CREATED_FACT,
      possibleDuplicates: OUT_DUPLICATES,
      possibleDuplicatesTotal: z.number().optional(),
      ledger: z.string(),
    }),
  }, async (args, extra) => {
    try {
      const { subject, predicate, object } = args;
      if (subject === undefined || predicate === undefined || object === undefined) {
        const missing = (['subject', 'predicate', 'object'] as const).filter(name => args[name] === undefined);
        throw refusal('missing_argument', `save_memory saves one fact and needs subject, predicate and object (missing: ${missing.join(', ')}). To save plain words, call remember with only statement, e.g. remember({"statement": "We moved the Fjord database to SQLite."}).`);
      }
      const correction = autoCorrectionEnabled() ? detectCorrection(db, { subject, predicate, object, scope: args.scope }) : null;
      const receipt = await remember(db, config.memoryDir, config.ledgerRelPath, {
        subject: correction?.subject ?? subject,
        predicate: correction?.predicate ?? predicate,
        object,
        source: sourceOf(args.source, extra, config),
        writer: agentOf(extra, config),
        scope: args.scope,
      });
      usefulness.cited(args.cites);
      if (receipt.action !== 'nochange') usefulness.updated(receipt.subject, receipt.predicate);
      // RENOR_LAYERED_SCOPE: where this was said and whether it is about the user or a project (metadata, nothing moves).
      if (layeredScopeEnabled() && receipt.action !== 'nochange' && receipt.eventId) {
        recordSaveOrigin(db, { eventId: receipt.eventId, text: `${receipt.subject} ${receipt.predicate}: ${object}`, subject: receipt.subject, origin: callOrigin(extra, config), explicitScope: args.scope });
      }
      // The same advisory hint `remember` gives a fact receipt (memory/factConflicts.ts): the fact is saved whatever
      // this read does, so its failure leaves the hint out instead of failing the save.
      let duplicates: ReturnType<typeof possibleDuplicates> = { values: [], total: 0 };
      try {
        duplicates = possibleDuplicates(db, receipt, receipt.created?.factId ?? null, scopeFilterFor(args.scope), readerOf(extra));
      } catch { /* no hint */ }
      if (receipt.action !== 'nochange') dreamer?.noteFactSave();
      return jsonResult({
        ok: receipt.ok,
        action: receipt.action,
        eventId: receipt.eventId,
        subject: receipt.subject,
        predicate: receipt.predicate,
        closed: receipt.closed,
        ...(receipt.alsoClosed ? { alsoClosed: receipt.alsoClosed } : {}),
        created: receipt.created,
        ...(duplicates.values.length > 0 ? { possibleDuplicates: duplicates.values } : {}),
        ...(duplicates.total > duplicates.values.length ? { possibleDuplicatesTotal: duplicates.total } : {}),
        ...(correction && receipt.action !== 'nochange' ? { autoCorrected: { replaced: correction.replaced, reason: correction.reason } } : {}),
        ledger: config.ledgerRelPath, // relative: no host paths leak to the client
      });
    } catch (err) {
      return toolError(oneLineHint(err));
    }
  });
}
