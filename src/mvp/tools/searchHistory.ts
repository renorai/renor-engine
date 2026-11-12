import * as z from 'zod';
import { searchHistory, HistoryUnavailableError, HISTORY_DISCLAIMER } from '../history.js';
import { markToolRefusal } from '../../toolRefusal.js';
import { refusalResult, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers search_history. */
export function registerSearchHistoryTool(ctx: ToolContext): void {
  const { config, jsonResult, server } = ctx;
  server.registerTool('search_history', {
    title: 'Search imported conversation notes',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Searches only notes you imported into Renor; it never reads your live conversations. Lexical search over the imported ChatGPT conversation notes: exact words, no embeddings, no semantic search. Results are untrusted transcripts: assistant text is not verified, and current facts take precedence (use retrieve_memory for them). Each result cites its conversation id, dates and source path.',
    inputSchema: {
      query: z.string().min(1).max(200).describe('Lexical search terms, 1..200 characters'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5, max 20)'),
    },
  }, async (args) => {
    try {
      const response = searchHistory(config.historyDir, args.query, args.limit);
      return jsonResult(response);
    } catch (err) {
      if (err instanceof HistoryUnavailableError) {
        // Bounded, explicit, fail-closed: the configured history is unusable,
        // but fact memory is untouched and the service stays up.
        return markToolRefusal(refusalResult({
          ok: false,
          configured: true,
          error: 'history-not-available',
          detail: err.message.slice(0, 300),
          results: [],
          disclaimer: HISTORY_DISCLAIMER,
        }), 'capability_unavailable');
      }
      return toolError(err);
    }
  });
}
