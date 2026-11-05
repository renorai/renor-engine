/**
 * Runtime footprint (issue #1442): Bun vs Node 22 for the self-hosted engine, and the local cost of the hosted path.
 * Measurement only: no model calls, no network beyond the package install in --install, no production endpoint.
 *
 *   npm run build                    # the stdio and HTTP paths run the compiled dist/
 *   npx tsx scripts/eval/runtime-footprint/run.ts [--runs 5] [--calls 1000] [--notes 2000] [--out <dir>]
 *        [--bun-version 1.4.4] [--install] [--suite] [--skip-part2] [--skip-part1] [--cli <path to cli/bin/renor.mjs>]
 *
 * Part 1, per runtime, alternating node/bun each run:
 *   stdio  `dist/cli.js mcp`: spawn -> first tools/list; RSS idle; RSS after N `search` calls (keyword-only, no embedding model).
 *   http   `dist/mvp/cli.js`: spawn -> first reply from the MCP endpoint (an unauthenticated POST answers 401, which proves the
 *          server is up and routing; a credential-free box cannot do the OAuth sign-in). RSS idle.
 *   mvp    in-process `get_context` and `search_memory` p50/p95 and RSS after N calls (loads TypeScript source: tsx under Node,
 *          native under Bun, so its start time compares loaders and is not reported).
 * --install: a clean production install per package manager (`npm ci --omit=dev` vs `bun install --production`), sizes of node_modules and of the runtime binary.
 * --suite: the full engine suite under Bun (`bun --bun vitest run`), pass/fail counts and every failing test with a one-line cause.
 * Part 2 (needs the repository's cli/): `renor setup --capture` into a throwaway HOME with RENOR_MCP_URL pointing at a local stub;
 *   lists processes left running, and times each installed hook (median of 20). `renor connect` needs the real client app, so it is not run.
 *
 * Writes <out>/runtime-footprint.json and <out>/runtime-footprint.md.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { procMb, percentile, queryList, renderMarkdown, rpcClient, runMeasured, summarize, type InstallRow, type Part2, type Report, type Row, type SuiteResult } from './lib.js';

const ENGINE = path.resolve(__dirname, '../../..');
const REPO = path.resolve(ENGINE, '..');
const SELF = __filename;

// ---- child: in-process mvp surface ------------------------------------------------------------

async function childMvp(): Promise<void> {
  const { openWorkspace } = await import('../../bench/mcp-latency.js');
  const { EvalHashEmbeddingProvider } = await import('../../../src/eval/hashEmbedding.js');
  const calls = Number(process.env.FP_CALLS);
  const auth = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-auth-'));
  const ws = await openWorkspace(process.env.FP_DIR!, Object.assign(new EvalHashEmbeddingProvider(), { dimensions: Number(process.env.FP_DIMS) }), auth);
  await ws.client.listTools();
  const rssIdle = procMb(process.pid);
  const qs = queryList(calls);
  const out: Record<string, number> = { mvpRssIdleMb: rssIdle };
  for (const [tool, key] of [['get_context', 'getContext'], ['search_memory', 'search']] as const) {
    const lat: number[] = [];
    for (const q of qs) { const t = performance.now(); await ws.client.callTool({ name: tool, arguments: { query: q } }); lat.push(performance.now() - t); }
    out[`${key}P50`] = percentile(lat, 0.5); out[`${key}P95`] = percentile(lat, 0.95);
  }
  out.mvpRssAfterMb = procMb(process.pid);
  process.stdout.write('FP ' + JSON.stringify(out) + '\n');
  await ws.close();
  process.exit(0);
}

// ---- part 1 -----------------------------------------------------------------------------------

const copyDir = (src: string, tag: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `fp-${tag}-`)); fs.cpSync(src, d, { recursive: true }); return d; };
const rm = (d: string) => fs.rmSync(d, { recursive: true, force: true });
const cleanEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k];
  return { ...env, RENOR_TELEMETRY: 'off', ...extra };
};

async function stdioRun(rt: string, vault: string, calls: number): Promise<Record<string, number>> {
  const dir = copyDir(vault, 'stdio');
  const t0 = performance.now();
  const child = spawn(rt, [path.join(ENGINE, 'dist/cli.js'), 'mcp'], { cwd: dir, env: cleanEnv({ VAULT_PATH: dir, EMBEDDING_PROVIDER: 'none' }), stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    const r = rpcClient(child);
    await r.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fp', version: '0' } }, 120_000);
    r.notify('notifications/initialized');
    await r.call('tools/list', {}, 120_000);
    const stdioStartMs = performance.now() - t0;
    const rssIdleMb = procMb(child.pid!);
    for (const q of queryList(calls)) await r.call('tools/call', { name: 'search', arguments: { query: q } });
    return { stdioStartMs, rssIdleMb, rssAfterMb: procMb(child.pid!) };
  } finally { child.kill('SIGKILL'); rm(dir); }
}

/** The engine logs one JSON line per event; the startup_failed line's message is the cause. */
function startupError(tail: string): string {
  const line = tail.split('\n').reverse().find(l => l.includes('startup_failed')) ?? tail.trim().split('\n').pop() ?? '';
  try { const m = JSON.parse(line)?.err?.message; if (m) return String(m).slice(0, 200); } catch { /* not JSON */ }
  return line.slice(0, 200);
}

