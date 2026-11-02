import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import express, { Response } from 'express';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidClientMetadataError, InvalidGrantError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ClientRegistry } from './client-store.js';
import type { MvpConfig } from './config'
import { emitTelemetry } from './telemetry';
import { createLogger } from './log';

const log = createLogger('auth');
import { hiveIdentity } from '../memory/sourceName';

/**
 * Owner-only OAuth 2.1 authorization for the single-user MVP, implemented on
 * the MCP SDK's supported auth components (OAuthServerProvider interface,
 * dynamic client registration store, and the SDK's mcpAuthRouter endpoints:
 * /authorize, /token, /register, /revocation + discovery metadata).
 *
 * Owner-only authorization model (NOT a secret URL), hardened after the Kimi
 * auth review (AUTH-B1/B3 + H1/H2/H4):
 *  - DCR is DENY BY DEFAULT: a client may register ONLY when every
 *    redirect_uri exactly matches an owner-configured allowlist
 *    (MVP_ALLOWED_CALLBACK_URIS, exact URIs — no wildcards, no guessed
 *    domains). The client store is bounded (AUTH-H2).
 *  - /authorize mints a ONE-TIME, expiring authorization-request ticket
 *    server-side, bound to the exact client_id / redirect_uri / PKCE
 *    challenge / scope / resource / state. The login POST must present that
 *    ticket; every parameter comes from the ticket (server-side), so the
 *    POST cannot be pre-baked, replayed, or tampered with (no request
 *    substitution). Tickets are single-use.
 *  - The consent page visibly shows the HTML-escaped registered client name,
 *    the exact redirect destination origin (and full callback URI), the
 *    requested scope, and an explicit "unreviewed client" warning, and it
 *    requires an explicit approval checkbox before any code is minted.
 *  - Cross-origin login POSTs are rejected (Origin/Referer checked against
 *    the configured base URL when the browser supplies them).
 *  - handleOwnerLogin re-validates redirect_uri membership against the
 *    client's registered list before minting a code (defense in depth).
 *  - A failed-login limiter, one bucket per client address, applies bounded backoff and
 *    lockout (AUTH-B3); audit events are metadata-only (never credentials,
 *    tokens, headers, or private content).
 *  - Refresh tokens expire (AUTH-H1) and rotate single-use; access tokens
 *    expire and revoke; PKCE S256 remains enforced by the SDK at exchange.
 *
 * Scope remains deliberately local/single-owner; token stores are in-memory
 * (restart drops codes/tokens — documented, re-auth expected). No accounts,
 * signups, multi-user platform, or public-exposure features. Any public use
 * requires TLS termination in front of this loopback-bound service; see
 * docs/build-1/MVP-AUTH-HARDENING-EVIDENCE.md.
 */

interface StoredAuthorizationCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  resource?: URL;
  expiresAt: number;
}

/** One authorization's tokens: the live access/refresh pair, shared by every rotation of the chain. */
interface TokenFamily {
  clientId: string;
  access: string;
  refresh: string;
}

interface StoredToken {
  family: TokenFamily;
  clientId: string;
  scopes: string[];
  /** Access-token expiry (epoch ms). */
  expiresAt: number;
  /** Refresh-token expiry (epoch ms) — enforced at refresh exchange (AUTH-H1). */
  refreshExpiresAt: number;
}

interface LoginBucket { failures: number; lockedUntil: number; lastFailureAt: number }

/** Key for every value that is not an IP address: one shared bucket, in the keyspace no address maps into. */
const LOGIN_INVALID_KEY = 'invalid';

/** The 8 sixteen-bit groups of a valid IPv6 address (any `::` spelling, optional dotted IPv4 tail). */
function ipv6Groups(addr: string): number[] {
  let text = addr;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail = ''] = text.split('::');
  const groups = head ? head.split(':') : [];
  if (text.includes('::')) {
    const rest = tail ? tail.split(':') : [];
    while (groups.length + rest.length < 8) groups.push('0');
    groups.push(...rest);
  }
  return groups.map(g => parseInt(g, 16));
}

