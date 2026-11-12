/**
 * `renor-engine connect <app>`: the self-host counterpart of the hosted `renor connect`. Agents read memory unprompted
 * but only save when told to, so this writes a short marked rule into the app's own instructions file. A re-run replaces
 * the block in place, nothing outside the markers is touched, and `--remove` deletes only the block.
 * The wording names the engine's stdio tools (see TOOLS in mcp/server.ts); a drift test keeps them in step.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RULE_START = '<!-- renor:rule:start -->';
export const RULE_END = '<!-- renor:rule:end -->';

export const RULE_TOOLS = ['search', 'remember_fact'] as const;

export const RULE_TEXT = `## Renor memory

Renor is connected to this app and remembers across sessions.
- Before deciding anything non-trivial, recall first: one search call is usually enough.
- Save with remember_fact when the user makes a decision, corrects you, or states a fact that should outlive this chat. Include the reason.
- Save the specific value (a port, a name, a path), not a summary of it.
- Do not save secrets, or things that are already in the code.`;

/** The rule for the default stdio server, which lists the hosted names (src/mcp/hostedSurface.ts). */
export const RULE_TEXT_HOSTED = `## Renor memory

Renor is connected to this app and remembers across sessions.
- Before deciding anything non-trivial, recall first: one get_context call is usually enough.
- Save with remember when the user makes a decision, corrects you, or states a fact that should outlive this chat. Include the reason.
- Save the specific value (a port, a name, a path), not a summary of it.
- Do not save secrets, or things that are already in the code.`;

/** Under RENOR_MCP_TOOLS=coding the save tool is `note` (remember_fact is not listed), so the rule names that one. */
function blockFor(coding: boolean, legacy: boolean): string {
  const text = !legacy ? RULE_TEXT_HOSTED : coding ? RULE_TEXT.replace('remember_fact', 'note') : RULE_TEXT;
  return `${RULE_START}\n${text}\n${RULE_END}\n`;
}

export const APPS = ['claude-code', 'codex', 'grok', 'gemini', 'pi', 'vscode'] as const;
export type AppId = (typeof APPS)[number];

export function isApp(id: string): id is AppId {
  return (APPS as readonly string[]).includes(id);
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** Where each app reads its standing instructions (same places as the hosted `renor connect`). */
export function rulePath(app: AppId, env: NodeJS.ProcessEnv, cwd: string): string {
  const home = homeDir(env);
  switch (app) {
    case 'claude-code': return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'CLAUDE.md');
    case 'codex': return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'AGENTS.md');
    case 'grok': return path.join(cwd, 'AGENTS.md');
    case 'gemini': return path.join(home, '.gemini', 'GEMINI.md');
    case 'pi': return path.join(home, '.pi', 'agent', 'AGENTS.md');
    case 'vscode': return path.join(cwd, '.github', 'copilot-instructions.md');
  }
}

function find(text: string): [number, number] | null {
  const start = text.indexOf(RULE_START);
  const end = start < 0 ? -1 : text.indexOf(RULE_END, start);
  return start >= 0 && end >= 0 ? [start, end + RULE_END.length] : null;
}

/** The MCP entry to add to the app's own config: the engine's stdio server. */
export function mcpEntry(opts: { tools?: 'coding' | 'full' } = {}): { command: string; args: string[]; env?: { RENOR_MCP_TOOLS: string } } {
  // Every app in APPS is a coding client: it gets the short stdio list by default. `full` is today's entry, byte for byte.
  const entry = { command: 'renor-engine', args: ['mcp'] };
  return (opts.tools ?? 'coding') === 'full' ? entry : { ...entry, env: { RENOR_MCP_TOOLS: 'coding' } };
}

export function installRule(app: AppId, env: NodeJS.ProcessEnv, cwd: string, opts: { tools?: 'coding' | 'full' } = {}): { path: string; state: 'added' | 'updated' | 'unchanged' } {
  const file = rulePath(app, env, cwd);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const span = find(before);
  const BLOCK = blockFor((opts.tools ?? 'coding') !== 'full', env.RENOR_MCP_LEGACY_STDIO?.trim() === '1');
  let after: string;
  if (span) after = before.slice(0, span[0]) + BLOCK.trimEnd() + before.slice(span[1]);
  else after = before + (before && !before.endsWith('\n') ? '\n' : '') + (before ? '\n' : '') + BLOCK;
  if (after === before) return { path: file, state: 'unchanged' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  return { path: file, state: span ? 'updated' : 'added' };
}

export function removeRule(app: AppId, env: NodeJS.ProcessEnv, cwd: string): { path: string; state: 'removed' | 'absent' } {
  const file = rulePath(app, env, cwd);
  if (!fs.existsSync(file)) return { path: file, state: 'absent' };
  const before = fs.readFileSync(file, 'utf8');
  const span = find(before);
  if (!span) return { path: file, state: 'absent' };
  const head = before.slice(0, span[0]).replace(/\n+$/, '\n');
  const tail = before.slice(span[1]).replace(/^\n/, '');
  const after = head === '\n' ? tail : head + (tail && head ? '\n' : '') + tail;
  fs.writeFileSync(file, after);
  return { path: file, state: 'removed' };
}
