import { importPreviewSchema, previewImport, importBatchSchema, applyHostedImport, undoHostedImport } from '../../importing/hosted.js';
import * as z from 'zod';
import { OUT_HIT } from '../outputSchemas.js';
import { engineRebuildEmbeddings } from '../engine.js';
import { toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers preview_import, apply_import and undo_import. */
export function registerImportTools(ctx: ToolContext): void {
  const { db, engine, digests, jsonResult, server, mapContext, storageLimitOf } = ctx;
  server.registerTool('preview_import', {
    title: 'Preview a Markdown vault batch',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Dry run for an agent-led import of notes into Imported/<label>/. The server cannot read your disk: read each file yourself and send its text as files: [{ relativePath, markdown }], relativePath being the path inside the folder you import (notes/idea.md: / separators, no leading / or ./ or ..). Only .md files: save a ChatGPT or Claude memory list, JSON or other text as Markdown first and leave attachments out. Names starting with "." are skipped. Returns counts, conflicts (a different file already at the destination is kept, not overwritten; use a new label to import a changed copy), skipped files with reasons, and an expiring batchId; writes no memory. Max 100 files, 64 KiB/file and 128 KiB per call including paths; for more, call again per group. Up to 8 previews can wait at once: apply one, or wait 15 minutes. Refuses unsafe or oversize inputs. Selection: include/exclude path prefixes. stage: false only checks (no batchId, nothing held). Show preview before apply_import.',
    inputSchema: importPreviewSchema,
    outputSchema: z.looseObject({
      ok: z.boolean(),
      namespace: z.string(),
      counts: z.record(z.string(), z.unknown()),
      conflicts: z.array(z.string()),
      unchanged: z.number(),
      toWrite: z.number(),
      skipped: z.array(OUT_HIT),
      limits: OUT_HIT,
      staged: z.boolean().optional(),
      batchId: z.string().optional(),
      expiresAt: z.string().optional(),
      secretGuard: OUT_HIT.optional(),
      unchangedPaths: z.array(z.string()).optional(),
    }),
  }, async (args) => {
    try { return jsonResult(await previewImport(mapContext(), args)); }
    catch (err) { return toolError(err); }
  });

  server.registerTool('apply_import', {
    title: 'Apply a previewed Markdown batch',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Apply preview_import batchId within 15 minutes (same tenant process). Additive: preserves existing different files and reports conflicts. Immediately keyword searchable; on a workspace with semantic search the new notes are then embedded in the background (memory_status says semantic: false until they are). No fact extraction. Returns batchId for undo_import; retries are idempotent.',
    inputSchema: importBatchSchema,
    outputSchema: z.looseObject({
      ok: z.boolean(),
      batchId: z.string(),
      namespace: z.string().optional(),
      notesWritten: z.number().optional(),
      notesUnchanged: z.number().optional(),
      notesConflicting: z.number().optional(),
      conflicts: z.array(z.string()).optional(),
      eventsAppended: z.number().optional(),
      eventsAlreadyPresent: z.number().optional(),
      ledgerReplayed: z.number().optional(),
      indexRows: OUT_HIT.optional(),
      destination: z.union([OUT_HIT, z.null()]).optional(),
      recall: z.string().optional(),
    }),
  }, async ({ batchId }, extra) => {
    try { return jsonResult(await applyHostedImport(mapContext(), batchId, storageLimitOf(extra?.requestInfo?.headers))); }
    catch (err) { return toolError(err); }
    // The import wrote its chunks without vectors and marked the index unfinished (so does a run that failed after its
    // commit): the background job embeds them, once, now. It returns null when there is nothing to embed.
    finally {
      // Digests are written for the imported notes once the index holds them whole (a note is listed only when finished).
      const rebuilding = engineRebuildEmbeddings(db, engine);
      if (digests) void (rebuilding?.done ?? Promise.resolve()).then(() => digests.worker.notify());
    }
  });
  server.registerTool('undo_import', {
    title: 'Undo one vault import batch',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Undo this batch\'s claim on imported notes. A created note stays live while a later batch still asserts the same bytes; undoing the last such batch retires it. Preserves pre-existing files, conflicts and later edits; reports preserved paths and the re-assertion reason. Uses existing retirement journal and trash. Batch receipts persist across restarts and are tenant-local.',
    inputSchema: importBatchSchema,
    outputSchema: z.looseObject({
      ok: z.boolean(),
      batchId: z.string(),
      retired: z.number().optional(),
      preserved: z.array(z.string()).optional(),
      preservedReasons: z.record(z.string(), z.string()).optional(),
      alreadyUndone: z.boolean().optional(),
    }),
  }, async ({ batchId }) => {
    try { return jsonResult(await undoHostedImport(mapContext(), batchId)); }
    catch (err) { return toolError(err); }
  });
}
