#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config";
import { openIndexDb } from "./db/client";
import { runMigrations } from "./db/schema";
import { sqliteRuntimeProblem } from "./db/sqlite";
import { replayLedger, resolveLedgerPath, DEFAULT_LEDGER_REL } from "./memory/lifecycle";
import { indexVault, MAX_NOTE_BYTES } from "./indexer/pipeline";
import { startWatcher } from "./watcher/watcher";
import { stalenessGate, stalenessJsonField } from "./indexer/staleness";
import { retrieveContext } from "./retrieval/orchestrator";
import { readerLayoutEnabledFor, layoutHitsForReader, conversationNoteMatcher } from "./retrieval/readerLayout";
import { isEventQuestion, noteTurnsLoader, readerEventsEnabled, turnScorer, vectorsMeanSomething } from "./retrieval/readerEvents";
import { withAdviceLines } from "./retrieval/adviceLines";
import type { RetrievalProbe } from "./retrieval/semantic";
import { ledgerNoteMatcher, presentLedgerEvents } from "./retrieval/ledgerPresentation";
import { attachSearchEvidence, searchEvidenceEnabled, EVIDENCE_HIT_PATH } from "./evidence/attach";
import { createEvidenceExtractor, resolveEvidenceToolOptions } from "./evidence/options";
import { productEvidenceReport } from "./evidence/attach";
import { VectorIndex } from "./embeddings/vectorIndex";
import { OpenAIEmbeddingProvider } from "./embeddings/openai";
import { LocalEmbeddingProvider } from "./embeddings/local";
import { createServer } from "./api/server";
import { requireApiToken } from "./api/apiAuth";
import { buildWritePathExtractors } from "./cli-extractors";
import { typedFactsEnabled } from "./extraction/typedFacts";
import { chronicleEnabled } from "./extraction/eventExtractor";
import { prefsEnabled } from "./extraction/preferenceExtractor";
import { composeQueryContextFromDb, structuredContextEnabled } from "./context/composer";
import { readHonestyEnabled, readHonestyForItems, noteProvenance } from "./context/readHonesty";
import { startMcpServer } from "./mcp/server";
import { clientPath } from "./mvp/engine";
import { EvalHashEmbeddingProvider } from "./eval/hashEmbedding";
import type { EmbeddingProvider } from "./embeddings/types";
import { parseConversation, resolveJSONLPath } from "./conversation/parser";
import { writeConversation } from "./conversation/writer";
import { resolveSessionRouterOptions, routeSearch, summarizeForRouter, type SessionRouterOptions } from "./router/sessionRouter";
import { runTelemetry } from "./sharing/cli";
import { DIGEST_HIT_PATH, attachDigest, digestIndexedNotes, resolveDigestOptions, type DigestOptions } from "./digests/digests";
import { ENGINE_VERSION } from "./buildIdentity";

/**
 * `serving`: the process is the long-running service (serve, mcp), the only one that may set an unterminated ledger tail
 * aside at start-up. Every other command refuses such a tail and leaves the ledger alone (replayLedger).
 */
async function setup({ serving = false }: { serving?: boolean } = {}) {
  const config = loadConfig();
  // D1 staleness guard (RENOR_VAULT_STALENESS=off|warn|fatal, default warn):
  // the indexer must never silently serve a stale vault checkout again. Local
  // git metadata only — no network, no fetch, zero model calls.
  const gate = stalenessGate(config.vaultPath);
  gate.stderrLines.forEach((l) => console.error(l));
  if (gate.fatal) {
    console.error("[staleness] RENOR_VAULT_STALENESS=fatal — refusing to serve a stale vault");
    process.exit(1);
  }
  const db = openIndexDb(config.dbPath, resolveLedgerPath(config.vaultPath, config.memoryLedger));
  runMigrations(db);
  // B7: startup MUST await a validated ledger replay before readiness. Replay
  // failures block startup (fail closed) instead of being swallowed in a
  // background promise — a corrupt ledger must never serve stale/absent facts.
  try {
    const replayed = await replayLedger(db, config.vaultPath, config.memoryLedger, { setTornTailAside: serving });
    if (replayed > 0) console.error(`[memory] replayed ${replayed} ledger event(s)`);
  } catch (err) {
    console.error(`[memory] ledger replay failed:`, err instanceof Error ? err.message : err);
    db.close();
    process.exit(1);
  }
  let provider: EmbeddingProvider | undefined;
  if (config.embeddingProvider === "local") {
    provider = new LocalEmbeddingProvider(config.embeddingModel);
  } else if (config.embeddingProvider === "eval-hash") {
    provider = new EvalHashEmbeddingProvider();
  } else if (config.embeddingProvider === "openai") {
    provider = new OpenAIEmbeddingProvider(config.openaiApiKey!.split(',').map(k => k.trim()).filter(Boolean), config.embeddingModel, config.embeddingBaseURL, config.embeddingDims);
  }
  if (!provider) console.error('[embeddings] Semantic search is off; set EMBEDDING_PROVIDER=openai to turn it on.');
  const vectorIndex = provider ? new VectorIndex(db, provider.dimensions) : undefined;
  vectorIndex?.initTable();
  const { factExtractor, numericFactExtractor, eventExtractor, preferenceExtractor } =
    buildWritePathExtractors(config);
  return { config, db, provider, vectorIndex, factExtractor, numericFactExtractor, eventExtractor, preferenceExtractor };
}

