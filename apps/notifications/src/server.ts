// The worker's HTTP face (#360): `GET /health` on `$PORT` (window 5's image contract) and the owner's preview,
// `GET /preview/{order-confirmation|shipment-shipped}?store=<code>&locale=<l>[&format=text]`, behind staff
// auth. The preview renders the sample data in templates/fixtures.ts — never a real order — so a staff user
// sees the brand's email without the route ever touching a customer. Node's own `http`, as in apps/feeds.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AuthError, type StaffAuth } from './auth.js';
import { applyLegalEntity } from './brands.js';
import type { RunReport, StoreTarget } from './consumer.js';
import { fixtureFor, pickLocale, render } from './templates/index.js';
import { isKind, isLocale, type BrandProfile, type Logger } from './types.js';

export interface HealthStatus {
  transport: string;
  stores: string[];
  last_run: RunReport | null;
}

export interface NotificationsServerOptions {
  auth: StaffAuth;
  brands: (storeCode: string) => BrandProfile | null;
  stores: readonly StoreTarget[];
  status: () => HealthStatus;
  log?: Logger;
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
    ...extra,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, JSON.stringify({ code, message }), 'application/json');
}

export function createNotificationsHandler(
  options: NotificationsServerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const log = options.log ?? console;

  return (req, res) => {
    void (async () => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'method_not_allowed', 'method not allowed');
          return;
        }
        const url = new URL(req.url ?? '/', 'http://notifications.local');

        if (url.pathname === '/health') {
          send(res, 200, JSON.stringify({ status: 'ok', ...options.status() }), 'application/json');
          return;
        }

        const preview = url.pathname.match(/^\/preview\/([a-z-]+)\/?$/);
        if (!preview) {
          sendError(res, 404, 'not_found', 'not found');
          return;
        }
        const kind = preview[1]!.replace(/-/g, '_');
        if (!isKind(kind)) {
          sendError(res, 404, 'not_found', 'unknown notification kind');
          return;
        }

        // Auth before anything that depends on the query: an unauthenticated caller learns nothing, not even
        // which store codes exist.
        try {
          await options.auth.authenticate(req.headers.authorization);
        } catch (err) {
          if (err instanceof AuthError) {
            send(
              res,
              err.status,
              JSON.stringify({ code: 'unauthorized', message: err.message }),
              'application/json',
              { 'www-authenticate': 'Bearer' },
            );
            return;
          }
          throw err;
        }

        const storeCode = url.searchParams.get('store') ?? '';
        const store = options.stores.find((s) => s.code === storeCode);
        const profile = store ? options.brands(store.code) : null;
        if (!store || !profile) {
          sendError(res, 404, 'not_found', 'unknown store (pass ?store=<code> of a served store)');
          return;
        }
        const requested = url.searchParams.get('locale');
        if (requested !== null && !isLocale(requested)) {
          sendError(res, 400, 'validation_error', `unsupported locale "${requested}"`);
          return;
        }
        const brand = applyLegalEntity(profile, store.legal);
        const locale =
          requested !== null ? requested : pickLocale(store.defaultLocale, brand.defaultLocale);
        const content = render(kind, fixtureFor(kind), { brand, locale, timeZone: store.timeZone });

        if (url.searchParams.get('format') === 'text') {
          send(
            res,
            200,
            `Subject: ${content.subject}\n\n${content.text}`,
            'text/plain; charset=utf-8',
          );
          return;
        }
        send(res, 200, content.html, 'text/html; charset=utf-8');
      } catch (err) {
        log.error(
          `notifications: unhandled request error: ${err instanceof Error ? err.name : 'error'}`,
        );
        if (!res.headersSent) sendError(res, 500, 'internal', 'internal error');
        else res.end();
      }
    })();
  };
}

export function createNotificationsServer(options: NotificationsServerOptions): Server {
  return createServer(createNotificationsHandler(options));
}