async function freePort(): Promise<number> {
  return new Promise(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}

async function httpRun(rt: string, vault: string): Promise<Record<string, number>> {
  const dir = copyDir(vault, 'http');
  const port = await freePort();
  const secret = crypto.randomBytes(18).toString('base64');
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-httpauth-')); // mkdtemp makes it 0700, which the client store requires
  const t0 = performance.now();
  const child = spawn(rt, [path.join(ENGINE, 'dist/mvp/cli.js')], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv({ MVP_MEMORY_DIR: dir, MVP_AUTH_STATE_PATH: path.join(authDir, 'clients.json'), MVP_BASE_URL: `http://127.0.0.1:${port}`, MVP_PORT: String(port), MVP_HOST: '127.0.0.1', MVP_OWNER_EMAIL: 'fp@example.test', MVP_OWNER_PASSWORD: secret, MVP_ALLOWED_CALLBACK_URIS: `http://127.0.0.1:${port}/callback` }),
  });
  let tail = '', exited: number | null | undefined;
  for (const st of [child.stdout!, child.stderr!]) st.on('data', d => { tail = (tail + d).slice(-4000); });
  child.on('exit', c => { exited = c; });
  try {
    for (;;) {
      if (exited !== undefined) throw new Error(`HTTP server exited (${exited}) before answering: ${startupError(tail)}`);
      if (performance.now() - t0 > 120_000) throw new Error('HTTP server did not answer in 120 s');
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
        await res.arrayBuffer();
        break;
      } catch { await new Promise(r => setTimeout(r, 5)); }
    }
    const httpStartMs = performance.now() - t0;
    await new Promise(r => setTimeout(r, 500));
    return { httpStartMs, httpRssIdleMb: procMb(child.pid!) };
  } finally { child.kill('SIGKILL'); rm(dir); rm(authDir); }
}

function mvpRun(rt: string, memoryDir: string, calls: number, dims: number): Record<string, number> {
  const dir = copyDir(memoryDir, 'mvp');
  const cmd = rt === 'bun' ? ['bun', SELF] : [path.join(ENGINE, 'node_modules/.bin/tsx'), SELF];
  const p = spawnSync(cmd[0], cmd.slice(1), { env: { ...process.env, FP_CHILD: 'mvp', FP_DIR: dir, FP_CALLS: String(calls), FP_DIMS: String(dims) }, encoding: 'utf8', timeout: 900_000 });
  rm(dir);
  const line = p.stdout.split('\n').find(l => l.startsWith('FP '));
  if (!line) throw new Error(`in-process run under ${rt} failed: ${(p.stderr || p.stdout).slice(-500)}`);
  return JSON.parse(line.slice(3));
}

// ---- install and suite ------------------------------------------------------------------------

const duMb = (p: string): number => { const r = spawnSync('du', ['-sk', p], { encoding: 'utf8' }); return Number(r.stdout.split('\t')[0]) / 1024; };
const binMb = (name: string): number => { const w = spawnSync('which', [name], { encoding: 'utf8' }).stdout.trim(); return w ? fs.statSync(fs.realpathSync(w)).size / 1048576 : NaN; };

