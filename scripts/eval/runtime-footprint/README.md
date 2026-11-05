# Runtime footprint (Bun vs Node 22, and the hosted path's local cost)

Issue #1442. No runtime switch without this table. Measurement only: no model calls, no production endpoint, no network except the package install under `--install`.

```sh
cd engine && npm ci && npm run build
npx tsx scripts/eval/runtime-footprint/run.ts --bun-version 1.4.4 --install --suite   # the full table
npx tsx scripts/eval/runtime-footprint/run.ts --runs 1 --calls 50 --notes 200 --skip-part2   # smoke
```

Output: `.eval-runs/runtime-footprint/runtime-footprint.json` and `.md` (override with `--out`), carrying the exact commit (`+dirty` if `engine/` has edits) and the Node and Bun versions. Median with (min-max) over `--runs` (default 5), node and bun alternating.

Part 1 uses one seeded synthetic vault (`--notes`, default 2,000, built once by `scripts/bench/mcp-latency.ts`, hash vectors) and a fresh copy per run:

- **stdio**: `dist/cli.js mcp`, spawn to first `tools/list`; RSS idle and after N `search` calls (keyword-only). The stdio server exposes `search`, not `get_context`.
- **HTTP**: `dist/mvp/cli.js`, spawn to first reply from `/mcp`. A credential-free box cannot sign in with OAuth, so an unauthenticated POST (a 401) is the "first reply". A server that exits before answering is recorded as a notice with its startup error, not hidden.
- **in-process mvp**: `get_context` and `search_memory` p50/p95 over N calls and RSS. It runs TypeScript source (tsx under Node, native under Bun), so its start time is not reported.
- `--install`: `npm ci --omit=dev` vs `bun install --production` in a clean directory: size of `node_modules`, time, and the runtime binary.
- `--suite`: `bun --bun vitest run`; every failing test is listed with its first error line. Nothing is skipped or edited. See also #1234 (Bun's `readdir` Buffer entries in the walker), which is why the HTTP path currently fails under Bun.

Part 2 (needs `cli/`, `--cli` to point elsewhere): `renor setup --capture` into a throwaway `HOME`, with `RENOR_MCP_URL` pointing at a local stub. It lists processes that appeared and stayed, then times each hook that settings now name (median of 20, peak RSS from `VmHWM`). `renor connect` needs the real client app and a browser sign-in, so it is not run; events `setup --capture` does not install are reported as not installed.
