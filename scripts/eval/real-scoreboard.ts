import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';

/**
 * Weekly real-world scoreboard: aggregates of the opt-in `shared_signal_rows`, split by Renor release.
 *
 * Privacy: the output holds counts, rates and intervals only. No row body, query, text, contributor id or workspace id is ever
 * printed. A cell backed by fewer than MIN_CONTRIBUTORS distinct contributors is suppressed (its numbers are not emitted).
 * The database is read through a read-only connection string held in an environment variable named on the command line;
 * the string is handed to psql through the child's environment, never on its command line, and never printed.
 *
 * A signal row carries no release of its own (only retrieval rows carry a `build`), so a release is a window of `received_at`:
 * the operator supplies `--releases` as JSON `[{"release":"1.4.0","since":"2026-10-29T00:00:00Z"}, ...]`.
 */

export const MIN_CONTRIBUTORS = 3;

export interface SignalRow {
  /** Opaque contributor id; used only to count distinct contributors, never output. */
  contributor: string;
  /** ISO timestamp the row was received. */
  receivedAt: string;
  body: Record<string, unknown>;
}
export interface ReleaseWindow { release: string; since: string }

export interface Rate { n: number; of: number; rate: number; lo: number; hi: number }
export type Cell<T> = { suppressed: true; contributors: number } | ({ suppressed: false; contributors: number } & T);

export interface ReleaseReport {
  release: string;
  rows: number;
  contributors: number;
  retrievalMiss: Cell<Rate & { meanReplyTokensBucket: number | null }>;
  saveOutcome: Cell<{ rows: number; opened: Rate; cited: Rate; superseded: Rate; retired: Rate }>;
  sessions: Cell<{ sessions: number; emptyReadSessions: Rate; readsBuckets: Record<string, number>; savesBuckets: Record<string, number> }>;
}
export interface Scoreboard {
  generatedAt: string;
  minContributors: number;
  notRecorded: string[];
  releases: ReleaseReport[];
}

