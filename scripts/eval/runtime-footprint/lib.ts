/**
 * Pure helpers for the runtime-footprint script (issue #1442): statistics, a /proc reader, a JSON-RPC line client
 * and the report renderers. Nothing here makes a network or model call.
 */
import fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Nearest-rank percentile, p in [0,1]. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

export interface Summary { n: number; median: number; min: number; max: number }
export function summarize(xs: number[]): Summary {
  const ok = xs.filter(Number.isFinite);
  return { n: ok.length, median: median(ok), min: ok.length ? Math.min(...ok) : NaN, max: ok.length ? Math.max(...ok) : NaN };
}

/** `median (min-max)`, one decimal; "n/a" when nothing was measured. */
export function fmt(s: Summary | undefined, digits = 1): string {
  if (!s || s.n === 0) return 'n/a';
  const f = (x: number) => x.toFixed(digits);
  return s.n === 1 ? f(s.median) : `${f(s.median)} (${f(s.min)}-${f(s.max)})`;
}

/** Resident set size in MB from /proc, NaN where /proc is missing or the process is gone. */
export function procMb(pid: number, field: 'VmRSS' | 'VmHWM' = 'VmRSS'): number {
  try {
    const m = new RegExp(`${field}:\\s+(\\d+) kB`).exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) / 1024 : NaN;
  } catch {
    return NaN;
  }
}

/** Run a command to completion, polling its high-water RSS (VmHWM) while it lives. wallMs is spawn to exit. */
export async function runMeasured(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs?: number } = {}):
  Promise<{ wallMs: number; peakRssMb: number; code: number | null; stdout: string; stderr: string }> {
  const t0 = performance.now();
  const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', peak = NaN;
  child.stdout!.on('data', d => { stdout += d; });
  child.stderr!.on('data', d => { stderr += d; });
  child.stdin!.on('error', () => {});
  child.stdin!.end(opts.input ?? '');
  const poll = setInterval(() => { const v = procMb(child.pid!, 'VmHWM'); if (Number.isFinite(v) && !(v < peak)) peak = v; }, 3);
  const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000);
  const code = await new Promise<number | null>(res => child.on('close', c => res(c)));
  clearInterval(poll); clearTimeout(killer);
  return { wallMs: performance.now() - t0, peakRssMb: peak, code, stdout, stderr };
}

/** Minimal newline-delimited JSON-RPC client over a child's stdio (the MCP stdio transport). */
export function rpcClient(child: ChildProcess) {
  let buf = '';
  const waiters = new Map<number, (m: any) => void>();
  child.stdout!.on('data', d => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch { /* a log line */ }
    }
  });
  let id = 0;
  return {
    call: (method: string, params: unknown = {}, timeoutMs = 60_000) => new Promise<any>((res, rej) => {
      const k = ++id;
      const to = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeoutMs);
      waiters.set(k, m => { clearTimeout(to); res(m); });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n');
    }),
    notify: (method: string) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
  };
}

/** The fixed query list for the 1,000 calls: deterministic, no randomness. */
export function queryList(n: number): string[] {
  const base = ['what did we decide about billing', 'status of the gateway rollout', 'who owns the onboarding project', 'project deploy logging', 'pricing decision previously', 'incident follow-ups security', 'roadmap research embeddings', 'hiring support mobile'];
  return Array.from({ length: n }, (_, i) => `${base[i % base.length]} project-${i % 150}`);
}

// ---- report ---------------------------------------------------------------------

export type Row = Record<string, Summary | undefined>;
export interface Report {
  commit: string;
  runs: number;
  calls: number;
  notes: number;
  cpus: number;
  versions: { node: string; bun: string | null };
  part1: Record<'node' | 'bun', Row | null>;
  install: { node: InstallRow | null; bun: InstallRow | null };
  suite: SuiteResult | null;
  part2: Part2 | null;
  notices: string[];
}
export interface InstallRow { tool: string; nodeModulesMb: number; runtimeMb: number; seconds: number }
export interface SuiteResult { runtime: string; passed: number; failed: number; files: number; failing: { name: string; cause: string }[] }
export interface Part2 {
  leftoverProcesses: { pid: number; command: string; rssMb: number }[];
  hooks: { event: string; command: string; wall: Summary; peakRssMb: Summary }[];
  notInstalled: string[];
}

