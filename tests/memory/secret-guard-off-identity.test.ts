import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../src/db/sqlite';
import { scanSecrets } from '../../src/extraction/secretScanner';
import { BUNDLE_FORMAT, type ImportBundle, type ImportFact, type ImportNote } from '../../src/importing/types';
import type { ParsedConversation } from '../../src/conversation/types';
import type { MemoryMapContext } from '../../src/memorymap/memoryMap';
import { KEY_SHAPES, Rng, password } from '../../scripts/eval/secret-guard/plantedSet';
import { useCurrentDriver } from '../helpers/currentDriver';

// Wraps the real scanner so the tests can count its calls. The behaviour is unchanged.
vi.mock('../../src/extraction/secretScanner', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/extraction/secretScanner')>();
  return { ...actual, scanSecrets: vi.fn(actual.scanSecrets) };
});

/**
 * With RENOR_SECRET_GUARD off (set to 0, false, no or off) the guarded write paths do what they did before the
 * guard existed. Two proofs, and neither compares anything with a number written down on one machine:
 *
 * 1. DIFFERENTIAL. The tree without the guard is exported from git (the commit this change was built on: `git archive`,
 *    nothing is checked out), and both trees run the same scenarios in this one process, on identical inputs, with a fake
 *    clock and the same seeded random sequence, the guard off. Everything they leave is then compared: every file (the
 *    ledger, the daily notes, the retired-memory journal, the imported notes), every receipt and result, what the
 *    `renor-import` command prints and its exit code, and every table of the index database, row by row, in a fixed order.
 *    Whatever depends on the machine (its time zone: a frontmatter date becomes a fact whose text is `Date.toString()`; the
 *    temp directory; a retirement's random id) is the same on both sides or replaced before comparing, so the result cannot
 *    depend on where it runs. The reference is the code itself, not a hash of it.
 *
 *    The two trees are comparable only while the live `src/` differs from the base by the guard's own files. If `main` has
 *    moved on (another change to `src/`), or the base commit is not in this checkout (a shallow clone), the differential
 *    is skipped, and says why in the name of the skipped tests; the mechanism checks below still run.
 *
 * 2. MECHANISM, always. With the guard off the scanner is never called on any of the paths (it is wrapped by a spy), no
 *    refusal is logged, and the outcome does not depend on which "off" value is used.
 *
 * The guarded paths: `remember` and the daily-note writer; a bulk import (the plan, the apply, and the `renor-import`
 * command over a real folder); retiring and restoring a memory, including the record that ends an interrupted retirement;
 * and the conversation logger. Each is run over text that holds planted secrets.
 */

/** The commit the guard was built on: `main` without it. Used when `origin/main` is not known (no remote branch in the checkout). */
const PINNED_BASE = '441ca02f4f26d4fadd2599390a9ebb1f92bf3a52';
/** The files of `engine/src` this change touches. The two trees are comparable while these are the only difference. */
const GUARD_FILES = [
  'engine/src/conversation/writer.ts',
  'engine/src/extraction/secretGuard.ts',
  'engine/src/extraction/secretScanner.ts',
  'engine/src/importing/apply.ts',
  'engine/src/importing/cli.ts',
  'engine/src/importing/plan.ts',
  'engine/src/importing/secretScreen.ts',
  'engine/src/memory/lifecycle.ts',
  'engine/src/memory/writer.ts',
  'engine/src/memorymap/memoryMap.ts',
];

const ENGINE = path.resolve(__dirname, '../..');
const REPO = path.resolve(ENGINE, '..');
const LIVE_SRC = path.join(ENGINE, 'src');

// ----------------------------------------------------------------------------- the two trees
type Tree = {
  lifecycle: typeof import('../../src/memory/lifecycle');
  writer: typeof import('../../src/memory/writer');
  client: typeof import('../../src/db/client');
  schema: typeof import('../../src/db/schema');
  pipeline: typeof import('../../src/indexer/pipeline');
  plan: typeof import('../../src/importing/plan');
  apply: typeof import('../../src/importing/apply');
  importCli: typeof import('../../src/importing/cli');
  memoryMap: typeof import('../../src/memorymap/memoryMap');
  conversation: typeof import('../../src/conversation/writer');
};

