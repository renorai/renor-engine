import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/importing/cli';
import { Rng, KEY_SHAPES } from '../../scripts/eval/secret-guard/plantedSet';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-import-'));
  roots.push(root);
  const write = (name: string, data: unknown) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
    return file;
  };
  return { root, dest: path.join(root, 'memory'), write };
}
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const mem0 = Array.from({ length: 6 }, (_, i) => ({
  id: `m-${i + 1}`, memory: `Invented preference number ${i + 1}: likes tea variety ${i + 1}`,
  created_at: `2026-0${i + 1}-15T10:00:00Z`, user_id: 'u1', metadata: { topic: 'tea' },
}));
const zep = {
  facts: [
    { uuid: 'z-1', fact: 'Rowan lives in Lisbon', created_at: '2026-02-01T00:00:00Z', valid_at: '2026-02-01T00:00:00Z' },
    { uuid: 'z-2', fact: 'Rowan works at Orbit Labs', created_at: '2026-01-01T00:00:00Z', invalid_at: '2026-03-01T00:00:00Z' },
    { uuid: 'z-3', fact: 'Rowan drinks oolong', created_at: '2026-04-01T00:00:00Z' },
  ],
};

const listing = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const jsonOf = () => JSON.parse((console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string);

describe('mem0 and zep sources', () => {
  it('previews, applies once, and a second apply is a no-op (mem0)', async () => {
    const f = fixture();
    const file = f.write('export.json', { results: mem0 });
    expect(await run(['--from', `mem0:${file}`, '--to', f.dest, '--json'])).toBe(0);
    expect(jsonOf().counts.selectedNotes).toBe(6);
    expect(listing(path.join(f.dest, 'Imported/mem0'))).toEqual([]);
    expect(await run(['--from', `mem0:${file}`, '--to', f.dest, '--apply', '--json'])).toBe(0);
    const dir = path.join(f.dest, 'Imported/mem0');
    expect(listing(dir)).toEqual(mem0.map(r => `${r.id}.md`));
    const body = fs.readFileSync(path.join(dir, 'm-1.md'), 'utf8');
    expect(body).toContain('record_id: "m-1"');
    expect(body).toContain('2026-01-15T10:00:00.000Z');
    expect(body).toContain('likes tea variety 1');
    expect(await run(['--from', `mem0:${file}`, '--to', f.dest, '--apply', '--json'])).toBe(0);
    expect(jsonOf().applied.notesWritten).toBe(0);
    expect(jsonOf().applied.notesUnchanged).toBe(6);
    // Everything written lives in the one folder, so removing it removes exactly the imported notes.
    expect(listing(path.join(f.dest, 'Imported'))).toEqual(['mem0']);
  });

  it('imports zep facts and writes an invalidated fact as a retired line', async () => {
    const f = fixture();
    const file = f.write('facts.json', zep);
    expect(await run(['--from', `zep:${file}`, '--to', f.dest, '--apply', '--json'])).toBe(0);
    const dir = path.join(f.dest, 'Imported/zep');
    expect(listing(dir)).toEqual(['z-1.md', 'z-2.md', 'z-3.md']);
    const retired = fs.readFileSync(path.join(dir, 'z-2.md'), 'utf8');
    expect(retired).toContain('(retired 2026-03-01, no longer true) Rowan works at Orbit Labs');
    expect(fs.readFileSync(path.join(dir, 'z-1.md'), 'utf8')).not.toContain('retired');
  });

  it('skips and counts a record that holds a secret when the guard is on', async () => {
    vi.stubEnv('RENOR_SECRET_GUARD', '1');
    const f = fixture();
    const key = KEY_SHAPES.openai_proj(new Rng(7));
    const file = f.write('export.json', [...mem0.slice(0, 2), { id: 'm-secret', memory: `the staging key is ${key}`, created_at: '2026-05-01T00:00:00Z' }]);
    expect(await run(['--from', `mem0:${file}`, '--to', f.dest, '--apply', '--json'])).toBe(3);
    expect(listing(path.join(f.dest, 'Imported/mem0'))).toEqual(['m-1.md', 'm-2.md']);
    expect(jsonOf().skipped.secretGuard.notes).toHaveLength(1);
    expect(JSON.stringify(jsonOf())).not.toContain(key.slice(-14));
  });

  it('refuses malformed input with a plain message and no write', async () => {
    const f = fixture();
    const cases: Array<[string, string, string]> = [
      ['mem0', '{not json', 'not valid JSON'],
      ['mem0', '', 'is empty'],
      ['mem0', JSON.stringify([mem0[0], { id: 'bad-1', memory: '   ' }]), 'record 2 (bad-1) has no memory text'],
      ['zep', JSON.stringify([{ uuid: 'z-x', created_at: '2026-01-01' }]), 'record 1 (z-x) has no fact text'],
      ['zep', JSON.stringify([{ uuid: 'z-d', fact: 'x', created_at: 'not a date' }]), 'record 1 (z-d) has an invalid created_at'],
    ];
    for (const [kind, data, message] of cases) {
      const file = f.write('bad.json', data);
      expect(await run(['--from', `${kind}:${file}`, '--to', f.dest, '--apply'])).toBe(1);
      expect((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toContain(message);
      expect(fs.existsSync(path.join(f.dest, 'Imported'))).toBe(false);
    }
  });

  it('with RENOR_IMPORT_VENDOR_SOURCES=0 answers as an unknown source, as before', async () => {
    vi.stubEnv('RENOR_IMPORT_VENDOR_SOURCES', '0');
    const f = fixture();
    const file = f.write('export.json', mem0);
    expect(await run(['--from', `mem0:${file}`, '--to', f.dest, '--apply'])).toBe(1);
    expect((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0])
      .toBe('source read failed: unknown source kind "mem0"; expected renor-index or bundle');
    expect(fs.existsSync(f.dest)).toBe(false);
  });
});

describe('import prints where it wrote and how to undo it', () => {
  const printed = () => (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0])).join('\n');
  for (const [kind, data, count] of [['mem0', { results: mem0 }, 6], ['zep', zep, 3]] as const) {
    it(`${kind}: folder, count and undo line; all files under Imported/${kind}`, async () => {
      const f = fixture();
      const file = f.write('export.json', data);
      expect(await run(['--from', `${kind}:${file}`, '--to', f.dest, '--apply'])).toBe(0);
      const folder = path.join(f.dest, 'Imported', kind);
      expect(printed()).toContain(`written to    : ${folder} (${count} file(s))`);
      expect(printed()).toContain(`undo          : remove ${folder}`);
      expect(listing(path.join(f.dest, 'Imported'))).toEqual([kind]);
      expect(listing(folder)).toHaveLength(count);
    });
  }
  it('json carries the same undo block, and a dry run prints none', async () => {
    const f = fixture();
    const file = f.write('export.json', { results: mem0 });
    expect(await run(['--from', `mem0:${file}`, '--to', f.dest, '--json'])).toBe(0);
    expect(jsonOf().undo).toBeUndefined();
    expect(await run(['--from', `mem0:${file}`, '--to', f.dest, '--apply', '--json'])).toBe(0);
    expect(jsonOf().undo).toEqual({ folder: path.join(f.dest, 'Imported/mem0'), files: 6, line: `remove ${path.join(f.dest, 'Imported/mem0')}` });
  });
  it('quotes a destination with spaces so the printed line is safe to paste', async () => {
    const f = fixture();
    const file = f.write('export.json', { results: mem0 });
    const spaced = path.join(f.root, 'my memory');
    expect(await run(['--from', `mem0:${file}`, '--to', spaced, '--apply', '--json'])).toBe(0);
    expect((jsonOf().undo as { line: string }).line).toBe(`remove '${path.join(spaced, 'Imported/mem0')}'`);
  });

  it('a second import into the same folder counts only what it wrote and offers no undo line', async () => {
    const f = fixture();
    const file = f.write('export.json', { results: mem0 });
    expect(await run(['--from', `mem0:${file}`, '--to', f.dest, '--apply', '--json'])).toBe(0);
    expect(await run(['--from', `mem0:${file}`, '--to', f.dest, '--apply', '--json'])).toBe(0);
    const undo = jsonOf().undo as { files: number; line: string | null; note: string };
    expect(undo.files).toBe(0);
    expect(undo.line).toBeNull();
    expect(undo.note).toContain('6 note(s) already in the folder would be deleted too');
  });

  it('a conflicting note the user already has is never offered for deletion', async () => {
    const f = fixture();
    const file = f.write('export.json', { results: mem0 });
    const dir = path.join(f.dest, 'Imported/mem0');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'm-1.md'), 'my own edited note');
    expect(await run(['--from', `mem0:${file}`, '--to', f.dest, '--apply', '--json'])).toBe(3);
    const undo = jsonOf().undo as { files: number; line: string | null; note: string };
    expect(undo.files).toBe(5);
    expect(undo.line).toBeNull();
    expect(undo.note).toContain('1 note(s) already in the folder would be deleted too');
  });

  it('notes from an earlier, different import in the folder withhold the undo line', async () => {
    const f = fixture();
    const first = f.write('first.json', { results: mem0.slice(0, 3) });
    const second = f.write('second.json', { results: mem0.slice(3) });
    expect(await run(['--from', `mem0:${first}`, '--to', f.dest, '--apply', '--json'])).toBe(0);
    expect((jsonOf().undo as { line: string | null }).line).not.toBeNull();
    expect(await run(['--from', `mem0:${second}`, '--to', f.dest, '--apply', '--json'])).toBe(0);
    const undo = jsonOf().undo as { files: number; line: string | null; note: string };
    expect(undo.files).toBe(3);
    expect(undo.line).toBeNull();
    expect(undo.note).toContain('3 note(s) already in the folder would be deleted too');
  });

  it('says so when the import also wrote ledger events, instead of calling folder removal an undo', async () => {
    const f = fixture();
    const file = f.write('facts.json', zep);
    expect(await run(['--from', `zep:${file}`, '--to', f.dest, '--apply', '--json'])).toBe(0);
    const undo = jsonOf().undo as { line: string | null; note?: string };
    if (undo.line === null) expect(undo.note).toMatch(/fact event\(s\) stay in the ledger/);
    else expect(undo.note).toBeUndefined();
  });
});
