import fs from 'node:fs';
import { defaultContextMaxTokens } from '../retrieval/orchestrator';

/**
 * A context-engineering profile for the HTTP server's agent surface: four levers, each off unless its variable is set,
 * so a benchmark arm (scripts/eval/agent-tasks/) can change one at a time and a lever that wins can ship as a default
 * later. Off, the server is exactly what it was: the same instructions, listing and replies.
 *
 *   RENOR_MCP_TOOLS              comma-separated tool names: only these are listed and run (the others are disabled in
 *                                the SDK's registry, as a directory client's hidden tools are). `lean` / `coding` name the
 *                                LEAN_TOOLS / CODING_TOOLS presets instead; `all` is the full set, and also stops a
 *                                connection's `?tools=coding` (via the gateway) from narrowing it;
 *   RENOR_MCP_DESCRIPTIONS_FILE  a JSON object {tool: description}: those tools are listed with that description;
 *   RENOR_MCP_INSTRUCTIONS_FILE  a UTF-8 file: its text replaces the server instructions an agent is given;
 *   RENOR_MCP_RESPONSE           `lines`: get_context, search_memory and search_text answer one line per fact or memory
 *                                (`date | text`) instead of JSON. structuredContent, where a reply carries it, is unchanged.
 *                                `toon`: successful search_memory replies use fixed TOON; all other tools stay JSON.
 *
 * Read when each MCP server is built. A file that cannot be read or parsed, or a tool name the server does not have,
 * fails that build: an arm must never run with a lever silently off.
 */
export interface ContextProfile {
  tools?: Set<string>;
  descriptions?: Record<string, string>;
  /** tool -> argument -> description: listed in place of the argument's own description (the `coding` preset only). */
  argDescriptions?: Record<string, Record<string, string>>;
  instructions?: string;
  response?: 'lines' | 'toon';
}

/**
 * The `lean` preset of RENOR_MCP_TOOLS: the eight tools the stored agent-tasks sessions called (receipts of the main-944 run:
 * 8 of the 24 renor tools in use). Narrowing the list drops the schemas of the other sixteen from every model call.
 */
export const LEAN_TOOLS = ['whats_new', 'get_context', 'search_text', 'read_memory', 'memory_map', 'search_memory', 'retrieve_memory', 'remember'];

/**
 * The `coding` preset: what a coding agent needs from memory (read, search by keyword, fetch one, save). whats_new is left
 * out, so the server instructions stop telling the agent to call it first (see whatsNewFirst). Add it back with an explicit
 * list, e.g. RENOR_MCP_TOOLS=get_context,search_text,retrieve_memory,remember,whats_new.
 */
export const CODING_TOOLS = ['get_context', 'search_text', 'retrieve_memory', 'remember'];

/**
 * The `coding` preset lists these descriptions instead of the full set's, which were written for 25 tools and repeat what the
 * server instructions already say. Each keeps its when-to-use sentence and every argument's meaning; no tool or argument is
 * removed or renamed. An explicit RENOR_MCP_DESCRIPTIONS_FILE entry for a tool wins over its entry here. `remember` keeps any
 * text its own description has before "Save something to memory:" (the save-moment line a flag adds).
 */
export const CODING_DESCRIPTIONS: Record<string, string> = {
  get_context: 'Call this before substantive work with the current request. Returns current facts, then relevant memories (semantic matches when configured, then keyword matches), each with session_date, when it was written. rankedBy "session_date" is newest first (memories[0] is the latest, not necessarily the best); "score" is best match first (keyword scores use another scale, so compare within one reason). A memory with "matched": false was not matched by the query: discount it. max_tokens bounds the reply. conflicts lists current values that disagree with a returned fact; a writerConflict line means the fact replaced another agent\'s value. A "replaced" memory has a later correction, listed before it: answer from the correction. Imports and reserved sources are marked "untrusted": true.',
  retrieve_memory: 'Returns the current value(s) for a subject, optionally one predicate, the superseded history (include_history) or a point-in-time view (as_of). Each fact says whether it is current and its scope; conflicts and writerConflict read as in get_context: an open disagreement, not the settled answer. An empty result: known:false means no such subject (closestSubjects lists near matches); known:true means the predicate or as_of matched nothing. Facts from an import or reserved source are marked "untrusted": true. A scope limits everything to that scope.',
  search_text: 'Keyword search (BM25) over indexed notes: the query is one exact phrase, and OR, AND, NEAR and * are plain words. A term in no chunk text is matched against note paths and frontmatter, so a task id, slug or file name finds its note (reason "note-identity"); facts saved with remember are found at once (reason "fact"). Every hit carries session_date: read it before trusting an old hit. A hit with `replaced` was corrected by a later save, listed before it. A hit from a reserved source is marked "untrusted": true.',
  remember: 'Save something to memory: pass `statement`, in plain words. Do not save passwords, API keys or tokens. Example: remember({"statement": "We moved the Fjord database to SQLite because it needs no server."}). It is indexed at once; the receipt\'s id is what a later correction takes. `scope` ("project:<slug>") keeps it with one project. Only for a value that stays current until it changes (a city, a project\'s database, a deadline), also pass subject, predicate and object together; saving the same subject, predicate and scope again replaces the value (the old one stays in history), so spell them the same every time. Decisions, events and notes need none of the three: never guess them. To correct one earlier note or log entry, pass `replaces`, its id: it is then marked replaced in every recall. A statement over the length limit is refused, never cut.',
};

