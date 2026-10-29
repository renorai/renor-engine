import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, JSONRPCMessage, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Database from '../db/sqlite';
import { PassThrough, type Readable } from 'stream';
import { VectorIndex } from '../embeddings/vectorIndex';
import { retrieveContext } from '../retrieval/orchestrator';
import { lookupEntity } from '../retrieval/entityLookup';
import { appendDailyMemory } from '../memory/writer';
import { remember, factsFor, resolveLedgerPath, DEFAULT_LEDGER_REL } from '../memory/lifecycle';
import { indexFile } from '../indexer/pipeline';
import { pickEntityName, pickTopK, quoteFtsQuery, shownPage } from '../retrieval/queryHelpers';
import { keywordSearch } from '../retrieval/keyword';
import { clientPath } from '../mvp/engine';
import { selectNoteIdentityHits, NOTE_IDENTITY_EXTRA } from '../retrieval/noteIdentity';
import { isLedgerPreamble, keywordLedgerHits, ledgerNoteMatcher, presentLedgerEvents } from '../retrieval/ledgerPresentation';
import { EvidenceExtractor } from '../evidence/secondPass';
import { createEvidenceExtractor, resolveEvidenceToolOptions, type EvidenceToolOptions } from '../evidence/options';
import { attachSearchEvidence, collectEvidence, searchEvidenceEnabled, EVIDENCE_HIT_PATH } from '../evidence/attach';
import { composeQueryContextFromDb, structuredContextEnabled } from '../context/composer';
import type { Config } from '../config';
import type { EmbeddingProvider } from '../embeddings/types';
import { createStdioHiveTools, HIVE_TOOLS } from './hive';
import { hiveIdentity } from '../memory/sourceName';
import { isZodError, mapInvalidParams } from './requestErrors';
import { escapeInvisibleControls } from '../mvp/sanitize';
import { matchingCurrentFactHits } from '../retrieval/factsFirst';
import { HANDOFF_ARG_DESCRIPTIONS, HANDOFF_TOOL_DESCRIPTION, HANDOFF_TOOL_NAME, handoffNoteEnabled, runHandoffTool, startHandoffSweep } from '../memory/handoff';
import { ENGINE_VERSION } from '../buildIdentity';
import { z } from 'zod';
import { OUT_ASK_AGENT, OUT_HANDOFF, OUT_HIT, OUT_LIST_REQUESTS, OUT_REQUEST, OUT_WHATS_NEW, toolCarriesStructured } from '../mvp/outputSchemas';

