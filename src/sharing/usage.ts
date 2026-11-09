import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ENGINE_VERSION } from '../buildIdentity';
import {
  ARCHES, EMBEDDING_MODES, FUNNEL_STEPS, INDEX_LABELS, LATENCY_FIELDS, MAX_ERROR_ENTRIES, MAX_TOOL_ENTRIES, MCP_CLIENTS, OS_FAMILIES, RERANKERS,
  SIZE_BUCKETS, TRANSPORTS, ERROR_CLASSES, TOOL_NAMES, coarsenRow, installAgeBucket, listedOrOther, majorMinor, modelIdentifier,
} from './fields';
import { USAGE_FILE, defaultInForce, effectiveLevel, hostedEngine, readState } from './state';
import { noticeRecorded } from './notice';

/**
 * Anonymous usage counters: the source of the install/1, heartbeat/1 and funnel/1 rows (fields.ts).
 *
 * A tool call costs one in-memory increment (UsageRecorder.call): a counter per tool and latency range, per error class, and the funnel steps
 * this process reached. The counters are bounded (MAX_TOOL_ENTRIES, MAX_ERROR_ENTRIES, a fixed set of steps, at most a few days pending) and
 * written in the background, on an unref'd timer and at the sender's tick, to one small file in the sharing folder (USAGE_FILE). The sender
 * (send.ts) turns that file into rows, under exactly the rules every other row goes out under: nothing before the first-run notice, nothing
 * under DO_NOT_TRACK=1 or RENOR_SHARING=off, nothing while Renor's switch for the default is closed. At level off nothing is written at all.
 *
 * What the file holds: a random install id (randomBytes, never derived from the machine, the user or a path), the environment labels, and
 * counts. Never an argument, a reply, a query, a memory, a name, a path or an error message.
 */

export type SizeBucket = (typeof SIZE_BUCKETS)[number];
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export type Transport = (typeof TRANSPORTS)[number];

/** A count as its range: 0, 1-9, 10-99, 100-999, 1000-9999, 10000+. */
export function sizeBucket(count: number): SizeBucket {
  if (!(count > 0)) return '0';
  if (count < 10) return '1-9';
  if (count < 100) return '10-99';
  if (count < 1000) return '100-999';
  if (count < 10_000) return '1000-9999';
  return '10000+';
}

/** The latency range a call falls in: <50ms, <200ms, <1s, <5s, >=5s (the index into LATENCY_FIELDS). */
export function latencyIndex(ms: number): number {
  if (ms < 50) return 0;
  if (ms < 200) return 1;
  if (ms < 1000) return 2;
  if (ms < 5000) return 3;
  return 4;
}

export interface Environment {
  /** major.minor only (the coarse-values rule); null when unknown. A usage file from before the rule may still hold a full version and a `build`: coarsenRow cuts both. */
  version: string | null;
  node_major: number;
  os: (typeof OS_FAMILIES)[number];
  arch: (typeof ARCHES)[number];
  ci: boolean;
  transport: Transport;
}

/** The standard variables CI systems set. Only whether one is set is sent. */
export const CI_VARIABLES = [
  'CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'TF_BUILD',
  'BITBUCKET_BUILD_NUMBER', 'TEAMCITY_VERSION', 'CODEBUILD_BUILD_ID', 'DRONE', 'APPVEYOR', 'SEMAPHORE',
] as const;

export function ciOf(env: NodeJS.ProcessEnv): boolean {
  return CI_VARIABLES.some(name => {
    const value = (env[name] ?? '').trim().toLowerCase();
    return value !== '' && value !== 'false' && value !== '0';
  });
}

const oneOf = <T extends string>(values: readonly T[], value: string): T => ((values as readonly string[]).includes(value) ? value as T : 'other' as T);

export function environmentOf(transport: Transport, env: NodeJS.ProcessEnv = process.env): Environment {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    version: majorMinor(ENGINE_VERSION),
    node_major: Number.isInteger(major) ? Math.min(99, Math.max(0, major)) : 0,
    os: oneOf(OS_FAMILIES, process.platform),
    arch: oneOf(ARCHES, process.arch),
    ci: ciOf(env),
    transport,
  };
}

