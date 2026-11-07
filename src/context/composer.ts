import type { RetrievalHit } from '../retrieval/orchestrator';
import { hasEvidenceIntent } from '../evidence/gate';
import {
  matchForm,
  readCurrentRowsForNotes,
  splitWords,
  type StoredStructuredRow,
  type FactPayload,
  type EventPayload,
  type PreferencePayload,
} from './rowStore';

/**
 * C0 shared context composer (ADR-0003 §5). One deterministic function of
 * (query, corpus, config): fixed section order, per-section row caps, whole-
 * section drop on total-budget overflow, deterministic tie-breaks everywhere.
 * Identical inputs produce byte-identical output, which is what makes cache-
 * first iteration and replay provable.
 *
 * Structured rows join to a query iff their source note is among the query's
 * product retrieval hits (the product-observable join — gold-blind, no
 * `haystack_session_ids`). Rows without provenance are rejected; rows whose
 * source note no longer resolves are never composed.
 */

export type SectionName = 'excerpts' | 'evidence' | 'facts' | 'chronicle' | 'prefs';

/** Declared render order (ADR-0003 §5.1). */
export const SECTION_ORDER: readonly SectionName[] = ['excerpts', 'evidence', 'facts', 'chronicle', 'prefs'] as const;
/** Declared drop order on overflow: reverse of fill priority, excerpts last-standing. */
export const SECTION_DROP_ORDER: readonly SectionName[] = ['prefs', 'chronicle', 'facts', 'evidence'] as const;

export const DEFAULT_SECTION_CAP = 40;
export const DEFAULT_BUDGET_TOKENS = 6000;

export interface EvidenceSectionInput {
  status?: string;
  items?: Array<{ item: string; action?: string; amount?: string; date?: string }>;
  sessions?: Array<{ stem: string; date?: string }>;
}

export interface ComposerInput {
  query: string;
  hits: RetrievalHit[];
  /** Second-pass evidence attachment (already gated by its own flag upstream). */
  evidence?: EvidenceSectionInput;
  /** Current structured-row candidates; joined to `query` via retrieval hits inside. */
  rows?: StoredStructuredRow[];
}

export interface ComposerOptions {
  budgetTokens?: number;
  sectionCap?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ComposedSection {
  name: SectionName;
  included: boolean;
  rowCount: number;
  tokens: number;
  text: string;
}

export interface ComposedContext {
  query: string;
  budgetTokens: number;
  usedTokens: number;
  sections: ComposedSection[];
  includedSections: SectionName[];
  droppedSections: SectionName[];
  /** Byte-identical rendering for identical inputs. */
  text: string;
}

export class ProvenanceError extends Error {}

/** Deterministic token estimate (chars/4, ceil). Never model-dependent. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** RENOR_STRUCTURED_CONTEXT (default OFF). Opt in with 1/true/yes/on. */
export function structuredContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_STRUCTURED_CONTEXT ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * RENOR_FACT_VALIDITY_WINDOWS (default OFF; research lever temporal-fact-validity).
 * Opt in with 1/true/yes/on. Renders each structured row with its validity window
 * (valid from / until) and also reads rows a newer value superseded, so knowledge-update
 * and temporal questions can see what was true and when. Off = byte-identical output.
 */
export function factValidityWindowsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_FACT_VALIDITY_WINDOWS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * RENOR_QUERY_SCOPED_ROWS (default OFF; C5 rollback flag — never flipped here).
 * Opt in with 1/true/yes/on. Enables read-path query-term-overlap filtering of
 * structured-row tables before composition (efficiency only; gold-blind).
 */
export function queryScopedRowsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_QUERY_SCOPED_ROWS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function resolveBudgetTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RENOR_CONTEXT_BUDGET_TOKENS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_BUDGET_TOKENS;
}

function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      splitWords(query).filter((t) => t.length >= 2),
    ),
  );
}

function rowSearchText(row: StoredStructuredRow): string {
  const p = row.payload;
  switch (row.rowKind) {
    case 'fact': {
      const f = p as FactPayload;
      return [f.value, f.unit, f.verb, f.object, f.event].filter(Boolean).join(' ');
    }
    case 'event': {
      const e = p as EventPayload;
      return [e.when, e.event, ...(e.entities ?? [])].filter(Boolean).join(' ');
    }
    case 'preference': {
      const pr = p as PreferencePayload;
      return [pr.statement, pr.kind].filter(Boolean).join(' ');
    }
  }
}

