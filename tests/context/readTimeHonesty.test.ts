import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import request from 'supertest';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { insertStructuredRows, readCurrentRowsForNotes } from '../../src/context/rowStore';
import {
  READ_HONESTY_FLAG,
  readHonestyEnabled,
  contentTerms,
  evidenceCoverage,
  detectFactConflicts,
  currentFactsForSubjects,
  assessAbstention,
  applyReadHonesty,
  readHonestyForItems,
  conflictAcrossScopes,
  fitConflicts,
  querySubjects,
  factProvenance,
  noteProvenance,
  NO_ANSWER_STATEMENT,
  DEFAULT_EVIDENCE_BAR,
  type FactConflict,
} from '../../src/context/readHonesty';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { createMvpApp, type MvpApp } from '../../src/mvp/server';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * LANE 3 — read-time honesty: provenance, conflict detection, abstention.
 *
 * The user evidence (agent dogfood 2026-09-23):
 *   D2 — "which of two contradictory statements in the same document is
 *        current. Nothing surfaced the conflict. I caught it on a re-read."
 *   D6 — weak hits are returned instead of a clean "no good answer", which
 *        trains an agent to trust noise.
 *
 * Every behaviour below is asserted at the PUBLIC product surface (the remote
 * MCP `get_context` tool over a real HTTP /mcp call, and the real `renor
 * search --json` CLI), not only from internal helpers.
 */

const tmpDirs: string[] = [];
const apps: MvpApp[] = [];

afterEach(() => {
  while (apps.length) apps.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function mkdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lane3-honesty-'));
  tmpDirs.push(d);
  return d;
}

const LEDGER = 'System/Memory Events Ledger.md';

interface SeedOptions {
  /** Insert a note-derived (extractor-style) fact row. */
  noteFact?: { subject: string; predicate: string; object: string; validFrom: string; sourcePath: string };
  /** Insert a lifecycle (_mcp_) fact row. */
  lifecycleFact?: { subject: string; predicate: string; object: string; validFrom: string };
}

function seedDb(file: string, seed: SeedOptions = {}) {
  const db = openDb(file);
  runMigrations(db);
  const at = '2026-09-01T00:00:00.000Z';
  const addEntity = (name: string, sourceNote: string) =>
    (db
      .prepare(
        `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
         VALUES ('person', ?, '[]', ?, 1.0, ?) RETURNING id`,
      )
      .get(name, sourceNote, at) as { id: number }).id;
  const addFact = (entityId: number, predicate: string, object: string, sourcePath: string, validFrom: string) =>
    db
      .prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at)
         VALUES (?, ?, ?, ?, 1.0, ?, ?)`,
      )
      .run(entityId, predicate, object, sourcePath, validFrom, validFrom);

  if (seed.noteFact) {
    // A note row must exist for the FK-free facts table to be meaningful here.
    db.prepare(
      `INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
       VALUES (?, ?, 'note', 'h', ?, '{}')`,
    ).run(seed.noteFact.sourcePath, seed.noteFact.subject, seed.noteFact.validFrom);
    const id = addEntity(seed.noteFact.subject, seed.noteFact.sourcePath);
    addFact(id, seed.noteFact.predicate, seed.noteFact.object, seed.noteFact.sourcePath, seed.noteFact.validFrom);
  }
  if (seed.lifecycleFact) {
    db.prepare(
      `INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
       VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', ?, '{}')`,
    ).run(at);
    const id = addEntity(seed.lifecycleFact.subject, '_mcp_');
    addFact(id, seed.lifecycleFact.predicate, seed.lifecycleFact.object, '_mcp_', seed.lifecycleFact.validFrom);
  }
  return db;
}

