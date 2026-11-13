import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { openIndexDb } from './db/client.js';
import { runMigrations } from './db/schema.js';
import { replayLedger, resolveLedgerPath } from './memory/lifecycle.js';

/**
 * `renor-engine backup | verify | restore`: a self-hoster's way to keep, check and bring back the memory folder.
 * The archive holds the Markdown notes (the ledger is one of them) under `files/` and a MANIFEST.json with the SHA-256
 * of each. The index is derived and is never archived: `rebuild` makes it again. Format: gzip over a plain ustar tar,
 * written and read here, so no dependency is added.
 */

export const BACKUP_FORMAT = 'renor-engine-backup-1';
const IGNORED_DIRS = new Set(['.obsidian', '.trash', '.semantic-memory', '.memory-index', 'node_modules', '.git']);

/** `RENOR_ENGINE_BACKUP=0` turns the three commands off: they are then not registered, as before. */
export function backupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.RENOR_ENGINE_BACKUP;
  return !(v === '0' || v === 'off' || v === 'false');
}

export class BackupError extends Error {}

interface ManifestFile { path: string; sha256: string; bytes: number }
interface Manifest { format: string; createdAt: string; files: ManifestFile[] }

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function listNotes(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) out.push(...listNotes(root, next));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(next);
  }
  return out.sort();
}

// ---- tar (ustar) ----

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, mtime: number): Buffer {
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    prefix = cut > 0 ? name.slice(0, cut) : '';
    base = cut > 0 ? name.slice(cut + 1) : name;
    if (!prefix || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) {
      throw new BackupError(`the path is too long to archive: ${name}`);
    }
  }
  const h = Buffer.alloc(512);
  h.write(base, 0, 100);
  h.write(octal(0o644, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(mtime, 12), 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function tarPack(entries: { name: string; data: Buffer }[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const parts: Buffer[] = [];
  for (const { name, data } of entries) {
    parts.push(header(name, data.length, mtime), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function cstr(buf: Buffer, from: number, len: number): string {
  const slice = buf.subarray(from, from + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? len : end).toString('utf8');
}

function tarUnpack(tar: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const h = tar.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) break;
    const stored = parseInt(cstr(h, 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (stored !== sum) throw new BackupError('the archive is damaged (bad tar header)');
    const base = cstr(h, 0, 100);
    const prefix = cstr(h, 345, 155);
    const name = prefix ? `${prefix}/${base}` : base;
    const type = String.fromCharCode(h[156] || 48);
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8);
    pos += 512;
    if (type === '5') continue;
    if (type !== '0') throw new BackupError(`the archive holds an entry that is not a plain file: ${name}`);
    if (pos + size > tar.length) throw new BackupError('the archive is damaged (cut short)');
    out.push({ name, data: Buffer.from(tar.subarray(pos, pos + size)) });
    pos += Math.ceil(size / 512) * 512;
  }
  return out;
}

// ---- commands ----

export function defaultBackupName(now = new Date()): string {
  return `renor-backup-${now.toISOString().slice(0, 10)}.tar.gz`;
}

export function createBackup(vaultPath: string, outFile: string): { out: string; files: number; bytes: number } {
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    throw new BackupError(`the memory folder ${vaultPath} does not exist or is not a folder (set VAULT_PATH)`);
  }
  const files: ManifestFile[] = [];
  const entries: { name: string; data: Buffer }[] = [];
  for (const rel of listNotes(vaultPath)) {
    const data = fs.readFileSync(path.join(vaultPath, rel));
    files.push({ path: rel, sha256: sha(data), bytes: data.length });
    entries.push({ name: `files/${rel}`, data });
  }
  const manifest: Manifest = { format: BACKUP_FORMAT, createdAt: new Date().toISOString(), files };
  const tar = tarPack([{ name: 'MANIFEST.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }, ...entries]);
  const target = path.resolve(outFile);
  if (fs.existsSync(target)) throw new BackupError(`${target} already exists; choose another --out`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.partial`;
  fs.writeFileSync(tmp, zlib.gzipSync(tar));
  fs.renameSync(tmp, target);
  return { out: target, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}

function safeRel(rel: string): boolean {
  if (!rel || rel.includes('\0') || rel.includes('\\') || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Reads and checks the archive: every checksum, no extra or unsafe entry. Returns the files, ready to write. */
export function readBackup(file: string): { manifest: Manifest; files: { path: string; data: Buffer }[] } {
  let raw: Buffer;
  try { raw = fs.readFileSync(file); } catch { throw new BackupError(`cannot read ${file}`); }
  let entries: { name: string; data: Buffer }[];
  try { entries = tarUnpack(zlib.gunzipSync(raw)); } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError(`${file} is not a readable backup (damaged or not a .tar.gz)`);
  }
  const mEntry = entries.find((e) => e.name === 'MANIFEST.json');
  if (!mEntry) throw new BackupError('the archive has no MANIFEST.json');
  let manifest: Manifest;
  try { manifest = JSON.parse(mEntry.data.toString('utf8')); } catch { throw new BackupError('MANIFEST.json is not valid JSON'); }
  if (manifest?.format !== BACKUP_FORMAT || !Array.isArray(manifest.files)) throw new BackupError('MANIFEST.json is not a Renor backup manifest');
  const byName = new Map(entries.filter((e) => e !== mEntry).map((e) => [e.name, e.data]));
  const files: { path: string; data: Buffer }[] = [];
  for (const f of manifest.files) {
    if (typeof f?.path !== 'string' || !safeRel(f.path)) throw new BackupError(`refusing an unsafe path in the archive: ${JSON.stringify(f?.path)}`);
    const data = byName.get(`files/${f.path}`);
    if (!data) throw new BackupError(`${f.path} is listed in the manifest but missing from the archive`);
    if (sha(data) !== f.sha256) throw new BackupError(`checksum mismatch: ${f.path}`);
    byName.delete(`files/${f.path}`);
    files.push({ path: f.path, data });
  }
  const extra = [...byName.keys()][0];
  if (extra !== undefined) throw new BackupError(`the archive holds a file the manifest does not list: ${extra}`);
  return { manifest, files };
}

function writeFiles(root: string, files: { path: string; data: Buffer }[]): void {
  for (const f of files) {
    const dest = path.join(root, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }
}

/** Checks the archive, then replays its ledger into a throwaway index and counts. */
export async function verifyBackup(file: string): Promise<{ notes: number; facts: number }> {
  const { files } = readBackup(file);
  const config = loadConfig();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-verify-'));
  try {
    writeFiles(tmp, files);
    const db = openIndexDb(path.join(tmp, '.verify-index.db'), resolveLedgerPath(tmp, config.memoryLedger));
    try {
      runMigrations(db);
      await replayLedger(db, tmp, config.memoryLedger);
      const facts = (db.prepare('SELECT COUNT(*) AS c FROM facts').get() as { c: number }).c;
      return { notes: files.length, facts };
    } catch (err) {
      throw new BackupError(`the ledger in the archive does not replay: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function restoreBackup(file: string, to: string): Promise<{ notes: number; facts: number; target: string }> {
  const target = path.resolve(to);
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new BackupError(`${target} exists and is not a folder`);
    if (fs.readdirSync(target).length > 0) throw new BackupError(`${target} is not empty; restore only into an empty folder`);
  }
  const counts = await verifyBackup(file);
  const { files } = readBackup(file);
  fs.mkdirSync(target, { recursive: true });
  writeFiles(target, files);
  return { ...counts, target };
}
