import { CLI_WORDING_VERSION, DEFAULT_WORDING_VERSION, fieldsAtLevel, type SharingLevel } from './fields';
import { NOTICE_LINE } from './notice';

/**
 * The words the command line shows before it records a choice. The version id (CLI_WORDING_VERSION) is stored with the
 * choice, so the record shows which words the user saw. Change the words, change the id.
 *
 * These are the command line's own words. They are not the privacy policy: the public wording (policy, terms, website) is the
 * owner's and a lawyer's to approve and is not part of this file. docs/TELEMETRY.md has the same facts for reading offline.
 */

export function wordingFor(level: Exclude<SharingLevel, 'off'>): string {
  const common = [
    'Renor can learn from how its memory is used. Anonymous usage numbers are on until you turn them off; your memory text is shared only if you say yes, here or to your agent.',
    '',
    'You can change this at any time with `renor-engine telemetry off`, and `renor-engine telemetry delete`',
    'removes what Renor holds. Turning it off stops recording at once and asks Renor to delete what it holds, at once (backups can keep a',
    'copy for up to 7 more days). A ranking setting already fitted from rows is not recalled; the next fit leaves yours out.',
    'Sharing never changes your plan, quota or features. What you share is kept as long as it helps improve Renor, with no fixed period, and is deleted when you ask or turn it off.',
    '',
  ];
  if (level === 'signals') {
    return [
      ...common,
      'LEVEL: share signals',
      '  Sent: anonymous labelled numbers, worked out inside your own data folder from the learning log: which kind of memory was returned,',
      '  in what position, with what score, and whether your AI then opened, cited, updated or retired it, with times rounded to the hour.',
      '  Never sent: memory text, queries, titles, names, file paths, memory ids, keys or your IP address stored with the rows.',
      '  Every field is listed by `renor-engine telemetry fields signals`, and `renor-engine telemetry preview` prints exactly what would be sent.',
    ].join('\n');
  }
  return [
    ...common,
    'LEVEL: share data for training',
    '  Sent: everything in "share signals", plus the TEXT of the examples: the query behind a retrieval, the text of the memories it returned,',
    '  and the statements that were saved. Renor may use that text to train and evaluate its own models.',
    '  Memories can contain other people\'s personal data and information about you. A text that looks like a secret (key, password, token)',
    '  is left out, but no scanner is perfect: choose this only if you accept that.',
    '  Every field is listed by `renor-engine telemetry fields data`, and `renor-engine telemetry preview` prints exactly what would be sent.',
  ].join('\n');
}

/**
 * The words about the default, shown by `renor-engine telemetry status`: the first-run notice (notice.ts, the same line every surface
 * shows) and the facts behind it. The command line's own words, not the privacy policy (see the header); the owner's approved wording
 * replaces them and the id changes with it (DEFAULT_WORDING_VERSION).
 */
export function defaultWording(): string {
  return [
    NOTICE_LINE,
    '  Every field is listed by `renor-engine telemetry fields signals`, and `renor-engine telemetry preview` prints exactly what would be sent.',
    '  They are stored under a random install identifier that stays the same until you turn sharing off.',
    '  Turning it off stops recording and sending at once, and Renor is asked to delete what it holds for this install.',
    '  Sharing your memory text to help train Renor is a separate choice, never on unless you say yes: ask your agent, or run `renor-engine telemetry data`.',
    `  (words: ${DEFAULT_WORDING_VERSION})`,
  ].join('\n');
}

export const ADULT_LINE = 'I am 18 or older and I choose this myself.';

export function fieldList(level: Exclude<SharingLevel, 'off'>): string {
  return fieldsAtLevel(level).join('\n');
}

export { CLI_WORDING_VERSION };