/** Flags that write structured rows, and only the commands that extract them. */
function armedWithoutProvider(extractors: {
  numericFactExtractor?: unknown;
  eventExtractor?: unknown;
  preferenceExtractor?: unknown;
}): string[] {
  return [
    typedFactsEnabled() && !extractors.numericFactExtractor ? 'RENOR_TYPED_FACTS' : '',
    chronicleEnabled() && !extractors.eventExtractor ? 'RENOR_CHRONICLE' : '',
    prefsEnabled() && !extractors.preferenceExtractor ? 'RENOR_PREFS' : '',
  ].filter(Boolean);
}

function refuseArmedWithoutProvider(
  db: { close(): void },
  flags: string[],
): void {
  if (flags.length === 0) return;
  // A flag without a provider used to index cleanly and write nothing.
  // The eval runner treats a clean index as success, so extraction commands
  // have to fail here rather than look like an empty extraction.
  // search, serve, and mcp do not extract; they must not exit on these flags.
  console.error(`[extraction] armed without a provider: ${flags.join(', ')}`);
  db.close();
  process.exit(1);
}

/**
 * RENOR_SESSION_ROUTER armed with no model to write the summaries it routes on. Same contract as the extraction
 * flags above: an armed flag that cannot run must fail the index, or a benchmark arm indexes cleanly and then
 * measures the control twice.
 */
function refuseRouterWithoutProvider(db: { close(): void }, router: SessionRouterOptions | null): void {
  if (!router || router.summaryChat) return;
  console.error('[router] armed without a provider: RENOR_SESSION_ROUTER needs RENOR_ROUTER_API_KEY(S), RENOR_EVIDENCE_API_KEY(S) or an Ollama Cloud key');
  db.close();
  process.exit(1);
}

/** Index-time summaries for the session router. Returns how many notes were left without one (an index error). */
async function buildRouterSummaries(
  db: Parameters<typeof summarizeForRouter>[0]['db'],
  config: { vaultPath: string; memoryLedger: string },
  router: SessionRouterOptions,
): Promise<number> {
  const stats = await summarizeForRouter({ db, config, options: router });
  console.log(`[router] summaries ${JSON.stringify(stats)}`);
  if (stats.failed > 0) {
    console.error(`[router] ${stats.failed} note(s) left without a summary; search will not route until they have one${stats.error ? ` (${stats.error})` : ''}`);
  }
  return stats.failed;
}

/**
 * RENOR_DIGESTS armed with no model to write the digests it reads. Same contract as the router: an armed flag that
 * cannot run must fail the index, or a benchmark arm indexes cleanly and then measures the control twice. A cache-only
 * run (RENOR_DIGEST_CACHE_ONLY) calls no model on purpose and needs none.
 */
function refuseDigestsWithoutProvider(db: { close(): void }, digests: DigestOptions | null): void {
  if (!digests || digests.chat || digests.cacheOnly) return;
  // The digest slot is the only provider notes are sent to: another provider's key is never borrowed (resolveDigestProvider).
  console.error('[digests] armed without a provider: RENOR_DIGESTS needs RENOR_DIGEST_BASE_URL and RENOR_DIGEST_API_KEY(S); it never uses the evidence provider or an Ollama Cloud key instead, so nothing was sent');
  db.close();
  process.exit(1);
}

