import path from 'path';
import { assertImportNamespace, buildImportPlan } from './plan';
import { readExistingStreams } from './existing';
import { applyImportPlan, type ApplyResult } from './apply';
import { readSource } from './source';
import { writeBundle } from './bundle-write';
import { ImportBundle } from './types';
import { readMarkdownSource } from './markdown';
import type { GuardSkips } from './secretScreen';
import { isVendorKind, vendorSourcesEnabled } from './sources/vendor';

/**
 * `renor-import` — bring existing memory into a workspace.
 *
 * The source and the destination are explicit arguments: nothing here knows about a
 * particular machine, and nothing imports implicitly at startup. Default mode is a
 * dry-run plan; `--apply` is required to write. Output is metadata only — counts and
 * paths, never note text.
 */

interface CliOptions {
  from: string;
  to: string;
  sourceRoot?: string;
  contentRoot?: string;
  namespace: string;
  include: string[];
  exclude: string[];
  limit?: number;
  ledgerRel: string;
  dbPath?: string;
  apply: boolean;
  canonicalOnly: boolean;
  eventSource: string;
  json: boolean;
  emitBundle?: string;
}

const USAGE = `renor-import — import existing memory into a Renor workspace

Usage:
  renor-import --from <source> --to <workspace-memory-dir> [--apply] [options]

Source spec:
  markdown:<folder>               an Obsidian vault or Markdown folder; no source index needed.
                                   Uses the normal vault ignore rules and .semanticignore.
                                   Only lowercase .md files; no attachments or symlinks.
                                   A file or folder name that is not valid UTF-8 cannot be imported:
                                   such files are listed, not imported; every other note still is.
  renor-index:<path-to-index.db>   a Renor-shaped index (another workspace, or a personal
                                   brain). Opened READ-ONLY. Combine with --source-root.
  bundle:<path-to.jsonl>           a renor-memory-export/v1 bundle, so any provider can
                                   produce the input for this command.
  mem0:<file.json>                 a mem0 export (JSON array or {results:[...]} of memory records).
  zep:<file.json>                  a Zep fact export (JSON array or {facts:[...]}); a fact with invalid_at
                                   is imported as a dated, retired line. Files only; no vendor API is called.
                                   Both go through the same preview, secret screen and apply.
                                   RENOR_IMPORT_VENDOR_SOURCES=0 turns the two names off.

Destination:
  --source-root <dir>              directory the index's stored absolute paths live under
                                   (used to build the relative path).
  --content-root <dir>             tree holding the source's original Markdown (defaults to
                                   --source-root). Originals are carried byte-for-byte when
                                   present; a missing file falls back to reconstruction.

  --to <memory-dir>                the workspace's memory directory (its canonical store).
  --db <path>                      derived index path (default <memory-dir>/.memory-index/index.db)
  --ledger-rel <rel>               ledger path relative to the memory dir
                                   (default System/Memory Events Ledger.md)

Selection (both repeatable; applied to every source kind, by each record's own
relative path — for renor-index: that is relative to --source-root, for bundle: it is
the record's relPath):
  --include <prefix>               include only this prefix (paths are relative to the source
                                   root and must be matched by the note to be carried).
  --exclude <prefix>               exclude this prefix. Applied after --include.

Ledger-derived facts (the owner-stated memory, source path '_mcp_') are carried by default
because they are the smallest and highest-value set. Exclude them with --exclude _mcp_.
  --limit <n>                      cap the number of selected notes.

Writing:
  --namespace <rel>                additive destination subdirectory under Imported/
                                   (default Imported/<source>)
  --apply                          perform the writes (default: plan only)
  --canonical-only                 write Markdown + ledger events only; copy no index rows

Other:
  --event-source <label>           provenance recorded in the ledger (default import:<source>)
  --emit-bundle <file>             write the selected source as a renor-memory-export/v1
                                   JSONL bundle and exit. This is how an import runs where
                                   the workspace lives: export once from a source you can
                                   only read, then import the file next to the workspace.
  --json                           emit the machine-readable plan/summary only
  --help                           show this message
`;

