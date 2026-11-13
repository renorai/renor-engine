/**
 * remember: a save whose text arrives under another argument name (#1885).
 *
 * The tool takes `statement`. Agents often send the same words as `text`, `content`, `memory`, `fact`, `note`, `message` or
 * `value`, and the schema refuses the call before the tool runs, which costs a retry turn (or loses the save). With
 * RENOR_REMEMBER_ARG_NAMES on (the default) the call is rewritten before validation: when `statement` is absent and no
 * subject, predicate or object is given, the first of those names holding a non-blank string becomes the `statement`.
 * A call that still cannot be understood is refused by the schema as before. `off`, `0`, `false` or `no` restores
 * the schema refusal byte for byte. The published input schema is untouched.
 */

export const REMEMBER_STATEMENT_ALIASES = ['text', 'content', 'memory', 'fact', 'note', 'message', 'value'] as const;

export function rememberArgNamesEnabled(): boolean {
  return !['off', '0', 'false', 'no'].includes((process.env.RENOR_REMEMBER_ARG_NAMES ?? '').trim().toLowerCase());
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The arguments to validate instead of `args`, or null to leave the call alone (every refusal stays the SDK's own). */
export function tolerateRememberArgs(args: unknown): { args: Record<string, unknown> } | null {
  if (!rememberArgNamesEnabled()) return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const given = args as Record<string, unknown>;
  if (nonBlank(given.statement)) return null;
  if ([given.subject, given.predicate, given.object].some(nonBlank)) return null;
  if (given.statement !== undefined && given.statement !== null && given.statement !== '') return null;
  for (const name of REMEMBER_STATEMENT_ALIASES) {
    if (nonBlank(given[name])) return { args: { ...given, statement: given[name] } };
  }
  return null;
}

/** The line added to a refusal when the call carried no statement under any accepted name (#1921). */
export const REMEMBER_STATEMENT_HINT =
  `Hint: send the text to save as "statement" (also accepted: ${REMEMBER_STATEMENT_ALIASES.map(n => `"${n}"`).join(', ')}).`;

/** True when a refused remember call held no text to save: no usable statement, alias or subject/predicate/object, and the hint is on. */
export function wantsStatementHint(args: unknown): boolean {
  if (!rememberArgNamesEnabled()) return false;
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) return false;
  const given = (args ?? {}) as Record<string, unknown>;
  if (given.statement !== undefined && given.statement !== null && given.statement !== '') return false;
  if ([given.subject, given.predicate, given.object].some(nonBlank)) return false;
  return !REMEMBER_STATEMENT_ALIASES.some(name => nonBlank(given[name]));
}
