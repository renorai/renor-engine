import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultInForce, defaultSharingDir, hostedEngine } from './state';

/**
 * The first-run notice: one plain line, shown once per install and recorded, on every surface where a person can read it.
 *
 * It is about the default only (usage numbers sent until the person says otherwise), so it is shown only while the default is what is
 * in force: not after any choice, not under DO_NOT_TRACK=1 or RENOR_SHARING=off, not on a hosted engine (the dashboard says its own).
 *
 * Two surfaces, each recorded on its own, because the person who starts the server is often not the person talking to the agent:
 *   terminal  a command of the CLI, or the server's start-up (`renor-engine ...`)
 *   agent     the first tool reply of an MCP session, which the agent relays to the user (mvp/server.ts)
 * `renor setup` shows it with its question and records both. The record is one small file in the install's folder
 * (defaultSharingDir), next to sharing.json; the `renor` CLI (cli/lib/sharing.mjs) writes the same file, and a test holds the two in step.
 */

export const NOTICE_FILE = 'sharing-notice.json';
/** The id of the words below. Change the words, change the id. */
export const NOTICE_WORDING_VERSION = 'engine-notice-2026-10-28';
export const TELEMETRY_DOC_URL = 'https://github.com/renorai/renor-engine/blob/main/docs/TELEMETRY.md';

export type NoticeSurface = 'terminal' | 'agent';

export const NOTICE_LINE =
  'Renor sends anonymous usage numbers (never text, names or paths) to improve its search. '
  + 'Turn them off any time: tell your agent, run `renor-engine telemetry off`, or set DO_NOT_TRACK=1. '
  + `Details: ${TELEMETRY_DOC_URL}`;

/** What the agent is told with the notice: relay it, and what to do if the user answers. */
export const AGENT_NOTICE_INSTRUCTION =
  'Tell the user this once, in your own short words, before anything else: '
  + `"${NOTICE_LINE}" `
  + 'If they want it off, or want to also share their memory text to help train Renor, use the sharing tool.';

interface NoticeRecord {
  version: 1;
  wording: string;
  terminal?: string;
  agent?: string;
  /** `renor setup` asked its question and the answer was No: it is not asked again, and No writes no consent record. */
  asked?: string;
}

const noticePath = (env: NodeJS.ProcessEnv): string => path.join(defaultSharingDir(env), NOTICE_FILE);

export function readNotice(env: NodeJS.ProcessEnv = process.env): NoticeRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(noticePath(env), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.version !== 1) return null;
    const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
    return {
      version: 1,
      wording: text(record.wording) ?? NOTICE_WORDING_VERSION,
      ...(text(record.terminal) ? { terminal: text(record.terminal) } : {}),
      ...(text(record.agent) ? { agent: text(record.agent) } : {}),
      ...(text(record.asked) ? { asked: text(record.asked) } : {}),
    };
  } catch {
    return null;
  }
}

function writeNotice(env: NodeJS.ProcessEnv, record: NoticeRecord): void {
  const dir = defaultSharingDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${NOTICE_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, noticePath(env));
}

/** Whether `surface` has a notice to show: the default is in force for `dir` and this surface has not shown it yet. */
export function noticePending(dir: string, surface: NoticeSurface, env: NodeJS.ProcessEnv = process.env): boolean {
  if (hostedEngine(env)) return false;
  if (!defaultInForce(dir, env)) return false;
  return readNotice(env)?.[surface] === undefined;
}

/**
 * Shows the notice on `surface` if it is due: `print` is called with the line first, and only when it returns is the notice recorded as
 * shown, so a surface that could not print it never counts as having told anyone. Returns whether it was shown and recorded. When the record
 * cannot be written after printing, the notice is told again next time and nothing is sent in the meantime (noticeRecorded stays false).
 */
export function showNotice(dir: string, surface: NoticeSurface, print: (line: string) => void, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): boolean {
  if (!noticePending(dir, surface, env)) return false;
  try {
    print(NOTICE_LINE);
  } catch {
    return false;
  }
  try {
    const previous = readNotice(env);
    writeNotice(env, { ...(previous ?? { version: 1 as const }), version: 1, wording: NOTICE_WORDING_VERSION, [surface]: new Date(now()).toISOString() });
  } catch {
    return false;
  }
  return true;
}

/**
 * Whether someone has been told: the notice was shown on a surface, or `renor setup` showed it with its question. The sender sends nothing
 * under the default until this is true (send.ts), so an engine nobody has talked to, a daemon or an idle service sends nothing.
 */
export function noticeRecorded(env: NodeJS.ProcessEnv = process.env): boolean {
  const record = readNotice(env);
  return record !== null && (record.terminal !== undefined || record.agent !== undefined || record.asked !== undefined);
}
