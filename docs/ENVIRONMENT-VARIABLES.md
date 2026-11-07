# Environment variables

A first run needs **no setting** on the command-line (stdio) server, and **two** on the HTTP server (`MVP_OWNER_EMAIL` and `MVP_OWNER_PASSWORD`; in Docker, nothing else). Everything below is optional unless a row says "required". This page lists only the settings a person running Renor for themselves may want.

Everything else is in [ENVIRONMENT-VARIABLES-REFERENCE.md](ENVIRONMENT-VARIABLES-REFERENCE.md): the settings for people who run the hosted service (operators) and the experiment, benchmark and tuning switches. None of those is needed to run Renor; their defaults are the ones the product was measured with.

**Two servers.** The command-line server is `node dist/cli.js mcp` (MCP over stdin and stdout). The HTTP server is `npm run mvp` (MCP over HTTP with an owner sign-in); its setup is in [self-hosting.md](self-hosting.md). A row that says nothing is read by both.

**How these pages stay true.** `tests/docs/environment-variables.test.ts` reads every file under `src/` and fails when the source reads a variable that has no row in this page or the reference, or a row names a variable the source does not read. It also checks the defaults of the settings a first run meets.

## Stdio server (`node dist/cli.js mcp`, what `npx -y renor-engine mcp` runs)

| Variable | Default | What it does |
| --- | --- | --- |
| `VAULT_PATH` | `~/.renor` | The folder of Markdown notes the command-line server and its commands read and write (`log-conversation`, a Stop hook, still exits quietly without it). Unset or empty, it is `.renor` in your home directory (a hidden name, so it is never a folder of yours that already exists, a clone named `renor` for one), and the server prints `Renor memory: <path>` on stderr at start, so `npx -y renor-engine mcp` needs no setting. Use an absolute path to choose another: an MCP client starts the server from a folder you do not choose. The engine creates the folder, and `.semantic-memory/` inside it, if they are missing. The quickstart check does not read it. The HTTP server does not use it (see `MVP_MEMORY_DIR`). |
| `PRIORITY_PATHS` | empty | Comma-separated path fragments, for example `Projects/,Areas/Work/`. A hit from a note whose path matches gets a score bonus of 0.1. |
| `RENOR_OWNER_NAMES` | unset | Comma-separated names. The first is canonical and the others are aliases of it; "I", "me", "my" and these names then resolve to your own facts. Unset, only case and Unicode form are folded. |
| `RENOR_CONNECTION_NAME` | unset | Names this connection of the command-line server. With a name that does not render empty (not blank, not `unnamed`) it also publishes the five hive tools, 13 tools instead of 8. Read once at start. One live process may hold a name in a notes folder. |

## Search by meaning (embeddings)

| Variable | Default | What it does |
| --- | --- | --- |
| `EMBEDDING_PROVIDER` | `none` | How the command-line server turns text into vectors for search by meaning. `none`: no embedding model, no key; search matches words, and saved facts are found as they are. `openai`: an OpenAI-compatible embeddings API (see `OPENAI_API_KEY`); the text of your notes is sent to it. `local`: downloads a model on first use and runs it on this machine. It needs the optional package `@xenova/transformers`, which a clone installs and `npx -y renor-engine` leaves out (hundreds of megabytes): add it with `npx -y -p renor-engine -p @xenova/transformers renor-engine mcp`. `eval-hash`: a deterministic offline stand-in the tests use; it makes no quality claim. After you change the provider on a folder that already holds notes, run `node dist/cli.js rebuild`: a plain `index` does not embed notes it has already indexed. The HTTP server needs no rebuild: when it starts with a provider it embeds, in the background, every chunk that has no vector. It reads `MVP_EMBEDDING_PROVIDER` first and then this variable, and accepts `none`, `local`, `openai` and `vertex`, so a value only the command-line server accepts (`eval-hash`) stops the HTTP server at start. |
| `OPENAI_API_KEY` | unset | The key for `EMBEDDING_PROVIDER=openai`, required then. Several keys, separated by commas, rotate when one is rate limited. On its own it sends nothing: the command-line server uses OpenAI only for `EMBEDDING_PROVIDER=openai` and for `LLM_EXTRACTION=true`. The HTTP server falls back to it when `MVP_EMBEDDING_API_KEY` is unset. |
| `EMBEDDING_MODEL` | `text-embedding-3-small` for `openai`, `Xenova/multilingual-e5-base` for `local` | The model name. The HTTP server also reads it, as a fallback for `MVP_EMBEDDING_MODEL`. |
| `EMBEDDING_BASE_URL` | the OpenAI API | The base URL of an OpenAI-compatible embeddings service (Voyage AI and gateways work). The extractor lanes also use it, with `OPENAI_API_KEY`, as a fallback for `OPENAI_BASE_URL`. The HTTP server reads it as a fallback for `MVP_EMBEDDING_BASE_URL`. |
| `EMBEDDING_DIMS` | `1536` for `openai` | The vector size. Set it when the service returns another size. The HTTP server reads it as a fallback for `MVP_EMBEDDING_DIMS`. |
| `MVP_EMBEDDING_PROVIDER` | `none` | HTTP server. `none`, `local`, `openai` or `vertex`; read before `EMBEDDING_PROVIDER`. |
| `MVP_EMBEDDING_API_KEY` | `OPENAI_API_KEY` | HTTP server, `openai`: the key. Required when the provider is `openai` and `OPENAI_API_KEY` is unset. |

