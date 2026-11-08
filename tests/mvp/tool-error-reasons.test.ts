import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp, SEARCH_REFUSAL_REASONS } from '../../src/mvp/server';
import { emitTelemetry } from '../../src/mvp/telemetry';
import { TOOL_ERROR_REASONS, isToolErrorReason, refusal, refusalReason } from '../../src/toolRefusal';
import { folderLabel } from '../../src/importing/hosted';
import { normalizeScope } from '../../src/mvp/scope';
import { LifecycleInputError } from '../../src/memory/lifecycle';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

/**
 * Why a refused MCP tool call failed, as a code next to `error_kind` on the `tool_use` event.
 *
 * One user lost 13 of 152 calls in a day (5 of 9 import previews, 3 of 16 remembers, the rest elsewhere), each
 * refused in 1-2 ms, and every one of them reached telemetry as the same `error_kind: "other"`: no way to tell an
 * import that was too large from a path that escapes the vault from an unknown memory id. So each refusal path now
 * names its reason, from the closed set in src/toolRefusal.ts, at the place the refusal is decided.
 *
 * Driven through the real MCP tools of a real keyword-only workspace (createMvpApp + the SDK's own client), so
 * every assertion is about the handler a production call reaches. The emitted events are read from the in-process
 * stdout sink (console.log): no sink is configured, so nothing leaves this process, and the leak test asserts it.
 * Synthetic data, no embeddings, no network.
 */

const HOOK_TIMEOUT_MS = 120_000;

const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
  'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL',
  'MVP_INSTANCE_ID', 'RENOR_POSTHOG_KEY', 'RENOR_POSTHOG_HOST', 'RENOR_POSTHOG_CAPTURE_URL', 'RENOR_SENTRY_DSN',
  'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST', 'RENOR_TELEMETRY_HASH_SALT', 'RENOR_TELEMETRY_DISABLED',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

/** Every line the telemetry local sink wrote since the last clear. */
let emitted: string[] = [];

function toolUseEvents(): Array<Record<string, unknown>> {
  return emitted
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter((event): event is Record<string, unknown> => event !== null && event.event === 'tool_use');
}

