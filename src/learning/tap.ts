import { readBuildIdentity } from '../buildIdentity';
import path from 'node:path';
import { contextLeanItemsEnabled, replyTokens } from '../mvp/agentMemory';
import { normalizeScope } from '../mvp/scope';
import { RankingTrace, traceKey, type TraceEntry } from '../retrieval/rankingTrace';
import { CANDIDATE_KINDS, RANKER_BASELINE, RETRIEVAL_TOOLS, SAVE_TOOLS, WRITE_TOOLS } from './schema';
import type { SharingHook } from '../sharing/examples';
import type { LearningSettings } from './settings';
import type { ErasedLink } from '../memorymap/memoryMap';
import { learningLogAt, type CandidateRecord, type LearningLog, type MemoryOpRecord } from './store';

/**
 * Records what a successful MCP call did, from the reply the tool already built and, for a retrieval, the ranker's trace of
 * the same read (rankingTrace.ts): the candidates a retrieval served and the ones it scored but did not serve, with their terms,
 * positions and the budget's decision; the memory operation a save or retire made; and the cites a save named. It reads the reply,
 * the arguments and the trace; it never writes what they say. Text becomes a keyed hash (store.ts `key`), and the one exception,
 * the raw query, is kept only behind RENOR_LEARNING_RAW_QUERY.
 *
 * Failures are swallowed: a read or a save must never fail because the log could not be written.
 */

export interface LearningObserver {
  /**
   * `extra` is the MCP request's extra argument; the agent's name is read from it, never from the arguments. `trace` is the
   * ranker's trace of this call, when the call was a read that collected one.
   */
  observe(tool: string, args: unknown, result: unknown, ok: boolean, ms: number, extra?: unknown, trace?: RankingTrace): void;
  /**
   * Whether a call made now would be recorded: the log is on, or the sharing choice is above off. The server collects the
   * ranker's trace only when this is true, since nothing would be written with it. Read at each call, as `observe` reads it.
   */
  recordsNext(): boolean;
  /**
   * A permanent deletion's own account of what it removed (memoryMap.ts `ErasedLink`), read before the erase: the receipt names
   * a note or entry only as `retired:<random>`, which no key can be derived from. Removes every link the log holds to them.
   */
  erased(links: readonly ErasedLink[]): void;
}

export interface ObserverContext {
  /** `agent` for the MCP client; `dashboard` for the owner's dashboard, which the platform makes for the owner. */
  actor: 'agent' | 'dashboard';
  /** The MCP session's id, when the server keeps one. It is keyed before it is stored. */
  session: string | null;
  /** The embedding model identity in use (`<provider>:<model>:<dims>`), read at each call; null when retrieval is keyword only. */
  model: () => string | null;
  /** The name the connection presented (the server's agentOf), from the request's extra argument. 'unnamed' when it has none. */
  agent: (extra: unknown) => string;
  /**
   * Sharing (src/sharing): the user's choice to share signals or data. With it, recording is on whenever the choice is above
   * off, whatever RENOR_LEARNING_LOG says, and it is asked at every call, so a change takes effect on the next one. At `data`
   * the tap also hands it the query and the text of what a reply served or a save wrote (never the log). Absent: no change.
   */
  sharing?: SharingHook;
}

const RETRIEVAL_MODES = ['facts', 'hybrid', 'semantic', 'keyword'];
// A lane string: lane names joined by '+' (semantic+content+recency). Closed vocabulary from the product's own labels.
const REASON = /^[a-z][a-z0-9+-]{0,127}$/;
const MODEL = /^[A-Za-z0-9._:/+-]{1,120}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const MAX_CITES = 20;

type Kind = (typeof CANDIDATE_KINDS)[number] | 'event';
type Identity = { kind: Kind | 'unkeyed'; memoryKey: string | null };
/** What every row of one call carries: who called, in which session, and the operation's own timing. */
type CallBase = { actor: string; sessionKey: string | null; agentKey: string | null; tool: string; ms: number };

const norm = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const recordsOf = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRecord) : []);

