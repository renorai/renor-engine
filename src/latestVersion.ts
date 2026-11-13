import { effectiveLevel, sharingDirFor } from './sharing/state.js';

/** The answer of a latest-version lookup. `skipped`: sharing is off, DO_NOT_TRACK=1 or offline, so no request was made. */
export interface LatestVersion {
  state: 'ok' | 'unreachable' | 'skipped';
  latest: string | null;
}

const REGISTRY_URL = 'https://registry.npmjs.org/renor-engine/latest';
export const LATEST_VERSION_TIMEOUT_MS = 2000;

/**
 * Asks the npm registry for the latest published renor-engine, for `status` and `doctor`. One GET, capped at 2 seconds, and
 * never an error: a silent or failing registry is `unreachable`. No request at all when sharing is off (the off switch, which
 * includes DO_NOT_TRACK=1 and RENOR_SHARING=off) or when the caller says offline.
 */
export async function lookupLatestVersion(opts: {
  env?: NodeJS.ProcessEnv;
  offline?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<LatestVersion> {
  const env = opts.env ?? process.env;
  if (opts.offline) return { state: 'skipped', latest: null };
  try {
    const memoryDir = (env.MVP_MEMORY_DIR ?? '').trim();
    if (effectiveLevel(sharingDirFor(memoryDir === '' ? null : memoryDir, env, undefined), env) === 'off') return { state: 'skipped', latest: null };
  } catch {
    return { state: 'skipped', latest: null };
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? LATEST_VERSION_TIMEOUT_MS),
    });
    if (!res.ok) return { state: 'unreachable', latest: null };
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version)
      ? { state: 'ok', latest: body.version }
      : { state: 'unreachable', latest: null };
  } catch {
    return { state: 'unreachable', latest: null };
  }
}

/** One line for status and doctor. */
export function latestVersionLine(installed: string, r: LatestVersion): string {
  if (r.state === 'skipped') return `renor-engine ${installed} (latest not checked: sharing is off or offline)`;
  if (r.state === 'unreachable' || r.latest === null) return `renor-engine ${installed} (latest unknown: the npm registry did not answer within 2 seconds)`;
  return r.latest === installed
    ? `renor-engine ${installed} (latest: ${r.latest}, up to date)`
    : `renor-engine ${installed} (latest: ${r.latest}; the usual \`npx -y renor-engine mcp\` fetches it at the next start)`;
}
