import { describe, expect, it } from 'vitest';
import { createBatcher, type RowSink } from './batcher.js';

function manualTimer() {
  let pending: (() => void) | null = null;
  return {
    setTimer: (fn: () => void) => {
      pending = fn;
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
    fire: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get armed() {
      return pending !== null;
    },
  };
}

function recordingSink() {
  const inserts: number[][] = [];
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const sink: RowSink<number> = {
    async insert(rows) {
      if (gate) await gate;
      inserts.push([...rows]);
    },
  };
  return {
    sink,
    inserts,
    hold() {
      gate = new Promise((r) => (release = r));
    },
    release() {
      gate = null;
      release?.();
    },
  };
}

const settled = async <T>(p: Promise<T>) => {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  p.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return state;
};

describe('batcher', () => {
  it('flushes when batchSize rows are waiting, across several callers', async () => {
    const t = manualTimer();
    const s = recordingSink();
    const b = createBatcher({ sink: s.sink, batchSize: 5, flushMs: 1_000, ...t });
    const a = b.add([1, 2]);
    expect(await settled(a)).toBe('pending');
    const c = b.add([3, 4, 5]);
    await Promise.all([a, c]);
    expect(s.inserts).toEqual([[1, 2, 3, 4, 5]]);
    expect(t.armed).toBe(false);
  });

  it('flushes after flushMs when the size is not reached', async () => {
    const t = manualTimer();
    const s = recordingSink();
    const b = createBatcher({ sink: s.sink, batchSize: 100, flushMs: 1_000, ...t });
    const a = b.add([1]);
    expect(t.armed).toBe(true);
    expect(await settled(a)).toBe('pending');
    t.fire();
    await a;
    expect(s.inserts).toEqual([[1]]);
  });

  it('resolves a caller only after the insert was acknowledged', async () => {
    const t = manualTimer();
    const s = recordingSink();
    s.hold();
    const b = createBatcher({ sink: s.sink, batchSize: 1, flushMs: 1_000, ...t });
    const a = b.add([1]);
    expect(await settled(a)).toBe('pending');
    s.release();
    await a;
    expect(s.inserts).toEqual([[1]]);
  });

  it('rejects every caller of a failed insert, and only those', async () => {
    const t = manualTimer();
    let fail = true;
    const got: number[][] = [];
    const sink: RowSink<number> = {
      async insert(rows) {
        if (fail) {
          fail = false;
          throw new Error('clickhouse down');
        }
        got.push([...rows]);
      },
    };
    const b = createBatcher({ sink, batchSize: 2, flushMs: 1_000, ...t });
    const a = b.add([1]);
    const c = b.add([2]);
    await expect(a).rejects.toThrow('clickhouse down');
    await expect(c).rejects.toThrow('clickhouse down');
    await b.add([3, 4]);
    expect(got).toEqual([[3, 4]]);
  });

  it('inserts buffers one after the other, in order', async () => {
    const t = manualTimer();
    const s = recordingSink();
    s.hold();
    const b = createBatcher({ sink: s.sink, batchSize: 1, flushMs: 1_000, ...t });
    const all = [b.add([1]), b.add([2]), b.add([3])];
    s.release();
    await Promise.all(all);
    expect(s.inserts).toEqual([[1], [2], [3]]);
  });

  it('flush() empties the buffer now (shutdown)', async () => {
    const t = manualTimer();
    const s = recordingSink();
    const b = createBatcher({ sink: s.sink, batchSize: 100, flushMs: 1_000, ...t });
    const a = b.add([1, 2]);
    expect(b.pending).toBe(2);
    await b.flush();
    await a;
    expect(s.inserts).toEqual([[1, 2]]);
    expect(b.pending).toBe(0);
  });
});