let build: string | null | undefined;
/** The commit of the running build, read once; null when the build is unstamped. */
function buildCommit(): string | null {
  if (build === undefined) {
    const commit = readBuildIdentity().commit;
    build = COMMIT.test(commit) ? commit : null;
  }
  return build;
}

/** The reply as the tool built it: its JSON body and the text it was sent as (the text is what the token budget counted). */
function replyOf(result: unknown): { body: Record<string, unknown>; text: string } | null {
  if (!isRecord(result)) return null;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = isRecord(first) && typeof first.text === 'string' ? first.text : null;
  if (text !== null) {
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? { body: parsed, text } : null;
    } catch {
      return null;
    }
  }
  if (isRecord(result.structuredContent)) {
    return { body: result.structuredContent, text: JSON.stringify(result.structuredContent) };
  }
  return null;
}

/** The identity of a memory named by its id: `note:<path>`, `entry:<path>#<hash>` (its note) or `fact:<eventId>` (one fact's event). */
function identityOf(log: LearningLog, id: string): Identity {
  if (id.startsWith('note:')) return { kind: 'note', memoryKey: log.key('note', id.slice(5)) };
  if (id.startsWith('entry:')) {
    const hashAt = id.lastIndexOf('#');
    const notePath = hashAt > 6 ? id.slice(6, hashAt) : id.slice(6);
    return { kind: 'note', memoryKey: log.key('note', notePath) };
  }
  if (id.startsWith('fact:')) return { kind: 'event', memoryKey: log.key('event', id.slice(5)) };
  return { kind: 'unkeyed', memoryKey: null };
}

/**
 * A cite is a memory id (note:, entry: or fact:), a note's path, or a fact's subject: the save tools' own wording, and the same
 * three forms readUsefulness.ts matches. A bare string with a path's shape is a note; any other bare string is a subject, and a
 * subject is keyed within the scope of the save that names it, as a fact's subject is.
 */
/** How long after a retrieval a save about the same subject counts as an inferred use. */
const INFERRED_CITE_WINDOW_MS = 30 * 60_000;

function citeOf(log: LearningLog, cite: string, scope: string): { target: string; memoryKey: string | null; subjectKey: string | null } {
  const value = cite.trim();
  if (value === '') return { target: 'unkeyed', memoryKey: null, subjectKey: null };
  if (value.startsWith('note:') || value.startsWith('entry:')) {
    return { target: 'note', memoryKey: identityOf(log, value).memoryKey, subjectKey: null };
  }
  if (value.startsWith('fact:')) return { target: 'event', memoryKey: identityOf(log, value).memoryKey, subjectKey: null };
  if (/\.md$/i.test(value) || value.includes('/')) return { target: 'note', memoryKey: log.key('note', value), subjectKey: null };
  return { target: 'subject', memoryKey: null, subjectKey: log.key('subject', scope, norm(value)) };
}

/** A candidate with no ranker trace: the columns the ranker adds are null, and so are its positions and the budget's decision. */
const UNTRACED = { rank: null, base: null, terms: null, poolRank: null, windowPos: null, budgetKept: null } as const;

/** A fact as a retrieval served it: the memory is the scope, subject and predicate; the subject alone joins a cite that names it. */
function factCandidate(log: LearningLog, subject: unknown, fact: Record<string, unknown>): CandidateRecord {
  const predicate = typeof fact.predicate === 'string' ? fact.predicate : null;
  const scope = normalizeScope(typeof fact.scope === 'string' ? fact.scope : 'global');
  const current = typeof fact.current === 'boolean' ? fact.current : null;
  if (typeof subject !== 'string' || predicate === null) return unkeyed(null, null, current);
  return {
    ...UNTRACED,
    kind: 'fact',
    memoryKey: log.key('fact', scope, norm(subject), norm(predicate)),
    subjectKey: log.key('subject', scope, norm(subject)),
    sectionKey: null,
    score: null,
    reason: 'fact',
    matched: null,
    current,
    text: typeof fact.object === 'string' ? `${subject} ${predicate}: ${fact.object}` : null,
  };
}