/** Both trees are loaded the same way, by absolute path, so neither is treated differently. */
async function loadTree(src: string): Promise<Tree> {
  const load = (rel: string) => import(path.join(src, rel));
  const [lifecycle, writer, client, schema, pipeline, plan, apply, importCli, memoryMap, conversation] = await Promise.all([
    load('memory/lifecycle.ts'), load('memory/writer.ts'), load('db/client.ts'), load('db/schema.ts'), load('indexer/pipeline.ts'),
    load('importing/plan.ts'), load('importing/apply.ts'), load('importing/cli.ts'), load('memorymap/memoryMap.ts'), load('conversation/writer.ts'),
  ]);
  return { lifecycle, writer, client, schema, pipeline, plan, apply, importCli, memoryMap, conversation };
}

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The commit to compare with, or why there is none. */
function findBase(): { sha: string } | { why: string } {
  let sha = PINNED_BASE;
  try {
    sha = git('merge-base', 'HEAD', 'origin/main');
  } catch {
    // no origin/main in this checkout: the commit the guard was built on
  }
  try {
    git('cat-file', '-e', `${sha}^{commit}`);
  } catch {
    return { why: `${sha.slice(0, 8)} is not in this checkout's history (a shallow clone?)` };
  }
  // The differential compares a tree WITHOUT the guard with this one. Once the guard is on main (#573), a base that already has it
  // is not that tree (it refuses on its default, so the two sides cannot agree): the mechanism checks below are what still apply.
  try {
    git('cat-file', '-e', `${sha}:engine/src/extraction/secretGuard.ts`);
    return { why: `${sha.slice(0, 8)} already has the secret guard: there is no tree without it to compare` };
  } catch {
    // the base has no guard file: it is the tree without the guard
  }
  let changed: string[];
  try {
    changed = git('diff', '--name-only', sha, '--', 'engine/src').split('\n').filter(Boolean);
  } catch {
    return { why: 'git could not compare engine/src with the base' };
  }
  if (changed.length === 0) return { why: `engine/src is the same as ${sha.slice(0, 8)}: there is no guard in this tree to compare` };
  const other = changed.filter(file => !GUARD_FILES.includes(file));
  if (other.length > 0) {
    return { why: `main has moved on from ${sha.slice(0, 8)}: ${other.slice(0, 3).join(', ')}${other.length > 3 ? ', ...' : ''} differ too, so the guard is no longer the only difference` };
  }
  return { sha };
}

