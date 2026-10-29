import { z } from 'zod';

/**
 * RENOR_TOOL_OUTPUT_SCHEMAS (on by default; `0` / `false` / `no` / `off` turns it off): the tools whose reply is small
 * (status, lookups, lists, write acknowledgements) list their `outputSchema` and also carry `structuredContent`. Off,
 * the tools listing and every reply are what they were before the schemas existed. Read once per server, so the
 * listing and the replies always agree. Shared by the hosted server (mvp/server.ts) and the self-hosted stdio server
 * (mcp/server.ts).
 *
 * The tools that return a memory page (PAGE_TOOLS) are the exception: structuredContent repeats the page, and a client
 * may pass both blocks to its model, so a page would be read twice. They stay text-only unless
 * RENOR_PAGE_OUTPUT_SCHEMAS is set to an on value (`1`, `true`, `yes`, `on`).
 */
export function toolOutputSchemasEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RENOR_TOOL_OUTPUT_SCHEMAS ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/** The page-returning tools of both servers: hosted names first, then the stdio server's. */
export const PAGE_TOOLS: ReadonlySet<string> = new Set([
  'get_context', 'search_memory', 'search_text', 'search_history', 'read_memory', 'memory_map', 'export_memory',
  'lookup_entity', 'retrieve_memory',
  'search', 'evidence', 'keyword', 'entity', 'facts',
]);

/** RENOR_PAGE_OUTPUT_SCHEMAS: off unless set to an on value. Only read together with toolOutputSchemasEnabled. */
export function pageOutputSchemasEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RENOR_PAGE_OUTPUT_SCHEMAS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Whether this tool lists its outputSchema and carries structuredContent under this environment. */
export function toolCarriesStructured(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!toolOutputSchemasEnabled(env)) return false;
  return !PAGE_TOOLS.has(name) || pageOutputSchemasEnabled(env);
}

/*
 * Shared pieces of the tools' declared output schemas (MCP `outputSchema`). Each tool declares the object it already
 * returns: the SDK validates the result's `structuredContent` against it, and clients read that as the structured result.
 * A field a reply does not always carry is optional, so a declared schema never refuses a reply the tool already produced.
 * Each top level is a loose object (additional properties allowed): a client that validates against the schema it listed
 * keeps accepting replies after a later release adds a field.
 */

/** One hit/excerpt a search or read returns; its own keys vary by reason, so only its object shape is fixed. */
export const OUT_HIT = z.record(z.string(), z.unknown());

/** The hive tools (whats_new, ask_agent, list_requests, answer_request, close_request) and the handoff note. Both servers
 * return these same objects from the same functions, so both declare these same schemas. */
export const OUT_WHATS_NEW = z.looseObject({
  items: z.array(OUT_HIT),
  as_of: z.string(),
  next_since: z.string().nullable(),
  cursor: z.string().nullable(),
  more_requests: z.number().optional(),
  more_requests_hint: z.string().optional(),
});
export const OUT_ASK_AGENT = z.looseObject({
  id: z.string(),
  status: z.enum(['open', 'answered', 'closed']),
  from_agent: z.string(),
  to_agent: z.string(),
  created_at: z.string(),
});
export const OUT_LIST_REQUESTS = z.looseObject({
  requests: z.array(OUT_HIT),
  more_requests: z.number().optional(),
  more_requests_hint: z.string().optional(),
});
/** answer_request and close_request reply with the request itself. */
export const OUT_REQUEST = z.looseObject({
  id: z.string(),
  scope: z.string().nullable(),
  from_agent: z.string(),
  to_agent: z.string(),
  question: z.string(),
  answer: z.string().nullable(),
  status: z.enum(['open', 'answered', 'closed']),
  created_at: z.string(),
  answered_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  untrusted: z.literal(true),
});
export const OUT_HANDOFF = z.looseObject({ ok: z.boolean(), action: z.enum(['read', 'write']) });
