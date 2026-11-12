/**
 * Renor on the ai-memory LongMemEval-S retrieval set (keyword lane only, no model call anywhere).
 *
 * Hit rule and question selection follow akitaonrails/ai-memory (MIT, https://github.com/akitaonrails/ai-memory,
 * evals/README.md and evals/src/retrieval/dataset.rs): the 470 questions are the 500 minus ids ending `_abs`; the unit
 * is the session; hit@k = any answer session is in the top k DISTINCT sessions; recall@k = the share of answer
 * sessions in the top k distinct sessions. Nothing else of their code is used.
 *
 * Each question gets its own vault (the haystack sessions as markdown, written deterministically) and an index with no
 * embeddings. The ranking is the keyword lane get_context uses (engineSearchText): with the keyword defaults on, one
 * OR expression over the question's content words on the stemmed index; with RENOR_KEYWORD_DEFAULTS=0, the legacy
 * phrase variants on the unstemmed index. Hosted hybrid (cache-only Vertex vectors) is deliberately not run here.
 *
 *   npx tsx scripts/eval/ai-memory-comparison.ts --dataset longmemeval_s_cleaned.json --output out.json
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Command } from 'commander';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { engineSearchText } from '../../src/mvp/engine';
import { keywordOrAll, keywordOrMatch } from '../../src/retrieval/keyword';
import { keywordVariants } from '../../src/mvp/agentMemory';
import { type LongMemInstance, validateLongMemRows } from '../../src/eval/longmemeval';
import { gitState } from '../../src/eval/runManifest';

export const DATASET_SHA256 = 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442';

/** Their selection: every question except the abstention ones (ids ending `_abs`). */
export function selectQuestions<T extends { question_id: string }>(rows: T[]): T[] {
  return rows.filter(row => !row.question_id.endsWith('_abs'));
}

/** hit@k and recall@k over the top k distinct sessions of a ranking (a repeated session counts once). */
export function scoreRanking(ranked: string[], answers: string[], ks: number[]): { hit: Record<number, number>; recall: Record<number, number> } {
  const distinct = [...new Set(ranked)];
  const hit: Record<number, number> = {};
  const recall: Record<number, number> = {};
  for (const k of ks) {
    const top = new Set(distinct.slice(0, k));
    const found = answers.filter(id => top.has(id)).length;
    hit[k] = found > 0 ? 1 : 0;
    recall[k] = answers.length === 0 ? 0 : found / answers.length;
  }
  return { hit, recall };
}

const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function renderSession(id: string, date: string, turns: LongMemInstance['haystack_sessions'][number]): string {
  const body = turns.map((turn, index) => `### Turn ${index + 1} — ${turn.role === 'assistant' ? 'Assistant' : 'User'}\n\n${turn.content}`).join('\n\n');
  return `---\nkind: longmemeval-session\nsession_id: ${JSON.stringify(id)}\nsession_date: ${JSON.stringify(date)}\n---\n# Session ${id}\n\nTimestamp: ${date}\n\n${body}\n`;
}

/** Writes the haystack as one note per session occurrence; returns note path -> session id. */
async function writeVault(root: string, row: LongMemInstance): Promise<Map<string, string>> {
  const owner = new Map<string, string>();
  await fsp.mkdir(path.join(root, 'Sessions'), { recursive: true });
  const seen = new Map<string, number>();
  for (let i = 0; i < row.haystack_sessions.length; i++) {
    const id = row.haystack_session_ids[i];
    const nth = (seen.get(id) ?? 0) + 1;
    seen.set(id, nth);
    const relative = `Sessions/${sha(id).slice(0, 16)}${nth === 1 ? '' : `-occ${nth}`}.md`;
    await fsp.writeFile(path.join(root, relative), renderSession(id, row.haystack_dates[i], row.haystack_sessions[i]), 'utf8');
    owner.set(relative, id);
  }
  return owner;
}

export interface ArmResult {
  arm: string;
  questions: number;
  hit5: number;
  hit10: number;
  recall10: number;
  wallSeconds: number;
  perQuestion: Array<{ id: string; type: string; hit5: number; hit10: number; recall10: number }>;
}

type Arm = { name: string; env: Record<string, string | undefined> };
export const ARMS: Arm[] = [
  { name: 'shipped-default (keyword OR + stem on)', env: { RENOR_KEYWORD_DEFAULTS: undefined, RENOR_KEYWORD_OR_ALL: undefined, RENOR_KEYWORD_STEM: undefined } },
  { name: 'legacy (RENOR_KEYWORD_DEFAULTS=0)', env: { RENOR_KEYWORD_DEFAULTS: '0', RENOR_KEYWORD_OR_ALL: undefined, RENOR_KEYWORD_STEM: undefined } },
];

