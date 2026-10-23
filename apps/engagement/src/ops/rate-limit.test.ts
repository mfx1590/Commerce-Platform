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
