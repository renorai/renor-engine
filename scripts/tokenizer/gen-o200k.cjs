'use strict';
/**
 * Regenerates src/indexer/o200k.json: the o200k_base vocabulary (what gpt-tokenizer ships as a 2.2 MB JavaScript array
 * of 199,998 strings and byte arrays) packed as one deflated buffer, so the engine can count tokens from ~3 MB of typed
 * arrays instead of a 200,000-entry Map of strings.
 *
 *   node scripts/tokenizer/gen-o200k.cjs            # writes src/indexer/o200k.json
 *   node scripts/tokenizer/gen-o200k.cjs --check    # exits 1 when the committed file differs from what would be written
 *
 * Layout of the buffer before deflate: for each rank 0..N-1: [len as LEB128][len bytes of the token's UTF-8 / raw bytes].
 * A token's rank is its position; length 0 marks a token that is not insertable (see below). The packed form is derived from gpt-tokenizer alone; tests compare the
 * counter built from it with gpt-tokenizer's own encoder.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

// The package's exports map hides its internals, so they are read by path from its directory.
const pkg = path.dirname(require.resolve('gpt-tokenizer/package.json'));
const ranks = require(path.join(pkg, 'cjs', 'bpeRanks', 'o200k_base.js')).default;
const { tryConvertToString } = require(path.join(pkg, 'cjs', 'utfUtil.js'));
const out = [];
let unreachable = 0;
const enc = new TextEncoder();
for (let rank = 0; rank < ranks.length; rank++) {
  const v = ranks[rank];
  if (v === undefined) throw new Error(`rank ${rank} is a hole: the packed form assumes none`);
  let bytes;
  if (typeof v === 'string') {
    bytes = enc.encode(v);
    if (tryConvertToString(bytes) !== v) throw new Error(`rank ${rank}: a string token that does not round-trip`);
  } else {
    bytes = Uint8Array.from(v);
    // A byte token that gpt-tokenizer itself reads as text (the nine that start with a byte-order mark) is never found by
    // its bytes: a key that reads as text is looked up as the decoded string, and the decoder drops the mark. Such a token
    // is packed as an empty entry, which the counter does not insert, so it stays as unreachable here as it is there.
    if (tryConvertToString(bytes) !== undefined) { unreachable++; bytes = new Uint8Array(0); }
  }
  let n = bytes.length;
  const len = [];
  do { len.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7; } while (n > 0);
  out.push(Buffer.from(len), Buffer.from(bytes));
}
const raw = Buffer.concat(out);
const packed = zlib.deflateSync(raw, { level: 9 });
const b64 = packed.toString('base64');
const sha = crypto.createHash('sha256').update(raw).digest('hex');
const source = JSON.stringify({
  generatedBy: 'scripts/tokenizer/gen-o200k.cjs from gpt-tokenizer o200k_base ranks; do not edit',
  tokens: ranks.length,
  unreachable,
  packedBytes: raw.length,
  packedSha256: sha,
  deflateBase64: b64,
}, null, 2) + '\n';
const target = path.join(__dirname, '..', '..', 'src', 'indexer', 'o200k.json');
if (process.argv.includes('--check')) {
  // The deflate stream is runtime-specific (Bun's zlib writes different bytes for the same input), so a byte match is
  // sufficient but not necessary: the committed file is current when it unpacks to exactly the bytes this run built.
  let same = fs.existsSync(target) && fs.readFileSync(target, 'utf8') === source;
  if (!same && fs.existsSync(target)) {
    try {
      const c = JSON.parse(fs.readFileSync(target, 'utf8'));
      same = c.tokens === ranks.length && c.packedBytes === raw.length && c.packedSha256 === sha
        && JSON.stringify(c.unreachable) === JSON.stringify(unreachable)
        && zlib.inflateSync(Buffer.from(c.deflateBase64, 'base64')).equals(raw);
    } catch { same = false; }
  }
  console.log(same ? 'o200k.json is current' : 'o200k.json differs from what the generator writes');
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(target, source);
console.log(`wrote ${target}: raw ${raw.length} B, deflated ${packed.length} B, base64 ${b64.length} B`);
