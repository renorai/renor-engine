#!/usr/bin/env node
/**
 * Packs the public `renor-engine` npm package as ONE bundled file, so `npx -y renor-engine mcp` downloads the native
 * modules it cannot do without and nothing else.
 *
 *   npm run build && node scripts/npm/pack.mjs [--out <dir>]     -> <dir>/renor-engine-<version>.tgz (default: .npm-pack/)
 *
 * WHY: `npm pack` of this folder ships tsc's dist/ and asks the installer for every dependency in package.json. The
 * install was 161 tarballs, ~29 MB, ~106 MB unpacked, and 17.7 MB of that was gpt-tokenizer, which no shipped code path
 * loads (the engine counts tokens with src/indexer/o200k.ts). Bundling dist/cli.js carries only the code the CLI can
 * reach; the package then depends on better-sqlite3 and sqlite-vec alone (native, so they cannot be bundled).
 *
 * WHAT DOES NOT CHANGE: this folder's package.json, dist/ and node_modules. The tenant VM and every script that runs
 * dist/mvp/cli.js from an `npm ci` of this tree see exactly what they saw before; only the published tarball differs.
 *
 * Kept outside the bundle, and why:
 *   - better-sqlite3, sqlite-vec: native binaries, resolved at runtime (dependencies).
 *   - posthog-node, @posthog/mcp: loaded only when RENOR_POSTHOG_KEY is set (src/mvp/posthogMcp.ts), so they are
 *     optional peers: a workspace that wants PostHog installs them, nobody else downloads them.
 *   - @xenova/transformers: already an optional peer (EMBEDDING_PROVIDER=local).
 *   - ./o200k.json: the token vocabulary, read on the first count and then dropped from the module cache; it ships as
 *     dist/o200k.json beside the bundle, where the bundled `require('./o200k.json')` resolves it.
 * dist/BUILD.json sits where src/buildIdentity.ts looks (the package root's dist/).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackResult } from './pack-result.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(engineRoot, 'package.json'));
const esbuild = require('esbuild');

const outFlag = process.argv.indexOf('--out');
const outDir = resolve(outFlag >= 0 ? process.argv[outFlag + 1] : join(engineRoot, '.npm-pack'));

const NATIVE = ['sqlite-vec'];
const OPTIONAL_PEERS = ['@xenova/transformers', 'posthog-node', '@posthog/mcp'];

const source = JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8'));
for (const rel of ['dist/cli.js', 'dist/indexer/o200k.json', 'dist/BUILD.json']) {
  if (!existsSync(join(engineRoot, rel))) {
    console.error(`pack: ${rel} is missing; run \`npm run build\` first`);
    process.exit(1);
  }
}

const stage = join(outDir, 'package');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'dist'), { recursive: true });
mkdirSync(join(stage, 'bin'), { recursive: true });

const result = await esbuild.build({
  entryPoints: [join(engineRoot, 'dist', 'cli.js')],
  outfile: join(stage, 'dist', 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: [...NATIVE, ...OPTIONAL_PEERS, './o200k.json'],
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
});

copyFileSync(join(engineRoot, 'dist', 'indexer', 'o200k.json'), join(stage, 'dist', 'o200k.json'));
copyFileSync(join(engineRoot, 'dist', 'BUILD.json'), join(stage, 'dist', 'BUILD.json'));
// The Node-version guard is the bin entry: plain old-syntax JS that checks the version, then loads dist/cli.js.
copyFileSync(join(engineRoot, 'bin', 'renor-engine.cjs'), join(stage, 'bin', 'renor-engine.cjs'));
// The private tree keeps the public README as README.public.md; the public export renames it README.md (oss/public-files.txt).
copyFileSync(join(engineRoot, existsSync(join(engineRoot, 'README.public.md')) ? 'README.public.md' : 'README.md'), join(stage, 'README.md'));
for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(engineRoot, file), join(stage, file));

// Bundled code keeps its authors' licence terms: every package inside the bundle, with its licence text.
const bundled = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const at = input.lastIndexOf('node_modules/');
  if (at < 0) continue;
  const name = /^(?:@[^/]+\/)?[^/]+/.exec(input.slice(at + 'node_modules/'.length))[0];
  bundled.set(name, join(engineRoot, input.slice(0, at), 'node_modules', name));
}
const notices = [...bundled].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licenceFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE', 'license.md']
    .map(file => join(dir, file)).find(existsSync);
  const text = licenceFile ? readFileSync(licenceFile, 'utf8').trim() : `(no licence file shipped; package.json says ${pkg.license})`;
  return `${name}@${pkg.version} (${pkg.license ?? 'unknown'})\n\n${text}\n`;
});
writeFileSync(join(stage, 'THIRD-PARTY-NOTICES'), `Packages bundled into dist/cli.js\n\n${notices.join('\n' + '-'.repeat(72) + '\n\n')}`);

const pick = names => Object.fromEntries(names.map(name => {
  const range = source.dependencies?.[name] ?? source.peerDependencies?.[name] ?? source.devDependencies?.[name];
  if (!range) throw new Error(`pack: ${name} has no version range in package.json`);
  return [name, range];
}));
const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  main: 'dist/cli.js',
  bin: { 'renor-engine': 'bin/renor-engine.cjs' },
  files: ['bin', 'dist', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES'],
  keywords: source.keywords,
  homepage: source.homepage,
  repository: source.repository,
  bugs: source.bugs,
  author: source.author,
  license: source.license,
  type: 'commonjs',
  dependencies: pick(NATIVE),
  peerDependencies: pick(OPTIONAL_PEERS),
  peerDependenciesMeta: Object.fromEntries(OPTIONAL_PEERS.map(name => [name, { optional: true }])),
  ...(source.private ? { private: true } : {}),
  engines: source.engines,
};
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', outDir], { cwd: stage, encoding: 'utf8' });
const info = readPackResult(packed);
console.log(`${join(outDir, info.filename)}: ${info.size} bytes packed, ${info.unpackedSize} unpacked, ${info.entryCount} files; ` +
  `${bundled.size} packages bundled, depends on ${NATIVE.join(' and ')}`);