/** Wilson score interval at 95%. */
export function wilson(k: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

function rate(k: number, n: number): Rate {
  const { lo, hi } = wilson(k, n);
  return { n: k, of: n, rate: n === 0 ? 0 : k / n, lo, hi };
}

function releaseOf(receivedAt: string, windows: ReleaseWindow[]): string {
  const t = Date.parse(receivedAt);
  let best: ReleaseWindow | null = null;
  for (const w of windows) {
    const s = Date.parse(w.since);
    if (s <= t && (best === null || s > Date.parse(best.since))) best = w;
  }
  return best ? best.release : 'unassigned';
}

function cell<T>(rows: SignalRow[], build: (rows: SignalRow[]) => T): Cell<T> {
  const contributors = new Set(rows.map((r) => r.contributor)).size;
  if (contributors < MIN_CONTRIBUTORS) return { suppressed: true, contributors };
  return { suppressed: false, contributors, ...build(rows) };
}

function tally(values: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) if (typeof v === 'string') out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function buildScoreboard(rows: SignalRow[], windows: ReleaseWindow[], now: Date = new Date()): Scoreboard {
  const byRelease = new Map<string, SignalRow[]>();
  for (const r of rows) {
    const rel = releaseOf(r.receivedAt, windows);
    if (!byRelease.has(rel)) byRelease.set(rel, []);
    byRelease.get(rel)!.push(r);
  }
  const order = [...windows.map((w) => w.release), 'unassigned'].filter((r) => byRelease.has(r));
  const releases: ReleaseReport[] = order.map((release) => {
    const all = byRelease.get(release)!;
    const kind = (k: string) => all.filter((r) => r.body.kind === k);
    const retrieval = kind('retrieval-labelled/1').filter((r) => typeof r.body.relevant === 'boolean');
    const saves = kind('save-outcome/1');
    const sessions = kind('session-aggregate/1');
    const count = (rs: SignalRow[], f: string) => rs.filter((r) => r.body[f] === true).length;
    return {
      release,
      rows: all.length,
      contributors: new Set(all.map((r) => r.contributor)).size,
      retrievalMiss: cell(retrieval, (rs) => {
        const tokens = rs.map((r) => r.body.reply_tokens_bucket).filter((v): v is number => typeof v === 'number');
        return {
          ...rate(rs.filter((r) => r.body.relevant === false).length, rs.length),
          meanReplyTokensBucket: tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : null,
        };
      }),
      saveOutcome: cell(saves, (rs) => ({
        rows: rs.length,
        opened: rate(count(rs, 'opened'), rs.length),
        cited: rate(count(rs, 'cited'), rs.length),
        superseded: rate(count(rs, 'superseded'), rs.length),
        retired: rate(count(rs, 'retired'), rs.length),
      })),
      sessions: cell(sessions, (rs) => ({
        sessions: rs.length,
        emptyReadSessions: rate(rs.filter((r) => r.body.empty_reads_bucket !== '0').length, rs.length),
        readsBuckets: tally(rs.map((r) => r.body.reads_bucket)),
        savesBuckets: tally(rs.map((r) => r.body.saves_bucket)),
      })),
    };
  });
  return {
    generatedAt: now.toISOString(),
    minContributors: MIN_CONTRIBUTORS,
    notRecorded: ['saved/skipped/failed split (a save row exists only for a save that ran)', '"I already told you" signals', 'exact calls per session and token totals (bucketed only)'],
    releases,
  };
}

const pct = (r: Rate) => `${(r.rate * 100).toFixed(1)}% (${r.n}/${r.of}, ${(r.lo * 100).toFixed(1)}–${(r.hi * 100).toFixed(1)})`;

export function renderMarkdown(sb: Scoreboard): string {
  const lines = [
    `# Real-world scoreboard (${sb.generatedAt})`,
    '',
    `Opt-in shared signals only. Intervals are 95% Wilson. A cell with fewer than ${sb.minContributors} contributors is suppressed (—).`,
    '',
    '| release | rows | contributors | retrieval miss | save cited | save superseded | sessions with an empty read |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of sb.releases) {
    lines.push(
      `| ${r.release} | ${r.rows} | ${r.contributors} | ${r.retrievalMiss.suppressed ? '—' : pct(r.retrievalMiss)} | ${r.saveOutcome.suppressed ? '—' : pct(r.saveOutcome.cited)} | ${r.saveOutcome.suppressed ? '—' : pct(r.saveOutcome.superseded)} | ${r.sessions.suppressed ? '—' : pct(r.sessions.emptyReadSessions)} |`,
    );
  }
  lines.push('', 'Not recorded: ' + sb.notRecorded.join('; ') + '.');
  return lines.join('\n') + '\n';
}

/** Rows from the read-only database, through psql. Only the connection string's env var NAME is taken from the command line. */
export function fetchRows(dbEnvName: string, env: NodeJS.ProcessEnv = process.env): SignalRow[] {
  const url = env[dbEnvName];
  if (!url) throw new Error(`environment variable ${dbEnvName} is empty or unset`);
  const sql = "select coalesce(json_agg(json_build_object('c', contributor, 'at', received_at, 'b', body)), '[]'::json) from public.shared_signal_rows";
  const out = execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: { ...env, PGDATABASE: url }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return (JSON.parse(out) as { c: string; at: string; b: Record<string, unknown> }[]).map((r) => ({ contributor: r.c, receivedAt: r.at, body: r.b }));
}

export function main(argv: string[]): void {
  const program = new Command()
    .requiredOption('--releases <file>', 'JSON file: [{"release":"1.4.0","since":"<ISO time>"}]')
    .option('--db-env <name>', 'name of the environment variable holding a READ-ONLY connection string')
    .option('--input <file>', 'rows JSON [{contributor,receivedAt,body}] instead of the database (fixtures)')
    .option('--out-json <file>', 'write the JSON report here')
    .option('--out-md <file>', 'write the markdown table here (default: stdout)');
  program.parse(argv, { from: 'user' });
  const o = program.opts<{ releases: string; dbEnv?: string; input?: string; outJson?: string; outMd?: string }>();
  if (!o.dbEnv === !o.input) throw new Error('give exactly one of --db-env or --input');
  const windows = JSON.parse(fs.readFileSync(o.releases, 'utf8')) as ReleaseWindow[];
  const rows = o.input ? (JSON.parse(fs.readFileSync(o.input, 'utf8')) as SignalRow[]) : fetchRows(o.dbEnv!);
  const sb = buildScoreboard(rows, windows);
  if (o.outJson) fs.writeFileSync(o.outJson, JSON.stringify(sb, null, 2) + '\n');
  const md = renderMarkdown(sb);
  if (o.outMd) fs.writeFileSync(o.outMd, md);
  else process.stdout.write(md);
}

if (require.main === module) main(process.argv.slice(2));
