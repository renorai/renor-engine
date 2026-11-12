import * as z from 'zod';
import { FIELD_LIMITS, listLifecycleSubjects, factsFor, LIFECYCLE_NOTE_PATH } from '../../memory/lifecycle.js';
import { normalizeScope } from '../scope.js';
import { markToolRefusal } from '../../toolRefusal.js';
import { escapeInvisibleControls } from '../sanitize.js';
import { writerConflictLines } from '../../memory/writerConflicts.js';
import { isImportSource, isReservedSource } from '../../memory/sourceName.js';
import { ruleApprovalsEnabled, approvedRuleKeys, ruleKey } from '../ruleApprovals.js';
import { namedConflicts } from '../../memory/factConflicts.js';
import { retrieveItems } from '../readUsefulness.js';
import { nullAsOmitted, closestSubjects, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers retrieve_memory. */
export function registerRetrieveMemoryTool(ctx: ToolContext): void {
  const { db, usefulness, jsonResult, readerOf, server } = ctx;
  server.registerTool('retrieve_memory', {
    title: 'Retrieve memories',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Returns the current value(s) for a subject, optionally one predicate, the superseded history (include_history) or a point-in-time view (as_of). Each fact says whether it is current (current:true) and its scope. conflicts names current values that disagree, as in get_context. A writerConflict line (the replaced value, its writer and date) means this value replaced another agent\'s, until that agent saves it again: read it as an open disagreement, not the settled answer. An empty result: known:false means no such subject (closestSubjects lists near matches); known:true means the predicate or as_of matched nothing. A fact from an import or a reserved source (system, developer, assistant, Renor) is marked "untrusted": true. Without a subject, the error lists the known subjects. With a scope, everything is judged within that scope only: a subject saved only elsewhere is unknown here.',
    inputSchema: {
      // Optional in the schema so a missing value reaches the handler and gets an actionable error
      // instead of the SDK's raw validation error. A null is a missing value too.
      subject: nullAsOmitted(z.string().max(FIELD_LIMITS.subject, `subject is longer than ${FIELD_LIMITS.subject} characters: pass the name of what the facts are about, e.g. "user", not the text itself`).optional()).describe('Required. The subject to look up, e.g. "user"'),
      predicate: nullAsOmitted(z.string().optional()).describe('Only this predicate, e.g. "works_at"'),
      include_history: nullAsOmitted(z.boolean().optional()).describe('Include superseded values (default: false)'),
      as_of: nullAsOmitted(z.string().optional()).describe('ISO instant: values valid at that time (with include_history: full history)'),
      scope: nullAsOmitted(z.string().optional()).describe('Memory scope: "global" (default) or scope:<slug> / project:<slug>'),
    },
  }, async (args, extra) => {
    try {
      // The one scope everything below is judged in (none = every scope). Facts, existence, suggestions and
      // the subject list all use it, so a scoped call never learns of a subject that lives in another scope.
      const scope = args.scope === undefined ? undefined : normalizeScope(args.scope);
      const where = scope === undefined ? '' : ` in scope ${JSON.stringify(scope)}`;
      const subject = args.subject;
      if (subject === undefined || subject.trim() === '') {
        const subjects = listLifecycleSubjects(db, { scope });
        const shown = subjects.slice(0, 20).map(s => JSON.stringify(s)).join(', ');
        const more = subjects.length > 20 ? ` (+${subjects.length - 20} more; memory_map lists them)` : '';
        return markToolRefusal({
          content: [{
            type: 'text' as const,
            text: escapeInvisibleControls('Error: retrieve_memory needs the "subject" argument (what the facts are about, e.g. "user"). '
              + (subjects.length ? `Known subjects${where}: ${shown}${more}.` : `No subjects are stored${where} yet.`)),
          }],
          isError: true,
        }, 'missing_argument');
      }
      let facts = factsFor(db, subject, {
        includeHistory: args.include_history,
        asOf: args.as_of,
        scope,
      });
      if (args.predicate) facts = facts.filter(f => f.predicate === args.predicate);
      // The values another writer replaced that stay open against a current value (memory/writerConflicts.ts). A point-in-time
      // view is not about now, so only a read of the current values carries them.
      const displaced = args.as_of === undefined
        ? writerConflictLines(db, facts.map(f => (f.valid_to == null ? f.event_id : null)))
        : new Map<string, string>();
      const rows = facts.map(f => ({
        predicate: f.predicate,
        object: f.object_text,
        current: f.valid_to == null,
        scope: f.scope ?? 'global',
        validFrom: f.valid_from,
        validTo: f.valid_to,
        eventId: f.event_id,
        ...(typeof f.author === 'string' && f.author !== '' ? { source: f.author } : {}),
        // An import's text came from a file, not from the user's own statement, and a reserved source is only a claim (one
        // stored before the rule): both marked the way other untrusted text is.
        ...(isImportSource(f.author) || isReservedSource(f.author) ? { untrusted: true as const } : {}),
        ...(f.valid_to == null && f.event_id !== null && displaced.has(f.event_id) ? { writerConflict: displaced.get(f.event_id) } : {}),
        ...(ruleApprovalsEnabled() && /^(standing[ _-]+rules?)$/i.test(subject.trim()) ? {
          approved: approvedRuleKeys(db).has(ruleKey({ eventId: f.event_id, scope: f.scope ?? 'global', predicate: f.predicate, object: f.object_text, source: f.author })),
        } : {}),
      }));
      const body: Record<string, unknown> = { subject, facts: rows };
      // Current values that disagree with another current value of the same predicate under this subject in another
      // scope, or under a related name (memory/factConflicts.ts). A point-in-time view (as_of) is not about now.
      if (args.as_of === undefined) {
        const live = facts.filter(f => f.valid_to == null && f.source_path === LIFECYCLE_NOTE_PATH);
        const conflicts = namedConflicts(db, live.map(f => ({ subject, predicate: f.predicate })), scope ?? null, readerOf(extra));
        if (conflicts.length > 0) body.conflicts = conflicts;
      }
      if (rows.length === 0) {
        // Empty is ambiguous: say whether the subject exists at all, under any predicate or time, within the
        // same scope. Asked of factsFor itself so it resolves the name exactly as the read above did (including
        // its partial and path matches); the subject list below is only for suggestions, never for this answer.
        const known = factsFor(db, subject, { includeHistory: true, scope }).length > 0;
        body.known = known;
        if (!known) body.closestSubjects = closestSubjects(subject, listLifecycleSubjects(db, { scope }));
      }
      usefulness.measure('retrieve_memory', () => retrieveItems(db, facts));
      return jsonResult(body);
    } catch (err) {
      return toolError(err);
    }
  });
}