export function createMcpTools(
  db: Database.Database,
  vectorIndex: VectorIndex | undefined,
  provider: EmbeddingProvider | undefined,
  config: Pick<Config, 'vaultPath' | 'memoryDir' | 'priorityPaths' | 'memoryLedger'> & Partial<Pick<Config, 'chunkMaxTokens' | 'chunkOverlapTokens'>>,
  evidence: EvidenceToolOptions = { mode: 'off', model: '', maxSessions: 12, charCap: 6000 }
) {
  // Startup configuration, captured once: tool arguments and later env changes cannot rename a connection.
  // The hive name is the header form. Empty, unnamed, or a second live holder publishes no hive tools
  // (a duplicate name throws here, so `renor-engine mcp` fails at startup instead of joining the other process).
  const rawConnectionName = process.env.RENOR_CONNECTION_NAME?.trim();
  const identity = rawConnectionName ? hiveIdentity(rawConnectionName) : null;
  const hive = identity ? createStdioHiveTools(db, identity) : {};
  // Lazy extractor: built on first use so mode=off and key-less deployments
  // never open the cache file or construct a chat client.
  let extractor: EvidenceExtractor | null | undefined;
  const getExtractor = (): EvidenceExtractor | null => {
    if (extractor !== undefined) return extractor;
    extractor = createEvidenceExtractor(evidence);
    return extractor;
  };
  // The ledger is the engine's own record, not a memory: no read tool returns its header or the markup of its records.
  const vault = { memoryDir: config.vaultPath, ledgerRelPath: config.memoryLedger ?? DEFAULT_LEDGER_REL };
  const isLedger = ledgerNoteMatcher(vault);

  // A save writes a file (the day's note, or the ledger) and nothing else, so search and keyword would not find it until
  // `renor index` ran again. Index the file just written, cut the way `renor index` cuts it, as the hosted save does.
  // The memory is already saved, so a failed refresh is said in the reply instead of failing the save.
  const indexSaved = async (file: string): Promise<{ warning: string; detail: string } | null> => {
    try {
      const maxTokens = config.chunkMaxTokens ?? 400;
      await indexFile(db, file, {
        embeddingProvider: provider,
        vectorIndex,
        // The defaults of loadConfig (CHUNK_MAX_TOKENS, CHUNK_OVERLAP_TOKENS): the chunker's own default overlap is 0.
        // A default overlap stays below a maximum the caller named, as loadConfig requires of the pair.
        chunkOptions: { maxTokens, overlapTokens: config.chunkOverlapTokens ?? Math.min(50, maxTokens - 1) },
      });
      return null;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { warning: 'memory-saved-but-index-refresh-failed', detail: detail.slice(0, 300) };
    }
  };

  // The handoff note (memory/handoff.ts), only with RENOR_HANDOFF_NOTE on. Its writer is this connection's startup name;
  // its expiry sweep runs for the life of the process (the timer never keeps it alive).
  if (handoffNoteEnabled()) startHandoffSweep(db);
  const handoff = handoffNoteEnabled()
    ? { async [HANDOFF_TOOL_NAME](args: { action: 'read' | 'write'; repo: string; branch: string; note?: string }) {
      return runHandoffTool(db, args ?? ({} as any), identity ?? 'stdio');
    } }
    : {};

  return {
    ...hive,
    ...handoff,
    // Canonical tool names. Clients that prefix with the server name render
    // these as renor_search, renor_keyword, renor_facts, etc.
    async search(args: { query: string; topK?: number; top_k?: number }) {
      const topK = pickTopK(args, 20, 100);
      const result = await retrieveContext(db, vectorIndex, provider, args.query, topK, config.priorityPaths ?? [], {}, { isLedgerNote: isLedger });
      // Unlike the owner-name shortcuts in the shared retrieval orchestrator, the self-hosted stdio read must surface
      // a just-saved fact about any subject before its ledger prose is indexed. This is the same bounded current-fact
      // term-index lane the hosted read uses; it excludes superseded facts.
      // Merged by score with the note hits, not prepended: a fact that answers the query ranks by how well it does,
      // and a strong note match still comes first.
      const currentFacts = matchingCurrentFactHits(db, args.query, Math.min(3, topK));
      const factTexts = new Set(currentFacts.map(hit => hit.text));
      const hits = [...currentFacts, ...result.hits.filter(hit => !factTexts.has(hit.text))]
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      const enabled = searchEvidenceEnabled();
      const attached = await attachSearchEvidence({
        query: args.query,
        hits,
        vaultPath: config.vaultPath,
        options: evidence,
        extractor: enabled ? getExtractor() : null,
        enabled,
      });
      // The evidence pass above read the sources as stored; what the caller is shown is what the user said.
      const shown = presentLedgerEvents(attached.hits, isLedger);
      // C0 shared composer (ADR-0003 §5): opt-in via RENOR_STRUCTURED_CONTEXT
      // (default OFF — plain hits array, unchanged contract). When on, the
      // composed bounded context ships alongside the hits.
      if (structuredContextEnabled()) {
        const excerptHits = shown.filter((h) => h.notePath !== EVIDENCE_HIT_PATH);
        return {
          hits: shown,
          composedContext: composeQueryContextFromDb(db, {
            query: args.query,
            hits: excerptHits,
            evidence: attached.evidence,
          }),
        };
      }
      return shown;
    },

    /**
     * Product path for the H10-v4 second pass: retrieve, then list every
     * distinct item/event/amount relevant to the question, with dates.
     * Content-addressed: an identical question over unchanged sessions
     * replays from cache with zero model calls.
     */
    async evidence(args: { query: string; topK?: number; top_k?: number; force?: boolean }) {
      const topK = pickTopK(args, 20, 100);
      const hits = (await retrieveContext(db, vectorIndex, provider, args.query, topK, config.priorityPaths ?? [], {}, { isLedgerNote: isLedger })).hits;
      const attachment = await collectEvidence({
        query: args.query,
        hits,
        vaultPath: config.vaultPath,
        options: evidence,
        extractor: getExtractor(),
        force: args.force === true,
      });
      return { query: args.query, hits: presentLedgerEvents(hits, isLedger), evidence: attachment };
    },

    async keyword(args: { query: string; topK?: number; top_k?: number }) {
      const topK = pickTopK(args, 20, 50);
      const match = quoteFtsQuery(args.query);
      if (!match) return [];
      try {
        // Rows of the ledger may come off the page (its header, an event the words are not in). They are judged before
        // the page is cut, from a read that goes on until the page is full or the index has no more rows: records of the
        // ledger never take a place from a note that says the word, however many of them rank above it. A search that
        // turns nothing away is the one read of topK rows it always was.
        const fts = shownPage(
          rows => keywordSearch(db, match, rows),
          rows => keywordLedgerHits(rows.map(r => ({ ...r, score: Math.abs(r.score), reason: 'fts' })), isLedger, args.query),
          topK,
        );
        // The term may also name a note (task id, slug, file name, frontmatter id): add
        // it after the untouched prose page — reason says it came from note identity.
        const named = selectNoteIdentityHits(
          db, args.query, NOTE_IDENTITY_EXTRA, new Set(fts.map(r => r.notePath)),
          (_notePath, opening) => !isLedgerPreamble(opening, isLedger),
        );
        // Judge stored paths first; expose only vault-relative paths on the wire,
        // using the same presentation as `renor search --json`.
        return presentLedgerEvents([...fts, ...named], isLedger)
          .map(hit => ({ ...hit, notePath: clientPath(config.vaultPath, hit.notePath) }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: 'fts-query', detail: message.slice(0, 200), results: [] };
      }
    },

    async entity(args: { name: string }) {
      return lookupEntity(db, args.name);
    },

    async facts(args: { entityName?: string; name?: string; subject?: string; asOf?: string; includeHistory?: boolean }) {
      const entityName = pickEntityName(args);
      if (!entityName) return [];
      return factsFor(db, entityName, { asOf: args.asOf, includeHistory: args.includeHistory });
    },

    /** The principal durable-memory verb: ledger-first, supersedes the current fact for the same subject+predicate. Returns a receipt. */
    async remember_fact(args: { subject: string; predicate: string; object: string; source?: string }) {
      const ledgerRel = config.memoryLedger ?? DEFAULT_LEDGER_REL;
      const receipt = await remember(db, config.vaultPath, ledgerRel, { ...args, source: identity ?? undefined });
      // Nothing was written when the fact was already current, as the hosted save skips its refresh.
      if (receipt.action === 'nochange') return receipt;
      const failed = await indexSaved(resolveLedgerPath(config.vaultPath, ledgerRel));
      return failed ? { ...receipt, ...failed } : receipt;
    },

    async status(_args: {}) {
      const counts = {
        notes: (db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number }).c,
        chunks: (db.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number }).c,
        entities: (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c,
        facts: (db.prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number }).c,
        relations: (db.prepare('SELECT COUNT(*) as c FROM relations').get() as { c: number }).c,
      };
      return counts;
    },

    async note(args: { text: string; date?: string; source?: string }) {
      const date = args.date ?? new Date().toISOString().substring(0, 10);
      const source = identity ?? 'mcp';
      const filePath = await appendDailyMemory(config.vaultPath, date, { text: args.text, source }, config.memoryDir);
      const failed = await indexSaved(filePath);
      return { ok: true, path: filePath, ...failed };
    },
  };
}