/**
 * RENOR_DIGESTS armed with semantic search off (EMBEDDING_PROVIDER omitted). Digests are written and looked up by their
 * embedding, cache-only runs included, so with no embedding provider the lane would index and search as if no digest existed.
 * Same contract as above: an armed flag that cannot run fails the command instead of quietly measuring the control.
 */
function refuseDigestsWithoutEmbeddings(db: { close(): void }, digests: DigestOptions | null, provider: EmbeddingProvider | undefined): void {
  if (!digests || provider) return;
  console.error('[digests] armed without an embedding provider: RENOR_DIGESTS writes and looks up digests by embedding, so it needs EMBEDDING_PROVIDER (for example openai); semantic search is off, so no digest was built or read');
  db.close();
  process.exit(1);
}

/** Index-time digests. Returns how many notes were left without one (an index error). */
async function buildDigests(
  db: Parameters<typeof digestIndexedNotes>[0]['db'],
  config: { vaultPath: string; memoryLedger: string },
  digests: DigestOptions,
  provider: EmbeddingProvider,
): Promise<number> {
  const stats = await digestIndexedNotes({ db, config, options: digests, provider });
  console.log(`[digests] ${JSON.stringify(stats)}`);
  if (stats.failed > 0) {
    console.error(`[digests] ${stats.failed} note(s) left without a digest; search will not read them until they have one${stats.error ? ` (${stats.error})` : ''}`);
  }
  return stats.failed;
}

/**
 * The Markdown files the walk could not name because a file or folder name holds bytes that are
 * not UTF-8. They are not errors — no note failed — but silently dropping them would make an
 * index that is short of the vault look complete, so they are named here with the fix. A note over
 * MAX_NOTE_BYTES is the same: never read, so no failure, but named.
 */
function printNotIndexed(names: string[], labelWidth: number, tooLarge: string[] = []) {
  if (tooLarge.length > 0) {
    console.log(`  ${'not indexed'.padEnd(labelWidth)}: ${tooLarge.length} Markdown file(s) over ${MAX_NOTE_BYTES / (1024 * 1024)} MiB`
      + ' (not read); split them or move them out of the memory folder, then index again');
    for (const name of tooLarge.slice(0, 10)) console.log(`      ! ${name}`);
    if (tooLarge.length > 10) console.log(`      ! …and ${tooLarge.length - 10} more`);
  }
  if (names.length === 0) return;
  console.log(`  ${'not indexed'.padEnd(labelWidth)}: ${names.length} Markdown file(s) whose file or folder name is not valid UTF-8`
    + ' (bad bytes are shown as \\xNN); rename them to UTF-8 names, then index again');
  for (const name of names.slice(0, 10)) console.log(`      ! ${name}`);
  if (names.length > 10) console.log(`      ! …and ${names.length - 10} more`);
}

const program = new Command().name("renor").version(ENGINE_VERSION);

program
  .command("index")
  .description("Index full vault")
  .action(async () => {
    const { config, db, provider, vectorIndex, factExtractor, numericFactExtractor, eventExtractor, preferenceExtractor } = await setup();
    refuseArmedWithoutProvider(db, armedWithoutProvider({
      numericFactExtractor, eventExtractor, preferenceExtractor,
    }));
    const router = resolveSessionRouterOptions(config);
    refuseRouterWithoutProvider(db, router);
    const digests = resolveDigestOptions(config);
    refuseDigestsWithoutProvider(db, digests);
    refuseDigestsWithoutEmbeddings(db, digests, provider);
    console.log(`Indexing: ${config.vaultPath}`);
    const stats = await indexVault(
      db,
      config.vaultPath,
      {
        embeddingProvider: provider,
        vectorIndex,
        chunkOptions: {
          maxTokens: config.chunkMaxTokens,
          overlapTokens: config.chunkOverlapTokens,
        },
        factExtractor,
        numericFactExtractor,
        eventExtractor,
        preferenceExtractor,
      },
      config.indexConcurrency,
    );
    console.log(
      `Done. ${stats.indexed}/${stats.total} indexed, ${stats.errors} errors.`,
    );
    printNotIndexed(stats.skippedNonUtf8Names, 15, stats.skippedTooLarge);
    const unsummarized = router ? await buildRouterSummaries(db, config, router) : 0;
    const undigested = digests && provider ? await buildDigests(db, config, digests, provider) : 0;
    db.close();
    // #188: a partial index is not a success. The completion line reports the
    // error count and the process status must agree with it, or automation
    // (the eval runner included) accepts an incomplete index. Never a blanket
    // catch: the count is the failure, and a clean run still exits 0.
    // A note the armed session router could not summarise is the same kind of failure.
    if (stats.errors > 0 || unsummarized > 0 || undigested > 0) process.exit(1);
  });

