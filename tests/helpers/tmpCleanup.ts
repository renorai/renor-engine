import fs from 'node:fs';
import { afterAll, vi } from 'vitest';

/**
 * Call once at the top level of a test file. Every folder the file (or the code it exercises) makes
 * with fs.mkdtempSync is removed when the file finishes, so a run leaves nothing behind in os.tmpdir().
 */
export function removeTempDirsAfterAll(): void {
  const made: string[] = [];
  const real = fs.mkdtempSync.bind(fs) as (...a: unknown[]) => string;
  vi.spyOn(fs, 'mkdtempSync').mockImplementation(((...a: unknown[]) => {
    const dir = real(...a);
    made.push(dir);
    return dir;
  }) as never);
  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });
}
