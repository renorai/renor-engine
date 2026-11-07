import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { hiveIdentity } from '../memory/sourceName';
import { syncDirectorySync } from '../memory/durableAppend';

/**
 * Persistent OAuth client registry (CLIENT-PERSISTENCE fix).
 *
 * The MVP previously kept the DCR client registry in memory only. ChatGPT
 * runs dynamic client registration ONCE per connection and caches the
 * returned client_id, so a service restart wiped the registry and every
 * later authorization failed with invalid_client — the owner could never
 * re-authorize without the client re-registering. This store persists ONLY
 * registered OAuth client metadata (client_id, client_secret, redirect
 * URIs, grant types) across restarts. Authorization tickets and codes are
 * deliberately NOT persisted: they stay short-lived and single-use. Access
 * and refresh tokens also stay ephemeral for this bounded fix — after a
 * restart the owner must re-run the login once; the durable client
 * identity is what makes that re-authorization possible.
 *
 * Hard requirements implemented here:
 *  - explicit private path, validated OUTSIDE the memory/history trees at
 *    config time; the store directory ("root") must be 0700/no group or
 *    other bits, owned by the running uid, a real directory rather than a
 *    symlink, and reached through no symlink except a root-owned one that
 *    group and other cannot write (macOS's /var -> private/var), and then
 *    only on a path where every directory belongs to root or the running
 *    uid and group and other cannot write it;
 *  - store file must be a regular, non-symlink, owner-only (0600) file;
 *  - versioned, strictly validated schema — corrupt, unreadable, or
 *    schema-violating existing state FAILS CLOSED (startup error), never
 *    a silent reset to empty;
 *  - bounded registry (MAX_REGISTERED_CLIENTS);
 *  - atomic durable writes: temp file 0600 -> fsync -> rename -> dir fsync;
 *    registration succeeds only AFTER the record is durably on disk — an
 *    I/O failure throws and leaves NO in-memory-only acknowledged client;
 *  - single-process serialization: all mutations are synchronous FS
 *    operations inside one Node event loop, so concurrent registrations
 *    cannot interleave reads-modify-writes;
 *  - nothing here ever logs client secrets or full client IDs.
 */

const STORE_SCHEMA = 'mvp-oauth-clients/1';

/** A stored client. `pending_approval` is set until the owner approves it; a record without it predates approval and is approved. */
type StoredClient = OAuthClientInformationFull & { pending_approval?: true };

/** Client store bound (AUTH-H2); a store violating it is corrupt, not trimmed. */
export const MAX_PERSISTED_CLIENTS = 100;

/** Unapproved dynamic registrations are discarded after this owner-approval window. */
export const PENDING_CLIENT_APPROVAL_TTL_MS = 10 * 60_000;

/** Accesses trigger expiry cleanup, throttled to avoid rewriting the store more than once a minute. */
const EXPIRED_CLIENT_SWEEP_INTERVAL_MS = 60_000;

/** Operator-facing failure. Messages carry no secrets. */
export class ClientRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientRegistryError';
  }
}

function failClosed(reason: string): never {
  throw new ClientRegistryError(
    `OAuth client store is not usable: ${reason}. `
    + 'Refusing to start with a missing, corrupted, or unsafe client registry '
    + '(fail closed). Fix or remove the store file only after backing it up, '
    + 'then let clients register again; removed clients must be re-created by their owners.');
}

/** Running uid; the POSIX-only store refuses to run without one. */
function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) failClosed('process uid is unavailable on this platform');
  return uid;
}

const ROOT_UID = 0;
const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY = 0o1000;

/** Linux follows at most 40 symlinks in one path lookup, macOS 32. */
const MAX_PATH_SYMLINKS = 40;

const SYMLINK_RULE = 'store directory must not contain symlinks, except root-owned ones that group and other cannot write, '
  + 'on a path that only root and the service user can change';

/** Why the symlink at `here`, which `found` describes, may not be followed, or null when it may. */
function linkRefusal(here: string, found: fs.Stats): string | null {
  if (found.uid !== ROOT_UID) return 'a symlink on its path is not owned by root';
  if (found.mode & GROUP_OR_OTHER_WRITE) return 'a symlink on its path is writable by group or other';
  const leadsTo = fs.lstatSync(fs.realpathSync(here));
  if (leadsTo.uid !== ROOT_UID) return 'a symlink on its path leads to a directory that is not owned by root';
  if (leadsTo.mode & GROUP_OR_OTHER_WRITE) return 'a symlink on its path leads to a directory that is writable by group or other';
  return null;
}

/**
 * Why `dir`, which the path searches for the entry `found`, may not be on it, or null when it may. Whoever can write a
 * directory can rename or replace the entries in it, so it is root's or the service user's and closed to group and
 * other. A directory they can write is accepted only when it is sticky and root's, for an entry root owns, because
 * then only root may rename or remove that entry (/tmp is drwxrwxrwt).
 */