program
  .command("search <query>")
  .description("Semantic search")
  .option("-k, --top-k <n>", "results", "20")
  .option("--json", "machine-readable JSON output (full hit text; the benchmark client transport)")
  .action(async (query: string, opts: { topK: string; json?: boolean }) => {
    const { config, db, provider, vectorIndex } = await setup();
    // D1: the machine-readable transport carries the staleness verdict so a
    // stale-serving index is visible to the CLIENT, not only in stderr — but only
    // when the operator EXPLICITLY armed the guard (RENOR_VAULT_STALENESS=warn|fatal).
    // Unset must stay byte-identical to the frozen `search --json` contract even on a
    // stale vault: the contract test's plain-folder fixture cannot reach that case, so
    // this is pinned at the CLI surface by tests/context/staleness-unarmed-contract.test.ts
    // (see stalenessJsonField).
    const vaultStaleness = stalenessJsonField(stalenessGate(config.vaultPath).staleness);
    // The ledger is the engine's own record, not a memory: a search returns neither its header nor the markup of its records.
    const isLedger = ledgerNoteMatcher({ memoryDir: config.vaultPath, ledgerRelPath: config.memoryLedger ?? DEFAULT_LEDGER_REL });
    // RENOR_READER_EVENTS reads the question's vector for its lines, only for an order or a date question: nothing else changes.
    const probe: RetrievalProbe | undefined = readerEventsEnabled() && isEventQuestion(query) ? {} : undefined;
    const retrieved = await retrieveContext(
      db,
      vectorIndex,
      provider,
      query,
      Number(opts.topK),
      config.priorityPaths,
      {},
      { isLedgerNote: isLedger, ...(probe ? { probe } : {}) },
    );
    // Session router (RENOR_SESSION_ROUTER, default off): null when off, and then nothing here changes.
    const routed = await routeSearch({ db, config, query, retrieved });
    const evidence = resolveEvidenceToolOptions(config);
    const result = await attachSearchEvidence({
      query,
      hits: routed ? routed.hits : retrieved.hits,
      vaultPath: config.vaultPath,
      options: evidence,
      extractor: searchEvidenceEnabled() ? createEvidenceExtractor(evidence) : null,
    });
    // Write-time digests (RENOR_DIGESTS, default off): null when off, and then nothing here changes. No model call.
    const digestOptions = resolveDigestOptions(config);
    refuseDigestsWithoutEmbeddings(db, digestOptions, provider);
    const digested = digestOptions && provider
      ? await attachDigest({ db, query, hits: result.hits, options: digestOptions, provider, isLedgerNote: isLedger })
      : null;
    // The evidence pass read the sources as stored; what is printed is what the user said.
    // Laid out for the model that reads it (RENOR_READER_LAYOUT; readerLayout.ts): the hits of a session come as one, and its time phrases are resolved. RENOR_READER_EVENTS adds event lines above them for an order or a date question.
    // A query that asks to be advised keeps the page as it was when RENOR_READER_LAYOUT_SKIP_ADVICE is on.
    // RENOR_READER_ADVICE_LINES (default off): for a query that asks to be advised, the user's own matching statements come first (adviceLines.ts).
    const presented = presentLedgerEvents(digested ? digested.hits : result.hits, isLedger);
    const notTable = (p: string) => !isLedger(p) && p !== EVIDENCE_HIT_PATH && p !== DIGEST_HIT_PATH;
    let conversationNote: ((notePath: string) => boolean) | undefined;
    const hits = withAdviceLines(readerLayoutEnabledFor(query)
      ? layoutHitsForReader(presented, { rankedBy: retrieved.rankedBy, isLedger: (p) => isLedger(p) || p === EVIDENCE_HIT_PATH || p === DIGEST_HIT_PATH, isConversation: conversationNoteMatcher(db), query, turnsOf: readerEventsEnabled() ? noteTurnsLoader(db) : undefined, scoreTurns: probe?.queryVector && provider && vectorIndex && vectorsMeanSomething(provider.identity?.kind) ? turnScorer(vectorIndex, probe.queryVector) : undefined })
      : presented, { query, turnsOf: () => noteTurnsLoader(db), isSource: (h) => (h.chunkId ?? 0) > 0 && h.notePath !== '' && notTable(h.notePath) && (conversationNote ??= conversationNoteMatcher(db))(h.notePath) });
    if (opts.json) {
      // Sole stdout content: machine-readable hits with FULL text. This is the
      // public CLI contract consumed by external clients (authoritative
      // benchmark runner); it must not be mixed with prose output.
      // C0 composer (ADR-0003 §5): RENOR_STRUCTURED_CONTEXT (default off) adds
      // the composed bounded context alongside the unchanged hits array.
      const composed = structuredContextEnabled()
        ? composeQueryContextFromDb(db, { query, hits: hits.filter((h) => h.notePath !== EVIDENCE_HIT_PATH), evidence: result.evidence })
        : undefined;
      // A note's path is printed as the hosted tools print it (clientPath): relative to the vault, so the reply names
      // neither the host's filesystem layout nor its temporary directory, and its size does not depend on where the
      // vault lives. The notes were found, and the composer joined its rows to them, by the stored path: only what is
      // printed below changes, and the evidence and digest tables' own paths (they are no files) stay what clients match
      // them by.
      const shown = (stored: string) => (stored === EVIDENCE_HIT_PATH || stored === DIGEST_HIT_PATH ? stored : clientPath(config.vaultPath, stored));
      const shownHits = hits.map((h) => ({ ...h, notePath: shown(h.notePath) }));
      const shownRouter = routed?.report.routed
        ? { ...routed.report, routed: routed.report.routed.map((r) => ({ ...r, notePath: shown(r.notePath) })) }
        : routed?.report;
      const shownDigest = digested
        ? { ...digested.report, items: digested.report.items.map((i) => ({ ...i, notePath: shown(i.notePath) })) }
        : undefined;
      const shownEvidence = result.evidence.sessions
        ? { ...result.evidence, sessions: result.evidence.sessions.map((s) => ({ ...s, stem: shown(s.stem) })) }
        : result.evidence;
      // LANE 3 read-time honesty (RENOR_READ_HONESTY, default off): adds
      // provenance + contradiction + abstention alongside the unchanged hits
      // array. Nothing is filtered, hidden or reordered — when the evidence
      // does not cover the question the read SAYS SO instead of presenting
      // weak hits as an answer.
      const honesty = readHonestyEnabled()
        ? readHonestyForItems({ db, query, items: shownHits, ledgerRelPath: config.memoryLedger ?? DEFAULT_LEDGER_REL })
        : undefined;
      console.log(JSON.stringify({
        hits: shownHits.map((h) => ({
          notePath: h.notePath,
          score: h.score,
          reason: h.reason,
          text: h.text,
          ...(h.session_date ? { session_date: h.session_date } : {}),
          ...(honesty ? { provenance: noteProvenance(h.notePath, h.session_date ?? null) } : {}),
        })),
        ...(composed ? { composedContext: composed } : {}),
        ...(honesty ? { readHonesty: honesty } : {}),
        ...(shownRouter ? { router: shownRouter } : {}),
        ...(shownDigest ? { digest: shownDigest } : {}),
        ...vaultStaleness,
        // What the evidence pass did, in the shape search_memory returns, so a
        // failed extraction is said instead of being a silently missing table
        // (#222). RENOR_SEARCH_EVIDENCE=0 keeps the frozen envelope.
        ...(result.evidence.reason === "flag-off" ? {} : { evidence: productEvidenceReport(shownEvidence) }),
      }));
    } else {
      if (routed) {
        console.log(`[router] ${routed.report.status}${routed.report.reason ? ` (${routed.report.reason})` : ''}`);
      }
      if (structuredContextEnabled()) {
        const composed = composeQueryContextFromDb(db, { query, hits, evidence: result.evidence });
        console.log(composed.text);
        console.log("");
      }
      hits.forEach((h) => {
        console.log(`\n[${h.score.toFixed(3)}] ${clientPath(config.vaultPath, h.notePath)} (${h.reason})`);
        console.log(h.text.substring(0, 200));
      });
    }
    db.close();
  });

