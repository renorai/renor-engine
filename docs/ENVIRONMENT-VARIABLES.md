# Environment variables

Every environment variable the engine's source (`src/`) reads, with its default. You need none of them for a first run: with nothing set, `node scripts/smoke-self-hosted.mjs` starts the engine, saves a fact and finds it again (see the Quickstart in the [README](../README.md)). Most people set one, `VAULT_PATH`, the folder of notes. The rest are defaults you can change.

**How this page stays true.** `tests/docs/environment-variables.test.ts` reads every file under `src/` and fails when the source reads a variable that has no row here, or a row here names a variable the source does not read. It also checks the defaults of the first-run settings against `loadConfig()`. It cannot check a description: change what a variable does and you change its row.

**Not covered.** Variables read only by `scripts/` (the benchmark runners and the deployment scripts) or by the hosted service's gateway, which a self-hosted engine does not run, and the ones Node.js, npm and your operating system read themselves (`PATH`, `NODE_OPTIONS` and so on).

**Two servers.** The command-line server is `node dist/cli.js mcp` (MCP over stdin and stdout), with the commands `index`, `search`, `rebuild`, `watch`, `serve` and `log-conversation`. The HTTP server is `npm run mvp` (MCP over HTTP with an owner sign-in). Each row says which one reads the variable; a row that says nothing is read by both.

## Start here