// Exported so tests/mcp/tool-surfaces.test.ts can compare the published list
// against the surface map in docs/architecture/MCP-TOOL-SURFACES.md.
export const TOOLS = [
  {
    name: 'search',
    description: 'DEFAULT tool for questions about the user or the vault (who/what/where/current project, preferences, goals). Prepends current lifecycle facts when they match; then semantic chunks. Each hit may include session_date — render excerpts as "[Session date: <session_date>]\n<text>". Do not rewrite stored chunk text. When RENOR_SEARCH_EVIDENCE is on, search also runs the H10-v4 evidence second pass (full source notes, 12-note/6k cap, cached) and prepends a dated item table as the first hit. Do not use keyword search first for identity questions. Write durable facts with remember_fact.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        topK: { type: 'number', description: 'Number of results (1-100, default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'evidence',
    description: 'Question-conditioned evidence extraction. Retrieves like search and then lists every distinct item/event/amount relevant to the question, with dates. Best for how-many / how-much / count / list / aggregate questions about the user\'s history. It never computes totals — count or sum the items yourself and prefer items with dates matching the question window. Identical questions over unchanged history replay from a content-addressed cache at zero model cost. Gated by RENOR_EVIDENCE_MODE (off | auto | always); call with force: true to run even when auto declines.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language question about the user\'s history' },
        topK: { type: 'number', description: 'Number of retrieval hits to return (1-100, default 20)' },
        force: { type: 'boolean', description: 'Run the second pass even when auto gating declines (ignored when mode is off)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'keyword',
    description: 'Exact keyword/BM25 search only: the query is matched as one exact phrase, and OR, AND, NEAR and * are plain words, not operators. Use search for identity and natural-language questions. Hyphens are quoted server-side. When the term appears in no chunk text, it is matched against note paths and frontmatter too, so a task id, slug or file name finds the note that carries it (reason: "note-identity").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Words to find, matched as one exact phrase: OR, AND, NEAR and * are plain words, not operators' },
        topK: { type: 'number', description: 'Number of results (1-50, default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'entity',
    description: 'Look up an entity (person, project, concept) by name or alias. Returns entity details or null.',
    inputSchema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Entity name or alias to look up' } },
      required: ['name'],
    },
  },
  {
    name: 'remember_fact',
    description: 'Durable memory write: stores (or supersedes) a fact about a subject. Ledger-first (survives index rebuild), temporal (closes the previous current fact for that subject+predicate). Returns a receipt. Use for "remember that…" statements. Confidence is not representable in the ledger.',
    inputSchema: {
      type: 'object' as const,
      // Every lifecycle field is a single-line STRING (the ledger framing rejects newlines and
      // control characters), so the descriptions say so explicitly: without them a model that
      // reads `object` as "the value" happily sends a list or a struct and gets back an opaque
      // type error instead of a stored fact.
      properties: {
        subject: { type: 'string', description: 'Who or what the fact is about, e.g. "Renor". A single string, not a nested object.' },
        predicate: { type: 'string', description: 'The relation or attribute being asserted, e.g. "works_at". A short single-line string.' },
        object: { type: 'string', description: 'The current value, e.g. "Memory Company". A single string: pass a list or a struct as ONE joined string, never as JSON or an array.' },
        source: { type: 'string', description: 'Ignored. The author is this connection\'s header-form name. When the connection has no usable name, the engine default (agent) is stored. Never a file path or document name.' },
      },
      required: ['subject', 'predicate', 'object'],
    },
  },
  {
    name: 'facts',
    description: 'All current lifecycle facts for an entity (name / entityName / subject; aliases). Prefer search for a natural-language question. asOf / includeHistory for temporal reads.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityName: { type: 'string', description: 'Entity name (also accepts name / subject)' },
        name: { type: 'string', description: 'Alias of entityName' },
        asOf: { type: 'string', description: 'ISO timestamp — facts valid at that time' },
        includeHistory: { type: 'boolean', description: 'include superseded facts' },
      },
    },
  },
  {
    name: 'status',
    description: 'Get vault index statistics: count of notes, chunks, entities, facts, and relations.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'note',
    description: 'Store a memory entry in the daily notes. Appends text to the daily note for the given date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to remember' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (defaults to today)' },
        source: { type: 'string', description: 'Ignored. The author is this connection\'s header-form name, or mcp when the connection has no usable name. Never a file path or document name.' },
      },
      required: ['text'],
    },
  },
];

