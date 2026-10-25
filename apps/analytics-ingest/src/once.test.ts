import { describe, expect, it } from 'vitest';
import { idleState, waitForIdle } from './once.js';

const o = { startedAt: 0, idleMs: 5_000, minRunMs: 15_000, maxRunMs: 60_000 };

describe('the --once stopping rule', () => {
  it('never stops before minRunMs, even with nothing consumed (a fresh group is still joining)', () => {
    expect(idleState(o, null, 14_999)).toBe('running');
    expect(idleState(o, null, 15_000)).toBe('idle');
  });

  it('stops idleMs after the last batch', () => {
    expect(idleState(o, 20_000, 24_999)).toBe('running');
    expect(idleState(o, 20_000, 25_000)).toBe('idle');
  });

  it('stops at maxRunMs however busy the bus is', () => {
    expect(idleState(o, 59_999, 60_000)).toBe('max_run');
  });

  it('waitForIdle polls until the rule says stop', async () => {
    let t = 0;
    const last = 12_000;
    const outcome = await waitForIdle({
      ...o,
      lastBatchAt: () => (t >= last ? last : null), // a batch at 12 s: quiet from then, but not before minRunMs
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      pollMs: 1_000,
    });
    expect(outcome).toBe('idle');
    expect(t).toBe(17_000);
  });
});
