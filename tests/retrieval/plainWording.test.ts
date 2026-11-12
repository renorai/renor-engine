import { describe, it, expect } from 'vitest';
import {
  applyNearDupCap, contentTerms, jaccard, laneTermShare, queryRewriteEnabled, resolveNearDupCap,
  rewriteConversationalQuery,
} from '../../src/retrieval/plainWording';

describe('the switches', () => {
  it('are off unless set to an on value; the cap is off unless it names one', () => {
    expect(queryRewriteEnabled({})).toBe(false);
    for (const value of ['1', 'true', 'yes', 'on', ' ON ']) {
      expect(queryRewriteEnabled({ RENOR_QUERY_REWRITE: value })).toBe(true);
    }
    for (const value of ['', '0', 'off', 'false', 'junk']) {
      expect(queryRewriteEnabled({ RENOR_QUERY_REWRITE: value })).toBe(false);
    }
    expect(resolveNearDupCap({})).toBe(0);
    for (const value of ['', '0', '-2', '0.5', 'junk', 'Infinity']) expect(resolveNearDupCap({ RENOR_NEAR_DUP_CAP: value })).toBe(0);
    expect(resolveNearDupCap({ RENOR_NEAR_DUP_CAP: '2' })).toBe(2);
    expect(resolveNearDupCap({ RENOR_NEAR_DUP_CAP: '1.9' })).toBe(1);
  });
});

describe('contentTerms', () => {
  it('keeps the words that can name a subject, a hyphenated name as one, without the words of asking', () => {
    expect(contentTerms('Hey, do you remember the numbers we measured for Jev?')).toEqual(['numbers', 'measured', 'jev']);
    expect(contentTerms('what did we decide about catalog-worker retries')).toEqual(['decide', 'catalog-worker', 'retries']);
    expect(contentTerms("Jev's idle draw, jev again")).toEqual(['jev', 'idle', 'draw']);
    expect(contentTerms('is it on?')).toEqual([]);
  });
});

describe('rewriteConversationalQuery', () => {
  it('takes the conversational wrapper off the front and the back, and keeps the question\'s own words', () => {
    expect(rewriteConversationalQuery('hey, do you remember what we said about the jev measurements?')).toBe('the jev measurements');
    expect(rewriteConversationalQuery('Claude, can you remind me of the staging database password rotation again?'))
      .toBe('the staging database password rotation');
    expect(rewriteConversationalQuery('what did we decide on the retry budget for catalog-worker')).toBe('the retry budget for catalog-worker');
  });

  it('returns a query with no wrapper, or one the rewrite would empty, as it came', () => {
    for (const query of ['catalog-worker retry budget', 'Where does Iris live now?', 'do you remember', 'remind me about it']) {
      expect(rewriteConversationalQuery(query)).toBe(query);
    }
  });
});

describe('laneTermShare', () => {
  it('counts whole words only, and a hyphenated lane word across any separator', () => {
    expect(laneTermShare('Jev bench readings: idle 41 mA', ['jev'])).toBe(1);
    expect(laneTermShare('Jevons paradox', ['jev'])).toBe(0);
    expect(laneTermShare('the catalog worker restarts', ['catalog-worker', 'retries'])).toBe(0.5);
    expect(laneTermShare('anything', [])).toBe(0);
  });
});

describe('applyNearDupCap', () => {
  const hit = (chunkId: number, text: string) => ({ chunkId, text });
  const copies = [1, 2, 3, 4].map(k => hit(k, `Benchmark run ${k} on the staging board: p95 latency unchanged from the run before.`));
  const distinct = hit(9, 'Jev bench readings from 3 Oct: idle draw 41 mA.');

  it('keeps at most `cap` near-copies, the best ranked, and every hit that is no copy, in rank order', () => {
    expect(applyNearDupCap([...copies, distinct], 1).map(h => h.chunkId)).toEqual([1, 9]);
    expect(applyNearDupCap([...copies, distinct], 2).map(h => h.chunkId)).toEqual([1, 2, 9]);
  });

  it('is off below 1, leaves fact rows alone, and compares the text it is given', () => {
    const all = [...copies, distinct];
    expect(applyNearDupCap(all, 0)).toBe(all);
    const facts = [hit(-1, 'same fact'), hit(-2, 'same fact')];
    expect(applyNearDupCap([...facts, ...copies], 1).map(h => h.chunkId)).toEqual([-1, -2, 1]);
    expect(applyNearDupCap([hit(1, 'x one'), hit(2, 'y two')], 1, () => 'same visible text').map(h => h.chunkId)).toEqual([1]);
  });

  it('measures copies by word-set Jaccard', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });
});
