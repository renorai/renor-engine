# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
