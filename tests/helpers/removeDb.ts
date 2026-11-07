import fs from 'fs';

/**
 * Test teardown for a SQLite file: removes it with its -wal and -shm side files. The test must have closed every handle
 * on it first. POSIX lets an open file be unlinked, so a leaked handle went unnoticed there; Windows refuses (EBUSY, #1563),
 * so on every platform a handle still open here is reported as the test's bug, naming the file, instead of as a bare EBUSY.
 */
export function removeDb(dbPath: string): void {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM') {
        throw new Error(`${file} is still open (${code}): close the database before removing it`, { cause: err });
      }
      throw err;
    }
  }
}
