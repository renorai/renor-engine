import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSharingLevel, lowerLevel, type SharingLevel } from './fields';

/**
 * Where sharing keeps what it knows, and who may change it.
 *
 * Two small files in one owner-only folder (the sharing folder):
 *   sharing.json        the consent record: the level, when it was chosen, the wording version the user saw, whether they
 *                       attested to being an adult, and who set it. One per install (self-hosted) or per workspace (hosted).
 *   sharing-state.json  what the sender needs between runs: the random secret that makes the contributor id, how far each row
 *                       kind has been sent, and whether rows were ever sent (only then does `off` have anything to remove).
 *
 * No file exists until a user picks a level above off. A folder where the user never chose has neither file, and reading its
 * level is `off`. Off writes nothing: the record of an off choice is made only when there was a level to turn off.
 */

export const CONSENT_FILE = 'sharing.json';
export const STATE_FILE = 'sharing-state.json';
/**
 * The deletion cutoff: when sharing's local state was last removed after a deletion, the time before which no row is ever sent again. It holds no
 * secret and no row, and it outlives the state file (which holds the contributor's secret and is removed on deletion), so a new contributor
 * created afterwards starts from it and only activity after the deletion is shared, never the history that was just deleted.
 */
export const CUTOFF_FILE = 'sharing-cutoff.json';
/** The text of examples a `data` choice keeps until it is sent; it lives next to the two files. */
export const EXAMPLES_FILE = 'sharing-examples.sqlite';
/**
 * The anonymous usage counters (usage.ts): the random install id the usage rows carry, and the counts not yet sent. Removed with the state on a
 * deletion, and when a hosted workspace's secret rotates, so a new contributor never carries the old install id.
 */
export const USAGE_FILE = 'sharing-usage.json';

export interface ConsentRecord {
  version: 1;
  level: SharingLevel;
  /** ISO instant the level was last chosen. */
  changedAt: string;
  /** The id of the words the user saw when they chose it (CLI_WORDING_VERSION, or the dashboard's own id). */
  wording: string;
  /** The user said they are 18 or older. Required for every level above off. */
  adult: boolean;
  /**
   * Where the choice was made. `agent` is a level an agent LOWERED on the user's word (the sharing_level tool never raises); `prompt` is a
   * yes the user gave the engine directly through their MCP client's own question (elicitation), only ever to anonymous numbers; the rest are the terminal and the dashboard.
   */
  source: 'cli' | 'setup' | 'dashboard' | 'service' | 'agent' | 'prompt';
  /**
   * The install this record was made on: the SHA-256 of the install's random id (installBinding). A self-hosted record counts as a yes
   * only on the install that wrote it, so a memory folder synced or restored on another computer, or a record copied from another
   * account, carries no consent there. Absent on a hosted record (its owner's switch is the dashboard's, not this machine's).
   */
  install?: string;
  /**
   * Which client application answered, when the yes came from a question put through the user's MCP client (`source: prompt`): the
   * `clientInfo` it declared at connect, so the record says whose software said yes.
   */
  client?: { name: string; version: string };
  /**
   * A hosted workspace that once chose Off keeps its usage numbers off for good: its owner may later switch the text for training on and off
   * again, and the numbers must not start because of it. Set only on a hosted record; the numbers stream reads it, the text switch never clears it.
   */
  numbersOff?: true;
}