function directoryRefusal(dir: fs.Stats, found: fs.Stats): string | null {
  if (dir.uid !== ROOT_UID && dir.uid !== currentUid()) return 'a directory on its path is not owned by root or the service user';
  if ((dir.mode & GROUP_OR_OTHER_WRITE) === 0) return null;
  if ((dir.mode & STICKY) !== 0 && dir.uid === ROOT_UID && found.uid === ROOT_UID) return null;
  return 'a directory on its path is writable by group or other';
}

/**
 * Why the path to `dir` may not be used, or null when it may. These messages reach the /register response, so none
 * names a path.
 *
 * A path without a symlink is judged as it always was: by the store directory itself, in validateStoreRoot. A symlink on
 * the path is refused unless root owns it and group and other cannot write it, and the same holds for the directory it
 * leads to: macOS reaches its per-user temp directory through /var, a symlink to private/var. Linux reports every link
 * as lrwxrwxrwx, so there this still refuses all of them.
 *
 * A link is only as safe as the directory it sits in, and its target only as safe as every directory on the way to it:
 * whoever can write one of those can rename or replace what was just checked, and a path that was refused outright
 * before would be accepted. So the walk follows the path as the kernel does, one component at a time, and judges each
 * link and every directory a name is looked up in, those a link leads through included (/private is in no path an
 * operator writes, only in the target of /var). What nobody else can change nobody else can swap between this check and
 * the write that follows, which is why the write needs no descriptor of the directory (Node has no openat). Every
 * directory above the store is walked, and the walk must end where realpath does, or the path is not trusted.
 *
 * Owner and mode are all this sees. A bind mount looks like the directory it mounts and is judged as that directory,
 * but lstat and realpath cannot tell whether a mount sits on the path. Mounting over a directory takes root or owning
 * it, and every directory accepted here belongs to root or the service user, so the mount layout is the operator's to
 * protect, as root's own links are.
 */
function symlinkRefusal(dir: string): string | null {
  const real = fs.realpathSync(dir);
  if (real === path.resolve(dir)) return null;
  // At least one symlink is on the way. Follow the path as the kernel does, one component at a time.
  let at: string = path.sep;
  const absolute = path.isAbsolute(dir) ? dir : `${process.cwd()}${path.sep}${dir}`;
  let rest = absolute.split(path.sep);
  let links = 0;
  while (rest.length > 0) {
    const name = rest.shift() as string;
    if (name === '' || name === '.') continue;
    if (name === '..') {
      at = path.dirname(at);
      continue;
    }
    const here = path.join(at, name);
    const found = fs.lstatSync(here);
    const isLink = found.isSymbolicLink();
    if (isLink && ++links > MAX_PATH_SYMLINKS) return `${SYMLINK_RULE}; its path crosses too many symlinks`;
    const unsafe = (isLink ? linkRefusal(here, found) : null) ?? directoryRefusal(fs.lstatSync(at), found);
    if (unsafe !== null) return `${SYMLINK_RULE}; ${unsafe}`;
    if (!isLink) {
      at = here;
      continue;
    }
    const target = fs.readlinkSync(here);
    if (path.isAbsolute(target)) at = path.sep;
    rest = [...target.split(path.sep), ...rest];
  }
  // The walk judged what it went through and the kernel says where the path really goes. If the two differ, the walk did
  // not see what the kernel saw (a link changed under it, or a case it does not model), and that is not a path to trust.
  return at === real ? null : 'store directory could not be resolved consistently';
}

function validateStoreRoot(dir: string): void {
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch (err) {
    failClosed(`store directory is missing or unreadable (${(err as NodeJS.ErrnoException).code}); `
      + 'the operator must create it as an owner-only (0700) directory before startup');
  }
  if (!dirStat.isDirectory()) failClosed('store path parent is not a directory');
  if (dirStat.uid !== currentUid()) failClosed('store directory is not owned by the service user');
  if (dirStat.mode & 0o077) failClosed('store directory must be owner-only (0700)');
  // The directory itself is a real, owner-only directory of the service user. What is left is the path to it. The
  // refusal is judged outside the try, so its reason cannot be replaced by the one for a failed lookup.
  let refusal: string | null;
  try {
    refusal = symlinkRefusal(dir);
  } catch (err) {
    failClosed(`store directory could not be resolved (${(err as NodeJS.ErrnoException).code ?? 'io-error'})`);
  }
  if (refusal !== null) failClosed(refusal);
}

