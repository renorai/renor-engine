/**
 * What a directory client (a claude.ai or chatgpt.com connector, which the gateway marks) is offered, beyond the hive tools it
 * never gets (server.ts HIVE_TOOLS).
 *
 * The directory rules ask a submitter to confirm that tool descriptions contain no instructions about model behaviour or other
 * tools. The descriptions in server.ts guide a named agent ("Call this before substantive work", "say you have no memory of it"),
 * which those agents rely on, so they stay as they are; a directory client is listed these instead, which say what each tool does
 * and returns. The listing is the only difference: a call runs the same code whichever text the client read.
 */
import { MAX_STATEMENT_LENGTH } from '../memory/limits';

/**
 * Tools a directory client is not offered: neither listed nor run. search_history reads a promoted-history folder a hosted
 * workspace does not have, so it could only answer "not configured". The others duplicate a listed tool (save_memory and
 * remember_note are remember with fewer choices) or are maintenance a hosted workspace does for itself (index_memory,
 * memory_status, lookup_entity), or change what the owner shares with Renor (sharing_level: a choice the directory rules would have to
 * review as an instruction to the model). Named agent keys keep all of them.
 */
export const DIRECTORY_HIDDEN_TOOLS = ['search_history', 'save_memory', 'remember_note', 'index_memory', 'memory_status', 'lookup_entity', 'sharing_level'] as const;

const NOT_FOR_SECRETS = 'Memory is kept as readable Markdown, so it is not a place for passwords, API keys or tokens.';

