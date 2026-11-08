/**
 * Import trial: the attempts a first-time agent makes with common exports, run through the real MCP tools on a
 * throwaway workspace (eval-hash stub embeddings, no network, no provider). One fixed matrix, so the success rate
 * before and after a change is measured on the same attempts. An attempt succeeds when the call does what the agent
 * plainly asked and the result is sensible, or when it is refused with a message that names what to change.
 *
 * Set RENOR_TRIAL_REPORT=1 to print the table (source, tool, call, outcome, message) and the rate.
 * The sample exports are small and synthetic.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import type { Express } from 'express';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

type F = { relativePath: string; markdown: string };
interface Reply { error?: string; body?: any }
interface Attempt {
  id: string; source: string; tool: string; call: string;
  /** Files the workspace must hold afterwards (relative to the memory dir) and words search_text must find. */
  written?: string[]; words?: string[];
  /** The refusal, or the skip reason, must match this when the attempt asked for something the tool cannot do. */
  explains?: RegExp;
  /** Fails today and is reported as a failure; it.fails flips red when someone fixes it, so the flag gets removed then. */
  knownGap?: boolean;
  run: (d: Driver) => Promise<{ ok: boolean; detail: string }>;
}

const OWNER = { email: 'owner@example.test', password: 'synthetic-owner-secret-123' };
let memoryDir = '';
let authRoot = '';
let service: Awaited<ReturnType<typeof startMvpService>>;
let client: Client;
const results: Array<{ a: Attempt; ok: boolean; detail: string }> = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

async function token(app: Express) {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'import-trial', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] }).expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorize.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({ ticket, approve: 'on', ...OWNER }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  return tokens.body.access_token as string;
}

async function tool(name: string, args: Record<string, unknown>): Promise<Reply> {
  const reply = await client.callTool({ name, arguments: args });
  const text = (reply.content as { text: string }[])[0].text;
  if (reply.isError) return { error: text };
  return { body: JSON.parse(text) };
}

class Driver {
  /** What a new agent does: preview, look at it, apply. Stops at the first refusal. */
  async importFiles(args: Record<string, unknown>) {
    const preview = await tool('preview_import', args);
    if (preview.error) return { preview, error: preview.error };
    const applied = await tool('apply_import', { batchId: preview.body.batchId });
    return { preview, applied, error: applied.error };
  }
  preview(args: Record<string, unknown>) { return tool('preview_import', args); }
  apply(batchId: unknown) { return tool('apply_import', { batchId }); }
  undo(batchId: unknown) { return tool('undo_import', { batchId }); }
  exists(rel: string) { return fs.existsSync(path.join(memoryDir, rel)); }
  async found(word: string) { return (await tool('search_text', { query: word })).body?.results?.length > 0; }
}

/** The plain case: import these files and find every expected note and word afterwards. */
function imports(id: string, source: string, call: string, args: Record<string, unknown>, written: string[], words: string[]): Attempt {
  return { id, source, tool: 'preview_import → apply_import', call, written, words, run: async d => {
    const r = await d.importFiles(args);
    if (r.error) return { ok: false, detail: r.error };
    const missing = written.filter(rel => !d.exists(rel));
    if (missing.length) return { ok: false, detail: `not written: ${missing.join(', ')}` };
    for (const w of words) if (!(await d.found(w))) return { ok: false, detail: `not searchable: ${w}` };
    return { ok: true, detail: `${r.applied!.body.notesWritten} notes written` };
  } };
}
/** A request the tool cannot honour: the refusal (or a skip reason) must say what to change. */
function explained(id: string, source: string, tool: string, call: string, args: Record<string, unknown>, explains: RegExp): Attempt {
  return { id, source, tool, call, explains, run: async d => {
    const r = await d.preview(args);
    const text = r.error ?? JSON.stringify(r.body.skipped ?? []);
    return explains.test(text) ? { ok: true, detail: text } : { ok: false, detail: text };
  } };
}

