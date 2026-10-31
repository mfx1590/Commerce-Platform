// Per-store monthly token budget and per-minute rate limit (D8, #605).
// A call first RESERVES its worst case (estimated input + the template's maxTokens) and is refused, with nothing
// sent, when that would pass the month's budget or the minute's call count; afterwards it SETTLES to the real usage
// (a negative correction for an unused reservation; the whole reservation back after a failed call). Redis holds
// the counters so every process of every app shares them; one Lua script makes the check-and-reserve atomic.
import { Redis } from 'ioredis';
import { AiConfigError } from './errors.js';

export interface Limits {
  monthlyTokens: number;
  perMinute: number;
}

export type ReserveResult =
  | { ok: true; reservationTokens: number; usedTokens: number }
  | { ok: false; reason: 'over_budget'; usedTokens: number; limitTokens: number }
  | { ok: false; reason: 'rate_limited'; limitPerMinute: number };

export interface UsageLimiter {
  reserve(storeId: string, tokens: number, limits: Limits, now: Date): Promise<ReserveResult>;
  /** Adds `deltaTokens` (may be negative) to this month's usage of the store. */
  settle(storeId: string, deltaTokens: number, now: Date): Promise<void>;
  usedTokens(storeId: string, now: Date): Promise<number>;
}

/** Phase-5 defaults while gift credit is the only money (manager, 2026-10-31); production sets its own via env. */
export const DEFAULT_LIMITS: Limits = { monthlyTokens: 200_000, perMinute: 10 };

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new AiConfigError(`${name} must be a positive integer (got ${raw})`);
  return n;
}

/** `AI_MONTHLY_TOKEN_BUDGET` and `AI_RATE_LIMIT_PER_MINUTE`, per store; the defaults otherwise. */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
  return {
    monthlyTokens: positiveInt(env, 'AI_MONTHLY_TOKEN_BUDGET', DEFAULT_LIMITS.monthlyTokens),
    perMinute: positiveInt(env, 'AI_RATE_LIMIT_PER_MINUTE', DEFAULT_LIMITS.perMinute),
  };
}

export const monthKey = (now: Date) =>
  `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
export const minuteKey = (now: Date) => String(Math.floor(now.getTime() / 60_000));

/** In-process limiter: tests, and a single-process dev run without Redis. */
export function createMemoryLimiter(): UsageLimiter {
  const budget = new Map<string, number>();
  const rate = new Map<string, number>();
  const bKey = (s: string, now: Date) => `${s}:${monthKey(now)}`;
  return {
    async reserve(storeId, tokens, limits, now) {
      const rKey = `${storeId}:${minuteKey(now)}`;
      const calls = (rate.get(rKey) ?? 0) + 1;
      if (calls > limits.perMinute)
        return { ok: false, reason: 'rate_limited', limitPerMinute: limits.perMinute };
      const used = budget.get(bKey(storeId, now)) ?? 0;
      if (used + tokens > limits.monthlyTokens) {
        return {
          ok: false,
          reason: 'over_budget',
          usedTokens: used,
          limitTokens: limits.monthlyTokens,
        };
      }
      rate.set(rKey, calls);
      budget.set(bKey(storeId, now), used + tokens);
      return { ok: true, reservationTokens: tokens, usedTokens: used + tokens };
    },
    async settle(storeId, delta, now) {
      const k = bKey(storeId, now);
      budget.set(k, Math.max(0, (budget.get(k) ?? 0) + delta));
    },
    async usedTokens(storeId, now) {
      return budget.get(bKey(storeId, now)) ?? 0;
    },
  };
}

// KEYS[1] budget key, KEYS[2] rate key; ARGV: tokens, monthly limit, per-minute limit, budget ttl s, rate ttl s.
// Returns {1, used} | {-1, calls} (rate) | {-2, used} (budget). A refused call does not count against the minute.
const RESERVE_LUA = `
local calls = redis.call('INCR', KEYS[2])
if calls == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5])) end
if calls > tonumber(ARGV[3]) then
  redis.call('DECR', KEYS[2])
  return {-1, calls - 1}
end
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used + tonumber(ARGV[1]) > tonumber(ARGV[2]) then
  redis.call('DECR', KEYS[2])
  return {-2, used}
end
local total = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if total == tonumber(ARGV[1]) then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4])) end
return {1, total}
`;

// never below zero: a settle after a month rolled over lands on the new month's key
const SETTLE_LUA = `
local v = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if v < 0 then redis.call('SET', KEYS[1], 0, 'KEEPTTL') end
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
return v
`;

const BUDGET_TTL_S = 40 * 24 * 3600;
const RATE_TTL_S = 120;

export interface RedisLimiterOptions {
  /** Default: REDIS_URL, else redis://127.0.0.1:6381 (the compose stack's port on this machine). */
  url?: string;
  /** Key prefix (tests use a random one). Default `ai:`. */
  prefix?: string;
  client?: Redis;
}

export interface RedisLimiter extends UsageLimiter {
  close(): Promise<void>;
}

export function createRedisLimiter(opts: RedisLimiterOptions = {}): RedisLimiter {
  const redis =
    opts.client ??
    new Redis(opts.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6381', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
    });
  const prefix = opts.prefix ?? 'ai:';
  const bKey = (s: string, now: Date) => `${prefix}budget:${s}:${monthKey(now)}`;
  const rKey = (s: string, now: Date) => `${prefix}rate:${s}:${minuteKey(now)}`;
  return {
    async reserve(storeId, tokens, limits, now) {
      const [code, value] = (await redis.eval(
        RESERVE_LUA,
        2,
        bKey(storeId, now),
        rKey(storeId, now),
        tokens,
        limits.monthlyTokens,
        limits.perMinute,
        BUDGET_TTL_S,
        RATE_TTL_S,
      )) as [number, number];
      if (code === -1)
        return { ok: false, reason: 'rate_limited', limitPerMinute: limits.perMinute };
      if (code === -2) {
        return {
          ok: false,
          reason: 'over_budget',
          usedTokens: value,
          limitTokens: limits.monthlyTokens,
        };
      }
      return { ok: true, reservationTokens: tokens, usedTokens: value };
    },
    async settle(storeId, delta, now) {
      if (delta === 0) return;
      await redis.eval(SETTLE_LUA, 1, bKey(storeId, now), delta, BUDGET_TTL_S);
    },
    async usedTokens(storeId, now) {
      return Number((await redis.get(bKey(storeId, now))) ?? 0);
    },
    async close() {
      if (!opts.client) await redis.quit().catch(() => redis.disconnect());
    },
  };
}
