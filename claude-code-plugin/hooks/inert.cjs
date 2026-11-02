'use strict';
// The one inert encoder for every agent-visible text Renor did not write itself: stored memory lines, pending rules and
// their fields, in the engine's get_context and in the SessionStart hook. Dependency-free and CommonJS on purpose, so the
// engine (compiled to CommonJS) and the plain-ESM hooks (which import CJS by name) load the same file.

/** Angle brackets and the characters that look like them, after NFKC has folded the fullwidth and small forms. */
const OPEN_LOOKALIKE = /[<\u2039\u3008\u27E8\u276E\u2770\u1438\u02C2\u29FC\u2329]/g;
const CLOSE_LOOKALIKE = /[>\u203A\u3009\u27E9\u276F\u2771\u1433\u02C3\u29FD\u232A]/g;
/** The memory label's name with any separator, as one spelling (the words stay readable; the brackets are what delimit). */
const MEMORY_LABEL = /renor[\s\p{Pd}_]*memory/giu;

/**
 * Stored text cannot close or reopen a Renor block: compatibility forms are folded (NFKC), whitespace collapsed to one
 * space, invisible format and control characters dropped, every angle bracket and lookalike turned into a parenthesis
 * (so `<renor-standing-rules>` and `<renor-session-index>` are plain words), the memory label's name split, and a
 * character reference (`&#60;`, `&lt;`, or a double-encoded `&amp;#60;`) broken so no decoder spells a delimiter.
 */
function inert(text) {
  return String(text ?? '').normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(OPEN_LOOKALIKE, '(')
    .replace(CLOSE_LOOKALIKE, ')')
    .replace(MEMORY_LABEL, 'renor memory')
    .replace(/&(?=#|[a-z][a-z0-9]*;)/gi, '& ')
    .trim();
}

exports.inert = inert;
