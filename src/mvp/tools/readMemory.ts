import * as z from 'zod';
import { OUT_HIT } from '../outputSchemas.js';
import { readMemory } from '../../memorymap/memoryMap.js';
import { replacementIndex } from '../../memorymap/replacements.js';
import { labelMemoryText } from '../hiddenSpans.js';
import { markStoredMemory, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers read_memory. */
export function registerReadMemoryTool(ctx: ToolContext): void {
  const { usefulness, jsonResult, server, mapContext, memoryIdSchema } = ctx;
  server.registerTool('read_memory', {
    title: 'Read one memory in full',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Returns one memory from memory_map by id: its full text, note metadata (status, tags, dates) and facts extracted from it. memory.session_date is when it was written, the date get_context and search_memory give the same text (memory.at is the entry\'s moment or the note\'s last write). An imported memory carries origin: "import"; a reserved stored source (system, developer, assistant, Renor) is marked "untrusted": true.',
    inputSchema: { id: memoryIdSchema },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      memory: OUT_HIT.optional(),
      text: z.string().optional(),
      textTruncated: z.boolean().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      facts: z.array(OUT_HIT).optional(),
      replaced: OUT_HIT.optional(),
      replaces: z.array(z.string()).optional(),
    }),
  }, async (args) => {
    try {
      const memory = await readMemory(mapContext(), args.id);
      usefulness.readInFull(args.id);
      const index = await replacementIndex(mapContext());
      const replaced = index.replacedBy(args.id);
      const replaces = index.replaces(args.id);
      const labelled = labelMemoryText(memory);
      return jsonResult({
        ...labelled,
        memory: markStoredMemory(labelled.memory),
        ...(replaced ? { replaced } : {}),
        ...(replaces.length > 0 ? { replaces } : {}),
      });
    } catch (err) {
      return toolError(err);
    }
  });
}