function installRun(tool: 'npm' | 'bun'): InstallRow | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-install-'));
  try {
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ENGINE, f), path.join(dir, f));
    const t0 = performance.now();
    const args = tool === 'npm' ? ['npm', 'ci', '--omit=dev', '--ignore-scripts=false'] : ['bun', 'install', '--production'];
    const r = spawnSync(args[0], args.slice(1), { cwd: dir, encoding: 'utf8', timeout: 900_000 });
    if (r.status !== 0) return null;
    return { tool: tool === 'npm' ? 'npm ci' : 'bun install', nodeModulesMb: duMb(path.join(dir, 'node_modules')), runtimeMb: binMb(tool === 'npm' ? 'node' : 'bun'), seconds: (performance.now() - t0) / 1000 };
  } finally { rm(dir); }
}

function suiteRun(): SuiteResult | null {
  const out = path.join(os.tmpdir(), `fp-suite-${process.pid}.json`);
  spawnSync('bun', ['--bun', 'node_modules/.bin/vitest', 'run', '--reporter=json', `--outputFile=${out}`], { cwd: ENGINE, encoding: 'utf8', timeout: 3 * 3600_000, maxBuffer: 1 << 28 });
  if (!fs.existsSync(out)) return null;
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(out, { force: true });
  const failing: SuiteResult['failing'] = [];
  for (const f of j.testResults ?? []) {
    if (f.status === 'failed' && !(f.assertionResults ?? []).some((a: any) => a.status === 'failed')) failing.push({ name: `${path.relative(ENGINE, f.name)} (file did not load)`, cause: oneLine(f.message) });
    for (const a of f.assertionResults ?? []) if (a.status === 'failed') failing.push({ name: `${path.relative(ENGINE, f.name)}: ${a.fullName}`, cause: oneLine((a.failureMessages ?? [])[0]) });
  }
  return { runtime: `Bun ${spawnSync('bun', ['-v'], { encoding: 'utf8' }).stdout.trim()}`, passed: j.numPassedTests ?? 0, failed: j.numFailedTests ?? 0, files: j.numTotalTestSuites ?? 0, failing };
}
const oneLine = (s: unknown): string => String(s ?? 'no message').split('\n').find(l => l.trim()) ?.trim().slice(0, 200) ?? 'no message';

// ---- part 2 -----------------------------------------------------------------------------------

function listProcs(): Map<number, { command: string; rssMb: number }> {
  const m = new Map<number, { command: string; rssMb: number }>();
  for (const d of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
    try { m.set(Number(d), { command: fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim().slice(0, 120), rssMb: procMb(Number(d)) }); } catch { /* gone */ }
  }
  return m;
}

