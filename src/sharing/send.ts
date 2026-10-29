import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import { learningDbPath, learningRetentionDays } from '../learning/settings';
import { LearningLog } from '../learning/store';
import { ExampleStore } from './examples';
import {
  CLI_WORDING_VERSION, DEFAULT_FIELD, DEFAULT_WORDING_VERSION, MAX_ROWS_PER_BATCH, SHARING_PROTOCOL, TERMINAL_REFUSALS, levelRank,
  validateRow, type SharingLevel,
} from './fields';
import { LABEL_WINDOW_MS, projectRows, type ProjectedKind, type ProjectedRow } from './project';
import {
  EXAMPLES_FILE, contributorId, rotateSecret, trainingBearer, consentFor, effectiveLevel, ensureState, freshState, readConsent, readState, removeLocalSharingData,
  writeConsent, writeState, type ConsentRecord, type SharingState,
} from './state';
import path from 'node:path';
import { noticeRecorded } from './notice';

/**
 * The sender, and the changes to the choice. Everything that leaves the machine leaves through `post` below, and only from
 * `shareNow` (rows), `deleteRemote` (a removal request with no data in it).
 *
 * The rules, each with a test:
 *   - level off sends nothing and writes nothing new (no file is made or opened except to read);
 *   - signals sends the signals fields; data sends the same plus the text fields; the rows are checked against
 *     fields.ts before a request is made, so a bug cannot widen what leaves;
 *   - debug mode builds the exact request body and returns it without sending and without moving any watermark;
 *   - a change of choice takes effect at the next call, in this process or another: the level is read from the record each time;
 *   - a run reads the choice again before each request and after it; when off was chosen meanwhile, it sends nothing more and
 *     asks the endpoint to delete what it holds (a request already on the wire may land after the deletion `off` asked for);
 *   - at `data`, an example text is deleted once every row that can use it has been sent;
 *   - a self-hosted batch carries the install's consent record (fields.ts CONSENT_FIELDS), which the endpoint requires; a hosted
 *     workspace's batch, and one sent under the default, carry `default: true` instead and are tied to no workspace;
 *   - a refusal the endpoint means for good (fields.ts TERMINAL_REFUSALS) is never retried: the refused rows are never sent again,
 *     `consent_off` applies off here, and `sharing_closed` or `consent_required` pause sending until the sharing status says open
 *     again or the person chooses a level again. A deletion is never paused.
 */

/** The endpoint the sender posts to. RENOR_SHARING_ENDPOINT replaces it (it must be https, or loopback for a test). */
export const DEFAULT_ENDPOINT = 'https://yiotrpmsxbnarzvodqyf.supabase.co/functions/v1/sharing-ingest';

export function sharingEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.RENOR_SHARING_ENDPOINT ?? '').trim();
  if (raw === '') return DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('RENOR_SHARING_ENDPOINT must be a URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('RENOR_SHARING_ENDPOINT must be https (http is allowed only for a loopback address)');
  }
  return url.toString();
}

/** Renor's public sharing switch (the gateway's GET /sharing/status, one bit). RENOR_SHARING_STATUS_URL replaces it. */
export const DEFAULT_STATUS_URL = 'https://mcp.renor.cloud/sharing/status';

export function sharingStatusUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.RENOR_SHARING_STATUS_URL ?? '').trim();
  if (raw === '') return DEFAULT_STATUS_URL;
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('RENOR_SHARING_STATUS_URL must be https (http is allowed only for a loopback address)');
  }
  return url.toString();
}

/** Whether Renor's switch is open: only an answer of exactly {"open": true} is open; any error, redirect or other answer is closed. */
export async function sharingStatusOpen(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(sharingStatusUrl(env), { method: 'GET', redirect: 'manual', signal: controller.signal });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body: unknown = JSON.parse(await readCapped(response));
    return typeof body === 'object' && body !== null && JSON.stringify(body) === '{"open":true}';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Renor's switch for the default (the gateway's GET /sharing/default-status, one bit, the same shape as the switch above). A
 * sender that has no choice of its own to send under asks it BEFORE it sends anything, so while it is closed no row leaves.
 * RENOR_SHARING_DEFAULT_STATUS_URL replaces it (https, or loopback for a test).
 */
export const DEFAULT_DEFAULT_STATUS_URL = 'https://mcp.renor.cloud/sharing/default-status';

export function sharingDefaultStatusUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.RENOR_SHARING_DEFAULT_STATUS_URL ?? '').trim();
  if (raw === '') return DEFAULT_DEFAULT_STATUS_URL;
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('RENOR_SHARING_DEFAULT_STATUS_URL must be https (http is allowed only for a loopback address)');
  }
  return url.toString();
}

