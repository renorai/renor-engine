import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import request from 'supertest';
import { claimManifest } from '../helpers/manifestGate';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH, MVP_VERSION_PATH, type MvpApp } from '../../src/mvp/server';
import {
  BUILD_MANIFEST_PATH,
  ENGINE_VERSION,
  MAX_BUILD_MANIFEST_BYTES,
  readBuildIdentity,
  type BuildIdentity,
} from '../../src/buildIdentity';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Build-identity observability for the surface alpha tenants actually run.
 *
 * GET /version on the MVP service must answer which source commit the instance
 * was built from, using the same non-throwing manifest reader as the
 * librarian's GET /api/health — and it must leak nothing else: no tenant slug,
 * no filesystem/vault path, no token, no count, and nothing a manifest producer
 * (the deploy pipeline stamps the manifest from environment variables and a
 * revision file, so its values are untrusted) happens to write into it.
 *
 * Every assertion here reads the ACTUAL HTTP RESPONSE BYTES from a real
 * listening socket; nothing inspects internal state or log lines.
 *
 * The manifest is stamped by the REAL build script (scripts/ci/stamp-build.mjs)
 * into <engine>/dist/BUILD.json, and the service is started for real on a
 * loopback port, so these assertions run against a live listener, not a mock.
 */

const ENGINE_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ENGINE_ROOT, 'dist', 'BUILD.json');
/** Per process: two runs must never share a stash, or one run's restore hands back the other's copy. */
const MANIFEST_STASH = `${MANIFEST}.test-backup.${process.pid}`;

/**
 * The public wire path an operator curls. Pinned as a literal (and asserted
 * against the exported MVP_VERSION_PATH) so the tests cannot follow the route
 * to a different path if it is ever moved.
 */
const VERSION_ROUTE = '/version';

/** A tenant hostname as provisioned (slug.public-ip.sslip.io), i.e. what Caddy fronts. */
const PUBLIC_TENANT_HOST = 'sample-tenant.203.0.113.10.sslip.io';

/**
 * Hard response ceiling. Every identity value is length-capped and
 * shape-checked (commit <= 40 hex chars, branch <= 255 ref chars, builtAt <= 35
 * ISO chars), so no manifest can produce a response anywhere near this — the
 * assertion is what makes the cap mechanical rather than a claim.
 */
const MAX_RESPONSE_BYTES = 512;

/** The exact field set is part of the security contract: anything else is a leak. */
const ALLOWED_KEYS = ['branch', 'builtAt', 'commit', 'dirty', 'ok'];

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
/** Values that must NEVER appear in an unauthenticated response body. */
const TENANT_SLUG = 'zz-secret-tenant-slug';
const GATEWAY_SECRET = 'synthetic-gateway-secret-must-never-leak';
const INSTANCE_ID = 'zz-secret-instance-token-must-never-leak';
/** Hostile values from the adversarial review of this route. */
const HOSTILE_PATH = '/var/lib/renor/sample-tenant/memory/db.sqlite';
const HOSTILE_TOKEN = 'sk-live-9f3a2c1b8e7d6f5a4b3c2d1e0f9a8b7c';
const HOSTILE_EMAIL = 'owner@renor.example';
const HOSTILE_HTML = '<script>alert(1)</script>';
const HOSTILE_NEWLINE = 'main\nSet-Cookie: renor=1';
const HOSTILE_CRLF = 'main\r\nX-Injected: 1';
const HOSTILE_OVERSIZE = 'a'.repeat(3000);

/** A manifest whose fields are all valid, used as the base for single-field probes. */
const PLAUSIBLE_MANIFEST: BuildIdentity = {
  commit: 'a'.repeat(40),
  branch: 'main',
  dirty: false,
  builtAt: '2026-09-24T10:33:31.000Z',
};

const tmpDirs: string[] = [];
let started: (MvpApp & { httpServer: import('http').Server }) | null = null;
let activeConfig: MvpConfig | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function versionUrl(): string {
  return `http://127.0.0.1:${config().port}${VERSION_ROUTE}`;
}