/** How the engine is set up: labels from closed sets, never a value the user typed (a local model named by a path is sent as null). */
export interface Labels {
  embedding: (typeof EMBEDDING_MODES)[number] | null;
  model: string | null;
  reranker: (typeof RERANKERS)[number] | null;
  index: (typeof INDEX_LABELS)[number] | null;
}

export function labelsOf(input: { embedding?: string | null; model?: string | null; rerankTopN?: number; vectors?: boolean | null }): Labels {
  return {
    embedding: input.embedding === undefined || input.embedding === null ? null : oneOf(EMBEDDING_MODES, input.embedding),
    model: modelIdentifier(input.model ?? null),
    reranker: input.rerankTopN === undefined ? null : input.rerankTopN > 0 ? 'query-words' : 'off',
    index: input.vectors === undefined || input.vectors === null ? null : input.vectors ? 'hybrid' : 'keyword',
  };
}

/** What the store holds: memories (notes and current facts), notes, facts. Sent as SIZE_BUCKETS only. */
export interface Sizes { memories: number; notes: number; facts: number }

const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * A failure's class: a refusal's code or an error's class name or code, as one of ERROR_CLASSES (any other is `other`, the coarse-values rule);
 * `Error` when there is neither. Never a message.
 */
export function errorClassOf(value: unknown): string {
  if (typeof value === 'string') return ERROR_CLASS.test(value) ? listedOrOther(ERROR_CLASSES, value) : 'Error';
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CLASS.test(code)) return listedOrOther(ERROR_CLASSES, code);
    if (ERROR_CLASS.test(value.name)) return listedOrOther(ERROR_CLASSES, value.name);
  }
  return 'Error';
}

/**
 * A client's declared name as one of MCP_CLIENTS: lower-cased, anything but letters and digits made `-`, and matched whole or as a prefix
 * (`cursor-vscode` is `cursor`). Any other name is `other`: what a client declares is free text, and is never sent as it is.
 */
export function clientLabel(name: unknown): (typeof MCP_CLIENTS)[number] | null {
  if (typeof name !== 'string') return null;
  const label = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (label === '') return null;
  const known = MCP_CLIENTS.find(client => client !== 'other' && (label === client || label.startsWith(`${client}-`)));
  return known ?? 'other';
}

/** A client's declared version, when it is shaped like a version (`1.0.42`, `v2.3`, `0.9.1-beta.2`), cut to major.minor (`1.0`); else null. */
export function clientVersionLabel(version: unknown): string | null {
  if (typeof version !== 'string') return null;
  const label = version.trim();
  return /^v?[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}(?:[-+][0-9A-Za-z.]{1,16})?$/.test(label) ? majorMinor(label) : null;
}

// Which calls move the funnel: a save, a recall, and a recall put to use (a memory opened, or a save that cites what it built on).
const SAVE_TOOLS = new Set(['remember', 'save_memory', 'remember_note', 'remember_fact', 'note']);
const RECALL_TOOLS = new Set(['get_context', 'search_memory', 'retrieve_memory', 'search_text', 'search', 'keyword', 'evidence', 'facts', 'entity']);
const OPEN_TOOLS = new Set(['read_memory']);

interface ToolCounts { calls: number; latency: number[] }
interface DayRecord {
  env: Environment;
  client: { name: string; version: string | null } | null;
  labels: Labels | null;
  sizes: { memories: SizeBucket; notes: SizeBucket; facts: SizeBucket } | null;
  tools: Record<string, ToolCounts>;
  errors: Record<string, number>;
}
interface FunnelEntry { id: string; session: string; step: FunnelStep; hour: string }
export interface UsageFile {
  version: 1;
  /** 16 random bytes, hex. Made once, with this file; removed with it (deletion, a hosted secret's rotation). */
  installId: string;
  install: { at: number; env: Environment; sent: boolean };
  days: Record<string, DayRecord>;
  /** Days already sent, so a late write for one is dropped instead of being sent twice. */
  sentDays: string[];
  funnel: FunnelEntry[];
}

