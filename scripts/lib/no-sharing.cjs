'use strict';
/**
 * Our own tests, gates, evals and benchmarks must never send usage-sharing signals.
 *
 * The self-hosted engine shares anonymous usage numbers by default (src/sharing/state.ts, SHIPPED_DEFAULT_LEVEL). That is the product
 * default for real users and this file does not touch it. But a harness that starts an engine without turning sharing off shows up in
 * the sharing data as one more "install", so every harness entry point sets these variables:
 *
 *   RENOR_SHARING=off          the engine's own level override (it can only lower the level);
 *   DO_NOT_TRACK=1             the standard opt-out, which also forbids the sender's deletion request;
 *   RENOR_SHARING_INTERNAL=1   belt and braces: if a harness turns sharing on anyway, every row it sends says `internal: true`
 *                              (src/sharing/context.ts), and Renor's reports leave it out.
 *
 * A value already in the environment is kept, so a test that turns sharing on explicitly (it sets its own env) still can.
 *
 * Two ways to use it:
 *   - preload: `node -r ./scripts/lib/no-sharing-preload.cjs script.js` (or `tsx -r ...`) sets them on process.env, which every child inherits;
 *   - import { withNoSharing } / NO_SHARING_ENV for a harness that builds a child environment from scratch and would otherwise drop them.
 *     Importing this module changes nothing by itself; only the preload mutates process.env.
 */

const NO_SHARING_ENV = Object.freeze({ RENOR_SHARING: 'off', DO_NOT_TRACK: '1', RENOR_SHARING_INTERNAL: '1' });

/** Fill in whichever of them is unset or empty; never overrides a value somebody set. Returns the same object. */
function applyNoSharing(env) {
  for (const [key, value] of Object.entries(NO_SHARING_ENV)) {
    if ((env[key] ?? '') === '') env[key] = value;
  }
  return env;
}

/** A copy of `env` with sharing off unless it already says otherwise. */
function withNoSharing(env = {}) {
  return applyNoSharing({ ...env });
}

module.exports = { NO_SHARING_ENV, applyNoSharing, withNoSharing };
