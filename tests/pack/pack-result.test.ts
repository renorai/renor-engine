import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { readPackResult } from '../../scripts/npm/pack-result.mjs';

const info = { filename: 'renor-engine-1.4.8.tgz', size: 100, unpackedSize: 300, entryCount: 9 };

describe('readPackResult', () => {
  it('reads the npm 10 shape (array)', () => {
    expect(readPackResult(JSON.stringify([info]))).toEqual(info);
  });
  it('reads the npm 12 shape (object keyed by package name)', () => {
    expect(readPackResult(JSON.stringify({ 'renor-engine': info }))).toEqual(info);
  });
  it('reads a bare object', () => {
    expect(readPackResult(JSON.stringify(info))).toEqual(info);
  });
  it('fails clearly on anything else', () => {
    expect(() => readPackResult('[]')).toThrow(/unrecognised/);
    expect(() => readPackResult('{}')).toThrow(/unrecognised/);
    expect(() => readPackResult('not json')).toThrow(/did not print JSON/);
  });
});
