import * as z from 'zod';
import { OUT_HIT } from '../outputSchemas.js';
import { engineLookupEntity } from '../engine.js';
import { markImportedOrigin, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers lookup_entity. */
export function registerLookupEntityTool(ctx: ToolContext): void {
  const { db, config, jsonResult, server } = ctx;
  server.registerTool('lookup_entity', {
    title: 'Look up an entity',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Find a person/project/concept by name or alias, without embeddings. Matches in order: exact canonical name, frontmatter alias, substring of a canonical name, substring of a source note path — never words inside note text, so a word only inside a saved note is not an entity. A miss returns reason "no-entity-match", the entity count and the tool that would find the word. With scope, the search and the count are restricted to it, so "no such entity" and "exists in another scope" answer the same. An imported note\'s entity carries origin: "import".',
    inputSchema: {
      name: z.string().min(1).max(200).describe('Entity name or alias'),
      scope: z.string().optional().describe('Memory scope: "global" (default) or scope:<slug> / project:<slug>; restricts to entities whose source note belongs to the scope'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      entity: z.union([OUT_HIT, z.null()]).optional(),
      reason: z.string().optional(),
      searched: z.string().optional(),
      entitiesIndexed: z.number().optional(),
      note: z.string().optional(),
      scope: z.string().optional(),
    }),
  }, async (args) => {
    try {
      const body = engineLookupEntity(db, config, args.name, args.scope);
      // The entity of an imported note says so, as every read of that note does.
      return jsonResult(body.entity ? { ...body, entity: markImportedOrigin(body.entity, 'sourceNote') } : body);
    } catch (err) {
      return toolError(err);
    }
  });
}
