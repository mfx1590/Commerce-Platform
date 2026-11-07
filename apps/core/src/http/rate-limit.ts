// Store API rate limits (#742, plan D4): a token bucket per (class, store, client) on the public write and
// auth-adjacent paths. Mounted on `/store` right after the tenant context (an unknown key is a 401 and costs no
// Redis call) and before the Store API routes (so before body parsing and customer-token verification). Over the
// limit: 429 `rate_limited` with `Retry-After` (store-api 0.5.10, CONTRACT CHANGE #744). FAIL-OPEN: when Redis does
// not answer, requests are allowed — availability over limits — with one warning per outage.
//
// Classes (defaults; env `CORE_RATE_LIMIT_<CLASS>=<burst>/<per-minute>`, `CORE_RATE_LIMIT=off` disables all):
//   auth      registerCustomer, recoverCart                                 10 burst, 20/min
//   cart      createCart, updateCart, add/update/removeLineItem,            60 burst, 300/min
//             createPaymentSession
//   checkout  completeCart                                                  10 burst, 60/min
// The client is the direct peer address, or — only with CORE_CLIENT_IP_HEADER set (a header our own proxy writes) —
// the address CORE_CLIENT_IP_HOPS entries from the right of that header (default 1: the entry the nearest proxy
// appended; the left-most entries are whatever the caller sent). IPv6 is bucketed by its /64. The client part of a
// Redis key is a sha256 prefix: no address is stored, logged or labelled.
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { Redis } from 'ioredis';
import { AppError } from '../lib/errors';
import { compileRouteMatcher } from '../telemetry';

export type RateLimitClass = 'auth' | 'cart' | 'checkout';

export interface BucketRule {
  /** Tokens when full: the burst a client may send at once. */
  burst: number;
  /** Refill rate. */
  perMinute: number;
}

export const DEFAULT_LIMITS: Readonly<Record<RateLimitClass, BucketRule>> = {
  auth: { burst: 10, perMinute: 20 },
  cart: { burst: 60, perMinute: 300 },
  checkout: { burst: 10, perMinute: 60 },
};

/** `<METHOD> <contract template>` → class. Exactly the operations store-api.yaml gives a 429 (pinned by a test). */
export const LIMITED_OPERATIONS: Readonly<Record<string, RateLimitClass>> = {
  'POST /store/customers': 'auth',
  'POST /store/cart-recovery/{token}': 'auth',
  'POST /store/carts': 'cart',
  'PATCH /store/carts/{cartId}': 'cart',
  'POST /store/carts/{cartId}/line-items': 'cart',
  'PATCH /store/carts/{cartId}/line-items/{lineItemId}': 'cart',
  'DELETE /store/carts/{cartId}/line-items/{lineItemId}': 'cart',
  'POST /store/carts/{cartId}/payment-session': 'cart',
  'POST /store/carts/{cartId}/complete': 'checkout',
};

export interface RateLimitConfig {
  limits: Readonly<Record<RateLimitClass, BucketRule>>;
  /** Lower-case header our own proxy sets with the client address; unset = the socket's peer address. */
  clientIpHeader?: string;
  clientIpHops: number;
}

export type TakeResult = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface RateLimitStore {
  /** Takes one token from `key`'s bucket. Never throws: a store that cannot answer allows (fail-open). */
  take(key: string, rule: BucketRule): Promise<TakeResult>;
  close?(): Promise<void>;
}

function parseRule(raw: string | undefined, fallback: BucketRule, name: string): BucketRule {
  if (raw === undefined || raw.trim() === '') return fallback;
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
  const burst = m ? Number(m[1]) : NaN;
  const perMinute = m ? Number(m[2]) : NaN;
  if (!(burst >= 1 && perMinute >= 1)) {
    console.warn(
      `[core] rate limit: ${name}=${raw} is not <burst>/<per-minute>; using the default`,
    );
    return fallback;
  }
  return { burst, perMinute };
}

/** From the environment; `null` when CORE_RATE_LIMIT=off. */
export function rateLimitConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig | null {
  if (env.CORE_RATE_LIMIT?.trim().toLowerCase() === 'off') return null;
  const limits = {} as Record<RateLimitClass, BucketRule>;
  for (const cls of Object.keys(DEFAULT_LIMITS) as RateLimitClass[]) {
    const name = `CORE_RATE_LIMIT_${cls.toUpperCase()}`;
    limits[cls] = parseRule(env[name], DEFAULT_LIMITS[cls], name);
  }
  const header = env.CORE_CLIENT_IP_HEADER?.trim().toLowerCase();
  const hops = Number(env.CORE_CLIENT_IP_HOPS ?? '1');
  return {
    limits,
    ...(header ? { clientIpHeader: header } : {}),
    clientIpHops: Number.isInteger(hops) && hops >= 1 ? hops : 1,
  };
}