/** Relevance = total query-term occurrences; ties broken by valid_from desc (NULL last), then source_path, then dedupe_key. */
function rankRows(rows: StoredStructuredRow[], terms: string[]): StoredStructuredRow[] {
  const counted = rows.map((row) => {
    const text = matchForm(rowSearchText(row));
    let relevance = 0;
    for (const term of terms) {
      let idx = text.indexOf(term);
      while (idx !== -1) {
        relevance += 1;
        idx = text.indexOf(term, idx + term.length);
      }
    }
    return { row, relevance };
  });
  counted.sort((a, b) => {
    if (a.relevance !== b.relevance) return b.relevance - a.relevance;
    const aDate = a.row.validFrom;
    const bDate = b.row.validFrom;
    if (aDate === null && bDate !== null) return 1; // NULL last
    if (bDate === null && aDate !== null) return -1;
    if (aDate !== bDate) return aDate! < bDate! ? 1 : -1; // desc
    if (a.row.sourcePath !== b.row.sourcePath) return a.row.sourcePath < b.row.sourcePath ? -1 : 1;
    return a.row.dedupeKey < b.row.dedupeKey ? -1 : a.row.dedupeKey > b.row.dedupeKey ? 1 : a.row.id - b.row.id;
  });
  return counted.map((c) => c.row);
}

function provenanceSuffix(row: StoredStructuredRow, windows = false): string {
  if (windows) {
    const from = row.validFrom ? `valid from ${row.validFrom}` : 'valid from unknown';
    const window = row.validTo ? `${from} until ${row.validTo}, superseded` : `${from}, current`;
    return ` (source: ${row.sourcePath}, ${window})`;
  }
  return ` (source: ${row.sourcePath}${row.validFrom ? `, ${row.validFrom}` : ', date unknown'})`;
}

/**
 * C5 query-scoped row filtering (HYP-20260921-query-scoped-rows).
 *
 * Read-path-only efficiency filter: keep rows whose text shares at least one
 * query term. Pure function of (query, rows) — zero model calls, zero access
 * to benchmark categories, gold labels, or any flag beyond the caller's
 * enabled decision (the flag is resolved OUTSIDE; nothing gold is passable).
 *
 * Gold-blind aggregate-intent detection reuses the product's EVIDENCE_INTENT
 * regex on QUERY TEXT ONLY (an AGGREGATE_INTENT-style cue; widened from the
 * eval runner's pattern). On aggregate intent the full facts table is retained
 * (H9 precedent: aggregates need the whole table to count/sum); chronicle and
 * prefs rows are ALWAYS term-filtered, even for aggregate queries.
 *
 * Determinism: overlap test is set membership on term sets; the caller (rank)
 * supplies the stable composer tie-breaks, so relative order is unchanged.
 */
export function filterRowsByQueryTerms(
  kind: 'fact' | 'event' | 'preference',
  query: string,
  rows: StoredStructuredRow[],
): StoredStructuredRow[] {
  if (kind === 'fact' && hasEvidenceIntent(query)) return rows;
  const terms = new Set(queryTerms(query));
  if (terms.size === 0) return rows; // empty query cannot scope: keep full table
  return rows.filter((row) => {
    const text = matchForm(rowSearchText(row));
    for (const term of terms) {
      if (text.includes(term)) return true;
    }
    return false;
  });
}

function renderRow(row: StoredStructuredRow, windows = false): string {
  const p = row.payload;
  switch (row.rowKind) {
    case 'fact': {
      const f = p as FactPayload;
      const value = [f.value, f.unit].filter(Boolean).join(' ');
      return `- ${[f.verb, f.object].filter(Boolean).join(' ')}: ${value}${provenanceSuffix(row, windows)}`;
    }
    case 'event': {
      const e = p as EventPayload;
      return `- ${e.when}: ${e.event}${provenanceSuffix(row, windows)}`;
    }
    case 'preference': {
      const pr = p as PreferencePayload;
      return `- ${pr.statement}${provenanceSuffix(row, windows)}`;
    }
  }
}

interface RenderedSection {
  name: SectionName;
  text: string;
  tokens: number;
  rowCount: number;
}

