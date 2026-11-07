import { handoffNoteEnabled, HANDOFF_TOOL_NAME, HANDOFF_TOOL_DESCRIPTION, HANDOFF_ARG_DESCRIPTIONS, HANDOFF_MAX_CHARS, runHandoffTool } from '../../memory/handoff.js';
import * as z from 'zod';
import { OUT_HANDOFF } from '../outputSchemas.js';
import { omittedWhenBlank, agentOf, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers the handoff note tool (RENOR_HANDOFF_NOTE). */
export function registerHandoffTool(ctx: ToolContext): void {
  const { db, config, jsonResult, server } = ctx;
  // The handoff note (memory/handoff.ts): published only with RENOR_HANDOFF_NOTE on, so the default tool list is unchanged.
  if (handoffNoteEnabled()) server.registerTool(HANDOFF_TOOL_NAME, {
    title: 'Handoff note for this branch',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: HANDOFF_TOOL_DESCRIPTION,
    inputSchema: {
      action: z.enum(['read', 'write']).describe(HANDOFF_ARG_DESCRIPTIONS.action),
      repo: z.string().min(1).max(1000).describe(HANDOFF_ARG_DESCRIPTIONS.repo),
      branch: z.string().min(1).max(1000).describe(HANDOFF_ARG_DESCRIPTIONS.branch),
      note: omittedWhenBlank(z.string().max(HANDOFF_MAX_CHARS * 2).optional()).describe(HANDOFF_ARG_DESCRIPTIONS.note),
    },
    outputSchema: OUT_HANDOFF,
  }, async (args, extra) => {
    try {
      return jsonResult(await runHandoffTool(db, args, agentOf(extra, config)));
    } catch (err) {
      return toolError(err);
    }
  });
}
