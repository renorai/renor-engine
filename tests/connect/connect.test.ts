import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { APPS, RULE_END, RULE_START, RULE_TEXT, RULE_TEXT_HOSTED, RULE_TOOLS, installRule, mcpEntry, removeRule, rulePath } from '../../src/connect';
import { HOSTED_STDIO_NAMES } from '../../src/mcp/hostedSurface';
import { TOOLS, STDIO_CODING_TOOLS, createMcpTools, registerMcpHandlers } from '../../src/mcp/server';

const dirs: string[] = [];
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-'));
  dirs.push(d);
  return { cwd: path.join(d, 'proj'), env: { HOME: d } as NodeJS.ProcessEnv };
}
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('renor-engine connect rule', () => {
  it('is idempotent: a second run leaves the file unchanged', () => {
    const { cwd, env } = sandbox();
    expect(installRule('claude-code', env, cwd).state).toBe('added');
    const file = rulePath('claude-code', env, cwd);
    const once = fs.readFileSync(file, 'utf8');
    expect(installRule('claude-code', env, cwd).state).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  });
  it('keeps existing user text and replaces the block in place', () => {
    const { cwd, env } = sandbox();
    const file = rulePath('gemini', env, cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'my notes\n');
    installRule('gemini', env, cwd);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('recall first', 'OLD') + 'after\n');
    expect(installRule('gemini', env, cwd).state).toBe('updated');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith('my notes\n')).toBe(true);
    expect(text).toContain('after\n');
    expect(text).not.toContain('OLD');
    expect(text.split(RULE_START).length).toBe(2);
  });
  it('removal deletes only the block and restores the user text', () => {
    const { cwd, env } = sandbox();
    const file = rulePath('codex', env, cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'mine\n');
    installRule('codex', env, cwd);
    expect(removeRule('codex', env, cwd).state).toBe('removed');
    expect(fs.readFileSync(file, 'utf8')).toBe('mine\n');
    expect(removeRule('codex', env, cwd).state).toBe('absent');
  });
  it('removal of a missing file is absent and creates nothing', () => {
    const { cwd, env } = sandbox();
    expect(removeRule('pi', env, cwd).state).toBe('absent');
    expect(fs.existsSync(rulePath('pi', env, cwd))).toBe(false);
  });
  it('covers every app with a path', () => {
    const { cwd, env } = sandbox();
    for (const a of APPS) expect(rulePath(a, env, cwd)).toBeTruthy();
  });
  it('names only tools the engine server exposes (drift)', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const t of RULE_TOOLS) {
      expect(names.has(t)).toBe(true);
      expect(RULE_TEXT).toContain(t);
    }
    expect(RULE_TEXT).not.toMatch(/get_context|\bremember\b(?!_)/);
    expect(RULE_TEXT.includes(RULE_END)).toBe(false);
  });
});

describe('renor-engine connect CLI', () => {
  const CLI = path.join(path.resolve(__dirname, '..', '..'), 'dist', 'cli.js');
  it.skipIf(!fs.existsSync(CLI))('--no-rule writes nothing', async () => {
    const { execFileSync } = await import('node:child_process');
    const { cwd, env } = sandbox();
    fs.mkdirSync(cwd, { recursive: true });
    const out = execFileSync(process.execPath, [CLI, 'connect', 'grok', '--no-rule'], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
    expect(out).toContain('renor-engine');
    expect(fs.existsSync(path.join(cwd, 'AGENTS.md'))).toBe(false);
  });
});

describe('renor-engine connect --tools (stdio coding preset)', () => {
  beforeAll(() => { process.env.RENOR_MCP_LEGACY_STDIO = '1'; });
  afterAll(() => { delete process.env.RENOR_MCP_LEGACY_STDIO; });
  it('prints the coding env by default and today\'s entry byte for byte with --tools full', () => {
    expect(mcpEntry()).toEqual({ command: 'renor-engine', args: ['mcp'], env: { RENOR_MCP_TOOLS: 'coding' } });
    expect(JSON.stringify(mcpEntry({ tools: 'full' }))).toBe('{"command":"renor-engine","args":["mcp"]}');
  });
  it('names the save tool the preset lists; full keeps today\'s rule', () => {
    const a = sandbox(); const b = sandbox();
    // RENOR_MCP_LEGACY_STDIO=1 keeps the rule that names the older stdio tools; the default rule names the hosted names.
    const legacy = { RENOR_MCP_LEGACY_STDIO: '1' };
    installRule('codex', { ...a.env, ...legacy }, a.cwd);
    installRule('codex', { ...b.env, ...legacy }, b.cwd, { tools: 'full' });
    const coding = fs.readFileSync(rulePath('codex', a.env, a.cwd), 'utf8');
    const full = fs.readFileSync(rulePath('codex', b.env, b.cwd), 'utf8');
    expect(full).toContain(RULE_TEXT);
    expect(coding).toContain('Save with note when');
    expect(coding).not.toContain('remember_fact');
    for (const name of ['search', 'note']) expect(STDIO_CODING_TOOLS).toContain(name);
  });
  it('by default the rule names get_context and remember, both listed by the stdio server', () => {
    const a = sandbox();
    installRule('codex', a.env, a.cwd);
    const rule = fs.readFileSync(rulePath('codex', a.env, a.cwd), 'utf8');
    expect(rule).toContain(RULE_TEXT_HOSTED);
    for (const name of ['get_context', 'remember']) expect(HOSTED_STDIO_NAMES).toContain(name);
    expect(rule).not.toMatch(/remember_fact|\bnote\b with/);
  });

  async function listed(toolsEnv: string | undefined): Promise<string[]> {
    const prev = process.env.RENOR_MCP_TOOLS;
    if (toolsEnv === undefined) delete process.env.RENOR_MCP_TOOLS; else process.env.RENOR_MCP_TOOLS = toolsEnv;
    try {
      const server = new Server({ name: 'renor', version: '1.0.0' }, { capabilities: { tools: {} } });
      registerMcpHandlers(server, {} as ReturnType<typeof createMcpTools>);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 't', version: '0.1.0' }, { capabilities: {} });
      await Promise.all([server.connect(st), client.connect(ct)]);
      const res = await client.listTools();
      const refused = await client.callTool({ name: 'entity', arguments: { name: 'x' } });
      await client.close();
      if (toolsEnv === 'coding') expect(refused.isError).toBe(true);
      return res.tools.map((t) => t.name);
    } finally {
      if (prev === undefined) delete process.env.RENOR_MCP_TOOLS; else process.env.RENOR_MCP_TOOLS = prev;
    }
  }
  it('lists exactly the five coding tools under coding; unset and all list every tool unchanged', async () => {
    expect(await listed('coding')).toEqual(TOOLS.map((t) => t.name).filter((n) => (STDIO_CODING_TOOLS as readonly string[]).includes(n)));
    expect((await listed('coding')).sort()).toEqual(['facts', 'keyword', 'note', 'search', 'status']);
    const all = TOOLS.map((t) => t.name);
    expect(await listed(undefined)).toEqual(all);
    expect(await listed('all')).toEqual(all);
  });
});
