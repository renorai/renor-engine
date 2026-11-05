#!/usr/bin/env node
// Non-gating report arm: runs the RenorBench product arm at the SHIPPED default (no --top-k, so top_k 50 and the
// scaled expansion budget apply) on the free hash embedder, writes its own record, and prints one line per suite
// next to the committed pinned top_k 20 baseline. It is not a gate step and moves no baseline or release evidence.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUITES = [
  { suite: 'v1', baseline: 'docs/evals/baselines/renorbench-v1-product-hash.json' },
  { suite: 'v2', baseline: 'docs/evals/baselines/renorbench-v2-product-hash.json' },
];
const KEYS = ['replyHit', 'replyRecall', 'meanReplyTokens', 'p95ReplyTokens'];

/** One report line: default vs pinned for the chosen overall metrics. */
export function reportLine(suite, pinned, def) {
  const parts = KEYS.map(k => `${k} ${pinned[k]} -> ${def[k]}`);
  return `default-arm ${suite} (top_k 50 default vs pinned top_k 20): ${parts.join(', ')}`;
}

export function main(argv = process.argv.slice(2)) {
  const outDir = path.resolve(root, argv[0] ?? '.eval-runs/default-arm-report');
  fs.mkdirSync(outDir, { recursive: true });
  const record = { schema: 1, note: 'non-gating report; the product arm without --top-k', suites: {} };
  for (const { suite, baseline } of SUITES) {
    const runDir = path.join(outDir, suite);
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval/run-renorbench-product.ts', '--provider', 'hash', '--suite', suite, '--output', runDir, '--allow-dirty'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    if (run.status !== 0) { console.error(`default-arm ${suite}: run failed (exit ${run.status})`); return 2; }
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    if (!/query only/.test(manifest.entryPoint?.searchArguments ?? '')) { console.error(`default-arm ${suite}: the run was not at the shipped default`); return 2; }
    const def = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8')).overall;
    const pinned = JSON.parse(fs.readFileSync(path.join(root, baseline), 'utf8')).summary.overall;
    record.suites[suite] = { pinned: Object.fromEntries(KEYS.map(k => [k, pinned[k]])), default: Object.fromEntries(KEYS.map(k => [k, def[k]])) };
    console.log(reportLine(suite, pinned, def));
  }
  fs.writeFileSync(path.join(outDir, 'default-arm.json'), JSON.stringify(record, null, 2) + '\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
