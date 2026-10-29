[Português (Brasil) → README.pt-BR.md](README.pt-BR.md)

# Renor

![Claude Code saves a decision to Renor; a fresh Codex session recalls it](docs/assets/renor-readme-demo.gif)\
*Self-hosted Renor, real session: Claude Code saves a decision, a fresh Codex session recalls it. Waiting time sped up.*

[![engine-public-ci](https://github.com/renorai/renor-engine/actions/workflows/engine-public-ci.yml/badge.svg?branch=main)](https://github.com/renorai/renor-engine/actions/workflows/engine-public-ci.yml)

**Renor is memory for coding agents: it keeps what you tell Claude Code, Codex or Cursor in a folder of Markdown files on your machine, and serves it back to any of them over MCP.**

Every new agent session starts from zero: you re-explain the project, last week's decision and why, the thing you corrected twice. With Renor, one agent saves it and the next one finds it. The memory is plain files you own. It runs locally, needs no account or API key, and sends nothing off your machine unless you configure a model or send anonymous usage numbers (on by default, with a first-run notice; `renor-engine telemetry off` or `DO_NOT_TRACK=1` turns them off). Your memory text is shared only if you say yes to that separately. A hosted version with no install is at <https://renor.cloud>.

## Quickstart

You need **Node 22** and git. The install is the only step that needs the network.

```bash
git clone https://github.com/renorai/renor-engine.git
cd renor-engine
node -v                    # v22.16 or newer
npm ci && npm run build
node scripts/smoke-self-hosted.mjs
```

The last command starts the MCP server, saves one fact (`Ada favorite_color cerulean`), searches for it three ways and stops. It works in a temporary folder that it deletes afterwards, so it never touches your notes. It ends with:

```text
PASS: self-hosted stdio MCP can remember and retrieve a current fact.
```

Downloaded a ZIP instead of cloning? It has no git history to stamp the build with, so build with `RENOR_BUILD_COMMIT=0000000 npm run build` instead. A wrong Node version or skipped install scripts: see [Troubleshooting](docs/self-hosting.md#troubleshooting).

## Connect your agent

**Without a clone.** With Node 22 installed, one line registers the published package. Your notes go to a hidden `.renor` folder in your home directory (`~/.renor`, printed on stderr at start; it never reuses an existing `renor` folder); to use another folder, add `-e VAULT_PATH=/absolute/path` to the `claude` line or `--env VAULT_PATH=/absolute/path` to the `codex` line. The first start downloads about 130 MB and takes about 15 seconds; if your agent shows one failed connection, restart it.

```bash
claude mcp add --scope user renor-local -- npx -y renor-engine mcp
codex mcp add renor-local -- npx -y renor-engine mcp
```

For Cursor or any other client, the server is the command `npx` with the arguments `-y renor-engine mcp`. In Cursor or VS Code (GitHub Copilot), one click adds it:

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=renor-local&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInJlbm9yLWVuZ2luZSIsIm1jcCJdfQ%3D%3D)
[![Add to VS Code](https://img.shields.io/badge/VS_Code-Add_renor--local-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=renor-local&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22renor-engine%22%2C%22mcp%22%5D%7D)

`claude mcp remove renor-local` and `codex mcp remove renor-local` undo the two lines above. The rest of this section is the same thing from a clone, which also lets you change the code.

**From a clone.**

Pick a folder for your memory (a new, empty one is fine; an Obsidian vault works too) and index it. Run this, and the commands below, from the `renor-engine` directory in the same shell:

```bash
export VAULT_PATH="$HOME/renor-notes"    # absolute path; created if missing
node dist/cli.js index
```

Each command below starts Renor with the Node 22 you are using now (`node -p process.execPath`), so the agent does not need Node 22 on its own `PATH`. In a new terminal, run the `export` line again first: each command stops with `VAULT_PATH: run the export line above first` rather than register a server that cannot start (an agent shows that only as "Connection closed").

**Claude Code**

```bash
claude mcp add --scope user renor-local -e VAULT_PATH="${VAULT_PATH:?run the export line above first}" -- "$(node -p process.execPath)" "$PWD/dist/cli.js" mcp
```

Restart Claude Code; `/mcp` lists `renor-local` in every project. `claude mcp remove renor-local` undoes it.

**Codex**

```bash
codex mcp add renor-local --env VAULT_PATH="${VAULT_PATH:?run the export line above first}" -- "$(node -p process.execPath)" "$PWD/dist/cli.js" mcp
```

Restart Codex; `codex mcp list` shows it. `codex mcp remove renor-local` undoes it.

**Cursor**

Cursor reads MCP servers from `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project). This prints the entry:

```bash
VAULT_PATH="${VAULT_PATH:?run the export line above first}" node -e 'console.log(JSON.stringify({ mcpServers: { "renor-local": { command: process.execPath,
  args: [process.cwd() + "/dist/cli.js", "mcp"], env: { VAULT_PATH: process.env.VAULT_PATH } } } }, null, 2))'
