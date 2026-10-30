import { describe, expect, it } from 'vitest';
import { createRateLimiter, rateLimitKey } from './rate-limit.js';

/** A clock the test moves by hand: no timers, no flake. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('rate limit', () => {
  it('keys per rule AND per store, so one noisy store does not mute another', () => {
    expect(rateLimitKey('payment-failed', 'brand-a')).toBe('payment-failed:brand-a');
    const c = clock();
    const l = createRateLimiter({ max: 1, windowMs: 1000, now: c.now });

    expect(l.check(rateLimitKey('payment-failed', 'brand-a')).allowed).toBe(true);
    expect(l.check(rateLimitKey('payment-failed', 'brand-a')).allowed).toBe(false);
    // Same rule, other store: its own window.
    expect(l.check(rateLimitKey('payment-failed', 'brand-b')).allowed).toBe(true);
    // Other rule, same store: its own window.
    expect(l.check(rateLimitKey('refund-failed', 'brand-a')).allowed).toBe(true);
    expect(l.size()).toBe(3);
  });

  it('allows max per window and refuses the rest', () => {
    const c = clock();
    const l = createRateLimiter({ max: 3, windowMs: 60_000, now: c.now });
    expect([1, 2, 3].map(() => l.check('k').allowed)).toEqual([true, true, true]);
    expect(l.check('k').allowed).toBe(false);
    expect(l.check('k').allowed).toBe(false);
  });

  it('opens a new window after windowMs and reports what it dropped', () => {
    const c = clock();
    const l = createRateLimiter({ max: 1, windowMs: 1000, now: c.now });

    expect(l.check('k')).toEqual({ allowed: true, suppressed: 0 });
    expect(l.check('k')).toEqual({ allowed: false, suppressed: 1 });
    expect(l.check('k')).toEqual({ allowed: false, suppressed: 2 });

    c.advance(1000);
    // The first alert of the new window carries the burst's size: four dropped alerts are never silent.
    expect(l.check('k')).toEqual({ allowed: true, suppressed: 2 });
    // ...and the counter is reset for the new window.
    expect(l.check('k')).toEqual({ allowed: false, suppressed: 1 });
  });

  it('a window edge is exclusive-at-start: exactly windowMs later is a new window', () => {
    const c = clock();
    const l = createRateLimiter({ max: 1, windowMs: 1000, now: c.now });
    expect(l.check('k').allowed).toBe(true);
    c.advance(999);
    expect(l.check('k').allowed).toBe(false);
    c.advance(1);
    expect(l.check('k').allowed).toBe(true);
  });

  it('reports suppressed on the next allowed alert inside the same window too', () => {
    const c = clock();
    const l = createRateLimiter({ max: 2, windowMs: 10_000, now: c.now });
    expect(l.check('k')).toEqual({ allowed: true, suppressed: 0 });
    expect(l.check('k')).toEqual({ allowed: true, suppressed: 0 });
    expect(l.check('k')).toEqual({ allowed: false, suppressed: 1 });
    c.advance(10_000);
    expect(l.check('k')).toEqual({ allowed: true, suppressed: 1 });
  });

  it('refuses a configuration that would silence everything', () => {
    expect(() => createRateLimiter({ max: 0, windowMs: 1000 })).toThrow(/max must be an integer/);
    expect(() => createRateLimiter({ max: 1.5, windowMs: 1000 })).toThrow(/max must be an integer/);
    expect(() => createRateLimiter({ max: 1, windowMs: 0 })).toThrow(/windowMs must be > 0/);
  });

  it('defaults to the real clock when none is injected', () => {
    const l = createRateLimiter({ max: 1, windowMs: 60_000 });
    expect(l.check('k').allowed).toBe(true);
    expect(l.check('k').allowed).toBe(false);
  });
});

describe('flushSuppressed (#657)', () => {
  // Carrying the count to the next allowed alert is silent for a burst that ENDS: four suppressed failures
  // at 02:00 surface when the fifth happens, or never if the process restarts first.
  it('hands over the pending counts and clears them', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => 0 });
    const key = rateLimitKey('payment-failed', 'brand-a');
    expect(limiter.check(key).allowed).toBe(true);
    for (let i = 0; i < 4; i += 1) expect(limiter.check(key).allowed).toBe(false);

    expect(limiter.flushSuppressed()).toEqual([{ key, suppressed: 4 }]);
    // Cleared: a flush reports each suppression once, so a timer cannot repeat the same count every tick.
    expect(limiter.flushSuppressed()).toEqual([]);
  });

  it('reports nothing when nothing was suppressed', () => {
    const limiter = createRateLimiter({ max: 5, windowMs: 60_000, now: () => 0 });
    limiter.check(rateLimitKey('payment-failed', 'brand-a'));
    expect(limiter.flushSuppressed()).toEqual([]);
  });

  it('reports every key that has a pending count', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => 0 });
    for (const store of ['brand-a', 'brand-b']) {
      const key = rateLimitKey('payment-failed', store);
      limiter.check(key);
      limiter.check(key);
    }
    expect(limiter.flushSuppressed()).toEqual([
      { key: 'payment-failed:brand-a', suppressed: 1 },
      { key: 'payment-failed:brand-b', suppressed: 1 },
    ]);
  });

  it('does not double-report a count the next allowed alert would have carried', () => {
    // The two paths must not both report: after a flush, the next allowed alert carries 0.
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1_000, now: () => t });
    const key = rateLimitKey('payment-failed', 'brand-a');
    limiter.check(key);
    limiter.check(key);
    expect(limiter.flushSuppressed()).toEqual([{ key, suppressed: 1 }]);
    t = 2_000;
    expect(limiter.check(key)).toEqual({ allowed: true, suppressed: 0 });
  });
});
