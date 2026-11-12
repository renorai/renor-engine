#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The server is started from dist/cli.js relative to the working directory, so the script must run from the engine root.
if (!fs.existsSync(path.resolve('dist/cli.js')) || !fs.existsSync(path.resolve('package.json'))) {
  console.error('Run this from the engine/ directory (cd engine && node scripts/smoke-self-hosted.mjs), after npm run build.');
  process.exit(1);
}

// With no argument the check needs no setting: it makes a new temporary notes folder and removes it when it ends. A
// VAULT_PATH in your environment is not read, so a check run by habit cannot add a test fact to your real notes. Name an
// absolute folder to check that one instead; the check then adds one test fact to its memory and leaves it there.
const named = process.argv[2];
if (process.argv.length > 3 || (named !== undefined && !path.isAbsolute(named))) {
  console.error('usage: node scripts/smoke-self-hosted.mjs [absolute-notes-folder]');
  process.exit(1);
}
// The real path of the temp directory: on macOS /var is a link, and the vault should not sit behind one.
const temporary = named === undefined ? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'renor-smoke-')) : null;
const vault = named ?? path.join(temporary, 'vault');
console.log(temporary
  ? `notes folder: ${vault} (temporary; removed when this check ends)`
  : `notes folder: ${vault} (yours; this check adds the test fact Ada favorite_color cerulean to its memory)`);

// Only the folder is passed to the server, so it runs on its own defaults: nothing else from this shell reaches it, and no
// key is set for any model. (The client adds HOME, PATH and a few other plain variables.) Sharing is off for the check: a check is
// not a user, so it must not take the first-run notice the agent would show you, nor send anything (docs/TELEMETRY.md).
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('dist/cli.js'), 'mcp'],
  cwd: process.cwd(),
  env: { VAULT_PATH: vault, RENOR_SHARING: 'off' },
  stderr: 'inherit',
});
const client = new Client({ name: 'renor-self-hosted-smoke', version: '1.0.0' });
// The first start applies the database migrations and loads the engine, which takes seconds and, on a busy or slow machine,
// longer than the client's default minute: waiting is better than failing a check that would have passed.
const patiently = { timeout: 180_000 };

function body(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP tool returned an error');
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('MCP tool returned no text result');
  return JSON.parse(text);
}

try {
  await client.connect(transport, patiently);
  const names = (await client.listTools(undefined, patiently)).tools.map(tool => tool.name);
  for (const required of ['remember', 'get_context']) {
    if (!names.includes(required)) throw new Error(`tools/list did not include ${required}`);
  }
  console.log(`tools/list: ${names.join(', ')}`);

  body(await client.callTool({
    name: 'remember',
    arguments: { statement: 'Ada favorite_color cerulean', subject: 'Ada', predicate: 'favorite_color', object: 'cerulean' },
  }, undefined, patiently));
  console.log('remember: saved Ada favorite_color cerulean');

  for (const query of ["What is Ada's favorite color?", 'Ada favorite color cerulean', 'cerulean']) {
    const result = body(await client.callTool({ name: 'get_context', arguments: { query } }, undefined, patiently));
    if (!JSON.stringify(result).toLowerCase().includes('cerulean')) {
      throw new Error(`get_context did not return cerulean for ${JSON.stringify(query)}: ${JSON.stringify(result)}`);
    }
    console.log(`get_context: ${JSON.stringify(query)} -> cerulean`);
  }
  console.log('PASS: self-hosted stdio MCP can remember and retrieve a current fact.');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // The server closes its pipe when it cannot start (a bad setting, a native module built for another Node); it says why on stderr.
  console.error(`FAIL: ${message}${/connection closed/i.test(message) ? ' (the server exited while starting; its own message is above)' : ''}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => transport.close());
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
}
