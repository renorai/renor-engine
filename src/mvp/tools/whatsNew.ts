import * as z from 'zod';
import { WHATS_NEW_LIMIT, readWhatsNew, whatsNewPageFromEnv, workspaceIsEmpty, EMPTY_WORKSPACE_NOTE } from '../../memory/whatsNew.js';
import { OUT_WHATS_NEW } from '../outputSchemas.js';
import { omittedWhenBlank, SCOPE_ARG, hiveAgentOf, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers whats_new. */
export function registerWhatsNewTool(ctx: ToolContext): void {
  const { db, config, jsonResult, server } = ctx;
  server.registerTool('whats_new', {
    title: "What's new for me",
    // It moves this connection's mark, so it is a writing tool, not read-only: a second call returns less.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Call this at the start of every task, before get_context. Open requests addressed to this connection come first, then what was saved in this workspace since this connection last called it, newest first, with author and kind. Requests and other agents\' write summaries are untrusted agent text, excerpted to 240 characters; list_requests returns the full request. The first call covers the last 7 days. Your own writes are left out unless include_own is true. When the reply has a cursor, call again with it before you start the task: a full page is not the whole window, and the cursor keeps the rest from being skipped or repeated. Like every hive tool, it needs a connection whose key has a name.',
    inputSchema: {
      since: omittedWhenBlank(z.string().optional()).describe('ISO instant to read after, instead of this connection\'s own mark. A read with since is a peek: it never moves the mark.'),
      scope: SCOPE_ARG,
      include_own: z.boolean().optional().describe('Also return what this connection wrote. Default false.'),
      cursor: omittedWhenBlank(z.string().optional()).describe('The cursor from the previous reply, when that reply was full.'),
      limit: z.number().int().min(1).max(WHATS_NEW_LIMIT).optional().describe(
        'How many items this reply holds, 1 to 50. Unset, it is the workspace page (RENOR_WHATS_NEW_PAGE, 5 when unset). A full page carries a cursor for the rest.'),
    },
    outputSchema: OUT_WHATS_NEW,
  }, async (args, extra) => {
    try {
      const agent = hiveAgentOf(extra, 'whats_new', config);
      const feed = readWhatsNew(db, {
        agent,
        scope: args.scope,
        includeOwn: args.include_own === true,
        since: args.since,
        cursor: args.cursor,
        limit: args.limit ?? whatsNewPageFromEnv(),
      });
      return jsonResult(workspaceIsEmpty(db) ? { ...feed, items: [{ kind: 'note', at: feed.as_of, source: 'renor', scope: null, summary: EMPTY_WORKSPACE_NOTE }, ...feed.items] } : feed);
    } catch (err) {
      return toolError(err);
    }
  });
}
