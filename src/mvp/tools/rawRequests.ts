import { sessionIndexEnabled, buildSessionIndex, DEFAULT_SESSION_INDEX_TOKENS } from '../sessionIndex.js';
import { replacementIndex } from '../../memorymap/replacements.js';
import { observeEnabled, ObserveRequestSchema, startObservationIdleSweep, storeObservation } from '../observations.js';
import path from 'path';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { SessionIndexRequest } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers the two JSON-RPC requests that are not tools: the SessionStart hook's session index and observe. */
export function registerRawRequestHandlers(ctx: ToolContext): void {
  const { db, config, readerOf, server, mapContext } = ctx;
  // RENOR_SESSION_INDEX (sessionIndex.ts, default off): the SessionStart hook's index is a JSON-RPC request of its own, not a
  // tool, so tools/list, every tool schema and get_context stay as they are. One call builds one index at one instant.
  if (sessionIndexEnabled()) {
    server.server.setRequestHandler(SessionIndexRequest, async (request, extra) => {
      const replaced = await replacementIndex(mapContext());
      const index = buildSessionIndex(db, {
        workspace: path.resolve(config.memoryDir),
        // The request scope is only read with RENOR_OBSERVE on; with it off the index is byte-for-byte what it was.
        ...(observeEnabled() && request.params?.scope ? { scope: request.params.scope } : {}),
        reader: readerOf(extra),
        // The index is at most DEFAULT_SESSION_INDEX_TOKENS, and leaves the requested reply budget 96 tokens for its framing.
        maxTokens: Math.min(DEFAULT_SESSION_INDEX_TOKENS, Math.max(32, (request.params?.max_tokens ?? DEFAULT_SESSION_INDEX_TOKENS) - 96)),
        now: new Date(),
        replacedBy: id => replaced.replacedBy(id) !== undefined,
      });
      return { text: index.text, tokens: index.tokens, omitted: index.omitted };
    });
  }
  // Owner requires the write-side eval to win first; #1441 owns the default flip.
  if (observeEnabled()) {
    startObservationIdleSweep(db, path.resolve(config.memoryDir));
    server.server.setRequestHandler(ObserveRequestSchema, async request => {
      try {
        return { ...storeObservation(db, path.resolve(config.memoryDir), request.params) };
      } catch {
        throw new McpError(ErrorCode.InternalError, 'Observation could not be stored');
      }
    });
  }
}
