import { saveMomentTool } from '../saveMoment.js';
import { MAX_STATEMENT_LENGTH } from '../../memory/limits.js';
import * as z from 'zod';
import { refusal } from '../../toolRefusal.js';
import { assertReplaceable } from '../../memorymap/replacements.js';
import { normalizeScope } from '../scope.js';
import { autoCorrectionEnabled, detectCorrection } from '../../memory/autoCorrection.js';
import { remember, resolveLedgerPath, scopeFilterFor } from '../../memory/lifecycle.js';
import { engineIndexChanged, engineRememberNote } from '../engine.js';
import { possibleDuplicates } from '../../memory/factConflicts.js';
import { blankStatementFilled, statementSchema, omittedWhenBlank, TIMEZONE_ARG, CITES_ARG, REPLACES_ARG, SCOPE_ARG, SOURCE_ARG_DESCRIPTION, OUT_INDEX_PASS, OUT_CREATED_FACT, OUT_CLOSED_FACT, OUT_DUPLICATES, OUT_REPLACEMENT, sourceOf, agentOf, callOrigin, unfinishedPass, indexSavedNote, oneLineHint, toolError } from './shared.js';
import { layeredScopeEnabled, recordSaveOrigin } from '../layeredScope.js';
import type { ToolContext } from './setup.js';

const RECEIPT_ECHO_CHARS = 80;
/** The off switch: RENOR_FULL_SAVE_RECEIPT=1 (or on, true, yes) echoes the whole statement in the receipt, as before. */
export const FULL_SAVE_RECEIPT_FLAG = 'RENOR_FULL_SAVE_RECEIPT';

/**
 * What a save receipt says about the statement. A statement of 80 characters or fewer, or the flag set, is echoed unchanged
 * (today's reply byte for byte). A longer one is cut to its first 80 characters plus an ellipsis, with its full length and a
 * plain note that the whole text was stored; the stored text and read_memory are untouched.
 */
export function echoedStatement(statement: string, env: NodeJS.ProcessEnv = process.env): { statement: string; statementChars?: number; statementStored?: string } {
  if (/^(1|true|yes|on)$/i.test((env[FULL_SAVE_RECEIPT_FLAG] ?? '').trim())) return { statement };
  const chars = Array.from(statement);
  if (chars.length <= RECEIPT_ECHO_CHARS) return { statement };
  return {
    statement: `${chars.slice(0, RECEIPT_ECHO_CHARS).join('')}…`,
    statementChars: chars.length,
    statementStored: 'Stored whole, word for word; read_memory with the receipt id returns all of it.',
  };
}