/** A note hit: its path is the memory, its heading path (when there is one) the section within it. */
function noteCandidate(log: LearningLog, hit: Record<string, unknown>): CandidateRecord {
  const notePath = typeof hit.notePath === 'string' && hit.notePath !== '' ? hit.notePath : null;
  const headingPath = typeof hit.headingPath === 'string' && hit.headingPath !== '' ? hit.headingPath : null;
  const score = typeof hit.score === 'number' && Number.isFinite(hit.score) ? hit.score : null;
  const reason = typeof hit.reason === 'string' && REASON.test(hit.reason) ? hit.reason : null;
  const matched = hit.matched === false ? false : null;
  if (notePath === null) return unkeyed(score, reason, null, matched);
  return {
    ...UNTRACED,
    kind: 'note',
    memoryKey: log.key('note', notePath),
    subjectKey: null,
    sectionKey: headingPath === null ? null : log.key('section', notePath, headingPath),
    score,
    reason,
    matched,
    current: null,
    text: typeof hit.text === 'string' ? hit.text : null,
  };
}

function unkeyed(score: number | null, reason: string | null, current: boolean | null, matched: boolean | null = null): CandidateRecord {
  return { ...UNTRACED, kind: 'unkeyed', memoryKey: null, subjectKey: null, sectionKey: null, score, reason, matched, current };
}

/** A candidate the reply served, and the trace key of the note it is (null for a fact, which the ranker does not score). */
interface Served {
  record: CandidateRecord;
  traceKey: string | null;
  notePath: string | null;
  headingPath: string | null;
}

/** The candidates a reply served, in the order it served them. Facts come first, as the reply lists them. */
function servedOf(log: LearningLog, tool: string, body: Record<string, unknown>): Served[] {
  if (tool === 'retrieve_memory') {
    return recordsOf(body.facts).map(fact => ({ record: factCandidate(log, body.subject, fact), traceKey: null, notePath: null, headingPath: null }));
  }
  const notes = (items: Array<Record<string, unknown>>): Served[] => items.map(item => ({
    record: noteCandidate(log, item),
    notePath: typeof item.notePath === 'string' ? item.notePath : null,
    headingPath: typeof item.headingPath === 'string' ? item.headingPath : null,
    traceKey: typeof item.notePath === 'string' && item.notePath !== '' && typeof item.text === 'string'
      ? traceKey(item.notePath, typeof item.headingPath === 'string' ? item.headingPath : undefined, item.text)
      : null,
  }));
  if (tool === 'get_context') {
    return [
      ...recordsOf(body.facts).map(fact => ({ record: factCandidate(log, fact.subject, fact), traceKey: null, notePath: null, headingPath: null })),
      ...notes(recordsOf(body.memories)),
    ];
  }
  return notes(recordsOf(body.hits));
}

/** The ranker's record of a candidate, as the candidate row carries it. */
function tracedFields(entry: TraceEntry) {
  return { base: entry.base, terms: entry.terms, poolRank: entry.poolRank, windowPos: entry.windowPos, budgetKept: entry.budgetKept };
}

/**
 * The rows of one retrieval: each served candidate at its rank, then every candidate the ranker scored or presented that the reply
 * did not serve (rank null). A fact-lane hit (reason `fact`) is left out of the second group: a fact is recorded from its own row.
 */