program
  .command("watch")
  .description("Watch vault for changes")
  .action(async () => {
    const { config, db, provider, vectorIndex, factExtractor, numericFactExtractor, eventExtractor, preferenceExtractor } = await setup();
    refuseArmedWithoutProvider(db, armedWithoutProvider({
      numericFactExtractor, eventExtractor, preferenceExtractor,
    }));
    console.log(`Watching: ${config.vaultPath}`);
    startWatcher(config.vaultPath, db, {
      embeddingProvider: provider,
      vectorIndex,
      factExtractor,
      numericFactExtractor,
      eventExtractor,
      preferenceExtractor,
    });
  });

program
  .command("serve")
  .description("Start HTTP API")
  .option("-p, --port <n>", "port", "3456")
  .action(async (opts: { port: string }) => {
    // Checked before anything is opened: a missing token must not leave a database or an index half-started.
    let apiToken: string;
    try {
      apiToken = requireApiToken();
    } catch (err) {
      console.error(`[serve] ${(err as Error).message}`);
      process.exit(1);
    }
    const { config, db, provider, vectorIndex } = await setup({ serving: true });
    const app = createServer(
      db,
      vectorIndex,
      provider,
      config.vaultPath,
      config.priorityPaths,
      config.memoryDir,
      config.memoryLedger,
      { apiToken },
    );
    app.listen(Number(opts.port), "127.0.0.1", () =>
      console.log(`Listening on http://127.0.0.1:${opts.port}`),
    );
  });