export function parseArgv(argv: string[]): CliOptions | { help: true } {
  const options: Partial<CliOptions> = {
    namespace: '',
    ledgerRel: 'System/Memory Events Ledger.md',
    apply: false,
    canonicalOnly: false,
    json: false,
  };
  const include: string[] = [];
  const exclude: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--help': case '-h': return { help: true };
      case '--from': options.from = value(); break;
      case '--to': options.to = value(); break;
      case '--source-root': options.sourceRoot = value(); break;
      case '--content-root': options.contentRoot = value(); break;
      case '--namespace': options.namespace = value(); break;
      case '--include': include.push(value()); break;
      case '--exclude': exclude.push(value()); break;
      case '--limit': options.limit = Number(value()); break;
      case '--ledger-rel': options.ledgerRel = value(); break;
      case '--db': options.dbPath = value(); break;
      case '--event-source': options.eventSource = value(); break;
      case '--apply': options.apply = true; break;
      case '--canonical-only': options.canonicalOnly = true; break;
      case '--json': options.json = true; break;
      case '--emit-bundle': options.emitBundle = value(); break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }

  if (options.namespace) assertImportNamespace(options.namespace);
  if (!options.from) throw new Error('--from is required (see --help)');
  if (!options.to) throw new Error('--to is required (see --help)');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
    throw new Error('--limit must be a non-negative integer');
  }
  return { ...(options as CliOptions), include, exclude };
}

/** Source label used in the default namespace and provenance label. */
function sourceKindAndLabel(from: string): { kind: string; label: string } {
  const separator = from.indexOf(':');
  const kind = separator < 0 ? from : from.slice(0, separator);
  const target = separator < 0 ? '' : from.slice(separator + 1);
  // A vendor export is labelled by its product (Imported/mem0), not by whatever the file is called.
  if (isVendorKind(kind) && vendorSourcesEnabled()) return { kind, label: kind };
  const base = path.basename(target || kind).replace(/\.(db|jsonl|json)$/i, '');
  return { kind, label: base || kind };
}

/** The Markdown files a source could not carry because a file or folder name is not valid UTF-8. */
function printNotImported(names: string[], labelWidth: number) {
  if (names.length === 0) return;
  console.log(`  ${'not imported'.padEnd(labelWidth)}: ${names.length} Markdown file(s) whose file or folder name is not valid UTF-8`
    + ' (bad bytes are shown as \\xNN); rename them to UTF-8 names, then run the import again');
  for (const name of names.slice(0, 10)) console.log(`      ! ${name}`);
  if (names.length > 10) console.log(`      ! …and ${names.length - 10} more (--json lists them all)`);
}

/**
 * What the secret guard left out of the plan (RENOR_SECRET_GUARD is on): a path or a fact id and the field that
 * looked like a secret, never text. A path that itself looks like a secret is withheld.
 */
function printGuardSkips(skips: GuardSkips | undefined, labelWidth: number) {
  if (!skips || skips.notes.length + skips.events.length === 0) return;
  console.log(`  ${'secret guard'.padEnd(labelWidth)}: ${skips.notes.length} note(s) and ${skips.events.length} fact(s) not imported: they appear to`
    + ' contain a credential or personal identifier (RENOR_SECRET_GUARD is on); every other note still is');
  const lines = [
    ...skips.notes.map(skip => `${skip.ref ?? '(path withheld)'} (${skip.field}: ${skip.reason})`),
    ...skips.events.map(skip => `fact ${skip.ref} (${skip.field}: ${skip.reason})`),
  ];
  for (const line of lines.slice(0, 10)) console.log(`      ! ${line}`);
  if (lines.length > 10) console.log(`      ! …and ${lines.length - 10} more (--json lists them all)`);
}