function config(): MvpConfig {
  if (!activeConfig) throw new Error('service not started');
  return activeConfig;
}

/** The host the service is bound to; all "local" probes use it. */
function loopbackHostHeader(): string {
  return `127.0.0.1:${config().port}`;
}

/** Stamps the real manifest the way a build does (no git => the script itself fails soft). */
function stampManifest(): void {
  execFileSync(process.execPath, ['scripts/ci/stamp-build.mjs'], { cwd: ENGINE_ROOT, stdio: 'pipe' });
}

function gitHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ENGINE_ROOT, encoding: 'utf8' }).trim();
}

function readManifest(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
}

function stashManifest(): boolean {
  const had = fs.existsSync(MANIFEST);
  if (had) {
    fs.rmSync(MANIFEST_STASH, { force: true });
    fs.renameSync(MANIFEST, MANIFEST_STASH);
  }
  return had;
}

function restoreManifest(had: boolean): void {
  if (had) fs.renameSync(MANIFEST_STASH, MANIFEST);
  else fs.rmSync(MANIFEST, { force: true });
}

function writeManifest(content: string | Buffer): void {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, content);
}

/** Runs `body` with `content` installed as the live manifest, then restores the real one. */
async function withManifest<T>(content: string | Buffer, body: () => Promise<T>): Promise<T> {
  const had = stashManifest();
  try {
    writeManifest(content);
    return await body();
  } finally {
    restoreManifest(had);
  }
}

/** Plain loopback GET through the standard fetch stack (the operator's `curl 127.0.0.1`). */
async function fetchVersion(headers?: Record<string, string>): Promise<{ status: number; raw: string; body: any }> {
  const res = await fetch(versionUrl(), headers ? { headers } : undefined);
  const raw = await res.text();
  return { status: res.status, raw, body: JSON.parse(raw) };
}

