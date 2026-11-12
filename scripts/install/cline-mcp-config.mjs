#!/usr/bin/env node
/**
 * Merge the self-hosted `renor-local` entry into Cline's MCP settings file (cline_mcp_settings.json).
 *
 *   node scripts/install/cline-mcp-config.mjs [--file <path>] [--print-path]
 *
 * Other servers in the file are kept. Needs no account and no key. Prints the file it wrote.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RENOR_LOCAL_ENTRY = { command: 'npx', args: ['-y', 'renor-engine', 'mcp'] };

/** Where Cline keeps cline_mcp_settings.json (VS Code extension), per platform. */
export function defaultSettingsPath(platform = process.platform, env = process.env, home = os.homedir()) {
  const tail = ['globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'];
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User', ...tail);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', ...tail);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Code', 'User', ...tail);
}

export function mergeEntry(text) {
  const doc = text && text.trim() ? JSON.parse(text) : {};
  doc.mcpServers = { ...doc.mcpServers, 'renor-local': RENOR_LOCAL_ENTRY };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function main(argv) {
  const i = argv.indexOf('--file');
  const file = i >= 0 ? argv[i + 1] : defaultSettingsPath();
  if (argv.includes('--print-path')) return console.log(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let merged;
  try {
    merged = mergeEntry(before);
  } catch {
    console.error(`cannot parse ${file}: not valid JSON. Nothing was changed.`);
    process.exit(1);
  }
  fs.writeFileSync(file, merged);
  console.log(file);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