const FALLBACKS: Record<'facts' | 'chronicle' | 'prefs', string> = {
  facts: 'Cite only values present in this table; if the answer is not here, use the excerpts instead.',
  chronicle: 'Use only events listed in this table; otherwise rely on the excerpts.',
  prefs:
    'When the question touches a preference or constraint, apply the matching entry to your answer as a standing rule. If nothing here is relevant, use the excerpts instead.',
};

function renderStructuredSection(
  name: 'facts' | 'chronicle' | 'prefs',
  rows: StoredStructuredRow[],
  windows = false,
): RenderedSection | null {
  if (rows.length === 0) return null;
  const lines = [`## ${name === 'prefs' ? 'Preferences' : name[0].toUpperCase() + name.slice(1)}`, '', FALLBACKS[name], ''];
  for (const row of rows) lines.push(renderRow(row, windows));
  const text = lines.join('\n');
  return { name, text, tokens: estimateTokens(text), rowCount: rows.length };
}

function renderEvidence(evidence: EvidenceSectionInput): RenderedSection | null {
  if (!evidence.items || evidence.items.length === 0) return null;
  const lines = ['## Evidence', ''];
  for (const item of evidence.items) {
    const parts = [item.item];
    if (item.action) parts.push(`action: ${item.action}`);
    if (item.amount) parts.push(`amount: ${item.amount}`);
    if (item.date) parts.push(`date: ${item.date}`);
    lines.push(`- ${parts.join(' | ')}`);
  }
  const text = lines.join('\n');
  return { name: 'evidence', text, tokens: estimateTokens(text), rowCount: evidence.items.length };
}

function renderExcerpts(hits: RetrievalHit[]): RenderedSection | null {
  if (hits.length === 0) return null;
  const lines: string[] = ['## Excerpts', ''];
  for (const hit of hits) {
    lines.push(`[${hit.score.toFixed(3)}] ${hit.notePath}${hit.session_date ? ` (${hit.session_date})` : ''}`);
    lines.push(hit.text);
    lines.push('');
  }
  // Trim the trailing blank so join behavior is stable.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const text = lines.join('\n');
  return { name: 'excerpts', text, tokens: estimateTokens(text), rowCount: hits.length };
}

/** Excerpts overflow: deterministic prefix trim (never reorders, never drops the section head). */
function trimExcerpts(hits: RetrievalHit[], budgetTokens: number): { hits: RetrievalHit[]; tokens: number } {
  const kept: RetrievalHit[] = [];
  let used = estimateTokens('## Excerpts');
  for (const hit of hits) {
    const block = `[${hit.score.toFixed(3)}] ${hit.notePath}${hit.session_date ? ` (${hit.session_date})` : ''}\n${hit.text}`;
    const cost = estimateTokens(block) + 1;
    if (used + cost > budgetTokens) break;
    kept.push(hit);
    used += cost;
  }
  return { hits: kept, tokens: used };
}

/**
 * Compose the bounded, deterministically ordered answer context. Structured
 * sections fill first; on total-budget overflow whole sections drop in
 * declared reverse order (prefs → chronicle → facts → evidence) — never
 * silent row-level truncation inside a table. Excerpts take the remaining
 * budget in product retrieval order.
 */