const chatgptList = [
  'Prefers concise answers with no preamble',
  'Works as a staff engineer at a logistics company',
  'Is learning Portuguese; currently at B1',
  'Has a golden retriever named Biscuit',
].map(l => `- ${l}`).join('\n');
const claudeMd = '# Project notes for Claude\n\n## Conventions\n- Use pnpm, never npm.\n- Tests live in `tests/`, run with `pnpm test`.\n\n## Deploy\nStaging deploys happen from the `staging` branch.\n';
const claudeMemory = '---\nname: user-role\ndescription: who the user is\ntype: user\n---\n\nThe user is a data scientist who prefers Quokkafield notation.\n';
const chatgptExport = JSON.stringify([{ title: 'Trip planning', create_time: 1735000000, mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['Plan a Marzipan Coast road trip'] } } } } }], null, 2);
const memoriesJson = JSON.stringify({ memories: [{ id: 1, text: 'Allergic to Gooseberry' }, { id: 2, text: 'Runs on Tuesdays' }] }, null, 2);
const daily = '---\ntags: [daily, journal]\ndate: 2026-01-02\n---\n# 2026-01-02\nMet Tamsin about the [[Alpha Project]]. Mentioned Cormorant budget.\n![[Attachments/diagram.png]]\n';
const alpha = '---\naliases: [Alpha]\nstatus: active\n---\n# Alpha Project\nOwner: [[People/Tamsin]]. Ships in March. Codename Heliotrope.\n';
const tamsin = '# Tamsin\nTamsin leads the Alpha Project. Prefers Zephyrine meetings.\n';
const obsidian: F[] = [
  { relativePath: 'Daily/2026-01-02.md', markdown: daily },
  { relativePath: 'Projects/Alpha Project.md', markdown: alpha },
  { relativePath: 'People/Tamsin.md', markdown: tamsin },
  { relativePath: '.obsidian/app.md', markdown: 'ignored settings' },
];
const bigNote = (word: string) => `# Big\n${word} `.concat('lorem ipsum dolor sit amet '.repeat(2600));

