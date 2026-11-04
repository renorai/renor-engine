import fs from 'node:fs';
import type { openReadOnlyDb as OpenRo } from './db/client.js';
import { openReadOnlyDb } from './db/client.js';
import { loadConfig } from './config.js';
import { walkVault } from './indexer/walker.js';
import { effectiveLevel, sharingDirFor } from './sharing/state.js';
import type { SharingLevel } from './sharing/fields.js';
import { ENGINE_VERSION } from './buildIdentity.js';

export interface EngineStatus {
  engineVersion: string;
  nodeVersion: string;
  memoryFolder: string;
  notes: number;
  facts: number;
  lastSaved: string | null;
  indexCurrent: boolean;
  /** Files on disk the index does not match (new, changed or half-indexed). */
  staleNotes: number;
  fix: string | null;
  search: 'keyword-only' | 'semantic';
  embeddingProvider: string;
  sharing: SharingLevel;
}

/** The folder or index cannot be opened: the one reason `status` exits 1. */
export class StatusError extends Error {}

/**
 * Reads the memory folder and its index and says whether the setup works. Reads only: no network call, no index
 * migration, no ledger replay, and no memory text in the answer.
 */
export async function engineStatus(env: NodeJS.ProcessEnv = process.env): Promise<EngineStatus> {
  const config = loadConfig();
  let isDir = false;
  try { isDir = fs.statSync(config.vaultPath).isDirectory(); } catch { /* reported below */ }
  if (!isDir) throw new StatusError(`the memory folder ${config.vaultPath} does not exist or is not a folder (set VAULT_PATH, or save a first memory)`);

  const files = await walkVault(config.vaultPath);
  let notes = 0;
  let facts = 0;
  let stale = files.length;
  let lastSaved: string | null = null;
  if (fs.existsSync(config.dbPath)) {
    let db: ReturnType<typeof OpenRo>;
    try {
      db = openReadOnlyDb(config.dbPath);
    } catch (err) {
      throw new StatusError(`the index ${config.dbPath} cannot be opened: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const rows = db.prepare('SELECT path, note_hash, modified_at FROM notes').all() as { path: string; note_hash: string; modified_at: string }[];
      const onDisk = new Set(files);
      const byPath = new Map(rows.map(r => [r.path, r]));
      notes = rows.length;
      facts = (db.prepare('SELECT COUNT(*) AS c FROM facts').get() as { c: number }).c;
      stale = 0;
      for (const file of files) {
        const row = byPath.get(file);
        let mtime = '';
        try { mtime = fs.statSync(file).mtime.toISOString(); } catch { /* gone */ }
        if (!row || row.note_hash === '' || row.modified_at !== mtime) stale++;
      }
      for (const row of rows) if (!onDisk.has(row.path)) stale++;
    } catch (err) {
      throw new StatusError(`the index ${config.dbPath} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      db.close();
    }
  }
  for (const file of files) {
    try {
      const t = fs.statSync(file).mtime.toISOString();
      if (lastSaved === null || t > lastSaved) lastSaved = t;
    } catch { /* gone */ }
  }
  const memoryDir = (env.MVP_MEMORY_DIR ?? '').trim();
  return {
    engineVersion: ENGINE_VERSION,
    nodeVersion: process.version,
    memoryFolder: config.vaultPath,
    notes,
    facts,
    lastSaved,
    indexCurrent: stale === 0,
    staleNotes: stale,
    fix: stale === 0 ? null : 'renor-engine index',
    search: config.embeddingProvider === 'none' ? 'keyword-only' : 'semantic',
    embeddingProvider: config.embeddingProvider,
    sharing: effectiveLevel(sharingDirFor(memoryDir === '' ? null : memoryDir, env, undefined), env),
  };
}

export function statusLines(s: EngineStatus): string[] {
  const lines = [
    `renor-engine ${s.engineVersion}, node ${s.nodeVersion}`,
    `memory folder: ${s.memoryFolder}`,
  ];
  if (s.notes === 0 && s.staleNotes === 0) {
    lines.push('memories: 0 notes, 0 facts. Nothing saved yet: save your first memory (remember something in your AI tool, or add a .md note to the folder), then run `renor-engine index`.');
  } else {
    lines.push(`memories: ${s.notes} notes, ${s.facts} facts; last saved ${s.lastSaved ?? 'never'}`);
  }
  lines.push(s.indexCurrent ? 'index: current' : `index: stale (${s.staleNotes} note(s) differ from the folder); fix: ${s.fix}`);
  lines.push(s.search === 'semantic' ? `search: semantic (${s.embeddingProvider})` : 'search: keyword-only (set EMBEDDING_PROVIDER=openai or local for semantic search)');
  lines.push(`sharing: ${s.sharing}`);
  return lines;
}
