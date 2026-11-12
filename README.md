<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/renor-logo-light.svg">
  <img alt="Renor" src="docs/assets/renor-logo-dark.svg" width="420">
</picture>

<h3>Shared memory for coding agents, over MCP.</h3>

What one agent learns in a session, every agent knows in the next.

</div>

## How it works

1. **Tell one agent once:** a decision, a root cause, a correction.
2. **Renor saves it** as plain Markdown you own.
3. **Every agent recalls it** in its next session: Claude Code, Codex, Cursor, Grok, Gemini, VS Code, OpenCode, Pi or any MCP client.

## Quickstart

Two ways in. Both take under a minute.

### Hosted: the easiest path

```bash
npx renor connect --client claude-code
```

`--client` is `claude-code`, `codex`, `cursor`, `grok`, `gemini`, `vscode`, `opencode` or `pi`. One command adds Renor to that app, signs you in through the app's own flow (no token to copy), writes the memory rule below, and ends with a live check that your workspace answers. Search is hybrid (keywords and meaning). Sign up at [renor.cloud](https://renor.cloud).

### Self-hosted: the private path

Your memory stays in a folder on your machine. No account, no API key. You need Node.js 22.16 or later (22.16+ or 24+); on an older Node, `renor-engine` prints one line saying so and exits.

```bash
claude mcp add --scope user renor-local -- npx -y renor-engine mcp
codex mcp add renor-local -- npx -y renor-engine mcp
```

Restart the agent. The first start downloads about 12 MB, and the first Renor call works about 3 seconds after an empty start. Notes go to `~/.renor` (set `VAULT_PATH` to use another folder).

