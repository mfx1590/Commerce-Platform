// The bound behind every in-process index in this module: entries expire, and the map never exceeds its cap.
import { describe, expect, it } from 'vitest';
import { BoundedTtlMap } from './bounded-map';

describe('BoundedTtlMap', () => {
  it('serves an entry until its TTL passes', () => {
    let clock = 0;
    const map = new BoundedTtlMap<string>({ maxEntries: 10, ttlMs: 100, now: () => clock });
    map.set('a', 'one');
    clock = 99;
    expect(map.get('a')).toBe('one');
    clock = 100;
    expect(map.get('a')).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('never grows past maxEntries, dropping the oldest insertion first', () => {
    const map = new BoundedTtlMap<number>({ maxEntries: 3, ttlMs: Infinity });
    for (const [key, value] of [
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 4],
    ] as const) {
      map.set(key, value);
    }
    expect(map.size).toBe(3);
    expect(map.get('a')).toBeUndefined();
    expect(map.values()).toEqual([2, 3, 4]);
  });

  it('re-inserting a key makes it the newest, so it is evicted last', () => {
    const map = new BoundedTtlMap<number>({ maxEntries: 2, ttlMs: Infinity });
    map.set('a', 1);
    map.set('b', 2);
    map.set('a', 11);
    map.set('c', 3);
    expect(map.get('b')).toBeUndefined();
    expect(map.get('a')).toBe(11);
    expect(map.get('c')).toBe(3);
  });

  it('drops expired entries before evicting live ones', () => {
    let clock = 0;
    const map = new BoundedTtlMap<number>({ maxEntries: 2, ttlMs: 10, now: () => clock });
    map.set('old', 1);
    clock = 20;
    map.set('new', 2);
    map.set('newer', 3);
    expect(map.values()).toEqual([2, 3]);
  });

  it('deletes and clears', () => {
    const map = new BoundedTtlMap<number>({ maxEntries: 5, ttlMs: Infinity });
    map.set('a', 1);
    map.delete('a');
    expect(map.get('a')).toBeUndefined();
    map.set('b', 2);
    map.clear();
    expect(map.size).toBe(0);
  });

  it('treats a maxEntries below one as one', () => {
    const map = new BoundedTtlMap<number>({ maxEntries: 0, ttlMs: Infinity });
    map.set('a', 1);
    map.set('b', 2);
    expect(map.size).toBe(1);
    expect(map.get('b')).toBe(2);
  });
});