/** Whether Renor's switch for the default is open: only exactly {"open": true}; any error, redirect or other answer is closed. */
export async function sharingDefaultOpen(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(sharingDefaultStatusUrl(env), { method: 'GET', redirect: 'manual', signal: controller.signal });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body: unknown = JSON.parse(await readCapped(response));
    return typeof body === 'object' && body !== null && JSON.stringify(body) === '{"open":true}';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function debugOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_SHARING_DEBUG ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** A reply as the sender reads it. `body` is the stream fetch gives; without one (a test's fake), `text()` is read. */
export interface Reply {
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
}
export type Post = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Reply>;

/** The most of a reply body the sender reads: a refusal is a short JSON object, so anything longer is cut and the rest cancelled. */
export const MAX_REPLY_BYTES = 4096;

/** Reads at most MAX_REPLY_BYTES of a reply and cancels the rest, so an endpoint (or anything in between) cannot make it read more. */
export async function readCapped(reply: Pick<Reply, 'text' | 'body'>, max = MAX_REPLY_BYTES): Promise<string> {
  const stream = reply.body;
  if (!stream) return (await reply.text()).slice(0, max);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

export interface SenderOptions {
  /** The sharing folder (consent record, state, example store). */
  dir: string;
  /** The memory folder whose learning log the rows are made from; null when there is none (nothing to send). */
  memoryDir: string | null;
  env?: NodeJS.ProcessEnv;
  fetch?: Post;
  now?: () => number;
  /**
   * This sender runs behind the hosted gateway. Its batches are sent untied, like the default's (`default: true`), whether or not the
   * owner chose: the platform never maps the install to the workspace, so the endpoint has no workspace choice to check them against.
   * Usage numbers only (a hosted `data` is sent as signals). A self-hosted install leaves it unset.
   */
  hosted?: boolean;
  /** Label window (ms), for tests. */
  windowMs?: number;
  /** Asks whether Renor's sharing switch is open (default: sharingStatusOpen), only while a `sharing_closed` refusal pauses sending. */
  sharingOpen?: () => Promise<boolean>;
  /** Asks whether Renor's switch for the default is open (default: sharingDefaultOpen), before reading rows and before EACH batch sent under the default; an error is closed. */
  defaultOpen?: () => Promise<boolean>;
  /** Whether someone has been told (default: the install's notice record, notice.ts), asked before anything is sent under the default. */
  noticeRecorded?: () => boolean;
  /** Return the request bodies instead of sending them. Also on with RENOR_SHARING_DEBUG=1. */
  debug?: boolean;
  /**
   * Debug only: build the bodies for this level even though the user has not chosen it, so a person can see exactly what a
   * level would send before they pick it. Ignored unless the run is a debug run, so it can never cause a send.
   */
  previewLevel?: Exclude<SharingLevel, 'off'>;
}

export type ShareStatus = 'off' | 'no-log' | 'nothing' | 'debug' | 'sent' | 'failed' | 'stopped' | 'paused';
export interface ShareResult {
  status: ShareStatus;
  level: SharingLevel;
  rows: number;
  batches: number;
  skipped: number;
  /** debug: the exact bodies that would be sent. */
  payloads?: unknown[];
  reason?: string;
}

/**
 * How a hosted workspace proves itself to the endpoint: the HMAC of its contributor id under a key derived from the fleet's gateway secret
 * (MVP_GATEWAY_SECRET, which only the hosted engines and the gateway hold). The endpoint holds the same derived key (SHARING_HOSTED_KEY, 64 hex
 * characters) and refuses a hosted request without a valid proof. Null when the process has no gateway secret: it cannot prove anything.
 */
export function hostedProof(env: NodeJS.ProcessEnv, contributor: string): string | null {
  const gateway = (env.MVP_GATEWAY_SECRET ?? '').trim();
  if (gateway === '') return null;
  const key = createHmac('sha256', gateway).update('sharing-ingest-hosted/v1').digest('hex');
  return createHmac('sha256', key).update(contributor).digest('hex');
}

/** The credential Renor issues an install (`register`): 86 base64url characters, a random id and its MAC. */
export function isIssuedToken(token: string | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{86}$/.test(token);
}

/**
 * What an install or a workspace sends as its bearer: a hosted workspace its own secret (proved by hostedProof), an install the credential
 * Renor issued it. An install that has none (a deletion owed from before credentials existed) falls back to its secret, which a delete accepts.
 */
function bearerOf(state: SharingState, hosted: boolean | undefined): string {
  return hosted ? state.secret : (state.token ?? state.secret);
}

async function post(
  url: string, bearer: string | null, body: string, send: Post | undefined, hosted = false, env: NodeJS.ProcessEnv = process.env, wantJson = false,
): Promise<{ status: number; retryAfter: number | null; code: string | null; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const doFetch: Post = send ?? ((u, init) => fetch(u, init));
    const proof = hosted && bearer !== null ? hostedProof(env, contributorId(bearer)) : null;
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
        ...(hosted ? { 'x-renor-hosted': '1', ...(proof !== null ? { 'x-renor-hosted-proof': proof } : {}) } : {}),
      },
      body,
      signal: controller.signal,
    });
    const retry = Number(response.headers.get('retry-after'));
    // The refusal's code, from the endpoint's JSON body ({"ok": false, "code": ...}); null when there is none.
    let code: string | null = null;
    if (response.status >= 400) {
      try {
        const parsed: unknown = JSON.parse(await readCapped(response));
        if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { code?: unknown }).code === 'string') code = (parsed as { code: string }).code;
      } catch {
        // An unreadable body is an ordinary failure, retried.
      }
    }
    // Only a request that asks for something back (register) reads a successful reply.
    let json: unknown = null;
    if (wantJson && response.status >= 200 && response.status < 300) {
      try {
        json = JSON.parse(await readCapped(response));
      } catch {
        json = null;
      }
    }
    return { status: response.status, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null, code, json };
  } finally {
    clearTimeout(timer);
  }
}