async function startWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-error-reasons-'));
  const memoryDir = path.join(root, 'memory');
  const authRoot = path.join(root, 'auth');
  // A configured history directory with no promotion manifest: fact memory works, history is unavailable.
  const historyDir = path.join(root, 'history');
  for (const dir of [memoryDir, authRoot, historyDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authRoot, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3477',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    MVP_EMBEDDING_PROVIDER: 'none',
    MVP_HISTORY_DIR: historyDir,
  });
  const app = createMvpApp(loadMvpConfig());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tool-error-reasons', version: '0.1.0' });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    /** One tool call, with the events it emitted. */
    async call(name: string, args: Record<string, unknown> = {}) {
      const before = emitted.length;
      const result = await client.callTool({ name, arguments: args });
      return {
        isError: result.isError === true,
        text: String((result.content as Array<{ text?: string }>)[0]?.text ?? ''),
        events: toolUseEvents().slice(-(emitted.length - before) || undefined) as Array<Record<string, unknown>>,
      };
    },
    async close() {
      await client.close();
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Workspace = Awaited<ReturnType<typeof startWorkspace>>;
let ws: Workspace;

/**
 * Call a tool that must refuse, and assert it refused: one `tool_use` event, still `error_kind: "other"` (a field
 * dashboards read, unchanged), carrying `code` as its reason.
 */
async function refusedWith(tool: string, args: Record<string, unknown>, code: string): Promise<void> {
  const result = await ws.call(tool, args);
  expect(result.isError, `${tool} ${JSON.stringify(args)} did not refuse: ${result.text}`).toBe(true);
  expect(result.events).toHaveLength(1);
  expect(result.events[0].tool).toBe(tool);
  expect(result.events[0].ok).toBe(false);
  expect(result.events[0].error_kind).toBe('other');
  expect(result.events[0].error_reason).toBe(code);
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { emitted.push(args.map(String).join(' ')); });
  ws = await startWorkspace();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await ws?.close();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterEach(() => { emitted = []; });

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('every refusal path logs its reason code', () => {
  it('remember with part of a fact triple: invalid_argument', async () => {
    await refusedWith('remember', { statement: 'Atlas ships on Friday', subject: 'Atlas', predicate: 'ships_on' }, 'invalid_argument');
  });

  it('remember of text that cannot be stored as text: invalid_text', async () => {
    await refusedWith('remember', { statement: 'a note with an unpaired surrogate \uD800 in it' }, 'invalid_text');
  });

  it('save_memory with a field longer than the ledger bound: field_too_long', async () => {
    await refusedWith('save_memory', { subject: 'a'.repeat(600), predicate: 'works_at', object: 'Acme' }, 'field_too_long');
  });

  it('save_memory with a control character in a field: invalid_text', async () => {
    await refusedWith('save_memory', { subject: 'a\nb', predicate: 'works_at', object: 'Acme' }, 'invalid_text');
  });

  it('save_memory with a scope that is not a scope: invalid_scope', async () => {
    await refusedWith('save_memory', { subject: 'user', predicate: 'works_at', object: 'Acme', scope: '!!!' }, 'invalid_scope');
  });

  it('retrieve_memory without its subject: missing_argument', async () => {
    await refusedWith('retrieve_memory', {}, 'missing_argument');
  });

  it('retrieve_memory with an invalid scope: invalid_scope', async () => {
    await refusedWith('retrieve_memory', { subject: 'user', scope: '!!!' }, 'invalid_scope');
  });

  it('memory_map with a scope but no query: invalid_argument', async () => {
    await refusedWith('memory_map', { scope: 'project:atlas' }, 'invalid_argument');
  });

  it('memory_map with a query that names no word to look for: invalid_argument', async () => {
    await refusedWith('memory_map', { query: '!!!' }, 'invalid_argument');
  });

  it('read_memory with an id that is not a memory id: invalid_argument', async () => {
    await refusedWith('read_memory', { id: 'chapter-one-of-the-atlas-plan' }, 'invalid_argument');
  });

  it('read_memory with an id naming a file that holds no memory: memory_not_found', async () => {
    await refusedWith('read_memory', { id: 'note:Nope.md' }, 'memory_not_found');
  });

  it('retire_memory with an id that names no retired memory: memory_not_found', async () => {
    await refusedWith('retire_memory', { id: 'entry:Memory/Daily/2026-01-01.md#0123456789abcdef' }, 'memory_not_found');
  });

  it('restore_memory with an id that was never retired: memory_not_found', async () => {
    await refusedWith('restore_memory', { id: 'note:Nope.md' }, 'memory_not_found');
  });

  it('retire_memory and restore_memory with a fact id that names no fact: memory_not_found', async () => {
    await refusedWith('retire_memory', { id: 'fact:MEM_NOSUCHEVENT' }, 'memory_not_found');
    await refusedWith('restore_memory', { id: 'fact:MEM_NOSUCHEVENT' }, 'memory_not_found');
  });

  it('search_memory on a workspace with no semantic search: capability_unavailable', async () => {
    await refusedWith('search_memory', { query: 'anything at all' }, 'capability_unavailable');
  });

  it('search_history on a history directory with no manifest: capability_unavailable', async () => {
    await refusedWith('search_history', { query: 'anything at all' }, 'capability_unavailable');
  });

  it('preview_import of a file that is not Markdown: unsupported_import_format', async () => {
    await refusedWith('preview_import', { label: 'vault', files: [{ relativePath: 'notes.txt', markdown: '# hi' }] }, 'unsupported_import_format');
  });

  it('preview_import of a path that leaves the memory directory: unsafe_path', async () => {
    await refusedWith('preview_import', { label: 'vault', files: [{ relativePath: '../../etc/passwd.md', markdown: '# hi' }] }, 'unsafe_path');
  });

  it('preview_import of a batch over the byte bound: import_too_large', async () => {
    // Multi-byte text, so the bound that refuses here is the batch BYTE bound rather than the schema's
    // character bound (which the SDK enforces before any handler runs).
    const big = '\u{1F600}'.repeat(30_000);
    await refusedWith('preview_import', {
      label: 'vault',
      files: [
        { relativePath: 'one.md', markdown: big },
        { relativePath: 'two.md', markdown: big },
        { relativePath: 'three.md', markdown: big },
      ],
    }, 'import_too_large');
  });

  it('preview_import naming one path twice: duplicate_import_path', async () => {
    await refusedWith('preview_import', {
      label: 'vault',
      files: [
        { relativePath: 'same.md', markdown: '# one' },
        { relativePath: 'same.md', markdown: '# one' },
      ],
    }, 'duplicate_import_path');
  });

  it('preview_import of text holding a NUL byte: invalid_text', async () => {
    await refusedWith('preview_import', { label: 'vault', files: [{ relativePath: 'a.md', markdown: 'a\u0000b' }] }, 'invalid_text');
  });

  it('apply_import of a batch nobody previewed: batch_not_found', async () => {
    await refusedWith('apply_import', { batchId: crypto.randomUUID() }, 'batch_not_found');
  });

  it('undo_import of a batch this workspace never applied: batch_not_found', async () => {
    await refusedWith('undo_import', { batchId: crypto.randomUUID() }, 'batch_not_found');
  });

  it('apply_import of a batch that was already applied and undone: batch_already_applied', async () => {
    const preview = await ws.call('preview_import', { label: 'applied', files: [{ relativePath: 'note.md', markdown: '# note\n\ntext' }] });
    expect(preview.isError, preview.text).toBe(false);
    const batchId = JSON.parse(preview.text).batchId as string;
    expect((await ws.call('apply_import', { batchId })).isError).toBe(false);
    expect((await ws.call('undo_import', { batchId })).isError).toBe(false);
    await refusedWith('apply_import', { batchId }, 'batch_already_applied');
  }, HOOK_TIMEOUT_MS);

  // Refusal sites main added after this feature was written. Each names its code like the ones above; the
  // messages (and the label/relativePath checks themselves) are main's, unchanged.
  it('save_memory missing a structured field: missing_argument', async () => {
    await refusedWith('save_memory', { subject: 'user' }, 'missing_argument');
  });

  it('preview_import with an absolute path: unsafe_path', async () => {
    await refusedWith('preview_import', { label: 'vault', files: [{ relativePath: '/etc/passwd.md', markdown: '# hi' }] }, 'unsafe_path');
  });

  it('preview_import with a backslash in the path: unsafe_path', async () => {
    await refusedWith('preview_import', { label: 'vault', files: [{ relativePath: 'notes\\a.md', markdown: '# hi' }] }, 'unsafe_path');
  });

  it('preview_import with a path component over 255 bytes: unsafe_path', async () => {
    await refusedWith('preview_import', { label: 'vault', files: [{ relativePath: `${'a'.repeat(300)}.md`, markdown: '# hi' }] }, 'unsafe_path');
  });

  it('preview_import with an uppercase extension: unsupported_import_format', async () => {
    await refusedWith('preview_import', { label: 'vault', files: [{ relativePath: 'notes/a.MD', markdown: '# hi' }] }, 'unsupported_import_format');
  });

  it('preview_import with a path ending in a dot: unsupported_import_format', async () => {
    await refusedWith('preview_import', { label: 'vault', files: [{ relativePath: 'notes/a.md.', markdown: '# hi' }] }, 'unsupported_import_format');
  });

  it('preview_import with a label that normalizes to nothing: invalid_argument', async () => {
    await refusedWith('preview_import', { label: '!!!', files: [{ relativePath: 'a.md', markdown: '# hi' }] }, 'invalid_argument');
  });

  it('preview_import with a label too long as a folder name: field_too_long', async () => {
    // 4-byte letters survive the folder-name filter; 64 of them are 256 bytes, over the 200-byte bound.
    await refusedWith('preview_import', { label: '\u{10000}'.repeat(100), files: [{ relativePath: 'a.md', markdown: '# hi' }] }, 'field_too_long');
  });

  it('a refusal site that names no better code falls back to refused', async () => {
    // include/exclude prefixes with ".." is checked by its own plain error, so it carries the generic code
    // rather than a specific one: the fallback in toolError still gives every refusal a closed-set code.
    await refusedWith('preview_import', {
      label: 'vault',
      files: [{ relativePath: 'a.md', markdown: '# hi' }],
      include: ['../x'],
    }, 'refused');
  });

  it('preview_import past the pending-preview cap: too_many_previews', async () => {
    // The cap is per workspace and every preview it refuses is still pending, so this runs last in the suite
    // and previews until one refuses rather than counting on an empty cap.
    let refusals = 0;
    for (let i = 0; i < 16; i++) {
      const result = await ws.call('preview_import', { label: `vault${i}`, files: [{ relativePath: `note-${i}.md`, markdown: `# note ${i}\n\ntext` }] });
      if (!result.isError) continue;
      refusals++;
      expect(result.events[0].error_reason).toBe('too_many_previews');
    }
    expect(refusals).toBeGreaterThan(0);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the codes are a closed set, and they carry nothing of the user\'s', () => {
  it('every code a refusal may log is a literal of the closed set', () => {
    // The mapping the search lane answers with, including the three states a keyword-only test cannot force.
    expect(SEARCH_REFUSAL_REASONS).toEqual({
      'semantic-unavailable': 'capability_unavailable',
      'semantic-rebuilding': 'capability_rebuilding',
      'fts-unavailable': 'capability_unavailable',
      'fts-query': 'invalid_query',
    });
    for (const [lane, code] of Object.entries(SEARCH_REFUSAL_REASONS)) {
      expect(isToolErrorReason(code), `${lane} -> ${code}`).toBe(true);
    }
    // A code that is not in the set is dropped rather than logged, so no message, statement or path can be
    // smuggled in as a reason.
    emitted = [];
    emitTelemetry({ event: 'tool_use', tool: 'remember', ok: false, ms: 1, error_kind: 'other', error_reason: 'statement: my own words' as never });
    expect(toolUseEvents()).toHaveLength(1);
    expect(toolUseEvents()[0]).not.toHaveProperty('error_reason');
    expect(toolUseEvents()[0].error_kind).toBe('other');
  });

  it('a reason that is not in the closed set is dropped; a real one is kept', () => {
    emitted = [];
    emitTelemetry({ event: 'tool_use', tool: 'remember', ok: false, ms: 1, error_kind: 'other' });
    emitTelemetry({ event: 'tool_use', tool: 'remember', ok: false, ms: 1, error_kind: 'other', error_reason: 'field_too_long' });
    const events = toolUseEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).not.toHaveProperty('error_reason');
    expect(events[1].error_reason).toBe('field_too_long');
  });

  it('distinctive user content never reaches an emitted event, and nothing is sent off-process', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const tokens = {
      statement: 'quokka-statement-4471-should-never-be-logged',
      scope: 'quokka-scope-9931-should-never-be-logged',
      importPath: 'quokka/secret-note-2211.md',
      importContent: 'quokka-file-content-7788-should-never-be-logged',
      memoryId: 'note:quokka-missing-5561.md',
      subject: 'quokka-subject-3321-should-never-be-logged',
    };
    emitted = [];
    await ws.call('remember', { statement: tokens.statement, scope: '!!! quokka-scope-9931' });
    await ws.call('save_memory', { subject: `${tokens.subject}\u0001`, predicate: 'p', object: tokens.statement });
    await ws.call('memory_map', { query: tokens.importPath });
    await ws.call('read_memory', { id: tokens.memoryId });
    await ws.call('preview_import', { label: 'vault', files: [{ relativePath: tokens.importPath, markdown: tokens.importContent }] });
    await ws.call('preview_import', { label: 'vault', files: [{ relativePath: '../../quokka.md', markdown: tokens.importContent }] });

    // Four of the six calls refuse (the other two answer, and are checked for carrying the tokens too):
    // invalid scope, a control character, a memory id naming nothing, and a path that leaves the directory.
    const refusals = toolUseEvents().filter(event => event.ok === false);
    expect(refusals).toHaveLength(4);
    expect(refusals.every(event => isToolErrorReason(event.error_reason))).toBe(true);
    for (const value of Object.values(tokens)) {
      expect(emitted.join('\n'), `${value} appears in telemetry`).not.toContain(value);
    }
    // Every refusal that named no code of its own is the generic one, never its message.
    expect(refusals.map(event => event.error_reason)).not.toContain('quokka-scope-9931-should-never-be-logged');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  }, HOOK_TIMEOUT_MS);
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('the closed set itself', () => {
  it('is short, snake_case and unique, and holds the codes every refusal path uses', () => {
    expect(new Set(TOOL_ERROR_REASONS).size).toBe(TOOL_ERROR_REASONS.length);
    for (const code of TOOL_ERROR_REASONS) expect(code).toMatch(/^[a-z][a-z0-9_]{2,31}$/);
    // Every code a refusal site can name is one of these, and no code may be built from anything at runtime.
    expect(TOOL_ERROR_REASONS).toContain('refused');
    expect(TOOL_ERROR_REASONS).toContain('internal');
    expect(isToolErrorReason('quokka-scope-9931')).toBe(false);
    expect(isToolErrorReason(undefined)).toBe(false);
  });
});

describe.skipIf(HTTP_SERVER_UNSUPPORTED)('a refusal is the same plain Error it always was, with the code out of band', () => {
  function caught(fn: () => unknown): Error {
    try { fn(); } catch (err) { return err as Error; }
    throw new Error('the call did not refuse');
  }

  // Every plain refusal site throws through `refusal()`, and every lifecycle one through LifecycleInputError.
  // One test of each mechanism covers every site: no site builds its own error class or adds a property.
  it('refusal() throws a plain Error: class, name, message and keys are unchanged', () => {
    const err = caught(() => { throw refusal('invalid_scope', 'invalid scope "!!!": use "global" or "scope:<slug>"'); });
    expect(err.constructor).toBe(Error);
    expect(err.constructor.name).toBe('Error');
    expect(err.name).toBe('Error');
    expect(Object.keys(err)).toEqual([]);
    expect(String(err)).toBe('Error: invalid scope "!!!": use "global" or "scope:<slug>"');
    // The code is out of band: no property, but telemetry still reads it.
    expect(refusalReason(err)).toBe('invalid_scope');
  });

  it('a converted site (folderLabel, the review repro) still throws a plain Error', () => {
    const err = caught(() => folderLabel('!!!'));
    expect(err.constructor.name).toBe('Error');
    expect(err.name).toBe('Error');
    expect(Object.keys(err)).toEqual([]);
    expect(err.message).toBe('label needs at least one letter or digit, e.g. "chatgpt-memory" (it becomes a folder name).');
    expect(refusalReason(err)).toBe('invalid_argument');
  });

  it('a converted site (normalizeScope) still throws a plain Error', () => {
    const err = caught(() => normalizeScope('!!!'));
    expect(err.constructor.name).toBe('Error');
    expect(err.name).toBe('Error');
    expect(Object.keys(err)).toEqual([]);
    expect(err.message).toBe('invalid scope "!!!": use "global" or "scope:<slug>" / "project:<slug>" with slug matching [a-z0-9-]{1,64}');
    expect(refusalReason(err)).toBe('invalid_scope');
  });

  it('LifecycleInputError keeps its class, name and keys, with the code out of band', () => {
    const err = new LifecycleInputError('subject', 'lifecycle subject must be a non-empty string', 'invalid_argument');
    // main's class carried only `name` and `field`; the code adds no `reason` key.
    expect(err.constructor.name).toBe('LifecycleInputError');
    expect(err.name).toBe('LifecycleInputError');
    expect(err.field).toBe('subject');
    // main's own keys, in main's order (the declared `field`, then the assigned `name`); no `reason`.
    expect(Object.keys(err)).toEqual(['field', 'name']);
    expect(String(err)).toBe('LifecycleInputError: lifecycle subject must be a non-empty string');
    expect(refusalReason(err)).toBe('invalid_argument');
  });

  it('an error with no code carries none, and a refusal never grows a reason key', () => {
    expect(refusalReason(new Error('plain'))).toBeUndefined();
    expect(refusalReason('invalid_scope')).toBeUndefined();
    const err = caught(() => { throw refusal('memory_not_found', 'memory not found'); });
    expect(Object.keys(err)).not.toContain('reason');
    expect(refusalReason(err)).toBe('memory_not_found');
  });
});