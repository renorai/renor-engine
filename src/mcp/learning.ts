import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Config } from '../config';
import { learningSettings } from '../learning/settings';
import { learningObserver, type LearningObserver } from '../learning/tap';
import { clientPath } from '../mvp/engine';
import { embeddingModelKey } from '../mvp/contextRelevance';
import { RankingTrace, withRankingTrace } from '../retrieval/rankingTrace';
import { runSharingTool, type AskHuman, type SharingToolArgs } from '../sharing/agentTool';
import { sharingHook } from '../sharing/examples';
import { startSharingLoop, type SharingLoop } from '../sharing/loop';
import { AGENT_NOTICE_INSTRUCTION, showNotice } from '../sharing/notice';
import { sharingDefaultOpen, sharingStatusOpen, type Post } from '../sharing/send';
import { envOverride, sharingDirFor } from '../sharing/state';

/**
 * The learning log and sharing for the self-hosted stdio server (`renor-engine mcp`), wired from the same parts the HTTP service uses
 * (mvp/server.ts, mvp/cli.ts): the learning tap records each call, the first tool reply carries the first-run notice, and the sharing
 * loop sends what is final in the background. There is no second pipeline here, only the stdio side of the same one.
 *
 * - Recording follows the sharing level at each call, exactly as the service's: anonymous numbers (`signals`) are the default, a choice
 *   wins over it, and `off` records nothing (unless RENOR_LEARNING_LOG=1 asks for a local log).
 * - DO_NOT_TRACK=1 or RENOR_SHARING=off at start-up: nothing of this is made. No log, no notice, no sender, no request.
 * - Nothing is sent under the default until the notice was shown (send.ts asks noticeRecorded), and the notice goes on the first tool
 *   reply (agent surface). The terminal notice is not printed: stderr of a stdio server is read by its client, not by a person.
 * - A tool call never waits for the network: recording is one local write after the reply was built; the sender runs on its own timer,
 *   never keeps the process alive, and on a clean exit (stdin closed) gets one last try with a short deadline, then every request it
 *   still has open is dropped. Offline, a request fails and nothing is said: the rows stay in the log for the next run.
 *
 * The stdio tools have names of their own. The rows say the tool by the name the shared row schema knows (src/learning/schema.ts),
 * which is the hosted tool that does the same thing: `search` is recorded as `search_memory`, `remember_fact` as `save_memory`,
 * `note` as `remember_note`. The other stdio tools are not recorded, as the service records only its retrieval and write tools.
 */

export const RECORDED_AS: Readonly<Record<string, string>> = { search: 'search_memory', remember_fact: 'save_memory', note: 'remember_note' };

/** How long a clean exit waits for the last send before it drops what is still open. */
export const EXIT_FLUSH_MS = 3_000;

export interface StdioLearning {
  /** The sharing folder: the vault's own (<vault>/.memory-index/sharing), or RENOR_SHARING_DIR. The install's record still limits it. */
  readonly sharingDir: string;
  /** Runs one tool call, collecting the ranker's trace only when the call will be recorded, and records it. Never fails the call. */
  run(tool: string, args: unknown, handler: () => Promise<unknown>): Promise<unknown>;
  /** The reply with the first-run notice added, when it is due. A notice that cannot be worked out leaves the reply as it is. */
  withNotice<T extends { content: unknown[] }>(reply: T): T;
  /** The sharing_level tool (src/sharing/agentTool.ts), so "tell your agent" works on stdio too. */
  sharingTool(args: SharingToolArgs, ask?: AskHuman): Promise<Record<string, unknown>>;
  /** Starts the background sender. */
  startSender(): void;
  /** One last send with a deadline; then stops the sender and drops any request still open. */
  flush(deadlineMs?: number): Promise<void>;
}

export interface StdioLearningOptions {
  env?: NodeJS.ProcessEnv;
  /** The name the connected client declared, read at each call (the agent's key in the log is a keyed hash of it). */
  agent?: () => string;
  /** The sender's post, for tests (default: fetch). */
  fetch?: Post;
  /** The sender's first tick and interval, for tests. */
  firstTickMs?: number;
  intervalMs?: number;
  /** Label window and clock, for tests. */
  windowMs?: number;
  now?: () => number;
}

type Hit = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The reply as the tap reads it, in the hosted tool's shape: a search's hits (with paths relative to the vault, as the ranker's trace
 * and a note save key them), a fact save's receipt, a note save's file. Null for anything else.
 */