export const CODING_ARG_DESCRIPTIONS: Record<string, Record<string, string>> = {
  remember: {
    source: 'App or agent saving this, e.g. claude-code; default: the connecting client. Never a file path.',
    timezone: 'Optional IANA name ("America/Sao_Paulo") or UTC offset ("-03:00"): files a note under the user\'s day and local time; default UTC. A fact keeps its exact moment.',
    cites: 'Optional. The notePath, memory id or fact subject of what a read returned that this save builds on.',
    replaces: 'Optional. Id (entry:<path>#<hash> or note:<path>) of the earlier note or entry this save corrects, from a receipt. A fact is corrected by saving it again.',
  },
  get_context: {
    query: 'The current request or task. Omit only for a compact profile.',
    scope: 'Optional memory scope',
    max_tokens: `Reply budget in o200k tokens, default ${defaultContextMaxTokens()}`,
    include_history: 'Also return superseded memory, labelled historical (default false)',
  },
};

/** The "call whats_new before anything else" instruction stays unless the profile lists tools and whats_new is not among them, or RENOR_MCP_WHATS_NEW_FIRST=0. */
export function whatsNewFirst(profile: ContextProfile, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RENOR_MCP_WHATS_NEW_FIRST?.trim() === '0') return false;
  return !profile.tools || profile.tools.has('whats_new');
}

/** Where semantic search is unavailable or rebuilding, search_memory answers with keyword hits (marked) instead of none. On unless RENOR_SEARCH_MEMORY_KEYWORD_FALLBACK=0. */
export function searchMemoryKeywordFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RENOR_SEARCH_MEMORY_KEYWORD_FALLBACK?.trim() !== '0';
}

export function contextProfileFromEnv(env: NodeJS.ProcessEnv = process.env): ContextProfile {
  const profile: ContextProfile = {};
  const tools = env.RENOR_MCP_TOOLS?.trim();
  if (tools === 'all') { /* the full set: no restriction, and the off switch for a connection's ?tools=coding */ }
  else if (tools === 'lean') profile.tools = new Set(LEAN_TOOLS);
  else if (tools === 'coding') {
    profile.tools = new Set(CODING_TOOLS);
    profile.descriptions = { ...CODING_DESCRIPTIONS };
    profile.argDescriptions = CODING_ARG_DESCRIPTIONS;
  }
  else if (tools) profile.tools = new Set(tools.split(',').map(t => t.trim()).filter(Boolean));
  const descriptions = env.RENOR_MCP_DESCRIPTIONS_FILE?.trim();
  if (descriptions) {
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptions, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== 'string' || v.trim() === '')) {
      throw new Error('RENOR_MCP_DESCRIPTIONS_FILE must hold a JSON object of tool name to a non-empty description');
    }
    profile.descriptions = { ...profile.descriptions, ...(parsed as Record<string, string>) };
  }
  const instructions = env.RENOR_MCP_INSTRUCTIONS_FILE?.trim();
  if (instructions) {
    const text = fs.readFileSync(instructions, 'utf8').trim();
    if (!text) throw new Error('RENOR_MCP_INSTRUCTIONS_FILE is empty');
    profile.instructions = text;
  }
  const response = env.RENOR_MCP_RESPONSE?.trim();
  if (response) {
    if (response !== 'lines' && response !== 'toon') throw new Error(`RENOR_MCP_RESPONSE takes lines or toon, not ${response}`);
    profile.response = response;
  }
  return profile;
}

