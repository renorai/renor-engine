/**
 * Where a memory was said (`origin`) and whether it is about the user or about a project (`kind`): the two facts about a
 * save that the layered read (RENOR_LAYERED_SCOPE, docs/research/2026-11-08-memory-scope-architecture.md option d) decides
 * visibility by. Both are metadata: a save's origin never moves a note or changes a fact's scope.
 *
 * Node built-ins only: the Claude Code recall hook (autoRecall.ts) ships this compiled file next to itself, and the engine
 * uses the same rules, so the hook and the server can never derive two different origins for one directory.
 *
 * Origin forms, normalized lowercase:
 *   `github.com/owner/repo`  a git remote, host + path, without scheme, user or `.git`;
 *   `<folder>#<hash8>`       a git repository with no remote: its root folder name and a short hash of its absolute path,
 *                            so two unrelated `api/` folders are two origins;
 *   `chat:<client>`          a chat client with no repository (claude.ai, ChatGPT);
 *   `<slug>`                 a project scope's slug (`project:<slug>`), what x-renor-scope and the backfill of a named scope give.
 * No origin (null) means unknown: an item said nowhere in particular, read as today's global memory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type MemoryKind = 'personal' | 'project';

export const ORIGIN_HEADER = 'x-renor-origin';
/** The MCP request `_meta` key a client without headers (stdio, the in-process eval) may name its origin under. */
export const ORIGIN_META_KEY = 'renor/origin';

const MAX_ORIGIN = 200;

