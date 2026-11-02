import { SESSION_EXPAND_REASON } from '../retrieval/orchestrator';

/**
 * MCP search_memory removes note hits below a raw-cosine floor after the facts lane fills the page.
 * The default is 0.63 only for Vertex gemini-embedding-001 at 768 dimensions; every other model defaults off.
 * Operator setting RENOR_SEARCH_HIT_FLOOR overrides either default; 0 restores the old response.
 * Facts, evidence, digests, ledger events and graph hits have no own cosine and stay. Session expansion
 * stays only while a matched hit from its note survives. Nothing is added, reordered or backfilled.
 * The three note hits with the highest similarity are never withheld, so a weak but best match still appears;
 * the floor only prunes the tail. get_context, HTTP API and CLI searches do not use this floor.
 */
export const SEARCH_HIT_FLOOR_DEFAULT = 0.63;
export const SEARCH_HIT_FLOOR_MODEL_KEY = 'vertex:gemini-embedding-001:768';
export const SEARCH_HIT_FLOOR_ENV = 'RENOR_SEARCH_HIT_FLOOR';

/** A cosine threshold never transfers between models or dimensions. Invalid settings use this model's default. */
export function searchHitFloor(modelKey: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const defaultFloor = modelKey === SEARCH_HIT_FLOOR_MODEL_KEY ? SEARCH_HIT_FLOOR_DEFAULT : 0;
  const value = env[SEARCH_HIT_FLOOR_ENV];
  if (value === undefined || value.trim() === '') return defaultFloor;
  const floor = Number(value);
  return Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : defaultFloor;
}

/** What a hit must carry to be judged: where it is, why it is on the page, and its own similarity when it has one. */
export interface FloorableHit {
  notePath: string;
  reason?: string;
  similarity?: number;
}

/** How many of the closest note hits the floor never removes. RENOR_SEARCH_HIT_FLOOR_KEEP overrides it; 0 is the plain floor. */
export const SEARCH_HIT_FLOOR_PROTECTED = 3;
export const SEARCH_HIT_FLOOR_KEEP_ENV = 'RENOR_SEARCH_HIT_FLOOR_KEEP';

/** The operator's count of protected closest hits: a whole number from 0 to 50, otherwise the default. */
export function searchHitFloorKeep(env: NodeJS.ProcessEnv = process.env): number {
  const value = env[SEARCH_HIT_FLOOR_KEEP_ENV];
  if (value === undefined || value.trim() === '') return SEARCH_HIT_FLOOR_PROTECTED;
  const keep = Number(value);
  return Number.isInteger(keep) && keep >= 0 && keep <= 50 ? keep : SEARCH_HIT_FLOOR_PROTECTED;
}

/**
 * `hits` without the ones found by meaning whose similarity is below `floor`, and without the statements the session
 * expansion added to a note none of whose matched hits is left. `withheld` counts every hit taken out. Order is kept.
 * The `keep` hits with the highest similarity (ties: earlier on the page) stay whatever their similarity.
 */
export function applyHitFloor<T extends FloorableHit>(hits: readonly T[], floor: number, keep: number = SEARCH_HIT_FLOOR_PROTECTED): { hits: T[]; withheld: number } {
  const closest = new Set(hits
    .map((hit, index) => ({ hit, index }))
    .filter(({ hit }) => typeof hit.similarity === 'number')
    .sort((a, b) => (b.hit.similarity as number) - (a.hit.similarity as number) || a.index - b.index)
    .slice(0, keep)
    .map(({ hit }) => hit));
  const below = new Set(hits.filter(hit => typeof hit.similarity === 'number' && hit.similarity < floor && !closest.has(hit)));
  const matched = new Set(hits.filter(hit => hit.reason !== SESSION_EXPAND_REASON && !below.has(hit)).map(hit => hit.notePath));
  const kept = hits.filter(hit => !below.has(hit) && (hit.reason !== SESSION_EXPAND_REASON || matched.has(hit.notePath)));
  return { hits: kept, withheld: hits.length - kept.length };
}

/** A kept note hit whose similarity is under the floor stayed only as one of the closest: marked so the reply says so. */
export function markWeakMatch<T extends object>(hit: T, floor: number): T | (T & { weak_match: true }) {
  const similarity = (hit as { similarity?: unknown }).similarity;
  return typeof similarity === 'number' && similarity < floor ? { ...hit, weak_match: true as const } : hit;
}