/**
 * The declared output schema of each tool this server lists (MCP `outputSchema`), used when RENOR_TOOL_OUTPUT_SCHEMAS is on.
 * The five hive tools and the handoff note declare the hosted server's schemas, since both return the same objects from the
 * same functions. The eight tools above have no hosted counterpart, so their schemas describe what each one returns here.
 * Structured content must be an object: a reply that is an array or null is wrapped as { result } (see structuredOf).
 */
const OUTPUT_SCHEMAS: Record<string, z.ZodType> = {
  search: z.looseObject({ result: z.array(OUT_HIT).optional(), hits: z.array(OUT_HIT).optional(), composedContext: z.unknown().optional() }),
  evidence: z.looseObject({ query: z.string(), hits: z.array(OUT_HIT), evidence: z.unknown() }),
  keyword: z.looseObject({
    result: z.array(OUT_HIT).optional(), ok: z.boolean().optional(), error: z.string().optional(),
    detail: z.string().optional(), results: z.array(OUT_HIT).optional(),
  }),
  entity: z.looseObject({
    result: z.looseObject({
      id: z.number(), type: z.string(), canonicalName: z.string(), aliases: z.array(z.string()), sourceNote: z.string(), confidence: z.number(),
    }).nullable().optional(),
  }),
  facts: z.looseObject({ result: z.array(OUT_HIT) }),
  remember_fact: z.looseObject({ action: z.enum(['supersede', 'store', 'nochange']) }),
  status: z.looseObject({ notes: z.number(), chunks: z.number(), entities: z.number(), facts: z.number(), relations: z.number() }),
  note: z.looseObject({ ok: z.literal(true), path: z.string(), warning: z.string().optional(), detail: z.string().optional() }),
  whats_new: OUT_WHATS_NEW,
  ask_agent: OUT_ASK_AGENT,
  list_requests: OUT_LIST_REQUESTS,
  answer_request: OUT_REQUEST,
  close_request: OUT_REQUEST,
  [HANDOFF_TOOL_NAME]: OUT_HANDOFF,
};