/** A client-sent origin in its one normal form, or null when it is empty or not a plausible origin. */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('chat:')) {
    const client = s.slice(5).replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return client ? `chat:${client.slice(0, 64)}` : null;
  }
  if (s.startsWith('project:') || s.startsWith('scope:')) s = s.slice(s.indexOf(':') + 1);
  const remote = originFromRemoteUrl(s);
  if (remote) return remote;
  s = s.replace(/[^a-z0-9._/#-]+/g, '-').replace(/\/+/g, '/').replace(/^[-/]+|[-/]+$/g, '');
  return s && s.length <= MAX_ORIGIN ? s : null;
}

/**
 * `host/owner/repo` from a git remote URL in any of its usual spellings (https, ssh://, scp-like git@host:owner/repo),
 * without credentials, port or `.git`; null when it is not one.
 */
export function originFromRemoteUrl(url: string): string | null {
  const u = url.trim();
  let host: string;
  let rest: string;
  const scp = /^(?:[^@/\s]+@)?([a-z0-9.-]+\.[a-z]{2,}):(?!\/\/)(.+)$/i.exec(u);
  const full = /^(?:[a-z+]+:\/\/)(?:[^@/\s]+@)?([a-z0-9.-]+)(?::\d+)?\/(.+)$/i.exec(u);
  const bare = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/(.+)$/i.exec(u);
  if (full) [host, rest] = [full[1], full[2]];
  else if (scp) [host, rest] = [scp[1], scp[2]];
  else if (bare && bare[1].includes('.') && !/\.(md|ts|js|json|txt)$/i.test(bare[1])) [host, rest] = [bare[1], bare[2]];
  else return null;
  const parts = rest.replace(/\.git\/?$/i, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const out = `${host}/${parts.join('/')}`.toLowerCase();
  return /^[a-z0-9._/-]+$/.test(out) && out.length <= MAX_ORIGIN ? out : null;
}

/** The repository root at or above `dir` (the directory holding `.git`), or null outside a repository. */
export function repoRootOf(dir: string): string | null {
  let at = path.resolve(dir);
  for (;;) {
    try {
      if (fs.existsSync(path.join(at, '.git'))) return at;
    } catch { return null; }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** The `.git` directory of a root: the directory itself, or what a worktree's `.git` file points to. */
function gitDirOf(root: string): string | null {
  const dotGit = path.join(root, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (!pointer) return null;
    const gitdir = path.resolve(root, pointer);
    // A worktree's gitdir is <main>/.git/worktrees/<name>; its config is the main repository's.
    const common = path.join(gitdir, 'commondir');
    return fs.existsSync(common) ? path.resolve(gitdir, fs.readFileSync(common, 'utf8').trim()) : gitdir;
  } catch { return null; }
}

/** The URL of remote `origin` (else the first remote) in a git config's text. */
export function remoteUrlFromConfig(text: string): string | null {
  let section: string | null = null;
  const urls = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (head) { section = head[1]; continue; }
    if (/^\s*\[/.test(line)) { section = null; continue; }
    const url = section ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1] : undefined;
    if (section && url && !urls.has(section)) urls.set(section, url);
  }
  return urls.get('origin') ?? urls.values().next().value ?? null;
}

const shortHash = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);

/**
 * The origin of a working directory: its repository's remote, else the repository root's folder name and a short hash of
 * its absolute path. Null outside a git repository (a home directory is not a project). Reads files only, never runs git.
 */
export function originFromDirectory(dir: string | undefined): string | null {
  if (!dir) return null;
  const root = repoRootOf(dir);
  if (!root) return null;
  const gitDir = gitDirOf(root);
  if (gitDir) {
    try {
      const url = remoteUrlFromConfig(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'));
      const remote = url ? originFromRemoteUrl(url) : null;
      if (remote) return remote;
    } catch { /* no config: the folder name below */ }
  }
  const name = path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `${name.slice(0, 64)}#${shortHash(root)}`;
}

/** The project's own name in an origin (the repository or folder), for the "names the repo" rule; null for a chat or none. */
export function originRepoName(origin: string | null | undefined): string | null {
  if (!origin || origin.startsWith('chat:')) return null;
  const last = origin.split('/').pop() ?? '';
  const name = last.split('#')[0];
  return name || null;
}

/** The repository owner of a remote origin (`github.com/owner/repo` → `github.com/owner`), or null. */
export function originOwner(origin: string | null | undefined): string | null {
  if (!origin || origin.startsWith('chat:')) return null;
  const parts = origin.split('/');
  return parts.length >= 3 ? parts.slice(0, -1).join('/') : null;
}

const FIRST_PERSON = /\b(i|i'm|im|i've|i'd|i'll|me|my|mine|myself)\b/i;
const USER_SUBJECTS = new Set(['user', 'me', 'i', 'owner', 'myself', 'the user']);
/** A file path or file name with an extension a project holds. */
const FILE_PATH = /(?:^|[\s`'"(])(?:\.{1,2}\/|\/)[\w.-]+|[\w.-]+\/[\w.-]+\/[\w./-]*|[\w-]+\/[\w-]+\.[a-z]{1,5}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|cpp|cs|php|json|ya?ml|toml|lock|md|sql|sh|env|tf|gradle|xml|html|css)\b/i;
/** A scoped package or a package manager / build tool by name. */
const PACKAGE = /@[\w-]+\/[\w.-]+|\b(?:npm|pnpm|yarn|bun|pip|poetry|cargo|gradle|maven|composer|gem|go mod|nuget|package\.json|dependency|dependencies|lockfile)\b/i;
/** A command: code in backticks, a flag, or a command line. */
const COMMAND = /`[^`]+`|(?:^|\s)--?[a-z][\w-]*\b|\b(?:npx|docker|kubectl|git)\s+[a-z-]+\b|\bmigrations?\b/i;
const BRANCH = /\b(?:branch|release\/[\w.-]+|feature\/[\w.-]+|pull request|PR\s*#?\d+)\b/i;
/** A service or code identifier: kebab-case or camelCase names, and the nouns of running software. */
const SERVICE = new RegExp([
  // kebab-case names of software (`ledger-api`, `web-v2`): a part that names a running thing, or a digit
  String.raw`\b[a-z0-9]+(?:-[a-z0-9]+)*-(?:api|app|web|service|svc|worker|gateway|server|proxy|cache|store|db|cli|sdk|ui|core|lib|bot|indexer|scheduler|relay|builder|console|engine|client|v\d+)\b`,
  String.raw`\b[a-z]+[0-9]*-[a-z0-9-]*[0-9][a-z0-9-]*\b`,
  String.raw`\b(?:service|api|endpoint|server|database|schema|repo|repository|codebase|ci|pipeline|staging|production|env var|environment variable|test suite)\b`,
].join('|'), 'i');
/** camelCase identifiers (`getUser`, `fetchJson`): case-sensitive, or every word would match. */
const CAMEL = /\b[a-z]+[A-Z][A-Za-z]+\b/;

export interface KindInput {
  /** The statement as saved (a note's text, or a fact's statement / `subject predicate object`). */
  text: string;
  subject?: string;
  /** Where it was said: a chat origin makes an undecided save personal, and the repository's own name counts as a project noun. */
  origin?: string | null;
}

export interface KindVerdict {
  kind: MemoryKind;
  /** Which rule decided: personal-first-person, project-noun, personal-chat or personal-default. */
  rule: 'personal-first-person' | 'project-noun' | 'personal-chat' | 'personal-default';
}

/** Whether `text` names something a project holds: a file path, package, command, branch, service, or the repo's own name. */
export function namesProject(text: string, origin?: string | null): boolean {
  if (FILE_PATH.test(text) || PACKAGE.test(text) || COMMAND.test(text) || BRANCH.test(text) || SERVICE.test(text) || CAMEL.test(text)) return true;
  const repo = originRepoName(origin);
  return Boolean(repo && repo.length >= 3 && new RegExp(`\\b${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
}

/**
 * The kind of a save, by rules only (no model call): first person, or a `user` subject, naming no project noun → personal;
 * naming a file path, package, command, branch, service or the repository's own name → project; said in a chat client →
 * personal; anything else → personal. Unsure is personal on purpose: a personal fact misfiled as project is hidden outside
 * its repository, while a project fact misfiled as personal is only shown somewhere it is not needed.
 */
export function classifyKind(input: KindInput): KindVerdict {
  const project = namesProject(input.text, input.origin);
  const subject = (input.subject ?? '').trim().toLowerCase();
  if ((FIRST_PERSON.test(input.text) || USER_SUBJECTS.has(subject)) && !project) return { kind: 'personal', rule: 'personal-first-person' };
  if (project || (subject && namesProject(subject, input.origin))) return { kind: 'project', rule: 'project-noun' };
  if (input.origin?.startsWith('chat:')) return { kind: 'personal', rule: 'personal-chat' };
  return { kind: 'personal', rule: 'personal-default' };
}
