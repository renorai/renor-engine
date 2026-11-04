import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPS, RULE_END, RULE_START, RULE_TEXT, RULE_TOOLS, installRule, removeRule, rulePath } from '../../src/connect';
import { TOOLS } from '../../src/mcp/server';

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
