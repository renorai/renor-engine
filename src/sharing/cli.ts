import fs from 'node:fs';
import { learningDbPath, learningRetentionDays } from '../learning/settings';
import { LearningLog } from '../learning/store';
import { fieldsAtLevel } from './fields';
import {
  chooseLevel, debugOn, deleteAllShared, settlePendingDelete, shareNow, sharingEndpoint, type Post,
} from './send';
import { consentFor, defaultInForce, defaultLevel, effectiveLevel, envOverride, foreignConsent, hasChosen, hostedEngine, readConsent, readState, sharingDirFor } from './state';
import { ADULT_LINE, CLI_WORDING_VERSION, defaultWording, wordingFor } from './wording';

/**
 * `renor-engine telemetry <status | signals | data | off | delete | preview | send | fields>`: the user's choice to share.
 *
 *   status          the choice in force, who set it, what is held, where it would go (reads only; makes no file)
 *   signals | data  show the words, ask for a yes and that you are 18 or older (or --yes), record the choice
 *   off             record off, stop recording at once, and ask Renor to delete what it holds
 *   delete          ask Renor to delete what it holds, and remove the local sharing files (--local: the learning log too)
 *   preview [level] debug mode: print exactly what would be sent now (or at a level you have not chosen yet), send nothing, change nothing
 *   send            share what is final and unsent now (the service does this on a timer)
 *   fields [level]  every field sent at each level
 *
 * The folder holding the choice: --dir, else RENOR_SHARING_DIR, else <memory folder>/.memory-index/sharing when MVP_MEMORY_DIR (or
 * --memory-dir) names the memory folder, else ~/.config/renor. The learning log it reads is in the memory folder.
 */

export interface TelemetryIo {
  out(line: string): void;
  err(line: string): void;
  /** Asks a yes/no question at a terminal; resolves null when there is no terminal. */
  ask(question: string): Promise<boolean | null>;
  env: NodeJS.ProcessEnv;
  fetch?: Post;
  now?: () => number;
}

export interface TelemetryOptions {
  yes?: boolean;
  local?: boolean;
  dir?: string;
  memoryDir?: string;
}

export const TELEMETRY_ACTIONS = ['status', 'signals', 'data', 'off', 'delete', 'preview', 'send', 'fields'] as const;

function memoryDirOf(options: TelemetryOptions, env: NodeJS.ProcessEnv): string | null {
  const value = (options.memoryDir ?? env.MVP_MEMORY_DIR ?? '').trim();
  return value === '' ? null : value;
}