export function composeQueryContext(input: ComposerInput, options: ComposerOptions = {}): ComposedContext {
  const budget = options.budgetTokens ?? resolveBudgetTokens(options.env);
  const cap = options.sectionCap ?? DEFAULT_SECTION_CAP;
  const { query, hits, evidence } = input;

  // Provenance guard: any structured row without source_path + source_chunk_id
  // is rejected from composition — fail loudly, never silently strip.
  for (const row of input.rows ?? []) {
    if (!row.sourcePath || !row.sourcePath.trim()) {
      throw new ProvenanceError(`structured row ${row.id} (${row.rowKind}) rejected: missing source_path`);
    }
    if (!Number.isInteger(row.sourceChunkId) || row.sourceChunkId <= 0) {
      throw new ProvenanceError(`structured row ${row.id} (${row.rowKind}) rejected: missing source_chunk_id`);
    }
  }

  // Product-observable join: row ↔ query iff its source note is a retrieval hit.
  const hitPaths = new Set(hits.map((h) => h.notePath));

  const terms = queryTerms(query);
  const scoped = queryScopedRowsEnabled(options.env);
  const byKind = (kind: string) => {
    const kindRows = (input.rows ?? []).filter((r) => r.rowKind === kind && hitPaths.has(r.sourcePath));
    // C5: term-overlap scope BEFORE ranking/cap; budget is still enforced
    // downstream (overflow drop + excerpts trim), so no cap reduction here.
    const scopedRows = scoped
      ? filterRowsByQueryTerms(kind as 'fact' | 'event' | 'preference', query, kindRows)
      : kindRows;
    return rankRows(scopedRows, terms).slice(0, cap);
  };

  const windows = factValidityWindowsEnabled(options.env);
  const factsSection = renderStructuredSection('facts', byKind('fact'), windows);
  const chronicleSection = renderStructuredSection('chronicle', byKind('event'), windows);
  const prefsSection = renderStructuredSection('prefs', byKind('preference'), windows);
  const evidenceSection = evidence ? renderEvidence(evidence) : null;
  const excerptsSection = renderExcerpts(hits);

  const structured: Array<RenderedSection | null> = [factsSection, chronicleSection, prefsSection, evidenceSection];

  // Fill structured + excerpts, then drop whole sections in declared reverse
  // order until the total fits (excerpts are prefix-trimmed, not dropped).
  const included: Array<RenderedSection> = structured.filter((s): s is RenderedSection => s !== null);
  let excerpts = excerptsSection;
  let dropped: SectionName[] = [];
  const total = () => included.reduce((sum, s) => sum + s.tokens, 0) + (excerpts?.tokens ?? 0);

  if (total() > budget) {
    for (const name of SECTION_DROP_ORDER) {
      if (total() <= budget) break;
      const idx = included.findIndex((s) => s.name === name);
      if (idx !== -1) {
        included.splice(idx, 1);
        dropped.push(name);
      }
    }
    if (excerpts && total() > budget) {
      const remaining = budget - included.reduce((sum, s) => sum + s.tokens, 0);
      const trimmed = trimExcerpts(hits, Math.max(0, remaining));
      excerpts = trimmed.hits.length > 0
        ? { name: 'excerpts', text: renderExcerpts(trimmed.hits)!.text, tokens: trimmed.tokens, rowCount: trimmed.hits.length }
        : null;
      if (excerpts === null) dropped.push('excerpts');
    }
  }

  // Render in declared section order.
  const ordered = [...included].sort(
    (a, b) => SECTION_ORDER.indexOf(a.name) - SECTION_ORDER.indexOf(b.name),
  );
  const parts: string[] = [];
  if (excerpts) parts.push(excerpts.text);
  for (const s of ordered) parts.push(s.text);

  const sections: ComposedSection[] = [];
  for (const name of SECTION_ORDER) {
    if (name === 'excerpts') {
      if (excerpts) {
        sections.push({ name, included: true, rowCount: excerpts.rowCount, tokens: excerpts.tokens, text: excerpts.text });
      } else {
        sections.push({ name, included: false, rowCount: 0, tokens: 0, text: '' });
      }
      continue;
    }
    const found = ordered.find((s) => s.name === name);
    if (found) {
      sections.push({ name, included: true, rowCount: found.rowCount, tokens: found.tokens, text: found.text });
    } else {
      sections.push({ name, included: false, rowCount: 0, tokens: 0, text: '' });
    }
  }

  const text = parts.join('\n\n');
  const includedSections = sections.filter((s) => s.included).map((s) => s.name);
  return {
    query,
    budgetTokens: budget,
    usedTokens: parts.reduce((sum, p) => sum + estimateTokens(p), 0),
    sections,
    includedSections,
    droppedSections: dropped,
    text,
  };
}

/** Convenience wiring helper: read current rows for the query's hits and compose. */
export function composeQueryContextFromDb(
  db: import('../db/sqlite').default.Database,
  input: Omit<ComposerInput, 'rows'>,
  options: ComposerOptions = {},
): ComposedContext {
  const rows = readCurrentRowsForNotes(db, input.hits.map((h) => h.notePath), {
    includeSuperseded: factValidityWindowsEnabled(options.env),
  });
  return composeQueryContext({ ...input, rows }, options);
}