**Then add [the memory rule](#the-memory-rule)** to the agent's instructions file, so it saves on its own.

**Cursor or VS Code**, one click:

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=renor-local&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInJlbm9yLWVuZ2luZSIsIm1jcCJdfQ%3D%3D)
[![Add to VS Code](https://img.shields.io/badge/VS_Code-Add_renor--local-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=renor-local&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22renor-engine%22%2C%22mcp%22%5D%7D)

**Grok.** Grok starts project servers only in a folder it trusts, so register Renor in the project:

```bash
grok mcp add --scope project renor -- npx -y renor-engine mcp
```

Trust the folder in Grok, then restart Grok. To check it: ask Grok to save a real decision from your project, restart Grok, and ask about it in the new session. To turn telemetry off, set `DO_NOT_TRACK=1` in the environment Grok runs in. Paste [the memory rule](#the-memory-rule) into the project's `AGENTS.md`.

**Any other MCP client:** the command is `npx` with the arguments `-y renor-engine mcp` (stdio).

**Check it works:**

```bash
npx renor-engine status
```

Something wrong? `npx renor-engine doctor` is a read-only health report (folder, index, ledger, embeddings, client configs) that is safe to paste into a support request; secrets are redacted. See [troubleshooting](docs/self-hosting.md#troubleshooting).

Then tell your agent a real decision ("remember that the orders service uses Postgres 16"), start a new session, and ask about it.

Running it on a server or with Docker: [docs/self-hosting.md](docs/self-hosting.md).

Several agents on one memory: start each with its own `RENOR_CONNECTION_NAME` and they get the multi-agent ("hive") tools ([details](docs/self-hosting.md)).

## The memory rule

Five lines that make agents save decisions, corrections and facts on their own. In our Grok test (grok-4.7, renor-engine 1.4.0, 3 Nov 2026), agents with the rule saved in 8 of 8 sessions and the next session recalled 5 of 5 project facts.

`renor connect` writes it for you. Self-hosted, paste it into `~/.claude/CLAUDE.md` (Claude Code), `~/.codex/AGENTS.md` (Codex) or the project's `AGENTS.md` (Grok):

```md
## Renor memory

Renor is connected to this app and remembers across sessions.
- Before deciding anything non-trivial, recall first: one get_context call is usually enough.
- Save with remember when the user makes a decision, corrects you, or states a fact that should outlive this chat. Include the reason.
- Save the specific value (a port, a name, a path), not a summary of it.
- Do not save secrets, or things that are already in the code.
```

Self-hosted, the local tools are `search`, `remember_fact` and `note`; agents map the rule onto them ([tool list](skill/SKILL.md#stdio-renor-engine-mcp)).

## What runs on your machine

- **Your memory is plain Markdown** in one folder you own. Edit it with anything; back it up like any folder.
- **SQLite** holds the search index, next to the notes. It is rebuilt from the Markdown at any time.
- **No embedding model needed.** Search is by keyword; when the exact words miss, it retries with word stems. Hybrid search (keywords and meaning) is the hosted default; self-hosters can opt in to OpenAI or a local model ([details](docs/self-hosting.md#embeddings)).
- **Small:** a 1.8 MB package, about 5 MB installed. About 143 MB of memory with 1,000 saved memories.
- **Telemetry:** anonymous usage numbers (never text, names or paths) are on by default, with a notice on first run. `renor-engine telemetry off` or `DO_NOT_TRACK=1` turns them off. Your memory text is never shared unless you say yes to that separately. Every field: [docs/TELEMETRY.md](docs/TELEMETRY.md).

## Benchmarks

| Benchmark | Renor | Setup |
| --- | --- | --- |
| LongMemEval-S | **98.4%** (492/500) | Default (deep search) |
| LongMemEval-S | **94.4%** (472/500) | Lean mode (`RENOR_DEEP_SEARCH=0`) |
| LoCoMo (categories 1 to 4) | **96.7%** (1,489/1,540) | Default (deep search) |
| BEAM 128K / 1M / 10M | **76.2 / 74.7 / 60.2** | Default (deep search), score out of 100 |
Claude Opus 5.5 answers LongMemEval, LoCoMo and BEAM. One run each, Oct 2026. Deep search, the default, reads 50 matches with a 4,000-token budget; `get_context` replies in up to 8,000 tokens. Lean mode (`RENOR_DEEP_SEARCH=0`) reads 20 matches with 1,300 tokens and an 800-token `get_context`. These runs used Vertex embeddings, as hosted Renor does; without an embedding model, self-hosted search is by keyword only, which they do not measure. Judges and methods for every run: [renor.cloud/research](https://renor.cloud/research).

## Build from source

You need Node.js 22.16 or later and git.

```bash
git clone https://github.com/renorai/renor-engine.git
cd renor-engine
npm ci && npm run build
node scripts/smoke-self-hosted.mjs
```

The last command starts the MCP server in a temporary folder, saves one fact, finds it again and ends with `PASS: self-hosted stdio MCP can remember and retrieve a current fact.` It never touches your notes. Downloaded a ZIP instead of cloning? Build with `RENOR_BUILD_COMMIT=0000000 npm run build`. Connecting a local build to each agent: [docs/self-hosting.md](docs/self-hosting.md).

## Learn more

[Docs](https://renor.mintlify.app) · [Self-hosting, servers and Docker](docs/self-hosting.md) · [Every setting](docs/ENVIRONMENT-VARIABLES.md) · [Telemetry](docs/TELEMETRY.md)

## License and contributing

The engine is **Apache-2.0** ([LICENSE](LICENSE)); 1.0.0 was released under AGPL-3.0; 1.1.0 and later are Apache-2.0; files imported from the upstream project stay ISC ([NOTICE](NOTICE), [UPSTREAM.md](UPSTREAM.md)). The `renor` CLI, the SDKs and the integrations are MIT.

Contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) has setup, tests and good first issues. Sign off each commit with the [DCO](https://developercertificate.org/) (`git commit -s`); there is no CLA. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

If Renor saves you re-explaining, a [⭐](https://github.com/renorai/renor-engine) helps other developers find it.