function validateStoreFile(filePath: string): void {
  const stat = fs.lstatSync(filePath); // throws if missing (handled by caller)
  if (!stat.isFile()) failClosed('store path is not a regular file (symlinks are rejected)');
  if (stat.uid !== currentUid()) failClosed('store file is not owned by the service user');
  if (stat.mode & 0o077) failClosed('store file must be owner-only (0600)');
}

/** Strict schema validation. Any deviation fails closed. */
function parseSnapshot(raw: string): Map<string, StoredClient> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failClosed('store file is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    failClosed('store file root must be an object');
  }
  const top = parsed as Record<string, unknown>;
  const knownKeys = new Set(['schema', 'clients']);
  for (const key of Object.keys(top)) {
    if (!knownKeys.has(key)) failClosed(`unknown top-level field '${key}'`);
  }
  if (top.schema !== STORE_SCHEMA) failClosed(`unsupported schema version (expected ${STORE_SCHEMA})`);
  if (!Array.isArray(top.clients)) failClosed('clients must be an array');
  if (top.clients.length > MAX_PERSISTED_CLIENTS) failClosed('store exceeds the bounded client limit');
  const clients = new Map<string, StoredClient>();
  for (const entry of top.clients) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) failClosed('client entry must be an object');
    const c = entry as Record<string, unknown>;
    const allowed = new Set(['client_id', 'client_secret', 'client_secret_expires_at', 'client_name', 'redirect_uris', 'grant_types',
      'token_endpoint_auth_method', 'client_id_issued_at', 'scope', 'client_uri', 'logo_uri', 'contacts', 'response_types', 'pending_approval']);
    for (const key of Object.keys(c)) {
      if (!allowed.has(key)) failClosed(`client entry has unknown field '${key}'`);
    }
    if (typeof c.client_id !== 'string' || c.client_id.length === 0) failClosed('client_id must be a non-empty string');
    if (clients.has(c.client_id)) failClosed(`duplicate client_id in store`);
    if (!Array.isArray(c.redirect_uris) || c.redirect_uris.length === 0
      || c.redirect_uris.some(u => typeof u !== 'string' || u.length === 0)) {
      failClosed('redirect_uris must be a non-empty array of strings');
    }
    if (c.client_secret !== undefined && typeof c.client_secret !== 'string') failClosed('client_secret must be a string when present');
    if (c.client_name !== undefined && typeof c.client_name !== 'string') failClosed('client_name must be a string when present');
    if (c.grant_types !== undefined && (!Array.isArray(c.grant_types) || c.grant_types.some(g => typeof g !== 'string'))) {
      failClosed('grant_types must be an array of strings when present');
    }
    if (c.token_endpoint_auth_method !== undefined && typeof c.token_endpoint_auth_method !== 'string') {
      failClosed('token_endpoint_auth_method must be a string when present');
    }
    if (c.client_secret_expires_at !== undefined
      && (typeof c.client_secret_expires_at !== 'number' || !Number.isFinite(c.client_secret_expires_at))) {
      failClosed('client_secret_expires_at must be a finite number when present');
    }
    // response_types: the SDK's DCR handler includes it for live clients
    // (observed in the live registry written by the ChatGPT connector).
    if (c.response_types !== undefined
      && (!Array.isArray(c.response_types) || c.response_types.some(r => typeof r !== 'string'))) {
      failClosed('response_types must be an array of strings when present');
    }
    if (typeof c.client_id_issued_at !== 'number' || !Number.isFinite(c.client_id_issued_at)) {
      failClosed('client_id_issued_at must be a finite number');
    }
    if (c.pending_approval !== undefined && typeof c.pending_approval !== 'boolean') {
      failClosed('pending_approval must be a boolean when present');
    }
    clients.set(c.client_id, entry as unknown as StoredClient);
  }
  return clients;
}