/**
 * The network a login attempt is counted against: the IPv4 address, or the first 64 bits of an IPv6 address (one /64 is
 * one subscriber's whole range, so rotating inside it gains nothing). IPv4-mapped IPv6 reads as the IPv4 address in
 * every spelling (dotted or hex). Anything that is not an IP address shares one `invalid` key, never a key a real client
 * can have and never the overflow bucket's.
 */
export function loginNetworkKey(address: string): string {
  const addr = address.split('%')[0].toLowerCase();
  if (net.isIPv4(addr)) return addr;
  if (net.isIPv6(addr)) {
    const g = ipv6Groups(addr);
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
      return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    }
    return `${g.slice(0, 4).map(x => x.toString(16)).join(':')}::/64`;
  }
  return LOGIN_INVALID_KEY;
}

interface StoredAuthTicket {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  resource?: URL;
  state?: string;
  expiresAt: number;
  used: boolean;
}

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const AUTH_TICKET_TTL_MS = 10 * 60 * 1000;
const MAX_AUTH_TICKETS = 1000;              // bounded ticket store (pruned)
const MAX_REGISTERED_CLIENTS = 100;         // bounded DCR store (AUTH-H2)
const MAX_REDIRECT_URIS_PER_CLIENT = 8;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCKOUT_MAX_MS = 15 * 60 * 1000;
const LOGIN_BUCKET_LIMIT = 10_000;           // client networks tracked at once; past this, new ones share one overflow bucket
const LOGIN_OVERFLOW_KEY = 'overflow:shared'; // a ':' with no '::/64' suffix and no dots: loginNetworkKey never returns it
const FAILURE_MEMORY_MS = 60 * 60 * 1000;   // a failed login is forgotten after an hour without another
const TOKEN_SWEEP_EVERY = 512;              // sweep expired tokens every N issues
const MAX_USED_CODES = 1000;                // redeemed authorization codes remembered, to recognise a replay

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Metadata-only audit line: timestamp + event + opaque identifiers/counts.
 * NEVER credentials, tokens, headers, query strings, or private content. */
function audit(event: string, fields: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  // BROWSER-LOGIN FIX: a real Chromium submitting the consent form (a
  // same-origin POST navigation) serializes the Origin header as the literal
  // "null" when the page's Referrer-Policy strips the referrer (verified
  // empirically with headless Chromium: Origin: null + no Referer under
  // no-referrer, which the cross-origin guard must keep rejecting as an
  // opaque origin). `same-origin` keeps the guard's strict-origin check
  // working for real browsers: same-origin requests carry a real Origin /
  // full Referer, while cross-origin requests (including the final 302 to
  // the client's callback) send NO referrer — nothing about this service,
  // its paths, or the authorization code leaks to the client's origin.
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  // frame-ancestors in the CSP is the modern control; this is the same refusal for browsers that ignore it.
  'X-Frame-Options': 'DENY',
};

/** Consent-page CSP: the login form may POST only to this origin, and the
 * post-submit redirect may land only on the exact allowlisted callback URIs.
 * BROWSER-LOGIN FIX #2: Chromium enforces `form-action` across the redirect
 * chain of a form submission (w3c/webappsec-csp#8; Nextcloud #29317,
 * dotnet/aspnetcore #55491 hit the same OAuth wall). A static
 * `form-action 'self'` therefore blocks the OAuth 302 from /mvp-login to the
 * client's callback, breaking every legitimate browser login. Allowing the
 * same exact URIs the DCR allowlist already governs keeps this strict: the
 * form still cannot POST anywhere but this service, and redirects still
 * cannot land anywhere but an owner-approved callback. */