export interface SharingState {
  version: 1;
  /**
   * 32 random bytes, base64url. It makes the batch ids, and it is a hosted workspace's bearer (its contributor id is its SHA-256). A self-hosted
   * install does not send it: it sends `token`, the credential Renor issued it, and its contributor id is the SHA-256 of that.
   */
  secret: string;
  /**
   * The credential Renor issued this install when it asked (`register`: 86 base64url characters, a random id and its MAC). Absent until the
   * install first sends, and dropped when Renor refuses it (the next send asks for a new one). Never kept for a hosted workspace.
   */
  token?: string;
  /** Newest `at` (ms) of each row kind already sent. */
  watermarks: { retrieval: number; save: number; session: number };
  /**
   * A hosted workspace whose owner switched text for training on sends that text as a second contributor, apart from the usage numbers (which
   * are sent untied, under `secret`): the training contributor is tied to the workspace so the owner's switch can be held. Its own watermarks.
   */
  trainingWatermarks?: { retrieval: number; save: number; session: number };
  /**
   * Earlier bearers of this install or workspace (a hosted workspace's retired secrets, a self-hosted install's retired credentials), kept only here
   * so Renor can still be asked to delete what they sent. The id rotates at the first send of every UTC calendar month (monthlyRotation), and a hosted
   * workspace's also every time its owner switches text for training on or off, so one month's id cannot be matched to the next. The server never
   * learns that these belong together. They are kept for as long as Renor may hold their rows (no fixed period: TELEMETRY.md), and removed with
   * the rest of this file once `off` or `delete` has had every one of them deleted. At most MAX_RETIRED_BEARERS (a hundred years of months).
   */
  retiredSecrets?: string[];
  /**
   * The UTC month (`2026-11`) the current secret was first used to send in. At the first send of a later month the secret (and a self-hosted
   * install's credential) is replaced, so an install is a new contributor every month. Absent until the first send.
   */
  secretMonth?: string;
  /**
   * When this install (or hosted workspace) was first seen by sharing: the start of that UTC day (ms). Kept only here, to say how old the install
   * is as one of four ranges (fields.ts INSTALL_AGE_BUCKETS); the date itself is never sent. Set the first time the sender runs.
   */
  firstSeen?: number;
  /**
   * Training bearers (trainingBearer of a retired install secret) whose removal is still owed: the owner switched text for training off or on and
   * the secret rotated before the training contributor could be deleted (the endpoint was unreachable, or DO_NOT_TRACK=1 deferred it). Each is kept
   * until the endpoint has been asked to delete it, independently of the new anonymous identity and of whether usage numbers were ever sent.
   */
  retiredTrainingBearers?: string[];
  /** A removal of the training contributor is owed (it could not be reached when it was asked for). */
  trainingDeletePending?: boolean;
  /** Training rows were sent at some time, so the endpoint may hold some for the training contributor. */
  trainingEverSent?: boolean;
  /**
   * The endpoint refused the training contributor's batch as `unmapped` (ms): its id is not tied to this workspace, so the platform has to tie it
   * again (it does when the dashboard reads the workspace). Cleared by the next accepted training batch, and when the secret rotates.
   */
  trainingUnmappedAt?: number;
  /** Rows were sent at some time, so the endpoint may hold some for this contributor. */
  everSent: boolean;
  /** A removal is owed to the endpoint (it could not be reached when it was asked for). Retried before anything else. */
  deletePending: boolean;
  /**
   * The endpoint refused a batch for good, so nothing is sent until this clears: `sharing_closed` (Renor's switch is off) clears
   * when the sharing status says open again, `consent_required` when the person chooses a level again. Absent when sending.
   */
  paused?: { code: 'sharing_closed' | 'consent_required'; at: number };
}

/**
 * Whether this engine runs behind the hosted gateway: the same rule as the service (mvp/config.ts reads MVP_GATEWAY_SECRET as
 * gatewaySecret, and mvp/cli.ts starts the sender with hosted: Boolean(config.gatewaySecret)), so the CLI sends as the service does.
 */
export function hostedEngine(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MVP_GATEWAY_SECRET ?? '').trim() !== '';
}

/** The install's random id, in the install's state folder (not its config folder, which dotfile syncs carry to other computers). */
export const INSTALL_ID_FILE = 'install-id';

/**
 * Where the install's random id lives: inside RENOR_SHARING_DIR when it is set (a relocated install keeps everything together), else in
 * the user's state folder ($XDG_STATE_HOME, ~/.local/state), apart from the config folder that holds the consent records.
 */
export function installIdPath(env: NodeJS.ProcessEnv = process.env): string {
  const set = (env.RENOR_SHARING_DIR ?? '').trim();
  if (set !== '') return path.join(path.resolve(set), INSTALL_ID_FILE);
  const xdg = (env.XDG_STATE_HOME ?? '').trim();
  return path.join(xdg !== '' ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'state'), 'renor', INSTALL_ID_FILE);
}

const INSTALL_ID_SHAPE = /^[0-9a-f]{32}$/;

function readInstallId(env: NodeJS.ProcessEnv): string | null {
  try {
    const id = fs.readFileSync(installIdPath(env), 'utf8').trim();
    return INSTALL_ID_SHAPE.test(id) ? id : null;
  } catch {
    return null;
  }
}

const bindingOf = (id: string): string => createHash('sha256').update(`renor-install/v1:${id}`).digest('hex');

const bindingCache = new Map<string, { stamp: string; binding: string | null }>();

