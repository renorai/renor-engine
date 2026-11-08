import { describe, it, expect, afterEach } from 'vitest';
import { VectorIndex, mirrorCapBytes } from '../../src/embeddings/vectorIndex';
import { openDb as openDbFile } from '../../src/db/client';
import fs from 'fs';
import { runMigrations } from '../../src/db/schema';
import { tmpPath } from '../helpers/tmpPath';
import { removeDb } from '../helpers/removeDb';

const DB = tmpPath('test-vector.db');
// Every connection a test opens is closed before the file is removed, even when the test failed before its own close.
// Two tests never closed theirs: Windows then could not remove the file (EBUSY), the next test reopened a table made at
// 4 dimensions, and its inserts failed with "Dimension mismatch" / SQLITE_ERROR "SQL logic error" (#1563).
const opened: ReturnType<typeof openDbFile>[] = [];
function openDb(file: string): ReturnType<typeof openDbFile> {
  const db = openDbFile(file);
  opened.push(db);
  return db;
}
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  removeDb(DB);
});

describe('VectorIndex', () => {
  it('stores and retrieves embedding', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(1, [1, 0, 0, 0]);
    const got = idx.get(1);
    expect(got).not.toBeNull();
    expect(got!.length).toBe(4);
    db.close();
  });

  it('returns nearest neighbors in order', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(1, [1, 0, 0, 0]);
    idx.upsert(2, [0.9, 0.1, 0, 0]);
    idx.upsert(3, [0, 0, 1, 0]);
    const results = idx.search([1, 0, 0, 0], 2);
    expect(results[0].chunkId).toBe(1);
    expect(results[1].chunkId).toBe(2);
    db.close();
  });

  it('deletes embedding', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(1, [1, 0, 0, 0]);
    idx.delete(1);
    expect(idx.get(1)).toBeNull();
  });

  it('returns bounded scores between -1 and 1', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(1, [1, 0, 0, 0]);
    idx.upsert(2, [0, 0, 0, 1]); // orthogonal
    const results = idx.search([1, 0, 0, 0], 2);
    results.forEach(r => {
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    });
    // First result (identical) should have score close to 1
    expect(results[0].score).toBeGreaterThan(0.9);
    db.close();
  });

  it('reloads after another connection replaces a vector without changing the count', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(1, [1, 0, 0, 0]);
    idx.upsert(2, [0.8, 0.2, 0, 0]);
    idx.upsert(3, [0, 0, 1, 0]);
    expect(idx.search([1, 0, 0, 0], 1)[0].chunkId).toBe(1);

    const other = openDb(DB);
    const writer = new VectorIndex(other, 4);
    writer.initTable();
    writer.upsert(1, [0, 0, 0, 1]);
    other.close();

    expect(idx.search([1, 0, 0, 0], 1)[0].chunkId).toBe(2);
    db.close();
  });

  it('does not grow the copy past its byte cap', () => {
    // 6144-d: the cap holds 2,730 vectors. The copy is built on search, at an exact 2,048, so the next
    // write is the one that doubles 2,048 → 4,096 (96 MiB) while one more vector still fits. The copy
    // must stay at or under 64 MiB and search must still find the new row. Writes before the first
    // search do not grow anything: there is no copy yet, and the next search reads the table.
    const dims = 6144;
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, dims); idx.initTable();
    const vector = new Array<number>(dims).fill(0);
    vector[0] = 1;
    db.transaction(() => {
      for (let id = 1; id <= 2048; id++) idx.upsert(id, vector);
    })();
    // Identical rows tie, so the id is whichever path answers. The search is what builds the copy, at cap 2,048.
    idx.search(vector, 1);
    const loaded = (idx as unknown as { mirror: { count: number; cap: number } | null }).mirror;
    expect(loaded).not.toBeNull();
    expect(loaded!.count).toBe(2048);
    expect(loaded!.cap).toBe(2048);
    const added = new Array<number>(dims).fill(0);
    added[1] = 1;
    idx.upsert(2049, added);
    const copy = (idx as unknown as { mirror: { data: Float32Array } | null }).mirror;
    expect(copy).not.toBeNull();
    expect(copy!.data.byteLength).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(idx.search(added, 1)[0].chunkId).toBe(2049);
    db.close();
  }, 120_000);

  it('throws when the stored table was created at another dimension', () => {
    const db = openDb(DB); runMigrations(db);
    const wide = new VectorIndex(db, 8); wide.initTable();
    wide.upsert(1, [1, 0, 0, 0, 0, 0, 0, 0]);
    const narrow = new VectorIndex(db, 4);
    expect(() => narrow.search([1, 0, 0, 0], 1)).toThrow(/Dimension mismatch/);
    db.close();
  });

  it('reads the byte cap from RENOR_VECTOR_MIRROR_MIB in whole MiB, and keeps 64 MiB for any other value', () => {
    const mib = 1024 * 1024;
    expect(mirrorCapBytes(undefined)).toBe(64 * mib);
    for (const other of ['', '  ', '0', '-3', '1.5', 'abc']) expect(mirrorCapBytes(other), `"${other}"`).toBe(64 * mib);
    expect(mirrorCapBytes('1')).toBe(mib);
    expect(mirrorCapBytes(' 400 ')).toBe(400 * mib);
  });

  it('keeps a copy only while its vectors fit RENOR_VECTOR_MIRROR_MIB: 400 vectors of 768 dimensions are over 1 MiB and inside 2 MiB', () => {
    // The cap is read when the index is made. 400 × 768 × 4 bytes = 1,228,800: past 1 MiB, inside 2 MiB.
    const dims = 768;
    const vector = new Array<number>(dims).fill(0);
    vector[0] = 1;
    const copyWithCap = (mib: string) => {
      const saved = process.env.RENOR_VECTOR_MIRROR_MIB;
      process.env.RENOR_VECTOR_MIRROR_MIB = mib;
      const file = tmpPath(`test-vector-cap-${mib}.db`);
      try {
        const db = openDb(file); runMigrations(db);
        const idx = new VectorIndex(db, dims); idx.initTable();
        db.transaction(() => {
          for (let id = 1; id <= 400; id++) idx.upsert(id, vector);
        })();
        idx.search(vector, 1);
        const copy = (idx as unknown as { mirror: { count: number } | null }).mirror;
        db.close();
        return copy;
      } finally {
        if (saved === undefined) delete process.env.RENOR_VECTOR_MIRROR_MIB;
        else process.env.RENOR_VECTOR_MIRROR_MIB = saved;
        for (const suffix of ['', '-wal', '-shm']) {
          if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
        }
      }
    };
    expect(copyWithCap('1')).toBeNull();
    expect(copyWithCap('2')).toMatchObject({ count: 400 });
  });

  it('clamps RENOR_VECTOR_MIRROR_MIB to 4096 MiB, however large the number is', () => {
    const mib = 1024 * 1024;
    expect(mirrorCapBytes('4096')).toBe(4096 * mib);
    expect(mirrorCapBytes('5000')).toBe(4096 * mib);
    expect(mirrorCapBytes('9'.repeat(400))).toBe(4096 * mib);
  });

  describe('a copy that cannot be allocated', () => {
    // `new Float32Array(length)` throws for `length` while `run` is on, as it does when the memory cannot be had.
    const withFloat32ArrayFailing = <T>(length: number, run: () => T): T => {
      // One plain construct signature for the base: the library's overloads return differently typed arrays, which a class cannot extend.
      const real = globalThis.Float32Array as unknown as new (...args: any[]) => Float32Array;
      globalThis.Float32Array = class extends real {
        constructor(...args: any[]) {
          if (args[0] === length) throw new RangeError('Array buffer allocation failed');
          super(...args);
        }
      } as unknown as Float32ArrayConstructor;
      try {
        return run();
      } finally {
        globalThis.Float32Array = real as unknown as Float32ArrayConstructor;
      }
    };
    // One distinct unit vector per id, so the nearest neighbour of a vector is its own id.
    const oneHot = (id: number, dims: number) => {
      const vector = new Array<number>(dims).fill(0);
      vector[id % dims] = 1;
      return vector;
    };

    it('answers from sqlite-vec when the copy cannot be allocated for a search', () => {
      const dims = 768;
      const db = openDb(DB); runMigrations(db);
      const idx = new VectorIndex(db, dims); idx.initTable();
      db.transaction(() => {
        for (let id = 1; id <= 400; id++) idx.upsert(id, oneHot(id, dims));
      })();
      withFloat32ArrayFailing(400 * dims, () => {
        expect(() => idx.search(oneHot(7, dims), 1)).not.toThrow();
      });
      expect(idx.search(oneHot(7, dims), 1)[0].chunkId).toBe(7);
      db.close();
    });

    it('drops the copy when a write needs a larger one that cannot be allocated, and the write still lands', () => {
      const dims = 768;
      const db = openDb(DB); runMigrations(db);
      const idx = new VectorIndex(db, dims); idx.initTable();
      db.transaction(() => {
        for (let id = 1; id <= 400; id++) idx.upsert(id, oneHot(id, dims));
      })();
      idx.search(oneHot(1, dims), 1);
      expect((idx as unknown as { mirror: unknown }).mirror).not.toBeNull();
      // The copy holds 400 vectors and is full, so the write doubles it to 800: that allocation is the one that fails.
      withFloat32ArrayFailing(800 * dims, () => {
        expect(() => idx.upsert(401, oneHot(401, dims))).not.toThrow();
      });
      expect((idx as unknown as { mirror: unknown }).mirror).toBeNull();
      expect(idx.search(oneHot(401, dims), 1)[0].chunkId).toBe(401);
      db.close();
    });
  });

  describe('the background copy (warmMirror)', () => {
    // 2,500 vectors of 128 dimensions fill three packed blobs of 1,024 rows, so the copy is read across turns of the event
    // loop. The cap of 1 MiB is past 2,500 × 128 × 4 bytes = 1.28 MB, so an index read with it answers from sqlite-vec alone.
    const dims = 128;
    const count = 2500;
    const vectorFor = (id: number) => {
      const raw = Array.from({ length: dims }, (_, d) => Math.sin(id * 0.61 + d * 0.37));
      const mag = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
      return raw.map(v => v / mag);
    };
    const fill = (db: ReturnType<typeof openDb>, idx: VectorIndex) => {
      db.transaction(() => {
        for (let id = 1; id <= count; id++) idx.upsert(id, vectorFor(id));
      })();
    };
    const withMirrorMib = <T>(mib: string | undefined, make: () => T): T => {
      const saved = process.env.RENOR_VECTOR_MIRROR_MIB;
      if (mib === undefined) delete process.env.RENOR_VECTOR_MIRROR_MIB;
      else process.env.RENOR_VECTOR_MIRROR_MIB = mib;
      try {
        return make();
      } finally {
        if (saved === undefined) delete process.env.RENOR_VECTOR_MIRROR_MIB;
        else process.env.RENOR_VECTOR_MIRROR_MIB = saved;
      }
    };
    const mirrorOf = (idx: VectorIndex) => (idx as unknown as { mirror: { count: number } | null }).mirror;
    const nextTurns = async (turns: number) => {
      for (let i = 0; i < turns; i++) await new Promise<void>(resolve => setImmediate(resolve));
    };

    it('reads the copy in the background, then answers as sqlite-vec does', async () => {
      const db = openDb(DB); runMigrations(db);
      const idx = new VectorIndex(db, dims); idx.initTable();
      fill(db, idx);
      const blobs = db.prepare('SELECT COUNT(*) AS n FROM chunk_embeddings_vector_chunks00').get() as { n: number | bigint };
      expect(Number(blobs.n)).toBeGreaterThanOrEqual(2);
      expect(await idx.warmMirror()).toBe(true);
      expect(mirrorOf(idx)?.count).toBe(count);
      const sqliteOnly = withMirrorMib('1', () => new VectorIndex(db, dims));
      for (const query of [vectorFor(0.5), vectorFor(1500.5), vectorFor(2499.5)]) {
        const copied = idx.search(query, 10);
        const stored = sqliteOnly.search(query, 10);
        expect(copied.map(r => r.chunkId)).toEqual(stored.map(r => r.chunkId));
        copied.forEach((r, i) => expect(r.score).toBeCloseTo(stored[i].score, 6));
      }
      expect(mirrorOf(sqliteOnly)).toBeNull();
      db.close();
    });

    it('applies the writes made while the copy is read, so the copy it installs is right', async () => {
      const db = openDb(DB); runMigrations(db);
      const idx = new VectorIndex(db, dims); idx.initTable();
      fill(db, idx);
      const pending = idx.warmMirror();
      const replaced = vectorFor(9001);
      idx.upsert(1234, replaced);
      idx.delete(7);
      expect(await pending).toBe(true);
      expect(mirrorOf(idx)?.count).toBe(count - 1);
      const sqliteOnly = withMirrorMib('1', () => new VectorIndex(db, dims));
      for (const query of [replaced, vectorFor(7), vectorFor(3.5)]) {
        expect(idx.search(query, 10).map(r => r.chunkId)).toEqual(sqliteOnly.search(query, 10).map(r => r.chunkId));
      }
      expect(idx.search(replaced, 1)[0].chunkId).toBe(1234);
      expect(idx.search(vectorFor(7), 10).map(r => r.chunkId)).not.toContain(7);
      db.close();
    });

    it('drops the copy when a rebuild starts, since the copy cannot follow it', async () => {
      const db = openDb(DB); runMigrations(db);
      const idx = new VectorIndex(db, dims); idx.initTable();
      fill(db, idx);
      const pending = idx.warmMirror();
      idx.beginRebuild('a-new-space');
      expect(await pending).toBe(false);
      expect(mirrorOf(idx)?.count).toBe(0);
      db.close();
    });

    it('yields to the event loop between blobs, so a reply in the meantime is not held up by the copy', async () => {
      const db = openDb(DB); runMigrations(db);
      const idx = new VectorIndex(db, dims); idx.initTable();
      fill(db, idx);
      let done = false;
      const pending = idx.warmMirror().then(ready => { done = true; return ready; });
      await nextTurns(1);
      expect(done).toBe(false);
      expect(await pending).toBe(true);
      db.close();
    });

    it('starts the copy in the background only when RENOR_VECTOR_MIRROR_MIB raised the cap above 64', async () => {
      const db = openDb(DB); runMigrations(db);
      const raised = withMirrorMib('128', () => new VectorIndex(db, dims));
      raised.initTable();
      fill(db, raised);
      raised.warmMirrorInBackground();
      await nextTurns(20);
      expect(mirrorOf(raised)?.count).toBe(count);
      const plain = withMirrorMib(undefined, () => new VectorIndex(db, dims));
      plain.warmMirrorInBackground();
      await nextTurns(20);
      expect(mirrorOf(plain)).toBeNull();
      db.close();
    });
  });

  it('grows a copy under a raised 4096 MiB cap without overflowing, and keeps answering', () => {
    // At the ceiling the cap is 4 GiB: the growth arithmetic (capBytes / (dims * 4), and the doubling) must stay exact there.
    const dims = 4;
    const previous = process.env.RENOR_VECTOR_MIRROR_MIB;
    process.env.RENOR_VECTOR_MIRROR_MIB = '4096';
    const db = openDb(DB); runMigrations(db);
    try {
      const idx = new VectorIndex(db, dims); idx.initTable();
      const vectorOf = (id: number) => {
        const raw = [Math.cos(id), Math.sin(id), Math.cos(id * 0.5), Math.sin(id * 0.25)];
        const mag = Math.hypot(...raw);
        return raw.map(v => v / mag);
      };
      db.transaction(() => {
        for (let id = 1; id <= 40; id++) idx.upsert(id, vectorOf(id));
      })();
      idx.search(vectorOf(1), 1); // builds the copy at 40 vectors, so its cap is 40
      for (let id = 41; id <= 90; id++) idx.upsert(id, vectorOf(id)); // each growth doubles the copy: 40, 80, 160
      const copy = (idx as unknown as { mirror: { count: number; cap: number } | null }).mirror;
      expect(copy).not.toBeNull();
      expect(copy!.count).toBe(90);
      expect(copy!.cap).toBeGreaterThanOrEqual(90);
      expect(Number.isFinite(copy!.cap)).toBe(true);
      expect(idx.search(vectorOf(77), 1)[0].chunkId).toBe(77);
    } finally {
      if (previous === undefined) delete process.env.RENOR_VECTOR_MIRROR_MIB;
      else process.env.RENOR_VECTOR_MIRROR_MIB = previous;
      db.close();
    }
  });

  it('holds more than 64 MiB of vectors in a copy at the raised cap, so a cap pinned to the 64 MiB constant fails here', () => {
    // 64 MiB holds 21,845 vectors of 768 dimensions. At RENOR_VECTOR_MIRROR_MIB=4096 the copy must keep growing past that.
    // Growth that stops at the 64 MiB constant drops the copy at row 21,846, so the copy is null and this test fails.
    const dims = 768;
    const rows = Math.floor((64 * 1024 * 1024) / (dims * 4)) + 1;
    const previous = process.env.RENOR_VECTOR_MIRROR_MIB;
    process.env.RENOR_VECTOR_MIRROR_MIB = '4096';
    const db = openDb(DB); runMigrations(db);
    try {
      const idx = new VectorIndex(db, dims); idx.initTable();
      // A distinct vector per id, so the nearest neighbour of a vector is its own id.
      const vectorOf = (id: number) => {
        const raw = new Array<number>(dims);
        for (let k = 0; k < dims; k++) raw[k] = Math.sin(id * 0.37 + k * 1.13);
        const mag = Math.hypot(...raw);
        return raw.map(v => v / mag);
      };
      db.transaction(() => {
        for (let id = 1; id <= 16_384; id++) idx.upsert(id, vectorOf(id));
      })();
      idx.search(vectorOf(1), 1); // builds the copy at exactly 16,384 vectors
      db.transaction(() => {
        for (let id = 16_385; id <= rows; id++) idx.upsert(id, vectorOf(id));
      })();
      const copy = (idx as unknown as { mirror: { count: number } | null }).mirror;
      expect(copy).not.toBeNull();
      expect(copy!.count).toBe(rows);
      expect(copy!.count * dims * 4).toBeGreaterThan(64 * 1024 * 1024);
      expect(idx.search(vectorOf(rows), 1)[0].chunkId).toBe(rows);
    } finally {
      if (previous === undefined) delete process.env.RENOR_VECTOR_MIRROR_MIB;
      else process.env.RENOR_VECTOR_MIRROR_MIB = previous;
      db.close();
    }
  }, 120_000);
});
