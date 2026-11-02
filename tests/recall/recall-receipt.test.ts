import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { runHook, type GetContextCaller } from '../../src/recall/autoRecall';
import { formatReceipt, receiptDate, receiptOn } from '../../src/recall/receipt';

/**
 * Memory receipts (src/recall/receipt.ts, wired into the recall hook's runHook): opt-in, a user-visible
 * `systemMessage` only when the hook injected something, and never a word of what a memory or a fact says.
 */
const ON = { RENOR_AUTO_RECALL: '1', RENOR_AUTO_RECALL_TOKEN: 'test-token', RENOR_RECALL_RECEIPT: '1' };
const PROMPT = 'which package manager should I use to add a dependency to ledger-api?';
const hookInput = (prompt: string) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: '/home/user/ledger' });
const reply = (body: Record<string, unknown>) => JSON.stringify({ ok: true, relevance: { relevant: true, similarity: 0.7 }, ...body });
const NOW = new Date();
const Y = NOW.getUTCFullYear();
const RELEVANT = reply({
  facts: [{ subject: 'ledger-api', predicate: 'node_version', object: 'Node 22' }],
  memories: [
    { text: 'Reply to Rowan in English.', session_date: `${Y}-10-18T09:00:00.000Z` },
    { text: 'Merges need Rowan\'s explicit yes.', session_date: `${Y}-10-19T09:00:00.000Z` },
  ],
});
const SENSITIVE = reply({
  facts: [{ subject: 'Rowan', predicate: 'bank_pin', object: '1234' }],
  memories: [{ text: 'My bank PIN is 1234', session_date: `${Y}-10-11` }, { text: 'Diagnosed with asthma in May.', session_date: `${Y}-10-12` }],
});
const parse = (out: string) => (out ? JSON.parse(out) : {}) as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };

describe('recall receipt: no line when nothing was injected', () => {
  const never: Array<[string, NodeJS.ProcessEnv, string, GetContextCaller]> = [
    ['empty result', ON, PROMPT, async () => reply({ memories: [] })],
    ['only unmatched filler', ON, PROMPT, async () => reply({ memories: [{ text: 'filler', matched: false }] })],
    ['unrelated (below the product threshold)', ON, PROMPT, async () => reply({ memories: [{ text: 'x' }], relevance: { relevant: false, similarity: 0.1 } })],
    ['below the configured minimum similarity', { ...ON, RENOR_AUTO_RECALL_MIN_SIMILARITY: '0.9' }, PROMPT, async () => RELEVANT],
    ['error', ON, PROMPT, async () => { throw new Error('ECONNREFUSED'); }],
    ['refused tool', ON, PROMPT, async () => JSON.stringify({ ok: false })],
    ['malformed reply', ON, PROMPT, async () => 'not json'],
    ['timeout', { ...ON, RENOR_AUTO_RECALL_TIMEOUT_MS: '100' }, PROMPT, () => new Promise<string>(() => {})],
    ['trivial prompt skipped', ON, 'ok go ahead', async () => RELEVANT],
    ['slash command skipped', ON, '/clear the context now', async () => RELEVANT],
    ['recall hook off', { ...ON, RENOR_AUTO_RECALL: '' }, PROMPT, async () => RELEVANT],
  ];
  it.each(never)('%s', async (_name, env, prompt, call) => {
    const out = await runHook(hookInput(prompt), env, call);
    expect(parse(out).systemMessage).toBeUndefined();
  });

  it('is off by default: an injection without RENOR_RECALL_RECEIPT shows nothing', async () => {
    const { RENOR_RECALL_RECEIPT: _, ...unset } = ON;
    for (const env of [unset, { ...ON, RENOR_RECALL_RECEIPT: '0' }, { ...ON, RENOR_RECALL_RECEIPT: 'maybe' }]) {
      const out = parse(await runHook(hookInput(PROMPT), env, async () => RELEVANT));
      expect(out.hookSpecificOutput?.additionalContext).toContain('Reply to Rowan in English.');
      expect(out.systemMessage).toBeUndefined();
    }
    expect(receiptOn({})).toBe(false);
    expect(formatReceipt([])).toBeNull();
  });
});