function candidateRows(log: LearningLog, served: Served[], trace: RankingTrace | undefined): CandidateRecord[] {
  const rows: CandidateRecord[] = [];
  const servedKeys = new Set<string>();
  let servedNoteIndex = 0;
  served.forEach((item, index) => {
    if (item.traceKey !== null) servedKeys.add(item.traceKey);
    let entry = trace && item.traceKey !== null
      ? trace.byKey(item.traceKey) ?? (item.notePath === null ? undefined : trace.byLocation(item.notePath, item.headingPath))
      : undefined;
    if (!entry && trace && item.record.memoryKey !== null) {
      const sameNote = trace.all().filter(candidate => candidate.notePath !== ''
        && log.key('note', candidate.notePath) === item.record.memoryKey);
      if (sameNote.length === 1) [entry] = sameNote;
    }
    if (!entry && trace && item.notePath !== null) {
      const shownFile = path.basename(item.notePath);
      const sameFile = trace.all().filter(candidate => path.basename(candidate.notePath) === shownFile);
      if (sameFile.length === 1) [entry] = sameFile;
    }
    if (entry?.budgetKept === null && trace?.all().some(candidate => candidate.budgetKept !== null)) entry = undefined;
    if (!entry && trace && item.notePath !== null) {
      const hasBudget = trace.all().some(candidate => candidate.budgetKept !== null);
      entry = trace.all()
        .filter(candidate => hasBudget ? candidate.budgetKept === true : candidate.windowPos !== null)
        .sort((a, b) => a.windowPos! - b.windowPos!)[servedNoteIndex];
    }
    if (item.notePath !== null) servedNoteIndex++;
    if (entry) servedKeys.add(entry.key);
    rows.push({ ...item.record, rank: index + 1, ...(entry ? tracedFields(entry) : {}) });
  });
  if (trace) {
    for (const entry of trace.all()) {
      if (servedKeys.has(entry.key) || entry.reason === 'fact') continue;
      const score = entry.base + entry.terms.reduce((sum, term) => sum + term, 0);
      rows.push({
        ...tracedFields(entry),
        rank: null,
        kind: entry.notePath === '' ? 'unkeyed' : 'note',
        memoryKey: entry.notePath === '' ? null : log.key('note', entry.notePath),
        subjectKey: null,
        sectionKey: entry.notePath !== '' && entry.headingPath !== null ? log.key('section', entry.notePath, entry.headingPath) : null,
        score,
        reason: REASON.test(entry.reason) ? entry.reason : null,
        matched: null,
        current: null,
      });
    }
  }
  return rows;
}

function recordRetrieval(log: LearningLog, ctx: ObserverContext, base: CallBase, args: Record<string, unknown>,
  reply: { body: Record<string, unknown>; text: string }, ms: number, trace: RankingTrace | undefined): void {
  const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query : null;
  const relevance = isRecord(reply.body.relevance) ? reply.body.relevance : null;
  const model = ctx.model();
  const candidates = candidateRows(log, servedOf(log, base.tool, reply.body), trace);
  log.recordRetrieval({
    tool: base.tool,
    actor: base.actor,
    sessionKey: base.sessionKey,
    agentKey: base.agentKey,
    queryKey: query === null ? null : log.key('query', norm(query)),
    // The store keeps this only when the log was opened with rawQueries and the secret scanner passes it (store.ts).
    queryText: query,
    queryRedacted: false,
    scopeKey: log.key('scope', normalizeScope(typeof args.scope === 'string' ? args.scope : undefined)),
    retrieval: typeof reply.body.retrieval === 'string' && RETRIEVAL_MODES.includes(reply.body.retrieval) ? reply.body.retrieval : null,
    ranker: RANKER_BASELINE,
    model: model !== null && MODEL.test(model) ? model : null,
    build: buildCommit(),
    candidates,
    ms,
    replyTokens: replyTokens(reply.text),
    relevant: relevance !== null && typeof relevance.relevant === 'boolean' ? relevance.relevant : null,
    truncated: typeof reply.body.truncated === 'boolean' ? reply.body.truncated : null,
    leanItems: contextLeanItemsEnabled(),
  });
  if (ctx.sharing && ctx.sharing.level() === 'data') {
    if (query !== null) ctx.sharing.query(log.key('query', norm(query)), query);
    for (const candidate of candidates) {
      if (candidate.memoryKey !== null && candidate.text) ctx.sharing.memory(candidate.memoryKey, candidate.text);
    }
  }
}

function recordOp(log: LearningLog, base: CallBase, op: MemoryOpRecord['op'], kind: string, memoryKey: string | null,
  subjectKey: string | null, replacedKey: string | null = null): void {
  log.recordMemoryOp({ actor: base.actor, sessionKey: base.sessionKey, agentKey: base.agentKey, tool: base.tool, ms: base.ms,
    op, kind, memoryKey, subjectKey, replacedKey });
}

