// The gate's own scripts are plain ESM JavaScript (.mjs) with no declaration file, so a test that
// imports them gets an implicit `any` (TS7016). Declaring exactly these two modules keeps that
// explicit and narrow: a NEW untyped import still fails the typecheck instead of slipping through.
declare module '*/scripts/gate/agent-gate.mjs';
// The quick tier and the run's file order: plain ESM JavaScript beside the gate, with the tests that state them.
declare module '*/scripts/gate/quick-select.mjs';
declare module '*/scripts/gate/record-durations.mjs';
declare module '*/scripts/gate/lint-baseline.mjs';
// The merge-ready check's gate-record parser, which the quick tier's tests hold to its promise (a quick record is refused).
declare module '*/merge-ready/gate-record.mjs';
// Its status-description parser, which the status poster's tests hold to its promise (a listed known flake is not a flake).
declare module '*/merge-ready/github-producer.mjs';
// The stored-report check behind a trusted-runner status, which its fake-S3 tests hold to the write-once store's contract.
declare module '*/merge-ready/runner-report.mjs';
declare module '*/setup/durationSequencer.mjs';
declare module '*/scripts/gate/test-inventory.mjs';
declare module '*/scripts/gate/landing-train.mjs';
declare module '*/scripts/gate/post-full-gate-status.mjs';
declare module '*/scripts/gate/open-flake-issues.mjs';
// The shard split and the shard combine the landing train applies, which its tests hold to plan-shard's own split.
declare module '*/hosted-full-gate/plan-shard.mjs';
declare module '*/hosted-full-gate/summarize.mjs';
declare module '*/scripts/ci/check-gateway-deps.mjs';
// The release script (scripts/release) is the same kind of module: plain ESM JavaScript, imported by its own tests.
declare module '*/scripts/release/run-release.mjs';
declare module '*/scripts/release/lib/sql-scan.mjs';
declare module '*/scripts/release/lib/evidence.mjs';
declare module '*/scripts/release/lib/exec.mjs';
declare module '*/scripts/release/lib/remote.mjs';
declare module '*/scripts/release/lib/supabase.mjs';
declare module '*/scripts/release/lib/parity.mjs';
declare module '*/scripts/release/lib/report.mjs';
declare module '*/scripts/release/lib/runtime.mjs';
declare module '*/scripts/release/lib/state.mjs';
declare module '*/scripts/release/lib/steps-post.mjs';
// The preflight's Edge Function secrets check (names only), imported by its own tests.
declare module '*/scripts/release/lib/function-secrets.mjs';
// The Claude Code plugin's standing-rules hook (claude-code-plugin/hooks/standing-rules): plain ESM JavaScript the plugin runs with node, imported by their tests.
declare module '*/claude-code-plugin/hooks/standing-rules/standing-rules.mjs';
declare module '*/claude-code-plugin/hooks/standing-rules/session-start.mjs';
declare module '*/claude-code-plugin/hooks/standing-rules/mcp-http.mjs';
declare module '*/claude-code-plugin/hooks/standing-rules/standing-rules-gate.mjs';
declare module '*/claude-code-plugin/hooks/standing-rules/privacy.mjs';
declare module '*/claude-code-plugin/hooks/standing-rules/approvals.mjs';
declare module '*/claude-code-plugin/hooks/standing-rules/approve.mjs';