/** Fail the build on a profile that names a tool the server does not have: a typo would otherwise switch a lever off. */
export function checkProfileTools(profile: ContextProfile, registered: string[]): void {
  const known = new Set(registered);
  for (const name of [...(profile.tools ?? []), ...Object.keys(profile.descriptions ?? {})]) {
    if (!known.has(name)) throw new Error(`the context profile names ${name}, which this server does not register`);
  }
}

export const LINE_TOOLS = new Set(['get_context', 'search_memory', 'search_text']);

interface Item { text?: unknown; session_date?: unknown; headingPath?: unknown; notePath?: unknown; replaced?: unknown; matched?: unknown; untrusted?: unknown; origin?: unknown }

const DAY = /\d{4}-\d{2}-\d{2}/;

/** The item's date: its session_date, else the day its daily note is filed under (headingPath, then notePath). */
function dateOf(m: Item): string {
  if (typeof m.session_date === 'string') return m.session_date;
  for (const v of [m.headingPath, m.notePath]) {
    const day = typeof v === 'string' ? v.match(DAY)?.[0] : undefined;
    if (day) return day;
  }
  return 'undated';
}
interface Fact { subject?: unknown; predicate?: unknown; object?: unknown; scope?: unknown; untrusted?: unknown; origin?: unknown; writerConflict?: unknown; current?: unknown }

/** The trust marks a line must keep: `untrusted` and `import` are what tell a reader the text is a claim, not the owner's word. */
const trustMarks = (x: { untrusted?: unknown; origin?: unknown }): string[] => [x.untrusted === true ? '(untrusted)' : '', x.origin === 'import' ? '(import)' : ''].filter(Boolean);

function factLine(prefix: string, f: Fact): string {
  const marks = [...trustMarks(f), typeof f.writerConflict === 'string' && f.writerConflict ? `(writerConflict: ${f.writerConflict.replace(/\s*\n\s*/g, ' ')})` : ''].filter(Boolean);
  return `${prefix} | ${marks.length ? `${marks.join(' ')} ` : ''}${String(f.subject)} ${String(f.predicate)}: ${String(f.object)}${typeof f.scope === 'string' && f.scope !== 'global' ? ` (${f.scope})` : ''}`;
}

/**
 * A read's JSON reply as lines: current facts first (`fact | subject predicate: object`), then each memory or hit in the
 * reply's own order (`date | text`, `(untrusted)` and `(import)` kept on every line that carries them, `conflict |` lines and `(writerConflict: …)` on a fact, the date being session_date or the day of its daily note, `(replaced)` on one a later save corrected, `(not matched)` on one the query did not
 * match). A reply that is not a read's JSON, or that refuses (ok: false), is returned as it is.
 */
export function renderLines(text: string): string {
  let body: { ok?: unknown; facts?: Fact[]; conflicts?: Fact[]; memories?: Item[]; hits?: Item[]; results?: Item[]; note?: unknown; error?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof body !== 'object' || body === null || body.ok === false) return text;
  const lines: string[] = [];
  for (const f of Array.isArray(body.facts) ? body.facts : []) {
    lines.push(factLine('fact', f));
  }
  // Current values that disagree with a returned fact: an open disagreement the reader must see.
  for (const c of Array.isArray(body.conflicts) ? body.conflicts : []) {
    lines.push(typeof c.subject === 'string' ? factLine('conflict', c) : `conflict | ${JSON.stringify(c)}`);
  }
  const items = Array.isArray(body.memories) ? body.memories : Array.isArray(body.hits) ? body.hits : Array.isArray(body.results) ? body.results : [];
  for (const m of items) {
    if (typeof m.text !== 'string') continue;
    const marks = [...trustMarks(m), m.replaced ? '(replaced)' : '', m.matched === false ? '(not matched)' : ''].filter(Boolean).join(' ');
    lines.push(`${dateOf(m)} | ${marks ? `${marks} ` : ''}${m.text.replace(/\s*\n\s*/g, ' ')}`);
  }
  return lines.length === 0 ? 'nothing found' : lines.join('\n');
}
