import crypto from 'crypto';
import fs from 'fs';

/**
 * One journal line when an engine stops, so memory caps can be sized from use rather than guessed:
 * a stable hash of the unit name, the cgroup's `memory.peak` and how long the engine ran.
 * Measuring only: nothing here changes a cap, an admission or an exit. A missing or unreadable
 * file writes "unknown" for that field; this never throws, so it can never block a stop.
 */

export interface StopLineSources {
  /** Reads a file as text; throws when it cannot. */
  read: (path: string) => string;
}

const defaultSources: StopLineSources = { read: p => fs.readFileSync(p, 'utf8') };

/** The cgroup v2 directory of this process, e.g. /system.slice/renor-acme.service, or null. */
function cgroupPath(sources: StopLineSources): string | null {
  try {
    const line = sources.read('/proc/self/cgroup').split('\n').find(l => l.startsWith('0::'));
    const rel = line ? line.slice(3).trim() : '';
    return rel.startsWith('/') ? rel : null;
  } catch {
    return null;
  }
}

export function stopLine(ranMs: number, sources: StopLineSources = defaultSources): string {
  let unit = 'unknown';
  let peak = 'unknown';
  try {
    const rel = cgroupPath(sources);
    if (rel) {
      unit = crypto.createHash('sha256').update(rel.split('/').filter(Boolean).pop() ?? rel).digest('hex').slice(0, 12);
      const bytes = Number(sources.read(`/sys/fs/cgroup${rel}/memory.peak`).trim());
      if (Number.isFinite(bytes) && bytes >= 0) peak = String(Math.round(bytes / (1024 * 1024)));
    }
  } catch {
    // peak stays "unknown"
  }
  const ran = Number.isFinite(ranMs) && ranMs >= 0 ? String(Math.round(ranMs / 1000)) : 'unknown';
  return `[mvp] engine_stop unit=${unit} peak_mib=${peak} ran_s=${ran}`;
}