| Variable | Default | What it does |
| --- | --- | --- |
| `VAULT_PATH` | `~/.renor` | The folder of Markdown notes the command-line server and its commands read and write (`log-conversation`, a Stop hook, still exits quietly without it). Unset or empty, it is `.renor` in your home directory (a hidden name, so it is never a folder of yours that already exists, a clone named `renor` for one), and the server prints `Renor memory: <path>` on stderr at start, so `npx -y renor-engine mcp` needs no setting. Use an absolute path to choose another: an MCP client starts the server from a folder you do not choose. The engine creates the folder, and `.semantic-memory/` inside it, if they are missing. The quickstart check does not read it. The HTTP server does not use it (see `MVP_MEMORY_DIR`). |
| `EMBEDDING_PROVIDER` | `none` | How the command-line server turns text into vectors for search by meaning. `none`: no embedding model, no key; search matches words, and saved facts are found as they are. `openai`: an OpenAI-compatible embeddings API (see `OPENAI_API_KEY`); the text of your notes is sent to it. `local`: downloads a model on first use and runs it on this machine. It needs the optional package `@xenova/transformers`, which a clone installs and `npx -y renor-engine` leaves out (hundreds of megabytes): add it with `npx -y -p renor-engine -p @xenova/transformers renor-engine mcp`. `eval-hash`: a deterministic offline stand-in the tests use; it makes no quality claim. After you change the provider on a folder that already holds notes, run `node dist/cli.js rebuild`: a plain `index` does not embed notes it has already indexed. The HTTP server needs no rebuild: when it starts with a provider it embeds, in the background, every chunk that has no vector. It reads `MVP_EMBEDDING_PROVIDER` first and then this variable, and accepts `none`, `local`, `openai` and `vertex`, so a value only the command-line server accepts (`eval-hash`) stops the HTTP server at start. |
| `OPENAI_API_KEY` | unset | The key for `EMBEDDING_PROVIDER=openai`, required then. Several keys, separated by commas, rotate when one is rate limited. On its own it sends nothing: the command-line server uses OpenAI only for `EMBEDDING_PROVIDER=openai` and for `LLM_EXTRACTION=true`. The HTTP server falls back to it when `MVP_EMBEDDING_API_KEY` is unset. |
| `RENOR_BENCH_DATA` | unset | Benchmark runners only: the benchmark data directory. Set, the index snapshots default to `index-snapshots` in it; unset, to `$HOME/.cache/renor-eval/index-snapshots`. `RENOR_EVAL_SNAPSHOT_DIR` wins over both. |
| `RENOR_EVIDENCE_MODE` | `off` | The evidence pass: after search finds notes, a model reads them and lists the items that answer the question (see [The evidence pass](#the-evidence-pass)). Off unless you turn it on: `always` runs it on every query, `auto` only on counting and listing questions (or a forced `evidence` call), `off` never. Turned on, each such search sends the query and the contents of up to 20 matched notes (up to 6,000 characters each) to `RENOR_EVIDENCE_BASE_URL` (default Ollama Cloud, `https://ollama.com/v1`). Hosted Renor sets `always` in each workspace's unit (`scripts/alpha/provision-renor-tenant.sh`), and the product benchmark runner sets it for its child. It acts only when a model key is configured (`RENOR_EVIDENCE_API_KEY`, `RENOR_EVIDENCE_API_KEYS` or an `OLLAMA_*` key); with none, nothing is sent anywhere and search returns the notes it found. `off` rules the pass out whatever keys the environment holds. |
| `RENOR_CONNECTION_NAME` | unset | Names this connection of the command-line server. With a name that does not render empty (not blank, not `unnamed`) it also publishes the five hive tools, 13 tools instead of 8. Read once at start. One live process may hold a name in a notes folder. |
| `RENOR_OWNER_NAMES` | unset | Comma-separated names. The first is canonical and the others are aliases of it; "I", "me", "my" and these names then resolve to your own facts. Unset, only case and Unicode form are folded. |

## Command-line server and its commands

| Variable | Default | What it does |
| --- | --- | --- |
| `DB_PATH` | `<VAULT_PATH>/.semantic-memory/index.db` | The SQLite index. It is derived from your notes and the ledger and can be rebuilt. A new one is created owner-only. |
| `MEMORY_DIR` | `Memory/Daily` | The folder, relative to the notes folder, where the `note` tool appends the daily notes. |
| `MEMORY_LEDGER` | `System/Memory Events Ledger.md` | The ledger file, relative to the notes folder. `remember_fact` appends each fact event to it before the index sees it, and the index rebuilds from it. |
| `CONVERSATIONS_DIR` | `Claude Code/Conversations` | The folder, relative to the notes folder, where `node dist/cli.js log-conversation` (a Claude Code Stop hook) writes session logs. That command also needs `VAULT_PATH`, and exits quietly without it. |
| `CHUNK_MAX_TOKENS` | `400` | The largest chunk, in tokens, a note is cut into. A positive number, larger than the overlap. |
| `CHUNK_OVERLAP_TOKENS` | `50` | Tokens shared by neighbouring chunks. `0` turns the overlap off. Less than `CHUNK_MAX_TOKENS`. |
| `INDEX_CONCURRENCY` | `5` | How many notes are indexed in parallel: a whole number from 1 to 20. |
| `PRIORITY_PATHS` | empty | Comma-separated path fragments, for example `Projects/,Areas/Work/`. A hit from a note whose path matches gets a score bonus of 0.1. |
| `LLM_EXTRACTION` | `false` | `true` makes `index` ask a model to extract facts from each note. That sends the note's text to the model: to OpenAI (`gpt-4o-mini`) when only `OPENAI_API_KEY` is set, or to the provider a `RENOR_EXTRACTOR_*` or Ollama key names. |
| `RENOR_API_TOKEN` | unset, required by `serve` | The bearer token `node dist/cli.js serve` (the local REST API) requires on every request. There is no default and no open mode: `serve` will not start without it. |
| `RENOR_VAULT_STALENESS` | `warn` | When the notes folder is a git checkout, whether to say that it is out of date. `warn` prints a line to stderr at start, `fatal` also refuses to start when HEAD is behind its already-fetched upstream, `off` says nothing. It reads local git metadata only and makes no network call. `renor search --json` adds a staleness field only when you set `warn` or `fatal` yourself. |

`renor search --json` names each note by its path below the notes folder (`Sessions/a.md`), the form the hosted tools print, instead of its absolute path: in `hits`, in each hit's `provenance` and in the `evidence` and `router` reports. Two opt-in lanes still print the stored path: the `RENOR_STRUCTURED_CONTEXT` text and the conflicts of the `RENOR_READ_HONESTY` report. Plain `renor search`, which a person reads at their own terminal, prints the file's real location.

## Embeddings

| Variable | Default | What it does |
| --- | --- | --- |
| `EMBEDDING_MODEL` | `text-embedding-3-small` for `openai`, `Xenova/multilingual-e5-base` for `local` | The model name. The HTTP server also reads it, as a fallback for `MVP_EMBEDDING_MODEL`. |
| `EMBEDDING_BASE_URL` | the OpenAI API | The base URL of an OpenAI-compatible embeddings service (Voyage AI and gateways work). The extractor lanes also use it, with `OPENAI_API_KEY`, as a fallback for `OPENAI_BASE_URL`. The HTTP server reads it as a fallback for `MVP_EMBEDDING_BASE_URL`. |
| `EMBEDDING_DIMS` | `1536` for `openai` | The vector size. Set it when the service returns another size. The HTTP server reads it as a fallback for `MVP_EMBEDDING_DIMS`. |
| `EMBEDDING_BATCH_SIZE` | `32` | Texts sent per request by the OpenAI-compatible provider: a positive whole number. |
| `OPENAI_BASE_URL` | unset | Read only by the extractor lanes: with `OPENAI_API_KEY` it names an OpenAI-compatible provider for them when no `RENOR_EXTRACTOR_*` or Ollama key exists. |
| `MVP_EMBEDDING_PROVIDER` | `none` | HTTP server. `none`, `local`, `openai` or `vertex`; read before `EMBEDDING_PROVIDER`. |
| `MVP_EMBEDDING_API_KEY` | `OPENAI_API_KEY` | HTTP server, `openai`: the key. Required when the provider is `openai` and `OPENAI_API_KEY` is unset. |
| `MVP_EMBEDDING_MODEL` | `voyage-4-large` for `openai`, `gemini-embedding-001` for `vertex`, `Xenova/multilingual-e5-base` for `local` | HTTP server: the model. Falls back to `EMBEDDING_MODEL`, and for `vertex` to `RENOR_EVAL_MODEL`. |
| `MVP_EMBEDDING_BASE_URL` | `https://api.voyageai.com/v1` | HTTP server, `openai`: the embeddings endpoint. Falls back to `EMBEDDING_BASE_URL`. |
| `MVP_EMBEDDING_DIMS` | `1024` for `openai`, `768` for `vertex` | HTTP server: the vector size (8 to 8192; `vertex` takes 768, 1536 or 3072; optional for `local`). Falls back to `EMBEDDING_DIMS`, and for `vertex` to `RENOR_EVAL_EMBEDDING_DIMS`. |
| `MVP_VERTEX_KEY_FILE` | unset | HTTP server, `vertex`: the service-account key file. Falls back to `GOOGLE_APPLICATION_CREDENTIALS`, then `RENOR_EVAL_VERTEX_KEY_FILE`. Required for `vertex`. |
| `MVP_VERTEX_PROJECT` | unset | HTTP server, `vertex`: the Google Cloud project. Falls back to `RENOR_EVAL_VERTEX_PROJECT`. Required for `vertex`. |
| `MVP_VERTEX_LOCATION` | unset | HTTP server, `vertex`: the region, for example `europe-west4`. Falls back to `RENOR_EVAL_VERTEX_LOCATION`. Required for `vertex`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | unset | The standard Google variable. The Vertex provider reads it for the key file when `MVP_VERTEX_KEY_FILE` and `RENOR_EVAL_VERTEX_KEY_FILE` are unset. |
| `RENOR_VECTOR_SIMD` | on | `0`, `false`, `no` or `off` turns off the WebAssembly SIMD scan of the vector index. Search then runs in JavaScript with the same answers, slower on a large index. |
| `RENOR_VECTOR_MIRROR_MIB` | `64` | The most MiB of stored vectors the process copies into RAM for the vector scan, read when the index is made. The copy is exact float32 and costs 4 bytes per dimension per vector (about 295 MiB for 100,000 chunks of 768 dimensions). Raised above 64, it is built in the background right after startup, and searches answer from sqlite-vec until it is ready, with the same answers; at 64 or less it is built on the first search. Past the cap, or where the copy cannot be allocated, the scan is sqlite-vec's, with the same answers. A whole number of MiB from 1 to 4096 (a larger number is 4096); any other value keeps 64. |
| `RENOR_EMBED_READ_BUDGET_MS` | `3000` | HTTP server. The longest a read waits for the embedding service to embed its query before it answers from facts and keyword search. `0` waits as long as the provider's retries take; otherwise 100 to 600000. |
| `RENOR_EMBED_WRITE_BUDGET_MS` | `5000` | HTTP server. The longest a save's index pass waits, per request of 32 texts, before it returns with the memory written and the vectors left for a background job. `0` or 100 to 600000, as above. |

A slow or refusing embedding service (429, 500, 503, silence) never holds an agent's call for minutes. Past its budget a save returns with the memory written and the receipt's existing `indexed: false` / `memory-saved-but-index-refresh-failed` warning (keyword search finds it at once), and `get_context` answers from the facts and keyword search with its existing semantic-unavailable `notice` (`search_memory` answers its existing `semantic-unavailable`). A service that just failed is not asked again by interactive calls for 15 s, and a background job embeds what was left (the provider's own retries and backoff, no lock held, started again at boot), so a saved memory becomes findable by meaning once the service answers. Measure it with `scripts/bench/embed-throttle-latency.ts` (a local stub; no Google call).

## HTTP server

The HTTP server is started with `npm run mvp`; the README walks through a first start. It refuses to start on a missing required variable, and says which.

| Variable | Default | What it does |
| --- | --- | --- |
| `MVP_MEMORY_DIR` | none, required | The folder the server keeps its memory in: statements, ledger and daily notes. Use a new folder. The server creates it owner-only (`0700`, files `0600`) and tightens a looser one it finds. |
| `RENOR_TOOL_OUTPUT_SCHEMAS` | on | The tools whose reply is small (status, lookups, lists, write acknowledgements) list an `outputSchema` and carry `structuredContent`. The tools that return a memory page (`get_context`, `search_memory`, `search_text`, `search_history`, `read_memory`, `memory_map`, `export_memory`, `lookup_entity`, `retrieve_memory`; on the stdio server `search`, `evidence`, `keyword`, `entity`, `facts`) stay text-only unless `RENOR_PAGE_OUTPUT_SCHEMAS` is on, because `structuredContent` repeats the page and a client may pass both blocks to its model. On the hosted server, `structuredContent` is exactly `JSON.parse` of the reply's text block, except under `RENOR_MCP_RESPONSE=lines`, where the text block holds lines and `structuredContent` stays the JSON object. On the self-hosted stdio server (`renor-engine mcp`), `structuredContent` is the parsed reply when the reply is an object; an array or null reply is wrapped as `{"result": ...}`, since structured content must be an object. Error replies are text only. `0`, `false`, `no` or `off` disables schemas for every tool; then the tools listing and every reply are byte-identical to a server without schemas. Read when each MCP server is built, so its listing and replies always agree. The gateway's static server card is generated from the default. |
| `RENOR_PAGE_OUTPUT_SCHEMAS` | off | `1`, `true`, `yes` or `on` gives the page-returning tools (listed under `RENOR_TOOL_OUTPUT_SCHEMAS`) their `outputSchema` and `structuredContent` too, when `RENOR_TOOL_OUTPUT_SCHEMAS` is not off. The cost is the wire: measured on #680, a `get_context` answer at the default 800-token budget goes from 741 to 1,446 tokens, because the same JSON travels twice. `max_tokens` still bounds the text block, and with this on `get_context` says so in its description. |
| `RENOR_MCP_TOOLS` | off (every tool) | A comma-separated list of tool names, or `lean` for the eight-tool preset (`LEAN_TOOLS`: whats_new, get_context, search_text, read_memory, memory_map, search_memory, retrieve_memory, remember): the HTTP server lists and runs only these, for a benchmark arm of `scripts/eval/agent-tasks/` (`src/mvp/contextProfile.ts`). A name the server does not register fails the server's build. Not applied to a directory client. |
| `RENOR_WHATS_NEW_PAGE` | 50 | The items a `whats_new` reply holds when the call names no `limit`: a whole number from 1 to 50. Unset, the reply is the 50-item page it always was. A call's own `limit` (1 to 50) wins; a full page carries a cursor for the rest. Other values fail the call. |
| `RENOR_MCP_DESCRIPTIONS_FILE` | off | A JSON file of `{"tool": "description"}`: those tools are listed with that description instead of their own. A file that cannot be read, is not such an object, or names a tool the server does not register fails the server's build. Not applied to a directory client. |
| `RENOR_MCP_INSTRUCTIONS_FILE` | off | A UTF-8 file whose text replaces the server instructions agents are given at `initialize`. An empty or unreadable file fails the server's build. Not applied to a directory client. |
| `RENOR_MCP_RESPONSE` | off (JSON) | `lines` makes `get_context`, `search_memory` and `search_text` answer one line per current fact (`fact`, then the subject, predicate and object) and per memory or hit (its date, then its text), in the reply's own order, instead of JSON. Experimental `toon` uses fixed TOON for successful HTTP `search_memory` replies only, with a `Format: TOON` header; other tools (including budgeted `get_context`) stay JSON. It never chooses a format by size. Refusals stay JSON and `structuredContent` is unchanged. TOON escapes hidden BMP characters; a reply with unsupported hidden supplementary characters, lone surrogates or unsafe keys returns `isError` / `toon-encoding-unsupported` rather than exposing them. Use the default JSON profile for such data. The value is trimmed (`" toon "` enables TOON); empty or whitespace-only values keep JSON. Any other non-empty value stops the server from starting. See the [offline evaluation](evals/TOON-20261027.md). |
| `MVP_BASE_URL` | none, required | The URL clients reach the server at, for example `http://127.0.0.1:39471`, with no query or fragment. The OAuth metadata and the printed MCP endpoint (`$MVP_BASE_URL/mcp`) come from it. Keep its port equal to `MVP_PORT`. |
| `MVP_PORT` | `3471` | The port to listen on: 1 to 65535. |
| `MVP_HOST` | `127.0.0.1` | The address to listen on, as an IP literal (a hostname is refused at start). Leave it on loopback and put a TLS proxy in front, unless the only way in is already such a proxy: the platform files (`render.yaml`, `railway.toml`, `fly.toml`) set `0.0.0.0` because the platform's proxy is. A non-loopback address is refused at start unless `MVP_BASE_URL` is `https://` or names `localhost`. Endpoints that answer only a local caller (`/version`) still refuse any request from another address. |
| `MVP_OWNER_EMAIL` | none, required | The one login email. No other identity can authorize a client. |
| `MVP_OWNER_PASSWORD` | none, required | The owner's secret, at least 8 characters; the only gate on your memory, so make it long and random (`openssl rand -base64 18`). The server refuses examples from documentation and very common passwords. |
| `MVP_AUTH_STATE_PATH` | none, required | The file that holds the registered OAuth clients (with their secrets). It must sit in a directory that is owner-only (`0700`) and outside the memory, history and export folders; it cannot be a Markdown file. |
| `MVP_ALLOWED_CALLBACK_URIS` | empty | Comma-separated redirect URIs a client may register, matched exactly (`localhost` is not `127.0.0.1`). Empty means no client may register. |
| `MVP_ACCESS_TOKEN_TTL_SECONDS` | `3600` | How long an access token lives: at least 60. |
| `MVP_LOGIN_MAX_FAILURES` | `5` | Failed owner logins, from any clients together, before login is locked for everyone: 1 to 100. A single client (an IPv4 address or an IPv6 /64) is locked out after half of that, rounded up, so one client does not lock out the others; several clients together can still reach the total. To unlock at once, send the server process `SIGUSR2` (`docker kill -s USR2 <container>`); only someone who controls the process can, and no request can. It ends the lockouts and keeps the failure counts, so the next failure locks again and the total stays at this limit. |
| `MVP_LOGIN_LOCKOUT_MS` | `30000` | How long a lockout lasts: 1 to 3600000 ms. |
| `MVP_TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the server: 0 to 5. At `0` a client is its socket peer and `X-Forwarded-*` headers are dropped. At `N` the address the Nth proxy appended to `X-Forwarded-For` is the client, so each remote client has its own failed-login and OAuth rate-limit bucket; without it, behind a proxy, all clients share the proxy's. Set it to the real number: too high lets a client choose its own address and evade the login limit. Any value above `0` on a public bind (`MVP_HOST` beyond loopback), and any value above `1`, is refused unless `MVP_TRUST_PROXY_HOPS_ACK_SPOOFING=1` confirms it. |
| `MVP_TRUST_PROXY_HOPS_ACK_SPOOFING` | unset | Set to `1` to confirm that `MVP_TRUST_PROXY_HOPS` equals the real number of proxies in front, so no client can reach the server directly and choose its own address. The platform files set it. |
| `MVP_MCP_JSON` | `true` | `true` answers every MCP request on its own (stateless JSON). `false` holds sessions in memory (about 0.3 MB each) and replies as server-sent events. |
| `MVP_MCP_MAX_SESSIONS` | `100` | With `MVP_MCP_JSON=false`, how many sessions stay open: 1 to 1000. |
| `MVP_MCP_SESSION_TTL_MS` | `3600000` | How long an idle session lives: 1000 to 86400000 ms. |
| `MVP_HISTORY_DIR` | unset | An optional folder of promoted history notes that `search_history` reads. It must not overlap `MVP_MEMORY_DIR`. Unset, `search_history` answers that history search is not configured. |
| `MVP_DB_PATH` | `<MVP_MEMORY_DIR>/.memory-index/index.db` | The SQLite index; not a Markdown file. |
| `MVP_LEDGER_REL` | `System/Memory Events Ledger.md` | The ledger file, relative to the memory folder. |
| `MVP_GATEWAY_SECRET` | empty | A secret the hosted service's gateway presents to obtain access tokens for its users. Leave it empty when you run the server yourself: with it empty the server validates the `Host` header against its own base URL. |
| `MVP_INSTANCE_ID` | unset | The workspace name the hosted service gives a process. Names the workspace in the connection notice and in telemetry. Leave it unset when self-hosting. |
| `RENOR_CONNECTION_STATUS` | on | `0` turns off the notice a hosted workspace adds to its first reply. It only appears when `MVP_INSTANCE_ID` is a hosted workspace name. |
| `MVP_COMPILE_CACHE_DIR` | unset | A folder for Node's compile cache, which speeds up start. It must not overlap the memory, history or auth locations, or the server refuses to start. Unset, no cache is used. |
| `MVP_COMPILE_SEED_DIR` | `.compile-seed` in the release | A folder of precompiled cache entries read at start. Used only when root or this account owns it and neither group nor others can write to it. |
| `RENOR_ON_DEMAND` | off | `1` or `true` makes the process exit after `RENOR_ON_DEMAND_IDLE_SECONDS` with no work in flight, for a workspace behind the hosted gateway that starts it again. Do not set it without that gateway. |
| `RENOR_ON_DEMAND_IDLE_SECONDS` | `600` | The idle time before an on-demand process exits: 1 to 86400. |
| `RENOR_EXPORT_MAX_BYTES` | `600000` | The most characters (despite the name) one `export_memory` reply carries; a larger export is paged. |
| `RENOR_ASK_AGENT_PER_HOUR` | `30` | How many requests one connection may record with `ask_agent` per rolling hour. Also applies to the command-line server's hive tools. |
| `RENOR_HANDOFF_NOTE` | off | `1`, `true`, `yes` or `on` publishes `handoff_note` on the hosted and the command-line server: one note per repository and branch, overwritten, never returned by any search, read or export tool. Off, nothing runs and the handoff tables are never created. **Expiry**: a note is deleted 7 days after it was written, by a sweep at server start and every 15 minutes (and on each handoff read or write), with SQLite `secure_delete` on and a WAL checkpoint, so its text is overwritten in the database file and its `-wal` emptied. What this does not do: (1) a reader holding the WAL (another process with an open read transaction) stops the checkpoint; the deleted row is gone at once, but its bytes stay in the file until a later sweep's checkpoint succeeds, which every sweep retries; (2) the 7 days are counted on a clock that never goes back (the latest of the wall clock, the time elapsed in the running process, and the last instant stored), so setting the clock back does not extend a note while a server runs, but time that passes while no server runs with the clock set back over it is not counted and delays the expiry by that long; (3) it does not reach backups, filesystem snapshots or any other copy of the database file. |
| `RENOR_READ_USE_WINDOW_MINUTES` | `30` | After a read, how long a later save that cites it counts as having used it, in the usage telemetry: 1 to 240. |

## Search and retrieval

Switches for how results are chosen and laid out. The defaults are the ones the product was measured with.

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_NEWEST_FIRST` | on | `0`, `false`, `no` or `off` lays the selected window out by score instead of newest session first. It does not change which chunks are selected. |
| `RENOR_SEARCH_BEST_FIRST` | off | `1`, `true`, `yes` or `on` makes `search_memory` list its hits best match first (`rankedBy: "score"`) instead of newest session first. Every hit keeps its `session_date`, the same hits are selected, and `get_context`, `renor search` and `RENOR_NEWEST_FIRST` are not affected. Unset or any other value leaves every reply byte-identical. Measured on the agent-workflow eval (LEDGER section AM): the needed memory moves to the top 3 far more often, but an old value or mistake saved as a plain note, without `replaces` or the structured form, can then rank above its correction. Keep it off. |
| `RENOR_TEMPORAL_RANKING` | on | `0`, `false`, `no` or `off` goes back to ordering without the temporal preference for current or historical facts. |
| `RENOR_TEMPORAL_ASOF` | off | `1`, `true`, `yes` or `on` treats a query that names a past date or month ("in April 2025", "originally") as a question about the past: it drops the recency bonus and ranks historical notes, and notes dated near that time, up. A present-tense word ("now", "currently") keeps it a question about now. |
| `RENOR_ENTITY_LANE` | off | `1`, `true`, `yes` or `on`: the rare words a query names (a subject such as a person, project or service: a registered entity name, or a word at most max(5, 2% of chunks) chunks carry; the rarest 3, and none for a query of more than 12 content words) pull the chunks that carry them into the search at their own cosine. Every hit that carries them gets up to +0.2 (`reason` `+entity-lane`), and the best 3 that carry every such word keep a place in the window. No model call. Measured on the offline evals in `docs/evals/results/plain-wording-crowding-20261021/`. |
| `RENOR_QUERY_REWRITE` | off | `1`, `true`, `yes` or `on`: the conversational wrapper of a query ("hey, do you remember what we said about ...", "can you remind me of ... again?") is taken off before it is embedded. A query the rewrite would leave with no content word is embedded as written. No model call. |
| `RENOR_NOTE_FUSION` | off | `1`, `true`, `yes` or `on` (H19 arm B, research only): the search window ranks each chunk of the semantic pool by its note's score, 0.5 × min-max of the note's best chunk cosine + 0.5 × min-max of BM25 over the note's text (k1 1.5, b 0.75, stop words out), over the notes the pool holds; the ledger is scored from its in-scope chunks. That score orders the window and feeds session expansion, while a hit's `similarity` stays the raw cosine. Chunks outside the pool (graph, entity-lane) keep their cosine. No model call; one read per pool note of a regular file of at most 32 KiB (a larger, linked or non-regular note is scored on the pool's chunks). Off by default until the product-path confirmation decides it (`src/retrieval/orchestrator.ts`, `noteFusionBase`). |
| `RENOR_NEAR_DUP_CAP` | off | A number n of 1 or more: at most n near-copies (word-set Jaccard 0.6 or more, on visible text) in a search window, the best scored kept, and the candidate pool is read deeper (min(160, 8 x top-K)) so the distinct memories they crowded out take the freed places. Unset, `0` or anything that names no number of 1 or more is off. |
| `RENOR_SESSION_DIVERSITY` | `2` for searches | How many chunks of one note or conversation a search keeps. Unset gives 2 for `search_memory`, the command-line `search` and the older API and MCP search; `get_context` keeps no cap by default. `0`, or anything below 1, turns it off. A fact, a ledger event and a daily-log entry are never counted. |
| `RENOR_SESSION_EXPAND` | `5` | How many of the best notes in the window get their other short statements added to it. `0`, or any value below 1, turns the expansion off. |
| `RENOR_NARROW_LEDGER_CHECK` | on | On each reply, whether the search index has caught up with the newest saved fact is asked by one full-text match, not one per chunk of the ledger note. `0`, `false`, `no` or `off` (in any case) keeps the per-chunk form. The answer is the same either way. |
| `RENOR_KEYWORD_OR_ALL` | off | `1` makes the keyword lane of `get_context` (no embedding provider) issue one FTS expression: the question's content words joined by OR, instead of the exact-phrase variants. Research switch (H11b, a replay on the agent-tasks corpus lifted needed-on-page from 40.8% to 73.3% with 9 losses): `=1` changes replies. Unset or any other value leaves every reply byte-identical. Keep it off until the guards and the confirmation pass. |
| `RENOR_SEARCH_TEXT_FALLBACK` | off | `1` makes `search_text` run the same words as an OR query when the exact phrase finds nothing, and label that reply `fallback: "any-word"`. A reply with hits is never changed. Research switch (H12: the fallback finds the note on 10 of 128 stored empty replies). Unset or any other value leaves every reply byte-identical. Keep it off until the guards and the confirmation pass. |
| `RENOR_EMBEDDING_SERVED_BY` | unset | For an operator who knows that an OpenAI-compatible embedding endpoint returns a calibrated provider's vectors: name that provider (`vertex`) and the command line arms the same ranked session expansion a hosted workspace runs. It counts only when the provider's own model and dimensions are one the product has calibrated; any other value, model or size changes nothing. Unset, nothing changes. Used by benchmark runs to match the hosted path; research use only. |
| `RENOR_SESSION_EXPAND_RANK` | on | `0` makes the expansion take statements best note first, in the order they sit in each note, instead of ranking them by closeness to the query. Ranking applies only with an embedding model the product has calibrated; with any other setting this has no effect. |
| `RENOR_SESSION_EXPAND_TOKENS` | `2000`, or `1300` when ranked | The most tokens the expansion may add. |
| `RENOR_SESSION_EXPAND_STATEMENT_TOKENS` | `120` | The longest statement, in tokens, the expansion adds from a conversation-shaped note. A longer one is skipped, never cut. |
| `RENOR_SESSION_EXPAND_RANKED_STATEMENT_TOKENS` | `400` | The longest statement, in tokens, the **ranked** expansion adds from a conversation-shaped note (the expansion a hosted workspace runs, and the command line with `RENOR_EMBEDDING_SERVED_BY`). A longer one is skipped, never cut. Unset or empty gives 400, unless `RENOR_SESSION_EXPAND_STATEMENT_TOKENS` is set: an explicit value of that one keeps deciding. A number of 1 or more sets the limit over the general one. **The off switch:** `0`, a negative number or anything that is not a number restores the general limit in the ranked expansion (120 unset), as it was before 25 Oct 2026. The former expansion and the documents are never touched by it. 400 is the largest value that changes anything: a section over 400 tokens is never a single chunk. It is not in the benchmark run manifest's flag list (that list is part of the frozen evaluator hash): a run that changes it says so in its own record. On the official LongMemEval-S instrument with a Claude Haiku 5.5 reader, the ranked expansion with 400 scored 433 of 500 and with 120 scored 431, against 418, 417 and 423 for the command-line default (LEDGER sections BE and BF: one draw each, found on the same 500 questions). |
| `RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS` | `200` | The same limit for every other note. |
| `RENOR_TOPK_SCALES_BUDGET` | off | `1`, `true`, `yes` or `on`: a search that asks for more than 20 matches (`--top-k`, `top_k`) gets a ranked expansion budget that grows with the ask, 1,300 tokens plus 90 for each match above 20 (4,000 at 50), unless `RENOR_SESSION_EXPAND_TOKENS` is set. At 20 or fewer matches, or off, nothing changes. |
| `RENOR_READER_DURATION` | on | `0`, `false`, `no` or `off` turns it off. When it is on (the default), it adds one line first to a search reply (the reader layout must be on too) when the question asks how many days, weeks or months lie between two events and the user wrote the date of each in their own words: the two dates, each with the sentence it was written in, and the time between them, counted from the written dates alone and never from a session date. A question it cannot answer that way, or any other question, gets the reply it would get without the flag. No stored text is cut or reworded. The `search_memory` tool description names the line only when the switch is written out as `1`, `true`, `yes` or `on`; left unset, the line is added to the reply but the description is unchanged. |
| `RENOR_READER_EVENTS` | on | `0`, `false`, `no` or `off` turns them off. When they are on (the default), they add one block first to a search reply (the reader layout must be on too) when the question asks for the order or the date of something you did ("which happened first", "when did I ..."): one line for each of your own statements that matches the question, each under the day it is about, oldest first, quoted as you wrote it. The excerpts stay in full below it. It makes no model call; with a real embedding model it also uses the vectors the index already holds to pick the lines, and without one it picks them by the words of the question. A question about a duration or about anything else gets the reply it would get without the flag. No stored text is cut or reworded. The `search_memory` tool description names the block only when the switch is written out as `1`, `true`, `yes` or `on`; left unset, the block is added to the reply but the description is unchanged. With `RENOR_READER_TIMELINE` on as well, a question that asks for a date can get both blocks, the timeline first. |
| `RENOR_READER_TIMELINE` | off | `1`, `true`, `yes` or `on` adds one block first to a search reply (the reader layout above must be on) when the question asks what a value is now or what it was before it changed: your own statements of that value, oldest first, the last one marked latest, earlier ones kept, quoted as you wrote them. The excerpts stay in full below it. It makes no model call. A question about a duration or an order gets the reply it would get without the flag. No stored text is cut or reworded. Research only. |
| `RENOR_READER_LAYOUT` | on | `0`, `false`, `no` or `off` turns off the reader layout of search (the command-line `search` and `search_memory` on the HTTP server): the hits that come from one conversation note are shown as one block, in the order of the conversation, and a hint below an excerpt names the calendar date a phrase such as "three weeks ago" points to. A session that reached the page as its header alone is no hit. No stored text is cut or reworded; whole chunks leave. It does not apply to `get_context`, saved facts or ledger events. |
| `RENOR_READER_LAYOUT_SKIP_ADVICE` | off | `1`, `true`, `yes` or `on` leaves a search query that asks to be advised without the reader layout, so its page is the one `RENOR_READER_LAYOUT=0` gives. It is narrow on purpose: only the last line of the query is read, and only for one of a few plain request frames ("Can you recommend...", "Could you suggest...", "Any tips...", "What should I...", "What do you think", "What would you do"). A query worded another way ("Please recommend a hotel") keeps the layout, and so does any query that also points at something said before ("earlier", "last time", "previously", "did you", "remind me", "you recommended"), even when it ends in a request frame. Every other query keeps the layout too. It changes nothing while `RENOR_READER_LAYOUT` is off. |
| `RENOR_READER_ORDER` | date | `relevance` puts the conversation blocks of the reader layout, on a page whose notes are all conversations, best match first (a block's score is its best chunk's, ties newest first) and the reply says `rankedBy: "score"`. Unset or any other value keeps the blocks in the order the page gave them (newest first by default) and leaves `rankedBy` as retrieval set it. Off by default because on RenorBench v2 it puts a superseded value ahead of the current one for knowledge-update questions. Research only. See `docs/evals/results/DELIVERY-LAYOUT-20261016.md`. |
| `RENOR_READER_SESSION_CAP` | 0 (no cap) | A whole number N above 0: one conversation block of the reader layout shows at most N chunks besides its header. Every chunk the query matched stays: the cap only drops statements the session expansion added beyond it. `0`, unset or anything invalid is no cap. Off by default because on RenorBench v2 a cap of 10 drops the remark a question asks about, which only the session expansion delivers. Research only. See `docs/evals/results/DELIVERY-LAYOUT-20261016.md`. |
| `RENOR_READER_ADVICE_LINES` | off | `1`, `true`, `yes` or `on` adds one block first to the reply of `search --json` when the query asks to be advised (the same request frames as `RENOR_READER_LAYOUT_SKIP_ADVICE` above): your own statements from the conversations the reply already holds that share a word with the request, each under the date of its conversation, oldest first, quoted as you wrote them. At most six lines, two per conversation and 400 tokens. Assistant turns and questions are not quoted. The excerpts stay in full below it, with the layout on or off. It makes no model call. Any other query, and any query with the switch unset or off, gets the reply it would get without the flag. No stored text is cut or reworded. The hosted `search_memory` does not read it. Research only. |
| `RENOR_SEARCH_HIT_FLOOR` | `0.63` for Vertex `gemini-embedding-001` at 768 dimensions, otherwise off | HTTP server, `search_memory`. Removes note hits whose raw cosine similarity to the query is below the floor. Any number from 0 to 1 sets it for any model; `0` turns it off. See [The hit floor](#the-hit-floor). |
| `RENOR_CONTEXT_RELEVANCE` | on | HTTP server, `get_context`. `0`, `false`, `no` or `off` stops it from saying that nothing on file matches the request. The signal also needs an embedding model with a calibrated bar, or `RENOR_CONTEXT_RELEVANCE_MIN`. |
| `RENOR_CONTEXT_RELEVANCE_MIN` | unset | HTTP server. The similarity bar for the relevance signal, for an embedding model that has no calibrated one. |
| `RENOR_CONTEXT_LEAN_ITEMS` | off | HTTP server, `get_context`. `1`, `true`, `yes` or `on` lists each memory as its text, its day (`session_date` as `YYYY-MM-DD`) and its markers (`replaced`, `matched`, `origin`, `source`, `untrusted`), without `notePath`, `headingPath`, `score` and `reason`, so the same `max_tokens` holds more memories. The order and the text are unchanged; the read-honesty lane keeps its own items. Unset or any other value leaves the reply byte-identical. `search_memory` does not read it. |
| `RENOR_CONTEXT_DISTINCT` | off | HTTP server, `get_context`. `1`, `true`, `yes` or `on` leaves out a memory that repeats the reply: a ledger record that is a fact the reply lists, or a memory whose words another memory holds whole (the first-listed copy stays; of nested ones the longer). A memory with a marker (`replaced`, `untrusted`, `origin`, `matched`) is never left out. Unset or any other value leaves the reply byte-identical. |
| `RENOR_CONTEXT_SPLIT` | off | HTTP server, `get_context`. `facts,recent,pieces` (for example `0.4,0.8,4`) sets how its `max_tokens` budget is split: `facts` is the facts' share while memories wait and `recent` the newest session's share, each above 0 and at most 1, and `pieces` is the most pieces of the newest session, a whole number from 1 to 12; the older evidence takes what the two leave. Unset, or any value not in that form, keeps the shipped split (0.4, 0.6, 4) and leaves every reply as before. Measured in #877 (answer quality loop 2): no split beat the default, so keep it off. |
| `RENOR_CONTEXT_BUDGET_TOKENS` | `6000` | The token budget of the composed context that `RENOR_STRUCTURED_CONTEXT` adds. |
| `RENOR_STRUCTURED_CONTEXT` | off | `1`, `true`, `yes` or `on` adds a bounded composed context (facts, events, preferences) beside the hits of the command-line server's `search` tool, `renor search` and `renor search --json`. |
| `RENOR_QUERY_SCOPED_ROWS` | off | `1`, `true`, `yes` or `on` filters the structured-row tables by overlap with the query before they are composed. |
| `RENOR_READ_HONESTY` | off | `1`, `true`, `yes` or `on` adds provenance, contradictions and an abstention verdict to `renor search --json` and to the HTTP server's `get_context`, and says when the evidence does not cover the question. Nothing is filtered or reordered. |
| `RENOR_READ_HONESTY_BAR` | `0.5` | The share of the query's content words the returned evidence must contain before a hit counts as an answer: 0 to 1. |
| `RENOR_STATUS_FRESHNESS` | off | HTTP server, `get_context`. `1`, `true`, `yes`, `on` or `label` marks a short-lived status fact (a pull request's state, a branch head, a build result, a count such as "14 issues open") with `staleStatus` once it is older than its window of 6 to 24 hours; `hide` leaves it out instead. Decisions, preferences and rules are never touched. Nothing is stored: the window is read from the fact's text and its saved time. Unset or any other value leaves the reply byte-identical. |

### The hit floor

`search_memory` applies a **0.63 raw-cosine floor** to note hits only when the workspace uses Vertex `gemini-embedding-001` at **768 dimensions**; every other embedding namespace defaults off. The floor runs after ranking and fact insertion. `RENOR_SEARCH_HIT_FLOOR=0` disables it and restores the previous replies byte for byte; any finite value from 0 to 1 changes the floor for any namespace (missing, empty or invalid values use that namespace's default). It never judges the boosted `score`. Facts, evidence, digests, ledger events and graph hits stay; session-expansion statements disappear if their note loses every matched hit. The response reports `floor: { similarity, withheld }`, and kept note hits show their similarity rounded to three decimals (the floor compares that same rounded cosine). Removed places are not backfilled. If a higher operator floor removes the closest relevant chunk, its relevance verdict is omitted so it cannot promise an absent match. There is no new MCP argument or listing text. `get_context`, the HTTP API and CLI searches are unchanged. Cosines depend on the model and dimensions: 0.63 was checked only with hosted `gemini-embedding-001` at 768 dimensions; it is never applied by default to hash vectors or an unknown namespace.

## The evidence pass

The evidence pass is off unless `RENOR_EVIDENCE_MODE` is `auto` or `always` (up to 20 source notes, `gemma4:31b`); turned on, it sends the query and those notes to the extractor's provider. It adds one extra model call per uncached search when an extractor is configured; identical cached queries reuse evidence, and unavailable extractors return retrieval hits. With no key configured the pass makes no call at all. An extraction whose reply the parser rejects (including a reply cut at the token limit) is remembered for 24 hours, so the same query over the same notes reports that failure again (`fromCache: true`) instead of paying for it again; a provider error (429, 5xx, timeout, refused request) is never remembered. Set `RENOR_EVIDENCE_MODE=off` to disable extraction (including forced evidence calls), or `RENOR_SEARCH_EVIDENCE=0` to disable attachment on search only. `RENOR_EVIDENCE_MODE=auto` retains intent gating; `RENOR_EVIDENCE_SESSIONS` overrides the session limit. Retrieval still defaults to top-K 20.

The extractor is any OpenAI-compatible endpoint: `RENOR_EVIDENCE_MODEL`, `RENOR_EVIDENCE_BASE_URL` (default Ollama Cloud) and `RENOR_EVIDENCE_API_KEY(S)`. `OLLAMA_*` keys are added to the pool only when that endpoint is `https://ollama.com`; any other provider needs its own `RENOR_EVIDENCE_API_KEY(S)`. Before pointing it at a reasoning model, bound each call with `RENOR_EVIDENCE_MAX_TOKENS` (sent as `max_tokens`) and `RENOR_EVIDENCE_REASONING_EFFORT` (`none` | `minimal` | `low` | `medium` | `high`, sent as `reasoning_effort`); both are unset by default, which sends the unbounded request, and an invalid value refuses to start. `renor search --json` reports what the pass did in `evidence` (`state` ok | failed | unavailable | not-applied | off), except under `RENOR_SEARCH_EVIDENCE=0`, and the product benchmark records it per case and in its manifest.

`RENOR_EVIDENCE_ASYNC=1` (default off; read only by the HTTP server's `get_context` and `search_memory`, never by the command-line server) bounds the wait for an uncached extraction to `RENOR_EVIDENCE_WAIT_MS` (default 2000): a cached table returns at once; otherwise the response says `pending` and the extraction fills the cache in the background, one per prompt, at most 2 running and 16 waiting per process (past that the response says `busy`).

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_SEARCH_EVIDENCE` | on | `0`, `false`, `no` or `off` stops search (the command-line server's `search` tool, `renor search`, `renor serve` and the HTTP server's search tools) from attaching the evidence table. The `evidence` tool still works. |
| `RENOR_EVIDENCE_SESSIONS` | `20` | The most source notes one extraction reads: a whole number from 1 to 50. |
| `RENOR_EVIDENCE_MODEL` | `gemma4:31b` | The model that extracts. |
| `RENOR_EVIDENCE_BASE_URL` | `https://ollama.com/v1` | The OpenAI-compatible endpoint the extractor calls. Blank is the default. |
| `RENOR_EVIDENCE_API_KEY` | unset | A key for the extractor. With `RENOR_EVIDENCE_API_KEYS` and, for Ollama Cloud, the `OLLAMA_*` keys, it forms the pool. |
| `RENOR_EVIDENCE_API_KEYS` | unset | Comma-separated keys for the extractor. |
| `OLLAMA_CLOUD_KEY_1`, `OLLAMA_CLOUD_KEY_2`, `OLLAMA_CLOUD_KEY_3`, `OLLAMA_CLOUD_KEY_4`, `OLLAMA_MAX_KEY`, `OLLAMA_API_KEY` | unset | The Ollama Cloud key pool, read in this order and shared by the evidence pass, the write-path extractors and the router. Used only for an Ollama Cloud endpoint: another provider never receives an Ollama key. Each may hold several keys separated by commas. |
| `RENOR_EVIDENCE_CACHE` | `evidence-cache.db` next to the index | The cache file of extractions, keyed by the exact prompt. |
| `RENOR_EVIDENCE_MAX_TOKENS` | unset | Bounds each extraction call (`max_tokens`): a positive whole number. Unset sends the unbounded request. |
| `RENOR_EVIDENCE_REASONING_EFFORT` | unset | `none`, `minimal`, `low`, `medium` or `high`, sent as `reasoning_effort`. |
| `RENOR_EVIDENCE_ASYNC` | off | HTTP server. `1`, `true`, `yes` or `on` bounds the wait for an uncached extraction (above). |
| `RENOR_EVIDENCE_WAIT_MS` | `2000` | HTTP server, with `RENOR_EVIDENCE_ASYNC`: how long a search waits, 0 to 60000. |
| `RENOR_EVIDENCE_ENUMERATE` | unset | A benchmark-client setting. The engine reads it only to record it in a run's manifest; it changes no search result (the exhaustive-prompt experiment it armed ended and its code is gone). |
| `RENOR_EVIDENCE_OPTIN` | unset | `ollama` is the only value. A hosted workspace that opted in reaches Ollama Cloud with the key in `RENOR_EVIDENCE_KEY_FILE`, on `gemma4:31b`, within a daily allowance. Unset for a self-hosted engine. |
| `RENOR_EVIDENCE_KEY_FILE` | unset | With `RENOR_EVIDENCE_OPTIN`: the absolute path of a file holding one key. |
| `RENOR_EVIDENCE_DAILY_CAP` | `50` | With `RENOR_EVIDENCE_OPTIN`: model calls per UTC day, 0 to 10000. A retried request counts. |

## Write-path extractors and guards

Off unless you turn them on. The four extractor lanes need a named provider: a bare `OPENAI_API_KEY` does not arm them.

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_EXTRACTOR_API_KEY` | unset | The provider key for the extractor lanes and the legacy `LLM_EXTRACTION` path. Checked before the Ollama pool. |
| `RENOR_EXTRACTOR_API_KEYS` | unset | Comma-separated keys for the same. |
| `RENOR_EXTRACTOR_BASE_URL` | `https://ollama.com/v1` | The endpoint for those keys. |
| `RENOR_EXTRACTOR_TIMEOUT_MS` | `180000` | How long one extractor call may take. |
| `RENOR_TYPED_FACTS` | off | `1`, `true`, `yes` or `on` extracts typed numeric facts at index time (a model call per note). Needs a named provider, or `index` stops. |
| `RENOR_CHRONICLE` | off | `1`, `true`, `yes` or `on` extracts dated events at index time. Same requirement. |
| `RENOR_PREFS` | off | `1`, `true`, `yes` or `on` extracts standing preferences at index time. Same requirement. |
| `RENOR_FACTS_WRITE_PATH` | off | `1`, `true`, `yes` or `on` runs the local-rules facts extractor on the write path (no model call). |
| `RENOR_CLASSIFY_CAPTURE` | off | `1`, `true`, `yes` or `on` classifies a saved statement and plans how to store it. A draft only: nothing is written because of it. |
| `RENOR_SECRET_GUARD` | off | `1`, `true`, `yes` or `on` refuses to store text that looks like a credential or a personal identifier, and says why. It decides what may be stored; it does not look at what is already stored. |
| `RENOR_JEV_OPTIN` | unset | The slug of one hosted workspace, and it must equal that workspace's `MVP_INSTANCE_ID` or it stays off. On, each text about to be stored by `remember`, `save_memory` or `remember_note` is also sent to TypeSafe's Jev (a US-hosted API) for a second sensitivity opinion and a recorded, advisory "worth saving" label, with a 1.5 s limit, falling back to the local rules on any failure. Needs `RENOR_JEV_KEY_FILE` and `MVP_MEMORY_DIR`. See `docs/security/JEV-SAVE-SCREEN.md`. |
| `RENOR_JEV_KEY_FILE` | unset | With `RENOR_JEV_OPTIN`: the absolute path of a file holding one key. |

## Opt-in trials

All three are off, and each sends text to a model, so each needs a provider key.

The session router (`RENOR_SESSION_ROUTER`, default off; `replace` or `union`) is a command-line trial: `renor index` also writes one title and summary per note with `RENOR_ROUTER_SUMMARY_MODEL`, and `renor search` asks `RENOR_ROUTER_MODEL`, in one bounded call, which notes answer the question, then delivers those notes' short sections instead of (`replace`) or beside (`union`) the retrieved chunks. Both models use the evidence pass's provider unless `RENOR_ROUTER_API_KEY` (and `RENOR_ROUTER_BASE_URL`) gives the router its own. When it cannot route, search returns the retrieved hits and `search --json` says why in its `router` field. The trial is one command: `bash scripts/eval/session-router-trial.sh --help`.

The answer check (`RENOR_ANSWER_CHECK`, default off) is an HTTP server trial: when a `get_context` or `search_memory` reply says `relevance.relevant: true`, one call asks the evidence pass's model whether the reply states what was asked, and a NO turns the verdict to `relevant: false`. It uses the evidence pass's endpoint, keys, model and, for an opted-in workspace, its key file and daily allowance; with no such key it does nothing. A call that fails or runs past its timeout leaves the reply as it was.

Write-time digests (`RENOR_DIGESTS`, default off) write a short digest of each note with a model at index time and show the digests of the matched notes with a search. Unlike the router they never borrow the evidence provider or an Ollama key: `RENOR_DIGEST_BASE_URL` and `RENOR_DIGEST_API_KEY(S)` must both be set, or the worker stops and nothing is sent.

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_SESSION_ROUTER` | `off` | `off`, `replace` or `union`. |
| `RENOR_ROUTER_MODEL` | `RENOR_EVIDENCE_MODEL` | The model that picks the notes. |
| `RENOR_ROUTER_SUMMARY_MODEL` | `RENOR_ROUTER_MODEL` | The model that writes the per-note summaries at index time. |
| `RENOR_ROUTER_API_KEY` | unset | A key for the router's own provider. |
| `RENOR_ROUTER_API_KEYS` | unset | Comma-separated keys for the same. |
| `RENOR_ROUTER_BASE_URL` | `RENOR_EVIDENCE_BASE_URL` | The router's own endpoint. |
| `RENOR_ROUTER_CACHE` | `router-cache.db` next to the index | The router's cache file. |
| `RENOR_ROUTER_TIMEOUT_MS` | `10000` | One call's timeout: 1000 to 120000. |
| `RENOR_ROUTER_RETRIES` | `1` for routing, `3` for summaries | Retries per call: 0 to 8. |
| `RENOR_ANSWER_CHECK` | off | `1`, `true`, `yes` or `on` turns the answer check on. |
| `RENOR_ANSWER_CHECK_TIMEOUT_MS` | `8000` | The one attempt's timeout: 1000 to 120000. No retry. |
| `RENOR_DIGESTS` | `off` | `on` or `off`. |
| `RENOR_DIGEST_BASE_URL` | unset, required with `RENOR_DIGESTS` | The OpenAI-compatible endpoint that writes the digests. |
| `RENOR_DIGEST_API_KEY` | unset, required with `RENOR_DIGESTS` | The key for it. |
| `RENOR_DIGEST_API_KEYS` | unset | Comma-separated keys for it. |
| `RENOR_DIGEST_MODEL` | `RENOR_EVIDENCE_MODEL` | The digest model. |
| `RENOR_DIGEST_REASONING_EFFORT` | `low` | `none`, `minimal`, `low`, `medium` or `high`. |
| `RENOR_DIGEST_TOKENS` | `600` | The size of a digest, in tokens: 100 to 4000. |
| `RENOR_DIGEST_RETRIES` | `3` | Retries per call: 0 to 8. |
| `RENOR_DIGEST_CACHE` | `digest-cache.db` next to the index | The digest cache file. |
| `RENOR_DIGEST_CACHE_ONLY` | off | Reads digests from the cache and never calls a model; needs no provider. |
| `RENOR_DIGEST_MAX_USD_PER_DAY` | `0.5` | The background worker's daily spend cap, in US dollars, estimated from the two prices below. |
| `RENOR_DIGEST_PRICE_IN_PER_M` | `0.225` | US dollars per million input tokens, for the cap. |
| `RENOR_DIGEST_PRICE_OUT_PER_M` | `0.75` | US dollars per million output tokens, for the cap. |

## Consolidation (the dreamer)

HTTP server only, **off by default**. A background pass that finds current facts which may be one thing under two names or scopes ("Atlas project" and "Atlas" with different `deploy_target`s; a value saved without its project scope), asks a model whether the newer one replaces the older, and writes only the replacements, as ordinary supersede events whose ledger statement names who and how: the dreamer, the prompt version, the model, whether a second look agreed, the reason and the events relied on (never the values). Nothing is deleted: the replaced value stays in history, and, as with any replacement of another writer's value, stays visible beside the new one, marked, until its writer saves again. A predicate that holds a collection (`supports`, `integrates_with`, `contributors`...) is never replaced automatically; its group is reported as both-may-hold. It runs after 20 fact saves, or after one idle hour once something is new, never twice within 8 hours. Turned on, it sends the subject, predicate, value, scope, saving agent, date and quoted words of the facts of each candidate group (not notes) to the endpoint below. It does nothing without a key.

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_CONSOLIDATE` | off | `1`, `true`, `yes` or `on` starts the dreamer, when a key is set. Anything else constructs nothing: no timer, no table, no read, no write, and every answer and file is the same as before. |
| `RENOR_CONSOLIDATE_API_KEY` | unset | The key for the endpoint, required: with none, the dreamer stays off and says why once. |
| `RENOR_CONSOLIDATE_API_KEYS` | unset | Several keys, separated by commas, used in turn. |
| `RENOR_CONSOLIDATE_BASE_URL` | `https://opencode.ai/zen/go/v1` | An OpenAI-compatible chat endpoint (OpenCode Go). For `opencode.ai` the request carries the session id header that endpoint requires. Separate from the evidence pass: turning the dreamer on never turns the read-time extractor on. |
| `RENOR_CONSOLIDATE_MODEL` | `deepseek-v4.1-flash` | The model id the endpoint serves. |
| `RENOR_CONSOLIDATE_MAX_TOKENS` | `600` | The output ceiling of one call, reasoning included. A positive whole number. |
| `RENOR_CONSOLIDATE_REASONING_EFFORT` | `low` | `none`, `minimal`, `low`, `medium` or `high`. |
| `RENOR_CONSOLIDATE_REVIEW` | `updates` | The second look: one more call, with both saves in full, for a pair the first call called an update (`updates`), could not settle (`uncertain`), or both (`both`). `off` makes one call per group. An update stands only if the second look agrees. |
| `RENOR_CONSOLIDATE_DRY_RUN` | off | `1`, `true`, `yes` or `on` judges and plans and writes nothing: no event, no table, no index pass. The log lists each planned write by event id, subject, predicate and scope, never a value. |
| `RENOR_CONSOLIDATE_MAX_USD_PER_DAY` | `0.05` | The workspace's spend cap per UTC day, in US dollars, estimated from the two prices below. A call that could pass it is not made; the groups left are asked on a later run. The count is kept in the workspace's index, so a restart does not hand the day back (a dry run keeps its count in the process). |
| `RENOR_CONSOLIDATE_PRICE_IN_PER_M` | `0.15` | US dollars per million input tokens, for the cap. |
| `RENOR_CONSOLIDATE_PRICE_OUT_PER_M` | `0.6` | US dollars per million output tokens, for the cap. |

## Automatic recall (Claude Code hook)

Read by the `UserPromptSubmit` hook (`dist/recall/autoRecall.js`, see [claude-code-plugin/README.md](../claude-code-plugin/README.md)), not by either server. Off by default. On, each prompt that is not trivial is sent to `get_context` and the reply is added to the agent's context. A failure, a timeout or an unrelated reply adds nothing and never blocks the prompt.

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_AUTO_RECALL` | unset (off) | `1` (or `on`, `true`, `yes`) turns the hook on. Anything else, it exits at once and reads nothing. |
| `RENOR_AUTO_RECALL_TOKEN` | unset | The Renor API key sent as the bearer. Unset, nothing is asked. |
| `RENOR_AUTO_RECALL_URL` | `https://mcp.renor.cloud/mcp` | The MCP endpoint that serves `get_context`. The key is sent only to an `https://` URL, or over `http://` to the literal addresses `127.0.0.1` and `[::1]`, and never across a redirect. Any other URL, `http://localhost` included, gets no recall, and the hook prints one line to stderr saying so (the origin only, never the path, query or key). |
| `RENOR_AUTO_RECALL_MAX_TOKENS` | `400` | Most tokens added to the agent's context per prompt (128 to 4000). `get_context` is asked for twice this, and the injected lines are cut to fit. |
| `RENOR_AUTO_RECALL_TIMEOUT_MS` | `1500` | The whole lookup (100 to 10000). Past it, the prompt goes on without context. |
| `RENOR_AUTO_RECALL_MIN_WORDS` | `3` | Prompts with fewer words are not looked up. Slash commands and steering replies ("ok", "yes go ahead") are never looked up. |
| `RENOR_AUTO_RECALL_MIN_SIMILARITY` | `0.68` on the hosted endpoint, unset elsewhere | The relevance floor: nothing is injected unless the reply's `relevance.similarity` is a number at least this high. While a floor applies, a reply with no similarity is dropped too. The server gives none when relevance judging is off, when there is no query vector, when its model has no calibrated bar (every self-hosted provider today) and while fact vectors are still warming; the hook says so once per endpoint on stderr. The default 0.68 applies only when `RENOR_AUTO_RECALL_URL` is the hosted `https://mcp.renor.cloud/mcp`. It is a cosine for that model's embeddings (`vertex:gemini-embedding-001:768`), chosen on the owner's private real-use sessions (in-sample, not reproducible here). A number between -1 and 1 sets another floor; `none`, `off`, `false` or `no` turns it off (what a self-hosted engine needs). Anything else is ignored with a line on stderr, and then no floor applies. A reply with `relevance.relevant: false` is never injected. Pre-action recall uses a floor only when this is set. |
| `RENOR_AUTO_RECALL_SCOPE` | unset (whole workspace) | A scope (`project:<slug>`) for every lookup, or `cwd` to name it after the working directory's last segment. Leave it unset unless your saved scopes are named after your folders. |
| `RENOR_RECALL_RECEIPT` | unset (off) | `1` (or `on`, `true`, `yes`): when the hook injected something, the user also sees one line in the chat (`systemMessage`), e.g. `Renor recalled 3: 2 notes (Oct 18, Oct 19), 1 fact`. Counts and dates only, never text from a memory. Nothing injected, no line. |

**Pre-action recall** (`src/recall/actionRecall.ts`, the same hook file on `PreToolUse`). Off by default. On, before a merge, release, deploy, money spend or question to the user, the hook looks up the current standing rules for that action and shows at most three, newest first with dates, without versions a later correction replaced. It uses the key, URL, timeout, scope and minimum similarity above. A failure lets the tool run.

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_ACTION_RECALL` | unset (off) | `1` (or `on`, `true`, `yes`) turns pre-action recall on. |
| `RENOR_ACTION_RECALL_MAX_TOKENS` | `250` | Most tokens shown per action (128 to 2000). |
| `RENOR_ACTION_RECALL_MODE` | `gate` | `gate`: the first such action of each kind in a session is refused once, with the rules as the reason, and the retry goes through. Claude Code shows a `PreToolUse` hook's added context only next to the tool's result, so a refusal is the only way the rules arrive before the action. `context`: never refuse; add the rules next to the result. |
| `RENOR_ACTION_RECALL_GATE_MINUTES` | `30` | How long one gate lasts per action kind and session (1 to 1440). |

**Search recall** (`src/recall/searchRecall.ts`, an experiment: a `PreToolUse` hook for `Grep`, `Glob` and `Read`; nothing in the plugin or the CLI installs it, and only the agent-tasks benchmark's `renor-pretool` arm does). Off by default. On, before a search or read, the hook asks `get_context` with the tool's own pattern or path and adds at most a few lines to the agent's context, inside the same untrusted-data boundary as automatic recall, never showing a memory twice in a session. It uses automatic recall's `RENOR_AUTO_RECALL_URL`, `_TOKEN`, `_SCOPE`, `_TIMEOUT_MS` and `_MIN_SIMILARITY` (here a floor applies only when that variable names one).

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_SEARCH_RECALL` | unset (off) | `1` (or `on`, `true`, `yes`) turns search recall on. |
| `RENOR_SEARCH_RECALL_MAX_TOKENS` | `150` | Most tokens added per search, the boundary's label included (100 to 1000). |
| `RENOR_SEARCH_RECALL_STATE_DIR` | `renor-search-recall` in the OS temp directory | Where the hook marks the memories it has shown, one file per memory and session. If it cannot write there, it shows nothing. |

## Learning log

The learning log records, for the MVP server, what each retrieval served, what each save or forget changed, and what each cite named, as ids, keyed hashes and numbers, in `<memory folder>/.memory-index/learning.sqlite`. It is off unless you turn it on, and it is separate from telemetry and from the index. The schema, the privacy rules and how to export or delete it are in [docs/learning/FEEDBACK-LOG.md](learning/FEEDBACK-LOG.md).

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_LEARNING_LOG` | off | `1` or `true` records retrievals, memory operations and cites in the learning log. Off, no file is made and nothing is recorded. A value other than 1, true, 0 or false stops the server at start. The engine's default stays off; a hosted workspace's provisioner (`engine/scripts/alpha/provision-renor-tenant.sh`, `RENOR_TENANT_LEARNING_LOG`, default 1) writes `RENOR_LEARNING_LOG=1` into its env: a new workspace at creation, an existing one on its next provisioner run. The log stays in that workspace's own folder. |
| `RENOR_LEARNING_RAW_QUERY` | off | `1` or `true` also keeps the query text of each retrieval. It needs `RENOR_LEARNING_LOG=1`, and a query the secret scanner flags is never kept. |
| `RENOR_LEARNING_RETENTION_DAYS` | `30` | Rows older than this many days are deleted, and never exported: 1 to 365. |

## Sharing with Renor (optional, off by default)

The user's choice to share anonymous labelled signals, or signals plus the text of examples for training, with Renor. Nothing is recorded for it or sent until the user picks a level with `renor-engine telemetry signals|data` (or the owner does, in the hosted dashboard). Every field sent is in [TELEMETRY.md](TELEMETRY.md); `renor-engine telemetry preview` prints exactly what would be sent.

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_SHARING` | unset | `off`, `signals` or `data`. Overrides the recorded choice for this process, and can only lower it: it never turns sharing on, because a choice needs a record of the words the user saw. Any other value stops the command at start. |
| `DO_NOT_TRACK` | unset | `1` is the same as `RENOR_SHARING=off`, and also means this process makes no request at all, even to ask Renor to delete what it holds. |
| `RENOR_SHARING_DEFAULT` | `signals` | `off` or `signals`: what applies to a memory folder where nobody has chosen (docs/TELEMETRY.md, "The default"). The engine ships with `signals` (anonymous usage numbers, with a first-run notice); `off` is an operator's way back to the older default, and nothing leaves under the default until Renor's own switch for the default is open. Never `data`. A recorded choice, an explicit off included, always wins over it, and `RENOR_SHARING` and `DO_NOT_TRACK` still lower it. Any other value stops the command at start. |
| `RENOR_SHARING_DEFAULT_STATUS_URL` | `https://mcp.renor.cloud/sharing/default-status` | Renor's switch for the default, asked before any row is read or sent under the default: sending is allowed only while it answers exactly `{"open": true}`. It must be https (http only for a loopback address, for a test). |
| `RENOR_SHARING_DEBUG` | off | `1` or `true`: debug mode. The sender builds the exact request bodies and prints them instead of sending them, and changes no state. |
| `RENOR_SHARING_DIR` | `<memory folder>/.memory-index/sharing`, else `~/.config/renor` | The folder holding the choice (`sharing.json`), the sender's state and, at `data`, the saved example texts. Owner-only. |
| `XDG_CONFIG_HOME` | `~/.config` | Where `~/.config/renor` is taken from when no memory folder and no `RENOR_SHARING_DIR` is given. |
| `XDG_STATE_HOME` | `~/.local/state` | Where the install id (`renor/install-id`) is kept; every sharing consent record is bound to it, so a record copied from another install counts as no choice. Inside `RENOR_SHARING_DIR` when that is set. |
| `RENOR_SHARING_ENDPOINT` | Renor's ingestion endpoint | Where rows are posted. It must be https (http only for a loopback address, for a test). |
| `RENOR_SHARING_STATUS_URL` | `https://mcp.renor.cloud/sharing/status` | Renor's sharing switch, read only after Renor refused a batch because sharing is closed: sending resumes when it answers exactly `{"open": true}`. It must be https (http only for a loopback address, for a test). |
| `RENOR_SHARING_INTERVAL_MIN` | `60` | How often the service looks for rows that are final and unsent: 1 to 1440 minutes. At off a tick reads one small file and does nothing else. |

## Telemetry

Off unless you give it a destination. The payload is metadata only (event names, counts, timings), never a note or a query, and a failure to send is ignored. `RENOR_TELEMETRY_DISABLED=true` switches all remote telemetry off, whatever else is set.

| Variable | Default | What it does |
| --- | --- | --- |
| `RENOR_TELEMETRY_DISABLED` | `false` | `true` switches every remote destination off. |
| `RENOR_TELEMETRY_HASH_SALT` | empty | A secret mixed into the pseudonym that stands for an instance in telemetry. |
| `RENOR_TELEMETRY_TIMEOUT_MS` | `1500` | How long one remote call may take: 250 to 5000. |
| `RENOR_POSTHOG_KEY` | unset | The PostHog project key. Unset, nothing is sent to PostHog. |
| `RENOR_POSTHOG_HOST` | `https://us.i.posthog.com` | The PostHog host. |
| `RENOR_POSTHOG_CAPTURE_URL` | `<host>/i/v0/e/` | The capture URL itself, when it differs from the host. |
| `RENOR_SENTRY_DSN` | unset | The Sentry DSN; failures only. Unset, nothing is sent to Sentry. |
| `LANGFUSE_PUBLIC_KEY` | unset | The Langfuse public key. Both Langfuse keys are needed to send traces. |
| `LANGFUSE_SECRET_KEY` | unset | The Langfuse secret key. |
| `LANGFUSE_HOST` | `https://cloud.langfuse.com` | The Langfuse host. |

## Evaluation harness

Read by the benchmark library code under `src/eval/`, which the benchmark runners use. A running engine does not need any of them.

| Variable | Default | What it does |
| --- | --- | --- |
| `HOME` | the operating system's | Where the benchmark caches and run ledger live by default, under `$HOME/.local/share/renor/`. |
| `RENOR_EVAL_CACHE` | `$HOME/.local/share/renor/eval-cache.db` | The cache of benchmark answer and judge model calls, so a repeated run costs nothing. `off` or `0` turns it off; any other value is the cache file's path. |
| `RENOR_EVAL_EMBED_CACHE` | `$HOME/.local/share/renor/embed-cache.db` | The same for embeddings, so each text is embedded once. `off` or `0` turns it off; any other value is a path. |
| `RENOR_EVAL_SNAPSHOT_DIR` | `<bench data>/index-snapshots` | Benchmark runners only: where the LongMemEval index snapshots are kept (`--snapshot-dir` wins). Outside the repository; owner-only files. |
| `RENOR_EVAL_SNAPSHOT_VAULT_BASE` | `/tmp/renor-index-vault` | Benchmark runners only: where snapshotted questions' vaults are rendered (`--snapshot-vault-base` wins). The index stores absolute paths, so this path is part of the snapshot key. |
| `RENOR_EVAL_RUN_LEDGER` | `$HOME/.local/share/renor/eval-run-ledger.jsonl` | Where each benchmark run appends one record before its first model call. It cannot be turned off. |
| `RENOR_EVAL_MAX_EMBED_TOKENS` | `80000000` | The Vertex benchmark provider's cap on input tokens, a cost guard: at least 1000. |
| `RENOR_EVAL_MODEL` | `gemini-embedding-001` | The Vertex embedding model of the benchmark provider. The HTTP server uses it as a fallback for `MVP_EMBEDDING_MODEL`. |
| `RENOR_EVAL_EMBEDDING_DIMS` | `768` | Its vector size: 768, 1536 or 3072. |
| `RENOR_EVAL_VERTEX_KEY_FILE` | unset | Its service-account key file. Falls back to `GOOGLE_APPLICATION_CREDENTIALS`. |
| `RENOR_EVAL_VERTEX_PROJECT` | unset | Its Google Cloud project. Required for Vertex. |
| `RENOR_EVAL_VERTEX_LOCATION` | unset | Its region. Required for Vertex. |
| `JUDGE_API_KEY` | unset | The prefix of the benchmark judge's key pool: `JUDGE_API_KEY_1` to `JUDGE_API_KEY_10`, then `OLLAMA_MAX_KEY_1` and `OLLAMA_API_KEY_1` the same way. |
| `RENOR_STRIP_EXCERPT_META` | unset | A benchmark-client setting. The engine reads it only to record it in a run's manifest; it changes no search result. |
