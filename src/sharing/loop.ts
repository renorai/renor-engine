import { showNotice } from './notice';
import { defaultSharingDir, effectiveLevel, installLimit, readConsent } from './state';
import { chooseLevel, settlePendingDelete, shareNow, type SenderOptions } from './send';

/**
 * The install said off (`renor setup` answered No, or `renor-engine telemetry off` without a memory folder) while this workspace's
 * own record is still on: turn the workspace off the way its own off does, which stops collection, deletes the example texts and
 * owes the deletion of what was sent. effectiveLevel already reads it as off; this makes the workspace's record say so too.
 */
export async function applyInstallOff(options: SenderOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  if (installLimit(options.dir, env) !== 'off') return false;
  const own = readConsent(options.dir, env);
  if (own === null || own.level === 'off') return false;
  const install = readConsent(defaultSharingDir(env), env);
  await chooseLevel({
    dir: options.dir, level: 'off', wording: install?.wording ?? 'install-off', adult: own.adult, source: install?.source ?? 'setup',
    env, fetch: options.fetch, hosted: options.hosted,
  });
  return true;
}

/**
 * The service's sender: every `intervalMs` it asks the sender to share what is final and unsent. At level off a tick reads
 * one small file and does nothing else. The timer never keeps the process alive and a failed tick is dropped (the rows are
 * still unsent, so the next tick tries again).
 */

export const DEFAULT_SHARE_INTERVAL_MS = 60 * 60_000;
export const MIN_SHARE_INTERVAL_MS = 60_000;

export function shareIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RENOR_SHARING_INTERVAL_MIN ?? '').trim();
  if (raw === '') return DEFAULT_SHARE_INTERVAL_MS;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error('RENOR_SHARING_INTERVAL_MIN must be a whole number of minutes between 1 and 1440');
  }
  return minutes * 60_000;
}

export interface SharingLoop {
  stop(): void;
  /** One tick now, for tests and for a manual run. */
  tick(): Promise<void>;
}

export function startSharingLoop(options: SenderOptions & { intervalMs?: number; firstTickMs?: number; log?: (line: string) => void }): SharingLoop {
  const env = options.env ?? process.env;
  const intervalMs = options.intervalMs ?? shareIntervalMs(env);
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      if (await applyInstallOff(options)) options.log?.('[sharing] off: this install chose not to share, so this workspace was turned off');
      await settlePendingDelete(options);
      if (effectiveLevel(options.dir, env) === 'off') return;
      const result = await shareNow(options);
      if (result.status === 'sent') options.log?.(`[sharing] sent ${result.rows} row(s) at level ${result.level}`);
      else if (result.status === 'failed') options.log?.(`[sharing] not sent: ${result.reason ?? 'unknown'}; will retry`);
      else if (result.status === 'paused' || result.status === 'stopped') options.log?.(`[sharing] not sent: ${result.reason ?? 'unknown'}`);
    } catch (err) {
      options.log?.(`[sharing] tick failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  // A tenant that sleeps when idle is woken by use, so the first tick runs soon after start instead of waiting a whole interval.
  const first = setTimeout(() => void tick(), options.firstTickMs ?? 30_000);
  first.unref();
  return { stop: () => { clearInterval(timer); clearTimeout(first); }, tick };
}

/**
 * The service's start-up for sharing: tell the person first, then start the sender. `print` shows the first-run notice (when it is due),
 * and the sender is started only after that call has returned, so no tick can come before the notice was printed. The notice is recorded
 * after it printed; if it could not be printed or recorded, the sender still starts but sends nothing under the default (send.ts asks
 * noticeRecorded), and an explicit choice is not held up by it.
 */
export function startSharingService(options: SenderOptions & { print: (line: string) => void; intervalMs?: number; firstTickMs?: number; log?: (line: string) => void }): SharingLoop {
  const { print, ...sender } = options;
  showNotice(sender.dir, 'terminal', print, sender.env ?? process.env);
  return startSharingLoop(sender);
}
