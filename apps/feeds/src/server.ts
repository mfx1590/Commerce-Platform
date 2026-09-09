// The feed server: `GET /feeds/{store_code}/{feedId}.xml|csv` and `GET /health` on `$PORT` (#146).
//
// It does one thing — hand a channel's crawler the file the core published. It has no database connection, no
// catalogue access and no way to mutate anything, which is what lets it sit on a public URL with a crawler
// hitting it every few hours. Node's own `http` module is enough; no framework is pulled in for two routes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CONTENT_TYPE, FeedReader, parseFeedPath } from './storage.js';

export interface FeedServerOptions {
  dir: string;
  storeCodes?: readonly string[];
  /** Seconds a channel may cache the file. Feeds are regenerated on publish, not on a timer. */
  maxAge?: number;
}

const DEFAULT_MAX_AGE = 300;

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    // A feed URL is public but is not a page; nothing here should end up in a search index.
    'x-robots-tag': 'noindex',
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  // Deliberately identical for "no such feed", "feed not published yet" and "store not served by this
  // instance": a crawler has no business learning which feed ids exist.
  send(
    res,
    404,
    JSON.stringify({ code: 'not_found', message: 'feed not found' }),
    'application/json',
  );
}

export function createFeedHandler(
  options: FeedServerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const reader = new FeedReader(options);
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;

  return (req, res) => {
    void (async () => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          send(
            res,
            405,
            JSON.stringify({ code: 'not_found', message: 'method not allowed' }),
            'application/json',
          );
          return;
        }
        const url = new URL(req.url ?? '/', 'http://feeds.local');

        if (url.pathname === '/health') {
          send(res, 200, JSON.stringify({ status: 'ok' }), 'application/json');
          return;
        }

        const ref = parseFeedPath(url.pathname);
        if (!ref) {
          notFound(res);
          return;
        }

        const body = await reader.read(ref);
        if (body === null) {
          notFound(res);
          return;
        }

        res.writeHead(200, {
          'content-type': CONTENT_TYPE[ref.extension] ?? 'application/octet-stream',
          'content-length': Buffer.byteLength(body),
          'cache-control': `public, max-age=${maxAge}`,
          'x-robots-tag': 'noindex',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch (err) {
        console.error('[feeds] unhandled error:', err);
        if (!res.headersSent) {
          send(
            res,
            500,
            JSON.stringify({ code: 'internal', message: 'internal error' }),
            'application/json',
          );
        } else {
          res.end();
        }
      }
    })();
  };
}

export function createFeedServer(options: FeedServerOptions): Server {
  return createServer(createFeedHandler(options));
}

export interface FeedServerConfig extends FeedServerOptions {
  port: number;
}

/**
 * Configuration from the environment. `FEEDS_STORE_CODES` is the store-code allowlist this instance serves;
 * production refuses to start without it, the same shape as the core's `CORE_DEV_TOKENS` guard. An instance
 * that serves every code it happens to find on disk is fine on a laptop and is not fine on a public URL.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): FeedServerConfig {
  const dir = env.FEEDS_DIR ?? '.feeds';
  const storeCodes = (env.FEEDS_STORE_CODES ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  if (env.NODE_ENV === 'production' && storeCodes.length === 0) {
    throw new Error(
      'FEEDS_STORE_CODES must list the store codes this instance serves (refusing to serve every code found on disk in production)',
    );
  }
  return {
    dir,
    storeCodes,
    port: Number(env.PORT ?? 4020),
    ...(env.FEEDS_MAX_AGE ? { maxAge: Number(env.FEEDS_MAX_AGE) } : {}),
  };
}