interface RawResponse {
  status: number;
  raw: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * GET /version over a real socket with full control of the Host header, the
 * forwarding headers a reverse proxy adds, and the local address dialled —
 * i.e. the exact bytes a public or proxied caller would receive.
 */
function rawGet(options: { address?: string; port?: number; headers?: Record<string, string> }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: options.address ?? '127.0.0.1',
        port: options.port ?? config().port,
        path: VERSION_ROUTE,
        method: 'GET',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          raw: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A first non-internal IPv4 address of this machine, or null when it has none. */
function nonLoopbackIpv4(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

function assertNoLeak(raw: string, body: any): void {
  expect(Object.keys(body).sort()).toEqual(ALLOWED_KEYS);
  expect(body.ok).toBe(true);
  // Known-sensitive literals must not appear in the wire bytes.
  for (const secret of [TENANT_SLUG, GATEWAY_SECRET, INSTANCE_ID, OWNER_PASSWORD, config().memoryDir, MANIFEST, ENGINE_ROOT]) {
    expect(raw).not.toContain(secret);
  }
  // Paths, tokens and URLs must not appear in the wire bytes.
  expect(raw).not.toMatch(/\/tmp\/|\/home\/|\/var\/|\/opt\/|\/etc\//);
  expect(raw).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/); // JWT
  expect(raw).not.toMatch(/Bearer|access_token|refresh_token|client_secret|password/i);
  // Value-level allowlist: every value is build metadata or a marker.
  expect(body.commit).toMatch(/^(unknown|[0-9a-f]{7,40})$/);
  expect(body.branch === 'unknown' || /^[A-Za-z0-9._/-]{1,255}$/.test(body.branch)).toBe(true);
  expect(body.branch.startsWith('/')).toBe(false); // a filesystem path would start with /
  expect(body.dirty === null || typeof body.dirty === 'boolean').toBe(true);
  expect(body.builtAt === null || /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(body.builtAt)).toBe(true);
}

/** Every response that goes out is bounded and cannot carry a lossy byte. */
function assertBoundedResponse(raw: string, label: string): void {
  expect(raw.length, `${label}: response size`).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  expect(raw.includes('\uFFFD'), `${label}: replacement character`).toBe(false);
}

/** The hostile value (and its JSON-escaped form) must not appear in the response bytes. */
function assertNotReflected(raw: string, value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) return;
  const escaped = JSON.stringify(value).slice(1, -1);
  expect(raw.includes(value), `${label}: value reflected verbatim`).toBe(false);
  if (escaped !== value) expect(raw.includes(escaped), `${label}: escaped value reflected`).toBe(false);
}

interface HostileValue {
  label: string;
  value: unknown;
}

/** Field -> the identity a manifest with that ONE field invalid must produce. */
const REJECTED_FIELD_IDENTITY: Record<'commit' | 'branch' | 'builtAt', BuildIdentity> = {
  commit: { ...PLAUSIBLE_MANIFEST, commit: 'unknown' },
  branch: { ...PLAUSIBLE_MANIFEST, branch: 'unknown' },
  builtAt: { ...PLAUSIBLE_MANIFEST, builtAt: null },
};

/**
 * Probes: a manifest carrying this value in `field` must (a) keep answering 200,
 * (b) replace exactly that field with its safe placeholder while the other three
 * keep their values, (c) never contain the hostile value in the response bytes,
 * and (d) stay under the response ceiling.
 */
async function expectFieldRejected(
  field: 'commit' | 'branch' | 'builtAt',
  { label, value }: HostileValue,
): Promise<void> {
  const name = `${field} = ${label}`;
  const { status, raw, body } = await withManifest(
    JSON.stringify({ ...PLAUSIBLE_MANIFEST, [field]: value }),
    () => fetchVersion(),
  );
  expect(status, name).toBe(200);
  expect(body, name).toEqual({ ok: true, ...REJECTED_FIELD_IDENTITY[field] });
  assertNotReflected(raw, value, name);
  assertBoundedResponse(raw, name);
  expect(Object.keys(body).sort(), name).toEqual(ALLOWED_KEYS);
}

/**
 * Values that are not a hex revision id. Everything a manifest producer could
 * put there by mistake or malice: a path, a slug, a secret, contact details,
 * markup, control characters, empty/oversized strings, and non-strings.
 */
const HOSTILE_COMMIT: HostileValue[] = [
  { label: 'filesystem path', value: HOSTILE_PATH },
  { label: 'tenant slug', value: 'sample-tenant' },
  { label: 'token-like string', value: HOSTILE_TOKEN },
  { label: 'bearer token', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzYW1wbGUtdGVuYW50In0.c2ln' },
  { label: 'email address', value: HOSTILE_EMAIL },
  { label: 'html', value: HOSTILE_HTML },
  { label: 'embedded newline', value: HOSTILE_NEWLINE },
  { label: 'embedded CRLF', value: HOSTILE_CRLF },
  { label: 'empty string', value: '' },
  { label: 'whitespace only', value: '   ' },
  { label: 'too short for a revision id', value: 'abc123' },
  { label: 'non-hex revision-length string', value: 'zzzzzzzzzz' },
  { label: 'over-long value (3000 chars)', value: HOSTILE_OVERSIZE },
  { label: 'number', value: 42 },
  { label: 'boolean', value: true },
  { label: 'object', value: { path: HOSTILE_PATH } },
  { label: 'array', value: ['a'.repeat(40)] },
  { label: 'null', value: null },
];

/**
 * Values that are not a git ref name (`git check-ref-format`): separators git
 * forbids, characters outside the ref charset, control characters, `..`, a
 * leading dot, empty components, and non-strings.
 */
const HOSTILE_BRANCH: HostileValue[] = [
  { label: 'filesystem path', value: HOSTILE_PATH },
  { label: 'relative traversal ref', value: 'refs/heads/../../etc/passwd' },
  { label: 'token with a space', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret' },
  { label: 'token with a shell metacharacter', value: HOSTILE_TOKEN.replace('9f3a', '$9f3a') },
  { label: 'email address', value: HOSTILE_EMAIL },
  { label: 'html', value: HOSTILE_HTML },
  { label: 'embedded newline', value: HOSTILE_NEWLINE },
  { label: 'embedded CRLF', value: HOSTILE_CRLF },
  { label: 'empty string', value: '' },
  { label: 'whitespace only', value: '   ' },
  { label: 'double slash', value: 'feat//mvp' },
  { label: 'leading dot', value: '.hidden' },
  { label: 'lock suffix', value: 'feat/mvp.lock' },
  { label: 'over-long value (3000 chars)', value: HOSTILE_OVERSIZE },
  { label: 'number', value: 42 },
  { label: 'boolean', value: false },
  { label: 'object', value: { branch: 'main' } },
  { label: 'array', value: ['main'] },
  { label: 'null', value: null },
];

/** Values that are not an ISO-8601 instant. */
const HOSTILE_BUILT_AT: HostileValue[] = [
  { label: 'filesystem path', value: HOSTILE_PATH },
  { label: 'tenant slug', value: 'sample-tenant' },
  { label: 'token-like string', value: HOSTILE_TOKEN },
  { label: 'email address', value: HOSTILE_EMAIL },
  { label: 'html', value: HOSTILE_HTML },
  { label: 'embedded newline', value: HOSTILE_NEWLINE },
  { label: 'embedded CRLF', value: HOSTILE_CRLF },
  { label: 'empty string', value: '' },
  { label: 'whitespace only', value: '   ' },
  { label: 'date without a time zone', value: '2026-09-24T10:33:31' },
  { label: 'prose', value: 'yesterday' },
  { label: 'epoch milliseconds as text', value: '1758700000000' },
  { label: 'over-long value (3000 chars)', value: HOSTILE_OVERSIZE },
  { label: 'number', value: 1758700000000 },
  { label: 'boolean', value: true },
  { label: 'object', value: { at: 1758700000000 } },
  { label: 'array', value: ['2026-09-24T10:33:31.000Z'] },
  { label: 'null', value: null },
];

let manifestClaim: { release(): void } | null = null;

beforeAll(async () => {
  // The shared manifest is claimed for the whole window that needs it, and the stamp is written
  // inside the claim. Two suite runs on one host both stamp and then mutate this one file, so
  // without the claim each run stashes the other's manifest mid-window and reads the other's
  // fixture instead of the stamp it wrote. A claim also repairs a previous run that died with a
  // fixture installed: this stamp overwrites it.
  manifestClaim = await claimManifest(MANIFEST);
  stampManifest();
  const port = await freePort();
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), `mvp-build-identity-${TENANT_SLUG}-`));
  tmpDirs.push(memoryDir);
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-build-identity-auth-'));
  tmpDirs.push(authRoot);
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  process.env.MVP_GATEWAY_SECRET = GATEWAY_SECRET;
  process.env.MVP_INSTANCE_ID = INSTANCE_ID;
  activeConfig = loadMvpConfig();
  started = await startMvpService(activeConfig);
});

afterAll(async () => {
  if (started) {
    started.httpServer.close();
    await started.close();
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  manifestClaim?.release();
  manifestClaim = null;
  for (const key of [
    'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL',
    'MVP_OWNER_PASSWORD', 'MVP_PORT', 'MVP_ALLOWED_CALLBACK_URIS', 'MVP_GATEWAY_SECRET',
    'MVP_INSTANCE_ID',
  ]) delete process.env[key];
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('MVP build identity: GET /version', () => {
  it('reads the real stamped BUILD.json and resolves it to the engine dist manifest', () => {
    // The helper must find <engine>/dist/BUILD.json in a source run too (tsx:
    // `npm run mvp`), which is the layout the alpha systemd units use.
    expect(BUILD_MANIFEST_PATH).toBe(MANIFEST);
    expect(MVP_VERSION_PATH).toBe(VERSION_ROUTE);
    expect(fs.existsSync(MANIFEST)).toBe(true);
    expect(readManifest().commit).toBe(gitHead());
  });

  it('serves the stamped commit/branch/builtAt over a real listening server', async () => {
    const stamped = readManifest();
    const { status, body } = await fetchVersion();
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      commit: stamped.commit,
      branch: stamped.branch,
      dirty: stamped.dirty,
      builtAt: stamped.builtAt,
    });
    // Not a vacuous pass: the stamped manifest carries this checkout's real HEAD.
    expect(body.commit).toBe(gitHead());
    expect(body.builtAt).toBe(stamped.builtAt);
  });

  it('is reachable over loopback without an Authorization header while POST /mcp still requires a Bearer token', async () => {
    const app = started!.app;
    const noHeader = await request(app).get(VERSION_ROUTE).expect(200);
    expect(noHeader.body.ok).toBe(true);
    // A junk credential does not change the answer either — the route ignores auth.
    const junkHeader = await fetchVersion({ Authorization: 'Bearer not-a-real-token' });
    expect(junkHeader.status).toBe(200);

    // Auth was NOT widened: /mcp is still closed without a valid owner token.
    const mcpNoAuth = await request(app).post(MVP_MCP_PATH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(mcpNoAuth.status).toBe(401);
    expect(mcpNoAuth.body.error.code).toBe(-32001);

    const mcpJunkAuth = await request(app).post(MVP_MCP_PATH)
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(mcpJunkAuth.status).toBe(401);
  });

  it('forbids caching, so a post-deploy parity check cannot read a stale answer', async () => {
    const res = await rawGet({});
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('leaks no tenant slug, filesystem path or token-like value', async () => {
    const { status, raw, body } = await fetchVersion();
    expect(status).toBe(200);
    assertNoLeak(raw, body);
    assertBoundedResponse(raw, 'stamped manifest');
    // The response is build identity and nothing else: four values plus the marker.
    expect(raw).toBe(JSON.stringify({ ok: true, ...body }));
  });

  it('reports unknown and does not throw when BUILD.json is missing', async () => {
    const had = stashManifest();
    try {
      expect(fs.existsSync(MANIFEST)).toBe(false);
      expect(() => readBuildIdentity()).not.toThrow();
      expect(readBuildIdentity()).toEqual({ commit: 'unknown', branch: 'unknown', dirty: null, builtAt: null });
      const { status, raw, body } = await fetchVersion();
      expect(status).toBe(200); // never a 500
      expect(body).toEqual({ ok: true, commit: 'unknown', branch: 'unknown', dirty: null, builtAt: null });
      assertNoLeak(raw, body);
      assertBoundedResponse(raw, 'missing manifest');
    } finally {
      restoreManifest(had);
    }
  });

  it('reports unknown and does not throw when BUILD.json is malformed JSON', async () => {
    const had = stashManifest();
    try {
      writeManifest('{ "commit": "deadbeef",\n');
      expect(() => readBuildIdentity()).not.toThrow();
      expect(readBuildIdentity()).toEqual({ commit: 'unknown', branch: 'unknown', dirty: null, builtAt: null });
      const { status, body } = await fetchVersion();
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, commit: 'unknown', branch: 'unknown', dirty: null, builtAt: null });
    } finally {
      restoreManifest(had);
    }
  });

  it('reports unknown and does not throw when BUILD.json has the wrong shape', async () => {
    const had = stashManifest();
    try {
      writeManifest(JSON.stringify({ commit: 42, branch: ['main'], dirty: 'yes', builtAt: { at: 1 } }));
      expect(() => readBuildIdentity()).not.toThrow();
      expect(readBuildIdentity()).toEqual({ commit: 'unknown', branch: 'unknown', dirty: null, builtAt: null });
      const { status, body } = await fetchVersion();
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, commit: 'unknown', branch: 'unknown', dirty: null, builtAt: null });
      // An unreadable-but-parsable manifest must not be echoed through.
      expect(JSON.stringify(body)).not.toContain('42');
    } finally {
      restoreManifest(had);
    }
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('MVP build identity: hostile manifest values are never reflected', () => {
  /**
   * The adversarial probe: the manifest is the deploy pipeline's file, so its
   * values are untrusted input on a probe surface.
   */
  it.each(HOSTILE_COMMIT.map((probe) => [probe.label, probe] as const))(
    'rejects and never reflects a hostile commit (%s)',
    async (_label, probe) => { await expectFieldRejected('commit', probe); },
  );

  it.each(HOSTILE_BRANCH.map((probe) => [probe.label, probe] as const))(
    'rejects and never reflects a hostile branch (%s)',
    async (_label, probe) => { await expectFieldRejected('branch', probe); },
  );

  it.each(HOSTILE_BUILT_AT.map((probe) => [probe.label, probe] as const))(
    'rejects and never reflects a hostile builtAt (%s)',
    async (_label, probe) => { await expectFieldRejected('builtAt', probe); },
  );

  it('keeps a plausible revision id, including a shortened one', async () => {
    for (const commit of ['b'.repeat(40), 'abc1234', 'DEADBEEF']) {
      const { status, body } = await withManifest(
        JSON.stringify({ ...PLAUSIBLE_MANIFEST, commit }),
        () => fetchVersion(),
      );
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, ...PLAUSIBLE_MANIFEST, commit });
    }
  });

  it('keeps a plausible ref name, including detached-HEAD and nested names', async () => {
    for (const branch of ['main', 'HEAD', 'feat/mvp-build-identity', 'fix/merge-artifacts.v2']) {
      const { status, body } = await withManifest(
        JSON.stringify({ ...PLAUSIBLE_MANIFEST, branch }),
        () => fetchVersion(),
      );
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, ...PLAUSIBLE_MANIFEST, branch });
    }
  });

  it('keeps a plausible ISO-8601 instant, including an explicit offset', async () => {
    for (const builtAt of ['2026-09-24T10:33:31.000Z', '2026-09-24T10:33:31Z', '2026-09-24T10:33:31-03:00']) {
      const { status, body } = await withManifest(
        JSON.stringify({ ...PLAUSIBLE_MANIFEST, builtAt }),
        () => fetchVersion(),
      );
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, ...PLAUSIBLE_MANIFEST, builtAt });
    }
  });