export async function run(argv: string[]): Promise<number> {
  let options: CliOptions | { help: true };
  try {
    options = parseArgv(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return 2;
  }
  if ('help' in options) {
    console.log(USAGE);
    return 0;
  }

  const { label } = sourceKindAndLabel(options.from);
  const include = options.include ?? [];
  const exclude = options.exclude ?? [];
  const namespace = options.namespace || path.posix.join('Imported', label);
  const memoryDir = path.resolve(options.to);
  const dbPath = options.dbPath ?? path.join(memoryDir, '.memory-index', 'index.db');
  const ledgerPath = path.join(memoryDir, ...options.ledgerRel.split('/'));
  const eventSource = options.eventSource || `import:${label}`;

  let bundle: ImportBundle;
  try {
    const filter = {
      include,
      exclude,
      limit: options.limit,
      sourceRoot: options.sourceRoot,
      contentRoot: options.contentRoot,
      label,
    };
    if (options.from.startsWith('markdown:')) {
      const root = path.resolve(options.from.slice('markdown:'.length));
      // Do not recursively import the destination on a later run. Use real paths
      // for the source and nearest existing destination ancestor (including links).
      const fs = await import('fs');
      let ancestor = memoryDir;
      while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
      const destination = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, memoryDir));
      const source = fs.realpathSync(root);
      const contains = (parent: string, child: string) => {
        const rel = path.relative(parent, child);
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
      };
      if (contains(source, destination) || contains(destination, source)) {
        throw new Error('Markdown source and destination must be separate folders');
      }
    }
    bundle = options.from.startsWith('markdown:')
      ? await readMarkdownSource(options.from.slice('markdown:'.length), filter)
      : readSource(options.from, filter);
  } catch (err) {
    console.error(`source read failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const nonUtf8Names = bundle.nonUtf8Names ?? [];

  if (options.emitBundle) {
    const written = writeBundle(bundle, options.emitBundle);
    if (options.json) {
      console.log(JSON.stringify({
        mode: 'emit-bundle',
        source: { spec: options.from, label: bundle.sourceLabel, format: bundle.format },
        bundle: { file: options.emitBundle, bytes: written.bytes, records: written.records },
        counts: {
          notes: bundle.notes.length,
          chunks: bundle.stats.chunksSelected,
          facts: bundle.facts.length,
          notesWithOriginalBytes: bundle.stats.notesWithOriginalBytes,
          notesSkippedNonUtf8Name: nonUtf8Names.length,
        },
        skipped: { nonUtf8Names },
        warning: 'the bundle contains memory content; it is written 0600 and must not be committed',
      }, null, 2));
    } else {
      console.log('renor-import: EMIT BUNDLE');
      console.log(`  source      : ${options.from}`);
      console.log(`  bundle      : ${options.emitBundle} (${written.bytes} bytes, ${written.records} records)`);
      console.log(`  counts      : notes ${bundle.notes.length} (${bundle.stats.notesWithOriginalBytes} with original bytes), chunks ${bundle.stats.chunksSelected}, facts ${bundle.facts.length}`);
      printNotImported(nonUtf8Names, 12);
      console.log('  note        : the bundle contains memory content; it is written 0600 and must not be committed');
    }
    return 0;
  }

  const plan = buildImportPlan(bundle, {
    namespace,
    label,
    eventSource,
    existingStreams: readExistingStreams(dbPath, ledgerPath),
  });

  const warnings: string[] = [];
  if (options.from.startsWith('markdown:')) {
    warnings.push(
      'Only lowercase .md files are imported. Attachments and symlinks are not imported; '
      + 'vault ignore rules and .semanticignore apply. Markdown is preserved, but this import '
      + 'creates no extracted entities or structured facts, and makes no embedding call itself. '
      + 'Use search_text with an exact phrase from a note to verify recall.',
    );
  }
  if (plan.counts.multiValuedFactsDropped > 0) {
    warnings.push(
      `${plan.counts.multiValuedFactsDropped} fact row(s) belong to multi-valued streams: the `
      + `lifecycle layer holds at most one current value per subject+predicate, so they are `
      + `carried as notes only and not as current facts.`,
    );
  }
  warnings.push(
    'Embeddings are not transferred: a vector is bound to the model that produced it, so a vector from '
    + 'another model would be silent garbage rather than a saving. Imported notes are lexically '
    + '(full-text) searchable at once. Applied to a workspace with semantic search, the import marks '
    + 'its index unfinished: the workspace service embeds the imported notes with its own model, once, '
    + 'when it next starts, and its semantic search is off until they are embedded.',
  );
  warnings.push(
    'Each imported note row carries the hash of the exact bytes written, which is the indexer\'s own '
    + '"unchanged" condition. With no extraction lane armed (this workspace\'s configuration) a later '
    + 'index pass is therefore a no-op for imported notes: no re-chunk, no re-embed, no re-extract. '
    + 'If a fact/chronicle/preference extraction lane is armed later, its cache key is that same hash '
    + 'and the lane has no rows for these notes yet, so that pass would re-extract and re-embed them. '
    + 'Content is durable in Markdown and the ledger; the indexed rows are derived and a rebuild would '
    + 're-derive them.',
  );

  const summary: Record<string, unknown> = {
    mode: options.apply ? 'apply' : 'plan',
    source: { spec: options.from, label: bundle.sourceLabel, format: bundle.format },
    destination: { memoryDir, dbPath, ledgerRel: options.ledgerRel, namespace },
    selection: {
      include,
      exclude,
      limit: options.limit ?? null,
    },
    counts: {
      ...plan.counts,
      // What the selection actually removed, measured by the adapter rather than echoed
      // back from the flags. A filter that is silently ignored is indistinguishable from
      // a filter that matched nothing, and `--exclude` failing quietly is a privacy bug.
      notesFilteredOut: bundle.stats.notesFilteredOut,
      factsFilteredOut: Math.max(0, bundle.stats.factsAvailable - bundle.stats.factsSelected),
      eventsAlreadyInDestination: 0,
      notesSkippedNonUtf8Name: nonUtf8Names.length,
    },
    skipped: { ...plan.skipped, nonUtf8Names },
    warnings,
  };

  let exitCode = 0;
  let applied: ApplyResult | undefined;
  if (options.apply) {
    const result = await applyImportPlan(plan, bundle, {
      memoryDir,
      dbPath,
      ledgerRelPath: options.ledgerRel,
      canonicalOnly: options.canonicalOnly,
    });
    summary.applied = applied = result;
    summary.counts = {
      ...(summary.counts as Record<string, unknown>),
      eventsAlreadyInDestination: result.eventsAlreadyPresent,
    };
    summary.after = result.destination;
  } else {
    summary.after = null;
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const mode = options.apply ? 'APPLIED' : 'PLAN (dry run — pass --apply to write)';
    console.log(`renor-import: ${mode}`);
    console.log(`  source        : ${options.from} (label ${bundle.sourceLabel})`);
    console.log(`  destination   : ${memoryDir}`);
    console.log(`  namespace     : ${namespace}`);
    console.log(`  notes         : ${plan.counts.selectedNotes} selected of ${plan.counts.notesInBundle} in bundle`
      + ` (${plan.skipped.duplicateNotePath} duplicate path, ${plan.skipped.emptyNoteBody} empty)`);
    if (bundle.stats.notesFilteredOut > 0 || bundle.stats.factsAvailable > bundle.stats.factsSelected) {
      console.log(`  selection     : ${bundle.stats.notesFilteredOut} note(s) and `
        + `${bundle.stats.factsAvailable - bundle.stats.factsSelected} fact(s) left out by --include/--exclude/--limit`);
    }
    printNotImported(nonUtf8Names, 14);
    printGuardSkips(plan.skipped.secretGuard, 14);
    console.log(`  chunks        : ${plan.counts.selectedChunks} from the source parse (no re-chunking)`);
    console.log(`  note bytes    : ${plan.counts.notesFromOriginalBytes} carried verbatim, ${plan.counts.notesReconstructed} reconstructed from chunks`);
    if (plan.counts.chunksNotLocated > 0) {
      console.log(`      ! ${plan.counts.chunksNotLocated} chunk(s) not locatable in the carried bytes; ${plan.counts.chunksSpanInherited} inherited the source span, the rest have an unknown span`);
    }
    console.log(`  ledger events : ${plan.counts.eventsToAppend} new`
      + (applied ? ` (${applied.eventsAppended} appended, ${applied.eventsAlreadyPresent} already present)` : ''));
    console.log(`  facts         : ${plan.counts.factsInBundle} current in source, ${plan.counts.eventsToAppend} carried, `
      + `${plan.counts.multiValuedFactsDropped} multi-valued dropped, ${plan.counts.factsSkipped} other skips`);
    for (const skip of plan.skipped.events) {
      console.log(`      - ${skip.count} × ${skip.reason}`);
    }
    if (applied) {
      const dest = applied.destination;
      console.log(`  files         : ${applied.notesWritten} written, ${applied.notesUnchanged} already identical, ${applied.notesConflicting} conflicting (never overwritten or indexed)`);
      for (const conflict of applied.conflicts.slice(0, 10)) {
        console.log(`      ! conflict (left as-is, not indexed): ${conflict}`);
      }
      if (applied.conflicts.length > 10) {
        console.log(`      ! …and ${applied.conflicts.length - 10} more`);
      }
      console.log(`  index rows    : ${applied.indexRows.notesInserted} notes, ${applied.indexRows.chunksInserted} chunks, ${applied.indexRows.entitiesInserted} entities inserted`);
      console.log(`  replayed      : ${applied.ledgerReplayed} ledger event(s) applied to the index`);
      console.log(`  workspace now : notes ${dest?.notes} · chunks ${dest?.chunks} · entities ${dest?.entities} · facts ${dest?.facts} (${dest?.currentFacts} current)`);
    }
    for (const warning of warnings) console.log(`  note          : ${warning}`);
  }

  if (applied && applied.notesConflicting > 0) exitCode = 3;
  // Like a conflict, a note the guard left out is something the operator asked for that was not imported.
  const guardSkips = plan.skipped.secretGuard;
  if (options.apply && guardSkips && guardSkips.notes.length + guardSkips.events.length > 0) exitCode = 3;
  return exitCode;
}

/* c8 ignore start — process wiring; `run` above holds the testable behavior. */
if (require.main === module) {
  run(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(err => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
