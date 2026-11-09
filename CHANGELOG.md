# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.4.7 - 2026-11-09

### Added

- The stdio MCP server writes the learning log and shares signals by default, with the same notice, controls and final send attempt as the HTTP service (#1537).
- Signals sharing includes anonymous usage rows and country at ingest, without storing the network address (#1539).
- Signals sharing uses a rotating monthly contributor id, install-age ranges, coarse values and a three-contributor release rule (#1591).

### Fixed

- Correction recall marks the superseded note every time; two saves in the same second no longer lose the tie (#1600, fixes #1599).

## 1.4.6 - 2026-11-08

### Added

- Sharing (`signals`, the default): anonymous `install/1`, `heartbeat/1` and `funnel/1` rows (a random install id, environment and setup labels, the MCP client from a closed list, and call, latency, error and store-size buckets), and a one-time `opt-out/1` count with no identifier when sharing is turned off. Every field is listed in `docs/TELEMETRY.md`.

### Fixed

- Self-hosted `search` with no embedding model (the default `npx renor-engine mcp` install) finds a saved note for a natural question such as "what test runner does acme-api use": the keyword stand-in matches the question's content words with OR over the stemmed index instead of the whole question as one exact phrase (#1456, #1584). `RENOR_KEYWORD_OR_ALL=0` or `RENOR_KEYWORD_DEFAULTS=0` restores the exact phrase.
- Self-hosted `search` marks a note that a later note on the same page corrects with `superseded: { byChunkId, at }` and lists it after its correction (#1457, #1584). `RENOR_INFER_REPLACES=0` switches it off.
- A PR that bumps `GATE_VERSION` can land on its own gate (#1583).

### Tests

- Raised the write-side CLI test timeout for loaded machines (#1592).
- Fixed the Google code sign-in test flake (#913).

## 1.4.5 - 2026-11-08

### Added

- `renor-engine doctor` gives self-hosters a read-only health report for their folder, index, ledger, embeddings and client configuration, with secrets redacted (#1573).

### Fixed

- Windows: close databases before deleting their files, normalize displayed and scoped paths, and fix SQL errors; confined writes also refuse links safely where `O_NOFOLLOW` is unavailable (#1574, fixes #1563).

## 1.4.4 - 2026-11-07

### Fixed

- Windows: the engine works again. It skips the directory fsync, which Windows does not support, and closes databases before deleting their files; it had been broken on Windows since 13 Oct (#1565, fixes #1563).

## 1.4.3 - 2026-11-06

### Changed

- `RENOR_INFER_REPLACES` is on by default (`0` turns it off): a note that reads as a correction (now also "replaced by", "switched to", "changed to") supersedes the earlier note it corrects, so recall no longer shows the old value unmarked (#1460).
- The engine can store and index zero-LLM capture observations (`renor/observe`); off by default behind `RENOR_OBSERVE` (#1446).
- The hosted server gives coding agents the lean tool surface per connection with `?tools=coding` (get_context, search_text, retrieve_memory, remember, plus memory_status); `RENOR_MCP_TOOLS=all` turns it off (#1377).
- Keyword search matches any word (OR), with stemming, and `search_text` falls back to an any-word match when the exact phrase finds nothing; on by default (#1454).
- `remember` with an empty statement but a subject, predicate and object fills the statement from them (`RENOR_BLANK_STATEMENT`, on by default) (#1478).
- Hosted workspaces get higher default memory limits (`MemoryHigh` 640M, `MemoryMax` 768M) so a large workspace is not throttled (#1110).
- Every hosted workspace, including named ones, reports usage to PostHog unless telemetry is disabled (#838).
- The dreamer cost cap now counts billable failures and retries (#1505).
- Reading the agent-task answer file no longer follows symlinks and accepts only bounded regular files (#1500).
- A hosted workspace shared with everyone recovers when its training id changes (#1128).

### Added

- `RENOR_RECALL_FILE_TREE` shows a folder tree in `memory_map` (off by default) (#1375).
- `RENOR_FACT_VALIDITY_WINDOWS` records validity windows on structured rows (off by default) (#1373).
- `RENOR_RETRIEVE_AGGREGATE_K` widens the top-k for aggregate questions (off by default) (#1370).

## 1.4.2 - 2026-11-05

### Changed

- Capture: a missing observation date defaults to the request day, and a request with 0 valid entries returns 200 (#1449).
- Capture: no default thinking on the extraction call, and a 200 with 0 notes is explained (#1433).
- Capture: `temperature` is no longer sent to Claude 5.x models, and the upstream error is surfaced (#1424).
- `search` and `search_memory` return 50 matches by default (was 20), with a scaled expansion budget (#1024).
- Bun compatibility: zod namespace import and byte-mode readdir of bare Buffers (#1452).
- Node 26 keep-alive pool fix and chokidar 4 (#1126).
- Removed the unused `RENOR_CONTEXT_SPLIT` and `RENOR_READER_ADVICE_LINES` switches (measured not better, off by default) (#1431).

## 1.4.1 - 2026-11-03

### Changed

- `renor-engine connect <app>` writes the Renor memory rule into the app's instructions file (idempotent, `--no-rule` to opt out, removable by its markers), so agents save unprompted.

## 1.4.0 - 2026-11-03

### Added

- Empty workspace: `get_context` and `whats_new` say what to save first.
- `search_text` retries with a stemmed OR query when the exact phrase matches nothing (`RENOR_SEARCH_TEXT_FALLBACK`).
- `search_memory` returns keyword hits instead of an empty reply when semantic search is unavailable.
- The coding tool profile has shorter tool descriptions, with a size limit pinned by a test.
- The project scope recorded by `renor connect` ranks first (`x-renor-scope`).
- Opt-in, default off: `RENOR_INFER_REPLACES` (infer that a correction replaces a note), `RENOR_CONTEXT_NEWER_FIRST` (list the newer of two near-duplicate notes first), an ordinary update by another agent shown as history instead of CONFLICT.
- A save about a subject just recalled infers a cite.
- Self-host footprint and Bun-vs-Node-22 measurements, and published LongMemEval, LoCoMo and BEAM scores in the docs.

### Changed

- Daily ledgers over 8 MiB are indexed (up to 64 MiB) instead of skipped; a save says so when a note is over the cap.
- Gateway: a missing or invalid connect token says how to fix it, failed `/mcp` token lookups are rate-limited per address before the control plane, and the client response ends when the engine closes early.
- `renor-engine` prints a clear message when Node is older than 22.16, before any import.
- First start prints one migrations summary line; the documented first-start size and time are corrected (about 12 MB, about 3 s).
- The save hook offers each user line once, and complaints are no longer saved as rules.

### Changed

- **Default flip (D1), decided by firstmate under the owner's autonomy rule, 2026-10-30:** `RENOR_READER_LAYOUT_SKIP_ADVICE` is now on by default. A search query that asks to be advised (a recommendation, a suggestion, tips, an opinion) keeps the page the layout-off reader gives. On the 30 LongMemEval-S preference questions (gpt-4o-mini reader, gpt-4o-2024-08-06 grader), two draws: 7/30 with the layout against 13/30 with it skipped (19 Oct, exact p 0.031), and 5/30 against 11/30 (30 Oct, p 0.070). Both are net +6 on the questions the rule catches. The committed record of the 30 Oct draw is `engine/docs/evals/results/best-set-20261019/records/draw2-20261030-skip-advice/`. Turn it off with `RENOR_READER_LAYOUT_SKIP_ADVICE=0`.

## 1.3.0 - 2026-10-29

### Changed

- **Anonymous usage numbers are now on by default** for self-hosted installs, with a notice the first time. They are counts and labels only, never memory text, names or paths. To turn them off, run `renor-engine telemetry off` or set `DO_NOT_TRACK=1`. Sharing your memory text is never on unless you say yes to it separately, at a terminal (`renor setup`, or `renor-engine telemetry data`). See [docs/TELEMETRY.md](docs/TELEMETRY.md).
- `renor setup` asks one question about sharing memory text (default no).
- The package is published as one bundled file: the first `npx renor-engine` download is about 4.9 MB instead of 29 MB, and starts in about 3 to 4 seconds instead of 10 to 16.
- MCP SDK 1.32.2, zod 4.6.7 and body-parser 2.4.0 (dependencies, security updates).
- Gateway and engine refuse `Content-Encoding: br` requests with 415 while a security issue is fixed.
- Authenticated `get_context` and `search_memory` replies carry a `Server-Timing` header.

### Added

- MCP tools declare an output schema so clients can check replies, except the tools that return memory pages (such as `get_context` and `search_memory`), which stay text-only unless you set `RENOR_PAGE_OUTPUT_SCHEMAS=1`; `RENOR_TOOL_OUTPUT_SCHEMAS=off` turns schemas off for every tool.
- `sharing_level` MCP tool: an agent can read the sharing level and lower it (off, anonymous). Only you can raise it, at a terminal or in your client's own prompt.
- First-run sharing notice, shown once per install and recorded per surface.
- Opt-in: TOON-formatted `search_memory` replies (default off).
- Opt-in: `RENOR_MCP_RESPONSE=lines` for plain-line `search_text` replies, and a lean MCP tool profile with a smaller `whats_new` page (both default off).
- Memory receipts for automatic recall in the Claude Code plugin, and opt-in automatic recall for OpenCode and Cursor.
- Self-hosting in one step: a hardened container image, plus Render, Railway and Fly files.
- Public `renor` CLI and a clean-computer `npx renor setup` check.
- Renor Python client, an offline harness, and a LangGraph store and tools.
- Obsidian plugin: share chosen folders with Renor and ask it questions.
- Brazilian Portuguese self-hosting docs.
- `memory_status` reports the vector copy and its searches past the cap.
- Opt-in note-level ranking (`RENOR_NOTE_FUSION`, default off) and a configurable vector copy cap (`RENOR_VECTOR_MIRROR_MIB`, default 64 MiB).

### Fixed

- The ledger check reads its narrow form by default (set `RENOR_NARROW_LEDGER_CHECK=0` to keep the join).
- The `search_memory` event lookup uses an index on facts (migration 29).
- Note fusion reads only bounded regular files.
- The first Vertex access token is fetched at start-up, not on the first call.

## 1.2.0 - 2026-10-26

### Added

- Opt-in sharing of usage data with Renor, off by default: `renor-engine telemetry off` stops it and `renor-engine telemetry delete` asks Renor to delete what it holds (see [docs/TELEMETRY.md](docs/TELEMETRY.md)).

## 1.1.0 - 2026-10-25

### Changed

- Changed the license from AGPL-3.0-only to Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
- Renor Engine now installs with Node's own SQLite driver, with no native build step.
- See the [README](README.md) for installation and usage instructions.