/** Returns the exit code. Throws nothing the user needs to read: problems are printed on `err`. */
export async function runTelemetry(action: string, argument: string | undefined, options: TelemetryOptions, io: TelemetryIo): Promise<number> {
  const env = io.env;
  const memoryDir = memoryDirOf(options, env);
  const dir = sharingDirFor(memoryDir, env, options.dir);
  // Hosted or not as the service decides it, so send, off and delete reach the endpoint the way the service's sender does.
  const common = { dir, env, fetch: io.fetch, now: io.now, hosted: hostedEngine(env) };
  try {
    switch (action) {
      case 'status': {
        const own = readConsent(dir, env);
        // This folder's record, else the install's answer (`renor setup`) that a folder with no record of its own follows.
        const record = consentFor(dir, env);
        const state = readState(dir);
        const override = envOverride(env);
        const level = effectiveLevel(dir, env);
        const fallback = defaultLevel(env);
        const byDefault = defaultInForce(dir, env);
        io.out(`sharing: ${level}${override !== null && level !== (record?.level ?? fallback) ? ` (lowered by the environment from ${record?.level ?? fallback})` : ''}${byDefault ? ' (the default: you have not chosen)' : ''}`);
        if (record === null && hasChosen(dir, env)) io.out('choice: a record is there but cannot be read, so it counts as off');
        else if (record === null && foreignConsent(dir, env)) io.out('choice: a record is there, but it was made on another install (copied or synced in), so it counts as no choice here');
        else if (record === null && fallback === 'off') io.out('choice: none made (the default is off; nothing is recorded for sharing or sent)');
        else if (record === null) {
          io.out('choice: none made (the default is usage numbers, on until you turn them off)');
          io.out(defaultWording());
        } else {
          io.out(`choice: ${record.level}, chosen ${record.changedAt} via ${record.source}, wording ${record.wording}, 18 or older: ${record.adult ? 'yes' : 'no'}${own === null ? ' (this install\'s answer at `renor setup`, which this memory folder follows)' : ''}`);
        }
        io.out(`folder: ${dir}`);
        io.out(`endpoint: ${sharingEndpoint(env)}`);
        if (state?.paused?.code === 'sharing_closed') io.out('sending: paused, Renor has closed sharing; nothing is sent until it is open again');
        else if (state?.paused?.code === 'consent_required') io.out('sending: paused, Renor refused the consent record; choose a level again to resume');
        io.out(`debug mode: ${debugOn(env) ? 'on (RENOR_SHARING_DEBUG): nothing is sent, bodies are printed' : 'off'}`);
        if (memoryDir === null) io.out('learning log: not found (set MVP_MEMORY_DIR or pass --memory-dir; sharing sends rows made from it)');
        else {
          const file = learningDbPath(memoryDir);
          if (!fs.existsSync(file)) io.out(`learning log: none at ${file}`);
          else {
            const log = LearningLog.open(file, { retentionDays: learningRetentionDays(env), rawQueries: false, create: false });
            try {
              io.out(`learning log: ${file}`);
              if (log) io.out(`  rows inside the retention window: ${JSON.stringify(log.counts())}`);
            } finally {
              log?.close();
            }
          }
        }
        if (state) {
          io.out(`sent before: ${state.everSent ? 'yes' : 'no'}${state.deletePending ? '; a deletion is owed to the endpoint and will be retried' : ''}`);
        }
        return 0;
      }
      case 'fields': {
        const wanted = argument === undefined ? ['signals', 'data'] : [argument];
        for (const level of wanted) {
          if (level !== 'signals' && level !== 'data') {
            io.err('usage: renor-engine telemetry fields [signals|data]');
            return 2;
          }
          io.out(`# fields sent at level ${level}`);
          for (const field of fieldsAtLevel(level)) io.out(field);
        }
        return 0;
      }
      case 'signals':
      case 'data': {
        const level = action;
        io.out(wordingFor(level));
        io.out('');
        if (options.yes !== true) {
          const answer = await io.ask(`${ADULT_LINE} Share at this level? [y/N] `);
          if (answer === null) {
            io.err('No terminal to ask on: nothing was changed. Run it in a terminal, or add --yes if you have read the words above.');
            return 1;
          }
          if (!answer) {
            io.out('Nothing was changed.');
            return 0;
          }
        }
        const result = await chooseLevel({ ...common, level, wording: CLI_WORDING_VERSION, adult: true, source: 'cli' });
        io.out(result.changed ? `Sharing is now: ${level}. Recorded ${result.record?.changedAt}.` : `Sharing was already: ${level}.`);
        if (memoryDir === null) io.out('Note: no learning log folder is set (MVP_MEMORY_DIR), so there is nothing to share yet.');
        return 0;
      }
      case 'off': {
        const result = await chooseLevel({ ...common, level: 'off', wording: CLI_WORDING_VERSION, adult: true, source: 'cli' });
        if (!result.changed) io.out('Sharing was already off.');
        else io.out('Sharing is now: off. Recording for sharing has stopped.');
        io.out('Off is recorded as your choice, so a later change of the default does not turn it back on.');
        if (result.remoteDeleted === true) io.out('Renor was asked to delete what it holds, and has.');
        else if (result.deleteOwedUnderDoNotTrack) io.out('DO_NOT_TRACK=1 forbids any request, so Renor has not been asked yet to delete what it holds. The deletion is recorded here and sent the first time the engine runs without DO_NOT_TRACK=1.');
        else if (result.remoteDeleted === false) io.out(`Renor could not be reached to delete what it holds (${result.reason ?? 'unknown'}). The deletion is kept and retried when the service next runs.`);
        return result.remoteDeleted === false ? 1 : 0;
      }
      case 'delete': {
        const result = await deleteAllShared(common);
        if (!result.remote.ok) {
          io.err(result.remote.owedUnderDoNotTrack
            ? 'DO_NOT_TRACK=1 forbids any request, so Renor has not been asked yet to delete what it holds; nothing was removed here. The deletion is recorded and sent the first time the engine runs without DO_NOT_TRACK=1.'
            : `Renor could not be reached (${result.remote.reason ?? 'unknown'}); nothing was removed here, and the deletion is kept to retry.`);
          return 1;
        }
        io.out(result.remote.requested ? 'Renor deleted what it held for this install.' : 'Nothing had ever been sent, so Renor holds nothing.');
        io.out('The local sharing files (state, saved example texts) were removed. Your choice is unchanged.');
        if (options.local) {
          if (memoryDir === null) {
            io.err('--local needs MVP_MEMORY_DIR or --memory-dir: the learning log was not touched.');
            return 1;
          }
          const file = learningDbPath(memoryDir);
          const log = fs.existsSync(file) ? LearningLog.open(file, { retentionDays: learningRetentionDays(env), rawQueries: false, create: false }) : null;
          if (log) {
            try {
              log.deleteAll();
            } finally {
              log.close();
            }
            io.out('The local learning log was emptied.');
          } else io.out('There was no local learning log.');
        }
        return 0;
      }
      case 'preview':
      case 'send': {
        if (action === 'preview' && argument !== undefined && argument !== 'signals' && argument !== 'data') {
          io.err('usage: renor-engine telemetry preview [signals|data]');
          return 2;
        }
        const result = await shareNow({
          ...common, memoryDir, debug: action === 'preview' ? true : undefined,
          previewLevel: action === 'preview' && (argument === 'signals' || argument === 'data') ? argument : undefined,
        });
        if (action === 'send') await settlePendingDelete(common);
        if (result.status === 'debug') {
          io.out(`# debug: nothing was sent and nothing was changed. These ${result.batches} request body(ies) are exactly what would be sent to ${sharingEndpoint(env)}:`);
          for (const payload of result.payloads ?? []) io.out(JSON.stringify(payload, null, 2));
        } else {
          io.out(`status: ${result.status}; level: ${result.level}; rows: ${result.rows}; batches: ${result.batches}${result.skipped ? `; skipped (failed their own contract): ${result.skipped}` : ''}${result.reason ? `; ${result.reason}` : ''}`);
        }
        return result.status === 'failed' ? 1 : 0;
      }
      default:
        io.err(`usage: renor-engine telemetry <${TELEMETRY_ACTIONS.join(' | ')}>`);
        return 2;
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
