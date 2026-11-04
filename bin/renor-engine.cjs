#!/usr/bin/env node
"use strict";
// Entry point for `renor-engine`. Plain old-syntax JavaScript on purpose: it must run on a Node too old for the
// engine's own code, check the version, and only then load dist/cli.js.
// Keep the range in step with "engines.node" in package.json.

function parse(version) {
  var m = /^v?(\d+)\.(\d+)/.exec(String(version));
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

// Supported: ^22.16.0 || >=24
function nodeVersionSupported(version) {
  var v = parse(version);
  if (!v) return false;
  if (v.major >= 24) return true;
  return v.major === 22 && v.minor >= 16;
}

function unsupportedMessage(version) {
  return (
    "renor-engine needs Node.js 22.16 or later (22.16+ or 24+); this is " + version + ".\n" +
    "Install a newer Node, for example: nvm install 22 && nvm use 22   (or: mise use node@22)\n"
  );
}

function main() {
  var found = process.versions.node;
  if (!nodeVersionSupported(found)) {
    process.stderr.write(unsupportedMessage(found));
    process.exit(1);
    return;
  }
  require("../dist/cli.js");
}

module.exports = { nodeVersionSupported: nodeVersionSupported, unsupportedMessage: unsupportedMessage };
if (require.main === module) main();