program
  .command("rebuild")
  .description("Clear derived data and reindex from scratch")
  .action(async () => {
    const { config, db, provider, vectorIndex, factExtractor, numericFactExtractor, eventExtractor, preferenceExtractor } = await setup();
    refuseArmedWithoutProvider(db, armedWithoutProvider({
      numericFactExtractor, eventExtractor, preferenceExtractor,
    }));
    const router = resolveSessionRouterOptions(config);
    refuseRouterWithoutProvider(db, router);
    const digests = resolveDigestOptions(config);
    refuseDigestsWithoutProvider(db, digests);
    refuseDigestsWithoutEmbeddings(db, digests, provider);
    let rebuildErrors = 0;
    try {
      // Clear vector index — drop and recreate
      db.prepare("DROP TABLE IF EXISTS chunk_embeddings").run();
      vectorIndex?.initTable(); // recreates it
      // Clear SQL derived tables atomically
      db.transaction(() => {
        ["facts", "relations", "entities", "chunks", "notes", "applied_ledger_events"].forEach((t) =>
          db.prepare(`DELETE FROM ${t}`).run(),
        );
      })();
      // The ledger is the source of truth: after the derived tables are wiped,
      // replay MUST run again (awaited) or the rebuild would silently drop
      // every lifecycle fact until the next restart. Errors block the rebuild.
      const replayed = await replayLedger(
        db,
        config.vaultPath,
        config.memoryLedger,
      );
      console.log(`Cleared. Replayed ${replayed} ledger event(s). Reindexing...`);
      const rebuildStats = await indexVault(
        db,
        config.vaultPath,
        {
          embeddingProvider: provider,
          vectorIndex,
          chunkOptions: {
            maxTokens: config.chunkMaxTokens,
            overlapTokens: config.chunkOverlapTokens,
          },
          factExtractor,
          numericFactExtractor,
          eventExtractor,
          preferenceExtractor,
        },
        config.indexConcurrency,
      );
      console.log(
        `Rebuild complete. ${rebuildStats.indexed}/${rebuildStats.total} indexed, ${rebuildStats.errors} errors.`,
      );
      printNotIndexed(rebuildStats.skippedNonUtf8Names, 17, rebuildStats.skippedTooLarge);
      rebuildErrors = rebuildStats.errors + (router ? await buildRouterSummaries(db, config, router) : 0)
        + (digests && provider ? await buildDigests(db, config, digests, provider) : 0);
    } catch (err) {
      console.error(
        `[memory] rebuild failed:`,
        err instanceof Error ? err.message : err,
      );
      db.close();
      process.exit(1);
    }
    db.close();
    // Same failure contract as `index` (#188): the rebuild reports its error
    // count, and the exit status must carry it. A wipe-and-reindex that left
    // notes behind is not a successful rebuild.
    if (rebuildErrors > 0) process.exit(1);
  });

