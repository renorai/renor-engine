import { describe, it, expect } from 'vitest';
import { applyHitFloor, markWeakMatch, searchHitFloor, searchHitFloorKeep } from '../../src/mvp/hitFloor';
import { SESSION_EXPAND_REASON } from '../../src/retrieval/orchestrator';

/** The floor itself (mvp/hitFloor.ts), on hits as the page holds them. The MCP tool that applies it: search-hit-floor.test.ts. */
describe('applyHitFloor', () => {
  const hit = (notePath: string, similarity: number | undefined, reason = 'semantic') => ({ notePath, similarity, reason });

  it('takes out the hits found by meaning below the floor and keeps the rest in order', () => {
    const hits = [hit('a.md', 0.9), hit('b.md', 0.5), hit('c.md', 0.7), hit('d.md', 0.7), hit('e.md', 0.8), hit('f.md', 0.4)];
    // Top three by similarity: a 0.9, e 0.8, c 0.7 (d ties c, earlier wins). b, d and f are the tail.
    expect(applyHitFloor(hits, 0.75)).toEqual({ hits: [hits[0], hits[2], hits[4]], withheld: 3 });
    expect(applyHitFloor(hits, 0)).toEqual({ hits, withheld: 0 });
    expect(applyHitFloor(hits, 1)).toEqual({ hits: [hits[0], hits[2], hits[4]], withheld: 3 });
  });

  it('keeps the best hit even when it is below the floor (0.60 survives a 0.63 floor)', () => {
    const hits = [hit('a.md', 0.6)];
    expect(applyHitFloor(hits, 0.63)).toEqual({ hits, withheld: 0 });
  });

  it('withholds the fourth hit below the floor while the top three stay', () => {
    const hits = [hit('a.md', 0.62), hit('b.md', 0.61), hit('c.md', 0.6), hit('d.md', 0.59)];
    expect(applyHitFloor(hits, 0.63)).toEqual({ hits: hits.slice(0, 3), withheld: 1 });
  });

  it('still removes tail noise: a below-floor hit outside the top three goes, whatever its page position', () => {
    const noise = Array.from({ length: 20 }, (_, i) => hit(`n${i}.md`, 0.5 + i * 0.001));
    const best = [hit('x.md', 0.60), hit('y.md', 0.59), hit('z.md', 0.58)];
    const { hits: kept, withheld } = applyHitFloor([...noise, ...best], 0.63);
    expect(kept).toEqual(best);
    expect(withheld).toBe(20);
  });

  it('protects only the closest note hits: facts without similarity neither take a protected place nor lose one', () => {
    const hits = [hit('', undefined, 'fact'), hit('a.md', 0.5), hit('b.md', 0.4), hit('c.md', 0.3), hit('d.md', 0.2)];
    expect(applyHitFloor(hits, 0.63)).toEqual({ hits: hits.slice(0, 4), withheld: 1 });
  });

  it('never judges a hit that has no similarity of its own: a fact, evidence, a digest, a ledger event, a graph hit', () => {
    const hits = [hit('', undefined, 'evidence'), hit('', undefined, 'digest'), hit('', undefined, 'fact'), hit('ledger.md', undefined), hit('g.md', undefined, 'graph'), hit('a.md', 0.2)];
    expect(applyHitFloor(hits, 1, 0)).toEqual({ hits: hits.slice(0, 5), withheld: 1 }); // judged only the one with a similarity
    expect(applyHitFloor(hits, 1)).toEqual({ hits, withheld: 0 }); // with the default keep it is among the closest three
  });

  it('keeps a statement the session expansion added only while a hit that matched its note is left', () => {
    const hits = [
      hit('kept.md', 0.8), hit('kept.md', undefined, SESSION_EXPAND_REASON),
      hit('gone.md', 0.3), hit('gone.md', undefined, SESSION_EXPAND_REASON), hit('gone.md', undefined, SESSION_EXPAND_REASON),
      hit('graph.md', undefined, 'graph'), hit('graph.md', undefined, SESSION_EXPAND_REASON),
      hit('p1.md', 0.9), hit('p2.md', 0.9),
    ];
    const { hits: kept, withheld } = applyHitFloor(hits, 0.5);
    expect(kept).toEqual([hits[0], hits[1], hits[5], hits[6], hits[7], hits[8]]);
    expect(withheld).toBe(3);
  });

  it('does not touch what it is given', () => {
    const hits = Object.freeze([Object.freeze(hit('a.md', 0.1)), Object.freeze(hit('b.md', 0.9))]);
    expect(() => applyHitFloor(hits, 0.5)).not.toThrow();
    expect(hits).toHaveLength(2);
  });
});


describe('operator setting', () => {
  const calibrated = 'vertex:gemini-embedding-001:768';
  const otherModels = [undefined, 'eval-hash:lexical-hash-v1:256', 'vertex:gemini-embedding-001:3072', 'vertex:other-model:768', 'other:gemini-embedding-001:768'];

  it('defaults to 0.63 only for the calibrated model and dimensions, off for every other namespace', () => {
    expect(searchHitFloor(calibrated, {})).toBe(0.63);
    for (const model of otherModels) expect(searchHitFloor(model, {}), model).toBe(0);
  });

  it('lets an explicit operator setting win for every namespace, including 0 as off', () => {
    for (const model of [calibrated, ...otherModels]) {
      for (const setting of ['0', '0.7', '1']) expect(searchHitFloor(model, { RENOR_SEARCH_HIT_FLOOR: setting })).toBe(Number(setting));
    }
  });

  it('uses the namespace default for empty or invalid settings', () => {
    for (const model of [calibrated, ...otherModels]) {
      for (const setting of ['', 'no', '-1', '1.1', 'NaN', 'Infinity']) {
        expect(searchHitFloor(model, { RENOR_SEARCH_HIT_FLOOR: setting })).toBe(model === calibrated ? 0.63 : 0);
      }
    }
  });

  it('keeps a cosine equal to the floor, regardless of a boosted score', () => {
    const top = ['t1.md', 't2.md', 't3.md'].map(notePath => ({ notePath, similarity: 0.9, score: 0.9 }));
    const hits = [{ notePath: 'below.md', similarity: 0.629, score: 1.9 }, { notePath: 'equal.md', similarity: 0.63, score: 0.63 }, ...top];
    expect(applyHitFloor(hits, 0.63)).toEqual({ hits: hits.slice(1), withheld: 1 });
  });
});

describe('RENOR_SEARCH_HIT_FLOOR_KEEP', () => {
  it('reads a whole number from 0 to 50 and uses 3 for anything else', () => {
    const table: Array<[string | undefined, number]> = [[undefined, 3], ['', 3], [' ', 3], ['0', 0], ['3', 3], ['50', 50], [' 5 ', 5], ['51', 3], ['-1', 3], ['2.5', 3], ['abc', 3]];
    for (const [setting, want] of table) expect(searchHitFloorKeep(setting === undefined ? {} : { RENOR_SEARCH_HIT_FLOOR_KEEP: setting }), String(setting)).toBe(want);
  });

  it('marks only a kept hit that is under the floor', () => {
    expect(markWeakMatch({ similarity: 0.6 }, 0.63)).toEqual({ similarity: 0.6, weak_match: true });
    expect(markWeakMatch({ similarity: 0.63 }, 0.63)).toEqual({ similarity: 0.63 });
    expect(markWeakMatch({}, 0.63)).toEqual({});
  });
});