function consentPageCsp(allowedCallbackUris: string[]): string {
  const sources = ["'self'"];
  for (const uri of allowedCallbackUris) {
    try {
      const u = new URL(uri);
      sources.push(u.origin + (u.pathname === '/' ? '' : u.pathname));
    } catch {
      // config validation already rejects invalid allowlist entries
    }
  }
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${sources.join(' ')}; frame-ancestors 'none'`;
}

export class OwnerOAuthProvider implements OAuthServerProvider {
  // CLIENT-PERSISTENCE: registered OAuth client metadata survives service
  // restarts in the private owner-only store; anything else about the store
  // being unreadable/corrupt FAILS CLOSED here (startup error), never a
  // silent reset to empty. Authorization tickets, codes, and tokens are
  // deliberately NOT persisted: they stay short-lived and single-use.
  private clients: ClientRegistry;
  private authorizationCodes = new Map<string, StoredAuthorizationCode>();
  private accessTokens = new Map<string, StoredToken>();
  private refreshTokens = new Map<string, StoredToken>();
  private authTickets = new Map<string, StoredAuthTicket>();
  private usedCodes = new Map<string, TokenFamily>();
  private config: MvpConfig;
  // Failed-login limiter (AUTH-B3). A client (an IPv4 address or an IPv6 /64) locks out after fewer failures than the
  // global ceiling, so one client does not lock out the others; the global ceiling still holds the total to
  // MVP_LOGIN_MAX_FAILURES per window. If several clients together reach it, everyone, the owner included, is locked
  // until it expires or the operator sends the process SIGUSR2 (operatorUnlock; no request can). The key is the address Express
  // resolves (the socket peer, or the proxy-appended hop when MVP_TRUST_PROXY_HOPS names the proxies in front); a
  // client-supplied X-Forwarded-For entry is never a key.
  private loginBuckets = new Map<string, LoginBucket>();
  // Global ceiling: every failed login from any client also counts here, with the limit and backoff the single global
  // counter had, so spreading guesses over many addresses cannot raise the total rate above what it always was.
  private globalLogin: LoginBucket = { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
  private issuedSinceSweep = 0;

  constructor(config: MvpConfig) {
    this.config = config;
    this.clients = new ClientRegistry(config.authStatePath);
  }

  /** Header-form hive name for this OAuth client. A legacy duplicate spelling resolves to no name. */
  hiveConnectionName(clientId: string): string | undefined {
    return this.clients.hiveConnectionName(clientId);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.clients.get(clientId),
      // DCR policy (AUTH-B1): DENY BY DEFAULT. A registration is accepted
      // only when the owner configured an exact-callback-URI allowlist
      // (MVP_ALLOWED_CALLBACK_URIS) and EVERY proposed redirect_uri matches
      // one allowlisted entry exactly. No wildcards, no guessed domains,
      // no http(s) heuristic substitution — the owner names the callbacks.
      registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        const allow = this.config.allowedCallbackUris;
        const uris = client.redirect_uris ?? [];
        if (!Array.isArray(uris) || uris.length === 0) {
          audit('dcr_denied', { reason: 'no-redirect-uris' });
          throw new InvalidClientMetadataError('DCR denied: registration must propose at least one redirect_uri');
        }
        if (uris.length > MAX_REDIRECT_URIS_PER_CLIENT) {
          audit('dcr_denied', { reason: 'too-many-redirect-uris' });
          throw new InvalidClientMetadataError(`DCR denied: at most ${MAX_REDIRECT_URIS_PER_CLIENT} redirect_uris per client`);
        }
        if (allow.length === 0) {
          audit('dcr_denied', { reason: 'deny-by-default-no-allowlist' });
          throw new InvalidClientMetadataError(
            'DCR denied by default: the owner has not configured an exact callback-URI allowlist '
            + '(MVP_ALLOWED_CALLBACK_URIS). No client may register until the owner explicitly allows its callback URIs.');
        }
        for (const uri of uris) {
          if (typeof uri !== 'string' || !allow.includes(uri)) {
            audit('dcr_denied', { reason: 'redirect-uri-not-allowlisted' });
            throw new InvalidClientMetadataError(
              'DCR denied: redirect_uri is not in the owner allowlist '
              + '(MVP_ALLOWED_CALLBACK_URIS allows only exact configured callback URIs)');
          }
        }
        if (this.clients.size >= MAX_REGISTERED_CLIENTS) {
          audit('dcr_denied', { reason: 'client-store-bound' });
          throw new InvalidClientMetadataError(`DCR denied: client store bound reached (${MAX_REGISTERED_CLIENTS} clients)`);
        }
        const client_id = randomToken();
        const full: OAuthClientInformationFull = {
          ...client,
          client_id,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        // CLIENT-PERSISTENCE: the registration is durably written (atomic
        // fsync + rename) BEFORE it is acknowledged. If the write fails the
        // client must NOT exist — not even in memory — so a restart can
        // never break a client that was promised to its owner. Mutations
        // are synchronous, serializing all concurrent registrations in
        // this single process.
        try {
          this.clients.add(full);
        } catch (err) {
          audit('dcr_denied', { reason: 'persist-failed' });
          throw new ServerError(
            `DCR failed: ${(err as Error).message} — no client was registered; `
            + 'the client store must be writable and healthy before registration succeeds');
        }
        audit('dcr_ok', { client_id: client_id.slice(0, 8) });
        return full;
      },
    };
  }

  private pruneTickets(): void {
    const now = Date.now();
    if (this.authTickets.size < MAX_AUTH_TICKETS) return;
    for (const [id, ticket] of this.authTickets) {
      if (ticket.expiresAt < now || ticket.used) this.authTickets.delete(id);
    }
    if (this.authTickets.size >= MAX_AUTH_TICKETS) {
      // still full: drop the oldest entries (bounded store, fail closed)
      const excess = this.authTickets.size - MAX_AUTH_TICKETS + 1;
      const ids = Array.from(this.authTickets.keys()).slice(0, excess);
      for (const id of ids) this.authTickets.delete(id);
    }
  }

  /**
   * Owner consent + login. Called by the SDK's /authorize AFTER it validated
   * the client and the redirect_uri against the client's registered list.
   * Mints a one-time authorization-request ticket bound to the EXACT request
   * parameters and renders the consent page. The login POST must present the
   * ticket; all OAuth parameters are taken from the ticket server-side.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Restart-policy enforcement (CLIENT-PERSISTENCE): a client persisted in
    // a previous run may only authorize while its EXACT callback URI is in
    // the owner's CURRENT allowlist. Removing a URI from
    // MVP_ALLOWED_CALLBACK_URIS and restarting therefore revokes fresh
    // authorizations for persisted clients without deleting their records.
    if (!this.config.allowedCallbackUris.includes(params.redirectUri)) {
      audit('authorize_denied', { reason: 'callback-not-allowlisted' });
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
      res.status(403).send('Authorization denied: this callback URI is no longer allowlisted by the owner.').end();
      return;
    }
    const scopes = params.scopes?.length ? params.scopes : ['memory'];
    this.pruneTickets();
    const ticket = randomToken();
    this.authTickets.set(ticket, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      challenge: params.codeChallenge,
      scopes,
      resource: params.resource,
      state: params.state,
      expiresAt: Date.now() + AUTH_TICKET_TTL_MS,
      used: false,
    });
    // Visible, honest consent (AUTH-B1): escaped client name, the EXACT
    // redirect destination (origin + full callback URI), the scope, an
    // explicit unreviewed-client warning, and an explicit approval checkbox.
    let redirectOrigin = '(unknown origin)';
    try {
      redirectOrigin = new URL(params.redirectUri).origin;
    } catch {
      // keep the placeholder; the ticket still binds the exact string
    }
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    res.setHeader('Content-Security-Policy', consentPageCsp(this.config.allowedCallbackUris));
    res.setHeader('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><title>Memory Company — owner authorization</title></head>
<body style="font-family: sans-serif; max-width: 32rem; margin: 4rem auto;">
<h2>Memory Company (single-owner MVP)</h2>
<p>Application <b>${htmlEscape(client.client_name ?? client.client_id)}</b> is requesting <b>${htmlEscape(scopes.join(' '))}</b> access to your memory service.</p>
<p><b>Redirect destination:</b> the authorization code will be sent to<br>
<b>${htmlEscape(redirectOrigin)}</b><br>
<code>${htmlEscape(params.redirectUri)}</code></p>
<p><b style="color:#b00">Warning:</b> this client is <b>unreviewed</b>. Anyone can attempt to register a client. Authorizing grants full read/write access to your private memory (facts and history). Only approve clients you trust and whose callback destination above you recognize.</p>
<form method="post" action="/mvp-login">
  <input type="hidden" name="ticket" value="${htmlEscape(ticket)}">
  <p><label><input type="checkbox" name="approve" value="on" required> I approve this application and the redirect destination shown above</label></p>
  <p><label>Email<br><input type="email" name="email" autocomplete="username" required style="width:100%"></label></p>
  <p><label>Secret<br><input type="password" name="password" autocomplete="current-password" required style="width:100%"></label></p>
  <p><button type="submit">Authorize</button></p>
</form>
</body></html>`);
  }

  /**
   * Called by the server's /mvp-login route after the owner submits the
   * consent form. The one-time ticket supplies every OAuth parameter; the
   * POST body may only add credentials and the explicit approval.
   */
  handleOwnerLogin(
    ticketId: string,
    email: string,
    password: string,
    approved: boolean,
    clientKey = 'local',
  ): { ok: true; redirect: URL; state?: string } | { ok: false; error: string; status: number; retryAfterSeconds?: number } {
    // Global single-owner limiter first (AUTH-B3): while locked out, even
    // correct credentials are refused; the response stays metadata-only.
    const now = Date.now();
    clientKey = loginNetworkKey(clientKey);
    if (now < this.globalLogin.lockedUntil) {
      audit('login_locked', { retry_after_ms: this.globalLogin.lockedUntil - now, scope: 'global' });
      return { ok: false, error: 'Too many failed login attempts. Try again later.', status: 429, retryAfterSeconds: Math.ceil((this.globalLogin.lockedUntil - now) / 1000) };
    }
    const bucket = this.loginBucket(clientKey, now);
    if (now < bucket.lockedUntil) {
      audit('login_locked', { retry_after_ms: bucket.lockedUntil - now });
      return { ok: false, error: 'Too many failed login attempts. Try again later.', status: 429, retryAfterSeconds: Math.ceil((bucket.lockedUntil - now) / 1000) };
    }
    const ticket = ticketId ? this.authTickets.get(ticketId) : undefined;
    // Consume the ticket on FIRST use attempt (single-use, anti-replay):
    // an unknown/expired/used ticket can never mint a code.
    if (ticket) this.authTickets.delete(ticketId);
    if (!ticket || ticket.used || ticket.expiresAt < now) {
      audit('login_ticket_rejected', { reason: !ticket ? 'unknown' : ticket.used ? 'replayed' : 'expired' });
      return { ok: false, error: 'Invalid or expired authorization request. Restart the authorization from the application.', status: 403 };
    }
    if (!approved) {
      audit('login_rejected', { reason: 'not-approved' });
      return { ok: false, error: 'Authorization was not approved.', status: 403 };
    }
    // Defense in depth: re-validate the client and the redirect membership
    // from the SERVER-SIDE ticket against the registered client record.
    const client = this.clients.get(ticket.clientId);
    if (!client) {
      audit('login_rejected', { reason: 'unknown-client' });
      return { ok: false, error: 'Unknown client.', status: 403 };
    }
    if (!(client.redirect_uris ?? []).includes(ticket.redirectUri)) {
      audit('login_rejected', { reason: 'redirect-uri-not-registered' });
      return { ok: false, error: 'Redirect destination is not registered for this client.', status: 403 };
    }
    const emailOk = constantTimeEqual(email.trim().toLowerCase(), this.config.ownerEmail);
    const passwordOk = constantTimeEqual(password, this.config.ownerPassword);
    if (!emailOk || !passwordOk) {
      const max = this.config.loginMaxFailures;
      const global = this.globalLogin;
      const clientFailures = this.recordFailure(bucket, now);
      const globalFailures = this.recordFailure(global, now);
      const clientLocked = clientFailures >= Math.max(1, Math.ceil(max / 2));
      const globalLocked = globalFailures >= max;
      if (clientLocked) bucket.lockedUntil = now + this.lockoutMs(clientFailures - Math.max(1, Math.ceil(max / 2)));
      if (globalLocked) {
        global.lockedUntil = now + this.lockoutMs(globalFailures - max);
        log.warn('login_locked_globally', { failures: globalFailures, detail: 'To unlock now, send the server process SIGUSR2 (docker kill -s USR2 <container>).' });
      }
      if (clientLocked || globalLocked) {
        const until = Math.max(bucket.lockedUntil, global.lockedUntil);
        emitTelemetry({ event: 'auth', kind: 'login_fail' });
        audit('login_failed', { failures: clientFailures, locked: true, scope: globalLocked ? 'global' : 'client' });
        return { ok: false, error: 'Owner credentials rejected. Too many failed attempts; login is temporarily locked.', status: 429, retryAfterSeconds: Math.ceil((until - now) / 1000) };
      }
      emitTelemetry({ event: 'auth', kind: 'login_fail' });
      audit('login_failed', { failures: clientFailures });
      return { ok: false, error: 'Owner credentials rejected. Only the configured owner can authorize this service.', status: 403 };
    }
    // Approval claims the client's hive name, so it is refused while an approved client holds that name, and it is
    // recorded before the code is minted: a write that fails mints nothing.
    const identity = hiveIdentity(client.client_name);
    if (identity && this.clients.holdsApprovedHiveIdentity(identity, client.client_id)) {
      audit('login_rejected', { reason: 'identity-held' });
      return {
        ok: false,
        error: `Another approved client already uses the name ${identity}. Give this client a different client_name, or reconnect the client that holds that name.`,
        status: 409,
      };
    }
    try {
      this.clients.approve(client.client_id);
    } catch {
      audit('login_rejected', { reason: 'approval-persist-failed' });
      return { ok: false, error: 'Could not record the approval; nothing was authorized. Retry once the client store is writable.', status: 500 };
    }
    // Success resets this client's bucket and the global count, and mints a code bound to the ticket values.
    this.loginBuckets.delete(clientKey);
    this.globalLogin = { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
    const code = randomToken();
    this.authorizationCodes.set(code, {
      clientId: ticket.clientId,
      redirectUri: ticket.redirectUri,
      challenge: ticket.challenge,
      scopes: ticket.scopes,
      resource: ticket.resource,
      expiresAt: now + AUTH_CODE_TTL_MS,
    });
    const redirect = new URL(ticket.redirectUri);
    redirect.searchParams.set('code', code);
    emitTelemetry({ event: 'auth', kind: 'login_ok' });
    audit('login_ok', { client_id: ticket.clientId.slice(0, 8) });
    return { ok: true, redirect, state: ticket.state };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const stored = this.authorizationCodes.get(authorizationCode);
    if (!stored) return this.refuseUnknownCode(client, authorizationCode);
    if (stored.clientId !== client.client_id) throw new InvalidGrantError('Authorization code was issued to a different client');
    return stored.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const stored = this.authorizationCodes.get(authorizationCode);
    if (!stored) return this.refuseUnknownCode(client, authorizationCode);
    if (stored.expiresAt < Date.now()) {
      throw new InvalidGrantError('Authorization code not found or expired');
    }
    if (stored.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    if (redirectUri && stored.redirectUri !== redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    this.authorizationCodes.delete(authorizationCode);
    const { tokens, family } = this.issue(client.client_id, stored.scopes, resource ?? stored.resource);
    this.usedCodes.set(authorizationCode, family);
    if (this.usedCodes.size > MAX_USED_CODES) this.usedCodes.delete(this.usedCodes.keys().next().value as string);
    return tokens;
  }

  /** A code that is not on file: if it was already redeemed, whoever redeemed it first holds tokens that must not
   *  survive the replay (RFC 6749 4.1.2). Always `invalid_grant` (400), never a 500 the client would retry. */
  private refuseUnknownCode(client: OAuthClientInformationFull, authorizationCode: string): never {
    const family = this.usedCodes.get(authorizationCode);
    if (family && family.clientId === client.client_id) this.killFamily(family);
    throw new InvalidGrantError('Authorization code not found or expired');
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const stored = this.refreshTokens.get(refreshToken);
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token not found or was issued to a different client');
    }
    // AUTH-H1: refresh tokens expire — a stolen refresh token dies with the
    // bound lifetime, not with the process.
    if (stored.refreshExpiresAt < Date.now()) {
      this.refreshTokens.delete(refreshToken);
      throw new InvalidGrantError('Refresh token expired');
    }
    // Rotate: single-use refresh tokens, and the access token minted beside the old one dies with it.
    this.refreshTokens.delete(refreshToken);
    this.accessTokens.delete(stored.family.access);
    return this.issue(client.client_id, stored.scopes, resource, stored.family).tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.accessTokens.get(token);
    if (!stored) throw new Error('Token invalid or revoked');
    if (stored.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      throw new Error('Token expired');
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt / 1000),
      resource: undefined,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: { token: string; token_type_hint?: string }): Promise<void> {
    // Invalid or already-revoked tokens: do nothing, per interface contract. Only the client a token was issued
    // to may revoke it, and revoking either half ends the pair (RFC 7009 2.1).
    const stored = this.accessTokens.get(request.token) ?? this.refreshTokens.get(request.token);
    if (stored && stored.clientId === client.client_id) this.killFamily(stored.family);
  }

  private killFamily(family: TokenFamily): void {
    this.accessTokens.delete(family.access);
    this.refreshTokens.delete(family.refresh);
  }

  
  /**
   * Mint a short-lived access token for the trusted universal gateway.
   * Disabled unless gatewaySecret is configured.
   */
  issueGatewayAccessToken(presentedSecret: string): OAuthTokens {
    const expected = this.config.gatewaySecret;
    if (!expected || !presentedSecret || !constantTimeEqual(expected, presentedSecret)) {
      throw new Error('gateway unauthorized');
    }
    return this.issue('renor-gateway', ['mcp'], undefined).tokens;
  }

  /** Mint the gateway's one-use-purpose bearer for the approval route. It is
   * deliberately a different scope from MCP and can only be obtained through
   * the loopback gateway-secret endpoint, never OAuth registration/exchange. */
  issueGatewayRuleApprovalToken(presentedSecret: string): OAuthTokens {
    const expected = this.config.gatewaySecret;
    if (!expected || !presentedSecret || !constantTimeEqual(expected, presentedSecret)) {
      throw new Error('gateway unauthorized');
    }
    return this.issue('renor-owner-rules', ['rules:approve'], undefined).tokens;
  }

  /** Expired tokens used to leave only when presented; sweep them so a long-running process does not grow without bound. */
  private sweepTokens(): void {
    const now = Date.now();
    for (const [t, s] of this.accessTokens) if (s.expiresAt < now) this.accessTokens.delete(t);
    for (const [t, s] of this.refreshTokens) if (s.refreshExpiresAt < now) this.refreshTokens.delete(t);
  }

  private issue(clientId: string, scopes: string[], resource?: URL, chain?: TokenFamily): { tokens: OAuthTokens; family: TokenFamily } {
    if (++this.issuedSinceSweep >= TOKEN_SWEEP_EVERY) { this.issuedSinceSweep = 0; this.sweepTokens(); }
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const expiresAt = Date.now() + this.config.accessTokenTtlSeconds * 1000;
    const family = chain ?? { clientId, access: accessToken, refresh: refreshToken };
    family.access = accessToken;
    family.refresh = refreshToken;
    const stored: StoredToken = {
      family,
      clientId,
      scopes,
      expiresAt,
      refreshExpiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    };
    this.accessTokens.set(accessToken, stored);
    this.refreshTokens.set(refreshToken, stored);
    const tokens = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' ') || 'memory',
      resource: resource?.href,
    } as OAuthTokens;
    return { tokens, family };
  }

  /** The bucket for one client network, created on first use. Locked or recently failed buckets are never evicted: once
   *  the map is full of them, new networks share one overflow bucket, so cycling addresses cannot reset a lockout. */
  private loginBucket(clientKey: string, now: number): LoginBucket {
    const existing = this.loginBuckets.get(clientKey);
    if (existing) return existing;
    if (this.loginBuckets.size >= LOGIN_BUCKET_LIMIT) {
      for (const [key, b] of this.loginBuckets) {
        if (now >= b.lockedUntil && now - b.lastFailureAt > FAILURE_MEMORY_MS) this.loginBuckets.delete(key);
      }
    }
    const key = this.loginBuckets.size >= LOGIN_BUCKET_LIMIT ? LOGIN_OVERFLOW_KEY : clientKey;
    let bucket = this.loginBuckets.get(key);
    if (!bucket) {
      bucket = { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
      this.loginBuckets.set(key, bucket);
    }
    return bucket;
  }

  private recordFailure(bucket: LoginBucket, now: number): number {
    if (now - bucket.lastFailureAt > FAILURE_MEMORY_MS) bucket.failures = 0;
    bucket.lastFailureAt = now;
    bucket.failures += 1;
    return bucket.failures;
  }

  private lockoutMs(exponent: number): number {
    return Math.min(this.config.loginLockoutMs * Math.pow(2, Math.min(exponent, 8)), LOCKOUT_MAX_MS);
  }

  /**
   * Operator recovery, called only from a local path (the SIGUSR2 handler in cli.ts), never from request handling:
   * ends every lockout now. Failure counts are kept, so the ceiling is unchanged: the next failed login in the window
   * locks again, and the total of failures held to MVP_LOGIN_MAX_FAILURES per window is the same as before.
   */
  operatorUnlock(): void {
    const now = Date.now();
    for (const b of this.loginBuckets.values()) b.lockedUntil = 0;
    this.globalLogin.lockedUntil = 0;
    audit('login_unlocked', { by: 'operator', at: now });
  }

  /** Test/operations helper: limiter is bounded and recoverable by design. */
  limiterState(clientKey = 'local'): { failures: number; lockedUntil: number } {
    const bucket = this.loginBuckets.get(loginNetworkKey(clientKey));
    return { failures: bucket?.failures ?? 0, lockedUntil: bucket?.lockedUntil ?? 0 };
  }
}