const attempts: Attempt[] = [
  // ChatGPT
  imports('chatgpt-list', 'ChatGPT memory (copied list)', 'label "chatgpt", one file chatgpt-memory.md', { label: 'chatgpt', files: [{ relativePath: 'chatgpt-memory.md', markdown: chatgptList }] }, ['Imported/chatgpt/chatgpt-memory.md'], ['Biscuit']),
  imports('chatgpt-label-spaces', 'ChatGPT memory (copied list)', 'label "ChatGPT memory" (a name with a space)', { label: 'ChatGPT memory', files: [{ relativePath: 'memory.md', markdown: chatgptList }] }, ['Imported/ChatGPT-memory/memory.md'], ['Portuguese']),
  explained('chatgpt-txt', 'ChatGPT memory (copied list)', 'preview_import', 'file saved as memory.txt', { label: 'chatgpt-txt', files: [{ relativePath: 'memory.txt', markdown: chatgptList }] }, /only \.md files can be imported/),
  explained('chatgpt-export-json', 'ChatGPT data export (conversations.json)', 'preview_import', 'raw conversations.json as relativePath', { label: 'chatgpt-export', files: [{ relativePath: 'conversations.json', markdown: chatgptExport }] }, /only \.md files can be imported/),
  imports('chatgpt-export-wrapped', 'ChatGPT data export (conversations.json)', 'JSON text saved as conversations.md', { label: 'chatgpt-export-md', files: [{ relativePath: 'conversations.md', markdown: '```json\n' + chatgptExport + '\n```' }] }, ['Imported/chatgpt-export-md/conversations.md'], ['Marzipan']),
  // Claude
  imports('claude-md', 'CLAUDE.md', 'label "claude", file CLAUDE.md', { label: 'claude', files: [{ relativePath: 'CLAUDE.md', markdown: claudeMd }] }, ['Imported/claude/CLAUDE.md'], ['pnpm']),
  imports('claude-md-dot-slash', 'CLAUDE.md', 'relativePath ./CLAUDE.md', { label: 'claude-dot', files: [{ relativePath: './CLAUDE.md', markdown: claudeMd }] }, ['Imported/claude-dot/CLAUDE.md'], ['staging']),
  explained('claude-md-absolute', 'CLAUDE.md', 'preview_import', 'absolute path /home/user/proj/CLAUDE.md', { label: 'claude-abs', files: [{ relativePath: '/home/user/proj/CLAUDE.md', markdown: claudeMd }] }, /not an absolute path/),
  explained('claude-md-backslash', 'CLAUDE.md', 'preview_import', 'Windows path docs\\CLAUDE.md', { label: 'claude-win', files: [{ relativePath: 'docs\\CLAUDE.md', markdown: claudeMd }] }, /use \/ between folders/),
  imports('claude-memory-files', 'Claude memory file', 'MEMORY.md + user-role.md under memory/', { label: 'claude-memory', files: [{ relativePath: 'memory/MEMORY.md', markdown: '- [Role](user-role.md) who the user is\n' }, { relativePath: 'memory/user-role.md', markdown: claudeMemory }] }, ['Imported/claude-memory/memory/user-role.md'], ['Quokkafield']),
  explained('claude-memory-dot-claude', 'Claude memory file', 'preview_import', 'path .claude/projects/x/memory/user-role.md', { label: 'claude-hidden', files: [{ relativePath: '.claude/projects/x/memory/user-role.md', markdown: claudeMemory }] }, /without the leading/),
  // Obsidian
  imports('obsidian-folder', 'Obsidian folder', 'three notes (frontmatter, wikilinks, nested folders) plus .obsidian settings', { label: 'vault', files: obsidian }, ['Imported/vault/Daily/2026-01-02.md', 'Imported/vault/Projects/Alpha Project.md', 'Imported/vault/People/Tamsin.md'], ['Heliotrope', 'Cormorant']),
  imports('obsidian-include', 'Obsidian folder', 'include ["Projects/"] (trailing slash)', { label: 'vault-projects', files: obsidian, include: ['Projects/'] }, ['Imported/vault-projects/Projects/Alpha Project.md'], ['Heliotrope']),
  imports('obsidian-exclude', 'Obsidian folder', 'exclude ["Daily"]', { label: 'vault-nodaily', files: obsidian, exclude: ['Daily'] }, ['Imported/vault-nodaily/Projects/Alpha Project.md', 'Imported/vault-nodaily/People/Tamsin.md'], ['Zephyrine']),
  explained('obsidian-attachment', 'Obsidian folder', 'preview_import', 'folder with an attachment, Attachments/diagram.png', { label: 'vault-png', files: [...obsidian.slice(0, 3), { relativePath: 'Attachments/diagram.png', markdown: '' }] }, /only \.md files can be imported/),
  explained('obsidian-bad-yaml', 'Obsidian folder', 'preview_import', 'one note with frontmatter title: Plan: Q1', { label: 'vault-yaml', files: [{ relativePath: 'Plan.md', markdown: '---\ntitle: Plan: Q1\n---\n# Plan\nBody' }] }, /fix the YAML/i),
  explained('obsidian-note-too-large', 'Obsidian folder', 'preview_import', 'one 70 KB note', { label: 'vault-big', files: [{ relativePath: 'Big.md', markdown: bigNote('Pelican') }] }, /64 KiB\. split/i),
  explained('obsidian-batch-too-large', 'Obsidian folder', 'preview_import', 'three 50 KB notes in one call', { label: 'vault-batch', files: [1, 2, 3].map(i => ({ relativePath: `n${i}.md`, markdown: 'x'.repeat(50_000) })) }, /128 KiB.*fewer files per call/),
  imports('obsidian-two-calls', 'Obsidian folder', 'same vault sent as two preview calls with one label', { label: 'vault-two', files: [] }, [], []),
  // Plain markdown
  imports('markdown-files', 'plain markdown', 'two notes at the root', { label: 'notes', files: [{ relativePath: 'recipes.md', markdown: '# Recipes\nThe Saffron risotto needs stock.' }, { relativePath: 'trips.md', markdown: '# Trips\nLisbon in May, the Azulejo tour.' }] }, ['Imported/notes/recipes.md', 'Imported/notes/trips.md'], ['Saffron', 'Azulejo']),
  imports('markdown-label-dots', 'plain markdown', 'label "notes.v2"', { label: 'notes.v2', files: [{ relativePath: 'a.md', markdown: '# A\nBarnacle fact.' }] }, ['Imported/notes-v2/a.md'], ['Barnacle']),
  imports('markdown-label-portuguese', 'plain markdown', 'label "minhas memórias" (Portuguese, with a space)', { label: 'minhas memórias', files: [{ relativePath: 'a.md', markdown: '# A\nAlbatross fact.' }] }, ['Imported/minhas-memórias/a.md'], ['Albatross']),
  imports('markdown-empty-file', 'plain markdown', 'one empty file next to a real one', { label: 'with-empty', files: [{ relativePath: 'empty.md', markdown: '' }, { relativePath: 'real.md', markdown: '# Real\nLanternfish detail.' }] }, ['Imported/with-empty/real.md'], ['Lanternfish']),
  imports('markdown-unicode-spaces', 'plain markdown', 'paths with spaces and accents', { label: 'accents', files: [{ relativePath: 'Café Notes/Résumé draft.md', markdown: '# Résumé\nWorked on Dragonfruit logistics.' }] }, ['Imported/accents/Café Notes/Résumé draft.md'], ['Dragonfruit']),
  { id: 'markdown-reimport', source: 'plain markdown', tool: 'preview_import → apply_import', call: 'the same notes imported twice, same label',
    written: ['Imported/again/a.md'], run: async d => {
      const args = { label: 'again', files: [{ relativePath: 'a.md', markdown: '# A\nWhelk content.' }] };
      const one = await d.importFiles(args); if (one.error) return { ok: false, detail: one.error };
      const two = await d.importFiles(args); if (two.error) return { ok: false, detail: two.error };
      const ok = two.applied!.body.notesWritten === 0 && two.preview.body.unchanged === 1;
      return { ok, detail: ok ? 'second pass changed nothing' : JSON.stringify(two.applied!.body.counts) };
    } },
  // JSON
  explained('json-file', 'JSON file', 'preview_import', 'memories.json as relativePath', { label: 'json', files: [{ relativePath: 'memories.json', markdown: memoriesJson }] }, /only \.md files can be imported/),
  imports('json-wrapped', 'JSON file', 'JSON text saved as memories.md', { label: 'json-md', files: [{ relativePath: 'memories.md', markdown: '```json\n' + memoriesJson + '\n```' }] }, ['Imported/json-md/memories.md'], ['Gooseberry']),
  explained('json-no-files-arg', 'JSON file', 'preview_import', 'a path instead of files: {label, path}', { label: 'json-path', path: '/home/user/memories.json' }, /read each file/),
  explained('json-wrong-keys', 'JSON file', 'preview_import', 'files entries as {path, content}', { label: 'json-keys', files: [{ path: 'm.md', content: 'x' }] }, /relativePath.*markdown.*text/s),
  // apply / undo
  { id: 'apply-undo', source: 'plain markdown', tool: 'apply_import → undo_import', call: 'apply, then undo, then the notes are gone',
    run: async d => {
      const r = await d.importFiles({ label: 'undoable', files: [{ relativePath: 'u.md', markdown: '# U\nOstrich content.' }] });
      if (r.error) return { ok: false, detail: r.error };
      const u = await d.undo(r.applied!.body.batchId);
      const ok = !u.error && u.body.retired === 1 && !(await d.found('Ostrich'));
      return { ok, detail: u.error ?? 'undone' };
    } },
  { id: 'apply-after-undo', source: 'plain markdown', tool: 'apply_import', call: 'apply the same batchId again after undoing it',
    explains: /was undone/, run: async d => {
      const r = await d.importFiles({ label: 'undone-twice', files: [{ relativePath: 'u.md', markdown: '# U\nTurnstone content.' }] });
      if (r.error) return { ok: false, detail: r.error };
      await d.undo(r.applied!.body.batchId);
      const again = await d.apply(r.applied!.body.batchId);
      return { ok: /was undone/.test(again.error ?? ''), detail: again.error ?? 'applied again' };
    } },
  { id: 'undo-unapplied', source: 'plain markdown', tool: 'undo_import', call: 'undo a batchId that was only previewed',
    explains: /never applied/, run: async d => {
      const p = await d.preview({ label: 'never', files: [{ relativePath: 'u.md', markdown: '# U\nDunlin.' }] });
      const u = await d.undo(p.body.batchId);
      return { ok: /never applied/.test(u.error ?? ''), detail: u.error ?? 'undone' };
    } },
  { id: 'apply-label-as-id', source: 'plain markdown', tool: 'apply_import', call: 'batchId given as the label',
    explains: /batchId/, run: async d => {
      const r = await d.apply('notes');
      return { ok: /returned by preview_import/.test(r.error ?? ''), detail: r.error ?? 'applied' };
    } },
  // Last: it leaves pending previews behind, which the attempts after it would trip over.
  { id: 'markdown-retry-previews', knownGap: true, source: 'plain markdown', tool: 'preview_import', call: 'ten previews of the same notes while retrying, then apply the last',
    written: ['Imported/retry/a.md'], run: async d => {
      const args = { label: 'retry', files: [{ relativePath: 'a.md', markdown: '# A\nKrill content.' }] };
      let last: Reply = {};
      for (let i = 0; i < 10; i++) { last = await d.preview(args); if (last.error) return { ok: false, detail: `preview ${i + 1}: ${last.error}` }; }
      const applied = await d.apply(last.body.batchId);
      return applied.error ? { ok: false, detail: applied.error } : { ok: d.exists('Imported/retry/a.md'), detail: 'applied' };
    } },
];