const MAX_DAYS = 14;
const MAX_SENT_DAYS = 30;
const MAX_FUNNEL = 100;
const MAX_PENDING_DAYS = 3;
export const USAGE_FLUSH_MS = 60_000;
const SIZES_EVERY_MS = 15 * 60_000;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const hourOf = (ms: number): string => new Date(ms).toISOString().slice(0, 13);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function readUsage(dir: string): UsageFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, USAGE_FILE), 'utf8')) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || typeof raw.installId !== 'string' || !/^[0-9a-f]{32}$/.test(raw.installId)) return null;
    if (!isRecord(raw.install) || !isRecord(raw.days) || !Array.isArray(raw.sentDays) || !Array.isArray(raw.funnel)) return null;
    return raw as unknown as UsageFile;
  } catch {
    return null;
  }
}

function writeUsage(dir: string, file: UsageFile): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${USAGE_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  fs.renameSync(temp, path.join(dir, USAGE_FILE));
}

// The funnel is per process: one random session id, and each step reached once. A step is taken into a file by the first flush after it.
const SESSION = randomBytes(16).toString('hex');
const reached = new Map<FunnelStep, number>();
const taken = new Set<FunnelStep>();
let recalled = false;

/** This process reached `step` (the first time only counts). Never throws, never writes: the next flush takes it. */
export function reachStep(step: FunnelStep, now: number = Date.now()): void {
  if (!reached.has(step)) reached.set(step, now);
}

/** For tests: forget the funnel this process reached. */
export function resetFunnelForTests(): void {
  reached.clear();
  taken.clear();
  recalled = false;
}

export interface RecorderOptions {
  transport: Transport;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  labels?: () => Labels;
  sizes?: () => Sizes | null;
  flushMs?: number;
}

interface PendingDay { tools: Map<string, ToolCounts>; errors: Map<string, number> }