/** Express router for the owner consent+login form submit (mounted at /mvp-login). */
export function ownerLoginRouter(provider: OwnerOAuthProvider, config: MvpConfig): express.Router {
  const router = express.Router();
  router.post('/', express.urlencoded({ extended: false }), (req: express.Request, res: express.Response) => {
    const { ticket, email, password, approve } = (req.body ?? {}) as Record<string, unknown> as Record<string, string>;
    // Security headers apply to EVERY outcome of this handler (including
    // the 403/400/429 rejections below), so no response from the login
    // endpoint ever renders with looser referrer/CSP/frame semantics than
    // the consent page that linked to it.
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    // Cross-origin POST protection (AUTH-B1): when a browser supplies
    // Origin or Referer, it must be this service's own origin. Spoofable
    // forwarding headers (X-Forwarded-*) are deliberately NOT trusted.
    const origin = req.headers.origin ?? req.headers.referer;
    if (origin) {
      let allowed = false;
      try {
        const supplied = new URL(origin);
        allowed = supplied.origin === config.baseUrl.origin;
      } catch {
        allowed = false;
      }
      if (!allowed) {
        audit('login_rejected', { reason: 'cross-origin-post' });
        res.status(403).send('Cross-origin login requests are not accepted.').end();
        return;
      }
    }
    // A repeated field (email=a&email=b) parses to an array: refuse it before the ticket is spent.
    if ([ticket, email, password, approve].some(v => v !== undefined && typeof v !== 'string')) {
      res.status(400).send('Invalid authorization request.').end();
      return;
    }
    if (!ticket) {
      res.status(400).send('Invalid authorization request: missing one-time ticket. Restart the authorization from the application.').end();
      return;
    }
    const result = provider.handleOwnerLogin(ticket, email ?? '', password ?? '', approve === 'on', req.ip ?? req.socket.remoteAddress ?? 'unknown');
    if (!result.ok) {
      // Privacy-safe: no detail beyond the rejection, no code, no redirect.
      if (result.status === 429) res.setHeader('Retry-After', String(result.retryAfterSeconds ?? 1));
      res.status(result.status).send(htmlEscape(result.error)).end();
      return;
    }
    if (result.state) result.redirect.searchParams.set('state', result.state);
    res.redirect(302, result.redirect.href);
  });
  return router;
}
