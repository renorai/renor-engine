import { observeEnabled } from '../observations.js';
import * as z from 'zod';
import { EXPORT_SECTIONS, exportEverything } from '../exportAll.js';
import { escapeInvisibleControls } from '../sanitize.js';
import { nullAsOmitted, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers export_memory. */
export function registerExportMemoryTool(ctx: ToolContext): void {
  const { withSchemas, server, mapContext } = ctx;
  server.registerTool('export_memory', {
    title: 'Export everything this workspace holds',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Returns everything the workspace holds, as portable Markdown (format renor-export/v1): the fact ledger exactly as stored (every fact with its subject, predicate, object, your words, source, scope, timestamps and event id, retired ones included), every daily-log entry (remember, remember_note) with its timestamp, source and scope, every other note (imports and your own notes) in full with its metadata, and everything retired and not restored (notes, entries, facts) with when it was retired. '
      + 'The reply is two blocks: a JSON manifest (counts per kind for a whole export, the sections it carries, whether it is complete) and the document. A workspace too large for one reply is paged, never cut: while the manifest says truncated, or has nextSection/nextItem, call again with section (ledger, daily-entries, notes, retired, and learning-log when the manifest names it) and offset (the item to continue from) until neither is set. A reply holds at most a bounded page, however large the workspace is. '
      + 'Not exported, and listed by kind in the manifest\'s notExported: the search index and embeddings (rebuilt from this), agent requests, import receipts, activity, agent connection state, the promoted history directory, and non-Markdown files.',
    inputSchema: {
      section: nullAsOmitted((observeEnabled() ? z.enum([...EXPORT_SECTIONS, 'observations']) : z.enum(EXPORT_SECTIONS)).optional()).describe('Continue with this section only (from the manifest\'s nextSection)'),
      offset: nullAsOmitted(z.number().int().min(0).optional()).describe('The item of that section to continue from (from the manifest\'s nextItem); default 0'),
    },
  }, async (args) => {
    try {
      const { manifest, document } = await exportEverything(mapContext(), { section: args.section, offset: args.offset });
      // Once: a manifest can carry a learning log of some size, and every copy of it is memory the reply holds.
      const manifestText = escapeInvisibleControls(JSON.stringify(manifest));
      return {
        content: [
          // The manifest is metadata an agent reads: escape invisible controls as in every other JSON reply.
          // The document is the portable archive and stays byte-faithful, so it is not rewritten here.
          { type: 'text' as const, text: manifestText },
          { type: 'text' as const, text: document },
        ],
        // The structured result (output schemas on) is the manifest: JSON.parse of the first block, the value a client parses
        // from it. The second block (the portable document) is not structured data.
        ...(withSchemas ? { structuredContent: JSON.parse(manifestText) as Record<string, unknown> } : {}),
      };
    } catch (err) {
      return toolError(err);
    }
  });
}
