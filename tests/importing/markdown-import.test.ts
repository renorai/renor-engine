import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { run } from '../../src/importing/cli';
import { readMarkdownSource } from '../../src/importing/markdown';
import { readBundleSource } from '../../src/importing/source';
import { loadMvpConfig } from '../../src/mvp/config';
import { startMvpService } from '../../src/mvp/server';
import { bytes, latin1, rawPath, supportsNonUtf8Names } from '../helpers/nonUtf8Names';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-import-'));
  roots.push(root);
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  const write = (rel: string, text: string | Buffer) => {
    const file = path.join(vault, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  return { root, vault, destination: path.join(root, 'memory'), write };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeRaw(vault: string, segments: Buffer[], text: string) {
  fs.mkdirSync(rawPath(vault, ...segments.slice(0, -1)), { recursive: true });
  fs.writeFileSync(rawPath(vault, ...segments), text);
}

describe('Markdown folder import', () => {
  it('uses vault ignore rules, does not follow links, filters before parsing and limits deterministically', async () => {
    const { vault, write } = fixture();
    write('Projects/b.md', '# B\n\nUseful note.\n');
    write('Projects/a.md', '# A\n\n[[B]]\n');
    write('Private/private.md', '---\nbroken: [\n---\n');
    for (const dir of ['.obsidian', '.trash', '.memory-index', '.semantic-memory', 'node_modules', 'Ignored']) {
      write(`${dir}/hidden.md`, '# Hidden');
    }
    write('.semanticignore', 'Ignored/\n');
    write('image.png', Buffer.from([0, 255]));
    write('UPPER.MD', '# Unsupported extension');
    fs.symlinkSync(path.join(vault, 'Private'), path.join(vault, 'linked-folder'));
    fs.symlinkSync(path.join(vault, 'Private/private.md'), path.join(vault, 'linked.md'));
    const bundle = await readMarkdownSource(vault, { include: [], exclude: ['Private'], limit: 1 });
    expect(bundle.notes.map(n => n.relPath)).toEqual(['Projects/a.md']);
    // Three notes exist; --exclude removed one and --limit removed another, so two were left out.
    // (It used to expect 1, which froze the --limit cut as invisible.)
    expect(bundle.stats).toMatchObject({ notesAvailable: 3, notesSelected: 1, notesFilteredOut: 2 });
    expect(bundle.stats.notesAvailable).toBe(bundle.stats.notesSelected + bundle.stats.notesFilteredOut);
    expect(bundle.facts).toEqual([]);
    const selected = await readMarkdownSource(vault, { include: ['Projects'], exclude: ['Projects/a.md'] });
    expect(selected.notes.map(n => n.relPath)).toEqual(['Projects/b.md']);
  });

  it('rejects invalid input before creating the destination and does not expose YAML content', async () => {
    const { vault, destination, write } = fixture();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    write('bad.md', Buffer.from([0xff]));
    const args = ['--from', `markdown:${vault}`, '--to', destination, '--apply', '--json'];
    expect(await run(args)).toBe(1);
    expect(fs.existsSync(destination)).toBe(false);
    expect(error.mock.calls.flat().join(' ')).toContain('not UTF-8');
    write('bad.md', '---\nprivate-secret-canary: [\n---\n');
    error.mockClear();
    expect(await run(args)).toBe(1);
    expect(fs.existsSync(destination)).toBe(false);
    expect(error.mock.calls.flat().join(' ')).not.toContain('private-secret-canary');
    write('bad.md', '# Binary\n\0');
    expect(await run(args)).toBe(1);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('rejects overlapping folders, including a linked destination ancestor', async () => {
    const { root, vault, write } = fixture();
    write('note.md', '# Note');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const link = path.join(root, 'vault-link');
    fs.symlinkSync(vault, link);
    for (const destination of [vault, path.join(vault, 'memory'), root, path.join(link, 'memory')]) {
      expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--apply'])).toBe(1);
    }
    expect(fs.readdirSync(vault)).toEqual(['note.md']);
  });

  it('exports a selected folder as a portable bundle and refuses to overwrite accepted notes', async () => {
    const { root, vault, destination, write } = fixture();
    write('Project/note.md', '# Project\n\nKeep this decision.\n');
    write('Private/note.md', '# Private\n\nDo not carry this.\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bundle = path.join(root, 'selected.jsonl');
    expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--exclude', 'Private', '--emit-bundle', bundle, '--json'])).toBe(0);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.statSync(bundle).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(bundle, 'utf8')).not.toContain('Do not carry this.');
    const args = ['--from', `bundle:${bundle}`, '--to', destination, '--namespace', 'Imported/vault', '--apply', '--json'];
    expect(await run(args)).toBe(0);
    write('Project/note.md', '# Project\n\nA changed decision.\n');
    expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--exclude', 'Private', '--apply', '--json'])).toBe(3);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).applied.notesConflicting).toBe(1);
    expect(fs.readFileSync(path.join(destination, 'Imported/vault/Project/note.md'), 'utf8')).toContain('Keep this decision.');
  });

  it('previews without writes, preserves Markdown, recalls over authenticated MCP, and supports subsequent saves', async () => {
    const { root, vault, destination, write } = fixture();
    const original = '---\ntags: [project, telescope]\naliases: [Orion]\n---\n# Observatory\n\nThe observatory uses amber filters. See [[Calibration]].\n';
    write('Projects/Observatory.md', original);
    write('Calibration.md', '# Calibration\n\nCalibrate at dusk.\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['--from', `markdown:${vault}`, '--to', destination, '--json'];
    expect(await run(args)).toBe(0);
    expect(fs.existsSync(destination)).toBe(false);
    expect(output.mock.calls.flat().join(' ')).not.toContain('amber filters');
    expect(await run([...args, '--apply'])).toBe(0);
    const copied = path.join(destination, 'Imported/vault/Projects/Observatory.md');
    expect(fs.readFileSync(copied, 'utf8')).toBe(original);
    expect(fs.readFileSync(path.join(vault, 'Projects/Observatory.md'), 'utf8')).toBe(original);
    expect(await run([...args, '--apply'])).toBe(0);
    const summary = JSON.parse(output.mock.calls.at(-1)![0]);
    expect(summary.applied.notesWritten).toBe(0);
    expect(summary.applied.notesUnchanged).toBe(2);

    vi.stubEnv('MVP_MEMORY_DIR', destination);
    fs.mkdirSync(path.join(root, 'auth'), { mode: 0o700 });
    vi.stubEnv('MVP_AUTH_STATE_PATH', path.join(root, 'auth/clients.json'));
    vi.stubEnv('MVP_BASE_URL', 'http://127.0.0.1:9999');
    vi.stubEnv('MVP_OWNER_EMAIL', 'fixture@example.test');
    vi.stubEnv('MVP_OWNER_PASSWORD', 'synthetic-password-only');
    vi.stubEnv('MVP_GATEWAY_SECRET', 'synthetic-gateway-secret');
    vi.stubEnv('MVP_EMBEDDING_PROVIDER', 'none');
    vi.stubEnv('MVP_DB_PATH', '');
    vi.stubEnv('MVP_HISTORY_DIR', '');
    vi.stubEnv('MVP_LEDGER_REL', 'System/Memory Events Ledger.md');
    const config = { ...loadMvpConfig(), port: 0 };
    const service = await startMvpService(config, null);
    let client = new Client({ name: 'markdown-fixture', version: '1' });
    try {
      const token = await request(service.app).post('/internal/gateway-token')
        .set('x-renor-gateway-secret', config.gatewaySecret).send({}).expect(200);
      const port = (service.httpServer.address() as { port: number }).port;
      const connect = async () => client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token.body.access_token}` } },
      }));
      await connect();
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        return JSON.parse((result.content as Array<{ text: string }>)[0].text);
      };
      const recalled = await call('search_text', { query: 'amber filters' });
      expect(JSON.stringify(recalled)).toContain('amber filters');
      expect(JSON.stringify(recalled)).toContain('Imported/vault/Projects/Observatory.md');
      const saved = await call('remember', {
        statement: 'The observatory now uses violet filters.',
        subject: 'Observatory', predicate: 'filter_color', object: 'violet',
      });
      expect(saved.ok).toBe(true);
      expect(saved.eventId).toMatch(/^MEM_/);
      await client.close();
      client = new Client({ name: 'second-agent-fixture', version: '1' });
      await connect();
      const current = await call('retrieve_memory', { subject: 'Observatory', predicate: 'filter_color' });
      expect(JSON.stringify(current)).toContain('violet');
      expect(fs.readFileSync(copied, 'utf8')).toBe(original);
    } finally {
      await client.close();
      service.httpServer.close();
      await service.close();
    }
  });
});

describe('Markdown folder import — what the preview says was left out', () => {
  function threeNotes() {
    const fx = fixture();
    fx.write('a.md', '# A\n\nalpha\n');
    fx.write('b.md', '# B\n\nbeta\n');
    fx.write('c.md', '# C\n\ngamma\n');
    return fx;
  }

  it('counts the notes --limit dropped, in the JSON preview and in the text summary', async () => {
    const { vault, destination } = threeNotes();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const preview = async (...extra: string[]) => {
      output.mockClear();
      expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--json', ...extra])).toBe(0);
      return JSON.parse(output.mock.calls.at(-1)![0]);
    };
    // Three eligible notes, no filter, --limit 1: the preview used to say nothing was left out.
    expect((await preview('--limit', '1')).counts).toMatchObject({ selectedNotes: 1, notesInBundle: 1, notesFilteredOut: 2 });
    expect((await preview('--limit', '3')).counts).toMatchObject({ selectedNotes: 3, notesFilteredOut: 0 });
    expect((await preview('--limit', '10')).counts).toMatchObject({ selectedNotes: 3, notesFilteredOut: 0 });
    expect((await preview()).counts).toMatchObject({ selectedNotes: 3, notesFilteredOut: 0 });
    // A filter and a limit add up.
    expect((await preview('--exclude', 'c.md', '--limit', '1')).counts).toMatchObject({ selectedNotes: 1, notesFilteredOut: 2 });

    output.mockClear();
    expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--limit', '1'])).toBe(0);
    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('2 note(s)');
    expect(text).toContain('left out by --include/--exclude/--limit');
    output.mockClear();
    expect(await run(['--from', `markdown:${vault}`, '--to', destination])).toBe(0);
    expect(output.mock.calls.flat().join('\n')).not.toContain('left out by');
  });

  it('counts a limit cut exactly as the bundle adapter does for the same notes, filter and limit', async () => {
    const { root, vault, destination } = threeNotes();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const bundleFile = path.join(root, 'all.jsonl');
    expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--emit-bundle', bundleFile, '--json'])).toBe(0);
    for (const filter of [
      { include: [], exclude: [], limit: 1 },
      { include: [], exclude: ['c.md'], limit: 1 },
      { include: ['a.md', 'b.md'], exclude: [], limit: 5 },
      { include: [], exclude: [], limit: 0 },
      { include: [], exclude: [] },
    ]) {
      const fromFolder = (await readMarkdownSource(vault, filter)).stats;
      const fromBundle = readBundleSource(bundleFile, filter).stats;
      expect(fromFolder, JSON.stringify(filter)).toMatchObject({
        notesAvailable: fromBundle.notesAvailable,
        notesSelected: fromBundle.notesSelected,
        notesFilteredOut: fromBundle.notesFilteredOut,
      });
      expect(fromFolder.notesAvailable).toBe(fromFolder.notesSelected + fromFolder.notesFilteredOut);
    }
  });
});

// These skip on a filesystem that cannot store such a name (APFS); on Linux a skip would only hide them.
it.runIf(process.platform === 'linux')('can store a name that is not valid UTF-8, so the tests below are not silently skipped', () => {
  expect(supportsNonUtf8Names).toBe(true);
});

describe.skipIf(!supportsNonUtf8Names)('Markdown folder import — names that are not valid UTF-8', () => {
  const BAD = String.raw`\xff\xfename.md`;
  function vaultWithBadName() {
    const fx = fixture();
    fx.write('good.md', '# Good\n\nA fine note.\n');
    fx.write('Projects/ok.md', '# Ok\n\nAlso fine.\n');
    writeRaw(fx.vault, [bytes([0xff, 0xfe], 'name.md')], '# BadName\n\nbody-canary\n');
    return fx;
  }

  it('previews and applies around a file whose name is not valid UTF-8 instead of dying with ENOENT', async () => {
    const { vault, destination } = vaultWithBadName();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const args = ['--from', `markdown:${vault}`, '--to', destination, '--json'];

    expect(await run(args)).toBe(0);
    expect(fs.existsSync(destination)).toBe(false);
    const preview = JSON.parse(output.mock.calls.at(-1)![0]);
    expect(preview.counts).toMatchObject({ selectedNotes: 2, notesFilteredOut: 0, notesSkippedNonUtf8Name: 1 });
    expect(preview.skipped.nonUtf8Names).toEqual([BAD]);
    expect(JSON.stringify(preview)).not.toContain('body-canary');

    expect(await run([...args, '--apply'])).toBe(0);
    const applied = JSON.parse(output.mock.calls.at(-1)![0]);
    expect(applied.applied.notesWritten).toBe(2);
    expect(applied.skipped.nonUtf8Names).toEqual([BAD]);
    expect(fs.readFileSync(path.join(destination, 'Imported/vault/good.md'), 'utf8')).toContain('A fine note.');
    expect(fs.readFileSync(path.join(destination, 'Imported/vault/Projects/ok.md'), 'utf8')).toContain('Also fine.');
    expect(fs.readdirSync(path.join(destination, 'Imported/vault')).sort()).toEqual(['Projects', 'good.md']);
    // Fresh database migration diagnostics now belong on stderr; actual import
    // failures must still be absent while invalid filenames are skipped.
    expect(error.mock.calls.filter(([message]) => !String(message).includes('"event":"database_ready"'))).toEqual([]);
  });

  it('names the file in the text summary and says what to do about it', async () => {
    const { vault, destination } = vaultWithBadName();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--from', `markdown:${vault}`, '--to', destination])).toBe(0);
    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain(BAD);
    expect(text).toContain('not valid UTF-8');
    expect(text).toMatch(/rename/i);
    expect(text).not.toContain('body-canary');
  });

  it('also reports it when exporting a bundle, so a bundle is never silently short of notes', async () => {
    const { root, vault, destination } = vaultWithBadName();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bundle = path.join(root, 'vault.jsonl');
    expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--emit-bundle', bundle, '--json'])).toBe(0);
    const emitted = JSON.parse(output.mock.calls.at(-1)![0]);
    expect(emitted.counts.notes).toBe(2);
    expect(emitted.skipped.nonUtf8Names).toEqual([BAD]);
    output.mockClear();
    expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--emit-bundle', bundle])).toBe(0);
    expect(output.mock.calls.flat().join('\n')).toContain(BAD);
  });

  it('keeps the selection arithmetic honest: a skipped name is neither available nor filtered out', async () => {
    const { vault } = vaultWithBadName();
    const bundle = await readMarkdownSource(vault, { include: [], exclude: [] });
    expect(bundle.notes.map(n => n.relPath)).toEqual(['good.md', 'Projects/ok.md']);
    expect(bundle.nonUtf8Names).toEqual([BAD]);
    expect(bundle.stats).toMatchObject({ notesAvailable: 2, notesSelected: 2, notesFilteredOut: 0 });
  });

  it('reports each note below a folder with such a name, and nothing for a folder holding only attachments', async () => {
    const { vault, destination, write } = fixture();
    write('ok.md', '# Ok\n\nfine\n');
    writeRaw(vault, [latin1('Reunião'), Buffer.from('ata.md')], '# Ata\n\ninside\n');
    writeRaw(vault, [latin1('Anexoç'), Buffer.from('logo.png')], 'not markdown');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--json'])).toBe(0);
    const preview = JSON.parse(output.mock.calls.at(-1)![0]);
    expect(preview.counts).toMatchObject({ selectedNotes: 1, notesSkippedNonUtf8Name: 1 });
    expect(preview.skipped.nonUtf8Names).toEqual([String.raw`Reuni\xe3o/ata.md`]);
  });

  it('does not report what the selection already leaves out, nor files that are not Markdown', async () => {
    const { vault, destination, write } = fixture();
    write('ok.md', '# Ok\n\nfine\n');
    writeRaw(vault, [Buffer.from('Private'), bytes([0xff], '.md')], '# Private\n');
    writeRaw(vault, [bytes([0xff], 'picture.png')], 'not markdown');
    writeRaw(vault, [Buffer.from('Shared'), bytes([0xfe], '.md')], '# Shared\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--json', '--exclude', 'Private'])).toBe(0);
    const preview = JSON.parse(output.mock.calls.at(-1)![0]);
    expect(preview.skipped.nonUtf8Names).toEqual([String.raw`Shared/\xfe.md`]);
    expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--json', '--include', 'ok.md'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).skipped.nonUtf8Names).toEqual([]);
  });

  it('imports a name that only looks broken: a real U+FFFD or other Unicode is valid UTF-8', async () => {
    const { vault, destination, write } = fixture();
    write('broken\u{FFFD}name.md', '# Replacement\n\ncharacter in a valid name\n');
    write('Résumé 日本語 😀.md', '# Unicode\n\nvalid\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--from', `markdown:${vault}`, '--to', destination, '--json'])).toBe(0);
    const preview = JSON.parse(output.mock.calls.at(-1)![0]);
    expect(preview.counts).toMatchObject({ selectedNotes: 2, notesSkippedNonUtf8Name: 0 });
    expect(preview.skipped.nonUtf8Names).toEqual([]);
  });
});
