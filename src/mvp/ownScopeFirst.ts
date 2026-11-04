import { normalizeScope } from './scope';

export const OWN_SCOPE_FIRST_FLAG = 'RENOR_OWN_SCOPE_FIRST';
export const DEFAULT_SCOPE_SETTING = 'RENOR_DEFAULT_SCOPE';

/**
 * The workspace's default project scope for a get_context that names none (RENOR_OWN_SCOPE_FIRST, off by default, with
 * RENOR_DEFAULT_SCOPE, empty by default). Null when off, empty or invalid: the reply is then what it always was.
 */
export function ownScopeSlug(env: NodeJS.ProcessEnv = process.env, connectionScope?: string): string | null {
  const flag = (env[OWN_SCOPE_FIRST_FLAG] ?? '').trim().toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(flag)) return null;
  // The scope a project-level `renor connect` wrote into the connection (x-renor-scope) wins over the workspace default;
  // an invalid or global one is ignored, as the setting is.
  const fromConnection = connectionScope?.trim() ? slugOfSetting(connectionScope.trim()) : null;
  if (fromConnection) return fromConnection;
  return slugOfSetting((env[DEFAULT_SCOPE_SETTING] ?? '').trim());
}

function slugOfSetting(raw: string): string | null {
  if (!raw) return null;
  try {
    const scope = normalizeScope(raw);
    return scope === 'global' ? null : scope.slice(scope.indexOf(':') + 1);
  } catch { return null; }
}

const slugOfScope = (scope: string | undefined | null): string | null =>
  scope && scope !== 'global' && scope.includes(':') ? scope.slice(scope.indexOf(':') + 1) : null;

const slugOfPath = (notePath: string): string | null => {
  const m = /^Memory\/Scopes\/([^/]+)\//.exec(notePath);
  return m ? m[1] : null;
};

/** Own scope first, then unscoped (global) items, then other scopes. Stable: each group keeps its order. */
function rank(slug: string | null, own: string): number {
  return slug === own ? 0 : slug === null ? 1 : 2;
}

export function ownScopeFirstFacts<T extends { scope?: string | null }>(items: T[], own: string | null): T[] {
  if (own === null) return items;
  return items.map((item, i) => ({ item, i, r: rank(slugOfScope(item.scope), own) }))
    .sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.item);
}

export function ownScopeFirstMemories<T extends { notePath: string }>(items: T[], own: string | null): T[] {
  if (own === null) return items;
  return items.map((item, i) => ({ item, i, r: rank(slugOfPath(item.notePath), own) }))
    .sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.item);
}