/** What a self-hosted record must carry to count here: the hash of this install's id. Null when this install has none yet (reading makes no file). */
export function installBinding(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = installIdPath(env);
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    bindingCache.delete(file);
    return null;
  }
  const hit = bindingCache.get(file);
  if (hit && hit.stamp === stamp) return hit.binding;
  const id = readInstallId(env);
  const binding = id === null ? null : bindingOf(id);
  bindingCache.set(file, { stamp, binding });
  return binding;
}

/** This install's binding, making its id on first use. Only a writer of a consent record calls this. */
export function ensureInstallBinding(env: NodeJS.ProcessEnv = process.env): string {
  const existing = installBinding(env);
  if (existing !== null) return existing;
  const file = installIdPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${randomBytes(16).toString('hex')}\n`, { mode: 0o600 });
  // Another process may have made one meanwhile: keep the first (link fails if the name exists), so every writer binds to the same id.
  try {
    fs.linkSync(temp, file);
  } catch {
    // already there
  } finally {
    fs.rmSync(temp, { force: true });
  }
  const made = installBinding(env);
  if (made === null) throw new Error('could not make this install\'s id for the sharing record');
  return made;
}

/** The folder of a self-hosted install: RENOR_SHARING_DIR, else the user's config folder. */
export function defaultSharingDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = (env.RENOR_SHARING_DIR ?? '').trim();
  if (set !== '') return path.resolve(set);
  const xdg = (env.XDG_CONFIG_HOME ?? '').trim();
  return path.join(xdg !== '' ? path.resolve(xdg) : path.join(os.homedir(), '.config'), 'renor');
}

/**
 * The sharing folder for a run: an explicit folder, else RENOR_SHARING_DIR, else the one inside the memory folder when there is
 * one (a service, or a command given its memory folder: the choice is per memory folder, so per workspace), else the user's
 * config folder (one choice per install).
 */
export function sharingDirFor(memoryDir: string | null, env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return path.resolve(explicit);
  if ((env.RENOR_SHARING_DIR ?? '').trim() !== '') return defaultSharingDir(env);
  return memoryDir !== null ? workspaceSharingDir(memoryDir) : defaultSharingDir(env);
}

/** The folder of one hosted workspace: inside its memory folder, so it goes with the memory on deletion. */
export function workspaceSharingDir(memoryDir: string): string {
  return path.join(path.resolve(memoryDir), '.memory-index', 'sharing');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function writeJson(dir: string, name: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const temp = path.join(dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Inspected = { kind: 'none' } | { kind: 'unreadable' } | { kind: 'foreign' } | { kind: 'ok'; record: ConsentRecord };

/**
 * What the folder's consent file is on this install. A file that is there but cannot be read is `unreadable` (a choice nobody can read: off).
 * A self-hosted record that does not carry this install's binding is `foreign` (copied from another install, or synced in with a memory
 * folder): it is nobody's yes here, so it is read as no choice at all, except an `off` (or a record without the adult confirmation, which reads as off), which is
 * honoured wherever it came from because a stricter reading never hurts. A hosted engine's records are the dashboard's, bound to the workspace, not to this machine.
 */
function inspectConsent(dir: string, env: NodeJS.ProcessEnv): Inspected {
  const file = path.join(dir, CONSENT_FILE);
  if (!fs.existsSync(file)) return { kind: 'none' };
  const raw = readJson(file);
  if (!isRecord(raw) || raw.version !== 1 || !isSharingLevel(raw.level)) return { kind: 'unreadable' };
  const sources = ['cli', 'setup', 'dashboard', 'service', 'agent', 'prompt'];
  if (typeof raw.changedAt !== 'string' || typeof raw.wording !== 'string' || typeof raw.adult !== 'boolean') return { kind: 'unreadable' };
  if (typeof raw.source !== 'string' || !sources.includes(raw.source)) return { kind: 'unreadable' };
  // Nobody above the terminal may have chosen `data`: an agent only ever lowers, and a client's answer to a question raises to anonymous
  // numbers only. A record that says otherwise was not written by this engine, so it is read as unreadable (off).
  if (raw.level === 'data' && (raw.source === 'agent' || raw.source === 'prompt')) return { kind: 'unreadable' };
  const client = isRecord(raw.client) && typeof raw.client.name === 'string' && typeof raw.client.version === 'string'
    ? { name: raw.client.name, version: raw.client.version }
    : undefined;
  const record: ConsentRecord = {
    version: 1,
    level: raw.level,
    changedAt: raw.changedAt,
    wording: raw.wording,
    adult: raw.adult,
    source: raw.source as ConsentRecord['source'],
    ...(typeof raw.install === 'string' ? { install: raw.install } : {}),
    ...(client !== undefined ? { client } : {}),
    ...(raw.numbersOff === true ? { numbersOff: true as const } : {}),
  };
  // An off, or a record that says the user is not an adult (which reads as off), only lowers: honoured wherever it came from.
  if (!hostedEngine(env) && record.level !== 'off' && record.adult) {
    const mine = installBinding(env);
    if (mine === null || record.install !== mine) return { kind: 'foreign' };
  }
  return { kind: 'ok', record };
}

/** The consent record, or null when none was made, or the file is unreadable (never read as consent), or it was made on another install. */
export function readConsent(dir: string, env: NodeJS.ProcessEnv = process.env): ConsentRecord | null {
  const found = inspectConsent(dir, env);
  return found.kind === 'ok' ? found.record : null;
}

/** A consent file is there, but it was made on another install (copied, or synced in with the memory folder): it counts as no choice here. */
export function foreignConsent(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return inspectConsent(dir, env).kind === 'foreign';
}

/** Writes the record, bound to this install (a self-hosted record only; a hosted workspace's record is the dashboard's). */
export function writeConsent(dir: string, record: ConsentRecord, env: NodeJS.ProcessEnv = process.env): void {
  const { install: _old, ...rest } = record;
  writeJson(dir, CONSENT_FILE, hostedEngine(env) ? rest : { ...rest, install: ensureInstallBinding(env) });
}

/** `RENOR_SHARING`: off, signals or data. It can only lower what the record says, never raise it: consent needs a record. */
export function envOverride(env: NodeJS.ProcessEnv = process.env): SharingLevel | null {
  if ((env.DO_NOT_TRACK ?? '').trim() === '1') return 'off';
  const raw = (env.RENOR_SHARING ?? '').trim().toLowerCase();
  if (raw === '') return null;
  if (!isSharingLevel(raw)) throw new Error('RENOR_SHARING must be off, signals or data');
  return raw;
}

/**
 * The level in force while the person has not chosen: the default. The owner's decision (2026-10-25, confirmed 2026-10-28) is anonymous
 * usage numbers (`signals`) ON by default, with a notice (notice.ts) and a switch: DO_NOT_TRACK=1, RENOR_SHARING=off,
 * `renor-engine telemetry off` or an agent's `sharing` tool call turn it off in one step. Nothing leaves until Renor's own switch for
 * the default is open (the sender asks before it sends: send.ts), and a choice (a consent file, including an explicit off) always wins
 * over it. `data` is never a default: text for training is opt-in only.
 *
 * `RENOR_SHARING_DEFAULT=off|signals` replaces it for one process: an operator's setting, or a test. It does not make anyone's
 * choice for them, and `RENOR_SHARING` / `DO_NOT_TRACK` still lower whatever it says.
 */
export const SHIPPED_DEFAULT_LEVEL: 'off' | 'signals' = 'signals';

/**
 * The shipped default applies to hosted engines too (owner approval 2026-10-28, production go 2026-11-01): a hosted engine (hostedEngine)
 * with no choice and no RENOR_SHARING_DEFAULT reads `signals`. RENOR_SHARING_DEFAULT=off is the explicit opt-out, a hosted owner's
 * dashboard choice wins over it, and the operator switches (the gateway's /sharing/status and /sharing/default-status, and the database's
 * learning_default) remain the real on/off. A hosted engine still prints no terminal notice: the dashboard panel shows the default.
 */
export function defaultLevel(env: NodeJS.ProcessEnv = process.env): 'off' | 'signals' {
  const raw = (env.RENOR_SHARING_DEFAULT ?? '').trim().toLowerCase();
  if (raw === '') return SHIPPED_DEFAULT_LEVEL;
  if (raw === 'off' || raw === 'signals') return raw;
  throw new Error('RENOR_SHARING_DEFAULT must be off or signals');
}

/**
 * Whether the person has chosen in this folder: a consent file is there, valid or not, and was made on this install. A file that cannot
 * be read is a choice that cannot be read, never an absence of one, so it is read as off and the default never applies over it. A
 * file made on another install (foreignConsent) is no choice of this one.
 */
export function hasChosen(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const kind = inspectConsent(dir, env).kind;
  return kind === 'ok' || kind === 'unreadable';
}

/**
 * The install's own record (the one `renor setup` and a command without a memory folder write, in defaultSharingDir) as a
 * limit on another sharing folder on this install, a workspace's: null when there is no install record, or when `dir` is that
 * folder itself. It lowers what a workspace's own record says, whatever that is.
 */
export function installLimit(dir: string, env: NodeJS.ProcessEnv = process.env): SharingLevel | null {
  const installDir = defaultSharingDir(env);
  if (path.resolve(dir) === installDir) return null;
  const record = readConsentCached(installDir, env);
  // An install file that is there and cannot be read is an answer nobody can read: the stricter reading, off.
  if (record === null) return hasChosen(installDir, env) ? 'off' : null;
  return record.adult ? record.level : 'off';
}

/**
 * The install's choice as the choice of a memory folder that has no record of its own: what a person answered once at `renor setup`
 * ("yes" is `data`) counts for every memory folder on a self-hosted install that has not been given its own answer, so one answer is
 * enough. Null when `dir` has a record (a choice always wins, unreadable included), when `dir` is the install's own folder, when the
 * install has no readable adult record, and on a hosted engine (a hosted workspace's switch is the dashboard's, never this machine's).
 */
export function inheritedChoice(dir: string, env: NodeJS.ProcessEnv = process.env): ConsentRecord | null {
  if (hostedEngine(env) || hasChosen(dir, env)) return null;
  const installDir = defaultSharingDir(env);
  if (path.resolve(dir) === installDir) return null;
  const record = readConsentCached(installDir, env);
  return record !== null && record.adult ? record : null;
}

/** The record the sender stands on: the folder's own, else the install's answer it inherits. Null when nobody has chosen. */
export function consentFor(dir: string, env: NodeJS.ProcessEnv = process.env): ConsentRecord | null {
  return readConsentCached(dir, env) ?? inheritedChoice(dir, env);
}

/**
 * The level in force right now: the recorded level (this folder's, else the install's answer), or the default when the person has not
 * chosen, lowered by the install's own record (the stricter of the two wins) and by the environment. An unreadable record, an
 * under-age user or a missing attestation is `off`: a file that is there is a choice, and the default never applies over it. Read from
 * the files at each call (a stat tells whether they changed), so a choice made in another process takes effect on the next call, with
 * no restart.
 */
export function effectiveLevel(dir: string, env: NodeJS.ProcessEnv = process.env): SharingLevel {
  const record = readConsentCached(dir, env) ?? inheritedChoice(dir, env);
  let level: SharingLevel = record === null ? (hasChosen(dir, env) ? 'off' : defaultLevel(env)) : !record.adult ? 'off' : record.level;
  const limit = installLimit(dir, env);
  if (limit !== null) level = lowerLevel(level, limit);
  const override = envOverride(env);
  if (override !== null) level = lowerLevel(level, override);
  return level;
}

/** Whether what is in force right now is the default, not a choice: nobody chose here or on the install, and the level is above off. */
export function defaultInForce(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !hasChosen(dir, env) && inheritedChoice(dir, env) === null && effectiveLevel(dir, env) !== 'off';
}

const cache = new Map<string, { stamp: string; record: ConsentRecord | null }>();
function readConsentCached(dir: string, env: NodeJS.ProcessEnv): ConsentRecord | null {
  const file = path.join(dir, CONSENT_FILE);
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    // The install's binding is part of the answer (a record counts only on the install that wrote it), so it is part of the stamp.
    stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}:${hostedEngine(env)}:${installBinding(env)}`;
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.record;
  const record = readConsent(dir, env);
  cache.set(file, { stamp, record });
  return record;
}