describe('LANE 3: read-time honesty flag is default OFF', () => {
  it('RENOR_READ_HONESTY is off unless explicitly armed', () => {
    expect(readHonestyEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(readHonestyEnabled({ [READ_HONESTY_FLAG]: 'off' } as NodeJS.ProcessEnv)).toBe(false);
    expect(readHonestyEnabled({ [READ_HONESTY_FLAG]: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(readHonestyEnabled({ [READ_HONESTY_FLAG]: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('leaves the default get_context response contract byte-identical when off', async () => {
    // The strongest form of "default-off": not just "no new keys" but the exact
    // key set the shipped contract had, including on the fact items themselves.
    const body = await getContext('what runtime does FlagOffOwner prefer', {
      arm: false,
      after: async (call) => {
        const save = await call('save_memory', {
          subject: 'FlagOffOwner', predicate: 'prefers_runtime', object: 'Bun', source: 'x',
        });
        expect(save.ok).toBe(true);
      },
    });
    // `renor` (which Renor answered, B1) is on every get_context reply, with the lane on or off.
    expect(Object.keys(body).sort()).toEqual([
      'facts', 'maxTokens', 'memories', 'ok', 'query', 'renor', 'retrieval', 'scope', 'truncated',
    ]);
    expect(body.provenance).toBeUndefined();
    expect(body.conflicts).toBeUndefined();
    expect(body.abstention).toBeUndefined();
    expect(body.facts.length).toBeGreaterThan(0);
    expect(Object.keys(body.facts[0]).sort()).toEqual([
      'object', 'predicate', 'scope', 'subject', 'validFrom',
    ]);
  }, 120_000);

  it('is not one of the already-armed product flags (no default flip)', () => {
    // The lane adds a NEW flag; nothing about existing defaults changes.
    const before = { RENOR_SEARCH_EVIDENCE: '1' } as NodeJS.ProcessEnv;
    expect(readHonestyEnabled(before)).toBe(false);
  });
});

describe('LANE 3 behaviour 1: provenance on returned items', () => {
  it('names the source and the last-verified date', () => {
    const p = factProvenance('2026-09-02T10:00:00.000Z', LEDGER);
    expect(p.source).toBe(LEDGER);
    expect(p.lastVerified).toBe('2026-09-02T10:00:00.000Z');
    expect(p.kind).toBe('ledger');
  });

  it('never fabricates a date: unknown stays null', () => {
    expect(factProvenance(null, LEDGER).lastVerified).toBeNull();
    expect(factProvenance(undefined, LEDGER).lastVerified).toBeNull();
    const n = noteProvenance('Daily/2026-09-01.md');
    expect(n.source).toBe('Daily/2026-09-01.md');
    expect(n.lastVerified).toBeNull();
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('is attached to every item the product read returns (MCP get_context)', async () => {
    const body = await getContext('what runtime does ProvenanceOwner prefer', {
      after: async (call) => {
        const save = await call('save_memory', {
          subject: 'ProvenanceOwner',
          predicate: 'prefers_runtime',
          object: 'Bun',
          source: 'claude',
        });
        expect(save.ok).toBe(true);
      },
    });
    // Non-vacuous: the read actually returned the fact we are asserting about.
    expect(body.facts.length).toBeGreaterThan(0);
    for (const fact of body.facts as any[]) {
      expect(fact.provenance).toBeDefined();
      expect(typeof fact.provenance.source).toBe('string');
      expect(fact.provenance.source.length).toBeGreaterThan(0);
      expect('lastVerified' in fact.provenance).toBe(true);
      expect(fact.provenance.lastVerified).not.toBeUndefined();
    }
    // The item's own verification date is the fact's valid_from, not "now".
    const fact = (body.facts as any[]).find((f) => f.subject === 'ProvenanceOwner');
    expect(fact.provenance.lastVerified).toBe(fact.validFrom);
  }, 120_000);
});

describe('LANE 3 behaviour 2: read-time conflict detection', () => {
  it('flags two contradicting CURRENT values for the same subject+predicate', () => {
    const file = path.join(mkdir(), 'index.db');
    const db = seedDb(file, {
      noteFact: {
        subject: 'Machine',
        predicate: 'power_source',
        object: 'mains-powered, any power blip is a hard power-off',
        validFrom: '2026-09-01T00:00:00.000Z',
        sourcePath: 'Notes/Machine.md',
      },
      lifecycleFact: {
        subject: 'Machine',
        predicate: 'power_source',
        object: 'battery pack reporting 48.84 Wh at 100% design capacity',
        validFrom: '2026-09-02T00:00:00.000Z',
      },
    });
    try {
      const rows = currentFactsForSubjects(db, ['Machine']);
      expect(rows).toHaveLength(2);
      const conflicts = detectFactConflicts(rows);
      expect(conflicts).toHaveLength(1);
      const c = conflicts[0];
      expect(c.subject).toBe('Machine');
      expect(c.predicate).toBe('power_source');
      // Names BOTH values...
      expect(c.values).toHaveLength(2);
      // ...and says which is newer.
      expect(c.newer.value).toContain('48.84 Wh');
      expect(c.older.value).toContain('mains-powered');
      expect(c.newer.lastVerified).toBe('2026-09-02T00:00:00.000Z');
      expect(c.statement).toContain('Contradiction');
      expect(c.statement).toContain('48.84 Wh');
      expect(c.statement).toContain('mains-powered');
      // Both values are current in one scope, so the conflict keeps the shape it always had: a side names no scope.
      expect(Object.keys(c.newer).sort()).toEqual(['lastVerified', 'source', 'value']);
      expect(Object.keys(c.older).sort()).toEqual(['lastVerified', 'source', 'value']);
      expect(c.statement).toBe(
        'Contradiction on Machine / power_source: "battery pack reporting 48.84 Wh at 100% design capacity" (_mcp_, 2026-09-02T00:00:00.000Z) '
        + 'is newer than "mains-powered, any power blip is a hard power-off" (Notes/Machine.md, 2026-09-01T00:00:00.000Z). '
        + 'Both are current in the store — do not treat them as compatible.',
      );
    } finally {
      db.close();
    }
  });

  it('does not invent a conflict when two sources agree', () => {
    const file = path.join(mkdir(), 'index.db');
    const db = seedDb(file, {
      noteFact: {
        subject: 'Agree',
        predicate: 'runtime',
        object: 'Node.js',
        validFrom: '2026-09-01T00:00:00.000Z',
        sourcePath: 'Notes/Agree.md',
      },
      lifecycleFact: { subject: 'Agree', predicate: 'runtime', object: 'node.js', validFrom: '2026-09-02T00:00:00.000Z' },
    });
    try {
      // Same value modulo case/normalization: agreement, not contradiction.
      expect(detectFactConflicts(currentFactsForSubjects(db, ['Agree']))).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('ignores superseded (non-current) rows and other predicates', () => {
    const file = path.join(mkdir(), 'index.db');
    const db = seedDb(file, {
      noteFact: {
        subject: 'Mixed',
        predicate: 'home',
        object: 'Port Alder',
        validFrom: '2026-09-01T00:00:00.000Z',
        sourcePath: 'Notes/Mixed.md',
      },
    });
    try {
      const entityId = (db.prepare(`SELECT id FROM entities WHERE canonical_name = 'Mixed'`).get() as { id: number }).id;
      // A CLOSED (superseded) row disagrees but must not be reported: history is not a conflict.
      db.prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at)
         VALUES (?, 'home', 'Sao Paulo', 'Notes/Mixed.md', 1.0, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      ).run(entityId);
      // A different predicate is a different claim entirely.
      db.prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at)
         VALUES (?, 'works_at', 'Somewhere Else', 'Notes/Mixed.md', 1.0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      ).run(entityId);
      expect(detectFactConflicts(currentFactsForSubjects(db, ['Mixed']))).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('names a contradiction across scopes to a read that names no scope, and compares a scoped read within its scope', () => {
    const file = path.join(mkdir(), 'index.db');
    const db = seedDb(file, {
      noteFact: {
        subject: 'Scoped',
        predicate: 'runtime',
        object: 'Bun',
        validFrom: '2026-09-01T00:00:00.000Z',
        sourcePath: 'Notes/Scoped.md',
      },
    });
    try {
      const entityId = (db.prepare(`SELECT id FROM entities WHERE canonical_name = 'Scoped'`).get() as { id: number }).id;
      db.prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at, scope)
         VALUES (?, 'runtime', 'Node.js', 'Notes/Other.md', 1.0, '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 'project:alpha')`,
      ).run(entityId);
      // A read that names no scope sees every scope, so one question has two current answers there, and each side says
      // which scope it is current in: the rule get_context's default conflicts follow (memory scout finding 13).
      const everywhere = detectFactConflicts(currentFactsForSubjects(db, ['Scoped']));
      expect(everywhere).toHaveLength(1);
      expect(everywhere[0].values).toEqual(['Node.js', 'Bun']);
      expect(everywhere[0].newer).toEqual({ value: 'Node.js', source: 'Notes/Other.md', lastVerified: '2026-09-02T00:00:00.000Z', scope: 'project:alpha' });
      expect(everywhere[0].older).toEqual({ value: 'Bun', source: 'Notes/Scoped.md', lastVerified: '2026-09-01T00:00:00.000Z', scope: 'global' });
      expect(everywhere[0].statement).toBe(
        'Contradiction on Scoped / runtime: "Node.js" (Notes/Other.md, scope project:alpha, 2026-09-02T00:00:00.000Z) '
        + 'is newer than "Bun" (Notes/Scoped.md, scope global, 2026-09-01T00:00:00.000Z). '
        + 'Both are current in the store — do not treat them as compatible.',
      );
      // The CLI search and HTTP surfaces name no scope, so they are told too.
      const surface = readHonestyForItems({ db, query: 'what runtime does Scoped use', items: [], ledgerRelPath: LEDGER });
      expect(surface.conflicts.map((c) => c.statement)).toEqual([everywhere[0].statement]);
      // A scoped read sees its own scope's facts only, so it is never told what another scope holds.
      for (const [scope, value] of [['project:alpha', 'Node.js'], ['global', 'Bun']]) {
        const rows = currentFactsForSubjects(db, ['Scoped'], scope);
        expect(rows.map((r) => r.object), scope).toEqual([value]);
        expect(detectFactConflicts(rows), scope).toEqual([]);
      }
    } finally {
      db.close();
    }
  });

  it('a scoped read is its slug: it sees the facts saved under every spelling of it, and no other scope\'s (dogfood D6)', () => {
    const file = path.join(mkdir(), 'index.db');
    const db = seedDb(file, {
      noteFact: {
        subject: 'Spelled',
        predicate: 'runtime',
        object: 'Bun',
        validFrom: '2026-09-01T00:00:00.000Z',
        sourcePath: 'Notes/Spelled.md',
      },
    });
    try {
      const entityId = (db.prepare(`SELECT id FROM entities WHERE canonical_name = 'Spelled'`).get() as { id: number }).id;
      const add = (object: string, validFrom: string, scope: string) => db.prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at, scope)
         VALUES (?, 'runtime', ?, 'Notes/Other.md', 1.0, ?, ?, ?)`,
      ).run(entityId, object, validFrom, validFrom, scope);
      add('Node.js', '2026-09-02T00:00:00.000Z', 'project:alpha');
      add('Deno', '2026-09-03T00:00:00.000Z', 'scope:alpha'); // the same scope, saved under its other spelling
      add('Zig', '2026-09-04T00:00:00.000Z', 'project:beta');
      for (const scope of ['project:alpha', 'scope:alpha']) {
        const rows = currentFactsForSubjects(db, ['Spelled'], scope);
        expect(rows.map((r) => [r.object, r.scope]), scope).toEqual([['Deno', 'scope:alpha'], ['Node.js', 'project:alpha']]);
        expect(detectFactConflicts(rows).map((c) => c.values), scope).toEqual([['Deno', 'Node.js']]);
      }
      expect(currentFactsForSubjects(db, ['Spelled'], 'project:beta').map((r) => r.object)).toEqual(['Zig']);
      expect(currentFactsForSubjects(db, ['Spelled'], 'global').map((r) => r.object)).toEqual(['Bun']);
    } finally {
      db.close();
    }
  });

  it('names every value with the scope it is current in, newest first: three scopes, then a value current in two', () => {
    const file = path.join(mkdir(), 'index.db');
    const db = seedDb(file, {
      noteFact: { subject: 'Triple', predicate: 'runtime', object: 'Bun', validFrom: '2026-09-01T00:00:00.000Z', sourcePath: 'Notes/Triple.md' },
    });
    try {
      const entityId = (db.prepare(`SELECT id FROM entities WHERE canonical_name = 'Triple'`).get() as { id: number }).id;
      const add = (object: string, sourcePath: string, validFrom: string, scope: string) => db.prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at, scope)
         VALUES (?, 'runtime', ?, ?, 1.0, ?, ?, ?)`,
      ).run(entityId, object, sourcePath, validFrom, validFrom, scope);
      add('Node.js', 'Notes/Other.md', '2026-09-02T00:00:00.000Z', 'project:alpha');
      add('Deno', '_mcp_', '2026-09-03T00:00:00.000Z', 'project:beta');
      // Three values in three scopes: newer and older are two of them, and the third is named with its scope too.
      const [three] = detectFactConflicts(currentFactsForSubjects(db, ['Triple']));
      expect(three.values).toEqual(['Deno', 'Node.js', 'Bun']);
      expect(three.newer).toEqual({ value: 'Deno', source: '_mcp_', lastVerified: '2026-09-03T00:00:00.000Z', scope: 'project:beta' });
      expect(three.older).toEqual({ value: 'Node.js', source: 'Notes/Other.md', lastVerified: '2026-09-02T00:00:00.000Z', scope: 'project:alpha' });
      expect(three.alsoCurrent).toEqual([{ value: 'Bun', source: 'Notes/Triple.md', lastVerified: '2026-09-01T00:00:00.000Z', scope: 'global' }]);
      expect(three).not.toHaveProperty('total');
      expect(three.statement).toBe(
        'Contradiction on Triple / runtime: "Deno" (_mcp_, scope project:beta, 2026-09-03T00:00:00.000Z) '
        + 'is newer than "Node.js" (Notes/Other.md, scope project:alpha, 2026-09-02T00:00:00.000Z); '
        + 'also current: "Bun" (Notes/Triple.md, scope global, 2026-09-01T00:00:00.000Z). '
        + 'All 3 are current in the store — do not treat them as compatible.',
      );
      // Values current in a second scope are named there too, after every value, newest first.
      add('bun', '_mcp_', '2026-08-31T00:00:00.000Z', 'project:gamma');
      add('Deno', '_mcp_', '2026-08-30T00:00:00.000Z', 'project:delta');
      const [five] = detectFactConflicts(currentFactsForSubjects(db, ['Triple']));
      expect(five.values).toEqual(['Deno', 'Node.js', 'Bun']);
      expect([five.newer, five.older, ...five.alsoCurrent!].map((s) => `${s.value} [${s.scope}]`)).toEqual([
        'Deno [project:beta]', 'Node.js [project:alpha]', 'Bun [global]', 'bun [project:gamma]', 'Deno [project:delta]',
      ]);
      expect(five.statement).toContain(
        '; also current: "Bun" (Notes/Triple.md, scope global, 2026-09-01T00:00:00.000Z), '
        + '"bun" (_mcp_, scope project:gamma, 2026-08-31T00:00:00.000Z), "Deno" (_mcp_, scope project:delta, 2026-08-30T00:00:00.000Z). '
        + 'All 5 are current in the store',
      );
      // The CLI search and HTTP surfaces name no scope, so they are told the same.
      expect(readHonestyForItems({ db, query: 'what runtime does Triple use', items: [], ledgerRelPath: LEDGER }).conflicts).toEqual([five]);
    } finally {
      db.close();
    }
  });

  it('told the facts a read returns, names a contradiction across scopes for those only, and one inside a scope for any', () => {
    const file = path.join(mkdir(), 'index.db');
    const db = seedDb(file, {
      noteFact: { subject: 'Rig', predicate: 'owner', object: 'Ana', validFrom: '2026-09-01T00:00:00.000Z', sourcePath: 'Notes/Rig.md' },
      lifecycleFact: { subject: 'Rig', predicate: 'owner', object: 'Bia', validFrom: '2026-09-02T00:00:00.000Z' },
    });
    try {
      const add = (subject: string, predicate: string, object: string, validFrom: string, scope: string) => {
        const entity = (db.prepare(`SELECT id FROM entities WHERE canonical_name = ? ORDER BY id LIMIT 1`).get(subject) as { id: number } | undefined)?.id
          ?? (db.prepare(
            `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
             VALUES ('thing', ?, '[]', '_mcp_', 1.0, ?) RETURNING id`,
          ).get(subject, validFrom) as { id: number }).id;
        db.prepare(
          `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at, scope)
           VALUES (?, ?, ?, '_mcp_', 1.0, ?, ?, ?)`,
        ).run(entity, predicate, object, validFrom, validFrom, scope);
      };
      add('Rig', 'runtime', 'Bun', '2026-09-01T00:00:00.000Z', 'global');
      add('Rig', 'runtime', 'Node.js', '2026-09-02T00:00:00.000Z', 'project:alpha');
      add('Rig', 'region', 'eu-west-1', '2026-09-01T00:00:00.000Z', 'global');
      add('Rig', 'region', 'sa-east-1', '2026-09-02T00:00:00.000Z', 'project:alpha');
      const read = (facts?: Array<{ subject: string; predicate: string }>) => applyReadHonesty({
        db, query: 'what runtime does Rig use', ledgerRelPath: LEDGER, texts: ['Rig runtime Node.js'], ...(facts ? { facts } : {}),
      }).conflicts.map((c) => c.predicate);
      // Not told (the CLI and HTTP reads, which return notes): every contradiction about the subject.
      expect(read()).toEqual(['owner', 'region', 'runtime']);
      // Told the read returns Rig's runtime: that contradiction across scopes, and the one inside global, as before.
      expect(read([{ subject: 'rig', predicate: 'runtime' }])).toEqual(['owner', 'runtime']);
      expect(read([])).toEqual(['owner']);
      // A contradiction the read does not name does not stand in for an answer: the abstention stays.
      add('Mast', 'region', 'eu-west-1', '2026-09-01T00:00:00.000Z', 'global');
      add('Mast', 'region', 'sa-east-1', '2026-09-02T00:00:00.000Z', 'project:alpha');
      const mast = (facts?: Array<{ subject: string; predicate: string }>) => applyReadHonesty({
        db, query: 'what colour is the Mast paint', ledgerRelPath: LEDGER, texts: [], considered: 0, ...(facts ? { facts } : {}),
      });
      expect(mast().conflicts.map((c) => c.predicate)).toEqual(['region']);
      expect(mast().abstention).toBeNull();
      const told = mast([{ subject: 'Mast', predicate: 'paint' }]);
      expect(told.conflicts).toEqual([]);
      expect(told.abstention).toMatchObject({ status: 'no-answer', reason: 'no-evidence' });
    } finally {
      db.close();
    }
  });

  it('names at most eight sides of a conflict across many scopes, and cuts them to a budget, never below the two that disagree', () => {
    // Two hundred scopes, one value each, the last saved newest: the conflict a read that names no scope sees.
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1, subject: 'deploy bot', predicate: 'retry_count', object: String(i + 1), sourcePath: '_mcp_',
      scope: `team:${i + 1}`, validFrom: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
    }));
    const named = (c: FactConflict) => [c.newer, c.older, ...(c.alsoCurrent ?? [])];
    const brief = (c: FactConflict) => named(c).map((s) => `${s.value} [${s.scope}]`);
    const newest = (n: number) => Array.from({ length: n }, (_, i) => `${200 - i} [team:${200 - i}]`);
    // The newest eight, each with its scope, and how many there are: as many as get_context's default conflicts list.
    const whole = detectFactConflicts(rows);
    expect(whole).toHaveLength(1);
    expect(brief(whole[0])).toEqual(newest(8));
    expect(whole[0].values).toEqual(named(whole[0]).map((s) => s.value));
    expect(whole[0].total).toBe(200);
    expect(whole[0].statement).toContain(' and 192 more. All 200 are current in the store');
    // A budget they fit in takes them as they are; a smaller one names fewer, newest first, and still counts them all.
    expect(fitConflicts(whole, 3_200)).toBe(whole);
    const counts: number[] = [];
    for (const maxChars of [512, 1_000, 1_400]) {
      const fitted = fitConflicts(whole, maxChars);
      expect(fitted, `${maxChars}`).toHaveLength(1);
      const [c] = fitted;
      const n = named(c).length;
      counts.push(n);
      expect(brief(c), `${maxChars}`).toEqual(newest(n));
      expect(c.values, `${maxChars}`).toEqual(named(c).map((s) => s.value));
      expect(c.total, `${maxChars}`).toBe(200);
      expect(c.statement, `${maxChars}`).toContain(`${n > 2 ? ' and ' : 'also current: '}${200 - n} more. All 200 are current`);
      if (n > 2) {
        // Within the budget, and as many as fit: one more side would not.
        expect(JSON.stringify(fitted).length, `${maxChars}`).toBeLessThanOrEqual(maxChars);
        const oneMore = conflictAcrossScopes(c.subject, c.predicate, named(whole[0]).slice(0, n + 1), 200);
        expect(JSON.stringify([oneMore]).length, `${maxChars}`).toBeGreaterThan(maxChars);
      }
    }
    // The smallest budget get_context allows (128 tokens) holds only the contradiction itself and the count.
    expect(counts[0]).toBe(2);
    expect(counts[1]).toBeGreaterThan(2);
    expect(counts[2]).toBeGreaterThan(counts[1]);
    expect(counts[2]).toBeLessThan(8);
    // Eight sides are all named, and a conflict inside one scope is never cut.
    const eight = detectFactConflicts(rows.slice(0, 8));
    expect(named(eight[0])).toHaveLength(8);
    expect(eight[0]).not.toHaveProperty('total');
    const oneScope = detectFactConflicts(rows.map((r) => ({ ...r, scope: 'global' })));
    expect(oneScope[0].values).toHaveLength(200);
    expect(oneScope[0]).not.toHaveProperty('alsoCurrent');
    expect(fitConflicts(oneScope, 512)).toEqual(oneScope);
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('surfaces the conflict through the public MCP get_context tool', async () => {
    const body = await getContext('what is the power source of the machine', {
      seed: (db) => {
        db.prepare(
          `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
           VALUES ('Notes/Machine.md', 'Machine', 'note', 'h', '2026-09-01T00:00:00.000Z', '{}')`,
        ).run();
        const noteEntity = (db
          .prepare(
            `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
             VALUES ('note', 'Machine', '[]', 'Notes/Machine.md', 1.0, '2026-09-01T00:00:00.000Z') RETURNING id`,
          )
          .get() as { id: number }).id;
        db.prepare(
          `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at)
           VALUES (?, 'power_source', 'mains-powered, any power blip is a hard power-off', 'Notes/Machine.md', 1.0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
        ).run(noteEntity);
      },
      after: async (mcp, token) => {
        const save = await mcp('save_memory', {
          subject: 'Machine',
          predicate: 'power_source',
          object: 'battery pack reporting 48.84 Wh at 100% of design capacity',
          source: 'chatgpt',
        });
        expect(save.ok).toBe(true);
      },
    });
    expect(Array.isArray(body.conflicts)).toBe(true);
    expect(body.conflicts).toHaveLength(1);
    const conflict = body.conflicts[0] as FactConflict;
    expect(conflict.subject).toBe('Machine');
    expect(conflict.values.join(' | ')).toContain('48.84 Wh');
    expect(conflict.values.join(' | ')).toContain('mains-powered');
    // The newer side is named explicitly.
    expect(conflict.statement).toMatch(/newer/i);
    expect(conflict.statement).toContain(conflict.newer.value);
    expect(conflict.statement).toContain(conflict.older.value);
    // A product surface never leaks a host path (repo rule for client output).
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(os.tmpdir());
    expect(serialized).not.toMatch(/"\/home\/|\/var\/folders\//);
  }, 120_000);

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('names every side of a conflict across scopes through get_context, each source rendered client-safe', async () => {
    // A host path is only ever a string here; it is seeded as a note's path and must never reach
    // the reply. It is still built per call so no other run on this machine can assume the same
    // name — the rule for every fixture path in this tree, data or file.
    const hostPath = path.join(mkdir(), 'Notes', 'Pipeline.md');
    const body = await getContext('what runtime does Pipeline use', {
      seed: (db) => {
        db.prepare(
          `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
           VALUES (?, 'Pipeline', 'note', 'h', '2026-09-01T00:00:00.000Z', '{}')`,
        ).run(hostPath);
        const noteEntity = (db
          .prepare(
            `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
             VALUES ('note', 'Pipeline', '[]', ?, 1.0, '2026-09-01T00:00:00.000Z') RETURNING id`,
          )
          .get(hostPath) as { id: number }).id;
        db.prepare(
          `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at)
           VALUES (?, 'runtime', 'Bun', ?, 1.0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
        ).run(noteEntity, hostPath);
      },
      after: async (mcp) => {
        expect((await mcp('save_memory', { subject: 'Pipeline', predicate: 'runtime', object: 'Node.js', scope: 'project:alpha' })).ok).toBe(true);
        expect((await mcp('save_memory', { subject: 'Pipeline', predicate: 'runtime', object: 'Deno', scope: 'project:beta' })).ok).toBe(true);
      },
    });
    expect(body.conflicts).toHaveLength(1);
    const conflict = body.conflicts[0] as FactConflict;
    // The note's value is the third side: it is named with its scope, and its source is the note's name, not its host path.
    expect([conflict.newer, conflict.older, ...(conflict.alsoCurrent ?? [])].map((s) => `${s.value} [${s.scope}] ${s.source}`)).toEqual([
      'Deno [project:beta] _mcp_', 'Node.js [project:alpha] _mcp_', 'Bun [global] Pipeline.md',
    ]);
    expect(conflict.statement).toContain('; also current: "Bun" (Pipeline.md, scope global, 2026-09-01T00:00:00.000Z). All 3 are current');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(os.tmpdir());
    expect(serialized).not.toMatch(/"\/home\/|\/var\/folders\//);
  }, 120_000);
});

describe('LANE 3 behaviour 3: honest abstention', () => {
  it('abstains when the query content is absent from the evidence', () => {
    const a = assessAbstention({
      query: 'what is my favourite colour and pet name',
      texts: ['The machine is mains powered; any power blip is a hard power-off.'],
    });
    expect(a).not.toBeNull();
    expect(a!.status).toBe('no-answer');
    expect(a!.reason).toBe('below-evidence-bar');
    expect(a!.statement).toBe(NO_ANSWER_STATEMENT);
    expect(a!.coverage).toBeLessThan(DEFAULT_EVIDENCE_BAR);
  });

  it('does not abstain when the evidence does cover the question', () => {
    const a = assessAbstention({
      query: 'what is the pack design capacity in Wh',
      texts: ['The pack reports 48.84 Wh at 100% of design capacity.'],
    });
    expect(a).toBeNull();
  });

  it('abstains with no-evidence when nothing is on file at all', () => {
    const a = assessAbstention({ query: 'anything at all', texts: [] });
    expect(a).not.toBeNull();
    expect(a!.reason).toBe('no-evidence');
    expect(a!.statement).toBe(NO_ANSWER_STATEMENT);
  });

  it('the bar is measured, not invented: coverage separates the two populations', () => {
    // Measured fixture separation (scripts/lane3-probe.ts): on-topic 0.67–1.00,
    // off-topic 0.00–0.33. The default bar sits between them.
    const onTopic = ['Is the machine mains powered or battery powered?', 'what is the rack draw in the server room'];
    const texts = ['The machine is mains powered; any power blip is a hard power-off.',
      'Rack draw is about 300 W. The UPS holds the rack for roughly nine minutes.'];
    for (const q of onTopic) {
      expect(evidenceCoverage(q, texts)).toBeGreaterThanOrEqual(DEFAULT_EVIDENCE_BAR);
    }
    const offTopic = ['what is my favourite colour and pet name', 'who won the world cup in 1994'];
    for (const q of offTopic) {
      expect(evidenceCoverage(q, texts)).toBeLessThan(DEFAULT_EVIDENCE_BAR);
    }
  });

  it('a contradiction outranks abstention (conflict is reported, not hidden by a no-answer)', () => {
    const file = path.join(mkdir(), 'index.db');
    const db = seedDb(file, {
      noteFact: {
        subject: 'Machine',
        predicate: 'power_source',
        object: 'mains-powered',
        validFrom: '2026-09-01T00:00:00.000Z',
        sourcePath: 'Notes/Machine.md',
      },
      lifecycleFact: { subject: 'Machine', predicate: 'power_source', object: 'battery powered', validFrom: '2026-09-02T00:00:00.000Z' },
    });
    try {
      const honesty = applyReadHonesty({
        db,
        query: 'what is the power source of the machine',
        ledgerRelPath: LEDGER,
        subjects: ['Machine'],
        // Deliberately unrelated evidence text: the bar would abstain on its own.
        texts: ['Completely unrelated content about garden watering.'],
      });
      expect(honesty.conflicts).toHaveLength(1);
      expect(honesty.abstention).toBeNull();
    } finally {
      db.close();
    }
  });

  it.skipIf(HTTP_SERVER_UNSUPPORTED)('reaches the public MCP get_context tool as an explicit no-answer', async () => {
    const saveMachine = async (call: (name: string, args: any) => Promise<any>) => {
      const save = await call('save_memory', {
        subject: 'Machine',
        predicate: 'power_source',
        object: 'mains-powered; any power blip is a hard power-off',
        source: 'chatgpt',
      });
      expect(save.ok).toBe(true);
    };
    // The fact is about the machine but does not say what was asked: evidence on file, below the bar.
    const body = await getContext('what colour is the machine painted', { after: saveMachine });
    expect(body.facts.map((f: any) => f.subject)).toEqual(['Machine']);
    expect(body.abstention).toBeDefined();
    expect(body.abstention.status).toBe('no-answer');
    expect(body.abstention.reason).toBe('below-evidence-bar');
    expect(body.abstention.statement).toBe(NO_ANSWER_STATEMENT);
    expect(body.abstention.coverage).toBeLessThan(DEFAULT_EVIDENCE_BAR);
    // The literal string an agent can surface verbatim.
    expect(JSON.stringify(body)).toContain('no good answer on file for this');

    // A question that shares no word with anything on file: the fact used to come back on the stop word "is".
    const unrelated = await getContext('what is my favourite colour and pet name', { after: saveMachine });
    expect(unrelated.facts).toEqual([]);
    expect(unrelated.abstention.status).toBe('no-answer');
    expect(unrelated.abstention.reason).toBe('no-evidence');
  }, 120_000);

  it('reaches the public CLI surface (renor search --json)', async () => {
    const vault = mkdir();
    fs.writeFileSync(path.join(vault, '.semanticignore'), 'System/\n');
    fs.writeFileSync(
      path.join(vault, 'Machine.md'),
      `---\ntitle: Machine power\n---\n\n# Machine power notes\n\nThe machine is mains powered; any power blip is a hard power-off.\n\nThe pack reports 48.84 Wh at 100% of design capacity.\n`,
    );
    const indexed = await runCli('index', vault, { RENOR_READ_HONESTY: '1' });
    expect(indexed.code).toBe(0);

    const onTopic = await runCli('search', vault, { RENOR_READ_HONESTY: '1' }, ['Is the machine mains powered?', '--json']);
    expect(onTopic.code).toBe(0);
    const onBody = JSON.parse(onTopic.stdout);
    expect(onBody.hits.length).toBeGreaterThan(0);
    expect(onBody.readHonesty).toBeDefined();
    expect(onBody.readHonesty.abstention).toBeNull();
    // Provenance on every returned hit.
    for (const hit of onBody.hits) {
      expect(hit.provenance).toBeDefined();
      expect(typeof hit.provenance.source).toBe('string');
    }

    const offTopic = await runCli('search', vault, { RENOR_READ_HONESTY: '1' }, ['what is my favourite colour and pet name', '--json']);
    expect(offTopic.code).toBe(0);
    const offBody = JSON.parse(offTopic.stdout);
    // Hits are still returned (nothing is hidden)... 
    expect(offBody.hits.length).toBeGreaterThan(0);
    // ...but the read SAYS they do not answer the question.
    expect(offBody.readHonesty.abstention.status).toBe('no-answer');
    expect(offBody.readHonesty.abstention.statement).toBe(NO_ANSWER_STATEMENT);
  }, 180_000);
});

describe('LANE 3: product-path honesty stays gold-blind', () => {
  it('resolves subjects from query text and the product entity table only', () => {
    const file = path.join(mkdir(), 'index.db');
    const db = seedDb(file, {
      noteFact: {
        subject: 'Machine',
        predicate: 'power_source',
        object: 'mains-powered',
        validFrom: '2026-09-01T00:00:00.000Z',
        sourcePath: 'Notes/Machine.md',
      },
    });
    try {
      expect(querySubjects(db, 'what is the power source of the machine')).toContain('Machine');
      expect(querySubjects(db, 'how tall is the eiffel tower')).not.toContain('Machine');
      // Content terms are query words, nothing else. Sub-3-char tokens are not
      // content terms (they cannot discriminate), so 'wh' is excluded.
      expect(contentTerms('what is the pack design capacity in Wh')).toEqual(['pack', 'design', 'capacity']);
      expect(contentTerms('what is the power source of the machine')).toEqual(['power', 'source', 'machine']);
      // Stopwords never leak in.
      expect(contentTerms('the and for with what how')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a structured row whose source note no longer resolves is never read back', () => {
    const file = path.join(mkdir(), 'index.db');
    const db = seedDb(file);
    try {
      db.prepare(
        `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
         VALUES ('Notes/A.md', 'A', 'note', 'h', '2026-09-01T00:00:00.000Z', '{}')`,
      ).run();
      const chunk = (db
        .prepare(
          `INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
           VALUES ('Notes/A.md', '', 'value 3:45', 1, 1, 3, 'c1') RETURNING id`,
        )
        .get() as { id: number }).id;
      insertStructuredRows(db, [
        {
          rowKind: 'fact',
          sourcePath: 'Notes/A.md',
          sourceChunkId: chunk,
          sourceHash: 'h',
          extractionVersion: 'v1',
          validFrom: '2026-09-01',
          payload: { value: '3:45', object: 'marathon time' },
        },
      ]);
      expect(readCurrentRowsForNotes(db, ['Notes/A.md'])).toHaveLength(1);
      // The provenance guard: the source note disappearing removes the row
      // from every read path (FK cascade), so no result is ever served with
      // provenance that no longer resolves.
      db.prepare('DELETE FROM notes WHERE path = ?').run('Notes/A.md');
      expect(readCurrentRowsForNotes(db, ['Notes/A.md'])).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* helpers: real product surfaces                                      */
/* ------------------------------------------------------------------ */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const LOOPBACK_CB = 'http://127.0.0.1:1/callback';

function mvpConfig(memoryDir: string): MvpConfig {
  const authRoot = mkdir();
  const env: Record<string, string> = {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: OWNER_EMAIL,
    MVP_OWNER_PASSWORD: OWNER_PASSWORD,
    MVP_ALLOWED_CALLBACK_URIS: LOOPBACK_CB,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  saved.RENOR_READ_HONESTY = process.env.RENOR_READ_HONESTY;
  process.env.RENOR_READ_HONESTY = '1'; // this lane's flag, armed for the surface tests
  try {
    return loadMvpConfig();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * Drives the REAL remote MCP surface: OAuth (register -> authorize -> login ->
 * PKCE token) then a tools/call on /mcp. Returns the parsed get_context body.
 *
 * The lane's flag is armed around the calls exactly as an operator arms it:
 * exported in the service environment before the read happens (the engine MCP
 * server resolves read-path flags from process.env per request, the same
 * pattern RENOR_STRUCTURED_CONTEXT uses).
 */
async function getContext(
  query: string,
  opts: { seed?: (db: import('../../src/db/sqlite').default.Database) => void; after?: (call: (name: string, args: any) => Promise<any>, token: string) => Promise<void>; arm?: boolean } = {},
): Promise<any> {
  const prevHonesty = process.env[READ_HONESTY_FLAG];
  const arm = opts.arm !== false;
  if (arm) process.env[READ_HONESTY_FLAG] = '1';
  else delete process.env[READ_HONESTY_FLAG];
  try {
    return await getContextArmed(query, opts);
  } finally {
    if (prevHonesty === undefined) delete process.env[READ_HONESTY_FLAG];
    else process.env[READ_HONESTY_FLAG] = prevHonesty;
  }
}

async function getContextArmed(
  query: string,
  opts: { seed?: (db: import('../../src/db/sqlite').default.Database) => void; after?: (call: (name: string, args: any) => Promise<any>, token: string) => Promise<void>; arm?: boolean } = {},
): Promise<any> {
  const memoryDir = mkdir();
  const config = mvpConfig(memoryDir);
  const mvp = createMvpApp(config);
  apps.push(mvp);
  opts.seed?.(mvp.db);

  const app = mvp.app;
  const reg = await request(app).post('/register')
    .send({ client_name: 'lane3-client', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code', 'refresh_token'] });
  expect(reg.status).toBe(201);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: LOOPBACK_CB, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  });
  expect(authorize.status).toBe(200);
  const ticket = authorize.text.match(/name="ticket" value="([^"]+)"/)?.[1];
  expect(ticket).toBeTruthy();
  const login = await request(app).post('/mvp-login').type('form')
    .send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
  expect(login.status).toBe(302);
  const code = new URL(login.headers.location as string, 'http://x').searchParams.get('code')!;
  const tokenRes = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: LOOPBACK_CB,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  });
  expect(tokenRes.status).toBe(200);
  const token = tokenRes.body.access_token as string;

  const call = async (name: string, args: any) => {
    const res = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    expect(res.status).toBe(200);
    // SSE mode may reply as an event stream; accept both.
    const raw = typeof res.text === 'string' && res.text.startsWith('event:')
      ? res.text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')
      : res.text;
    const parsed = raw ? JSON.parse(raw) : res.body;
    const text = parsed.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : parsed;
  };

  if (opts.after) await opts.after(call, token);

  return call('get_context', { query, max_tokens: 800 });
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The compiled `renor` bin (package.json `bin`), built by tests/globalSetup.ts before any test
// file loads: the surface a user runs, and without paying tsx's transform on every spawn.
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

function runCli(
  command: string,
  vault: string,
  extraEnv: Record<string, string>,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of [
      'OPENAI_API_KEY', 'EMBEDDING_PROVIDER', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL',
      'EMBEDDING_DIMS', 'LLM_EXTRACTION', 'MEMORY_LEDGER', 'DB_PATH', 'VAULT_PATH',
      'RENOR_READ_HONESTY', 'RENOR_READ_HONESTY_BAR', 'RENOR_STRUCTURED_CONTEXT',
      'RENOR_SEARCH_EVIDENCE', 'RENOR_QUERY_SCOPED_ROWS', 'RENOR_TYPED_FACTS',
      'RENOR_CHRONICLE', 'RENOR_PREFS',
    ]) delete env[k];
    env.VAULT_PATH = vault;
    env.DB_PATH = path.join(vault, '.semantic-memory', 'index.db');
    env.EMBEDDING_PROVIDER = 'eval-hash';
    env.MEMORY_LEDGER = LEDGER;
    Object.assign(env, extraEnv);
    execFile(process.execPath, [CLI, command, ...args], { cwd: REPO_ROOT, env, timeout: 120_000 },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0),
          stdout: String(stdout),
          stderr: String(stderr),
        });
      });
  });
}