  it('never echoes a raw non-UTF-8 byte sequence', async () => {
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"commit":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`abc","branch":"main","dirty":false,"builtAt":"${PLAUSIBLE_MANIFEST.builtAt}"}`),
    ]);
    const { status, raw, body } = await withManifest(invalidUtf8, () => fetchVersion());
    expect(status).toBe(200);
    // The replacement character the decoder produces must not reach the wire.
    expect(raw.includes('\uFFFD')).toBe(false);
    expect(body).toEqual({ ok: true, ...PLAUSIBLE_MANIFEST, commit: 'unknown' });
    assertBoundedResponse(raw, 'non-UTF-8 byte in commit');
  });

  it('answers the full hostile probe from the review with a safe identity and a bounded body', async () => {
    // Every string field hostile at once, plus extra attacker keys.
    const hostileManifest = {
      commit: HOSTILE_PATH,
      branch: 'refs/heads/../../etc/passwd',
      builtAt: HOSTILE_HTML,
      dirty: 'yes',
      tenant: TENANT_SLUG,
      token: GATEWAY_SECRET,
      note: `${HOSTILE_EMAIL}${HOSTILE_NEWLINE}${HOSTILE_CRLF}`,
    };
    const { status, raw, body } = await withManifest(JSON.stringify(hostileManifest), () => fetchVersion());
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, commit: 'unknown', branch: 'unknown', dirty: null, builtAt: null });
    expect(Object.keys(body).sort()).toEqual(ALLOWED_KEYS);
    assertNoLeak(raw, body);
    assertBoundedResponse(raw, 'fully hostile manifest');
    for (const value of [HOSTILE_PATH, HOSTILE_HTML, HOSTILE_EMAIL, HOSTILE_NEWLINE, HOSTILE_CRLF, TENANT_SLUG, GATEWAY_SECRET]) {
      assertNotReflected(raw, value, 'fully hostile manifest');
    }
  });

  it('never emits a 1 MiB value, and never a 1 MiB body', async () => {
    const manifest = JSON.stringify({ ...PLAUSIBLE_MANIFEST, commit: 'a'.repeat(1024 * 1024) });
    expect(manifest.length).toBeGreaterThan(MAX_BUILD_MANIFEST_BYTES);
    const { status, raw, body } = await withManifest(manifest, () => fetchVersion());
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(ALLOWED_KEYS);
    expect(body.commit).not.toContain('a'.repeat(64));
    expect(raw.length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(raw.includes('a'.repeat(64))).toBe(false);
  });

  /**
   * Only the manifest SIZE gate can produce this answer: the four fields are all
   * legal and the extra `pad` key is dropped anyway, so nothing but "this file
   * is not a stamp we wrote" can turn a valid-looking manifest into `unknown`.
   */
  it('refuses an oversized manifest by size, so a huge manifest cannot produce a huge response', async () => {
    const manifest = JSON.stringify({ ...PLAUSIBLE_MANIFEST, pad: 'x'.repeat(1024 * 1024) });
    expect(manifest.length).toBeGreaterThan(MAX_BUILD_MANIFEST_BYTES);
    const { status, raw, body } = await withManifest(manifest, () => fetchVersion());
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, commit: 'unknown', branch: 'unknown', dirty: null, builtAt: null });
    expect(raw.length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(raw.includes('x'.repeat(64))).toBe(false);
  });

  /**
   * Documented boundary (see docs/architecture/BUILD-IDENTITY.md): shape
   * validation cannot tell a ref-shaped secret from a real branch name. The
   * value is still emitted, but ONLY there, only if it is a legal ref name, and
   * only to a loopback caller.
   */
  it('documented boundary: a value that IS a legal ref name survives in branch', async () => {
    const refShaped = { slug: 'sample-tenant', token: 'sk-live-9f3a2c1b8e7d6f5a4b3c2d1e0f9a8b7c' };
    for (const [label, branch] of Object.entries(refShaped)) {
      const { status, body, raw } = await withManifest(
        JSON.stringify({ ...PLAUSIBLE_MANIFEST, branch }),
        () => fetchVersion(),
      );
      expect(status, label).toBe(200);
      expect(body.branch, label).toBe(branch);
      expect(body.commit, label).toBe(PLAUSIBLE_MANIFEST.commit);
      assertBoundedResponse(raw, `${label} in branch`);
    }
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('MVP build identity: GET /version is loopback-only', () => {
  it('answers a direct loopback call (the SSH verification path)', async () => {
    const res = await rawGet({ headers: { Host: loopbackHostHeader() } });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.raw);
    expect(body.ok).toBe(true);
    expect(body.commit).toBe(readManifest().commit);
  });

  /**
   * The deployed public path: Caddy's catch-all `reverse_proxy 127.0.0.1:<port>`
   * dials from loopback and forwards the client's Host, so the socket peer is
   * loopback. The Host the public caller used is what identifies the hop.
   */
  it.each([
    ['the public tenant host is forwarded', { Host: PUBLIC_TENANT_HOST }],
    ['the public tenant host is forwarded with a port', { Host: `${PUBLIC_TENANT_HOST}:443` }],
  ])('returns 404 when %s', async (_label, headers) => {
    const res = await rawGet({ headers });
    expect(res.status).toBe(404);
    expect(res.raw).not.toContain(readManifest().commit as string);
    expect(res.raw).not.toContain('unknown');
  });

  /**
   * The other half of the same hop: some proxies rewrite Host to the upstream,
   * but Caddy's reverse_proxy always appends its forwarding headers. Any of
   * them means the request did not come straight off the loopback interface.
   */
  it.each([
    ['X-Forwarded-For is present', { 'X-Forwarded-For': '203.0.113.9' }],
    ['X-Forwarded-Proto is present', { 'X-Forwarded-Proto': 'https' }],
    ['X-Forwarded-Host is present', { 'X-Forwarded-Host': PUBLIC_TENANT_HOST }],
    ['X-Real-IP is present', { 'X-Real-IP': '203.0.113.9' }],
    ['Forwarded is present', { Forwarded: `for=203.0.113.9;host=${PUBLIC_TENANT_HOST}` }],
  ])('returns 404 when %s even under a loopback Host', async (_label, extra) => {
    const res = await rawGet({ headers: { Host: loopbackHostHeader(), ...extra } });
    expect(res.status).toBe(404);
    expect(res.raw).not.toContain(readManifest().commit as string);
  });

  it('returns 404 for a non-loopback peer, even when the peer claims a loopback Host', async () => {
    const address = nonLoopbackIpv4();
    // Fail loudly rather than silently skipping the only non-loopback evidence.
    expect(address, 'this machine has no non-loopback IPv4 to dial').not.toBeNull();
    const server = http.createServer(started!.app);
    await new Promise<void>((resolve) => server.listen(0, address!, () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      // (a) the caller addresses the non-loopback interface and says so
      const asPublic = await new Promise<RawResponse>((resolve, reject) => {
        const req = http.request({ host: address!, port, path: VERSION_ROUTE }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(asPublic.status).toBe(404);
      // (b) the caller reaches a non-loopback interface while claiming loopback
      const claimedLoopback = await new Promise<RawResponse>((resolve, reject) => {
        const req = http.request(
          { host: address!, port, path: VERSION_ROUTE, headers: { Host: `127.0.0.1:${port}` } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(claimedLoopback.status).toBe(404);
      expect(claimedLoopback.raw).not.toContain(readManifest().commit as string);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('answers 404s for a rejected caller without build metadata or an error detail', async () => {
    const res = await rawGet({ headers: { Host: PUBLIC_TENANT_HOST } });
    expect(res.status).toBe(404);
    expect(res.raw).toBe(JSON.stringify({ error: 'not found' }));
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

/** The librarian API needs a bearer token on every route, /api/health included. */
const LIBRARIAN_TOKEN = 'synthetic-api-token-for-build-identity';

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('librarian GET /api/health shares the manifest reader', () => {
  /** The librarian app, built the way src/api/server.ts is built in production. */
  async function createLibrarianApp() {
    const { createServer } = await import('../../src/api/server.js');
    const { openDb } = await import('../../src/db/client.js');
    const { runMigrations } = await import('../../src/db/schema.js');
    const { VectorIndex } = await import('../../src/embeddings/vectorIndex.js');
    const dbPath = path.join(tmpDirs[0], `api-health-${Math.random().toString(36).slice(2)}.db`);
    const db = openDb(dbPath);
    runMigrations(db);
    const idx = new VectorIndex(db, 4);
    idx.initTable();
    const provider = { dimensions: 4, embed: async () => [[1, 0, 0, 0]] };
    return { app: createServer(db, idx, provider as any, tmpDirs[0], [], undefined, undefined, { apiToken: LIBRARIAN_TOKEN }), db };
  }

  it('announces the version package.json holds', () => {
    // The MCP initialize reply, /api/health and `renor --version` all read ENGINE_VERSION.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it('reports the stamped identity on the librarian route too', async () => {
    const stamped = readManifest();
    const { app, db } = await createLibrarianApp();
    try {
      const res = await request(app).get('/api/health').set('Authorization', `Bearer ${LIBRARIAN_TOKEN}`).expect(200);
      expect(res.body).toEqual({
        ok: true, name: 'renor', version: ENGINE_VERSION,
        commit: stamped.commit, branch: stamped.branch, dirty: stamped.dirty, builtAt: stamped.builtAt,
      });
    } finally {
      db.close();
    }
  });

  it('adds dirty:null on the librarian route when the manifest is missing (recorded narrowing)', async () => {
    // Delta recorded, not fixed: the pre-helper route returned
    // {ok,name,version,commit,branch,builtAt} with no `dirty` key at all.
    const had = stashManifest();
    try {
      const { app, db } = await createLibrarianApp();
      try {
        const res = await request(app).get('/api/health').set('Authorization', `Bearer ${LIBRARIAN_TOKEN}`).expect(200);
        expect(res.body).toEqual({
          ok: true, name: 'renor', version: ENGINE_VERSION,
          commit: 'unknown', branch: 'unknown', dirty: null, builtAt: null,
        });
      } finally {
        db.close();
      }
    } finally {
      restoreManifest(had);
    }
  });
});
