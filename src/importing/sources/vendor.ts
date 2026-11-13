import fs from 'fs';
import path from 'path';
import { parseMarkdownImportNote } from '../markdown';
import { isSelected, type SourceFilter } from '../source';
import { BUNDLE_FORMAT, type ImportBundle, type ImportNote } from '../types';

/**
 * Vendor export adapters: `mem0:<file.json>` and `zep:<file.json>`.
 *
 * Files only; no vendor API is called. Each record becomes one Markdown note under the import namespace and
 * then travels the normal import path (secret screen, preview, apply). Shapes follow the vendors'
 * public documentation: mem0 memory records (`id`, `memory`, `created_at`, `metadata`, `user_id`) as a JSON array
 * or `{results: [...]}`; Zep facts (`uuid`, `fact`, `created_at`, `valid_at`, `invalid_at`) as a JSON array or
 * `{facts|edges|results: [...]}`.
 */

export const VENDOR_KINDS = ['mem0', 'zep'] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];

/** RENOR_IMPORT_VENDOR_SOURCES=0 (or false/off/no) restores the previous behavior: these source names are unknown. */
export function vendorSourcesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_IMPORT_VENDOR_SOURCES ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

export function isVendorKind(kind: string): kind is VendorKind {
  return (VENDOR_KINDS as readonly string[]).includes(kind);
}

const MAX_BYTES = 64 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(kind: VendorKind, data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (isObject(data)) {
    const keys = kind === 'mem0' ? ['results', 'memories'] : ['facts', 'edges', 'results'];
    for (const key of keys) if (Array.isArray(data[key])) return data[key] as unknown[];
  }
  throw new Error(`${kind} export must be a JSON array of records or an object holding them under ${kind === 'mem0' ? 'results' : 'facts'}`);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isoDate(raw: unknown, where: string, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${where} has an invalid ${field}`);
  return parsed.toISOString();
}

const q = (value: string) => JSON.stringify(value);

function safeFileId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return cleaned || 'record';
}

export function readVendorSource(kind: VendorKind, file: string, filter: SourceFilter): ImportBundle {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`${kind} source must be a JSON file`);
  if (stat.size > MAX_BYTES) throw new Error(`${kind} export is larger than ${MAX_BYTES} bytes`);
  const raw = fs.readFileSync(resolved, 'utf8');
  if (raw.trim() === '') throw new Error(`${kind} export is empty`);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${kind} export is not valid JSON`);
  }
  const list = records(kind, data);
  const textField = kind === 'mem0' ? 'memory' : 'fact';
  const idField = kind === 'mem0' ? 'id' : 'uuid';

  const seen = new Set<string>();
  const all: ImportNote[] = list.map((record, index) => {
    const rid = isObject(record) ? text(record[idField]) : undefined;
    const where = `${kind} record ${index + 1}${rid ? ` (${rid})` : ''}`;
    if (!isObject(record)) throw new Error(`${where} is not an object`);
    const body = text(record[textField]);
    if (!body) throw new Error(`${where} has no ${textField} text`);
    const created = isoDate(record.created_at, where, 'created_at');
    const validAt = kind === 'zep' ? isoDate(record.valid_at, where, 'valid_at') : undefined;
    const invalidAt = kind === 'zep' ? isoDate(record.invalid_at, where, 'invalid_at') : undefined;
    const date = created ?? validAt ?? '1970-01-01T00:00:00.000Z';
    let name = safeFileId(rid ?? `record-${index + 1}`);
    while (seen.has(name)) name = `${name}-${index + 1}`;
    seen.add(name);

    const front: string[] = [`source: ${q(kind)}`, `record_id: ${q(rid ?? `record-${index + 1}`)}`, `date: ${q(date)}`];
    if (kind === 'mem0') {
      const user = text(record.user_id);
      if (user) front.push(`user_id: ${q(user)}`);
      if (isObject(record.metadata)) {
        for (const [key, value] of Object.entries(record.metadata)) {
          if (/^[A-Za-z0-9_]{1,40}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
            front.push(`meta_${key}: ${q(String(value))}`);
          }
        }
      }
    } else {
      if (validAt) front.push(`valid_at: ${q(validAt)}`);
      if (invalidAt) front.push(`invalid_at: ${q(invalidAt)}`);
    }
    const day = date.slice(0, 10);
    // A superseded Zep fact must not read as a current rule.
    const line = invalidAt ? `- (retired ${invalidAt.slice(0, 10)}, no longer true) ${body}` : body;
    const content = `---\n${front.join('\n')}\n---\n\n# ${day} ${kind} memory\n\n${line}\n`;
    const relPath = `${name}.md`;
    return parseMarkdownImportNote(`${kind}:${name}`, relPath, content, date);
  });

  const selected = all.filter(note => isSelected(note.relPath, filter));
  const limited = filter.limit === undefined ? selected : selected.slice(0, filter.limit);
  return {
    format: BUNDLE_FORMAT, sourceLabel: kind, notes: limited, facts: [],
    stats: {
      notesAvailable: all.length, notesSelected: limited.length, notesFilteredOut: all.length - limited.length,
      notesWithOriginalBytes: limited.length,
      chunksSelected: limited.reduce((sum, note) => sum + note.chunks.length, 0),
      factsAvailable: 0, factsSelected: 0,
    },
  };
}
