import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// #1280: an old Node must get one plain message, not a raw syntax or module error.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const guard = require('../../bin/renor-engine.cjs') as {
  nodeVersionSupported: (v: string) => boolean;
};
const entry = path.resolve(__dirname, '../../bin/renor-engine.cjs');

describe('renor-engine Node version guard', () => {
  it.each([
    ['20.11.0', false],
    ['22.15.9', false],
    ['22.16.0', true],
    ['22.20.1', true],
    ['23.5.0', false],
    ['24.0.0', true],
    ['26.1.0', true],
    ['garbage', false],
  ])('node %s supported=%s', (v, ok) => {
    expect(guard.nodeVersionSupported(v)).toBe(ok);
  });

  it('exits 1 with a single message and no stack trace on an old Node', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-guard-'));
    const preload = path.join(dir, 'old-node.cjs');
    fs.writeFileSync(
      preload,
      "Object.defineProperty(process.versions,'node',{value:'20.11.0',configurable:true});",
    );
    const r = spawnSync(process.execPath, ['--require', preload, entry, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    const lines = r.stderr.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(r.stderr).toContain('22.16');
    expect(r.stderr).toContain('20.11.0');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});
