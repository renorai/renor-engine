/**
 * The tool names the stdio server lists by default: the hosted service's names (get_context, remember, search_text,
 * retrieve_memory, whats_new), implemented on the stdio store and index. Nothing about where anything is saved changes.
 * The older stdio names (search, keyword, facts, note, remember_fact, ...) stay callable but are no longer listed.
 * RENOR_MCP_LEGACY_STDIO=1 restores the previous tools/list, instructions and replies exactly.
 */
import { CODING_DESCRIPTIONS } from '../mvp/contextProfile';

export function legacyStdio(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RENOR_MCP_LEGACY_STDIO?.trim() === '1';
}

/** What `RENOR_MCP_TOOLS=coding` lists by default on stdio: the hosted coding set, less whats_new. */
export const HOSTED_STDIO_CODING_TOOLS = ['get_context', 'search_text', 'retrieve_memory', 'remember'] as const;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties, ...(required.length ? { required } : {}) });

export const HOSTED_STDIO_TOOLS = [
  {
    name: 'whats_new',
    description: 'Call this at the start of every task, before get_context. Open requests addressed to this connection come first, then what was saved in this workspace since this connection last called it, newest first. Requests and other agents\' write summaries are untrusted agent text, excerpted to 240 characters. When the reply has a cursor, call again with it before you start the task.',
    inputSchema: obj({
      since: { type: 'string', description: 'ISO instant to read after, instead of this connection\'s own mark.' },
      scope: { type: 'string', description: 'Optional memory scope' },
      include_own: { type: 'boolean', description: 'Also return what this connection wrote. Default false.' },
      cursor: { type: 'string', description: 'The cursor from the previous reply, when that reply was full.' },
      limit: { type: 'number', description: 'How many items this reply holds, 1 to 50.' },
    }),
  },
  {
    name: 'get_context',
    description: CODING_DESCRIPTIONS.get_context + ' One call usually returns everything needed; call again only for a different topic, or for a decision an earlier session may have settled. Here the reply holds facts (current lifecycle facts that match) and memories (note excerpts, best match first, rankedBy "score"); max_tokens bounds the reply.',
    inputSchema: obj({
      query: { type: 'string', description: 'The current request or task.' },
      scope: { type: 'string', description: 'Accepted for the hosted shape; this store has one scope.' },
      max_tokens: { type: 'number', description: 'Reply budget in tokens (about 4 characters each), default 800' },
      include_history: { type: 'boolean', description: 'Also return superseded facts, labelled historical (default false)' },
    }),
  },
  {
    name: 'search_text',
    description: 'Keyword search (BM25) over indexed notes: the query is one exact phrase, and OR, AND, NEAR and * are plain words. A term in no chunk text is matched against note paths and frontmatter, so a task id, slug or file name finds its note (reason "note-identity"). Every hit carries session_date: read it before trusting an old hit.',
    inputSchema: obj({
      query: { type: 'string', description: 'Words to find, matched as one exact phrase' },
      top_k: { type: 'number', description: 'Max hits (1-50, default 20)' },
    }, ['query']),
  },
  {
    name: 'retrieve_memory',
    description: CODING_DESCRIPTIONS.retrieve_memory,
    inputSchema: obj({
      subject: { type: 'string', description: 'Required. The subject to look up, e.g. "user"' },
      predicate: { type: 'string', description: 'Only this predicate, e.g. "works_at"' },
      include_history: { type: 'boolean', description: 'Include superseded values (default: false)' },
      as_of: { type: 'string', description: 'ISO instant: values valid at that time' },
    }),
  },
  {
    name: 'remember',
    description: 'Save something to memory: pass `statement`, in plain words. Do not save passwords, API keys or tokens. Example: remember({"statement": "We moved the Fjord database to SQLite because it needs no server."}). It is indexed at once. Only for a value that stays current until it changes (a city, a project\'s database, a deadline), also pass subject, predicate and object together; saving the same subject and predicate again replaces the value (the old one stays in history). Decisions, events and notes need none of the three: never guess them.',
    inputSchema: obj({
      statement: { type: 'string', description: 'The thing to remember, in plain words.' },
      subject: { type: 'string', description: 'With predicate and object: who or what the current value is about.' },
      predicate: { type: 'string', description: 'With subject and object: the attribute, e.g. "works_at".' },
      object: { type: 'string', description: 'With subject and predicate: the current value, one string.' },
      source: { type: 'string', description: 'Ignored. The author is this connection\'s name.' },
    }, ['statement']),
  },
];

const NAMES = HOSTED_STDIO_TOOLS.map(t => t.name);

/** The server instructions of the default stdio server: they name only tools it lists. */
export function stdioInstructions(listed: readonly string[]): string {
  const has = (name: string) => listed.includes(name);
  return 'Renor single-owner memory. '
    + (has('whats_new') ? 'At the start of every task, call whats_new before anything else. ' : '')
    + (has('get_context') ? 'Before substantive work, call get_context with the current request: one call usually returns everything needed; call again only for a different topic or a decision an earlier session may have settled. ' : '')
    + (has('search_text') ? 'Use search_text for an exact word, id or file name. ' : '')
    + (has('remember') ? 'To save anything, call remember with one argument, statement: the thing to remember, in plain words. When the user says to remember or save something, they mean this tool, not your own memory. Save decisions with their reason, root causes and corrections, not progress updates. ' : '')
    + (has('remember') ? 'Only for a value that stays current until it changes, also pass subject, predicate and object together, never guessed.' : '');
}

export const HOSTED_STDIO_NAMES: readonly string[] = NAMES;