/** The plugin directory engine/src imports from (hooks/inert.cjs), for a base that already has it; an older base has no such path and `git archive` refuses a missing one. */
function pluginPaths(sha: string): string[] {
  return spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${sha}:engine/claude-code-plugin`]).status === 0 ? ['engine/claude-code-plugin'] : [];
}

/** `engine/src` of `sha`, exported from git into a temp directory (nothing in the checkout is touched). */
function exportSrc(sha: string): { dir: string; src: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'off-identity-base-'));
  const tar = execFileSync('git', ['-C', REPO, 'archive', '--format=tar', sha, 'engine/src', ...pluginPaths(sha)], { maxBuffer: 1 << 28 });
  const extracted = spawnSync('tar', ['-x', '-C', dir], { input: tar });
  if (extracted.status !== 0) throw new Error(`tar could not unpack the export of ${sha}`);
  fs.symlinkSync(path.join(ENGINE, 'node_modules'), path.join(dir, 'engine', 'node_modules'));
  const src = path.join(dir, 'engine', 'src');
  useCurrentDriver(src); // the same driver as the tree under test, in place of better-sqlite3 (tests/helpers/currentDriver.ts)
  return { dir, src };
}

// ----------------------------------------------------------------------------- what a run leaves, in a comparable form
const tmpDirs: string[] = [];
const mkdir = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `secret-guard-off-${tag}-`));
  tmpDirs.push(d);
  return d;
};

const r1 = new Rng(20261003);
const KEY = KEY_SHAPES.openai_proj(r1);
const TOKEN = KEY_SHAPES.github(r1);
const STRIPE = KEY_SHAPES.stripe(r1);
const WIFI = password(r1);
const CARD = '4242 4242 4242 4242';
const PLANTED = [KEY, TOKEN, STRIPE, WIFI, CARD];

/**
 * What depends on where a run happened, replaced so two runs can be compared: the directories it used, a retirement's
 * random id (also the name of the directory its note is moved into), and the planted secrets (so a failure never prints one).
 */
function scrubber(roots: string[]) {
  const rids = new Map<string, string>();
  return (text: string): string => {
    let out = text;
    for (const root of roots) out = out.split(root).join('<root>');
    PLANTED.forEach((secret, i) => { out = out.split(secret).join(`<secret-${i + 1}>`); });
    return out.replace(/(retired:|renor-retired\/files\/)([0-9a-f]{16})/g, (_all, lead: string, rid: string) => {
      if (!rids.has(rid)) rids.set(rid, `rid-${rids.size + 1}`);
      return `${lead}<${rids.get(rid)}>`;
    });
  };
}

/** Every file under `dir`, by relative path, with its text. The index database is compared by what it holds, below. */
function readTree(dir: string, scrub: (s: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (rel.startsWith('.memory-index')) continue;
      if (e.isDirectory()) walk(full);
      else out[scrub(rel)] = scrub(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Every table of the index database, row by row. Left out, because they differ between two runs of the SAME code: the
 * autoincrement ids and the columns that point at them (files are indexed concurrently, so which row is first varies), the
 * notes' file mtime, and the full-text index's own storage tables (the full-text tables themselves are compared by content).
 * Rows are sorted, so the order of insertion does not matter.
 */
function dumpDatabase(dbPath: string, scrub: (s: string) => string): Record<string, string[]> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>;
    const virtual = tables.filter(t => /^CREATE VIRTUAL TABLE/i.test(t.sql)).map(t => t.name);
    const shadow = (name: string) => virtual.some(v => name.startsWith(`${v}_`) && /^(data|idx|content|docsize|config)$/.test(name.slice(v.length + 1)));
    const out: Record<string, string[]> = {};
    for (const { name } of tables) {
      if (shadow(name)) continue;
      const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; type: string; pk: number }>)
        .filter(c => !(c.pk > 0 && /^INTEGER$/i.test(c.type)) && !(/^INTEGER$/i.test(c.type) && /(^|_)id$/.test(c.name)) && !(name === 'notes' && c.name === 'modified_at'))
        .map(c => c.name);
      if (columns.length === 0) continue;
      const rows = db.prepare(`SELECT ${columns.map(c => `"${c}"`).join(', ')} FROM "${name}"`).all();
      out[name] = rows.map(row => scrub(JSON.stringify(row))).sort();
    }
    return out;
  } finally {
    db.close();
  }
}

/** A fake clock and a seeded Math.random for one scenario, the same for every tree that runs it. */
async function inWorld<R>(seed: number, startIso: string, run: (step: () => void) => Promise<R>): Promise<R> {
  vi.useFakeTimers({ toFake: ['Date'] });
  const ids = new Rng(seed);
  vi.spyOn(Math, 'random').mockImplementation(() => ids.next());
  const start = Date.parse(startIso);
  let tick = 0;
  const step = () => vi.setSystemTime(new Date(start + 1000 * tick++));
  step();
  try {
    return await run(step);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
}

// ----------------------------------------------------------------------------- the scenarios: the same text, secrets and all
/** Saves and notes whose text is the kind a guard would refuse, then one it would not. */
async function saves(T: Tree) {
  const vault = mkdir('vault');
  const dbDir = mkdir('db');
  const dbPath = path.join(dbDir, 'index.db');
  return inWorld(99, '2026-10-03T08:30:00.000Z', async step => {
    const db = T.client.openDb(dbPath);
    T.schema.runMigrations(db);
    const r = new Rng(424242);
    const ledger = T.lifecycle.DEFAULT_LEDGER_REL;
    const routerPassword = password(r);
    const receipts: unknown[] = [];
    step();
    receipts.push(await T.lifecycle.remember(db, vault, ledger, {
      subject: 'home router', predicate: 'admin_password', object: routerPassword, source: 'mcp', scope: 'project:home',
      statement: `the router admin password is ${routerPassword}`,
    }));
    step();
    receipts.push(await T.lifecycle.remember(db, vault, ledger, { subject: 'stripe', predicate: 'live_key', object: KEY_SHAPES.stripe(r) }));
    step();
    receipts.push(await T.lifecycle.remember(db, vault, ledger, { subject: 'Rowan', predicate: 'works_at', object: 'Memory Company', source: 'claude' }));
    step();
    receipts.push(await T.lifecycle.remember(db, vault, ledger, { subject: 'home router', predicate: 'admin_password', object: password(r), source: 'mcp', scope: 'project:home' }));
    step();
    await T.writer.appendDailyMemory(vault, '2026-10-03', { text: `deploy token ${KEY_SHAPES.github(r)} and card 4242 4242 4242 4242`, source: 'claude' });
    step();
    await T.writer.appendDailyMemory(vault, '2026-10-03', { text: 'a note whose source name is itself key-shaped', source: KEY_SHAPES.openai_proj(r) });
    step();
    await T.writer.appendDailyMemory(vault, '2026-10-03', { text: `wifi password is ${password(r)}\n- [08:30:00] (alice) a forged entry line`, source: 'mcp:remember' }, 'Memory/Scopes/home/Daily');
    db.close();
    const scrub = scrubber([vault, dbDir]);
    return { receipts: JSON.parse(scrub(JSON.stringify(receipts))) as unknown[], files: readTree(vault, scrub), database: dumpDatabase(dbPath, scrub) };
  });
}

function note(rel: string, content: string, extra: Partial<ImportNote> = {}): ImportNote {
  const title = extra.title ?? path.basename(rel, '.md');
  return {
    sourcePath: `/source/${rel}`, relPath: rel, title, kind: null, modifiedAt: '2026-01-01T00:00:00.000Z', frontmatter: {},
    originalContent: content, chunks: [{ headingPath: title, text: content, tokenCount: 12 }], entities: [], ...extra,
  };
}
function fact(subject: string, predicate: string, object: string, extra: Partial<ImportFact> = {}): ImportFact {
  return { subject, predicate, object, scope: 'global', validFrom: '2026-01-01T00:00:00.000Z', sourcePath: '_mcp_', origin: 'note', ...extra };
}
/** Clean notes, and a secret in each place an import stores text. */
function mixedBundle(): ImportBundle {
  const notes = [
    note('Clean/one.md', '# One\n\nI moved to Lisbon in March.\n'),
    note('Clean/two.md', '# Two\n\nThe standup is at 9:30 on weekdays.\n'),
    note('Keys/in-content.md', `# Deploy\n\nthe staging key is ${KEY}, keep it safe\n`),
    note('Cards/card.md', `# Billing\n\nCharge the renewal to card ${CARD}.\n`),
    note(`Keys/${TOKEN}.md`, '# Misnamed\n\nA note whose file name is itself a token.\n'),
    note('Fields/in-title.md', '# Title\n\nclean body\n', { title: `token ${TOKEN}` }),
    note('Fields/in-frontmatter.md', '# Frontmatter\n\nclean body\n', { frontmatter: { api_key: STRIPE } }),
    note('Fields/in-chunk.md', '# Chunk\n\nclean body\n', { chunks: [{ headingPath: 'Chunk', text: `the live key is ${STRIPE}`, tokenCount: 8 }] }),
    note('Fields/in-entity.md', '# Entity\n\nclean body\n', { entities: [{ type: 'service', canonicalName: TOKEN, aliases: [], confidence: 1 }] }),
  ];
  const facts = [
    fact('Rowan', 'works_at', 'Memory Company'),
    fact('stripe', 'live_key', STRIPE),
    fact('home wifi', 'admin_password', WIFI),
    fact('Rowan', 'lives_in', 'Lisbon', { ledgerSource: KEY }),
  ];
  return {
    format: BUNDLE_FORMAT, sourceLabel: 'src', notes, facts,
    stats: { notesAvailable: notes.length, notesSelected: notes.length, notesFilteredOut: 0, notesWithOriginalBytes: notes.length, chunksSelected: notes.length, factsAvailable: facts.length, factsSelected: facts.length },
  };
}

