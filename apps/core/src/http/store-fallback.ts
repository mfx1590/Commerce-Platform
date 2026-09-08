// Integration 1 Store API fallback (non-production only): every `/store/*` request that none of the core's real
// routes answered (src/http/store-routes.ts — GET /store, /store/categories, /store/products,
// /store/products/{handle}) is proxied verbatim to `CORE_STORE_API_FALLBACK_URL` (the Prism mock, :4010) with
// Node's global fetch, ahead of Medusa's own /store routes. Method, path + query, headers (X-Publishable-Key,
// Authorization, Idempotency-Key, Content-Type, …), body, and the upstream status, headers and body pass through
// unchanged; only hop-by-hop / framing headers are dropped. One log line per proxied request (method + path,
// never headers or bodies). Refused in production by mountCoreMiddleware.
import type { Request, RequestHandler } from 'express';
import { AppError } from '../lib/errors';

export const STORE_API_FALLBACK_ENV = 'CORE_STORE_API_FALLBACK_URL';

/** Never forwarded (RFC 9110 §7.6.1 hop-by-hop, plus what fetch/Express compute themselves). */
const DROP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'expect',
]);
/** fetch already decoded the body, so its framing/encoding headers must not be echoed. */
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
]);

function readRawBody(req: Request): Promise<Buffer> {
  // A body parser upstream (none on /store) would have consumed the stream; then `req.body` is what is left.
  if (req.body !== undefined && !req.readable) {
    return Promise.resolve(
      Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface StoreApiFallbackOptions {
  /** One line per proxied request; default `console.info`. */
  log?: (line: string) => void;
}

/** Express middleware for `/store`: proxies the request to `baseUrl` (no trailing slash needed). */
export function storeApiFallbackProxy(
  baseUrl: string,
  opts: StoreApiFallbackOptions = {},
): RequestHandler {
  const base = baseUrl.replace(/\/+$/, '');
  const log = opts.log ?? ((line: string) => console.info(line));
  return (req, res, next) => {
    const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
    // Only `/store/...` may leave through the proxy: a dot segment (`/store/../admin`) would otherwise reach
    // another path on the upstream. Non-production and a fixed target, but a proxy is a proxy.
    if (!path.startsWith('/store') || path.split('/').some((seg) => seg === '..' || seg === '.')) {
      next(new AppError('validation_error', 'invalid store api path', undefined, 400));
      return;
    }
    readRawBody(req)
      .then(async (raw) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined || DROP_REQUEST.has(name)) continue;
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const withBody = raw.length > 0 && req.method !== 'GET' && req.method !== 'HEAD';
        log(`[core] store api fallback → ${req.method} ${path}`);
        let upstream: Response;
        try {
          upstream = await fetch(base + req.originalUrl, {
            method: req.method,
            headers,
            ...(withBody ? { body: raw } : {}),
            redirect: 'manual',
          });
        } catch {
          throw new AppError(
            'internal',
            `store api fallback unreachable (${base})`,
            undefined,
            502,
          );
        }
        const body = Buffer.from(await upstream.arrayBuffer());
        res.status(upstream.status);
        upstream.headers.forEach((value, name) => {
          if (!DROP_RESPONSE.has(name)) res.setHeader(name, value);
        });
        res.end(body);
      })
      .catch(next);
  };
}
