/**
 * The HTTP MCP server (createMvpApp, startMvpService) is POSIX-only by design: its OAuth client store needs a POSIX user id
 * and owner-only (0700 / 0600) modes, and native Windows refuses to start it, fail closed (README "Windows (WSL2 only)",
 * docs/self-hosting.md). The suites and tests that boot it are skipped on win32 for that reason and no other (#1563); the
 * refusal itself is tested on every platform in client-persistence.test.ts ("refuses startup when the platform has no POSIX
 * user id"). Every other test in those files runs on Windows too.
 */
export const HTTP_SERVER_UNSUPPORTED = process.platform === 'win32';
