import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { MIN_CONTRIBUTORS, keepCrowdedMonths, rowMonth } from '../../src/sharing/crowd';

/**
 * Weekly real-world scoreboard: aggregates of the opt-in `shared_signal_rows`, split by Renor release and by deployment (cloud or
 * self-hosted). Rows Renor's own engines made (`internal: true`: gates, CI, evals, Renor's own workspaces) are left out by default and
 * counted apart; `--include-internal` keeps them.
 *
 * Privacy: the output holds counts, rates and intervals only. No row body, query, text, contributor id or workspace id is ever
 * printed. The 3-people rule (src/sharing/crowd.ts): a cell keeps only the rows of months in which its own rows come from at least
 * MIN_CONTRIBUTORS distinct contributors, and is suppressed (its numbers are not emitted) when fewer than that remain. Counted per month
 * because a contributor id lasts one month (an install-month), so one install over three months must not pass for three people.
 * The database is read through a read-only connection string held in an environment variable named on the command line;
 * the string is handed to psql through the child's environment, never on its command line, and never printed.
 *
 * A row carries its release and deployment (engine/docs/TELEMETRY.md, "Where a row was made") since 2026-11-08. A row from an older
 * engine carries neither: its release is a window of `received_at` (`--releases`, JSON `[{"release":"1.4.0","since":"2026-10-29T00:00:00Z"}, ...]`,
 * `unassigned` before every window or without the file) and its deployment is `unknown`.
 */

export { MIN_CONTRIBUTORS };

export interface SignalRow {
  /** Opaque contributor id; used only to count distinct contributors, never output. */
  contributor: string;
  /** ISO timestamp the row was received. */
  receivedAt: string;
  body: Record<string, unknown>;
}
export interface ReleaseWindow { release: string; since: string }

export interface Rate { n: number; of: number; rate: number; lo: number; hi: number }
export type Cell<T> = { suppressed: true } | ({ suppressed: false; contributors: number } & T);

export const DEPLOYMENT_ORDER = ['cloud', 'self-hosted', 'unknown'] as const;

export interface ReleaseReport {
  release: string;
  /** `cloud`, `self-hosted`, or `unknown` for a row from an engine released before the field. */
  deployment: string;
  /** Rows and distinct contributors of the release's months that have at least MIN_CONTRIBUTORS contributors (0 when none has). */
  rows: number;
  contributors: number;
  retrievalMiss: Cell<Rate & { meanReplyTokensBucket: number | null }>;
  saveOutcome: Cell<{ rows: number; opened: Rate; cited: Rate; superseded: Rate; retired: Rate }>;
  sessions: Cell<{ sessions: number; emptyReadSessions: Rate; readsBuckets: Record<string, number>; savesBuckets: Record<string, number> }>;
}
export interface Scoreboard {
  generatedAt: string;
  minContributors: number;
  /** Rows left out because Renor's own engine made them (`internal: true`); 0 when they were kept. */
  internalExcluded: number;
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
  const crowded = keepCrowdedMonths(rows, (r) => r.contributor, rowMonth);
  // Suppressed means no number at all, not even how many (one or two) people stand behind it.
  if (crowded.contributors < MIN_CONTRIBUTORS) return { suppressed: true };
  return { suppressed: false, contributors: crowded.contributors, ...build(crowded.kept) };
}

function tally(values: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) if (typeof v === 'string') out[v] = (out[v] ?? 0) + 1;
  return out;
}

export interface ScoreboardOptions {
  /** Keep the rows Renor's own engines made (`internal: true`). Default false: they are left out and counted in `internalExcluded`. */
  includeInternal?: boolean;
}

/** The row's own release when it carries one (a newer engine), else the window its receipt falls in. */
function rowRelease(r: SignalRow, windows: ReleaseWindow[]): string {
  return typeof r.body.release === 'string' && r.body.release !== '' ? r.body.release : releaseOf(r.receivedAt, windows);
}

function rowDeployment(r: SignalRow): string {
  return r.body.deployment === 'cloud' || r.body.deployment === 'self-hosted' ? r.body.deployment : 'unknown';
}