export function readState(dir: string): SharingState | null {
  const raw = readJson(path.join(dir, STATE_FILE));
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.secret !== 'string' || raw.secret.length < 32) return null;
  const marks = isRecord(raw.watermarks) ? raw.watermarks : {};
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  return {
    version: 1,
    secret: raw.secret,
    watermarks: { retrieval: num(marks.retrieval), save: num(marks.save), session: num(marks.session) },
    everSent: raw.everSent === true,
    deletePending: raw.deletePending === true,
    ...(isRecord(raw.trainingWatermarks)
      ? { trainingWatermarks: { retrieval: num(raw.trainingWatermarks.retrieval), save: num(raw.trainingWatermarks.save), session: num(raw.trainingWatermarks.session) } }
      : {}),
    ...(Array.isArray(raw.retiredSecrets) && raw.retiredSecrets.some(item => typeof item === 'string' && item.length >= 32)
      ? { retiredSecrets: raw.retiredSecrets.filter((item): item is string => typeof item === 'string' && item.length >= 32).slice(-MAX_RETIRED_BEARERS) }
      : {}),
    ...(Array.isArray(raw.retiredTrainingBearers) && raw.retiredTrainingBearers.some(item => typeof item === 'string' && item.length >= 32)
      ? { retiredTrainingBearers: raw.retiredTrainingBearers.filter((item): item is string => typeof item === 'string' && item.length >= 32).slice(-MAX_RETIRED_BEARERS) }
      : {}),
    ...(typeof raw.secretMonth === 'string' && MONTH_SHAPE.test(raw.secretMonth) ? { secretMonth: raw.secretMonth } : {}),
    ...(typeof raw.firstSeen === 'number' && Number.isFinite(raw.firstSeen) && raw.firstSeen > 0 ? { firstSeen: raw.firstSeen } : {}),
    ...(raw.trainingEverSent === true ? { trainingEverSent: true } : {}),
    ...(typeof raw.trainingUnmappedAt === 'number' ? { trainingUnmappedAt: raw.trainingUnmappedAt } : {}),
    ...(raw.trainingDeletePending === true ? { trainingDeletePending: true } : {}),
    ...(typeof raw.token === 'string' && /^[A-Za-z0-9_-]{86}$/.test(raw.token) ? { token: raw.token } : {}),
    ...pausedOf(raw.paused),
  };
}