/** A tool as this server lists it: with its outputSchema (as JSON Schema draft-07, which the SDK's validator reads) when on. */
function listedWithSchema<T extends { name: string }>(tool: T, on: boolean): T | (T & { outputSchema: Record<string, unknown> }) {
  const schema = OUTPUT_SCHEMAS[tool.name];
  if (!on || !schema) return tool;
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  return { ...tool, outputSchema: { ...json, type: 'object' as const } };
}

/**
 * structuredContent for a reply: the decoded value when the reply is an object, which is what a client parses from the text
 * block; an array or null reply (a list of hits, a fact list, a lookup that found nothing) is wrapped as { result }, since
 * structured content is an object. The text block is the same in both cases.
 */
function structuredOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { result: value };
}

/** Listed beside TOOLS only when the server has the handler, i.e. RENOR_HANDOFF_NOTE was on at startup. */
export const HANDOFF_TOOL = {
  name: HANDOFF_TOOL_NAME,
  description: HANDOFF_TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['read', 'write'], description: HANDOFF_ARG_DESCRIPTIONS.action },
      repo: { type: 'string', description: HANDOFF_ARG_DESCRIPTIONS.repo },
      branch: { type: 'string', description: HANDOFF_ARG_DESCRIPTIONS.branch },
      note: { type: 'string', description: HANDOFF_ARG_DESCRIPTIONS.note },
    },
    required: ['action', 'repo', 'branch'],
  },
};

/**
 * The stdin of the stdio server as lines the MCP transport can read, with a line that is not valid UTF-8 kept out.
 *
 * The transport decodes what it reads leniently, so an invalid byte would reach a tool as U+FFFD and be stored as
 * that. Each newline-terminated line is decoded strictly here instead; a line that fails is not passed on, and
 * `onInvalid` is told, so the caller can answer it. A frame is only ever checked whole: a multi-byte character split
 * across two reads is decoded once its line is complete.
 */
export function utf8Lines(source: Readable, onInvalid: () => void): Readable {
  const out = new PassThrough();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending: Buffer = Buffer.alloc(0);
  const pass = (line: Buffer): void => {
    try {
      decoder.decode(line);
    } catch {
      onInvalid();
      return;
    }
    out.write(line);
  };
  source.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      pass(pending.subarray(0, newline + 1));
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
  });
  source.on('end', () => {
    if (pending.length > 0) pass(pending);
    out.end();
  });
  source.on('error', err => out.destroy(err));
  return out;
}