/**
 * A fact save (save_memory, or remember with subject, predicate and object): the value of one subject, predicate and scope.
 * A supersede is recorded as the operation it is, with the value it replaces. When the save names no cites and this session was
 * served that subject within the last 30 minutes, it is also recorded as an inferred cite (observed = 0): agents almost never
 * send `cites`, and a save about what was just recalled is the engine's own evidence that the recall was used. The product's
 * usage signal counts a supersede as a use too (readUsefulness.ts, `updated`).
 */
function factSave(log: LearningLog, ctx: ObserverContext, base: CallBase, action: unknown, scope: unknown, subject: unknown, predicate: unknown,
  object: unknown, namedCites = false): void {
  if (typeof subject !== 'string' || typeof predicate !== 'string') return;
  if (action !== 'store' && action !== 'supersede') return; // nochange: nothing was written
  const normalized = normalizeScope(typeof scope === 'string' ? scope : undefined);
  const memoryKey = log.key('fact', normalized, norm(subject), norm(predicate));
  const subjectKey = log.key('subject', normalized, norm(subject));
  if (!namedCites && log.servedWithin(base.sessionKey, memoryKey, subjectKey, INFERRED_CITE_WINDOW_MS)) {
    log.recordFeedback({ actor: base.actor, sessionKey: base.sessionKey, agentKey: base.agentKey, tool: base.tool,
      target: 'subject', memoryKey: null, subjectKey, observed: false });
  }
  if (typeof object === 'string' && ctx.sharing && ctx.sharing.level() === 'data') ctx.sharing.memory(memoryKey, `${subject} ${predicate}: ${object}`);
  if (action === 'supersede') recordOp(log, base, 'supersede', 'fact', memoryKey, subjectKey, memoryKey);
  else recordOp(log, base, 'create', 'fact', memoryKey, subjectKey);
}

/** A note save (remember or remember_note): the note is created, or it replaces the memory named by `replaces`. */
function noteSave(log: LearningLog, ctx: ObserverContext, base: CallBase, file: unknown, replaces: unknown, text: unknown): void {
  if (typeof file !== 'string' || file === '') return;
  const memoryKey = log.key('note', file);
  if (typeof text === 'string' && ctx.sharing && ctx.sharing.level() === 'data') ctx.sharing.memory(memoryKey, text);
  const replaced = typeof replaces === 'string' ? identityOf(log, replaces).memoryKey : null;
  if (replaced !== null) recordOp(log, base, 'supersede', 'note', memoryKey, null, replaced);
  else recordOp(log, base, 'create', 'note', memoryKey, null);
}

function recordWrite(log: LearningLog, ctx: ObserverContext, base: CallBase, args: Record<string, unknown>, body: Record<string, unknown>): void {
  const hasCites = Array.isArray(args.cites) && args.cites.length > 0;
  if ((SAVE_TOOLS as readonly string[]).includes(base.tool) && Array.isArray(args.cites)) {
    const scope = normalizeScope(typeof args.scope === 'string' ? args.scope : undefined);
    for (const cite of args.cites.filter((value): value is string => typeof value === 'string').slice(0, MAX_CITES)) {
      const named = citeOf(log, cite, scope);
      log.recordFeedback({
        actor: base.actor, sessionKey: base.sessionKey, agentKey: base.agentKey, tool: base.tool,
        target: named.target, memoryKey: named.memoryKey, subjectKey: named.subjectKey,
      });
    }
  }
  switch (base.tool) {
    case 'save_memory':
      factSave(log, ctx, base, body.action, args.scope, args.subject, args.predicate, args.object, hasCites);
      return;
    case 'remember':
      if (body.mode === 'fact') factSave(log, ctx, base, body.action, args.scope, args.subject, args.predicate, args.object, hasCites);
      else noteSave(log, ctx, base, body.file, args.replaces, args.statement);
      return;
    case 'remember_note':
      noteSave(log, ctx, base, body.file, args.replaces, args.text);
      return;
    case 'retire_memory': {
      if (typeof args.id !== 'string') return;
      const named = identityOf(log, args.id);
      if (body.action === 'retired') recordOp(log, base, 'delete', named.kind, named.memoryKey, null);
      else if (body.action === 'restored') recordOp(log, base, 'restore', named.kind, named.memoryKey, null);
      return;
    }
    case 'restore_memory':
    case 'delete_retired_memory':
    case 'read_memory': {
      if (typeof args.id !== 'string') return;
      if (base.tool === 'delete_retired_memory') {
        const erased = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [args.id];
        for (const id of erased) {
          const named = identityOf(log, id);
          if (named.memoryKey !== null) log.eraseMemory(named.memoryKey);
          recordOp(log, base, 'erase', named.kind, null, null);
        }
        return;
      }
      const named = identityOf(log, args.id);
      const op = base.tool === 'restore_memory' ? 'restore' : 'retrieve';
      recordOp(log, base, op, named.kind, named.memoryKey, null);
      return;
    }
    default:
  }
}