/** Plan and apply a bundle that holds secrets. */
async function importPlanAndApply(T: Tree) {
  const dest = mkdir('import');
  return inWorld(5, '2026-10-03T09:00:00.000Z', async () => {
    const bundle = mixedBundle();
    const plan = T.plan.buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    const result = await T.apply.applyImportPlan(plan, bundle, { memoryDir: dest });
    const scrub = scrubber([dest]);
    return {
      plan: JSON.parse(scrub(JSON.stringify(plan))) as unknown,
      result: JSON.parse(scrub(JSON.stringify(result))) as unknown,
      files: readTree(dest, scrub),
      database: dumpDatabase(path.join(dest, '.memory-index', 'index.db'), scrub),
    };
  });
}

/** `renor-import` over a real folder, dry run and applied: everything it prints, its exit codes, and what it wrote. */
async function importCommand(T: Tree) {
  // The folder's name becomes the import's label, so it is named here and not by mkdtemp.
  const parent = mkdir('import-cli');
  const src = path.join(parent, 'src');
  const dest = path.join(parent, 'dest');
  fs.mkdirSync(src);
  fs.mkdirSync(dest);
  const put = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), body);
  };
  put('People/Ada.md', '# Ada\n\nAda leads the platform team and prefers short answers.\n');
  put('Ops/keys.md', `# Keys\n\nthe staging key is ${KEY}, keep it somewhere safe\n`);
  put('Billing/card.md', `# Billing\n\nCharge the renewal to card ${CARD}, exp 08/29.\n`);
  return inWorld(6, '2026-10-03T09:30:00.000Z', async () => {
    const said: string[] = [];
    const keep = (...a: unknown[]) => { said.push(a.join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(keep);
    vi.spyOn(console, 'warn').mockImplementation(keep);
    vi.spyOn(console, 'error').mockImplementation(keep);
    const scrub = scrubber([parent]);
    const dryCode = await T.importCli.run(['--from', `markdown:${src}`, '--to', path.join(dest, 'never-created'), '--namespace', 'Imported/src']);
    const dryOutput = scrub(said.splice(0).join('\n'));
    const code = await T.importCli.run(['--from', `markdown:${src}`, '--to', dest, '--apply', '--namespace', 'Imported/src']);
    const output = scrub(said.join('\n'));
    return { dryCode, dryOutput, code, output, files: readTree(dest, scrub), database: dumpDatabase(path.join(dest, '.memory-index', 'index.db'), scrub) };
  });
}

/** Retire and restore memories that hold secrets, then end an interrupted retirement of each kind. */
async function retireAndRestore(T: Tree) {
  const vault = mkdir('memmap');
  return inWorld(7, '2026-10-03T09:00:00.000Z', async step => {
    const db = T.client.openDb(path.join(vault, '.memory-index', 'index.db'));
    T.schema.runMigrations(db);
    const ctx: MemoryMapContext = { db, memoryDir: vault, ledgerRelPath: T.lifecycle.DEFAULT_LEDGER_REL, indexOptions: {} };
    const DAY = '2026-10-01';
    const daily = path.join(vault, 'Memory', 'Daily', `${DAY}.md`);
    const keysNote = path.join(vault, 'Projects', 'keys.md');
    fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
    fs.writeFileSync(keysNote, `# Keys\n\nthe deploy token is ${TOKEN}, do not share\n`);
    fs.writeFileSync(path.join(vault, 'Projects', 'plan.md'), '# Plan\n\nThe launch is on the 14th and Rachel owns the checklist.\n');
    step();
    await T.writer.appendDailyMemory(vault, DAY, { text: `the staging key is ${KEY}, keep it somewhere safe`, source: 'claude' });
    step();
    await T.writer.appendDailyMemory(vault, DAY, { text: 'Prefers short answers from agents', source: 'claude' });
    step();
    await T.pipeline.indexVault(db, vault, {});

    const idOf = async (kind: string, needle: string) => {
      const map = await T.memoryMap.buildMemoryMap(ctx);
      return map.memories.find(m => m.kind === kind && (m.excerpt.includes(needle) || m.title.includes(needle)))!.id;
    };
    const receipts: unknown[] = [];
    const entry = await idOf('entry', 'staging key');
    const clean = await idOf('entry', 'short answers');
    const keys = await idOf('note', 'Keys');

    // an entry: retired, restored, retired again, and then its bytes put back by hand. The next retirement or restore
    // starts by settling what an interruption left, and appends the record that ends this one.
    step(); receipts.push(await T.memoryMap.retireMemory(ctx, entry));
    step(); receipts.push(await T.memoryMap.restoreMemory(ctx, entry));
    const whole = fs.readFileSync(daily, 'utf8');
    step(); receipts.push(await T.memoryMap.retireMemory(ctx, entry));
    fs.writeFileSync(daily, whole);
    step(); receipts.push(await T.memoryMap.retireMemory(ctx, clean)); // settles the entry first
    step(); receipts.push(await T.memoryMap.restoreMemory(ctx, clean));
    // a note: retired and restored, then retired and moved back by hand, settled by the next retirement
    step(); receipts.push(await T.memoryMap.retireMemory(ctx, keys));
    step(); receipts.push(await T.memoryMap.restoreMemory(ctx, keys));
    step(); receipts.push(await T.memoryMap.retireMemory(ctx, keys));
    const retiredFiles = path.join(vault, '.trash', 'renor-retired', 'files');
    const stored = (fs.readdirSync(retiredFiles, { recursive: true }) as string[]).map(String).filter(f => f.endsWith('keys.md'));
    fs.renameSync(path.join(retiredFiles, stored[stored.length - 1]), keysNote);
    step(); receipts.push(await T.memoryMap.retireMemory(ctx, clean)); // settles the note first
    db.close();

    const scrub = scrubber([vault]);
    const files = readTree(vault, scrub);
    return {
      receipts: JSON.parse(scrub(JSON.stringify(receipts))) as unknown[],
      files,
      journal: files['.trash/renor-retired/retired.jsonl'] ?? '',
      database: dumpDatabase(path.join(vault, '.memory-index', 'index.db'), scrub),
    };
  });
}

const conversation = (text: string, title: string): ParsedConversation => ({
  sessionId: 'abc-123', title, timeStart: '2026-04-03T10:30:00.000Z', project: '/Users/test/project',
  turns: [{ role: 'user', text, toolCalls: [] }],
});

/** The logger writes a transcript that holds a key, one that holds a password and a card, and an ordinary one. */
async function conversationLogger(T: Tree) {
  const vault = mkdir('conversation');
  return inWorld(77, '2026-10-03T10:00:00.000Z', async () => {
    const r = new Rng(77);
    const written = [
      await T.conversation.writeConversation(vault, 'Claude Code/Conversations', conversation(`please use this key: ${KEY_SHAPES.anthropic(r)}`, 'Fix auth bug')),
      await T.conversation.writeConversation(vault, 'Claude Code/Conversations', conversation(`the wifi password is ${password(r)} and my card is ${CARD}`, 'Network notes')),
      await T.conversation.writeConversation(vault, 'Claude Code/Conversations', conversation('Please fix the login redirect, it loops.', 'Login loop')),
    ];
    const scrub = scrubber([vault]);
    return { written: written.map(p => scrub(path.relative(vault, p))), files: readTree(vault, scrub) };
  });
}

const SCENARIOS = { saves, importPlanAndApply, importCommand, retireAndRestore, conversationLogger } as const;
type ScenarioName = keyof typeof SCENARIOS;
const NAMES = Object.keys(SCENARIOS) as ScenarioName[];

// ----------------------------------------------------------------------------- the tests
const SAVED = process.env.RENOR_SECRET_GUARD;
// Unset is the default, which is ON. The off values are the explicit ones an operator writes.
const OFF: Array<string | undefined> = ['0', 'false', 'no', 'off', 'OFF', ' No '];
const SOME_OFF: Array<string | undefined> = ['0', 'off', 'no']; // the switch is one function: all of them are tried for saves
const label = (value: string | undefined) => `RENOR_SECRET_GUARD=${value === undefined ? '(unset)' : JSON.stringify(value)}`;
const setGuard = (value: string | undefined) => {
  if (value === undefined) delete process.env.RENOR_SECRET_GUARD;
  else process.env.RENOR_SECRET_GUARD = value;
};

const base = findBase();

let live: Tree;
let exported: { dir: string; src: string } | null = null;
let baseTree: Tree | null = null;

beforeAll(async () => {
  live = await loadTree(LIVE_SRC);
  if ('sha' in base) {
    exported = exportSrc(base.sha);
    baseTree = await loadTree(exported.src);
  }
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setGuard(SAVED);
});

afterAll(() => {
  if (exported) fs.rmSync(exported.dir, { recursive: true, force: true });
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe.skipIf('why' in base)(`with the secret guard off, the guarded paths leave exactly what the tree without the guard leaves${'why' in base ? ` (skipped: ${base.why})` : ''}`, () => {
  // Each scenario runs once on the tree without the guard; each "off" value then runs on this one, and they must agree.
  const reference = new Map<ScenarioName, Promise<unknown>>();
  const referenceFor = (name: ScenarioName) => {
    if (!reference.has(name)) {
      setGuard(undefined);
      reference.set(name, SCENARIOS[name](baseTree!));
    }
    return reference.get(name)!;
  };

  for (const name of NAMES) {
    for (const value of name === 'saves' ? OFF : SOME_OFF) {
      it(`${name}: every file, receipt, output and table row is the same, for ${label(value)}`, async () => {
        const expected = await referenceFor(name);
        setGuard(value);
        const actual = await SCENARIOS[name](live);
        expect(actual).toEqual(expected);
      }, 30_000);
    }
  }

  it('compares real content: the tree without the guard stores the planted secrets, the notes, the journal and the index rows', async () => {
    const saved = (await referenceFor('saves')) as Awaited<ReturnType<typeof saves>>;
    expect(saved.files['System/Memory Events Ledger.md']).toContain('admin_password');
    expect(saved.files['System/Memory Events Ledger.md']).toContain('the router admin password is ');
    expect(saved.files['Memory/Daily/2026-10-03.md']).toContain('deploy token ghp_');
    expect(saved.files['Memory/Daily/2026-10-03.md']).toContain('and card <secret-5>'); // the planted card number, replaced for comparing
    expect(Object.values(saved.database).flat().length).toBeGreaterThan(5);

    const imported = (await referenceFor('importPlanAndApply')) as Awaited<ReturnType<typeof importPlanAndApply>>;
    expect(Object.keys(imported.files).filter(f => f.startsWith('Imported/'))).toHaveLength(9);
    expect(imported.database.notes.length).toBeGreaterThanOrEqual(9);
    const cli = (await referenceFor('importCommand')) as Awaited<ReturnType<typeof importCommand>>;
    expect([cli.dryCode, cli.code]).toEqual([0, 0]);
    expect(Object.keys(cli.files).filter(f => f.endsWith('.md'))).toHaveLength(3);

    const mapped = (await referenceFor('retireAndRestore')) as Awaited<ReturnType<typeof retireAndRestore>>;
    const records = mapped.journal.trim().split('\n').map(l => JSON.parse(l) as { kind: string; block?: string; voided?: boolean; restoredAt?: string });
    expect(mapped.receipts).toHaveLength(9);
    expect(records.filter(x => x.voided).map(x => x.kind).sort()).toEqual(['entry', 'note']);
    expect(records.find(x => x.voided && x.kind === 'entry')?.block).toContain('staging key'); // the record keeps its block, as ever
    expect(records.filter(x => x.restoredAt).length).toBeGreaterThanOrEqual(3);

    const logged = (await referenceFor('conversationLogger')) as Awaited<ReturnType<typeof conversationLogger>>;
    expect(logged.written).toHaveLength(3);
    expect(Object.values(logged.files).some(text => text.includes('<secret-'))).toBe(true);
  }, 30_000);
});

describe('with the secret guard off, nothing on any guarded path reaches the scanner', () => {
  const scanned = () => vi.mocked(scanSecrets).mock.calls.length;

  for (const name of NAMES) {
    it(`${name}: the scanner is never called, no refusal is logged, and no "off" value changes the result`, async () => {
      const results: unknown[] = [];
      for (const value of SOME_OFF) {
        setGuard(value);
        vi.mocked(scanSecrets).mockClear();
        const logged: string[] = [];
        const original = console.warn;
        console.warn = (...args: unknown[]) => { logged.push(args.join(' ')); };
        try {
          results.push(await SCENARIOS[name](live));
        } finally {
          console.warn = original;
        }
        expect(scanned(), label(value)).toBe(0);
        expect(logged.filter(line => line.includes('secret_guard_refusal')), label(value)).toEqual([]);
      }
      for (const other of results.slice(1)) expect(other).toEqual(results[0]);
    }, 60_000);
  }

  it('and the spy is real: with the guard on, the same kind of save does reach the scanner and is refused', async () => {
    setGuard('1');
    vi.mocked(scanSecrets).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const vault = mkdir('on');
    await expect(live.writer.appendDailyMemory(vault, '2026-10-03', { text: `deploy token ${KEY_SHAPES.github(new Rng(3))}`, source: 'claude' })).rejects.toThrow(/Nothing was saved/);
    expect(scanned()).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(vault, 'Memory'))).toBe(false);
  });
});
