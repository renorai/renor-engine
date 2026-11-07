import * as z from 'zod';
import { retireMemory, restoreMemory } from '../../memorymap/memoryMap.js';
import { measureMarkdownBytes } from '../storedSize.js';
import { refusal } from '../../toolRefusal.js';
import { sourceOf, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers retire_memory and restore_memory. */
export function registerRetireMemoryTools(ctx: ToolContext): void {
  const { config, jsonResult, server, mapContext, retirableIdSchema, storageLimitOf } = ctx;
  server.registerTool('retire_memory', {
    title: 'Retire a memory (reversible)',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Takes one memory out of recall without deleting it: a note file moves to the retired area, a daily-log entry moves out of its file, a fact leaves every read, and all leave search immediately. Use only when the owner asks to forget something; the receipt of the save that wrote it, or memory_map with a query (words of that memory), gives its id. restore_memory undoes it. A wrong fact is corrected with remember, not retired; a wrong or outdated note is corrected with remember and replaces. Retiring a correction undoes its replaces: the memory it replaced reads as current again.',
    inputSchema: { id: retirableIdSchema },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      id: z.string(),
      action: z.enum(['retired', 'restored']),
      title: z.string(),
      at: z.string(),
      eventId: z.string().optional(),
      current: z.boolean().optional(),
    }),
  }, async (args, extra) => {
    try {
      return jsonResult(await retireMemory({ ...mapContext(), source: sourceOf(undefined, extra, config) }, args.id));
    } catch (err) {
      return toolError(err);
    }
  });

  server.registerTool('restore_memory', {
    title: 'Restore a retired memory',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Puts a retired memory back exactly as it was and re-indexes it. Refuses to overwrite a file that now occupies the same path.',
    inputSchema: { id: retirableIdSchema },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      id: z.string(),
      action: z.enum(['retired', 'restored']),
      title: z.string(),
      at: z.string(),
      eventId: z.string().optional(),
      current: z.boolean().optional(),
    }),
  }, async (args, extra) => {
    try {
      const storageLimit = storageLimitOf(extra?.requestInfo?.headers);
      return jsonResult(await restoreMemory(
        { ...mapContext(), source: sourceOf(undefined, extra, config) },
        args.id,
        storageLimit === undefined ? {} : { validateAfterWrite: async (addedBytes = 0) => {
          const bytes = await measureMarkdownBytes(config.memoryDir) + addedBytes;
          if (bytes > storageLimit) {
            throw refusal('storage_limit', `Renor: this write would need ${bytes.toLocaleString('en-US')} bytes of Markdown storage and would not fit; the storage limit is ${storageLimit.toLocaleString('en-US')} bytes. This memory write was not run.`);
          }
        } },
      ));
    } catch (err) {
      return toolError(err);
    }
  });
}