export class UsageRecorder {
  private pending = new Map<string, PendingDay>();
  private clientInfo: { name: string; version: string | null } | null = null;
  private sizes: DayRecord['sizes'] = null;
  private sizesAt = -Infinity;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly dir: string, private options: RecorderOptions) {}

  /** The latest caller's sources for the labels and sizes (a server built later in the same process may hold a newer database handle). */
  sources(labels: RecorderOptions['labels'], sizes: RecorderOptions['sizes']): void {
    this.options = { ...this.options, labels, sizes };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** One finished tool call. An in-memory increment: no file, no network, and it never throws. */
  call(tool: string, ms: number, ok: boolean, failure: unknown = null, args?: unknown): void {
    try {
      const now = this.now();
      const day = dayOf(now);
      let counts = this.pending.get(day);
      if (counts === undefined) {
        if (this.pending.size >= MAX_PENDING_DAYS) return;
        counts = { tools: new Map(), errors: new Map() };
        this.pending.set(day, counts);
      }
      const named = TOOL_NAME.test(tool) ? listedOrOther(TOOL_NAMES, tool) : 'other';
      const key = counts.tools.has(named) || counts.tools.size < MAX_TOOL_ENTRIES - 1 ? named : 'other';
      const entry = counts.tools.get(key) ?? { calls: 0, latency: [0, 0, 0, 0, 0] };
      entry.calls += 1;
      entry.latency[latencyIndex(Math.max(0, ms))]! += 1;
      counts.tools.set(key, entry);
      if (!ok) {
        const cls = errorClassOf(failure);
        const errorKey = counts.errors.has(cls) || counts.errors.size < MAX_ERROR_ENTRIES - 1 ? cls : 'other';
        counts.errors.set(errorKey, (counts.errors.get(errorKey) ?? 0) + 1);
      } else {
        const cites = isRecord(args) && Array.isArray(args.cites) && args.cites.length > 0;
        if (SAVE_TOOLS.has(tool)) {
          reachStep('first_save', now);
          if (cites && recalled) reachStep('first_recall_used', now);
        }
        if (OPEN_TOOLS.has(tool) && recalled) reachStep('first_recall_used', now);
        if (RECALL_TOOLS.has(tool)) {
          reachStep('first_recall', now);
          recalled = true;
        }
      }
      this.start();
    } catch {
      // Counting must never fail a call.
    }
  }

  /** The client's own `clientInfo` from MCP initialize, as labels. */
  client(info: { name?: unknown; version?: unknown } | undefined | null): void {
    try {
      const name = clientLabel(info?.name);
      this.clientInfo = name === null ? null : { name, version: clientVersionLabel(info?.version) };
    } catch {
      this.clientInfo = null;
    }
  }

  /** Background flushes, on a timer that never keeps the process alive. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.flush(), this.options.flushMs ?? USAGE_FLUSH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Writes what is pending into the folder's usage file. At level off it writes nothing and drops the counts. Never throws. */
  flush(): void {
    try {
      this.flushOrThrow();
    } catch {
      this.pending.clear();
    }
  }

  private flushOrThrow(): void {
    const env = this.options.env ?? process.env;
    let level;
    try {
      level = effectiveLevel(this.dir, env);
    } catch {
      level = 'off' as const;
    }
    if (level === 'off') {
      // Off records nothing: what was counted while off is dropped, and so are the steps reached meanwhile.
      this.pending.clear();
      for (const step of reached.keys()) taken.add(step);
      return;
    }
    const now = this.now();
    let file = readUsage(this.dir);
    // Under the default, the file (and its install id) is made only once someone has been told (the first-run notice), as the sender
    // sends nothing before then. A choice, or a hosted workspace (its dashboard says it), needs no notice. Until then the counts wait here.
    if (file === null && defaultInForce(this.dir, env) && !hostedEngine(env) && !noticeRecorded(env)) return;
    if (file === null) {
      file = {
        version: 1, installId: randomBytes(16).toString('hex'), install: { at: now, env: environmentOf(this.options.transport, env), sent: false },
        days: {}, sentDays: [], funnel: [],
      };
      reachStep('installed', now);
    }
    if (this.options.sizes !== undefined && now - this.sizesAt >= SIZES_EVERY_MS) {
      this.sizesAt = now;
      try {
        const sizes = this.options.sizes();
        this.sizes = sizes === null ? null : { memories: sizeBucket(sizes.memories), notes: sizeBucket(sizes.notes), facts: sizeBucket(sizes.facts) };
      } catch {
        this.sizes = null;
      }
    }
    let labels: Labels | null = null;
    try {
      labels = this.options.labels?.() ?? null;
    } catch {
      labels = null;
    }
    for (const [day, counts] of this.pending) {
      if (file.sentDays.includes(day)) continue;
      const record: DayRecord = file.days[day] ?? { env: environmentOf(this.options.transport, env), client: null, labels: null, sizes: null, tools: {}, errors: {} };
      record.env = environmentOf(this.options.transport, env);
      if (this.clientInfo !== null) record.client = this.clientInfo;
      if (labels !== null) record.labels = labels;
      if (this.sizes !== null) record.sizes = this.sizes;
      for (const [tool, add] of counts.tools) {
        const known = record.tools[tool] !== undefined || Object.keys(record.tools).length < MAX_TOOL_ENTRIES - 1 ? tool : 'other';
        const into = record.tools[known] ?? { calls: 0, latency: [0, 0, 0, 0, 0] };
        into.calls += add.calls;
        into.latency = into.latency.map((value, index) => value + (add.latency[index] ?? 0));
        record.tools[known] = into;
      }
      for (const [cls, add] of counts.errors) {
        const known = record.errors[cls] !== undefined || Object.keys(record.errors).length < MAX_ERROR_ENTRIES - 1 ? cls : 'other';
        record.errors[known] = (record.errors[known] ?? 0) + add;
      }
      file.days[day] = record;
    }
    this.pending.clear();
    for (const [step, at] of reached) {
      if (taken.has(step)) continue;
      taken.add(step);
      file.funnel.push({ id: randomBytes(8).toString('hex'), session: SESSION, step, hour: hourOf(at) });
    }
    file.funnel = file.funnel.slice(-MAX_FUNNEL);
    const days = Object.keys(file.days).sort();
    for (const day of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete file.days[day];
    file.sentDays = file.sentDays.slice(-MAX_SENT_DAYS);
    writeUsage(this.dir, file);
  }
}

const recorders = new Map<string, UsageRecorder>();

/** The recorder of a sharing folder in this process, made on first use. */
export function usageRecorder(dir: string, options: RecorderOptions): UsageRecorder {
  const key = path.resolve(dir);
  const existing = recorders.get(key);
  if (existing !== undefined) return existing;
  const made = new UsageRecorder(key, options);
  recorders.set(key, made);
  return made;
}

/** Flushes the folder's recorder, if this process has one (the sender's tick calls it before it reads the file). */
export function flushUsageFor(dir: string): void {
  recorders.get(path.resolve(dir))?.flush();
}

/** A row the sender may send, with what to mark once it was accepted. */
export interface UsageRow { at: number; row: Record<string, unknown>; mark: string }

/**
 * The rows the folder's usage file has for the sender: the install row until it was sent, one heartbeat for each finished active day (a day
 * is sent once it is over, so it is complete), and each funnel step. Reads only.
 */
export function usageRows(dir: string, now: number): UsageRow[] {
  const file = readUsage(dir);
  if (file === null) return [];
  // Every row says how old the install is (fields.ts INSTALL_AGE_BUCKETS), from the first-seen day the sharing state keeps; and every row is
  // made coarse (a usage file from before the coarse-values rule may still hold a full version or a build commit).
  const firstSeen = readState(dir)?.firstSeen ?? file.install.at;
  const rows: UsageRow[] = [];
  const push = (row: UsageRow): void => {
    rows.push({ ...row, row: coarsenRow({ ...row.row, install_age: installAgeBucket(firstSeen, row.at) }) as UsageRow['row'] });
  };
  if (file.install.sent !== true) {
    push({ at: file.install.at, mark: 'install', row: { kind: 'install/1', hour: hourOf(file.install.at), install_id: file.installId, ...file.install.env } });
  }
  const today = dayOf(now);
  for (const day of Object.keys(file.days).sort()) {
    if (day >= today || file.sentDays.includes(day)) continue;
    const record = file.days[day]!;
    const tools = Object.entries(record.tools).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_TOOL_ENTRIES).map(([tool, counts]) => ({
      tool,
      calls_bucket: sizeBucket(counts.calls),
      ...Object.fromEntries(LATENCY_FIELDS.map((field, index) => [field, sizeBucket(counts.latency[index] ?? 0)])),
    }));
    const errors = Object.entries(record.errors).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_ERROR_ENTRIES)
      .map(([cls, count]) => ({ class: cls, count_bucket: sizeBucket(count) }));
    push({
      at: Date.parse(`${day}T00:00:00.000Z`),
      mark: `day:${day}`,
      row: {
        kind: 'heartbeat/1', hour: `${day}T00`, install_id: file.installId, ...record.env,
        client_name: record.client?.name ?? null, client_version: record.client?.version ?? null,
        embedding: record.labels?.embedding ?? null, model: record.labels?.model ?? null,
        reranker: record.labels?.reranker ?? null, index: record.labels?.index ?? null,
        memories_bucket: record.sizes?.memories ?? null, notes_bucket: record.sizes?.notes ?? null, facts_bucket: record.sizes?.facts ?? null,
        tools, errors,
      },
    });
  }
  for (const entry of file.funnel) {
    push({ at: Date.parse(`${entry.hour}:00:00.000Z`), mark: `funnel:${entry.id}`, row: { kind: 'funnel/1', hour: entry.hour, session: entry.session, step: entry.step } });
  }
  return rows;
}

/** Marks rows as done (sent, or refused for good): they are never offered again. A missing file (deleted meanwhile) is left missing. */
export function markUsageSent(dir: string, marks: readonly string[]): void {
  if (marks.length === 0) return;
  const file = readUsage(dir);
  if (file === null) return;
  for (const mark of marks) {
    if (mark === 'install') file.install.sent = true;
    else if (mark.startsWith('day:')) {
      const day = mark.slice(4);
      delete file.days[day];
      if (!file.sentDays.includes(day)) file.sentDays.push(day);
    } else if (mark.startsWith('funnel:')) file.funnel = file.funnel.filter(entry => entry.id !== mark.slice(7));
  }
  file.sentDays = file.sentDays.slice(-MAX_SENT_DAYS);
  writeUsage(dir, file);
}
