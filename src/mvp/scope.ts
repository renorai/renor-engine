/**
 * Optional memory scope for MVP tools (global vs named project/scope).
 *
 * Allowed forms:
 *   - "global" (default)
 *   - "scope:<slug>" or "project:<slug>"
 * Slug: lowercase [a-z0-9-]{1,64} after normalization.
 */
import { refusal } from '../toolRefusal';

export type NormalizedScope = 'global' | `scope:${string}` | `project:${string}`;

/** The one directory a scope owns. Read by both the JS and the SQL scope rules. */
const SCOPES_ROOT = 'Memory/Scopes/';

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

/** Normalize user/agent scope input. Throws on invalid values. */
export function normalizeScope(raw?: string | null): NormalizedScope {
  if (raw === undefined || raw === null || raw.trim() === '') return 'global';
  const s = raw.trim().toLowerCase();
  if (s === 'global') return 'global';

  let kind: 'scope' | 'project' | null = null;
  let slug = s;
  if (s.startsWith('scope:')) {
    kind = 'scope';
    slug = s.slice('scope:'.length);
  } else if (s.startsWith('project:')) {
    kind = 'project';
    slug = s.slice('project:'.length);
  } else {
    // Bare slug → scope:<slug>
    kind = 'scope';
    slug = s;
  }

  // Normalize slug: spaces/underscores → hyphens; strip invalid chars
  slug = slug
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!SLUG_RE.test(slug)) {
    // The refusal names its code for telemetry (a closed set, never built from this input); the message the
    // agent reads is unchanged, and it is the agent's own argument that is quoted in it.
    throw refusal(
      'invalid_scope',
      `invalid scope ${JSON.stringify(raw)}: use "global" or "scope:<slug>" / "project:<slug>" with slug matching [a-z0-9-]{1,64}`,
    );
  }
  return `${kind}:${slug}` as NormalizedScope;
}

/** Daily-note directory under the vault for this scope. */
export function dailyDirForScope(scope: NormalizedScope): string {
  if (scope === 'global') return 'Memory/Daily';
  const slug = scope.includes(':') ? scope.slice(scope.indexOf(':') + 1) : scope;
  return `Memory/Scopes/${slug}/Daily`;
}

/** True if a vault-relative note path belongs to the given scope. */
export function notePathMatchesScope(notePath: string, scope: NormalizedScope): boolean {
  const norm = notePath.replace(/\\/g, '/');
  if (scope === 'global') {
    // Global notes: not under Memory/Scopes/
    if (norm.startsWith('Memory/Scopes/') || norm.includes('/Memory/Scopes/')) return false;
    return true;
  }
  const slug = scope.slice(scope.indexOf(':') + 1);
  const prefix = `Memory/Scopes/${slug}/`;
  return norm === prefix.slice(0, -1) || norm.startsWith(prefix) || norm.includes('/' + prefix);
}

/**
 * The same rule as notePathMatchesScope, as a SQL predicate over a stored path
 * column, for the callers that must filter or count rows without materializing
 * every path. Each arm below is one arm of that function — the three `dir`
 * terms are its equality, startsWith and includes cases — and
 * tests/mvp/scope-isolation.test.ts pins them against each other, so a scope
 * can never mean two different things depending on whether it was checked in
 * SQL or in JS. A prefix is `instr(...) = 1`, not LIKE: LIKE folds ASCII
 * case and the JS rule does not. Bind with better-sqlite3's positional params
 * in `params`.
 */
export function scopeSqlPredicate(
  scope: NormalizedScope,
  column: string,
): { sql: string; params: string[] } {
  if (scope === 'global') {
    return {
      sql: `(instr(${column}, ?) <> 1 AND instr(${column}, ?) = 0)`,
      params: [SCOPES_ROOT, `/${SCOPES_ROOT}`],
    };
  }
  const dir = `${SCOPES_ROOT}${scope.slice(scope.indexOf(':') + 1)}`;
  return {
    sql: `(instr(${column}, ?) > 0 OR instr(${column}, ?) = 1 OR ${column} = ?)`,
    params: [`/${dir}/`, `${dir}/`, dir],
  };
}

/**
 * The scopes a fact or a ledger event can have been saved in and belong to `scope`: the one rule notes follow, for
 * what is not a note. A named scope is its slug. `scope:<slug>`, `project:<slug>` and the bare `<slug>` are spellings
 * of one scope: a note saved in any of them goes to the one folder of that slug (`dailyDirForScope`) and is read in
 * all three (`notePathMatchesScope`). A fact keeps the spelling it was saved with (the ledger, its digest and the
 * `scope` a read shows are what was written), and is read in every spelling of its slug, as its scope's notes are. A
 * save corrects its subject and predicate in every spelling too: it closes the current value whatever spelling that
 * was saved with (memory/lifecycle.ts, one lifecycle stream per slug).
 * Global has one spelling. Distinct, so a caller that reads once per spelling never reads a scope twice.
 */
export function scopeSpellings(scope: NormalizedScope): string[] {
  if (scope === 'global') return ['global'];
  const slug = scope.slice(scope.indexOf(':') + 1);
  return [`scope:${slug}`, `project:${slug}`];
}

/** Whether a fact or ledger event saved in `saved` (a stored, normalized scope) belongs to `scope`. */
export function savedScopeMatches(saved: string, scope: NormalizedScope): boolean {
  return scopeSpellings(scope).includes(saved);
}

/**
 * The same rule as savedScopeMatches, as a SQL predicate over a stored scope column (`facts.scope`,
 * `fact_terms.scope`). Bind with better-sqlite3's positional params in `params`.
 */
export function savedScopeSqlPredicate(
  scope: NormalizedScope,
  column: string,
): { sql: string; params: string[] } {
  const spellings = scopeSpellings(scope);
  return { sql: `${column} IN (${spellings.map(() => '?').join(', ')})`, params: spellings };
}