export class ClientRegistry {
  private clients = new Map<string, StoredClient>();
  private lastExpiredClientSweepAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly filePath: string) {
    validateStoreRoot(path.dirname(filePath));
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No store yet: a fresh deployment starts with zero clients. The
        // first registration creates the file; an EXISTING store that has
        // become unreadable/corrupt never takes this path (it fails below).
        return;
      }
      failClosed(`store file could not be inspected (${(err as NodeJS.ErrnoException).code})`);
    }
    if (stat === null) failClosed('store file could not be inspected');
    validateStoreFile(filePath);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      failClosed(`store file could not be read (${(err as NodeJS.ErrnoException).code})`);
    }
    this.clients = parseSnapshot(raw);
  }

  get size(): number {
    this.sweepExpiredPendingClients();
    return this.clients.size;
  }

  get(clientId: string): OAuthClientInformationFull | undefined {
    this.sweepExpiredPendingClients();
    return this.clients.get(clientId);
  }

  /** Whether the client is registered but not yet approved by the owner. Stores from before approval existed have none. */
  isPending(clientId: string): boolean {
    this.sweepExpiredPendingClients();
    return this.clients.get(clientId)?.pending_approval === true;
  }

  /**
   * True when an approved client other than `exceptClientId` already holds the hive name `identity`. A registration
   * that has not been approved holds no name: anyone can register one, so only the owner's approval claims a name.
   */
  holdsApprovedHiveIdentity(identity: string, exceptClientId: string): boolean {
    this.sweepExpiredPendingClients();
    for (const client of this.clients.values()) {
      if (client.client_id !== exceptClientId && client.pending_approval !== true
        && hiveIdentity(client.client_name) === identity) return true;
    }
    return false;
  }

  /**
   * The hive name of this client. Two approved spellings of one header form are one agent: the earliest
   * `client_id_issued_at`, then `client_id`, keeps the name, and the others resolve to no name. Nothing is deleted.
   * Unapproved registrations are not holders, so one cannot win the name by registering first.
   */
  hiveConnectionName(clientId: string): string | undefined {
    this.sweepExpiredPendingClients();
    const client = this.clients.get(clientId);
    if (!client) return undefined;
    const identity = hiveIdentity(client.client_name);
    if (!identity) return typeof client.client_name === 'string' ? client.client_name.trim() : undefined;
    const holders = [...this.clients.values()].filter(other => other.pending_approval !== true && hiveIdentity(other.client_name) === identity);
    holders.sort((a, b) => {
      const issued = (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0);
      if (issued !== 0) return issued;
      return a.client_id < b.client_id ? -1 : a.client_id > b.client_id ? 1 : 0;
    });
    return holders[0]?.client_id === clientId ? identity : '';
  }

  /**
   * Disk-first registration: persists durably BEFORE the record becomes
   * visible. Any I/O failure throws and leaves the registry (and disk)
   * unchanged — a client is never acknowledged in memory only.
   * The record is pending until approve(): it claims no hive name yet.
   */
  add(client: OAuthClientInformationFull): void {
    this.sweepExpiredPendingClients();
    if (this.clients.size >= MAX_PERSISTED_CLIENTS) {
      throw new ClientRegistryError(`client store bound reached (${MAX_PERSISTED_CLIENTS} clients)`);
    }
    if (this.clients.has(client.client_id)) {
      throw new ClientRegistryError('client_id already exists');
    }
    validateStoreRoot(path.dirname(this.filePath));
    const next = new Map(this.clients);
    next.set(client.client_id, { ...client, pending_approval: true });
    this.writeSnapshot(next);
    this.clients = next;
  }

  /**
   * The owner approved this client: it becomes a holder of its hive name. Persisted before it takes effect, like add.
   */
  approve(clientId: string): void {
    this.sweepExpiredPendingClients();
    const client = this.clients.get(clientId);
    if (!client) throw new ClientRegistryError('client is not registered');
    if (client.pending_approval !== true) return;
    validateStoreRoot(path.dirname(this.filePath));
    const next = new Map(this.clients);
    const { pending_approval: _pending, ...approved } = client;
    next.set(clientId, approved);
    this.writeSnapshot(next);
    this.clients = next;
  }

  private sweepExpiredPendingClients(): void {
    const now = Date.now();
    if (now >= this.lastExpiredClientSweepAt
      && now - this.lastExpiredClientSweepAt < EXPIRED_CLIENT_SWEEP_INTERVAL_MS) return;
    this.lastExpiredClientSweepAt = now;

    const next = new Map(this.clients);
    for (const [clientId, client] of next) {
      if (client.pending_approval === true
        && (client.client_id_issued_at ?? 0) * 1000 <= now - PENDING_CLIENT_APPROVAL_TTL_MS) {
        next.delete(clientId);
      }
    }
    if (next.size === this.clients.size) return;
    // Expiry only removes records nobody can use: a store that cannot be written right now must not break reads or
    // sign-in, so the expired records are dropped in memory and the next write (or restart) persists the removal.
    try {
      validateStoreRoot(path.dirname(this.filePath));
      this.writeSnapshot(next);
    } catch (err) {
      if (!(err instanceof ClientRegistryError)) throw err;
    }
    this.clients = next;
  }

  private writeSnapshot(clients: Map<string, StoredClient>): void {
    const payload = JSON.stringify({
      schema: STORE_SCHEMA,
      clients: Array.from(clients.values()),
    });
    const dir = path.dirname(this.filePath);
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeFileSync(fd, payload, 'utf-8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, this.filePath);
      // durable directory entry for the renamed store file (a no-op where directories cannot be fsynced: Windows, #1563)
      syncDirectorySync(dir);
    } catch (err) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw new ClientRegistryError(
        `client registration could not be persisted (${(err as NodeJS.ErrnoException).code ?? 'io-error'}); no client was registered`);
    }
  }
}