async function part2(cliPath: string, runs: number): Promise<Part2> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-home-'));
  const stub = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise<void>(r => stub.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(stub.address() as any).port}/mcp`;
  const env = cleanEnv({ HOME: home, RENOR_MCP_URL: url });
  try {
    const before = listProcs();
    const r = await runMeasured('node', [cliPath, 'setup', '--capture', '--yes', '--no-login', '--no-skill'], { env, cwd: home });
    if (r.code !== 0) throw new Error(`renor setup --capture failed (${r.code}): ${(r.stderr || r.stdout).slice(-300)}`);
    await new Promise(res => setTimeout(res, 1000));
    const leftover = [...listProcs()].filter(([pid, p]) => !before.has(pid) && !p.command.includes('fp-')).filter(([pid]) => pid !== process.pid)
      .map(([pid, p]) => ({ pid, ...p })).filter(p => !/\b(ps|sh|bash)\b/.test(p.command.split(' ')[0] ?? ''));
    // The installed hooks, as Claude Code's settings now name them.
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const inputs: Record<string, object> = {
      SessionStart: { hook_event_name: 'SessionStart', session_id: 'fp', source: 'startup', cwd: home },
      UserPromptSubmit: { hook_event_name: 'UserPromptSubmit', session_id: 'fp', prompt: 'what did we decide about billing', cwd: home },
      PostToolUse: { hook_event_name: 'PostToolUse', session_id: 'fp', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '' }, cwd: home },
      Stop: { hook_event_name: 'Stop', session_id: 'fp', stop_hook_active: false, cwd: home },
    };
    const hooks: Part2['hooks'] = [];
    const notInstalled: string[] = [];
    for (const event of Object.keys(inputs)) {
      const cmds: string[] = (settings.hooks?.[event] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command as string)).filter(Boolean);
      if (cmds.length === 0) { notInstalled.push(event); continue; }
      for (const command of cmds) {
        const walls: number[] = [], rss: number[] = [];
        for (let i = 0; i < runs; i++) {
          const m = await runMeasured('sh', ['-c', 'exec ' + command], { env, cwd: home, input: JSON.stringify(inputs[event]) });
          walls.push(m.wallMs); rss.push(m.peakRssMb);
        }
        hooks.push({ event, command: command.replace(home, '~'), wall: summarize(walls), peakRssMb: summarize(rss) });
      }
    }
    return { leftoverProcesses: leftover, hooks, notInstalled };
  } finally { stub.close(); rm(home); }
}

// ---- main -------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const a = process.argv.slice(2);
  const opt = (k: string, d: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const runs = Number(opt('--runs', '5')), calls = Number(opt('--calls', '1000')), notes = Number(opt('--notes', '2000'));
  const out = path.resolve(opt('--out', path.join(ENGINE, '.eval-runs/runtime-footprint')));
  const cli = path.resolve(opt('--cli', path.join(REPO, 'cli/bin/renor.mjs')));
  const dims = 64;
  fs.mkdirSync(out, { recursive: true });
  const bunV = spawnSync('bun', ['-v'], { encoding: 'utf8' });
  const bun = bunV.status === 0 ? bunV.stdout.trim() : null;
  const notices: string[] = [];
  const pin = opt('--bun-version', '');
  if (pin && bun !== pin) notices.push(`Bun is ${bun ?? 'not installed'}, not the pinned ${pin}: the Bun column is not the pinned version.`);
  if (!bun) notices.push('Bun is not installed: the Bun column is empty.');
  if (!fs.existsSync(path.join(ENGINE, 'dist/cli.js'))) throw new Error('dist/ is missing: run `npm run build` first.');
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim() + (spawnSync('git', ['status', '--porcelain', '--', 'engine'], { cwd: REPO, encoding: 'utf8' }).stdout.trim() ? '+dirty' : '');

  const part1: Report['part1'] = { node: null, bun: null };
  if (!a.includes('--skip-part1')) {
    // One seeded vault of `notes` synthetic notes, built once; every run works on its own copy.
    const { ensureFixture } = await import('../../bench/mcp-latency.js');
    const fixDir = path.join(os.tmpdir(), 'fp-fixture');
    const auth = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-fixauth-'));
    const { memoryDir } = await ensureFixture({ sizes: [notes], runs: 1, embeddings: 'hash', dims, dir: fixDir }, notes, auth, l => console.error(l));
    const rts = bun ? ['node', 'bun'] : ['node'];
    const acc: Record<string, Record<string, number[]>> = { node: {}, bun: {} };
    for (let i = 0; i < runs; i++) for (const rt of rts) {
      const rec: Record<string, number> = {};
      for (const [name, f] of [['stdio', () => stdioRun(rt, memoryDir, calls)], ['http', () => httpRun(rt, memoryDir)], ['in-process mvp', async () => mvpRun(rt, memoryDir, calls, dims)]] as const) {
        try { Object.assign(rec, await f()); } catch (e) {
          const msg = `${rt}, ${name}: ${(e as Error).message.split('\n')[0]}`;
          if (!notices.includes(msg)) notices.push(msg);
        }
      }
      for (const [k, v] of Object.entries(rec)) (acc[rt][k] ??= []).push(v);
      console.error(`run ${i + 1}/${runs} ${rt} done`);
    }
    for (const rt of rts as ('node' | 'bun')[]) part1[rt] = Object.fromEntries(Object.entries(acc[rt]).map(([k, v]) => [k, summarize(v)])) as Row;
  }
  const install = { node: null as InstallRow | null, bun: null as InstallRow | null };
  if (a.includes('--install')) { install.node = installRun('npm'); if (bun) install.bun = installRun('bun'); }
  const suite = a.includes('--suite') && bun ? suiteRun() : null;
  const p2 = a.includes('--skip-part2') ? null : await part2(cli, 20).catch(e => { notices.push(`Part 2 failed: ${(e as Error).message}`); return null; });

  const report: Report = { commit, runs, calls, notes, cpus: os.cpus().length, versions: { node: process.version, bun }, part1, install, suite, part2: p2, notices };
  fs.writeFileSync(path.join(out, 'runtime-footprint.json'), JSON.stringify(report, null, 2) + '\n');
  const md = renderMarkdown(report);
  fs.writeFileSync(path.join(out, 'runtime-footprint.md'), md + '\n');
  console.log(md);
}

if (process.env.FP_CHILD === 'mvp') childMvp().catch(e => { console.error(e); process.exit(1); });
else if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
