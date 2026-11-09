# Sharing with Renor: telemetry and training data, your choice

Renor can learn from how its memory is used. There are three levels, and you choose in plain words:

- **off**: nothing is recorded for sharing and nothing is sent.
- **anonymous** (the default): usage numbers only. Never your memory text, queries, names or paths.
- **everything**: the numbers plus the text of your memories and queries, to help train Renor. Only ever on after one explicit yes.

**Anonymous is on until you turn it off**, with a notice the first time (below). **Everything is never on unless you say yes.** You can see,
preview, change and withdraw every level, and every field is listed on this page.

These are the command line's own words and facts. They are not the privacy policy; the public wording (policy, terms, website) is the
owner's and a lawyer's to approve, and is not part of this file.

## The three levels

| Level (in plain words) | Engine name | What leaves your machine | How to choose it |
| --- | --- | --- | --- |
| off | `off` | Nothing. Nothing new is recorded for sharing. | tell your agent, `renor-engine telemetry off`, or `DO_NOT_TRACK=1` |
| anonymous (the default) | `signals` | Anonymous labelled numbers, worked out **inside your own data folder** from the learning log. No text, no queries, no memory ids, no keys, no names, no paths. | the default. To come back to it after turning it off: `renor-engine telemetry signals` at a terminal (or your client's own question, if it can ask); your agent can only lower the level |
| everything | `data` | The signals, plus the **text of the examples**: the query behind a retrieval, the text of the memories it returned, and the statements you saved. Renor may use that text to train and evaluate its own models. | at a terminal only: `renor setup` (one question, a yes) or `renor-engine telemetry data`; your agent cannot turn this on |

A choice above `off` needs your confirmation that you are 18 or older (the default does not: it holds only numbers). It is recorded in one small
file with the level, the time, the id of the words you saw (`engine-cli-2026-10-29` for the command line, `setup-2026-10-28` for `renor setup`;
the dashboard sends its own) and who set it (`cli`, `setup`, `agent`, `dashboard`). One record per install (self-hosted), or per workspace
(hosted). Choosing a level never changes your plan, quota or features.

## How you are told, and how you choose

- **The first-run notice.** One line, shown once per install and recorded in `sharing-notice.json` next to the install's own record
  (`~/.config/renor`, or `RENOR_SHARING_DIR`): "Renor sends anonymous usage numbers (never text, names or paths) to improve Renor for everyone. Turn them
  off any time: tell your agent, run `renor-engine telemetry off`, or set DO_NOT_TRACK=1. Details: this page." It is shown only while the default is
  what is in force (not after any choice, not under `DO_NOT_TRACK=1` or `RENOR_SHARING=off`, not on a hosted workspace, whose dashboard says its own
  words), on each place a person can read it, and each place is recorded on its own, because whoever starts the server is often not whoever talks
  to the agent: the HTTP service's start-up (`terminal`: printed before the sender starts, and recorded only after it printed), the first tool reply the
  install gives an agent over HTTP or stdio, which the agent is told to relay (`agent`), and `renor setup`, which shows it with its question and records both. Until a
  notice is recorded on any surface, the sender sends nothing under the default. **A service you run in the background (systemd, a container) tells
  you in its log**: that log line is the notice for a service nobody is watching, and the numbers can start at the service's next tick. Whether you
  read it is up to you; to be sure, set `DO_NOT_TRACK=1` in the service's environment before its first start. The `agent` notice is recorded when the
  engine adds it to the first tool reply, not when your agent has said it to you.
- **`renor setup`** asks one question: "Also share your memory text to help train Renor? [y/N]". Saying yes confirms you are 18 or older and records
  **everything** for this install; it starts at once for every memory folder on this computer that has no record of its own (below). No writes no
  consent record: the anonymous default stays, and setup only remembers that it asked. The question is asked only while Renor's gate is open.
- **Your agent** can read the level and **lower** it with the `sharing_level` tool when you say so in plain words ("what do you share?", "turn sharing
  off", "stop sharing my memory text"). Lowering takes effect at once. It can **never raise** it: no argument of the agent's call counts as your yes.
  - **Anonymous numbers again after you turned them off:** you answer a question the engine puts to you itself, through your MCP client, when the client
    supports it (MCP elicitation: "Do you want to share anonymous usage numbers with Renor again?", with your 18+ confirmation). The record names the
    client application that relayed your answer (`client`: its declared name and version) and says `source: prompt`. A client that cannot ask changes
    nothing, and the agent tells you to run `renor-engine telemetry signals`.
  - **Everything (your memory text):** only at a terminal, with `renor setup` or `renor-engine telemetry data`. A client application can answer a question
    on its own, so its answer is never taken for this one: the tool changes nothing and the agent tells you the command. A record that says `data` was
    chosen by an agent or by a client's prompt is read as unreadable, so off.
  - On a hosted workspace the owner changes the level in Settings and the tool only reads.
- **A record counts only on the install that wrote it.** Each consent record carries the hash of the install's random id (`install`), and the id is kept
  in the state folder (`$XDG_STATE_HOME/renor/install-id`, else `~/.local/state/renor/install-id`; inside `RENOR_SHARING_DIR` when that is set), not in
  the config folder that dotfile syncs carry. A memory folder synced or restored on another computer, a config folder copied there, or a `sharing.json`
  pasted from someone else holds a record made on another install: it counts as no choice, so the memory text does not turn on because of it and the
  anonymous default applies (`renor-engine telemetry status` says so). An `off` is honoured wherever it came from. A hosted workspace's record is the
  dashboard's and is not bound to a machine.
- **What this does not stop.** An agent that runs as you with a shell can write the record itself or run `renor-engine telemetry data --yes`, and no
  local check can tell it from you: it can read the same files. What is protected is an agent saying yes **through the tool** (or a copied file saying it
  for you). A yes that must come from a person, against code running as that person, would need a channel that code cannot reach, such as signing in
  to the dashboard. Keep that in mind when you give an agent a shell.

## The default (anonymous usage numbers)

The owner's decision (2026-10-25, confirmed 2026-10-28): anonymous usage numbers on by default, with a notice and a switch; text for training never on
by default.

- The self-hosted engine's default is a constant, `signals` (`src/sharing/state.ts`, `SHIPPED_DEFAULT_LEVEL`), and **nothing leaves until the first-run
  notice has been shown and recorded, and Renor's own switch for the default is open** (below). A **hosted** engine (`MVP_GATEWAY_SECRET` set) with no
  dashboard choice reads the same default, `signals` (owner approval 2026-10-28, production go 2026-11-01); it shows no terminal notice, because the dashboard
  panel shows the default. `RENOR_SHARING_DEFAULT=off` is the explicit opt-out (`signals` is the same as unset), `DO_NOT_TRACK` and `RENOR_SHARING=off` still lower it, a
  hosted owner's dashboard choice wins over it, and nothing leaves while Renor's switches (the gateway's `/sharing/status` and `/sharing/default-status`, and the
  database's `learning_default`) are closed. `RENOR_SHARING_DEFAULT=off|signals` replaces the default for one process (an operator's explicit setting). `data` is never a default.
- A memory folder in which nobody has chosen, on an install where nobody has chosen, is at `signals` ("the default"), and `status` and the
  service's start-up line say so. A **choice always wins**: any consent file, an explicit `off` included, is the choice, and a file that
  cannot be read is a choice nobody can read, so it is `off`. `renor-engine telemetry off` and an agent's off record the off even when nothing was on,
  so the default does not turn it back on. (An `off` typed on an install that had never chosen, before the default was on, left no
  record and cannot be told from never having chosen.)
- `DO_NOT_TRACK=1` and `RENOR_SHARING=off` are off, in one step, for that process, and `DO_NOT_TRACK=1` also means that process makes no request at all. `RENOR_SHARING=off`
  stops recording and sending rows, but a deletion you already asked for (`renor-engine telemetry off` owes one) is still sent.
- **An install's answer is followed by a memory folder that has no record of its own** (self-hosted only): what `renor setup` recorded for the install
  (a yes is everything) counts as the choice of every memory folder on this computer that has not been given its own, and is sent as a choice (a consent
  record, no `default` field), without waiting for Renor's switch for the default. A folder with a record of its own keeps it, and the stricter of the
  two is in force, so an install-level No still turns every folder off. A hosted workspace never follows an answer given on the machine that hosts it.
- Under the default the sender asks Renor's switch (`GET /sharing/default-status`, one bit) **before it reads a row and again before every
  batch it posts**, and any error counts as closed. A run can post several batches, so once the switch answers closed no further batch is
  posted; what was not sent stays unsent and goes out when it is open again. The gateway caches the answer for up to 30 seconds, so a
  sender can still read "open" for up to 30 seconds after the operator closes it; the endpoint itself refuses a default batch from the
  moment the database says closed. A batch under the default says `default: true`, carries no consent record (there was no choice), is
  always `signals`, and is the same rows, field for field, as a chosen `signals`.
- What an explicit choice sends from a self-hosted install is exactly what it sent before: no `default` field, the consent record kept (a test compares the keys).
  A **hosted workspace** sends up to two streams whatever its owner chose (owner's final design, 2026-10-27): its usage numbers always as the default's shape (`default: true`,
  signals, the install's own id, **never tied to the workspace**), unless the owner explicitly chose Off; and, only while the owner's switch for memory text is on, the text as a
  second contributor (`data`, no `default` field) that Renor ties to the workspace so the switch can be held. Turning that switch off deletes what the second contributor sent
  and the numbers carry on; an explicit Off stops both and deletes both. The two streams never carry the same row: **while the text switch is on the numbers pause**, the text stream
  carries only rows created after the switch went on (its watermarks start at that time, never at 0), and the numbers resume from the switch-off time. The install secret is
  **rotated** every time the switch goes on or off, so the numbers' id after a tied period cannot be matched to the one before it, and also at the first send of every month (below,
  "A new id every month"); the old secrets stay in the workspace's own sharing state only, so that Renor can still be asked to delete what they sent (`off` / `delete` ask for every
  id the workspace ever used).
- Turning it off is `renor-engine telemetry off`, your agent, or the dashboard's switch: it stops at once, deletes the example texts and asks Renor to
  delete what it holds under this install's secret, as `off` always did.

### What counts as anonymous

The default sends the `signals` rows and nothing else. Three rules keep them anonymous as they grow (owner decision, 2026-11-08): **coarse
values only**, **a new id every month**, and **the 3-people rule**. Each is code, and each has a test.

**Coarse values only.** No field, alone or together with the others, may be fine enough to single out a person. Every field in a `signals`
row is one of:

1. a yes/no;
2. a value from a closed list (`tool`, `kind`, a bucket, `retrieval`, the ranker, the lane, the install age, the embedding model);
3. a time, at most to the hour (`2026-10-21T14`, UTC), or a day;
4. a version, at most `major.minor` (`1.4`: never a patch number, a build or a commit), for the engine and for the MCP client;
5. a bucketed number: a count or a position capped at 200, a size class (a power of two, capped at 65,536), a score rounded to two places,
   Node's major version capped at 99;
6. the one kind of identifier: a random id made on your machine that says nothing but itself, the usage rows' install id (replaced every
   month, with the contributor id) and a funnel row's session id (one per process).

The embedding model is named only when it is a public model on Renor's list (for example `vertex:gemini-embedding-001:768`); any other model (a
file on your disk, a fine-tune, a private name) is sent as null, because a rare name could point at you. A lane or ranker that is not on the list
is sent as `other`, and so is a tool name or a failure class that is not on the engine's own list. The commit of the running build is no
longer sent at all. `coarseViolations()` in `src/sharing/fields.ts` checks the field
table itself against these five shapes, and a test holds it empty, so a new field that breaks the rule fails before it can ship. The ingest
function applies the same rule to what older engines still send (it drops the commit, rounds the score, and so on) before anything is stored.