/** Registers remember: save one statement (or a subject, predicate, object) to memory. */
export function registerRememberTool(ctx: ToolContext): void {
  const { db, config, engine, digests, usefulness, dreamer, jsonResult, readerOf, saveMoment, statusLedger, server, recordNoteSave, mapContext, replacementReceipt, inferReplacesFor } = ctx;
  server.registerTool('remember', {
    title: 'Remember something naturally',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: saveMomentTool(saveMoment, statusLedger !== '') + 'Save something to memory: pass `statement`, in plain words, and nothing else. Do not save passwords, API keys or tokens. Example: remember({"statement": "We moved the Fjord database to SQLite because it needs no server."}). It is stored whole and indexed at once, so get_context finds it right away; the receipt\'s id is what read_memory and retire_memory take. `scope` ("project:<slug>") keeps it with one project. '
      + 'Only for a value that stays current until it changes (a city, a project\'s database, a deadline, a preference), also pass subject, predicate and object together: "subject": "Fjord", "predicate": "database", "object": "SQLite". Saving the same subject, predicate and scope again replaces the value: the old one leaves current reads and stays in history. A save by a different agent than the one that saved the current value is shown in reads as a CONFLICT line until that agent saves it again (see save_memory). Spell them the same every time. Decisions, events and notes need none of the three: leave them out, never guess them. '
      + `The same statement for the same fact again changes nothing. A statement over ${MAX_STATEMENT_LENGTH} characters is refused, never cut, in either form. Saved on its own as a note, one that is not valid Unicode or holds a control character (U+0000 to U+001F except tab, newline and carriage return, or U+007F) is refused and nothing is written; with subject, predicate and object it is saved as a fact with its control characters escaped in the ledger, and only those three fields refuse them. A fact receipt may list possibleDuplicates (the same predicate under a name one word longer or shorter, or in another scope): nothing is merged; to correct one, save again with its subject and scope. A save is compared within the scope it names.`
      + ' To correct one specific earlier note or log entry (not a fact), also pass `replaces`, its id (from memory_map with a query, or an earlier save\'s receipt): that memory is then marked replaced, with a pointer to this save, in every recall, and this save is listed before it. Nothing is deleted; retire_memory on this save undoes it, and the receipt says `replaced` (or `replacesIgnored` when linking would make a loop, as when the save is the same line as the memory it replaces). '
      + 'Sent with subject, predicate and object as well, replaces naming a note or entry makes the save that plain-words correction (`factFieldsIgnored`), and replaces naming a fact is dropped while the fact is saved (`replacesIgnored`).',
    inputSchema: {
      statement: statementSchema().describe('The thing to remember, in plain words.'),
      subject: omittedWhenBlank(z.string().optional()).describe('With predicate and object: who or what the value is about, e.g. "Fjord".'),
      predicate: omittedWhenBlank(z.string().optional()).describe('With subject and object: the attribute, snake_case, spelled the same every time, e.g. "database".'),
      object: omittedWhenBlank(z.string().optional()).describe('With subject and predicate: the current value, on one line, e.g. "SQLite".'),
      source: omittedWhenBlank(z.string().optional()).describe(SOURCE_ARG_DESCRIPTION),
      scope: SCOPE_ARG,
      timezone: TIMEZONE_ARG,
      cites: CITES_ARG,
      replaces: REPLACES_ARG,
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      mode: z.enum(['fact', 'note']),
      statement: z.string(),
      action: z.enum(['store', 'supersede', 'nochange']).optional(),
      eventId: z.string().optional(),
      subject: z.string().optional(),
      predicate: z.string().optional(),
      closed: OUT_CLOSED_FACT,
      alsoClosed: OUT_CLOSED_FACT,
      created: OUT_CREATED_FACT,
      scope: z.string().optional(),
      possibleDuplicates: OUT_DUPLICATES,
      possibleDuplicatesTotal: z.number().optional(),
      file: z.string().optional(),
      id: z.string().optional(),
      replaced: OUT_REPLACEMENT,
      replacesIgnored: z.string().optional(),
      indexed: z.boolean().optional(),
      index: OUT_INDEX_PASS,
      warning: z.string().optional(),
      detail: z.string().optional(),
    }),
  }, async (args, extra) => {
    try {
      const structured = [args.subject, args.predicate, args.object];
      const present = structured.filter(v => typeof v === 'string' && v.trim().length > 0).length;
      // A blank statement with a full subject/predicate/object (what a small model sends when it fills only the fact fields) is
      // filled from them, so the save lands on the first try; RENOR_BLANK_STATEMENT=off restores the refusal.
      if (blankStatementFilled() && args.statement === '' && present === 3) {
        args.statement = `${args.subject} ${args.predicate}: ${args.object}`.slice(0, MAX_STATEMENT_LENGTH);
      }
      if (args.statement === '') {
        throw refusal('invalid_argument', 'remember needs `statement`: the thing to remember, in plain words (or subject, predicate and object together)');
      }
      if (present !== 0 && present !== 3) {
        throw refusal('invalid_argument', 'remember requires subject, predicate, and object together, or none of them: to save plain words pass only statement');
      }

      // A client may send a value's subject, predicate and object together with replaces. One of the two is kept rather than the
      // call refused, so the save lands on the first try: replaces naming a fact is dropped (a fact is corrected by saving it
      // again, which this save does), and replaces naming a note or log entry wins (the save becomes a plain-words correction
      // of it, which is the only way that note is marked replaced). The receipt says which.
      let replaces = args.replaces;
      let asFact = present === 3;
      let adjusted: Record<string, string> = {};
      if (replaces !== undefined && asFact) {
        if (replaces.startsWith('fact:')) {
          replaces = undefined;
          adjusted = { replacesIgnored: 'replaces named a fact: a fact is corrected by saving it again with the same subject, predicate and scope, which this save did' };
        } else {
          asFact = false;
          adjusted = { factFieldsIgnored: 'replaces named a note or log entry, so this save is a plain-words correction of it; subject, predicate and object were not saved as a fact' };
        }
      }
      if (replaces !== undefined) await assertReplaceable(mapContext(), replaces, normalizeScope(args.scope));

      if (asFact) {
        const correction = autoCorrectionEnabled()
          ? detectCorrection(db, { subject: args.subject!, predicate: args.predicate!, object: args.object!, scope: args.scope, statement: args.statement })
          : null;
        const receipt = await remember(db, config.memoryDir, config.ledgerRelPath, {
          subject: correction?.subject ?? args.subject!,
          predicate: correction?.predicate ?? args.predicate!,
          object: args.object!,
          source: sourceOf(args.source, extra, config),
          writer: agentOf(extra, config),
          scope: args.scope,
          statement: args.statement,
        });
        usefulness.cited(args.cites);
        if (receipt.action !== 'nochange') usefulness.updated(receipt.subject, receipt.predicate);
        // RENOR_LAYERED_SCOPE: where this was said and whether it is about the user or a project (metadata, nothing moves).
        if (layeredScopeEnabled() && receipt.action !== 'nochange' && receipt.eventId) {
          recordSaveOrigin(db, { eventId: receipt.eventId, text: args.statement, subject: receipt.subject, origin: callOrigin(extra, config), explicitScope: args.scope });
        }
        // The ledger holds the user's own words now, so index it: recall by
        // their phrasing (semantic or keyword) then reaches the fact. The fact
        // is already durable, so a failed refresh must not fail the receipt; the
        // receipt says it failed, and why.
        // Only the ledger, which this save appended to, is checked: its new event is what changed, so a save costs the
        // same however many events and notes the workspace holds. The vault is walked only once every
        // FULL_VAULT_CHECK_MS (see engineIndexChanged).
        let refresh: Record<string, unknown> = {};
        if (receipt.action !== 'nochange') {
          dreamer?.noteFactSave();
          try {
            const pass = await engineIndexChanged(db, config, engine, undefined, {
              interactive: true,
              touched: [resolveLedgerPath(config.memoryDir, config.ledgerRelPath)],
            });
            if (pass.errors > 0) refresh = unfinishedPass(pass);
            else if (pass.tooLarge) refresh = { warning: 'memory-saved-but-not-indexed', detail: `${pass.tooLarge.join(', ')} is over the 8 MiB note size limit, so it is saved but no longer searchable. Split it or move it out of the memory folder.` };
          } catch {
            refresh = { warning: 'memory-saved-but-index-refresh-failed' };
          }
        }
        // Other current facts that may be this one under another name or scope (memory/factConflicts.ts). Advisory:
        // the fact is saved whatever this read does, so its failure leaves the hint out instead of failing the save.
        let duplicates: ReturnType<typeof possibleDuplicates> = { values: [], total: 0 };
        try {
          duplicates = possibleDuplicates(db, receipt, receipt.created?.factId ?? null, scopeFilterFor(args.scope), readerOf(extra));
        } catch { /* no hint */ }
        return jsonResult({
          ok: receipt.ok,
          mode: 'fact',
          ...echoedStatement(args.statement),
          action: receipt.action,
          eventId: receipt.eventId,
          subject: receipt.subject,
          predicate: receipt.predicate,
          closed: receipt.closed,
          ...(receipt.alsoClosed ? { alsoClosed: receipt.alsoClosed } : {}),
          created: receipt.created,
          scope: normalizeScope(args.scope),
          ...(duplicates.values.length > 0 ? { possibleDuplicates: duplicates.values } : {}),
          ...(duplicates.total > duplicates.values.length ? { possibleDuplicatesTotal: duplicates.total } : {}),
          ...(correction && receipt.action !== 'nochange' ? { autoCorrected: { replaced: correction.replaced, reason: correction.reason } } : {}),
          ...adjusted,
          ...refresh,
        });
      }

      const source = sourceOf(args.source, extra, config);
      const inference = replaces === undefined ? await inferReplacesFor(args.statement, args.scope, source ?? 'mcp:remember') : {};
      const inferred = inference.id;
      const note = await engineRememberNote(config, args.statement, undefined, source ?? 'mcp:remember', args.scope, args.timezone);
      recordNoteSave(note.file, args.statement, source, note.scope);
      if (layeredScopeEnabled() && note.id) {
        recordSaveOrigin(db, { noteId: note.id, notePath: note.file, text: args.statement, origin: callOrigin(extra, config), explicitScope: args.scope });
      }
      usefulness.cited(args.cites);
      const replaced = (replaces ?? inferred) !== undefined && note.id
        // The source the entry was written with (the default of this write, when none), so the link names the same one.
        ? await replacementReceipt((replaces ?? inferred)!, note.id, source ?? 'mcp:remember', inferred !== undefined)
        : {};
      return jsonResult({
        ok: true,
        mode: 'note',
        ...echoedStatement(args.statement),
        file: note.file,
        scope: note.scope,
        ...(note.id ? { id: note.id } : {}),
        ...adjusted,
        ...replaced,
        ...(inference.possibly && inferred === undefined ? { possiblyReplaces: inference.possibly } : {}),
        ...(await indexSavedNote(db, config, engine, digests, note.file)),
      });
    } catch (err) {
      return toolError(oneLineHint(err));
    }
  });
}
