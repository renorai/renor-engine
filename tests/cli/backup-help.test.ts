import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('shows how to restore an archive to an empty folder in backup help', () => {
  const cli = path.resolve(__dirname, '../../bin/renor-engine.cjs');
  const help = execFileSync(process.execPath, [cli, 'backup', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, RENOR_ENGINE_BACKUP: '1' },
  });

  expect(help).toContain('renor-engine restore backup.tar.gz --to ./restored');
});
