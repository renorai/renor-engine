#!/usr/bin/env node
// Checks that `npx -y renor-engine mcp` works the way a stranger runs it: an empty npm cache, an empty home directory, an
// empty working folder, no setting. It starts the server through npx, does the MCP initialize handshake, remembers one fact
// and recalls it, then removes everything it made. It needs only Node and npx (no dependency of this repository).
//
//   node scripts/verify-npx.mjs                   the published package: npx -y renor-engine mcp
//   node scripts/verify-npx.mjs renor-engine@1.0.1   a version or dist-tag
//   node scripts/verify-npx.mjs .npm-pack/renor-engine-1.0.0.tgz   a tarball from `npm run pack:npm`, before it is published
//
// The install is the slow part and the only step that needs the network. Exit 0 and the line PASS mean it worked.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spec = process.argv[2] ?? 'renor-engine';
if (process.argv.length > 3) {
  console.error('usage: node scripts/verify-npx.mjs [package spec | path to a .tgz]');
  process.exit(1);
}
const isFile = fs.existsSync(spec) && fs.statSync(spec).isFile();
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'renor-npx-'));
const home = path.join(root, 'home');
const cwd = path.join(root, 'cwd');
fs.mkdirSync(home);
fs.mkdirSync(cwd);

// A tarball is named with --package (npx would read a bare path as a command); a registry spec is the one-liner itself.
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = isFile
  ? ['-y', `--package=${path.resolve(spec)}`, '--', 'renor-engine', 'mcp']
  : ['-y', spec, 'mcp'];
console.log(`$ ${command} ${args.join(' ')}`);
console.log(`node ${process.version}, ${process.platform}-${process.arch}; empty npm cache, home and working folder under ${root}`);

const env = { ...process.env, HOME: home, USERPROFILE: home, npm_config_cache: path.join(root, 'npm-cache') };
// Nothing of the engine's own configuration may reach the server: a stranger has none of it, and a model key here would
// send the check's query to a model.
for (const name of Object.keys(env)) {
  if (/^(RENOR_|MVP_|EMBEDDING_|OPENAI_|OLLAMA_|VAULT_|MEMORY_|CHUNK_|INDEX_|PRIORITY_|LLM_|CONVERSATIONS_|DB_PATH$)/.test(name)) delete env[name];
}
// A check is not a user: no first-run notice is recorded for it and nothing is shared (docs/TELEMETRY.md).
env.RENOR_SHARING = 'off';
const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });

let buffer = '';
let nextId = 0;
const waiting = new Map();
const strayLines = [];
child.stdout.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try { const reply = JSON.parse(line); waiting.get(reply.id)?.(reply); } catch { strayLines.push(line); }
  }
});
child.on('exit', code => { if (!finished) fail(`the server exited (code ${code}) before the check ended`); });

const LIMIT_MS = 240_000;
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method} in ${LIMIT_MS / 1000}s`)), LIMIT_MS);
    waiting.set(id, reply => { clearTimeout(timer); resolve(reply); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function text(reply) {
  if (reply.error || reply.result?.isError) throw new Error(JSON.stringify(reply.error ?? reply.result));
  return reply.result.content.map(item => item.text ?? '').join('\n');
}

let finished = false;
function cleanup() {
  finished = true;
  child.kill();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
function fail(message) {
  console.error(`FAIL: ${message}`);
  cleanup();
  process.exit(1);
}

try {
  const started = Date.now();
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-npx', version: '1' } });
  if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`initialize: ${init.result.serverInfo.name} ${init.result.serverInfo.version}, ${seconds}s from start (install included)`);
  if (seconds > 30) console.log('note: over 30 s; Claude Code gives an MCP server about 30 s to connect, so a first start may need a retry');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  text(await request('tools/call', { name: 'remember_fact', arguments: { subject: 'Ada', predicate: 'favorite_color', object: 'cerulean' } }));
  console.log('remember_fact: saved Ada favorite_color cerulean');
  const found = text(await request('tools/call', { name: 'search', arguments: { query: "What is Ada's favorite color?" } }));
  if (!found.toLowerCase().includes('cerulean')) throw new Error(`search did not return cerulean: ${found.slice(0, 300)}`);
  console.log('search: "What is Ada\'s favorite color?" -> cerulean');

  const ledger = path.join(home, '.renor', 'System', 'Memory Events Ledger.md');
  if (!fs.existsSync(ledger)) throw new Error('the default notes folder ~/.renor was not written');
  if (strayLines.length) throw new Error(`stdout carried non-JSON-RPC lines, which breaks a client: ${strayLines[0].slice(0, 200)}`);
  cleanup();
  console.log('PASS: npx renor-engine mcp remembers and recalls a fact with no setting.');
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
