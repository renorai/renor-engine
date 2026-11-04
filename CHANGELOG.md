# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