program
  .command("mcp")
  .description("Start MCP server (stdio transport) for agent connectivity")
  .action(async () => {
    const { config, db, provider, vectorIndex } = await setup({ serving: true });
    // stderr only: stdout is the JSON-RPC stream. Said when the folder is the default, so a person who set nothing can find it.
    if (!process.env.VAULT_PATH) process.stderr.write(`Renor memory: ${config.vaultPath}\n`);
    try {
      await startMcpServer(db, vectorIndex, provider, config);
    } catch (err) {
      // A refused startup is an operator-facing answer, not a crash: another live `renor-engine mcp`
      // already holds this connection's name (memory/agentLease.ts). Say it on one line and exit
      // non-zero, so a client that launches the server reads a stderr it can act on. stdout
      // stays empty either way, so a JSON-RPC stream is never polluted.
      process.stderr.write(`renor-engine mcp: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("telemetry <action> [argument]")
  .description("Choose what to share with Renor: off, anonymous usage numbers (signals, the default) or everything incl. memory text (data): status | signals | data | off | delete | preview [level] | send | fields [level]")
  .option("--yes", "do not ask: you have read the words shown and confirm you are 18 or older")
  .option("--local", "delete: also empty the local learning log")
  .option("--dir <path>", "the sharing folder (default: RENOR_SHARING_DIR, else ~/.config/renor)")
  .option("--memory-dir <path>", "the memory folder whose learning log is read (default: MVP_MEMORY_DIR)")
  .action(async (action: string, argument: string | undefined, opts: { yes?: boolean; local?: boolean; dir?: string; memoryDir?: string }) => {
    const readline = await import("node:readline");
    const code = await runTelemetry(action, argument, opts, {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
      env: process.env,
      ask: (question) => {
        if (!process.stdin.isTTY) return Promise.resolve(null);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise((resolve) => rl.question(question, (answer) => {
          rl.close();
          resolve(/^y(es)?$/i.test(answer.trim()));
        }));
      },
    });
    process.exit(code);
  });

program
  .command("log-conversation")
  .description(
    "Log a Claude Code session to Obsidian vault (invoked by Stop hook)",
  )
  .action(async () => {
    const vaultPath = process.env.VAULT_PATH;
    const conversationsDir =
      process.env.CONVERSATIONS_DIR ?? "Claude Code/Conversations";

    if (!vaultPath) {
      process.stderr.write("log-conversation: VAULT_PATH not set\n");
      process.exit(0);
    }

    // Читаем JSON-пейлоад Stop hook из stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8").trim();

    let sessionId: string | undefined;
    let cwd: string | undefined;
    try {
      const payload = JSON.parse(raw);
      sessionId = payload.session_id;
      cwd = payload.cwd;
    } catch {
      process.stderr.write("log-conversation: invalid JSON on stdin\n");
      process.exit(0);
    }

    if (!sessionId || !cwd) {
      process.stderr.write(
        "log-conversation: missing session_id or cwd in payload\n",
      );
      process.exit(0);
    }

    try {
      const jsonlPath = resolveJSONLPath(sessionId, cwd);
      const conv = await parseConversation(jsonlPath, sessionId, cwd);
      const filePath = await writeConversation(
        vaultPath,
        conversationsDir,
        conv,
      );
      process.stdout.write(`Conversation saved: ${filePath}\n`);
    } catch (err) {
      process.stderr.write(`log-conversation: ${err}\n`);
      process.exit(0);
    }
  });

// One line naming the fix, before any command runs, when this machine cannot run the engine's SQLite: otherwise an MCP
// client only sees a server that exited.
const runtimeProblem = sqliteRuntimeProblem();
if (runtimeProblem) {
  process.stderr.write(`renor-engine: ${runtimeProblem}\n`);
  process.exit(1);
}

program.parse();