And **no** field is, or is made from, a workspace, a person, an account, an agent, a session, a memory, a note path, a heading, a subject, a
title, a key, or any text of a memory or a query. `tests/sharing/default.test.ts` holds this: it lists the only patterned fields (the hours),
probes each pattern with the characters of a path, an address and a name, refuses a field named for any of those, and checks that the text
fields exist at `data` only.

**A new id every month.** The id your rows are stored under changes at the first send of each calendar month (UTC). A self-hosted install
asks Renor for a new credential then; a hosted workspace makes a new secret. Renor cannot tell that October's id and November's id are the same
install, so no id builds a profile longer than a month. Only the usage numbers rotate: a hosted workspace's text for training is tied to the
workspace on purpose (so its owner's switch can be held), and while it is on the numbers are paused anyway.

- **The old ids stay on your machine (or in your workspace's own folder), and only there**, in `sharing-state.json`, for one purpose: so that
  `off` and `delete` can ask Renor to delete the rows sent under every one of them. They are never sent except inside such a deletion request.
  Because Renor keeps shared rows with no fixed period (below), an old id is kept **for as long as its rows may exist**: until `off` or `delete`
  has had every one of them deleted, after which they are all removed with the rest of the file. Nothing expires them by age (there is a
  safety cap of 1,200, a hundred years of months).
- **Registrations:** a self-hosted install that sends in a month makes **one extra credential request that month** (twelve a year), and none in a
  month it sends nothing. Renor issues at most 20 credentials a day per network address and 500 a day in all, and stores at most 20 new
  contributors a day per address. Because every install rotates at its first send of the month, the first days of a month are when those limits
  can be reached: an install that is refused waits (its rows stay unsent, nothing is lost) and tries again at its next hourly send, so past 500
  active installs, or 20 behind one address, some installs' rows arrive a day or more later. The same per-address limit applies to hosted
  workspaces, which send from Renor's own servers.
- The usage rows' random install id (`sharing-usage.json`) is replaced at the same moment, so it never links two months either. What that file
  has counted is kept: the install row is not sent again (an install is not a new install every month) and days not yet sent are not lost.
- An id that has not sent anything yet is not replaced (there is nothing to separate), and debug mode never rotates.

**Install age.** Every row says how long the install has existed, as one of four ranges: `<1w` (under a week), `1-4w`, `1-3m` (four weeks to
about three months) or `3m+`, as of the row's hour. The opt-out count is the one row without it: it carries no identifier on purpose, and an
age would only narrow who sent it. It comes from the day sharing first ran on this install, kept in `sharing-state.json` next
to the id (the day itself is never sent). It lets Renor tell new installs from settled ones without an id that lasts. Turning sharing `off` or
`delete` removes it with the rest of the state, so after that the age starts again from `<1w`. Rows from an engine older than this field arrive
with it as null.

**The 3-people rule.** Nothing Renor computes from shared rows is shown or used unless at least **3 distinct contributors stand behind it within
one month**. Since an id lasts one month, a contributor is an install-month: one install active for three months is three ids, and counted across
months it would pass for three people. So each reader of shared rows (the weekly scoreboard, `scripts/eval/real-scoreboard.ts`, and the ranking
fit, `scripts/eval/ablation-loop/ranking-fit.ts`) first drops every month in which its rows come from fewer than 3 ids, then withholds any number
whose remaining rows still come from fewer than 3. The ranking fit refuses a threshold below 3, and its "enough people" gate counts the most
distinct ids in any one month (a floor on distinct installs), never the ids summed over months. The rule lives in `src/sharing/crowd.ts`. Within a
month an install can, rarely, have two ids (after a deletion and a fresh start, a refused credential, or a hosted owner's text switch), so the
rule is a floor, not a proof.

What this does not claim. The hour is the coarsest time sent, but a small number of installs with a known working pattern can still make one
guessable, within a month, by someone who already knows that pattern; and the install age narrows a young install's first day to a week.
That is why the default is a switch and not a rule, and why the words the owner approves, not this page, say what is anonymous to a reader.
Renor never ties an id to a workspace or a person, whatever the owner chooses in the dashboard (an Off makes the engine stop and ask Renor to
delete by each id, so the server cannot refuse an install it does not know to be the workspace's).

"Anonymous" here therefore means: the fields hold nothing that names anyone, every value is coarse, and rows can be linked to each other for
at most one calendar month. Within that month they share one id, so by itself the data is pseudonymous for that month, not anonymous. The
dashboard's words therefore say "usage numbers", describe the identifier, and do not say "anonymous".

### How an install proves itself to Renor

Before it first sends, an install asks Renor for a credential: a request with no body but the protocol and the action (`register`), no identifier and no data. Renor signs a
random id and answers with it; the install keeps it in the sharing folder and sends it as its bearer from then on, and the install id Renor keeps is the SHA-256 of it. Without
a credential Renor issued (an invented or copied one), a send is refused before it is read. A request for a credential is made only by an install that is about to send: not at
`off`, not under `DO_NOT_TRACK=1`, not in debug mode, not while Renor's switch for the default is closed, and never by a hosted workspace (it proves itself with a keyed proof
derived from the fleet's gateway secret). A credential Renor refuses is dropped and asked for again. `docs/SHARING-INGEST.md`, "Authentication", says what this does and does not prove.

## Commands

```
renor-engine telemetry status            the choice in force, what is held, where it would go (reads only)
renor-engine telemetry signals           anonymous (usage numbers only): show the words, ask, record the choice
renor-engine telemetry data              everything (the numbers and your memory text, for training): the same
renor-engine telemetry off               record off, stop at once, ask Renor to delete what it holds
renor-engine telemetry delete [--local]  ask Renor to delete what it holds; --local also empties your learning log
renor-engine telemetry preview [level]   debug mode: print exactly what would be sent (for a level you have not chosen yet too)
renor-engine telemetry send              share what is final and unsent now (the HTTP service does this on a timer)
renor-engine telemetry fields [level]    every field sent at each level
```

`signals` and `data` ask on a terminal; without one, add `--yes` once you have read the words they print. The commands read the learning log
of the memory folder named by `MVP_MEMORY_DIR` (or `--memory-dir`) and keep the choice in `<memory folder>/.memory-index/sharing`
(`--dir` or `RENOR_SHARING_DIR` choose another folder; with neither, `~/.config/renor`).

The install's own choice (the one in `~/.config/renor`, which `npx renor setup` writes) is the choice of every memory folder on this install
that has no record of its own, and it also limits every memory folder's choice: the stricter of the two is in force. When the install's choice is off, the
service turns any memory folder's choice that is still on to off at its next sharing check, the same way `renor-engine telemetry off`
does (it stops, deletes the example texts and asks Renor to delete what was sent).

### Overrides and debug mode

- `RENOR_SHARING=off|signals|data` overrides the recorded choice **for that process, and can only lower it**. It cannot turn sharing on:
  a choice needs a record of the words you saw. `DO_NOT_TRACK=1` is the same as `RENOR_SHARING=off`, and also means that process makes no
  request at all.
- `RENOR_SHARING_DEBUG=1` (or `renor-engine telemetry preview`) is debug mode: the sender builds the exact request bodies, prints them, sends
  nothing and changes nothing. What debug prints is what a real run sends, byte for byte (a test compares them).

## Where the rows come from

The learning log (`RENOR_LEARNING_LOG`, [learning/FEEDBACK-LOG.md](learning/FEEDBACK-LOG.md)) records, as keyed hashes and numbers, what each
retrieval served, what each save changed and what each cite named. Choosing `signals` or `data` turns that recording on (it is read at every
call, so there is no restart); choosing `off` turns it off again, unless you also set `RENOR_LEARNING_LOG=1` yourself. The join that gives a
returned memory its label ("opened", "cited", "updated", "retired") is done **locally**, and only the finished rows can leave. A row is sent only
when its label is final: 24 hours after the event. Times are rounded to the hour.

The learning log is written by the HTTP service (`npm run mvp`, and the hosted service) and by `renor-engine mcp` over stdio, the self-hosted
path most people use. The stdio server keeps it in the notes folder, at `$VAULT_PATH/.memory-index/learning.sqlite` (the indexer skips that
folder), and keeps its sharing choice beside it in `$VAULT_PATH/.memory-index/sharing`; the install's own choice in `~/.config/renor` (what
`renor-engine telemetry off` writes when it is given no memory folder) limits it, so that command turns the stdio server off too. It records
the same rows from three of its tools, named in the rows by the tool that does the same thing on the service: `search` as `search_memory`,
`remember_fact` as `save_memory` and `note` as `remember_note`. Its other tools (`keyword`, `facts`, `entity`, `evidence`, `status`, the hive
tools) are not recorded. It lists the `sharing_level` tool, so you can tell your agent to turn sharing off.

How the stdio server sends:

- **After the notice.** The first successful tool reply carries the first-run notice (the `agent` surface); nothing is sent under the default
  until a notice has been recorded. The stdio server prints no `terminal` notice: its stderr is read by the client application, not by you.
- **Never in the way of a tool call.** A call writes its row to the local log after its reply is built, and nothing else. Sending runs on
  its own timer (first about 30 seconds after start, then every `RENOR_SHARING_INTERVAL_MIN`, default an hour) and never keeps the process
  alive. When the client closes the server's input (a clean exit), the server tries one last send with a 3-second deadline and then drops
  any request still open.
- **Offline, nothing happens.** A failed request is dropped without a word; the rows stay in the log (kept for `RENOR_LEARNING_RETENTION_DAYS`,
  30 days by default) and the next run sends what is final. A row is final 24 hours after its event, so a session's rows go out with a
  later session.
- **`DO_NOT_TRACK=1` or `RENOR_SHARING=off` turns all of it off for that process**: no learning log is made, no notice is shown, no
  `sharing_level` tool is listed and no request is made. `renor-engine telemetry off` turns it off for good.

`renor-engine telemetry status`, `preview` and `send` read the stdio server's log when given its folder:
`renor-engine telemetry preview --memory-dir "$VAULT_PATH"`.

The **usage rows** (`install/1`, `heartbeat/1`, `funnel/1`) come from counters, not from the learning log. Both transports keep them: a
tool call adds one to an in-memory counter (its tool, its latency range, and on a failure its error class) and nothing else, so it never
waits on a file or the network. The counters are written in the background, about once a minute and when the process exits, to
`sharing-usage.json` in the sharing folder (the install's folder for `renor-engine mcp`, the workspace's for the HTTP service), and only at
a level above `off`, and, under the default, only once the first-run notice was shown (the file and its install id are not made before
then): at `off` nothing is written and what was counted is dropped. The sender reads that file and sends its rows under
exactly the rules above: nothing before the first-run notice, nothing under `DO_NOT_TRACK=1` or `RENOR_SHARING=off`, nothing while Renor's
switch for the default is closed. A heartbeat is sent once its day (UTC) is over. `off` and `delete` remove the file, and with it the
install id: a later install row carries a new one.

At `data`, the query and the text of what a reply served or a save wrote are also kept, in `sharing-examples.sqlite` in the sharing folder,
under the learning log's own keyed hashes, until they are sent. A text the secret scanner flags is never kept, so that example is sent
without text. A text is cut at 2,000 characters. Leaving `data` (to `signals` or `off`), or `delete`, removes that file at once.

## Every field sent

Each request is `{ protocol, action, batch_id, level, wording, rows, consent }` (`action` is `batch`), or `{ protocol, action: "delete" }` to ask
Renor to delete what it holds. `consent` is your install's record of the choice, `{ version, level, changed_at, wording, adult }`: the level
you chose, when, the wording you saw and your 18-or-older confirmation. Renor refuses a self-hosted batch without it and keeps it with the
rows as the evidence of your choice. A hosted workspace's batch has no `consent`: the dashboard's record is the evidence. A row is one of six kinds; each carries `kind`, which names its version. The names below are exactly the
fields; the engine checks every row against this table before a request is made and the endpoint refuses a row with any other field.

### Level `signals`

One row per retrieval (`retrieval-labelled/1`), with one entry per returned memory in `candidates`:

| Field | Meaning |
| --- | --- |
| `retrieval-labelled/1.kind` | the row kind and version |
| `retrieval-labelled/1.hour` | the hour it happened, UTC (`2026-10-21T14`) |
| `retrieval-labelled/1.install_age` | how long this install had existed then: `<1w`, `1-4w`, `1-3m`, `3m+` (null from an older engine) |
| `retrieval-labelled/1.tool` | `get_context`, `search_memory` or `retrieve_memory` |
| `retrieval-labelled/1.ranker` | the ranking procedure: `baseline` (the shipped one) or `other` |
| `retrieval-labelled/1.model` | the embedding model, when it is a public model on Renor's list (`provider:model:dimensions`), else null |
| `retrieval-labelled/1.retrieval` | the reply's retrieval mode (`facts`, `hybrid`, `semantic`, `keyword`), or null |
| `retrieval-labelled/1.served` | how many memories the reply held, capped at 200 |
| `retrieval-labelled/1.reply_tokens_bucket` | the reply's size class: the next power of two above its token count, capped at 65,536 |
| `retrieval-labelled/1.relevant` | the engine's own verdict that something matched, or null |
| `retrieval-labelled/1.truncated` | whether the reply was cut to its budget, or null |
| `retrieval-labelled/1.candidates.rank` | position in the reply, capped at 200 |
| `retrieval-labelled/1.candidates.kind` | `fact`, `note` or `unkeyed` |
| `retrieval-labelled/1.candidates.lane` | which lane matched, from a closed list (`fact`, `fts`, `semantic`, `keyword`, `graph`, ...; anything else `other`), or null, also when several lanes matched together (`semantic+content+recency`) |
| `retrieval-labelled/1.candidates.score` | the reply's score, 2 decimals (within ±100), or null |
| `retrieval-labelled/1.candidates.matched` | whether the reply marked it as matched, or null |
| `retrieval-labelled/1.candidates.current` | for a fact read, whether the value was current, or null |
| `retrieval-labelled/1.candidates.opened` | within 24 hours, your AI opened this memory (`read_memory`); null when it cannot be told |
| `retrieval-labelled/1.candidates.cited` | within 24 hours, a save cited it |
| `retrieval-labelled/1.candidates.updated` | within 24 hours, it was replaced by a newer value |
| `retrieval-labelled/1.candidates.retired` | within 24 hours, it was retired |
| `retrieval-labelled/1.candidates.delay_bucket` | how long until the first of those happened: `<1m`, `<10m`, `<1h`, `<1d`, `>=1d`, or null |

One row per save (`save-outcome/1`):

| Field | Meaning |
| --- | --- |
| `save-outcome/1.kind` | the row kind and version |
| `save-outcome/1.hour` | the hour of the save, UTC |
| `save-outcome/1.install_age` | how long this install had existed then (the same four ranges) |
| `save-outcome/1.tool` | `remember`, `save_memory` or `remember_note` |
| `save-outcome/1.op` | `create` or `supersede` |
| `save-outcome/1.item` | `fact`, `note`, `event` or `unkeyed` |
| `save-outcome/1.has_cites` | whether the save named memories it builds on |
| `save-outcome/1.reads_bucket` | how many later reads served it within 24 hours: `0`, `1`, `2-3`, `4-7`, `8+` |
| `save-outcome/1.opened` | it was opened within 24 hours |
| `save-outcome/1.cited` | it was cited within 24 hours |
| `save-outcome/1.superseded` | it was replaced within 24 hours |
| `save-outcome/1.retired` | it was retired within 24 hours |

One row per finished session (`session-aggregate/1`):

| Field | Meaning |
| --- | --- |
| `session-aggregate/1.kind` | the row kind and version |
| `session-aggregate/1.hour` | the hour the session began, UTC |
| `session-aggregate/1.install_age` | how long this install had existed then (the same four ranges) |
| `session-aggregate/1.length_bucket` | `<1m`, `<10m`, `<1h`, `<6h`, `>=6h` |
| `session-aggregate/1.reads_bucket` | reads in the session, as a count bucket |
| `session-aggregate/1.saves_bucket` | saves in the session |
| `session-aggregate/1.empty_reads_bucket` | reads that returned nothing |
| `session-aggregate/1.first_call` | the first tool the session called (a read or save tool, else `other`) |

Count buckets, used by every `_bucket` field of the usage rows below: `0`, `1-9`, `10-99`, `100-999`, `1000-9999`, `10000+`. A count is
never sent exactly.

Once per install (`install/1`), at the first send after the first-run notice:

| Field | Meaning |
| --- | --- |
| `install/1.kind` | the row kind and version |
| `install/1.hour` | the hour the install was first counted, UTC |
| `install/1.install_age` | how long this install had existed then (the same four ranges; almost always `<1w`) |
| `install/1.install_id` | a random id (16 random bytes, hex), made on this machine and kept in `sharing-usage.json`; never derived from the hostname, a network address, the user, a path or anything else; **replaced with a new random id every month**, with the contributor id |
| `install/1.version` | the engine version, major.minor only (`1.4`), or null when unknown |
| `install/1.node_major` | the Node.js major version (`22`), capped at 99 |
| `install/1.os` | `linux`, `darwin`, `win32`, `freebsd`, `openbsd` or `other` |
| `install/1.arch` | `x64`, `arm64`, `arm`, `ia32` or `other` |
| `install/1.ci` | whether a standard CI variable is set (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TRAVIS`, `JENKINS_URL`, `TF_BUILD`, ...); only true or false |
| `install/1.transport` | `stdio` (`renor-engine mcp`) or `http` (the service) |

Once per active day (`heartbeat/1`), after the day is over:

| Field | Meaning |
| --- | --- |
| `heartbeat/1.kind` | the row kind and version |
| `heartbeat/1.hour` | the day it covers, as its first hour, UTC (`2026-11-06T00`) |
| `heartbeat/1.install_age` | how long this install had existed that day (the same four ranges) |
| `heartbeat/1.install_id` | the install id above (this month's) |
| `heartbeat/1.version` | as in `install/1` |
| `heartbeat/1.node_major` | as in `install/1` |
| `heartbeat/1.os` | as in `install/1` |
| `heartbeat/1.arch` | as in `install/1` |
| `heartbeat/1.ci` | as in `install/1` |
| `heartbeat/1.transport` | as in `install/1` |
| `heartbeat/1.client_name` | the MCP client, from its own `initialize` (`clientInfo.name`), as one of a closed list: `claude-code`, `claude-ai`, `claude-desktop`, `chatgpt`, `openai-mcp`, `codex`, `cursor`, `windsurf`, `vscode`, `visual-studio-code`, `zed`, `cline`, `roo-code`, `continue`, `goose`, `gemini-cli`, `opencode`, `warp`, `jetbrains`, `lm-studio`, `librechat`, `mcp-inspector`, `hermes`, `renor`; any other name is sent as `other`, never as itself; the last client seen that day, when several connected; null when no client declared one |
| `heartbeat/1.client_version` | the client's `clientInfo.version` when it is shaped like a version, cut to major.minor (`1.0.42` is sent as `1.0`, `v2.3` as `2.3`), else null |
| `heartbeat/1.embedding` | the embedding mode: `none`, `local`, `openai`, `vertex` or `other`; null when not known |
| `heartbeat/1.model` | the embedding model, when it is a public model on Renor's list (`provider:model:dims`), else null |
| `heartbeat/1.reranker` | `off`, or `query-words` when `RENOR_RERANK_TOP_N` is on; null when not known |
| `heartbeat/1.index` | `keyword` (full text only) or `hybrid` (full text and vectors); null when not known |
| `heartbeat/1.memories_bucket` | notes plus current facts in the store, as a count bucket, or null |
| `heartbeat/1.notes_bucket` | notes in the store, as a count bucket, or null |
| `heartbeat/1.facts_bucket` | current facts in the store, as a count bucket, or null |
| `heartbeat/1.tools.tool` | a tool's name, from the closed list of the engine's own tools; any other is `other` (at most 64 entries a day) |
| `heartbeat/1.tools.calls_bucket` | that tool's calls that day |
| `heartbeat/1.tools.lt50ms_bucket` | its calls that took under 50 ms |
| `heartbeat/1.tools.lt200ms_bucket` | 50 ms to under 200 ms |
| `heartbeat/1.tools.lt1s_bucket` | 200 ms to under 1 s |
| `heartbeat/1.tools.lt5s_bucket` | 1 s to under 5 s |
| `heartbeat/1.tools.ge5s_bucket` | 5 s or more |
| `heartbeat/1.errors.class` | a failure's class, from a closed list (JavaScript's and the engine's error classes, SQLite's and Node's error codes, a few refusal codes such as `invalid_argument`); any other is `other`; never its message, a path or a stack. At most 16 a day |
| `heartbeat/1.errors.count_bucket` | how often that class happened that day |

One row per funnel step a process reached (`funnel/1`), each step at most once per process:

| Field | Meaning |
| --- | --- |
| `funnel/1.kind` | the row kind and version |
| `funnel/1.hour` | the hour the step was reached, UTC |
| `funnel/1.install_age` | how long this install had existed then (the same four ranges) |
| `funnel/1.session` | a random id made when the process started (16 random bytes, hex) and never stored anywhere else; it is not the install id |
| `funnel/1.step` | `installed` (the install's usage file was made), `notice_shown` (the first-run notice was shown), `first_save`, `first_recall`, `first_recall_used` (after a recall, a memory was opened with `read_memory` or a save cited what it built on) |

**The opt-out count (`opt-out/1`).** When sharing is turned off (`renor-engine telemetry off`, an agent's sharing tool, the dashboard,
`renor setup`, or `RENOR_SHARING=off` on an install that had been sharing), Renor is told once that one install turned it off. It is its
own request, `{ protocol, action: "opt-out", row }`, sent with **no bearer**, and the row carries **no install id, no session id and no
other identifier**, so it cannot be joined to anything sent before it. Renor keeps only a counter per day and `via`. It is never sent
under `DO_NOT_TRACK=1`, and an install that was never sharing sends none.

| Field | Meaning |
| --- | --- |
| `opt-out/1.kind` | the row kind and version |
| `opt-out/1.day` | the day it was turned off, UTC (`2026-11-06`) |
| `opt-out/1.via` | `command`, `agent`, `env`, `setup`, `dashboard` or `other` |

**Added by Renor when a row arrives (`country`).** Your install does not send it: Renor's endpoint adds it to every row it stores, from the
request it came in on, and refuses a row that already carries it.

| Field | Meaning |
| --- | --- |
| `country` | the country the request came from, as its 2-letter ISO code (`BR`, `US`), read from the hosting platform's geo header; null when the header is missing, is not exactly two letters, or is `XX` (unknown). Your network address is never stored, not even hashed into a row: it is used only as a rate-limit counter key, an HMAC under a key that changes every day, dropped after two days |

**Never sent at any level:** the keyed hashes in your learning log, memory ids, subjects, predicates, note paths, headings, scope names,
agent names, your session ids, tool arguments or replies, error messages, the commit of your build, the day you installed, or an address or
name of yours. The links between rows are one random secret per install **per calendar month**, kept in your sharing folder (Renor sees only
its SHA-256, so it can find and delete your rows when you ask; your folder keeps the earlier months' secrets for exactly that), and the random
install id of the usage rows, kept next to it and replaced with it every month.

### Level `data` (everything above, plus)

| Field | Meaning |
| --- | --- |
| `retrieval-labelled/1.query` | the text of the query behind the retrieval, or null if none was kept |
| `retrieval-labelled/1.candidates.text` | the text the reply served for that memory, or null if none was kept |
| `save-outcome/1.text` | the statement that was saved, or null if none was kept |

Memories can hold information about you and about other people. A text that looks like a secret (a key, a password, a token) is left out;
no scanner is perfect, so choose `data` only if you accept that.

## What happens to what you send

- The endpoint is a Renor function separate from product analytics, PostHog, Sentry and Langfuse; nothing here goes to any of them. It
  authenticates each request (an install with the credential Renor issued it, a hosted workspace with a keyed proof), limits how often an install may post, and stores the rows apart from your account. It stores no network address: an address is used only as a rate-limit counter key, an HMAC under a key that changes every day, and the counters are dropped after two days.
- **Retention (the owner's decision, 2026-10-27):** what is shared is kept as long as it helps improve Renor, with no fixed period. The database's daily purge expires no rows
  (it drops only request counters, kept two days). Shared data is deleted on request (`off` / `delete`, or an email to privacy@renor.cloud), when the owner switches the text for
  training off (the text goes, the numbers stay), and, for a hosted workspace whose owner explicitly chose Off earlier, that Off holds: its numbers are never sent again, even if the
  owner later toggles the text switch on and off.
- **Withdrawal and deletion:** `off` and `delete` ask the endpoint to delete everything it holds for your install, at once, under every monthly
  id it has used. If `DO_NOT_TRACK=1`
  is set, nothing at all may be sent: `off` deletes the local example texts, records here that the deletion is owed (keeping the install's
  secret it needs), says so, and the first run without `DO_NOT_TRACK=1` sends it and then removes the rest. Otherwise,
  if the endpoint cannot be reached, the request is kept and retried. Rows Renor refuses for good are never sent again: when it says sharing is
  closed, the sender sends nothing until Renor's status says it is open again; when it says the workspace's choice is off, off is applied here
  too; when it refuses the consent record, nothing is sent until you choose a level again. A deletion is never held back. Backups can hold a copy for up to 7 more days. A ranking setting already fitted from rows is not
  recalled; the next fit leaves yours out.
- **The default's switch.** Renor's `learning_default` (an operator setting, closed until the owner approves the wording) is asked by the
  sender before it sends under the default, and again by the endpoint, which refuses a default batch with `default_closed` while it is
  closed. Closing it stops every default sender at its next question (before its next batch; the gateway's cache makes that up to 30
  seconds), with no release.
- **Hosted workspaces:** the owner chooses in the dashboard. Renor records the choice in the control plane and the workspace obeys it at the
  next call; the endpoint refuses rows from a workspace whose recorded choice does not allow them, so off holds even if the workspace has not yet
  been told.
- A self-hosted install sends anonymous usage numbers by default (with the notice above) once Renor's switch for the default is open, and never your memory text unless you said yes; the code that sends is in `src/sharing/` and is the only place a request is made.