/**
 * Wire TOOLS into a low-level MCP Server's `tools/list` and `tools/call` handlers.
 *
 * Extracted from startMcpServer so a test can drive the REAL protocol path — the same handlers
 * a stdio or gateway client reaches — instead of calling createMcpTools().remember_fact()
 * directly. A write-path regression asserted only on the internal function would pass even if
 * the published schema or the error envelope the client actually sees were wrong.
 */
export function registerMcpHandlers(server: Server, tools: ReturnType<typeof createMcpTools>): void {
  // Looked up by the name the client sent: an argument shape is the tool's own to check.
  const byName = tools as unknown as Record<string, ((args: unknown) => Promise<unknown>) | undefined>;
  const hive = HIVE_TOOLS.filter(tool => typeof byName[tool.name] === 'function');
  const handoff = typeof byName[HANDOFF_TOOL_NAME] === 'function' ? [HANDOFF_TOOL] : [];
  // Read once for this server, so the listing and the replies always agree (as the hosted server does).
  const env = { ...process.env };
  const carries = (name: string) => toolCarriesStructured(name, env);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS, ...hive, ...handoff].map(tool => listedWithSchema(tool, carries(tool.name))),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = byName[name];
    if (!handler) {
      if (HIVE_TOOLS.some(tool => tool.name === name)) {
        return { content: [{ type: 'text', text: `${name} is refused: this connection has no name. Set RENOR_CONNECTION_NAME to this agent's name before starting renor-engine mcp, then reconnect.` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await handler(args ?? {});
      // One line, as the hosted tools answer: indentation is tokens an agent pays for and reads nothing from.
      // Escaped as the hosted server escapes its replies (mvp/server.ts): stored text is untrusted, and a raw bidi
      // override or zero-width character would reach the agent's transcript unrendered.
      const text = escapeInvisibleControls(JSON.stringify(result));
      // A refusal or error is text only (the catch below), as the hosted server answers it.
      return { content: [{ type: 'text', text }], ...(carries(name) ? { structuredContent: structuredOf(JSON.parse(text)) } : {}) };
    } catch (err) {
      return { content: [{ type: 'text', text: escapeInvisibleControls(`Error: ${err instanceof Error ? err.message : String(err)}`) }], isError: true };
    }
  });
}

export async function startMcpServer(
  db: Database.Database,
  vectorIndex: VectorIndex | undefined,
  provider: EmbeddingProvider | undefined,
  config: Config
) {
  const server = new Server({ name: 'renor', version: ENGINE_VERSION }, { capabilities: { tools: {} } });
  const evidence = resolveEvidenceToolOptions(config);
  const tools = createMcpTools(db, vectorIndex, provider, config, evidence);

  registerMcpHandlers(server, tools);
  mapInvalidParams(server);

  // A frame that is not UTF-8 is not run: the transport would decode it as U+FFFD and a tool would store that.
  // utf8Lines answers such a frame itself, so the transport below only ever reads frames that passed the check.
  const stdin = utf8Lines(process.stdin, () => {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the frame is not valid UTF-8; nothing was run' },
    }) + '\n');
  });
  const transport = new StdioServerTransport(stdin);
  // The SDK reports a frame it cannot read to onerror and sends nothing back, so the client that sent it waits
  // forever. The request id is unreadable, so the reply carries id null: -32700 when the line is not JSON, -32600
  // when it is JSON but not one request (a batch, an invalid id, a bad envelope). Nothing else is written to stdout.
  transport.onerror = (error: Error) => {
    const code = error instanceof SyntaxError ? ErrorCode.ParseError
      : isZodError(error) ? ErrorCode.InvalidRequest
        : null;
    if (code === null) return;
    const reply = {
      jsonrpc: '2.0',
      id: null,
      error: { code, message: code === ErrorCode.ParseError ? 'Parse error' : 'Invalid Request' },
    };
    // The SDK's response type does not allow a null id, which the spec does for these two errors.
    transport.send(reply as unknown as JSONRPCMessage).catch(() => {});
  };
  await server.connect(transport);
}
