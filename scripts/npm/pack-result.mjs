/**
 * Reads the JSON that `npm pack --json` prints. npm 10 prints a one-element array; npm 12 can print an object keyed by
 * package name. Both carry the same fields (filename, size, unpackedSize, entryCount). Anything else throws a clear error.
 */
export function readPackResult(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`pack: \`npm pack --json\` did not print JSON (${error.message}): ${String(text).slice(0, 200)}`);
  }
  const info = Array.isArray(parsed)
    ? parsed[0]
    : parsed && typeof parsed === 'object' && typeof parsed.filename !== 'string'
      ? Object.values(parsed)[0]
      : parsed;
  if (!info || typeof info !== 'object' || typeof info.filename !== 'string') {
    throw new Error(`pack: unrecognised \`npm pack --json\` output: ${String(text).slice(0, 200)}`);
  }
  return info;
}
