import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

/**
 * The Claude Code handoff hooks (engine/claude-plugin/hooks), run as Claude Code runs them: `node handoff.mjs <event>`
 * with the hook's JSON on stdin, in a synthetic git repository. Default off; SessionStart prints its one block once per
 * session, only on startup and clear, with this repo and branch; Stop asks for a write only after new tool use, at most
 * once per interval, never while a stop hook is already active, and not when the agent already wrote the note.
 */
const SCRIPT = path.join(__dirname, '../../claude-plugin/hooks/handoff.mjs');
const HOOKS = JSON.parse(fs.readFileSync(path.join(__dirname, '../../claude-plugin/hooks/hooks.json'), 'utf8'));
let root: string;
let repo: string;
let data: string;

function run(event: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, event], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, CLAUDE_PLUGIN_DATA: data, RENOR_HANDOFF_NOTE: '1', ...env },
  });
  expect(res.status).toBe(0);
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

function transcript(lines: unknown[]): string {
  const file = path.join(root, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
  return file;
}
const toolUse = (name: string, input: Record<string, unknown> = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name, input }] } });

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-hooks-'));
  repo = path.join(root, 'fjord');
  data = path.join(root, 'plugin-data');
  fs.mkdirSync(repo);
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'seed');
  g('remote', 'add', 'origin', 'https://alice:ghp_synthetic123@github.com/acme/fjord.git');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('hooks.json', () => {
  it('runs the script on SessionStart (startup|clear) and Stop', () => {
    expect(HOOKS.hooks.SessionStart[0].matcher).toBe('startup|clear');
    expect(HOOKS.hooks.SessionStart[0].hooks[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/handoff.mjs" session-start');
    expect(HOOKS.hooks.Stop[0].hooks[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/handoff.mjs" stop');
  });
});

describe('SessionStart', () => {
  it('prints nothing with RENOR_HANDOFF_NOTE unset', () => {
    expect(run('session-start', { session_id: 'off', source: 'startup', cwd: repo }, { RENOR_HANDOFF_NOTE: '' })).toBeNull();
  });

  it('asks for this repo and branch\'s note once per session, credentials dropped', () => {
    const out = run('session-start', { session_id: 's1', source: 'startup', cwd: repo });
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(text).toContain('{"action": "read", "repo": "https://github.com/acme/fjord.git", "branch": "main"}');
    expect(text).not.toMatch(/alice|ghp_/);
    // The same session again (a second copy of the hook, or a re-fire): nothing.
    expect(run('session-start', { session_id: 's1', source: 'startup', cwd: repo })).toBeNull();
  });

  it('is silent on resume and compact, outside a repo, and on a detached HEAD', () => {
    expect(run('session-start', { session_id: 's2', source: 'resume', cwd: repo })).toBeNull();
    expect(run('session-start', { session_id: 's3', source: 'compact', cwd: repo })).toBeNull();
    expect(run('session-start', { session_id: 's4', source: 'startup', cwd: root })).toBeNull();
    execFileSync('git', ['-C', repo, 'checkout', '-q', '--detach']);
    try {
      expect(run('session-start', { session_id: 's4b', source: 'startup', cwd: repo })).toBeNull();
    } finally { execFileSync('git', ['-C', repo, 'checkout', '-q', 'main']); }
    expect(run('session-start', { session_id: 's5', source: 'clear', cwd: repo })).not.toBeNull();
  });

  it('a branch is its own key', () => {
    execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature/x']);
    try {
      const out = run('session-start', { session_id: 's6', source: 'startup', cwd: repo });
      expect(out.hookSpecificOutput.additionalContext).toContain('"branch": "feature/x"');
    } finally { execFileSync('git', ['-C', repo, 'checkout', '-q', 'main']); }
  });
});

describe('Stop', () => {
  it('asks for a write after tool use, then not again inside the interval, and never while a stop hook is active', () => {
    const t = transcript([toolUse('Edit')]);
    expect(run('stop', { session_id: 'p1', cwd: repo, transcript_path: t, stop_hook_active: true })).toBeNull();
    const out = run('stop', { session_id: 'p1', cwd: repo, transcript_path: t, stop_hook_active: false });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('{"action": "write", "repo": "https://github.com/acme/fjord.git", "branch": "main", "note": "..."}');
    expect(out.reason).toContain('at most 200 words');
    fs.appendFileSync(t, '\n' + JSON.stringify(toolUse('Bash')));
    expect(run('stop', { session_id: 'p1', cwd: repo, transcript_path: t })).toBeNull();
    // Past the interval, with new tool use: asked again.
    expect(run('stop', { session_id: 'p1', cwd: repo, transcript_path: t }, { RENOR_HANDOFF_EVERY_MINUTES: '0' })?.decision).toBe('block');
  });

  it('does not ask when nothing was done, when off, or when the agent already wrote the note', () => {
    expect(run('stop', { session_id: 'p2', cwd: repo, transcript_path: transcript([{ type: 'user' }]) })).toBeNull();
    expect(run('stop', { session_id: 'p3', cwd: repo, transcript_path: transcript([toolUse('Edit')]) }, { RENOR_HANDOFF_NOTE: '0' })).toBeNull();
    const wrote = transcript([toolUse('Edit'), toolUse('mcp__renor__handoff_note', { action: 'write', repo: 'r', branch: 'main', note: 'n' })]);
    expect(run('stop', { session_id: 'p4', cwd: repo, transcript_path: wrote })).toBeNull();
  });

  it('refuses an attacker-precreated state directory and never writes through a symlinked state file', ({ skip }) => {
    if (typeof process.getuid !== 'function') skip('POSIX uid and mode bits do not exist on native Windows');
    const victim = path.join(root, 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    const open = path.join(root, 'open-dir');
    fs.mkdirSync(open, { mode: 0o777 });
    fs.chmodSync(open, 0o777);
    // The tmpdir fallback is strict: a pre-existing open directory is refused.
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(path.join(tmp, `renor-handoff-${process.getuid!()}`), { recursive: true, mode: 0o777 });
    fs.chmodSync(path.join(tmp, `renor-handoff-${process.getuid!()}`), 0o777);
    const noPlugin = { CLAUDE_PLUGIN_DATA: '', TMPDIR: tmp };
    expect(run('session-start', { session_id: 'x1', cwd: repo, source: 'startup' }, noPlugin)).toBeNull();
    expect(fs.readdirSync(path.join(tmp, `renor-handoff-${process.getuid!()}`))).toEqual([]);

    // The host-created CLAUDE_PLUGIN_DATA is usually 0755: still works.
    const host = path.join(root, 'host-dir');
    fs.mkdirSync(host, { mode: 0o755 });
    fs.chmodSync(host, 0o755);
    expect(run('session-start', { session_id: 'x0', cwd: repo, source: 'startup' }, { CLAUDE_PLUGIN_DATA: host })?.hookSpecificOutput).toBeTruthy();

    const mine = path.join(root, 'mine-dir');
    fs.mkdirSync(mine, { mode: 0o700 });
    fs.symlinkSync(victim, path.join(mine, 'x2.start.json'));
    run('session-start', { session_id: 'x2', cwd: repo, source: 'startup' }, { CLAUDE_PLUGIN_DATA: mine });
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
  });
});
