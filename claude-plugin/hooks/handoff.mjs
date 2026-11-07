#!/usr/bin/env node
// Renor handoff note hooks for Claude Code (I6). Default off: they do nothing unless RENOR_HANDOFF_NOTE is 1, true, yes
// or on, matching the engine flag that publishes the `handoff_note` tool.
//
//   node handoff.mjs session-start   SessionStart (startup, clear): asks the agent to read this repo and branch's note
//                                    and show it once, with its date and writer.
//   node handoff.mjs stop            Stop: at most once per RENOR_HANDOFF_EVERY_MINUTES (default 30), and only after new
//                                    tool use, asks the agent to overwrite the note (at most 200 words).
//
// A hook holds no Renor credential (hosted sign-in is OAuth inside Claude Code), so it cannot read or write the note
// itself: it hands the agent the exact call, with the repo and branch it read from git. SessionEnd cannot make the agent
// act, so the write rides on Stop. Each hook prints at most one block per session and event, so a second copy of this
// hook (plugin plus settings) or a sibling SessionStart hook never injects the note twice. No dependencies.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function enabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.RENOR_HANDOFF_NOTE ?? '').trim().toLowerCase());
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch {
    return '';
  }
}

/** The repo (origin's URL, else the work tree's path) and branch of `cwd`, or null outside a repo or on a detached HEAD. */
export function repoAndBranch(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') return null;
  // The engine drops credentials from the URL before storing it; drop them here too, so they never reach the transcript.
  const remote = git(cwd, ['remote', 'get-url', 'origin']).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  return { repo: remote || top, branch };
}

function stateFile(env, sessionId, event) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  const dir = env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), `renor-handoff-${uid}`);
  const strict = !env.CLAUDE_PLUGIN_DATA;
  const safe = String(sessionId || 'no-session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  return { dir, strict, file: path.join(dir, `${safe}.${event}.json`) };
}

/** True only for a real directory (not a symlink) that this user owns; with strictMode, also one nobody else can read or write.
 *  The host creates CLAUDE_PLUGIN_DATA (often 0755), so only the tmpdir fallback needs strictMode. */
function privateDir(dir, strictMode = true) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) return false;
  if (typeof process.getuid === 'function' && (st.uid !== process.getuid() || (strictMode && (st.mode & 0o077) !== 0))) return false;
  return true;
}

function readState(env, sessionId, event) {
  try {
    const { dir, file, strict } = stateFile(env, sessionId, event);
    if (!privateDir(dir, strict) || !fs.lstatSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function writeState(env, sessionId, event, value) {
  const { dir, file, strict } = stateFile(env, sessionId, event);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!privateDir(dir, strict)) return false;
    // Write a fresh file that refuses symlinks, then rename it over the state file: rename replaces a planted symlink
    // itself and never writes through it.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, JSON.stringify(value)); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Tool calls in the transcript so far, and whether handoff_note was written after `fromLine`. Cheap string counts. */
function transcriptActivity(transcriptPath, fromLine = 0) {
  let lines = [];
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return { lines: 0, toolUses: 0, wroteNote: false }; }
  let toolUses = 0;
  let wroteNote = false;
  lines.forEach((line, i) => {
    const uses = line.match(/"type":\s*"tool_use"/g)?.length ?? 0;
    toolUses += uses;
    if (i >= fromLine && uses && /handoff_note/.test(line) && /\\?"action\\?":\s*\\?"write/.test(line)) wroteNote = true;
  });
  return { lines: lines.length, toolUses, wroteNote };
}

const quote = (value) => JSON.stringify(value);

/** What SessionStart prints, or '' for nothing. `input` is the hook's stdin JSON. */
export function sessionStart(input, env = process.env, now = Date.now()) {
  if (!enabled(env)) return '';
  if (!['startup', 'clear'].includes(input.source ?? 'startup')) return '';
  const where = repoAndBranch(input.cwd || process.cwd());
  if (!where) return '';
  if (readState(env, input.session_id, 'start')) return '';
  if (!writeState(env, input.session_id, 'start', { at: now })) return '';
  const call = `{"action": "read", "repo": ${quote(where.repo)}, "branch": ${quote(where.branch)}}`;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `Renor handoff note: before you answer the first request, call Renor's handoff_note tool with ${call}. `
        + 'If it returns found: true, show the user its "shown" text once, as the last session\'s status on this branch, and check it against the code before relying on it. '
        + 'If found is false or the tool is missing, say nothing about it. Never save the note with remember or any memory tool.',
    },
  });
}

/** What Stop prints, or '' to let Claude stop. */
export function stop(input, env = process.env, now = Date.now()) {
  if (!enabled(env) || input.stop_hook_active) return '';
  const where = repoAndBranch(input.cwd || process.cwd());
  if (!where) return '';
  const minutes = Number(env.RENOR_HANDOFF_EVERY_MINUTES);
  const everyMs = (env.RENOR_HANDOFF_EVERY_MINUTES?.trim() && Number.isFinite(minutes) && minutes >= 0 ? minutes : 30) * 60_000;
  const last = readState(env, input.session_id, 'stop') ?? { at: 0, toolUses: 0, line: 0 };
  const activity = transcriptActivity(input.transcript_path, last.line);
  // Nothing done since the last ask, or the agent already wrote the note itself: no ask.
  if (activity.wroteNote) { writeState(env, input.session_id, 'stop', { at: now, toolUses: activity.toolUses, line: activity.lines }); return ''; }
  if (activity.toolUses <= last.toolUses) return '';
  if (last.at && now - last.at < everyMs) return '';
  if (!writeState(env, input.session_id, 'stop', { at: now, toolUses: activity.toolUses, line: activity.lines })) return '';
  const call = `{"action": "write", "repo": ${quote(where.repo)}, "branch": ${quote(where.branch)}, "note": "..."}`;
  return JSON.stringify({
    decision: 'block',
    reason:
      `Renor handoff note: call Renor's handoff_note tool with ${call}. The note, at most 200 words, is for the next session on this branch: `
      + 'what was in progress, the next step, open questions. It replaces the last note; write only what is still true. '
      + 'Then stop without repeating it to the user. If the tool is missing, just stop.',
  });
}

async function main() {
  const event = process.argv[2];
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* a hook never fails the session */ }
  const out = event === 'session-start' ? sessionStart(input) : event === 'stop' ? stop(input) : '';
  if (out) process.stdout.write(out + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main().catch(() => process.exit(0));
