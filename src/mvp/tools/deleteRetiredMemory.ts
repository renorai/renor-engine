import * as z from 'zod';
import { refusal } from '../../toolRefusal.js';
import { purgeRetired } from '../../memorymap/memoryMap.js';
import { MAX_LOOKUP_LIMIT, isDashboardCall, registeredToolEntry, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers delete_retired_memory: owner-only, from the dashboard. */
export function registerDeleteRetiredMemoryTool(ctx: ToolContext): void {
  const { config, dashboard, jsonResult, server, learner, mapContext } = ctx;
  // Only for the owner, from the dashboard. Irreversible, so an agent never holds it: retire_memory is how an agent forgets, and
  // the owner decides what is erased. Only the gateway can set the mark this reads, and it sets it only for the dashboard's own
  // short-lived read key; it strips a client-sent copy (apps/gateway/src/dashboard-mark.ts). Three layers, none relying on another:
  //   1. tools/list (installed once every tool is registered) drops the tool from its answer unless the request being answered carries
  //      the mark. An SSE session keeps one server, so what was decided when it was built would keep listing the tool after the mark was gone;
  //   2. a server built without the mark has the tool disabled in the SDK's registry, so a call is refused before it reaches the handler;
  //   3. the handler below refuses a call whose own request carries no mark, which is what a session built with the mark answers.
  // (1) and (2) act on the registry's entry and on the answer, never on the handle registerTool returns: in a workspace that reports to
  // PostHog (RENOR_POSTHOG_KEY), @posthog/mcp stores a copy of the tool and that handle no longer reaches the SDK
  // (tests/review/delete-retired-instrumented.test.ts).
  server.registerTool('delete_retired_memory', {
    title: 'Permanently delete retired memories (owner only)',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Permanently deletes a retired memory (id from memory_map.retired), or every listed retired memory (id: "all"; with ids, only those ids). Cannot be undone. A live memory is retired first.',
    inputSchema: {
      id: z.string().min(1).max(64).describe('A retired memory id from memory_map.retired, or "all"'),
      ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_LOOKUP_LIMIT).optional().describe('With id "all": only these retired memory ids (what the owner saw listed)'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      action: z.enum(['deleted']),
      ids: z.array(z.string()),
      freedBytes: z.number(),
      at: z.string(),
    }),
  }, async (args, extra) => {
    try {
      if (!isDashboardCall(extra?.requestInfo?.headers, config)) {
        throw refusal('invalid_argument', 'delete_retired_memory is only available to the owner, from the Renor dashboard');
      }
      return jsonResult(await purgeRetired({ ...mapContext(), source: 'dashboard' }, args.id, args.ids, (links) => learner?.erased(links)));
    } catch (err) {
      return toolError(err);
    }
  });
  if (!dashboard) registeredToolEntry(server, 'delete_retired_memory').enabled = false;
}