```

Put it in that file, or merge the `renor-local` entry into an existing `mcpServers`, then check that `renor-local` is enabled in Cursor's MCP settings. (The `cursor-plugin/` folder of this repository is the Cursor plugin for the hosted service at renor.cloud, which needs a Renor account; it does not connect to this engine.)

**Any other MCP client:** the command is `node dist/cli.js mcp` (stdio) with `VAULT_PATH` set.

Then ask your agent to remember something, and ask about it in a new session. What an agent saves is searchable at once. A Markdown file you add or edit by hand is searchable after you run `node dist/cli.js index` again.

## Run it on a server

One container serves your memory over HTTP to every agent, from any machine, with OAuth sign-in for you alone. It needs no model or key; the memory stays on a volume you own.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/renorai/renor-engine)

```bash
docker build -t renor-engine https://github.com/renorai/renor-engine.git
docker run -d --name renor -p 127.0.0.1:3471:3471 -v renor-data:/data \
  -e MVP_OWNER_EMAIL=you@example.com -e MVP_OWNER_PASSWORD="$(openssl rand -base64 18)" \
  -e MVP_ALLOWED_CALLBACK_URIS=http://localhost:39472/callback renor-engine
claude mcp add --transport http --scope user --callback-port 39472 renor http://localhost:3471/mcp
```

Sign in from `/mcp` in Claude Code with that email and password (`docker exec renor printenv MVP_OWNER_PASSWORD`). Railway (`railway.toml`) and Fly.io (`fly.toml`) work the same way; [Docker and one-click hosts](docs/self-hosting.md#docker-and-one-click-hosts) has the steps for each.

## What is stored where

| What | Where |
| --- | --- |
| Your notes | Any Markdown files in `$VAULT_PATH`. Renor reads them; edit them with anything. |
| What agents save | Appended as Markdown in the same folder: facts to `System/Memory Events Ledger.md`, notes to `Memory/Daily/<date>.md`. |
| Search index | SQLite at `$VAULT_PATH/.semantic-memory/index.db`. Derived: `node dist/cli.js index` rebuilds it from the Markdown. |

Everything Renor keeps is in that one folder, so back it up, sync it or move it like any other folder. Nothing leaves your machine unless you set a model key: `EMBEDDING_PROVIDER=openai` sends your notes' text to OpenAI to embed it, and `RENOR_EVIDENCE_MODE=auto` or `always` with an evidence-model key (`RENOR_EVIDENCE_API_KEY` or an `OLLAMA_*` key) makes search send the notes it matched to that model. The evidence pass is off unless `RENOR_EVIDENCE_MODE` is set, so a key alone sends nothing. Every setting and its default: [docs/ENVIRONMENT-VARIABLES.md](docs/ENVIRONMENT-VARIABLES.md).

**Search without embeddings.** With nothing set, Renor uses no embedding model, so a note is found by its exact words: `blue notebook` finds "The blue notebook is on the desk", but `where is my notebook?` does not. Saved facts are found either way. For search by meaning, set `EMBEDDING_PROVIDER=openai` with `OPENAI_API_KEY`, or `local` to download a model once and run it on this machine, then run `node dist/cli.js rebuild` so existing notes are embedded ([details](docs/self-hosting.md#embeddings)).

## More

- [docs/self-hosting.md](docs/self-hosting.md): troubleshooting, embeddings, the HTTP server with OAuth sign-in, connecting agents over HTTP, the tool lists, owner names, multi-agent ("hive") tools (set `RENOR_CONNECTION_NAME` per agent), and how the vault is protected.
- [skill/SKILL.md](skill/SKILL.md): instructions to give your agent so it recalls and saves memory without being asked. Most of it names the hosted tools (`get_context`, `remember`); the `renor-local` server above has other names (`search`, `remember_fact`, `note`), listed in its [Stdio section](skill/SKILL.md#stdio-renor-engine-mcp).

Renor is a single-owner engine: one person's notes, one set of agents. It is not a multi-user product.

## Contributing, license, security

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and tests and lists good first issues. Renor's own code is **Apache-2.0** ([LICENSE](LICENSE)); 1.0.0 was released under AGPL-3.0; 1.1.0 and later are Apache-2.0; files imported from the upstream project stay ISC ([NOTICE](NOTICE), [UPSTREAM.md](UPSTREAM.md)). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

If Renor saves you re-explaining, a [⭐](https://github.com/renorai/renor-engine) helps other developers find it.