/** The description a directory client is listed for each tool, by tool name. A tool missing here keeps its own. */
export const DIRECTORY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  get_context:
    'Returns what the workspace holds that is relevant to a request: the current facts first, then the saved memories that match it, by meaning where semantic search is available and by keywords. '
    + 'Each memory carries session_date (when it was written) and a score: higher is closer, and keyword matches (reason "fts" or "note-identity") use their own scale. '
    + 'rankedBy names the order: "session_date" is newest first, "score" is best match first. '
    + 'relevance.relevant is false when nothing on file closely matches the request; the listed items are then only the nearest ones, not an answer. '
    + 'A memory marked replaced has a later correction, listed before it. A memory marked "matched": false came along with a matching note without matching itself. '
    + 'Facts saved by an import are marked "untrusted": true, and conflicts lists current values that disagree with a returned fact. The reply fits within max_tokens.',
  search_memory:
    'Searches the saved memories by meaning. Where semantic search is not available yet, the reply has no hits and says why (semantic-unavailable or semantic-rebuilding); keyword search keeps working meanwhile. '
    + 'Each hit carries a score (higher is closer) and session_date; rankedBy names the order: "session_date" (the default) is newest first, "score" is best match first. Saved facts that match are included. '
    + 'relevance.relevant is false when nothing on file closely matches the query; the hits are then only the nearest ones, not an answer. A hit marked replaced has a later correction, listed before it.',
  search_text:
    'Keyword search over the saved memories: the query is matched as one exact phrase (OR, AND, NEAR and * are plain words), with no call to an embedding service. '
    + 'A term found in no memory text is also matched against note paths and front matter (reason "note-identity"), and matching saved facts are included (reason "fact"). '
    + 'Each hit carries session_date, when that text was written. A hit marked replaced has a later correction, listed before it.',
  retrieve_memory:
    'Returns the current value of the saved facts about a subject, optionally for one predicate, with the full history of earlier values (include_history) or as they stood at a moment (as_of). '
    + 'Each value says whether it is current. A value that replaced one another agent saved carries a writerConflict line naming the replaced value: an open disagreement, not a settled answer. '
    + 'conflicts names current values that disagree. An empty result says whether the subject exists (known), and closestSubjects lists near matches. Without a subject, the reply lists the known subjects.',
  memory_map:
    'An overview of everything the workspace holds, for browsing: its memories (notes and daily-log entries), the things saved facts are about, topics, facts with their history, the links between them, recent saves, and retired memories, newest first, up to limit (default 20, at most 200). '
    + 'With query, only the memories and retired memories containing its words are returned, rarest words first: this is where the id of one memory is found, which read_memory, retire_memory and restore_memory take.',
  read_memory:
    'Returns one memory in full by its id (from memory_map or a save\'s receipt): its text, its note details (status, tags, dates), and the facts taken from it. session_date is when it was written.',
  export_memory:
    'Exports everything the workspace holds as portable Markdown (format renor-export/v1): every fact with its history, every daily-log entry, every note with its details, and everything retired. '
    + 'The reply is a JSON manifest (counts, the sections it carries, whether it is complete) and the document. A large workspace is paged, not cut: while the manifest says truncated or names nextSection or nextItem, the rest comes with section and offset. '
    + 'The search index, embeddings and activity are not exported; the manifest lists what is left out under notExported.',
  remember:
    'Saves one statement to memory in plain words and indexes it at once, so later recall finds it. The receipt\'s id identifies the saved memory, and scope ("project:<slug>") keeps it with one project. '
    + 'For a value that stays current until it changes (a city, a project\'s database, a deadline, a preference), subject, predicate and object can come with the statement: a later save of the same subject, predicate and scope replaces the value, and the earlier one stays in history. '
    + 'replaces, the id of an earlier note or log entry, marks that memory as corrected by this one, and nothing is deleted; with subject, predicate and object as well, the save is a plain-words correction of that note. '
    + `${NOT_FOR_SECRETS} A statement over ${MAX_STATEMENT_LENGTH} characters is refused.`,
  retire_memory:
    'Takes one memory (a note, a daily-log entry or a fact, by its id) out of recall without deleting it: it leaves every read and search at once, and restore_memory puts it back. '
    + 'Retiring a correction undoes its replaces link, so the memory it replaced reads as current again. A wrong value is corrected by saving the new one, which keeps history; retiring is for forgetting.',
  sharing_level:
    'Reads what this Renor shares with Renor to improve it (off, anonymous usage numbers, or everything including the memory text) and, when the user asks, lowers it. Raising it is never the agent\'s: only the user\'s own yes does: asked by the engine through their client for anonymous numbers, and given at a terminal for the memory text.',
  restore_memory:
    'Puts a retired memory back exactly as it was and re-indexes it. A file that now occupies the same path is not overwritten, and the restore is refused.',
  preview_import:
    'Dry run of an import of Markdown notes into Imported/<label>/. The server has no access to the user\'s disk: files arrive as files: [{ relativePath, markdown }], relativePath being the path inside the imported folder (notes/idea.md). '
    + 'Only .md files are imported, and names starting with "." are skipped. Returns counts, conflicts (a different file already at the destination is kept, not overwritten), skipped files with reasons, and a batchId that stays valid for 15 minutes; nothing is written to memory. '
    + 'Limits: 100 files, 64 KiB per file and 128 KiB per call, with up to 8 previews waiting at once. include and exclude select path prefixes; stage: false only checks.',
  apply_import:
    'Applies a batch from preview_import (its batchId, within 15 minutes). Additive: existing different files are kept and reported as conflicts. '
    + 'The notes are keyword-searchable at once, and searchable by meaning once they are embedded in the background. Returns the batchId undo_import takes; applying the same batch again changes nothing.',
  undo_import:
    'Undoes one import batch: the notes it created are retired, unless a later batch still holds the same content. Files that existed before, conflicts and later edits are kept, and the reply lists them.',
  // The hidden tools, in case one is offered again: a client listed one reads a description in the same terms.
  save_memory:
    'Saves one fact as subject, predicate and object, e.g. Fjord / database / SQLite. A later save of the same subject, predicate and scope replaces the value, and the earlier one stays in history. '
    + 'A value that replaces one another agent saved shows in reads with a writerConflict line until that agent saves it again. The receipt says store, supersede or nochange.',
  remember_note:
    'Appends one line to a day\'s log (today, or date), timestamped and indexed at once; the receipt\'s id identifies the line. replaces works as it does for remember. '
    + `${NOT_FOR_SECRETS} A line over ${MAX_STATEMENT_LENGTH} characters is refused.`,
  index_memory:
    'Indexes the workspace\'s Markdown notes for search: chunks, the keyword index, entities, and embeddings where configured. Saves are indexed as they happen; this pass covers everything, for example after a search reports index.stale. '
    + 'Files an embedding service cannot finish are reported (index-unfinished) and finished in the background.',
  memory_status:
    'Counts what the workspace holds (notes, chunks, entities, facts) and says whether search by meaning can answer now (semantic). While embeddings are being built, semantic is false, embeddingRebuild counts the chunks left, and keyword search works meanwhile.',
  lookup_entity:
    'Finds a person, project or concept by name or alias: the exact name, an alias, or part of a name or a note path, not words inside note text. A miss returns reason "no-entity-match" and the number of entities.',
  search_history:
    'Searches conversation notes imported from ChatGPT by their exact words. Available only where a folder of imported conversations is configured.',
};
