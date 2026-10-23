/**
 * Rate limit per (rule, store): at most `max` alerts per `windowMs`, counted in a fixed window.
 *
 * IN MEMORY, on purpose and with a limit worth knowing: one process serves one organization (the
 * apps/notifications single-worker rule), so the window lives in this process and a restart forgets it — the
 * first alerts after a restart always go out. A second ops worker would rate-limit independently and a burst
 * could be announced twice. When that is ever needed the window moves to a table keyed (rule, store, bucket);
 * it is not needed for one worker, and a missed ops alert is worse than a duplicate one.
 *
 * A burst is never silent: the suppressed count rides on the next alert that does go out (`Alert.suppressed`),
 * so "5 more suppressed" appears in Slack instead of four alerts vanishing.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Alerts dropped for this key since the last allowed one — set on the allowed decision, then reset. */
  suppressed: number;
}

export interface RateLimitOptions {
  /** Alerts allowed per key per window. Must be >= 1. */
  max: number;
  windowMs: number;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
}

interface Bucket {
  windowStart: number;
  count: number;
  suppressed: number;
}

export interface RateLimiter {
  /** Call once per alert. `allowed: false` means: do not send, it is counted. */
  check(key: string): RateLimitDecision;
  /** Keys currently holding a window — diagnostics only. */
  size(): number;
}

/** `payment-failed:brand-a` — the key the limit is per. */
export function rateLimitKey(rule: string, storeCode: string): string {
  return `${rule}:${storeCode}`;
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  if (!Number.isInteger(opts.max) || opts.max < 1) {
    throw new Error(`rate limit: max must be an integer >= 1 (got ${opts.max})`);
  }
  if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
    throw new Error(`rate limit: windowMs must be > 0 (got ${opts.windowMs})`);
  }
  const now = opts.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  return {
    check(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b || t - b.windowStart >= opts.windowMs) {
        // A new window. Anything suppressed in the previous one is reported on this first alert.
        const suppressed = b?.suppressed ?? 0;
        b = { windowStart: t, count: 1, suppressed: 0 };
        buckets.set(key, b);
        return { allowed: true, suppressed };
      }
      if (b.count < opts.max) {
        b.count += 1;
        const suppressed = b.suppressed;
        b.suppressed = 0;
        return { allowed: true, suppressed };
      }
      b.suppressed += 1;
      return { allowed: false, suppressed: b.suppressed };
    },
    size() {
      return buckets.size;
    },
  };
}
