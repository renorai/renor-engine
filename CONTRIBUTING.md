# Contributing to Renor

Thanks for looking. This is a single-owner memory engine, so the bar is simple: a change should make it work better for the person running it, and it should come with a test.

## Set up

Renor needs **Node 22.16 or newer** (`.nvmrc` and `mise.toml` pin the tested Node 22): it stores through Node's built-in SQLite and loads sqlite-vec's prebuilt binary, so the install builds nothing. [Troubleshooting](docs/self-hosting.md#troubleshooting) has the fixes for an old Node or a missing sqlite-vec binary.

```bash
nvm use                 # or: mise use node@22
npm ci                  # without --omit=optional: sqlite-vec's binary is an optional dependency
npm run build
node scripts/smoke-self-hosted.mjs                  # ends with PASS
```

A copy without `.git` (a ZIP download) builds with `RENOR_BUILD_COMMIT=0000000 npm run build`; a git clone needs nothing.

## Test

```bash
npx tsc --noEmit
npx tsc -p tsconfig.public-eval.json --noEmit
npm test -- --maxWorkers=2
npm run eval:renor:hash -- --output .eval-runs/hash-smoke
```

These are the same steps as `.github/workflows/engine-public-ci.yml`; the CI badge on `main` should be green before you open a pull request. Tests use the offline `eval-hash` embedding stub. Do not add a test that needs a paid model, a downloaded model or the network.

## Good first issues

Small, real problems found by following the README from a clean clone. Each one is a single change with a test. Comment on the matching GitHub issue (or open one quoting the item) before you start, so two people do not take the same one.

1. **`rebuild` fails after turning embeddings off.** Index a folder with `EMBEDDING_PROVIDER=eval-hash`, then run `node dist/cli.js rebuild` with `EMBEDDING_PROVIDER` unset: it prints `[memory] rebuild failed: no such module: vec0` and exits 1, because the old vector table needs the `sqlite-vec` module that is only loaded when a provider is set. `node dist/cli.js index` on the same folder works. Expected: `rebuild` drops or skips the vector table and succeeds. Test: index with `eval-hash`, rebuild with nothing set, assert exit 0 and a working `search`.
2. **The first run prints 26 migration lines.** On a new folder, `node dist/cli.js index` and `node scripts/smoke-self-hosted.mjs` print one `[migrations] applied: …` line per schema migration (26 today) to stderr before anything useful. Expected: one summary line (for example `[migrations] applied 26 (new index)`), with the per-migration list kept for an existing index being upgraded. Test: a new folder's stderr has one migrations line.
3. **`search` returns absolute paths; `keyword` returns relative ones.** Over MCP, `search` hits carry `notePath: "/home/you/renor-notes/notebook.md"` while `keyword` hits carry `notePath: "notebook.md"`, and `note` replies with the absolute file path. Expected: vault-relative paths from every stdio tool, so the agent sees one form and the home directory is not repeated in every reply. Test: index one note and assert `search`, `keyword` and `note` all return the same vault-relative path.
4. **A failed model download prints one stack trace per note.** With `EMBEDDING_PROVIDER=local` and no route to huggingface.co, `node dist/cli.js index` prints a full `TypeError: fetch failed` stack for every file before `Done. 0/N indexed, N errors.` Expected: stop at the first failure with one line naming the model, the host it tried and how to fix it (network, or unset `EMBEDDING_PROVIDER`). Test: point the model host at an unreachable address and assert one error line and a non-zero exit.
5. **The smoke check's wrong-directory hint names a folder that does not exist here.** Run `node scripts/smoke-self-hosted.mjs` from outside the repository and it says `Run this from the engine/ directory (cd engine && node scripts/smoke-self-hosted.mjs)`; in this repository the files are at the top level, so there is no `engine/`. Expected: a hint that is right here, for example the directory that holds `package.json`. Test: run it from a temporary directory and assert the message names no `engine/` path.

## Pull requests

- Open an issue first for anything larger than a bug fix, so we agree on the shape before you write it.
- Keep a pull request to one change. Say what it does, why, and which tests you ran.
- A bug fix needs a test that fails before the fix and passes after it.
- Say so in the description if the change loosens security (who can sign in, what a token can reach, what a tool returns) or changes retrieval results. Those get a closer review.
- Never commit credentials, real notes or personal paths. Test fixtures that look like secrets must be obviously synthetic and are allowlisted by exact path in `.gitleaks.toml`.
- Dependency updates are taken in the private repository this one is exported from, so Dependabot version-update pull requests here cannot land. There, `@modelcontextprotocol/sdk` minor and major bumps are held until `tests/mvp/schema-rejected-calls.test.ts` is reviewed against the new SDK.
- Please write issues, pull requests and reviews in English, so anyone can follow along; translated docs are welcome.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). Do not open a public issue for them.

## License

Inbound = outbound: by contributing you agree that your work is licensed under Apache-2.0, the same as the project ([LICENSE](LICENSE)). There is no CLA. Sign off every commit with the [Developer Certificate of Origin](https://developercertificate.org/) (`git commit -s`, which adds `Signed-off-by: Your Name <you@example.com>`); a pull request with an unsigned commit is not merged.