type Registered = { ok: true; token: string } | { ok: false; code: string | null; reason: string };

/**
 * Asks Renor for this install's credential: a request with no bearer and nothing in it but the protocol and the action. The reply's token is
 * kept in the sharing state and sent as the install's bearer (its contributor id is the SHA-256 of it, so the endpoint keeps only that). A
 * hosted workspace never registers: it proves itself with hostedProof.
 */
async function registerInstall(options: Pick<SenderOptions, 'env' | 'fetch'>, endpoint: string): Promise<Registered> {
  const env = options.env ?? process.env;
  try {
    const { status, code, json } = await post(
      endpoint, null, JSON.stringify({ protocol: SHARING_PROTOCOL, action: 'register' }), options.fetch, false, env, true);
    const token = typeof json === 'object' && json !== null ? (json as { token?: unknown }).token : undefined;
    if (status >= 200 && status < 300 && typeof token === 'string' && isIssuedToken(token)) return { ok: true, token };
    return { ok: false, code, reason: code !== null ? `Renor refused to issue a credential (${code})` : `Renor answered ${status} when asked for a credential` };
  } catch (err) {
    return { ok: false, code: null, reason: err instanceof Error ? err.message : 'request failed' };
  }
}

/** Splits rows (oldest first) into batches of at most `max`, never between two rows with the same time, so a watermark is exact. */
function chunk(rows: ProjectedRow[], max: number): ProjectedRow[][] {
  const out: ProjectedRow[][] = [];
  let index = 0;
  while (index < rows.length) {
    let end = Math.min(index + max, rows.length);
    while (end < rows.length && end > index + 1 && rows[end]!.at === rows[end - 1]!.at) end -= 1;
    out.push(rows.slice(index, end));
    index = end;
  }
  return out;
}

function batchId(secret: string, kind: ProjectedKind, rows: ProjectedRow[]): string {
  // The same chunk gets the same id on a retry, so an answer lost on the way never makes the endpoint store it twice.
  return createHash('sha256')
    .update(JSON.stringify([secret, kind, rows[0]!.at, rows[rows.length - 1]!.at, rows.length]))
    .digest('hex')
    .slice(0, 32);
}

const STATUS_RANK: ShareStatus[] = ['failed', 'paused', 'stopped', 'sent', 'debug', 'nothing', 'no-log', 'off'];

/**
 * Computes the rows that are final and unsent, and sends them (or, in debug mode, returns the bodies).
 *
 * A hosted workspace sends up to two streams. The usage numbers always go out untied (`default: true`, signals, under the install's own
 * id) whatever the owner chose, unless the owner's record says off. If the owner also switched text for training on (`data`), the text
 * goes out as a second, TIED contributor (the owner's switch has to be held), apart from the numbers. A self-hosted install sends one stream.
 */
export async function shareNow(options: SenderOptions): Promise<ShareResult> {
  const first = await shareStream(options, 'numbers');
  const env = options.env ?? process.env;
  const debug = options.debug === true || debugOn(env);
  const previewing = debug && options.previewLevel !== undefined;
  // An earlier explicit Off keeps the numbers off (their stream answers 'off'), and the text, if its switch is on, still goes.
  const numbersOff = readConsent(options.dir, env)?.numbersOff === true;
  if (options.hosted !== true || previewing || (first.status === 'off' && !numbersOff) || effectiveLevel(options.dir, env) !== 'data') return first;
  const second = await shareStream(options, 'training');
  const rank = (status: ShareStatus): number => STATUS_RANK.indexOf(status);
  const status = rank(first.status) <= rank(second.status) ? first.status : second.status;
  const reasons = [first.reason, second.reason].filter((reason): reason is string => reason !== undefined);
  return {
    status, level: second.level, rows: first.rows + second.rows, batches: first.batches + second.batches, skipped: first.skipped + second.skipped,
    ...(first.payloads !== undefined || second.payloads !== undefined ? { payloads: [...(first.payloads ?? []), ...(second.payloads ?? [])] } : {}),
    ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
  };
}