## HTTP server (`npm run mvp`)

| Variable | Default | What it does |
| --- | --- | --- |
| `MVP_OWNER_EMAIL` | none, required | The one login email. No other identity can authorize a client. |
| `MVP_OWNER_PASSWORD` | none, required | The owner's secret, at least 8 characters; the only gate on your memory, so make it long and random (`openssl rand -base64 18`). The server refuses examples from documentation and very common passwords. |
| `MVP_MEMORY_DIR` | none, required | The folder the server keeps its memory in: statements, ledger and daily notes. Use a new folder. The server creates it owner-only (`0700`, files `0600`) and tightens a looser one it finds. |
| `MVP_AUTH_STATE_PATH` | none, required | The file that holds the registered OAuth clients (with their secrets). It must sit in a directory that is owner-only (`0700`) and outside the memory, history and export folders; it cannot be a Markdown file. |
| `MVP_BASE_URL` | none, required | The URL clients reach the server at, for example `http://127.0.0.1:39471`, with no query or fragment. The OAuth metadata and the printed MCP endpoint (`$MVP_BASE_URL/mcp`) come from it. Keep its port equal to `MVP_PORT`. |
| `MVP_ALLOWED_CALLBACK_URIS` | empty | Comma-separated redirect URIs a client may register, matched exactly (`localhost` is not `127.0.0.1`). Empty means no client may register. |
| `MVP_PORT` | `3471` | The port to listen on: 1 to 65535. |
| `MVP_HOST` | `127.0.0.1` | The address to listen on, as an IP literal (a hostname is refused at start). Leave it on loopback and put a TLS proxy in front, unless the only way in is already such a proxy: the platform files (`render.yaml`, `railway.toml`, `fly.toml`) set `0.0.0.0` because the platform's proxy is. A non-loopback address is refused at start unless `MVP_BASE_URL` is `https://` or names `localhost`. Endpoints that answer only a local caller (`/version`) still refuse any request from another address. |
| `MVP_TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the server: 0 to 5. At `0` a client is its socket peer and `X-Forwarded-*` headers are dropped. At `N` the address the Nth proxy appended to `X-Forwarded-For` is the client, so each remote client has its own failed-login and OAuth rate-limit bucket; without it, behind a proxy, all clients share the proxy's. Set it to the real number: too high lets a client choose its own address and evade the login limit. Any value above `0` on a public bind (`MVP_HOST` beyond loopback), and any value above `1`, is refused unless `MVP_TRUST_PROXY_HOPS_ACK_SPOOFING=1` confirms it. |

## Automatic recall (Claude Code hook)

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_AUTO_RECALL` | unset (off) | `1` (or `on`, `true`, `yes`) turns the hook on. Anything else, it exits at once and reads nothing. |
| `RENOR_AUTO_RECALL_TOKEN` | unset | The Renor API key sent as the bearer. Unset, nothing is asked. |
| `RENOR_AUTO_RECALL_URL` | `https://mcp.renor.cloud/mcp` | The MCP endpoint that serves `get_context`. The key is sent only to an `https://` URL, or over `http://` to the literal addresses `127.0.0.1` and `[::1]`, and never across a redirect. Any other URL, `http://localhost` included, gets no recall, and the hook prints one line to stderr saying so (the origin only, never the path, query or key). |

## Privacy

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_TELEMETRY_DISABLED` | `false` | `true` switches every remote destination off. |
| `RENOR_SHARING` | unset | `off`, `signals` or `data`. Overrides the recorded choice for this process, and can only lower it: it never turns sharing on, because a choice needs a record of the words the user saw. Any other value stops the command at start. |
