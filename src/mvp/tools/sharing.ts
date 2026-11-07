import * as z from 'zod';
import { SHARING_LEVELS } from '../../sharing/fields.js';
import { refusal } from '../../toolRefusal.js';
import { chooseLevel, deleteAllShared } from '../../sharing/send.js';
import { readConsent, contributorId, trainingBearer, ensureState, effectiveLevel, defaultInForce, readState } from '../../sharing/state.js';
import { SHARING_TOOL_DESCRIPTION, AGENT_LEVELS, type AskHuman, runSharingTool } from '../../sharing/agentTool.js';
import { isDashboardCall, registeredToolEntry, toolError } from './shared.js';
import type { ToolContext } from './setup.js';

/** Registers sharing_settings (owner-only, dashboard) and sharing_level (the user's agent). */
export function registerSharingTools(ctx: ToolContext): void {
  const { config, dashboard, jsonResult, server } = ctx;
  // Only for the owner, from the dashboard: the workspace's choice to share learning data with Renor (src/sharing). The consent
  // record the owner's click writes in the control plane (set_learning_consent) is the proof; THIS is what the tenant obeys, so the
  // dashboard calls it right after the record is written, and recording and sending start or stop on the next call. It guards
  // itself exactly as delete_retired_memory does, and for an agent it is neither listed nor callable.
  server.registerTool('sharing_settings', {
    title: 'Learning-data sharing choice (owner only)',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: 'Reads, sets or deletes this workspace\'s choice to share learning data with Renor. action "get" returns the choice; "set" needs level (off, signals or data) and, for signals or data, adult: true and the notice_version the owner saw; "delete" asks Renor to delete what it holds for this workspace and removes the local sharing files. Off is the default.',
    inputSchema: {
      action: z.enum(['get', 'set', 'delete']).describe('get, set or delete'),
      level: z.enum(SHARING_LEVELS).optional().describe('With set: off, signals or data'),
      notice_version: z.string().min(1).max(80).optional().describe('With set: the id of the words the owner saw'),
      adult: z.boolean().optional().describe('With set to signals or data: the owner confirmed they are 18 or older'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      action: z.enum(['get', 'set', 'delete']),
      level: z.enum(SHARING_LEVELS),
      effective: z.enum(SHARING_LEVELS),
      byDefault: z.boolean(),
      changedAt: z.string().nullable(),
      noticeVersion: z.string().nullable(),
      remoteDeleted: z.boolean().nullable(),
      trainingContributorId: z.string().nullable(),
      trainingUnmapped: z.boolean(),
    }),
  }, async (args, extra) => {
    try {
      if (!isDashboardCall(extra?.requestInfo?.headers, config)) {
        throw refusal('invalid_argument', 'sharing_settings is only available to the owner, from the Renor dashboard');
      }
      const dir = config.sharingDir;
      if (dir === undefined) throw refusal('invalid_argument', 'sharing is not configured on this server');
      let remoteDeleted: boolean | null = null;
      if (args.action === 'set') {
        if (args.level === undefined) throw refusal('invalid_argument', 'set needs level');
        if (args.level !== 'off' && (args.adult !== true || args.notice_version === undefined)) {
          throw refusal('invalid_argument', 'sharing signals or data needs adult: true and the notice_version the owner saw');
        }
        const result = await chooseLevel({
          dir, level: args.level, wording: args.notice_version ?? 'dashboard', adult: args.adult === true, source: 'dashboard', hosted: true,
        });
        remoteDeleted = result.remoteDeleted;
      } else if (args.action === 'delete') {
        const result = await deleteAllShared({ dir, hosted: true });
        remoteDeleted = result.remote.requested ? result.remote.ok : null;
      }
      const record = readConsent(dir);
      // The name the control plane ties to this workspace, so the endpoint can check the owner's switch before it stores a row of text for
      // training. It names the TRAINING contributor only, and only while the text switch is on: the usage numbers go out under another id
      // that is never told to the platform and never tied to a workspace.
      const training = record !== null && record.level === 'data' && record.adult;
      return jsonResult({
        ok: true,
        action: args.action,
        trainingContributorId: training ? contributorId(trainingBearer(ensureState(dir).secret)) : null,
        // True while the endpoint refused the training id as unmapped: the platform ties it again (memory-inventory) when it sees this.
        trainingUnmapped: training && readState(dir)?.trainingUnmappedAt !== undefined,
        // An earlier explicit Off that the text switch was toggled on and off over reads as `signals` (the switch off), as the platform's record says;
        // the engine keeps the numbers off (ConsentRecord.numbersOff).
        level: record?.numbersOff === true && record.level === 'off' ? 'signals' : (record?.level ?? 'off'),
        effective: effectiveLevel(dir),
        // True while nobody has chosen and the default is what is in force (src/sharing/state.ts defaultInForce).
        byDefault: defaultInForce(dir),
        changedAt: record?.changedAt ?? null,
        noticeVersion: record?.wording ?? null,
        remoteDeleted,
      });
    } catch (err) {
      return toolError(err);
    }
  });
  if (!dashboard) registeredToolEntry(server, 'sharing_settings').enabled = false;

  // For the user's agent: read or LOWER what this Renor shares with Renor, when the user asks in plain words (src/sharing/agentTool.ts).
  // It never raises: that needs the user's own yes. Back to anonymous numbers the engine asks for through the user's client (elicitation) when it can;
  // the memory text is only ever a terminal's yes, because a client application can answer a question without the user.
  server.registerTool('sharing_level', {
    title: 'What Renor shares to improve (off, anonymous, everything)',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: SHARING_TOOL_DESCRIPTION,
    inputSchema: {
      action: z.enum(['get', 'set']).describe('get: what is shared now. set: change it, only when the user asks'),
      level: z.enum(AGENT_LEVELS).optional().describe('With set: off, anonymous or everything. Going up is the user\'s own yes, never yours: asked by the engine for anonymous, at a terminal for everything'),
    },
    outputSchema: z.looseObject({
      ok: z.boolean(),
      action: z.enum(['get', 'set']),
      level: z.enum(AGENT_LEVELS),
      byDefault: z.boolean(),
      chosen: z.enum(AGENT_LEVELS).nullable(),
      changedAt: z.string().nullable(),
      loweredByEnvironment: z.boolean(),
      hosted: z.boolean(),
      changed: z.boolean().optional(),
      remoteDeleted: z.boolean().nullable().optional(),
      message: z.string().optional(),
    }),
  }, async (args, extra) => {
    try {
      const dir = config.sharingDir;
      if (dir === undefined) throw refusal('invalid_argument', 'sharing is not configured on this server');
      // The question goes to the user through their own client. A client that did not declare elicitation, or a server that has no session to
      // ask over (the stateless default), answers null: the tool then changes nothing and names the terminal command.
      const ask: AskHuman = async ({ message }) => {
        if (server.server.getClientCapabilities()?.elicitation === undefined) return null;
        const reply = await server.server.elicitInput({
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              agree: { type: 'boolean', title: 'Yes, share', description: 'Yes, I want this' },
              adult: { type: 'boolean', title: 'I am 18 or older', description: 'I am 18 or older and I choose this myself' },
            },
            required: ['agree', 'adult'],
          },
        }, { relatedRequestId: extra.requestId });
        if (reply.action !== 'accept') return { agreed: false, adult: false };
        const info = server.server.getClientVersion();
        const client = info !== undefined ? { name: String(info.name).slice(0, 80), version: String(info.version).slice(0, 40) } : undefined;
        return { agreed: reply.content?.agree === true, adult: reply.content?.adult === true, ...(client !== undefined ? { client } : {}) };
      };
      return jsonResult(await runSharingTool(args, { dir, hosted: Boolean(config.gatewaySecret), ask }));
    } catch (err) {
      return toolError(err);
    }
  });
}