async function shareStream(options: SenderOptions, stream: 'numbers' | 'training'): Promise<ShareResult> {
  const training = stream === 'training';
  const env = options.env ?? process.env;
  const now = (options.now ?? Date.now)();
  const debug = options.debug === true || debugOn(env);
  const previewing = debug && options.previewLevel !== undefined;
  const chosen: SharingLevel = previewing ? options.previewLevel! : effectiveLevel(options.dir, env);
  // A hosted workspace's numbers stream carries numbers only, whatever else the owner chose; its training stream is the text.
  const level: SharingLevel = options.hosted && !training && chosen === 'data' ? 'signals' : chosen;
  const empty = (status: ShareStatus, extra: Partial<ShareResult> = {}): ShareResult =>
    ({ status, level, rows: 0, batches: 0, skipped: 0, ...extra });
  if (level === 'off') return empty('off');
  // This folder's own record, else the install's answer it inherits (`renor setup`): either is a choice, so neither is sent as the default.
  const record = consentFor(options.dir, env);
  // A hosted workspace that once chose Off never sends its numbers again, whatever its owner does with the text switch.
  if (options.hosted === true && !training && record?.numbersOff === true) return empty('off');
  // While the owner's text switch is on, the usage numbers pause: a row of the text stream is the same row with its text, so sending it in both would
  // let anyone with the database match the untied id to the workspace. The text stream carries only rows created after the switch went on (below),
  // and the numbers resume, from the switch-off time, when it goes off (chooseLevel).
  if (options.hosted === true && !training && chosen === 'data') return empty('nothing');
  // A batch is sent "untied" (`default: true`, no consent record, only while Renor's switch for it is open) when no choice was made
  // (above off with no record can only be the default: a record that cannot be read is off, state.ts) AND for a hosted workspace's
  // numbers stream, whatever its owner chose: Renor never ties the install id to the workspace, so the owner's choice about the text
  // changes nothing about how the numbers arrive. An owner's Off stops this sender, which then asks Renor to delete by the install's own
  // id. A self-hosted install has no workspace and sends its consent record. The training stream is the one tied stream: the platform's
  // record of the owner's switch is its consent, so it carries neither a consent record nor the default flag.
  const viaDefault = !previewing && !training && (record === null || options.hosted === true);
  // Nothing is sent under the default until someone has been told (notice.ts): a daemon or an idle service nobody has talked to sends nothing.
  if (viaDefault && options.hosted !== true && !debug && !(options.noticeRecorded ?? (() => noticeRecorded(env)))()) {
    return empty('paused', { reason: 'the first-run notice has not been shown yet; nothing is sent under the default until it has' });
  }
  const consent = viaDefault ? { wording: DEFAULT_WORDING_VERSION } : (record ?? (previewing ? { wording: CLI_WORDING_VERSION } : null));
  if (consent === null || options.memoryDir === null) return empty('no-log', { reason: 'no learning log to read' });

  // A refusal for good paused sending: nothing goes out until it clears (debug only builds bodies, so it ignores the pause).
  const paused = debug ? undefined : readState(options.dir)?.paused;
  if (paused?.code === 'consent_required') {
    return empty('paused', { reason: 'Renor refused the consent record; nothing is sent until a level is chosen again' });
  }
  if (paused?.code === 'sharing_closed') {
    if (!(await (options.sharingOpen ?? (() => sharingStatusOpen(env)))())) {
      return empty('paused', { reason: 'Renor has closed sharing; nothing is sent until it is open again' });
    }
    const resumed = readState(options.dir);
    if (resumed !== null) {
      delete resumed.paused;
      writeState(options.dir, resumed);
    }
  }

  // Nothing is sent under the default while Renor's switch for it is closed. The question is asked here, before a row is read or a
  // file made, and AGAIN before every batch (below), because a run can post several batches and the switch can close between them.
  // Any error is "closed". Debug builds the bodies and sends nothing, so it asks nothing either.
  const defaultIsOpen = async (): Promise<boolean> => {
    try {
      return await (options.defaultOpen ?? (() => sharingDefaultOpen(env)))();
    } catch {
      return false;
    }
  };
  if (viaDefault && !debug && !(await defaultIsOpen())) {
    return empty('paused', { reason: "Renor's switch for the default is closed; nothing is sent" });
  }

  const file = learningDbPath(options.memoryDir);
  if (!fs.existsSync(file)) return empty('no-log', { reason: `no learning log at ${file}` });

  const log = LearningLog.open(file, { retentionDays: learningRetentionDays(env), rawQueries: false, create: false, now: () => now });
  if (log === null) return empty('no-log', { reason: `no learning log at ${file}` });
  let exported;
  try {
    exported = log.exportLog();
  } finally {
    log.close();
  }

  // Debug reads the state if there is one and never makes it; a real send makes it on first use.
  const state = debug ? (readState(options.dir) ?? freshState()) : ensureState(options.dir);
  // The text stream starts at the switch-on time, never at 0: nothing created before it is ever sent tied, so nothing sent untied is repeated.
  if (training) {
    const from = Math.max(0, Date.parse(record?.changedAt ?? '') || 0);
    state.trainingWatermarks ??= { retrieval: from, save: from, session: from };
  }
  const marks = training ? state.trainingWatermarks! : state.watermarks;
  // Read at each send: an install is issued its credential (state.token) after this point, and the numbers go out under it.
  const currentBearer = (): string => (training ? trainingBearer(state.secret) : bearerOf(state, options.hosted));
  const idSecret = training ? trainingBearer(state.secret) : state.secret;
  const examples = level === 'data' ? ExampleStore.open(options.dir, false) : null;
  let projected: ProjectedRow[];
  try {
    projected = projectRows(exported, { level, now, windowMs: options.windowMs, watermarks: marks, examples });
  } finally {
    examples?.close();
  }

  let skipped = 0;
  const valid = projected.filter(item => {
    try {
      validateRow(item.row, level);
      return true;
    } catch {
      skipped += 1;
      return false;
    }
  });
  // A row that fails its own contract is never sent. Its time still passes the watermark (below), so it cannot block the rest.
  const byKind = new Map<ProjectedKind, ProjectedRow[]>();
  for (const item of valid) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  const batches: Array<{ kind: ProjectedKind; rows: ProjectedRow[] }> = [];
  for (const [kind, rows] of byKind) {
    rows.sort((a, b) => a.at - b.at);
    for (const part of chunk(rows, MAX_ROWS_PER_BATCH)) batches.push({ kind, rows: part });
  }
  // Every row older than the label window is final, so it is sent once the run sends all it has; the texts only such rows use
  // are no longer needed. A text a later event still needs was put again at that event, which keeps it.
  const forgetSentExamples = (): void => {
    if (level !== 'data') return;
    const store = ExampleStore.open(options.dir, false);
    try {
      store?.forgetUpTo(now - (options.windowMs ?? LABEL_WINDOW_MS));
    } finally {
      store?.close();
    }
  };
  if (batches.length === 0) {
    if (!debug) forgetSentExamples();
    return empty('nothing', { skipped });
  }

  // The consent record a self-hosted batch carries (the endpoint refuses one without it). A preview has no record yet: it shows
  // the one choosing that level would make.
  const evidence = {
    version: 1,
    level: record?.level ?? level,
    changed_at: record?.changedAt ?? new Date(now).toISOString(),
    wording: consent.wording,
    adult: record ? record.adult === true : true,
  };
  const body = (kind: ProjectedKind, rows: ProjectedRow[]): Record<string, unknown> => ({
    protocol: SHARING_PROTOCOL,
    action: 'batch',
    batch_id: batchId(idSecret, kind, rows),
    level,
    wording: consent.wording,
    rows: rows.map(item => item.row),
    ...(options.hosted || viaDefault ? {} : { consent: evidence }),
    ...(viaDefault ? { [DEFAULT_FIELD]: true } : {}),
  });

  if (debug) {
    const payloads = batches.map(batch => body(batch.kind, batch.rows));
    return { status: 'debug', level, rows: valid.length, batches: payloads.length, skipped, payloads };
  }

  // An install proves itself with the credential Renor issued it; one that has none (a first send, or one Renor refused) asks now, after every
  // other check (the choice, the default's switch) and before any row is posted. A hosted workspace proves itself with hostedProof instead.
  const endpoint = sharingEndpoint(env);
  if (!options.hosted && !isIssuedToken(state.token)) {
    const registered = await registerInstall({ env, fetch: options.fetch }, endpoint);
    if (!registered.ok) {
      if (registered.code === 'sharing_closed') {
        state.paused = { code: 'sharing_closed', at: now };
        writeState(options.dir, state);
        return empty('paused', { reason: 'Renor has closed sharing; nothing is sent until it is open again' });
      }
      return empty('failed', { reason: `${registered.reason}; will retry` });
    }
    state.token = registered.token;
    writeState(options.dir, state);
  }

  let sent = 0;
  let sentBatches = 0;
  const stillChosen = (): boolean => levelRank(effectiveLevel(options.dir, env)) >= levelRank(level);
  const stopped = (): ShareResult => ({ status: 'stopped', level, rows: sent, batches: sentBatches, skipped, reason: 'the choice was lowered during the run' });
  for (const batch of batches) {
    if (!stillChosen()) return stopped();
    // Under the default, the switch is asked before EACH batch, not once per run: closed (or unanswered) now means this batch and the
    // rest are not posted. The rows stay unsent (no watermark moves), so they go out when the switch is open again.
    if (viaDefault && !(await defaultIsOpen())) {
      return { status: 'paused', level, rows: sent, batches: sentBatches, skipped, reason: "Renor's switch for the default closed during the run; the rest is not sent" };
    }
    // Recorded before the request, so an `off` chosen while it is on the wire knows there may be something to delete.
    if (training) state.trainingEverSent = true; else state.everSent = true;
    writeState(options.dir, state);
    let status: number | null = null;
    let code: string | null = null;
    let failure: string | null = null;
    try {
      ({ status, code } = await post(endpoint, currentBearer(), JSON.stringify(body(batch.kind, batch.rows)), options.fetch, options.hosted, env));
    } catch (err) {
      failure = err instanceof Error ? err.message : 'request failed';
    }
    // Off was chosen while the request was out: it may have landed after the deletion off asked for, so ask again.
    if (effectiveLevel(options.dir, env) === 'off') {
      const removal = await requestDelete(options.dir, state, { env, fetch: options.fetch, hosted: options.hosted });
      if (removal.ok) removeLocalSharingData(options.dir);
      return { ...stopped(), reason: 'off was chosen during the run; the endpoint was asked to delete what it holds' };
    }
    if (failure !== null || status === null) {
      return { status: 'failed', level, rows: sent, batches: sentBatches, skipped, reason: failure ?? 'request failed' };
    }
    // The endpoint did not accept who this is. An install drops the credential (the next run asks for a new one); a hosted workspace's
    // proof is the operator's to fix. Either way nothing was stored and the rows stay unsent.
    if (status === 401 && code === 'unauthenticated') {
      if (!options.hosted) {
        delete state.token;
        writeState(options.dir, state);
      }
      return {
        status: 'failed', level, rows: sent, batches: sentBatches, skipped,
        reason: options.hosted ? "Renor did not accept this workspace's proof; will retry" : 'Renor did not accept this install\'s credential; it will ask for a new one',
      };
    }
    const last = batch.rows[batch.rows.length - 1]!.at;
    const key = batch.kind === 'retrieval' ? 'retrieval' : batch.kind === 'save' ? 'save' : 'session';
    if ((status < 200 || status >= 300) && code !== null && (TERMINAL_REFUSALS as readonly string[]).includes(code)) {
      // Refused for good: these rows are never sent again, whatever happens next, and nothing more is sent now.
      marks[key] = Math.max(marks[key], last);
      if (code === 'consent_off') {
        writeState(options.dir, state);
        // The workspace's record says off: apply it here, as choosing off does (it also asks for the deletion).
        // The training stream is tied to the workspace's record: that record being below `data` lowers the text, never the numbers.
        await chooseLevel({
          dir: options.dir, level: training ? 'signals' : 'off', wording: consent.wording, adult: record?.adult === true, source: 'service',
          env, fetch: options.fetch, now: options.now, hosted: options.hosted,
        });
        return { ...stopped(), reason: 'Renor says sharing is off for this workspace; it is now off here too' };
      }
      state.paused = { code: code as 'sharing_closed' | 'consent_required', at: now };
      writeState(options.dir, state);
      return {
        status: 'paused', level, rows: sent, batches: sentBatches, skipped,
        reason: code === 'sharing_closed'
          ? 'Renor has closed sharing; nothing is sent until it is open again'
          : 'Renor refused the consent record; nothing is sent until a level is chosen again',
      };
    }
    if (status < 200 || status >= 300) {
      return { status: 'failed', level, rows: sent, batches: sentBatches, skipped, reason: `the endpoint answered ${status}` };
    }
    marks[key] = Math.max(marks[key], last);
    if (training) state.trainingEverSent = true; else state.everSent = true;
    writeState(options.dir, state);
    sent += batch.rows.length;
    sentBatches += 1;
  }
  // Rows that failed the contract also move the watermark, so they are not recomputed forever.
  if (skipped > 0) {
    for (const item of projected) {
      if (valid.includes(item)) continue;
      const key = item.kind;
      marks[key] = Math.max(marks[key], item.at);
    }
    writeState(options.dir, state);
  }
  forgetSentExamples();
  return { status: 'sent', level, rows: sent, batches: sentBatches, skipped };
}

