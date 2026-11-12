import os from 'node:os';
import {
  APP_FAMILIES, DEPLOYMENTS, EMBEDDING_FAMILIES, LATENCY_BUCKETS, NODE_MAJORS, OS_FAMILIES, TOOL_PROFILES,
} from './fields';

/**
 * Where a shared row was made, reduced to closed lists before anything is written or sent (fields.ts CONTEXT_FIELDS).
 *
 * Every function here turns an open value (a client's declared name, a version string, a platform, an environment) into one entry of a
 * fixed list, or null. Nothing open-ended survives: a name that matches no family is `other`, a pre-release version is null. The learning
 * log stores the reduced value only, so the raw client name is never written anywhere by sharing.
 */

export type Deployment = (typeof DEPLOYMENTS)[number];
export type AppFamily = (typeof APP_FAMILIES)[number];
export type OsFamily = (typeof OS_FAMILIES)[number];
export type NodeMajor = (typeof NODE_MAJORS)[number];
export type ToolProfile = (typeof TOOL_PROFILES)[number];
export type EmbeddingFamily = (typeof EMBEDDING_FAMILIES)[number];
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number];

// For one name, the first family whose pattern matches. `claude-code` before `claude-ai`, since both say "claude".
const FAMILY_PATTERNS: ReadonlyArray<[Exclude<AppFamily, 'other'>, RegExp]> = [
  ['claude-code', /claude[\s_-]*code/i],
  ['cursor', /cursor/i],
  ['codex', /codex/i],
  ['chatgpt', /chatgpt|openai/i],
  ['hermes', /hermes/i],
  ['dsh', /(^|[^a-z0-9])dsh([^a-z0-9]|$)/i],
  ['claude-ai', /claude|anthropic/i],
];

/**
 * The AI application's family, from the names the connection presents: the MCP client's declared name (initialize's clientInfo.name),
 * the User-Agent, the connection's own name. `other` when there is a name and no family matches, null when there is no name at all.
 */
export function appFamily(names: ReadonlyArray<string | null | undefined>): AppFamily | null {
  const present = names.filter((name): name is string => typeof name === 'string' && name.trim() !== '' && name !== 'unnamed');
  if (present.length === 0) return null;
  // The names in the order given (the client's own declaration first): the first name that names a family decides.
  for (const name of present) {
    for (const [family, pattern] of FAMILY_PATTERNS) if (pattern.test(name.slice(0, 200))) return family;
  }
  return 'other';
}

/**
 * A released version as major.minor only (`1.4.2` and `1.4` are `1.4`); anything else (a pre-release, `unknown`, a fork's tag) is null. The
 * patch number is dropped on purpose: coarse values only (owner decision, 2026-11-08).
 */
export function releaseOf(version: string | null | undefined): string | null {
  const match = typeof version === 'string' ? /^([0-9]{1,3})\.([0-9]{1,3})(?:\.[0-9]{1,4})?$/.exec(version) : null;
  return match ? `${match[1]}.${match[2]}` : null;
}

export function osFamily(platform: string = process.platform): OsFamily {
  // The same list the install row uses (fields.ts OS_FAMILIES): Node's own platform names, anything else `other`.
  return (OS_FAMILIES as readonly string[]).includes(platform) && platform !== 'other' ? (platform as OsFamily) : 'other';
}

export function nodeMajor(version: string = process.versions.node): NodeMajor {
  const major = version.replace(/^v/, '').split('.')[0];
  return (NODE_MAJORS as readonly string[]).includes(major ?? '') && major !== 'other' ? (major as NodeMajor) : 'other';
}

/** The tool set a connection is given (mvp/tools/setup.ts): the connection's own `coding`, else RENOR_MCP_TOOLS. */
export function toolProfileOf(connection: 'coding' | null, env: NodeJS.ProcessEnv = process.env): ToolProfile {
  const tools = env.RENOR_MCP_TOOLS?.trim();
  if (tools === 'all') return 'full';
  if (connection === 'coding' || tools === 'coding') return 'coding';
  if (tools === 'lean') return 'lean';
  return tools ? 'custom' : 'full';
}

/** The provider family of an embedding model identity (`provider:model:dims`), `none` when there is none. */
export function embeddingFamily(modelKey: string | null | undefined): EmbeddingFamily {
  if (typeof modelKey !== 'string' || modelKey === '') return 'none';
  const provider = modelKey.split(':')[0] ?? '';
  return (EMBEDDING_FAMILIES as readonly string[]).includes(provider) && provider !== 'none' ? (provider as EmbeddingFamily) : 'other';
}

export function latencyBucket(ms: number | null | undefined): LatencyBucket | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 50) return '<50ms';
  if (ms < 200) return '<200ms';
  if (ms < 1000) return '<1s';
  if (ms < 5000) return '<5s';
  return '>=5s';
}

const truthy = (value: string | undefined): boolean => value !== undefined && /^(1|true|yes)$/i.test(value.trim());

/**
 * Whether this engine is Renor's own: RENOR_SHARING_INTERNAL=1 (set by Renor's gates, harnesses and its own hosted workspaces), or a
 * CI or test runner's own marker (CI=true, GITHUB_ACTIONS, VITEST, JEST_WORKER_ID, NODE_ENV=test). A real install sets none of these.
 * RENOR_SHARING_INTERNAL=0 says explicitly that it is not, whatever else the environment holds.
 */
export function sharingInternal(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.RENOR_SHARING_INTERNAL?.trim();
  if (explicit !== undefined && explicit !== '') return truthy(explicit);
  return truthy(env.CI) || truthy(env.GITHUB_ACTIONS) || (env.VITEST ?? '') !== '' || (env.JEST_WORKER_ID ?? '') !== '' || env.NODE_ENV === 'test';
}

/** What the sender stamps on every row: the same for every row it sends, because they are this install's. */
export interface SenderContext {
  deployment: Deployment;
  internal: boolean;
  /** null on cloud: Renor's own machine says nothing about the person. */
  os: OsFamily | null;
  node: NodeMajor | null;
}

export function senderContext(hosted: boolean, env: NodeJS.ProcessEnv = process.env): SenderContext {
  return {
    deployment: hosted ? 'cloud' : 'self-hosted',
    internal: sharingInternal(env),
    os: hosted ? null : osFamily(os.platform()),
    node: hosted ? null : nodeMajor(),
  };
}
