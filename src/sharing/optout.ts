import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { OPT_OUT_KIND, OPT_OUT_VIA, SHARING_PROTOCOL, validateOptOut } from './fields';
import { noticeRecorded } from './notice';
import { effectiveLevel, envOverride, readState, type ConsentRecord } from './state';

/**
 * The opt-out count (opt-out/1): when sharing is turned off, Renor is told once that one install turned it off, and nothing else. The
 * request carries no bearer, no install id, no session and no other identifier, and it is its own request, never part of a batch, so it
 * cannot be joined to anything sent before it. Under DO_NOT_TRACK=1 it is never sent (nor recorded as owed).
 *
 * It counts a change from on to off, never an install that was never on: `chooseLevel('off')` owes it only when a level above off was in
 * force, and RENOR_SHARING=off owes it only when the person had been told sharing was on (the first-run notice was recorded) and the level
 * without that variable is above off. The marker file (OPT_OUT_FILE) holds no identifier; it says only whether the count is owed or was sent,
 * so the same off is counted once. It is removed when sharing is on again, so a later off counts again.
 */

export const OPT_OUT_FILE = 'sharing-optout.json';
export type OptOutVia = (typeof OPT_OUT_VIA)[number];

interface Marker { version: 1; state: 'owed' | 'sent'; via: OptOutVia; day: string }

const doNotTrack = (env: NodeJS.ProcessEnv): boolean => (env.DO_NOT_TRACK ?? '').trim() === '1';

function readMarker(dir: string): Marker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, OPT_OUT_FILE), 'utf8')) as Partial<Marker>;
    if (raw.version !== 1 || (raw.state !== 'owed' && raw.state !== 'sent') || typeof raw.day !== 'string') return null;
    return { version: 1, state: raw.state, via: (OPT_OUT_VIA as readonly string[]).includes(String(raw.via)) ? raw.via as OptOutVia : 'other', day: raw.day };
  } catch {
    return null;
  }
}

function writeMarker(dir: string, marker: Marker): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${OPT_OUT_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  fs.renameSync(temp, path.join(dir, OPT_OUT_FILE));
}

/** Where a choice of off came from, as the count names it. */
export function viaOf(source: ConsentRecord['source']): OptOutVia {
  switch (source) {
    case 'cli': return 'command';
    case 'setup': return 'setup';
    case 'agent':
    case 'prompt': return 'agent';
    case 'dashboard': return 'dashboard';
    default: return 'other';
  }
}

/** Records that one opt-out count is owed. Nothing under DO_NOT_TRACK=1. Never throws. */
export function oweOptOut(dir: string, via: OptOutVia, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): void {
  if (doNotTrack(env)) return;
  try {
    writeMarker(dir, { version: 1, state: 'owed', via, day: new Date(now).toISOString().slice(0, 10) });
  } catch {
    // A count that cannot be recorded is not counted.
  }
}

/** The exact body of an opt-out request. */
export function optOutBody(marker: { via: OptOutVia; day: string }): { protocol: number; action: 'opt-out'; row: Record<string, unknown> } {
  return { protocol: SHARING_PROTOCOL, action: 'opt-out', row: { kind: OPT_OUT_KIND, day: marker.day, via: marker.via } };
}

/** The body that is owed for `dir` now, for debug and `telemetry preview`; null when nothing is owed. Reads only. */
export function pendingOptOut(dir: string, env: NodeJS.ProcessEnv = process.env): ReturnType<typeof optOutBody> | null {
  if (doNotTrack(env)) return null;
  const marker = readMarker(dir);
  return marker?.state === 'owed' ? optOutBody(marker) : null;
}

export type OptOutPost = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface SettleOptOutOptions {
  dir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: OptOutPost;
  now?: () => number;
  endpoint: () => string;
  debug?: boolean;
}

/**
 * Sends the count if one is owed, notices RENOR_SHARING=off turning sharing off, and forgets a sent count once sharing is on again. A
 * failure keeps it owed (silent; the next tick tries again). Returns what happened.
 */
export async function settleOptOut(options: SettleOptOutOptions): Promise<'sent' | 'owed' | 'none' | 'debug'> {
  const env = options.env ?? process.env;
  if (doNotTrack(env)) return 'none';
  const now = (options.now ?? Date.now)();
  let marker = readMarker(options.dir);
  let level;
  try {
    level = effectiveLevel(options.dir, env);
  } catch {
    return 'none';
  }
  if (level !== 'off') {
    // On again: a later off is a new one, and counts.
    if (marker !== null) fs.rmSync(path.join(options.dir, OPT_OUT_FILE), { force: true });
    return 'none';
  }
  if (marker === null && envOverride(env) === 'off') {
    let without;
    try {
      without = effectiveLevel(options.dir, { ...env, RENOR_SHARING: '' });
    } catch {
      without = 'off';
    }
    // Only an install that was really sharing: it was told (the notice) AND it sent rows. A harness that starts with RENOR_SHARING=off counts nothing.
    if (without !== 'off' && noticeRecorded(env) && readState(options.dir)?.everSent === true) {
      oweOptOut(options.dir, 'env', env, now);
      marker = readMarker(options.dir);
    }
  }
  if (marker?.state !== 'owed') return 'none';
  const body = optOutBody(marker);
  validateOptOut(body.row);
  if (options.debug === true) return 'debug';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const doFetch: OptOutPost = options.fetch ?? ((url, init) => fetch(url, init));
    const reply = await doFetch(options.endpoint(), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    });
    // Accepted, or refused for good (a malformed count is never sent twice). Rate limits and Renor's closed switch keep it owed.
    if ((reply.status >= 200 && reply.status < 300) || (reply.status >= 400 && reply.status < 500 && reply.status !== 403 && reply.status !== 429)) {
      writeMarker(options.dir, { ...marker, state: 'sent' });
      return 'sent';
    }
    return 'owed';
  } catch {
    return 'owed';
  } finally {
    clearTimeout(timer);
  }
}