export interface RemoteDeleteResult {
  /** The endpoint holds nothing of this contributor now (or never did). */
  ok: boolean;
  /** A request was made. False when nothing had ever been sent, or when DO_NOT_TRACK=1 forbade it. */
  requested: boolean;
  /** DO_NOT_TRACK=1 forbade the request: the deletion is recorded here as owed and sent by the first run without it. */
  owedUnderDoNotTrack?: boolean;
  reason?: string;
}

const doNotTrack = (env: NodeJS.ProcessEnv): boolean => (env.DO_NOT_TRACK ?? '').trim() === '1';

/**
 * Asks the endpoint to delete everything it holds for this contributor. A request is made only if rows were ever sent: an
 * install that never shared sends nothing, even to be deleted. When the endpoint cannot be reached, the removal stays owed
 * (deletePending) and is tried again by the next sender run.
 */
export async function deleteRemote(options: Pick<SenderOptions, 'dir' | 'env' | 'fetch' | 'hosted'>): Promise<RemoteDeleteResult> {
  const state = readState(options.dir);
  if (state === null || (!state.everSent && !state.deletePending && state.trainingEverSent !== true && state.trainingDeletePending !== true && (state.retiredSecrets ?? []).length === 0)) {
    return { ok: true, requested: false };
  }
  return requestDelete(options.dir, state, options);
}

