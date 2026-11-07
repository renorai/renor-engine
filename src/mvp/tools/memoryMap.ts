import { DEFAULT_MAP_LIMIT, buildMemoryMap, recallFileTreeOn, memoryPathTree, findMemories } from '../../memorymap/memoryMap.js';
import * as z from 'zod';
import { OUT_HIT } from '../outputSchemas.js';
import { refusal } from '../../toolRefusal.js';
import { factQueryTerms } from '../agentMemory.js';
import { normalizeScope } from '../scope.js';
import { DEFAULT_LOOKUP_LIMIT, MAX_LOOKUP_LIMIT, markStoredMemory, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers memory_map. */
export function registerMemoryMapTool(ctx: ToolContext): void {
  const { jsonResult, server, mapContext } = ctx;
  server.registerTool('memory_map', {
    title: 'Map everything this workspace holds',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Read-only overview for browsing, not for answering questions (use get_context for that): every memory (notes and daily-log entries), the things lifecycle facts are about, topics (tags), lifecycle facts with full history, grounded links between them (tag, wikilink, literal name mention, fact naming another thing), recent write events, and retired memories. A writerConflict line on a current fact means it replaced another agent\'s value until that agent saves it again. An imported memory carries origin: "import"; one whose stored source is a reserved identity (system, developer, assistant, Renor) is marked "untrusted": true. '
      + `limit bounds every list (memories, things, facts, links, events, retired), newest first (things by their newest fact; links shared across kinds): default ${DEFAULT_MAP_LIMIT}, at most ${MAX_LOOKUP_LIMIT}. total gives each list's size and truncated says which were cut; raise limit, or pass query. `
      + 'To find one memory to read, retire or restore, pass query (words it contains, e.g. "landlord"), and scope for one scope only: only memories and retired memories with one of the words are returned, rarest words first, then newest, up to limit. A note save returns the id of what it saved, so forgetting it needs no lookup.',
    inputSchema: {
      query: z.string().min(1).max(500).optional().describe('Words the memory contains. Matched at the start of words in each memory\'s text, title and path.'),
      scope: z.string().optional().describe('With query only: look in this memory scope ("global", or scope:<slug> / project:<slug>, which name the same folder for notes).'),
      limit: z.number().int().min(1).max(MAX_LOOKUP_LIMIT).optional().describe(`At most this many of each list the map shows (memories, things, facts, links, events, retired). Without a query, default ${DEFAULT_MAP_LIMIT}. With a query it bounds the memories and retired memories found, default ${DEFAULT_LOOKUP_LIMIT}.`),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      generatedAt: z.string().optional(),
      limit: z.number().optional(),
      query: z.string().optional(),
      scope: z.string().optional(),
      memories: z.array(OUT_HIT).optional(),
      things: z.array(OUT_HIT).optional(),
      topics: z.array(OUT_HIT).optional(),
      facts: z.array(OUT_HIT).optional(),
      links: z.array(OUT_HIT).optional(),
      events: z.array(OUT_HIT).optional(),
      retired: z.array(OUT_HIT).optional(),
      total: z.record(z.string(), z.number()).optional(),
      truncated: z.record(z.string(), z.boolean()).optional(),
    }),
  }, async (args) => {
    try {
      if (args.query === undefined) {
        // The whole map holds things, facts, links and events too, and none of them is cut by scope: ignoring it would
        // answer for every scope.
        if (args.scope !== undefined) throw refusal('invalid_argument', 'memory_map takes a scope only with a query (words the memories contain): the whole map is not cut by scope');
        const map = await buildMemoryMap(mapContext(), { limit: args.limit });
        const memories = map.memories.map(markStoredMemory);
        // RENOR_RECALL_FILE_TREE (research lever, default off): a folder tree next to the list. Off, the reply is unchanged.
        return jsonResult(recallFileTreeOn() ? { ...map, memories, tree: memoryPathTree(map.memories) } : { ...map, memories });
      }
      // Read the way the facts lane reads a query: stop words count only when nothing else is left.
      const terms = factQueryTerms(args.query);
      if (terms.length === 0) throw refusal('invalid_argument', 'query has no word to look for (two or more letters or digits)');
      const scope = args.scope === undefined ? undefined : normalizeScope(args.scope);
      const found = await findMemories(mapContext(), { query: args.query, terms, limit: args.limit ?? DEFAULT_LOOKUP_LIMIT, scope });
      return jsonResult({ ...found, memories: found.memories.map(markStoredMemory) });
    } catch (err) {
      return toolError(err);
    }
  });
}