export function buildScoreboard(rows: SignalRow[], windows: ReleaseWindow[], now: Date = new Date(), options: ScoreboardOptions = {}): Scoreboard {
  const kept = options.includeInternal ? rows : rows.filter((r) => r.body.internal !== true);
  const groups = new Map<string, { release: string; deployment: string; rows: SignalRow[] }>();
  for (const r of kept) {
    const release = rowRelease(r, windows);
    const deployment = rowDeployment(r);
    const key = JSON.stringify([release, deployment]);
    if (!groups.has(key)) groups.set(key, { release, deployment, rows: [] });
    groups.get(key)!.rows.push(r);
  }
  // Releases in the order of the windows, then any other release a row named (sorted), then `unassigned`; deployments in a fixed order.
  const windowed = windows.map((w) => w.release);
  const named = [...new Set([...groups.values()].map((g) => g.release))].filter((r) => !windowed.includes(r) && r !== 'unassigned').sort();
  const releaseOrder = [...windowed, ...named, 'unassigned'];
  const ordered = [...groups.values()].sort((a, b) =>
    releaseOrder.indexOf(a.release) - releaseOrder.indexOf(b.release)
    || DEPLOYMENT_ORDER.indexOf(a.deployment as (typeof DEPLOYMENT_ORDER)[number]) - DEPLOYMENT_ORDER.indexOf(b.deployment as (typeof DEPLOYMENT_ORDER)[number]));
  const releases: ReleaseReport[] = ordered.map(({ release, deployment, rows: all }) => {
    const kind = (k: string) => all.filter((r) => r.body.kind === k);
    const retrieval = kind('retrieval-labelled/1').filter((r) => typeof r.body.relevant === 'boolean');
    const saves = kind('save-outcome/1');
    const sessions = kind('session-aggregate/1');
    const count = (rs: SignalRow[], f: string) => rs.filter((r) => r.body[f] === true).length;
    // The release's own totals follow the same rule: a count of rows from fewer than three people is a count about one of them.
    const crowded = keepCrowdedMonths(all, (r) => r.contributor, rowMonth);
    return {
      release,
      deployment,
      rows: crowded.kept.length,
      contributors: crowded.contributors,
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
    internalExcluded: rows.length - kept.length,
    notRecorded: ['saved/skipped/failed split (a save row exists only for a save that ran)', '"I already told you" signals', 'exact calls per session and token totals (bucketed only)'],
    releases,
  };
}

const pct = (r: Rate) => `${(r.rate * 100).toFixed(1)}% (${r.n}/${r.of}, ${(r.lo * 100).toFixed(1)}–${(r.hi * 100).toFixed(1)})`;

export function renderMarkdown(sb: Scoreboard): string {
  const lines = [
    `# Real-world scoreboard (${sb.generatedAt})`,
    '',
    `Opt-in shared signals only. Intervals are 95% Wilson. A cell counts only months with at least ${sb.minContributors} contributors, and is suppressed (—) when none remain.`,
    `Rows from Renor's own engines (internal) left out: ${sb.internalExcluded}.`,
    '',
    '| release | deployment | rows | contributors | retrieval miss | save cited | save superseded | sessions with an empty read |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of sb.releases) {
    lines.push(
      `| ${r.release} | ${r.deployment} | ${r.rows} | ${r.contributors} | ${r.retrievalMiss.suppressed ? '—' : pct(r.retrievalMiss)} | ${r.saveOutcome.suppressed ? '—' : pct(r.saveOutcome.cited)} | ${r.saveOutcome.suppressed ? '—' : pct(r.saveOutcome.superseded)} | ${r.sessions.suppressed ? '—' : pct(r.sessions.emptyReadSessions)} |`,
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
    .option('--releases <file>', 'JSON file: [{"release":"1.4.0","since":"<ISO time>"}], for rows from engines that do not name their release')
    .option('--include-internal', "keep the rows Renor's own engines made (internal: true); left out by default")
    .option('--db-env <name>', 'name of the environment variable holding a READ-ONLY connection string')
    .option('--input <file>', 'rows JSON [{contributor,receivedAt,body}] instead of the database (fixtures)')
    .option('--out-json <file>', 'write the JSON report here')
    .option('--out-md <file>', 'write the markdown table here (default: stdout)');
  program.parse(argv, { from: 'user' });
  const o = program.opts<{ releases?: string; includeInternal?: boolean; dbEnv?: string; input?: string; outJson?: string; outMd?: string }>();
  if (!o.dbEnv === !o.input) throw new Error('give exactly one of --db-env or --input');
  const windows = o.releases ? (JSON.parse(fs.readFileSync(o.releases, 'utf8')) as ReleaseWindow[]) : [];
  const rows = o.input ? (JSON.parse(fs.readFileSync(o.input, 'utf8')) as SignalRow[]) : fetchRows(o.dbEnv!);
  const sb = buildScoreboard(rows, windows, new Date(), { includeInternal: o.includeInternal === true });
  if (o.outJson) fs.writeFileSync(o.outJson, JSON.stringify(sb, null, 2) + '\n');
  const md = renderMarkdown(sb);
  if (o.outMd) fs.writeFileSync(o.outMd, md);
  else process.stdout.write(md);
}

if (require.main === module) main(process.argv.slice(2));