function hostedShape(tool: string, value: unknown, vaultPath: string): Record<string, unknown> | null {
  if (tool === 'search') {
    const hits = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.hits) ? value.hits : null;
    if (hits === null) return null;
    return {
      hits: hits.filter(isRecord).map((hit: Hit) => (typeof hit.notePath === 'string' && hit.notePath !== '' ? { ...hit, notePath: clientPath(vaultPath, hit.notePath) } : hit)),
    };
  }
  if (tool === 'remember_fact') return isRecord(value) ? value : null;
  if (tool === 'note') {
    return isRecord(value) && typeof value.path === 'string' ? { ok: true, file: clientPath(vaultPath, value.path) } : null;
  }
  return null;
}

/** The stdio side of learning and sharing, or null when DO_NOT_TRACK=1 or RENOR_SHARING=off turned it off for this process. */
export function stdioLearning(config: Pick<Config, 'vaultPath' | 'embeddingProvider' | 'embeddingModel' | 'embeddingDims'>, options: StdioLearningOptions = {}): StdioLearning | null {
  const env = options.env ?? process.env;
  if (envOverride(env) === 'off') return null;
  const vaultPath = config.vaultPath;
  const sharingDir = sharingDirFor(vaultPath, env);
  const settings = learningSettings(vaultPath, env);
  const session = randomUUID();
  const model = config.embeddingProvider === 'none' ? null : embeddingModelKey(config.embeddingProvider, config.embeddingModel, config.embeddingDims);
  const learner: LearningObserver | null = learningObserver(settings, {
    actor: 'agent',
    session,
    model: () => model,
    agent: () => options.agent?.() ?? 'unnamed',
    sharing: sharingHook(sharingDir, env),
  });

  // Every request the sender makes goes through this signal, so a clean exit can drop them at its deadline.
  const closing = new AbortController();
  const post: Post = options.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.any([init.signal, closing.signal]) }));
  let loop: SharingLoop | null = null;
  const sender = {
    dir: sharingDir, memoryDir: vaultPath, env, hosted: false, fetch: post,
    defaultOpen: () => sharingDefaultOpen(env, closing.signal),
    sharingOpen: () => sharingStatusOpen(env, closing.signal),
    ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };

  return {
    sharingDir,
    async run(tool, args, handler) {
      const recordedAs = RECORDED_AS[tool];
      if (learner === null || recordedAs === undefined) return handler();
      const started = Date.now();
      let trace: RankingTrace | undefined;
      try {
        trace = learner.recordsNext() ? new RankingTrace(vaultPath) : undefined;
      } catch {
        trace = undefined;
      }
      const value = await (trace ? withRankingTrace(trace, handler) : handler());
      try {
        const body = hostedShape(tool, value, vaultPath);
        if (body !== null) {
          learner.observe(recordedAs, args, { content: [{ type: 'text', text: JSON.stringify(body) }] }, true, Date.now() - started, undefined, trace);
        }
      } catch {
        // Recording must never fail the call it describes.
      }
      return value;
    },
    withNotice(reply) {
      let notice: string | null = null;
      try {
        showNotice(sharingDir, 'agent', line => { notice = line; }, env);
      } catch {
        return reply;
      }
      if (notice === null) return reply;
      return { ...reply, content: [...reply.content, { type: 'text', text: JSON.stringify({ renor_sharing_notice: notice, instruction: AGENT_NOTICE_INSTRUCTION }) }] };
    },
    sharingTool: (args, ask) => runSharingTool(args, { dir: sharingDir, env, hosted: false, ...(ask !== undefined ? { ask } : {}) }),
    startSender() {
      if (loop !== null) return;
      loop = startSharingLoop({
        ...sender,
        ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
        ...(options.firstTickMs !== undefined ? { firstTickMs: options.firstTickMs } : {}),
      });
    },
    async flush(deadlineMs = EXIT_FLUSH_MS) {
      if (loop === null) return;
      const running = loop;
      running.stop();
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>(resolve => {
        timer = setTimeout(resolve, deadlineMs);
        timer.unref();
      });
      try {
        await Promise.race([running.tick(), deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        closing.abort();
      }
    },
  };
}

/** Puts the sharing question to the user through their own client (elicitation), as the service's sharing_level tool does. */
export function askThrough(server: Server): AskHuman {
  return async ({ message }) => {
    if (server.getClientCapabilities()?.elicitation === undefined) return null;
    const reply = await server.elicitInput({
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          agree: { type: 'boolean', title: 'Yes, share', description: 'Yes, I want this' },
          adult: { type: 'boolean', title: 'I am 18 or older', description: 'I am 18 or older and I choose this myself' },
        },
        required: ['agree', 'adult'],
      },
    });
    if (reply.action !== 'accept') return { agreed: false, adult: false };
    const info = server.getClientVersion();
    const client = info !== undefined ? { name: String(info.name).slice(0, 80), version: String(info.version).slice(0, 40) } : undefined;
    return { agreed: reply.content?.agree === true, adult: reply.content?.adult === true, ...(client !== undefined ? { client } : {}) };
  };
}