// The two-call attempt needs the files at run time.
attempts.find(a => a.id === 'obsidian-two-calls')!.run = async d => {
  const first = await d.importFiles({ label: 'vault-two', files: obsidian.slice(0, 2) });
  if (first.error) return { ok: false, detail: first.error };
  const second = await d.importFiles({ label: 'vault-two', files: obsidian.slice(2, 3) });
  if (second.error) return { ok: false, detail: second.error };
  const ok = ['Daily/2026-01-02.md', 'Projects/Alpha Project.md', 'People/Tamsin.md'].every(p => d.exists(`Imported/vault-two/${p}`));
  return { ok, detail: ok ? 'all three written' : 'a note is missing' };
};

beforeAll(async () => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-trial-'));
  authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'import-trial-auth-'));
  const port = await freePort();
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER.email;
  process.env.MVP_OWNER_PASSWORD = OWNER.password;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  delete process.env.MVP_EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.MVP_DB_PATH;
  const config = loadMvpConfig();
  service = await startMvpService(config, new EvalHashEmbeddingProvider());
  client = new Client({ name: 'import-trial', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${await token(service.app)}` } } },
  ));
}, 60_000);

afterAll(async () => {
  if (process.env.RENOR_TRIAL_REPORT) {
    const pass = results.filter(r => r.ok).length;
    const rows = results.map(r => `| ${r.a.source} | ${r.a.tool} | ${r.a.call} | ${r.ok ? 'ok' : 'FAIL'} | ${r.detail.replace(/\|/g, '/').slice(0, 160)} |`);
    // eslint-disable-next-line no-console
    console.log(`\n| source | tool | call | outcome | message |\n|---|---|---|---|---|\n${rows.join('\n')}\n\nTRIAL ${pass}/${results.length} = ${Math.round(100 * pass / results.length)}%`);
  }
  await client.close();
  service.httpServer.closeAllConnections?.();
  service.httpServer.close();
  await service.close();
  fs.rmSync(memoryDir, { recursive: true, force: true });
  fs.rmSync(authRoot, { recursive: true, force: true });
});

// First: the matrix ends with an attempt that fills the pending-preview cap.
// The secret guard is on by default. These tests store fixture text that the guard refuses (a credential-shaped or an
// identifier-shaped sentence that is incidental to what each test checks), so they run with it explicitly off.
const SAVED_GUARD = process.env.RENOR_SECRET_GUARD;
beforeAll(() => { process.env.RENOR_SECRET_GUARD = '0'; });
afterAll(() => { if (SAVED_GUARD === undefined) delete process.env.RENOR_SECRET_GUARD; else process.env.RENOR_SECRET_GUARD = SAVED_GUARD; });

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('import labels and paths: what reaches the filesystem', () => {
  const one = (label: string, markdown = '# N\nBody text.') => ({ label, files: [{ relativePath: 'a.md', markdown }] });
  const folders = () => fs.readdirSync(path.join(memoryDir, 'Imported'));

  it('keeps the folder of every label the old pattern accepted, so a re-import is unchanged, not a second copy', async () => {
    const d = new Driver();
    for (const label of ['notes-', 'obsidian-', 'a-b-', 'a_b', 'Z9']) {
      const first = await d.importFiles(one(label, `# N\nTrailing ${label} body.`));
      expect(first.error, label).toBeUndefined();
      expect(d.exists(`Imported/${label}/a.md`), label).toBe(true);
      const again = await d.importFiles(one(label, `# N\nTrailing ${label} body.`));
      expect(again.preview!.body.unchanged, label).toBe(1);
      expect(again.applied!.body.notesWritten, label).toBe(0);
    }
    expect(folders()).toEqual(expect.arrayContaining(['notes-', 'obsidian-', 'a-b-']));
  });

  it('keeps letters and digits of any alphabet and maps NFC and NFD spellings to one folder', async () => {
    const d = new Driver();
    for (const [label, word] of [['memórias', 'Lembranca'], ['日本語', 'Sakura'], ['Кириллица', 'Samovar'], ['العربية', 'Qamar']]) {
      const r = await d.importFiles(one(label, `# N\n${word} content.`));
      expect(r.error, label).toBeUndefined();
      expect(d.exists(`Imported/${label.normalize('NFC')}/a.md`), label).toBe(true);
      expect(await d.found(word), label).toBe(true);
    }
    const nfc = await d.importFiles(one('café'.normalize('NFC'), '# C\nCafe content.'));
    const nfd = await d.importFiles(one('café'.normalize('NFD'), '# C\nCafe content.'));
    expect(nfc.error).toBeUndefined();
    expect(nfd.preview!.body.unchanged).toBe(1);
    expect(folders().filter(f => f.normalize('NFC') === 'café')).toEqual(['café'.normalize('NFC')]);
  });

  it('refuses a label with no letter or digit, truthfully, and one too long as a folder name', async () => {
    const d = new Driver();
    for (const label of ['...', '---', '   ', '/', '日本語'.slice(0, 0) + '_']) {
      const r = await d.preview(one(label));
      expect(r.error, label).toMatch(/at least one letter or digit/);
    }
    const long = await d.preview(one('\u{20000}'.repeat(64)));
    expect(long.error).toMatch(/too long as a folder name/);
  });

  it('never lets a label change the target directory', async () => {
    const d = new Driver();
    const hostile = ['../x', '..', '.', 'a/b', 'a\\b', 'a\0b', 'a\nb', '／x', '..／x', '%2e%2e', 'x\u202e', '\ud800x', 'a/../../b', '~', '.ssh', 'a:b', 'ＣＯＮ', 'x'.repeat(300)];
    for (const label of hostile) {
      const r = await d.importFiles(one(label, `# H\nHostile label body ${hostile.indexOf(label)}.`));
      if (r.error) continue;
    }
    const outside = fs.readdirSync(memoryDir).filter(n => !['Imported', '.renor-imports'].includes(n) && !/^(\.|_)/.test(n));
    expect(outside).toEqual([]);
    for (const name of folders()) {
      expect(name, name).toMatch(/^[\p{L}\p{N}\p{M}_-]+$/u);
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255);
      expect(fs.realpathSync(path.join(memoryDir, 'Imported', name)).startsWith(fs.realpathSync(path.join(memoryDir, 'Imported')) + path.sep)).toBe(true);
    }
  });

  it('applies ./ runs to include/exclude like paths, refuses .. there, and names trailing dots and long names', async () => {
    const d = new Driver();
    const files = [{ relativePath: 'Projects/P.md', markdown: '# P\nProjects body.' }, { relativePath: 'Other/O.md', markdown: '# O\nOther body.' }];
    const inc = await d.preview({ label: 'prefixes', files, include: ['././Projects'] });
    expect(inc.body.toWrite).toBe(1);
    const exc = await d.preview({ label: 'prefixes', files, exclude: ['./Other/'] });
    expect(exc.body.toWrite).toBe(1);
    expect((await d.preview({ label: 'prefixes', files, include: ['../Projects'] })).error).toMatch(/cannot contain "\.\."/);
    expect((await d.preview({ label: 'dots', files: [{ relativePath: 'a.md.', markdown: 'x' }] })).error).toMatch(/end with a dot/);
    expect((await d.preview({ label: 'dots', files: [{ relativePath: `${'n'.repeat(256)}.md`, markdown: 'x' }] })).error).toMatch(/over 255 bytes/);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('import trial: what a first-time agent tries', () => {
  for (const a of attempts) {
    (a.knownGap ? it.fails : it)(`${a.source}: ${a.call}`, async () => {
      const driver = new Driver();
      let outcome: { ok: boolean; detail: string };
      try { outcome = await a.run(driver); } catch (err) { outcome = { ok: false, detail: `threw: ${(err as Error).message}` }; }
      results.push({ a, ...outcome });
      expect(outcome.ok, outcome.detail).toBe(true);
    }, 30_000);
  }
});