async function runArm(arm: Arm, rows: LongMemInstance[], chunks: number): Promise<ArmResult> {
  for (const [key, value] of Object.entries(arm.env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const started = performance.now();
  const perQuestion: ArmResult['perQuestion'] = [];
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-memory-cmp-'));
  for (const row of rows) {
    const dir = path.join(base, sha(row.question_id).slice(0, 12));
    const vault = path.join(dir, 'vault');
    await fsp.mkdir(vault, { recursive: true });
    const db = openDb(path.join(dir, 'index.db'));
    try {
      const owner = await writeVault(vault, row);
      runMigrations(db);
      const stats = await indexVault(db, vault, { chunkOptions: { maxTokens: 400, overlapTokens: 50 } }, 2);
      if (stats.errors > 0) throw new Error(`${row.question_id}: ${stats.errors} indexing error(s)`);
      const orAll = keywordOrAll();
      const ranked: string[] = [];
      for (const variant of orAll ? [row.question.trim()] : keywordVariants(row.question)) {
        const found = assertSearchOk(engineSearchText(db, vault, variant, chunks, undefined, false, undefined, undefined, orAll ? keywordOrMatch(row.question) : undefined) as { ok: boolean; error?: unknown; results: Array<{ notePath: string }> }, arm.name, row.question_id);
        for (const hit of found.results) {
          const id = owner.get(hit.notePath.replace(/\\/g, '/').replace(/^.*?(Sessions\/)/, '$1'));
          if (id) ranked.push(id);
        }
      }
      const s = scoreRanking(ranked, row.answer_session_ids, [5, 10]);
      perQuestion.push({ id: row.question_id, type: row.question_type, hit5: s.hit[5], hit10: s.hit[10], recall10: s.recall[10] });
    } finally {
      db.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
  await fsp.rm(base, { recursive: true, force: true });
  const mean = (pick: (q: ArmResult['perQuestion'][number]) => number) => perQuestion.reduce((sum, q) => sum + pick(q), 0) / Math.max(1, perQuestion.length);
  return { arm: arm.name, questions: perQuestion.length, hit5: mean(q => q.hit5), hit10: mean(q => q.hit10), recall10: mean(q => q.recall10), wallSeconds: (performance.now() - started) / 1000, perQuestion };
}

export function renderTable(commit: string, results: ArmResult[]): string {
  const lines = [`Commit ${commit}. ${results[0]?.questions ?? 0} questions.`, '', '| arm | hit@5 | hit@10 | recall@10 | wall time (s) |', '| --- | --- | --- | --- | --- |'];
  for (const r of results) lines.push(`| ${r.arm} | ${r.hit5.toFixed(3)} | ${r.hit10.toFixed(3)} | ${r.recall10.toFixed(3)} | ${r.wallSeconds.toFixed(0)} |`);
  return lines.join('\n');
}

/** A failed search is not a miss: abort with the arm and question, so no benchmark score is built on search errors. */
export function assertSearchOk<T extends { ok: boolean; error?: unknown }>(found: T, arm: string, questionId: string): T {
  if (!found.ok) throw new Error(`${arm} / ${questionId}: keyword search failed (${typeof found.error === 'string' ? found.error : JSON.stringify(found.error ?? 'no error detail')}); refusing to score it as a miss`);
  return found;
}

/** The markdown twin of a JSON result path; it holds the hand-written write-up, so a rerun must never overwrite it. */
export function markdownTwin(output: string): string {
  return output.replace(/\.json$/, '') + '.table.md';
}

export function assertNoWriteUpOverwrite(output: string): void {
  const twin = markdownTwin(output);
  if (fs.existsSync(twin)) throw new Error(`${twin} already exists and may hold the hand-written write-up; choose another --output path`);
}

async function main(): Promise<void> {
  const program = new Command()
    .requiredOption('--dataset <path>', 'longmemeval_s_cleaned.json (sha256 is checked)')
    .requiredOption('--output <path>', 'JSON result path; a markdown table is written beside it as <name>.table.md')
    .option('--limit <n>', 'first n questions only (smoke runs; 0 = all)', '0')
    .option('--chunks <n>', 'chunks requested per keyword query', '50')
    .parse(process.argv);
  const opts = program.opts<{ dataset: string; output: string; limit: string; chunks: string }>();
  assertNoWriteUpOverwrite(opts.output);
  const bytes = await fsp.readFile(opts.dataset);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== DATASET_SHA256) throw new Error(`dataset sha256 ${digest} is not the pinned ${DATASET_SHA256}`);
  const all = JSON.parse(bytes.toString('utf8')) as LongMemInstance[];
  validateLongMemRows(all);
  let rows = selectQuestions(all);
  if (Number(opts.limit) > 0) rows = rows.slice(0, Number(opts.limit));
  const results: ArmResult[] = [];
  for (const arm of ARMS) results.push(await runArm(arm, rows, Number(opts.chunks)));
  const commit = gitState(process.cwd()).sha;
  fs.writeFileSync(opts.output, JSON.stringify({ commit, datasetSha256: digest, chunks: Number(opts.chunks), results }, null, 2));
  const table = renderTable(commit, results);
  fs.writeFileSync(markdownTwin(opts.output), table + '\n');
  console.log(table);
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });
