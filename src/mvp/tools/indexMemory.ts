import * as z from 'zod';
import { engineIndex } from '../engine.js';
import { toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers index_memory. */
export function registerIndexMemoryTool(ctx: ToolContext): void {
  const { db, config, engine, digests, jsonResult, server } = ctx;
  server.registerTool('index_memory', {
    title: 'Index the memory folder',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Walks the workspace\'s Markdown notes into the search index (chunks, keyword index, entities). If an embedding provider is configured, stamps new and changed notes with it; the provider must match the existing index dimensions. Run it when search_memory or get_context report index.stale; saved facts are keyword-searchable without it. It does not wait for a slow or refusing embedding service: such files are reported (warning "index-unfinished") and finished in the background.',
    inputSchema: {},
    outputSchema: z.looseObject({
      ok: z.boolean(),
      total: z.number(),
      indexed: z.number(),
      errors: z.number(),
      skippedNonUtf8Names: z.array(z.string()).optional(),
      skippedTooLarge: z.array(z.string()).optional(),
      failure: z.string().optional(),
      warning: z.string().optional(),
      detail: z.string().optional(),
    }),
  }, async () => {
    try {
      const stats = await engineIndex(db, config, engine, { interactive: true });
      digests?.worker.notify();
      // A file the embedding service would not take in time is saved and found by keyword; a background job embeds it.
      return jsonResult({
        ok: true,
        ...stats,
        ...(stats.errors > 0
          ? { warning: 'index-unfinished', detail: `${stats.errors} file(s) are indexed for keyword search but not yet for search by meaning: the embedding service did not answer in time, and they are being finished in the background (memory_status shows chunksWithoutVectors until they are).` }
          : {}),
      });
    } catch (err) {
      return toolError(err);
    }
  });
}