/**
 * Asks the endpoint to delete what the TRAINING contributor sent, and nothing else: the owner switched text for training off, so the text goes
 * (the usage numbers are not theirs to switch, and stay). A failure leaves it owed (trainingDeletePending), retried by settlePendingDelete.
 */
export async function deleteTraining(options: Pick<SenderOptions, 'dir' | 'env' | 'fetch' | 'hosted'>): Promise<RemoteDeleteResult> {
  const state = readState(options.dir);
  if (state === null || (state.trainingEverSent !== true && state.trainingDeletePending !== true)) return { ok: true, requested: false };
  const env = options.env ?? process.env;
  if (doNotTrack(env)) {
    writeState(options.dir, { ...state, trainingEverSent: true, trainingDeletePending: true });
    return { ok: false, requested: false, owedUnderDoNotTrack: true, reason: 'DO_NOT_TRACK=1 forbids any request, so the deletion is recorded here and sent the first time the engine runs without it' };
  }
  try {
    const { status } = await post(
      sharingEndpoint(env), trainingBearer(state.secret), JSON.stringify({ protocol: SHARING_PROTOCOL, action: 'delete' }), options.fetch, options.hosted, env);
    if ((status >= 200 && status < 300) || status === 401 || status === 404) {
      const { trainingEverSent: _sent, trainingDeletePending: _owed, trainingWatermarks: _marks, ...rest } = readState(options.dir) ?? state;
      writeState(options.dir, rest);
      return { ok: true, requested: true };
    }
    writeState(options.dir, { ...state, trainingEverSent: true, trainingDeletePending: true });
    return { ok: false, requested: true, reason: `the endpoint answered ${status}` };
  } catch (err) {
    writeState(options.dir, { ...state, trainingEverSent: true, trainingDeletePending: true });
    return { ok: false, requested: true, reason: err instanceof Error ? err.message : 'request failed' };
  }
}