function pausedOf(raw: unknown): Pick<SharingState, 'paused'> {
  if (!isRecord(raw) || (raw.code !== 'sharing_closed' && raw.code !== 'consent_required')) return {};
  return { paused: { code: raw.code, at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0 } };
}

/**
 * How many retired bearers the state keeps. Each month adds at most one (plus one per hosted text switch or refused credential), so this is
 * about a hundred years; it exists only so a damaged file cannot grow without end. Rows are kept by Renor with no fixed period, so a bearer is
 * never dropped for its age: only a completed deletion removes them.
 */
export const MAX_RETIRED_BEARERS = 1200;

const MONTH_SHAPE = /^\d{4}-\d{2}$/;

/** `2026-11`: the UTC calendar month of a time. */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** The start (ms) of the UTC day of a time: the first-seen date is kept no finer than a day. */
export function dayStart(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

/** The public name of a contributor: the SHA-256 of its secret, in hex. The endpoint knows only this, never the secret. */
export function contributorId(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * The bearer of a hosted workspace's training contributor: derived from the workspace's secret, so nothing new is stored, and a different
 * contributor id from the one the usage numbers are sent under (the numbers are never tied to the workspace; this one is, on purpose).
 */
export function trainingBearer(secret: string): string {
  return createHmac('sha256', secret).update('renor-sharing-training/v1').digest('base64url');
}

/**
 * A new install secret (a new untied id), the old one retired so a deletion can still be asked for it. Nothing was sent under the new one yet, and
 * the training contributor (derived from the secret) starts over. A self-hosted install's credential (`token`, which is what it sends as its bearer)
 * is retired with it and dropped, so its next send asks Renor for a new one: a new contributor id. Returns the new state.
 */
export function rotateSecret(dir: string, options: { keepUsage?: boolean } = {}): SharingState {
  const state = ensureState(dir);
  const { trainingEverSent: _t, trainingDeletePending: _d, trainingWatermarks: _w, trainingUnmappedAt: _u, token: _token, secretMonth: _m, ...rest } = state;
  // The training contributor is derived from the secret being retired, so a training deletion still owed (or rows ever sent to it) must keep its bearer.
  const trainingOwed = state.trainingEverSent === true || state.trainingDeletePending === true;
  const retiredTraining = [...new Set([...(state.retiredTrainingBearers ?? []), ...(trainingOwed ? [trainingBearer(state.secret)] : [])])].slice(-MAX_RETIRED_BEARERS);
  // What the rows were sent under: a self-hosted install's credential, else (hosted, or an install from before credentials) the secret itself.
  const bearer = state.token ?? state.secret;
  // The usage rows' install id would match the old id to the new one: it goes with the secret. The monthly rotation keeps what the file
  // counted (an install is not a new install every month, and days not yet sent are not lost) and only gives it a new random install id.
  if (options.keepUsage === true) renewUsageInstallId(dir);
  else fs.rmSync(path.join(dir, USAGE_FILE), { force: true });
  const next: SharingState = {
    ...rest,
    secret: randomBytes(32).toString('base64url'),
    retiredSecrets: [...new Set([...(state.retiredSecrets ?? []), ...(state.everSent || state.deletePending ? [bearer] : [])])].slice(-MAX_RETIRED_BEARERS),
    ...(retiredTraining.length > 0 ? { retiredTrainingBearers: retiredTraining } : {}),
    everSent: false,
  };
  writeState(dir, next);
  return next;
}

/**
 * A new random install id in the usage file (usage.ts), keeping everything else in it: the install row's sent flag, the days not yet sent, the
 * funnel. A file that is missing or unreadable is left alone (usage.ts makes a fresh one with a fresh id when it next counts).
 */
function renewUsageInstallId(dir: string): void {
  const file = path.join(dir, USAGE_FILE);
  const raw = readJson(file);
  if (!isRecord(raw) || typeof raw.installId !== 'string') return;
  writeJson(dir, USAGE_FILE, { ...raw, installId: randomBytes(16).toString('hex') });
}

/**
 * The monthly id (owner decision, 2026-11-08): called by the sender just before it sends, it gives the install a new contributor id at the first
 * send of each UTC calendar month, so no id spans more than one month. A state that never sent just records the month (its id is unused, so
 * there is nothing to separate). Returns the state to send under (the same object when nothing changed). It also records the first-seen day
 * the first time it runs.
 */
export function monthlyRotation(dir: string, state: SharingState, now: number): SharingState {
  const month = monthOf(now);
  let next = state;
  if (state.secretMonth !== month) {
    const used = state.everSent || state.deletePending;
    // A state that sent in an earlier month (or before this field existed) moves to a new id; an unused one only takes the month.
    if (used) writeState(dir, state);
    next = used ? { ...rotateSecret(dir, { keepUsage: true }), secretMonth: month } : { ...state, secretMonth: month };
  }
  if (next.firstSeen === undefined) next = { ...next, firstSeen: dayStart(now) };
  if (next !== state) writeState(dir, next);
  return next;
}

/** The deletion cutoff (ms) in the folder, or 0 when no deletion ever removed the state here. */
export function readCutoff(dir: string): number {
  const raw = readJson(path.join(dir, CUTOFF_FILE));
  return isRecord(raw) && raw.version === 1 && typeof raw.at === 'number' && Number.isFinite(raw.at) && raw.at > 0 ? raw.at : 0;
}

/**
 * A state for a new contributor. Its watermarks start at `cutoff` (the deletion cutoff), so history that was deleted is never sent again. Its
 * first-seen day is today: a state is made when a level above off is first in force here.
 */
export function freshState(cutoff = 0, now: number = Date.now()): SharingState {
  return {
    version: 1,
    secret: randomBytes(32).toString('base64url'),
    watermarks: { retrieval: cutoff, save: cutoff, session: cutoff },
    everSent: false,
    deletePending: false,
    firstSeen: dayStart(now),
  };
}

export function writeState(dir: string, state: SharingState): void {
  writeJson(dir, STATE_FILE, state);
}

/** The state, made on first use. Only a sender that has a level above off calls this. */
export function ensureState(dir: string, now: number = Date.now()): SharingState {
  const existing = readState(dir);
  if (existing !== null) return existing;
  const made = freshState(readCutoff(dir), now);
  writeState(dir, made);
  return made;
}

/**
 * Removes the files sharing keeps (the record stays: it is the proof of what was chosen, and holds no row). When a state existed, the deletion
 * cutoff is written first (at least `now`, and at least every watermark the state had), so the next contributor never re-sends the deleted history.
 */
export function removeLocalSharingData(dir: string, now: number = Date.now()): void {
  const state = readState(dir);
  if (state !== null) {
    const at = Math.max(
      now, readCutoff(dir), ...Object.values(state.watermarks), ...Object.values(state.trainingWatermarks ?? {}),
    );
    writeJson(dir, CUTOFF_FILE, { version: 1, at });
  }
  for (const name of [STATE_FILE, USAGE_FILE, EXAMPLES_FILE, `${EXAMPLES_FILE}-wal`, `${EXAMPLES_FILE}-shm`]) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}