describe('recall receipt: the line', () => {
  it('counts what was injected, with dates, in systemMessage', async () => {
    const out = parse(await runHook(hookInput(PROMPT), ON, async () => RELEVANT));
    expect(out.systemMessage).toBe('Renor recalled 3: 2 notes (Oct 18, Oct 19), 1 fact');
    expect(out.hookSpecificOutput?.additionalContext).toContain('Merges need Rowan');
  });

  it('never shows text from a memory or a fact (the PIN repro)', async () => {
    const line = parse(await runHook(hookInput(PROMPT), ON, async () => SENSITIVE)).systemMessage!;
    expect(line).toBe('Renor recalled 3: 2 notes (Oct 11, Oct 12), 1 fact');
    for (const w of ['PIN', '1234', 'bank', 'asthma', 'Rowan', 'bank_pin']) expect(line).not.toContain(w);
  });

  it('is built only from counts and dates, whatever the stored text holds', async () => {
    const words = ['secret', 'Oct', '18', 'note', 'fact', 'recalled', '\u001b[31m', '<private>', 'more', ','];
    for (let n = 1; n <= 12; n++) {
      const memories = Array.from({ length: n }, (_, i) => ({ text: `${words[i % words.length]} ${words[(i * 7) % words.length]} ${i}`, session_date: `${Y}-0${(i % 9) + 1}-1${i % 10}` }));
      const line = parse(await runHook(hookInput(PROMPT), ON, async () => reply({ memories }))).systemMessage!;
      expect(line).toMatch(/^Renor recalled \d+: \d+ notes?( \((?:[A-Z][a-z]{2} \d{1,2}(?: \d{4})?)(?:, [A-Z][a-z]{2} \d{1,2}(?: \d{4})?){0,2}(?:, \+\d+ more)?\))?$/);
    }
  });

  it('counts only the lines that fit the budget', async () => {
    const memories = Array.from({ length: 50 }, (_, i) => ({ text: `note ${i} ${'x'.repeat(200)}`, session_date: `${Y}-10-01` }));
    const out = parse(await runHook(hookInput(PROMPT), { ...ON, RENOR_AUTO_RECALL_MAX_TOKENS: '128' }, async () => reply({ memories })));
    const injected = (out.hookSpecificOutput!.additionalContext!.match(/^- /gm) ?? []).length;
    expect(out.systemMessage).toBe(`Renor recalled ${injected}: ${injected} note${injected === 1 ? '' : 's'} (Oct 1)`);
  });

  it('shows at most three dates, then +N more; adds the year outside this year; omits a bad date', () => {
    const notes = ['10-01', '10-02', '10-03', '10-04', '10-05'].map(d => ({ kind: 'memory' as const, date: `${Y}-${d}` }));
    expect(formatReceipt(notes, NOW)).toBe('Renor recalled 5: 5 notes (Oct 1, Oct 2, Oct 3, +2 more)');
    expect(receiptDate(`${Y - 1}-12-30`, NOW)).toBe(`Dec 30 ${Y - 1}`);
    expect(formatReceipt([{ kind: 'memory', date: 'nope' }, { kind: 'fact' }, { kind: 'fact' }], NOW)).toBe('Renor recalled 3: 1 note, 2 facts');
  });
});

describe('recall receipt: the registered plugin hook', () => {
  /** A get_context server over MCP Streamable HTTP that answers `text`. */
  async function fakeRenor(text: string): Promise<{ url: string; close: () => void }> {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const msg = body ? JSON.parse(body) : {};
        if (req.method === 'DELETE' || msg.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } }
          : { content: [{ type: 'text', text }] };
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, close: () => server.close() };
  }

  /** Runs the UserPromptSubmit command hooks.json registers, with the plugin root laid out as its README ships it. */
  function runRegistered(env: NodeJS.ProcessEnv, stdin: string): Promise<{ code: number | null; stdout: string }> {
    const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '../../claude-code-plugin/hooks/hooks.json'), 'utf8')).hooks;
    const command: string = hooks.UserPromptSubmit[0].hooks[0].command;
    // README "Shipping it": dist/recall/ is copied into the plugin as hooks/renor-recall/.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-plugin-'));
    fs.mkdirSync(path.join(root, 'hooks'));
    fs.cpSync(path.join(__dirname, '../../dist/recall'), path.join(root, 'hooks/renor-recall'), { recursive: true });
    // The shared inert encoder ships one level up, and the compiled recall files name it by that path (scripts/plugin/pack-claude-code-plugin.mjs).
    fs.copyFileSync(path.join(__dirname, '../../claude-code-plugin/hooks/inert.cjs'), path.join(root, 'hooks/inert.cjs'));
    for (const name of fs.readdirSync(path.join(root, 'hooks/renor-recall'))) {
      const file = path.join(root, 'hooks/renor-recall', name);
      if (name.endsWith('.js')) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('../../claude-code-plugin/hooks/inert.cjs').join('../inert.cjs'));
    }
    return new Promise(resolve => {
      const child = spawn(command, { shell: true, env: { PATH: process.env.PATH, ...env, CLAUDE_PLUGIN_ROOT: root } });
      let stdout = '';
      child.stdout.on('data', c => { stdout += c; });
      child.on('close', code => { fs.rmSync(root, { recursive: true, force: true }); resolve({ code, stdout }); });
      child.stdin.end(stdin);
    });
  }

  it('emits the receipt as systemMessage when on, and none when the switch is unset', async () => {
    const renor = await fakeRenor(RELEVANT);
    try {
      const on = await runRegistered({ ...ON, RENOR_AUTO_RECALL_URL: renor.url }, hookInput(PROMPT));
      expect(on.code).toBe(0);
      expect(parse(on.stdout).systemMessage).toBe('Renor recalled 3: 2 notes (Oct 18, Oct 19), 1 fact');
      const { RENOR_RECALL_RECEIPT: _, ...unset } = ON;
      const off = await runRegistered({ ...unset, RENOR_AUTO_RECALL_URL: renor.url }, hookInput(PROMPT));
      expect(parse(off.stdout).hookSpecificOutput?.additionalContext).toContain('Reply to Rowan in English.');
      expect(parse(off.stdout).systemMessage).toBeUndefined();
    } finally {
      renor.close();
    }
  }, 30_000);
});
