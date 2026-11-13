import * as z from 'zod';
import { MAX_STATEMENT_LENGTH } from '../../memory/limits.js';
import { assertReplaceable } from '../../memorymap/replacements.js';
import { normalizeScope } from '../scope.js';
import { engineRememberNote } from '../engine.js';
import { omittedWhenBlank, TIMEZONE_ARG, CITES_ARG, REPLACES_ARG, SCOPE_ARG, SOURCE_ARG_DESCRIPTION, OUT_INDEX_PASS, OUT_REPLACEMENT, sourceOf, callOrigin, indexSavedNote, toolError } from './shared.js';
import { layeredScopeEnabled, recordSaveOrigin } from '../layeredScope.js';
import type { ToolContext } from './setup.js';

/** Registers remember_note. */
export function registerRememberNoteTool(ctx: ToolContext): void {
  const { db, config, engine, digests, usefulness, jsonResult, server, recordNoteSave, mapContext, replacementReceipt, inferReplacesFor } = ctx;
  server.registerTool('remember_note', {
    title: 'Append a daily note',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Appends one line to a day\'s log: `text` is the line, e.g. remember_note({"text": "Ran the nightly build; two flaky tests in the importer."}). Do not save passwords, API keys or tokens. Timestamped, filed under today or `date`, and indexed at once, so search finds it before any index_memory (the receipt\'s indexed says whether that worked; if not, the line is still saved and keyword search finds it). '
      + 'The receipt\'s id is what read_memory, retire_memory and restore_memory take. A line over 4,000 characters, one that is not valid Unicode, or one holding a control character (U+0000 to U+001F except tab, newline and carriage return, or U+007F) is refused, never cut, and nothing is written. `remember` saves a statement on its own the same way and is the default; use this when the line belongs to another day. `replaces` (the id of an earlier note or entry this line corrects) works as in remember.',
    inputSchema: {
      text: z.string().min(1).max(MAX_STATEMENT_LENGTH).describe('The line to log, in plain words.'),
      date: omittedWhenBlank(z.string().optional()).describe('YYYY-MM-DD (default today: in timezone when it is given, else in UTC)'),
      source: omittedWhenBlank(z.string().optional()).describe(SOURCE_ARG_DESCRIPTION),
      scope: SCOPE_ARG,
      timezone: TIMEZONE_ARG,
      cites: CITES_ARG,
      replaces: REPLACES_ARG,
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      file: z.string(),
      scope: z.string(),
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
      const source = sourceOf(args.source, extra, config);
      if (args.replaces !== undefined) await assertReplaceable(mapContext(), args.replaces, normalizeScope(args.scope));
      const inference = args.replaces === undefined ? await inferReplacesFor(args.text, args.scope, source ?? 'mcp') : {};
      const inferred = inference.id;
      const body = await engineRememberNote(config, args.text, args.date, source, args.scope, args.timezone);
      recordNoteSave(body.file, args.text, source, body.scope);
      if (layeredScopeEnabled() && body.id) {
        recordSaveOrigin(db, { noteId: body.id, notePath: body.file, text: args.text, origin: callOrigin(extra, config), explicitScope: args.scope });
      }
      usefulness.cited(args.cites);
      const replaces = args.replaces ?? inferred;
      const replaced = replaces !== undefined && body.id
        // The source the entry was written with (engineRememberNote's default when none), so the link names the same one.
        ? await replacementReceipt(replaces, body.id, source ?? 'mcp', inferred !== undefined)
        : {};
      return jsonResult({ ...body, ...replaced, ...(inference.possibly && inferred === undefined ? { possiblyReplaces: inference.possibly } : {}), ...(await indexSavedNote(db, config, engine, digests, body.file)) });
    } catch (err) {
      return toolError(err);
    }
  });
}