/** Records one call. Never throws: a failure to write is dropped, and the call it describes has already happened. */
function observeTool(log: LearningLog, ctx: ObserverContext, tool: string, rawArgs: unknown, result: unknown, ok: boolean, ms: number,
  extra: unknown, trace: RankingTrace | undefined): void {
  try {
    if (!ok) return;
    const retrieval = (RETRIEVAL_TOOLS as readonly string[]).includes(tool);
    const write = (WRITE_TOOLS as readonly string[]).includes(tool);
    if (!retrieval && !write) return;
    const reply = replyOf(result);
    if (reply === null) return;
    const args = isRecord(rawArgs) ? rawArgs : {};
    const base: CallBase = {
      actor: ctx.actor,
      sessionKey: ctx.session === null ? null : log.key('session', ctx.session),
      agentKey: log.key('agent', ctx.agent(extra)),
      tool,
      ms,
    };
    if (retrieval) recordRetrieval(log, ctx, base, args, reply, ms, trace);
    else recordWrite(log, ctx, base, args, reply.body);
  } catch {
    // Recording must never fail the call it describes.
  }
}

/**
 * The observer for one MCP server, or null when the log is off. Off means nothing is opened and no file is made: a server
 * without RENOR_LEARNING_LOG behaves exactly as it did before this module existed. With a sharing hook the observer exists
 * and decides at each call: a user who chose to share turns recording on, with no restart.
 */
export function learningObserver(settings: LearningSettings | undefined, ctx: ObserverContext): LearningObserver | null {
  if (settings === undefined) return null;
  // Without a sharing choice behind it, the log is on or off for the life of the process, as before.
  if (!settings.enabled && !ctx.sharing) return null;
  const sharing = ctx.sharing;
  let held: LearningLog | null = settings.enabled ? learningLogAt(settings) : null;
  return {
    recordsNext: () => settings.enabled || (sharing !== undefined && sharing.level() !== 'off'),
    erased: (links) => {
      if (!settings.enabled && (sharing === undefined || sharing.level() === 'off')) return;
      try {
        held ??= learningLogAt(settings);
        for (const link of links) {
          if (link.kind === 'note') {
            held.eraseMemory(held.key('note', link.path));
          } else {
            // A fact is keyed by what saves and retrievals name it by (scope, subject, predicate), and by its event for a read by id.
            held.eraseMemory(held.key('fact', normalizeScope(link.scope), norm(link.subject), norm(link.predicate)));
            held.eraseMemory(held.key('event', link.eventId));
          }
        }
      } catch {
        // Recording must never fail the call it describes.
      }
    },
    observe: (tool, args, result, ok, ms, extra, trace) => {
      // The sharing choice is read at each call: off records nothing and makes no file, anything above it records.
      if (!settings.enabled && (sharing === undefined || sharing.level() === 'off')) return;
      try {
        held ??= learningLogAt(settings);
      } catch {
        return;
      }
      observeTool(held, ctx, tool, args, result, ok, ms, extra, trace);
    },
  };
}