/** `::ffff:1.2.3.4` → `1.2.3.4`; an IPv6 address → its /64 (the first four hextets). */
export function bucketAddress(address: string): string {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (v4mapped) return v4mapped[1]!;
  if (isIP(address) !== 6) return address;
  const [head, tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') && tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** The client a bucket belongs to: the trusted header's entry when configured and valid, else the peer address. */
export function clientAddress(
  req: Request,
  cfg: Pick<RateLimitConfig, 'clientIpHeader' | 'clientIpHops'>,
): string {
  if (cfg.clientIpHeader) {
    const raw = req.headers[cfg.clientIpHeader];
    const value = Array.isArray(raw) ? raw.join(',') : raw;
    const parts = (value ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const candidate = parts[parts.length - cfg.clientIpHops];
    if (candidate && isIP(candidate)) return bucketAddress(candidate);
  }
  return bucketAddress(req.socket?.remoteAddress ?? 'unknown');
}

const clientHash = (address: string) =>
  createHash('sha256').update(address).digest('hex').slice(0, 16);

export function rateLimitMiddleware(opts: {
  store: RateLimitStore;
  config: RateLimitConfig;
}): RequestHandler {
  const templates = [...new Set(Object.keys(LIMITED_OPERATIONS).map((k) => k.split(' ')[1]!))];
  const routes = compileRouteMatcher(templates);
  return (req, _res, next) => {
    const match = routes.match(req.baseUrl + req.path);
    const cls = match && LIMITED_OPERATIONS[`${req.method} ${match.template}`];
    const storeId = req.tenant?.storeId;
    if (!cls || !storeId) return next();
    const rule = opts.config.limits[cls];
    const key = `core:rl:${cls}:${storeId}:${clientHash(clientAddress(req, opts.config))}`;
    opts.store.take(key, rule).then(
      (r) => {
        if (r.allowed) return next();
        const seconds = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
        next(
          new AppError(
            'rate_limited',
            'Too many requests',
            { retry_after_seconds: seconds },
            undefined,
            { 'Retry-After': String(seconds) },
          ),
        );
      },
      () => next(), // a store never rejects; if one does, fail open
    );
  };
}

// Refill to now, then take one token, atomically, on Redis's own clock. Returns { allowed (1|0), wait ms }.
// The bucket hash expires once it would be full again, so idle clients cost nothing.
const TAKE_LUA = `
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end
if now > ts then
  tokens = math.min(burst, tokens + (now - ts) * rate)
  ts = now
end
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(ts))
redis.call('PEXPIRE', KEYS[1], math.ceil((burst - tokens) / rate) + 1000)
return { allowed, wait }
`;

type TakeCommand = (key: string, burst: number, perMs: number) => Promise<[number, number]>;

/**
 * The Redis store. Commands fail fast instead of queueing while Redis is away (no offline queue, 100 ms timeout,
 * no retries per request), and every failure allows the request: one warning when an outage starts, one line when
 * Redis answers again.
 */
export function redisRateLimitStore(
  opts: { url?: string; client?: Redis; commandTimeoutMs?: number } = {},
): RateLimitStore {
  const redis =
    opts.client ??
    new Redis(opts.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6381', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: opts.commandTimeoutMs ?? 100,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
  // Without a listener an 'error' event would crash the process; the outage is reported by take() below.
  redis.on('error', () => {});
  if (!opts.client) redis.connect().catch(() => {});
  redis.defineCommand('coreTakeToken', { numberOfKeys: 1, lua: TAKE_LUA });
  const takeToken = (redis as unknown as { coreTakeToken: TakeCommand }).coreTakeToken.bind(redis);
  let degraded = false;
  return {
    async take(key, rule) {
      try {
        const [allowed, wait] = await takeToken(key, rule.burst, rule.perMinute / 60_000);
        if (degraded) {
          degraded = false;
          console.info('[core] rate limit: Redis answers again; limits apply');
        }
        return allowed === 1 ? { allowed: true } : { allowed: false, retryAfterMs: Number(wait) };
      } catch (err) {
        if (!degraded) {
          degraded = true;
          console.warn(
            `[core] rate limit: Redis is not answering (${(err as Error).name}); requests are allowed until it is back`,
          );
        }
        return { allowed: true };
      }
    },
    async close() {
      if (!opts.client) redis.disconnect();
    },
  };
}