/** The removal request for the contributor `state` names. A failure leaves the removal owed (deletePending) in `dir`. */
async function requestDelete(dir: string, state: SharingState, options: Pick<SenderOptions, 'env' | 'fetch' | 'hosted'>): Promise<RemoteDeleteResult> {
  const env = options.env ?? process.env;
  if (doNotTrack(env)) {
    // No request may be made from this process. The deletion is still owed: keep the secret it needs and mark it pending, so the
    // first run without DO_NOT_TRACK=1 sends it (settlePendingDelete).
    writeState(dir, { ...state, everSent: true, deletePending: true });
    return {
      ok: false, requested: false, owedUnderDoNotTrack: true,
      reason: 'DO_NOT_TRACK=1 forbids any request, so the deletion is recorded here and sent the first time the engine runs without it',
    };
  }
  // Every contributor this workspace has sent as: the usage numbers' id, and (hosted, text for training) the training id.
  const bearers = [
    ...(state.everSent || state.deletePending ? [bearerOf(state, options.hosted)] : []),
    ...(state.retiredSecrets ?? []),
    ...(state.trainingEverSent === true || state.trainingDeletePending === true ? [trainingBearer(state.secret)] : []),
  ];
  const owed = { ...state, everSent: true, deletePending: true };
  try {
    for (const bearer of bearers) {
      const { status } = await post(sharingEndpoint(env), bearer, JSON.stringify({ protocol: SHARING_PROTOCOL, action: 'delete' }), options.fetch, options.hosted, env);
      // 401 on a contributor the endpoint no longer knows is the same as gone.
      if ((status >= 200 && status < 300) || status === 401 || status === 404) continue;
      writeState(dir, owed);
      return { ok: false, requested: true, reason: `the endpoint answered ${status}` };
    }
    return { ok: true, requested: true };
  } catch (err) {
    writeState(dir, owed);
    return { ok: false, requested: true, reason: err instanceof Error ? err.message : 'request failed' };
  }
}

export interface ChooseOptions {
  dir: string;
  level: SharingLevel;
  wording: string;
  adult: boolean;
  source: ConsentRecord['source'];
  /** Which client application relayed the user's yes (source `prompt`): kept in the record. */
  client?: ConsentRecord['client'];
  env?: NodeJS.ProcessEnv;
  fetch?: Post;
  now?: () => number;
  hosted?: boolean;
  /**
   * Off only: owe the deletion of what Renor holds instead of asking for it inside this call. The sender's next tick asks (settlePendingDelete),
   * so a caller that must not reach the network (an agent's tool call) records the off at once and the request follows within the hour.
   */
  deferRemoteDelete?: boolean;
}

export interface ChooseResult {
  level: SharingLevel;
  changed: boolean;
  record: ConsentRecord | null;
  /** Off only: the endpoint was asked to delete (true), or could not be reached or DO_NOT_TRACK=1 forbade it, and it will be asked again (false), or had nothing (null). */
  remoteDeleted: boolean | null;
  /** Off only: DO_NOT_TRACK=1 forbade the deletion request; it is owed and sent by the first run without it. */
  deleteOwedUnderDoNotTrack?: boolean;
  reason?: string;
}

/**
 * Records a choice. Off is always recorded, even when nothing was ever on: a folder with no record has not chosen, and the default
 * (state.ts) applies to it, so an off that left no record would be undone by the default. Leaving `data` deletes the example texts
 * at once.
 */