const ROWS: [string, string][] = [
  ['stdioStartMs', 'Cold start, stdio: spawn to first `tools/list` reply (ms)'],
  ['httpStartMs', 'Cold start, HTTP server: spawn to first MCP-endpoint reply (ms)'],
  ['rssIdleMb', 'RSS idle after start, stdio server (MB)'],
  ['rssAfterMb', 'RSS after the calls, stdio server, `search` (MB)'],
  ['httpRssIdleMb', 'RSS idle after start, HTTP server (MB)'],
  ['mvpRssIdleMb', 'RSS idle after start, in-process mvp surface (MB)'],
  ['mvpRssAfterMb', 'RSS after the calls, in-process mvp surface (MB)'],
  ['getContextP50', '`get_context` p50 (ms)'],
  ['getContextP95', '`get_context` p95 (ms)'],
  ['searchP50', '`search_memory` p50 (ms)'],
  ['searchP95', '`search_memory` p95 (ms)'],
];

export function renderMarkdown(r: Report): string {
  const L: string[] = [];
  L.push(`# Runtime footprint`, '');
  L.push(`Commit \`${r.commit}\`. Node ${r.versions.node}, Bun ${r.versions.bun ?? 'not installed'}. ${r.cpus} CPUs. ${r.notes} synthetic notes, ${r.runs} runs each, ${r.calls} calls per run. Median (min-max).`, '');
  for (const n of r.notices) L.push(`> ${n}`);
  if (r.notices.length) L.push('');
  L.push('## Part 1: self-hosted engine', '', '| Measure | Node 22 | Bun |', '| --- | --- | --- |');
  for (const [k, label] of ROWS) L.push(`| ${label} | ${fmt(r.part1.node?.[k])} | ${fmt(r.part1.bun?.[k])} |`);
  const ins = (x: InstallRow | null, f: (i: InstallRow) => string) => (x ? f(x) : 'n/a');
  L.push(`| Install: \`node_modules\` after a clean production install (MB) | ${ins(r.install.node, i => `${i.nodeModulesMb.toFixed(0)} (${i.tool}, ${i.seconds.toFixed(0)} s)`)} | ${ins(r.install.bun, i => `${i.nodeModulesMb.toFixed(0)} (${i.tool}, ${i.seconds.toFixed(0)} s)`)} |`);
  L.push(`| Runtime binary size (MB) | ${ins(r.install.node, i => i.runtimeMb.toFixed(0))} | ${ins(r.install.bun, i => i.runtimeMb.toFixed(0))} |`, '');
  if (r.suite) {
    L.push(`### Test suite under ${r.suite.runtime}`, '', `${r.suite.passed} passed, ${r.suite.failed} failed (${r.suite.files} files). No test skipped or edited.`, '');
    if (r.suite.failing.length) { L.push('| Failing test | Cause |', '| --- | --- |'); for (const f of r.suite.failing) L.push(`| ${f.name.replace(/\|/g, '\\|')} | ${f.cause.replace(/\|/g, '\\|')} |`); L.push(''); }
  } else L.push('Test suite: not run (pass `--suite`).', '');
  if (r.part2) {
    L.push('## Part 2: hosted path, local footprint', '', '### Processes left running after `renor setup --capture`', '');
    if (r.part2.leftoverProcesses.length === 0) L.push('None.', '');
    else { L.push('| PID | Command | RSS (MB) |', '| --- | --- | --- |'); for (const p of r.part2.leftoverProcesses) L.push(`| ${p.pid} | ${p.command} | ${p.rssMb.toFixed(1)} |`); L.push(''); }
    L.push('### One hook run', '', '| Event | Wall (ms) | Peak RSS (MB) |', '| --- | --- | --- |');
    for (const h of r.part2.hooks) L.push(`| ${h.event} | ${fmt(h.wall)} | ${fmt(h.peakRssMb)} |`);
    for (const e of r.part2.notInstalled) L.push(`| ${e} | not installed by \`renor setup --capture\` | not installed |`);
    L.push('');
  }
  return L.join('\n');
}
