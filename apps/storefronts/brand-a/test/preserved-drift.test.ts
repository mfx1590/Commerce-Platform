import { describe, expect, it } from 'vitest';
import { blobIds, preservedDrift } from '../scripts/preserved-drift.mjs';

/**
 * The record that says a PRESERVED file's starter counterpart moved. Pure functions only: the
 * script's wiring reads the live starter, which this suite deliberately never does (see the
 * `--check` comment in sync-from-starter.mjs).
 */
describe('preservedDrift', () => {
  const recorded = { 'next.config.mjs': 'aaa', 'src/brand/config.ts': 'bbb' };

  it('says nothing when the starter has not moved', () => {
    expect(preservedDrift(recorded, { ...recorded })).toEqual([]);
  });

  it('names a preserved file whose starter blob changed — the 2026-10-03 case', () => {
    expect(preservedDrift(recorded, { ...recorded, 'next.config.mjs': 'ccc' })).toEqual([
      '~ next.config.mjs',
    ]);
  });

  it('names files the starter added or removed under a preserved path', () => {
    expect(
      preservedDrift(recorded, { 'next.config.mjs': 'aaa', 'src/brand/fonts.ts': 'ddd' }),
    ).toEqual([
      '+ src/brand/fonts.ts (new in the starter since the last sync)',
      '- src/brand/config.ts (gone from the starter)',
    ]);
  });

  it('reports nothing without a previous record rather than calling everything new', () => {
    expect(preservedDrift(undefined, recorded)).toEqual([]);
  });
});

describe('blobIds', () => {
  it('reads `git ls-files -s`, keeping only the paths asked for', () => {
    const output = [
      '100644 cbc0d09da42652b29266252b3e081717d1aabeb0 0\tnext.config.mjs',
      '100644 1111111111111111111111111111111111111111 0\tsrc/app/[locale]/(shop)/page.tsx',
      '100644 2222222222222222222222222222222222222222 0\tsrc/brand/config.ts',
      '',
    ].join('\n');
    expect(blobIds(output, (f) => f === 'next.config.mjs' || f.startsWith('src/brand/'))).toEqual({
      'next.config.mjs': 'cbc0d09da42652b29266252b3e081717d1aabeb0',
      'src/brand/config.ts': '2222222222222222222222222222222222222222',
    });
  });
});