export async function chooseLevel(options: ChooseOptions): Promise<ChooseResult> {
  const previous = readConsent(options.dir, options.env);
  const now = (options.now ?? Date.now)();
  if (options.level === 'off') {
    const record: ConsentRecord = { version: 1, level: 'off', changedAt: new Date(now).toISOString(), wording: options.wording, adult: previous?.adult ?? false, source: options.source };
    writeConsent(options.dir, record, options.env);
    // Stop first: from this write on, no process records or sends anything. Then owe the deletion before discarding anything,
    // so a process that dies here leaves it pending (with the secret it needs) for settlePendingDelete.
    const owed = readState(options.dir);
    if (owed !== null && owed.everSent && !owed.deletePending) writeState(options.dir, { ...owed, deletePending: true });
    for (const name of [EXAMPLES_FILE, `${EXAMPLES_FILE}-wal`, `${EXAMPLES_FILE}-shm`]) fs.rmSync(path.join(options.dir, name), { force: true });
    const result: RemoteDeleteResult = options.deferRemoteDelete === true
      ? { ok: false, requested: false }
      : await deleteRemote({ dir: options.dir, env: options.env, fetch: options.fetch, hosted: options.hosted });
    // The secret is removed only once the endpoint holds nothing; until then the state keeps it, with the deletion pending.
    if (result.ok) removeLocalSharingData(options.dir);
    const deleted = result.requested || result.owedUnderDoNotTrack ? result.ok : null;
    return {
      level: 'off', changed: previous?.level !== 'off', record, remoteDeleted: deleted, reason: result.reason,
      ...(result.owedUnderDoNotTrack ? { deleteOwedUnderDoNotTrack: true } : {}),
    };
  }
  if (!options.adult) throw new Error('sharing needs the user to confirm they are 18 or older');
  // A hosted workspace that ever chose Off keeps its numbers off: the text switch (data) toggles the text only, and switching it off returns
  // the workspace to Off, never to usage numbers.
  const numbersOff = options.hosted === true && (previous?.numbersOff === true || previous?.level === 'off');
  const hostedWas = options.hosted === true && previous?.level === 'data';
  // A hosted workspace leaving the text: what the training contributor sent is deleted, the install secret is rotated (the numbers' id after a tied
  // period is a new one), and the numbers resume from now, never repeating a row that was sent tied while the text was on.
  const leaveText = async (): Promise<boolean | null> => {
    const result = await deleteTraining({ dir: options.dir, env: options.env, fetch: options.fetch, hosted: true });
    const rotated = rotateSecret(options.dir);
    writeState(options.dir, { ...rotated, watermarks: {
      retrieval: Math.max(rotated.watermarks.retrieval, now), save: Math.max(rotated.watermarks.save, now), session: Math.max(rotated.watermarks.session, now),
    } });
    return result.requested || result.owedUnderDoNotTrack ? result.ok : null;
  };
  if (numbersOff && options.level === 'signals') {
    const off: ConsentRecord = { version: 1, level: 'off', changedAt: new Date(now).toISOString(), wording: options.wording, adult: true, source: options.source, numbersOff: true };
    writeConsent(options.dir, off, options.env);
    for (const name of [EXAMPLES_FILE, `${EXAMPLES_FILE}-wal`, `${EXAMPLES_FILE}-shm`]) fs.rmSync(path.join(options.dir, name), { force: true });
    let remoteDeleted: boolean | null = null;
    if (hostedWas) remoteDeleted = await leaveText();
    return { level: 'off', changed: previous?.level !== 'off', record: off, remoteDeleted };
  }
  // Choosing a level is the person's answer to a refusal that paused sending: sending resumes, with new rows only.
  const pausedState = readState(options.dir);
  if (pausedState?.paused !== undefined) {
    delete pausedState.paused;
    writeState(options.dir, pausedState);
  }
  if (previous !== null && previous.level === options.level && previous.adult) {
    return { level: options.level, changed: false, record: previous, remoteDeleted: null };
  }
  const record: ConsentRecord = {
    version: 1, level: options.level, changedAt: new Date(now).toISOString(), wording: options.wording, adult: true, source: options.source,
    ...(options.client !== undefined ? { client: options.client } : {}),
    ...(numbersOff ? { numbersOff: true as const } : {}),
  };
  writeConsent(options.dir, record, options.env);
  ensureState(options.dir);
  let remoteDeleted: boolean | null = null;
  if (levelRank(options.level) < levelRank('data')) {
    for (const name of [EXAMPLES_FILE, `${EXAMPLES_FILE}-wal`, `${EXAMPLES_FILE}-shm`]) fs.rmSync(path.join(options.dir, name), { force: true });
    // A hosted workspace whose owner switched text for training off: what the training contributor sent goes, the numbers stay (under a new id).
    if (hostedWas) remoteDeleted = await leaveText();
  }
  // A hosted workspace switching text for training ON: a new install secret, so the training contributor and the numbers' id start apart, and the
  // text stream's watermarks start now (shareStream reads the record's time).
  if (options.hosted === true && levelRank(options.level) >= levelRank('data') && previous?.level !== 'data') {
    const { trainingWatermarks: _w, ...rest } = rotateSecret(options.dir);
    writeState(options.dir, rest);
  }
  return { level: options.level, changed: true, record, remoteDeleted };
}

export interface DeleteAllResult {
  remote: RemoteDeleteResult;
  localRemoved: boolean;
}

/** Deletes what the endpoint holds and what sharing keeps here (state, example texts), and keeps the choice. */
export async function deleteAllShared(options: Pick<SenderOptions, 'dir' | 'env' | 'fetch' | 'hosted'>): Promise<DeleteAllResult> {
  const remote = await deleteRemote(options);
  if (!remote.ok) return { remote, localRemoved: false };
  removeLocalSharingData(options.dir);
  return { remote, localRemoved: true };
}

/** The retry of a removal that could not be made earlier. Called by the loop, whatever the level. */
export async function settlePendingDelete(options: Pick<SenderOptions, 'dir' | 'env' | 'fetch' | 'hosted'>): Promise<void> {
  const env = options.env ?? process.env;
  // Only DO_NOT_TRACK=1 forbids a request (deleteRemote records the deletion as owed under it). RENOR_SHARING=off stops sending rows; a
  // deletion the person already asked for is still theirs, and goes out.
  if (doNotTrack(env)) return;
  const state = readState(options.dir);
  if (state === null) return;
  // Only the text for training is owed (the owner switched it off): the numbers are untouched.
  if (!state.deletePending && state.trainingDeletePending === true) {
    await deleteTraining(options);
    return;
  }
  if (!state.deletePending) return;
  const result = await deleteRemote(options);
  if (result.ok) removeLocalSharingData(options.dir);
}
