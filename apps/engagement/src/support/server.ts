// The support HTTP server (#556) — the first one in this app.
//
// Node's own `http`, no framework: three routes, and a dependency this service would otherwise not have is a
// dependency to justify. The routes:
//
//   GET  /health                                   anyone   — liveness, no data
//   GET  /support/customers/:customerId/context    agent    — the context, shaped for a Chatwoot dashboard app
//   POST /webhooks/chatwoot                        Chatwoot — HMAC verified, nothing persisted
//
// The order of checks on the context route is deliberate: authenticate, THEN the store, THEN `support` on that
// store, THEN read. An unauthenticated caller is 401 before any query parameter is even parsed, so the API
// cannot be probed for which stores or customers exist.
//
// A 404 is also the answer for a customer of ANOTHER store, so the route cannot be used to discover that an id
// exists elsewhere in the organization.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { ScopedClient } from '@platform/db';
import type { AgentAuth } from './auth.js';
import { buildContext } from './context.js';
import type { ChatwootReceiver } from './chatwoot.js';
import type { SupportReader } from './admin-api.js';
import { SupportError } from './types.js';

export interface SupportLogLine {
  service: 'engagement';
  module: 'support';
  event: 'context' | 'webhook' | 'refused' | 'started' | 'stopped';
  route?: string;
  status?: number;
  code?: string;
  /** Ids only — never a name, an address or an e-mail. */
  customer_id?: string;
  store_code?: string;
  staff_user_id?: string;
  conversation_id?: string;
  orders?: number;
}

export interface SupportServerOptions {
  /** Organization-scoped client: the `staff_user` lookup and the store lookup only. */
  hq: ScopedClient;
  auth: AgentAuth;
  reader: SupportReader;
  chatwoot?: ChatwootReceiver;
  /** Max bytes of a webhook body. A webhook is small; anything larger is not one. */
  maxBodyBytes?: number;
  log?: (line: SupportLogLine) => void;
}

interface StoreRow {
  id: string;
  code: string;
  default_currency: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    // A support answer is personal data: never cached by a proxy or a browser.
    'cache-control': 'no-store',
  });
  res.end(text);
}

function fail(
  res: ServerResponse,
  err: unknown,
  log: SupportServerOptions['log'],
  route: string,
): void {
  const e =
    err instanceof SupportError
      ? err
      : new SupportError(500, 'internal_error', 'Something went wrong');
  log?.({
    service: 'engagement',
    module: 'support',
    event: 'refused',
    route,
    status: e.status,
    code: e.code,
  });
  // The message is ours, never an upstream body and never the error's stack.
  send(res, e.status, { code: e.code, message: e.message });
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new SupportError(413, 'payload_too_large', 'Body is too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new SupportError(400, 'bad_request', 'Body could not be read')));
  });
}

export function createSupportServer(opts: SupportServerOptions): Server {
  const maxBody = opts.maxBodyBytes ?? 64 * 1024;

  async function storeOf(ref: string): Promise<StoreRow> {
    // By id or by code, because a Chatwoot dashboard app is configured with a code and an admin link has an id.
    const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
    const r = await opts.hq.query<StoreRow>(
      `SELECT id, code, default_currency FROM store WHERE ${byId ? 'id = $1' : 'code = $1'}`,
      [ref],
    );
    const row = r.rows[0];
    if (!row) throw new SupportError(404, 'not_found', 'No such store');
    return row;
  }

  return createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/health') {
        send(res, 200, { status: 'ok', module: 'support' });
        return;
      }

      const context = /^\/support\/customers\/([^/]+)\/context$/.exec(path);
      if (context) {
        try {
          if (req.method !== 'GET') {
            throw new SupportError(405, 'method_not_allowed', 'Use GET');
          }
          // 1. WHO — before any parameter is read, so the route cannot be probed unauthenticated.
          const principal = await opts.auth.authenticate(req.headers.authorization);

          const storeRef = url.searchParams.get('store');
          if (!storeRef)
            throw new SupportError(400, 'bad_request', 'The `store` parameter is required');
          const store = await storeOf(storeRef);

          // 2. WHAT — `support` on this store, server-side, before a single read.
          await opts.auth.requireSupport(principal, store.id);

          const customerId = decodeURIComponent(context[1] as string);
          const built = await buildContext({
            reader: opts.reader,
            storeId: store.id,
            storeCode: store.code,
            defaultCurrency: store.default_currency,
            customerId,
            // 3. The agent's own header, so the core checks the agent too.
            authorization: principal.authorization,
          });

          opts.log?.({
            service: 'engagement',
            module: 'support',
            event: 'context',
            route: '/support/customers/:customerId/context',
            status: 200,
            customer_id: customerId,
            store_code: store.code,
            staff_user_id: principal.staffUserId,
            orders: built.orders.length,
          });
          send(res, 200, built);
        } catch (err) {
          fail(res, err, opts.log, '/support/customers/:customerId/context');
        }
        return;
      }

      if (path === '/webhooks/chatwoot') {
        try {
          if (req.method !== 'POST') throw new SupportError(405, 'method_not_allowed', 'Use POST');
          if (!opts.chatwoot) {
            throw new SupportError(503, 'unavailable', 'The Chatwoot webhook is not configured');
          }
          const body = await readBody(req, maxBody);
          const signature =
            (req.headers['x-chatwoot-signature'] as string | undefined) ??
            (req.headers['x-hub-signature-256'] as string | undefined);
          const link = opts.chatwoot.receive(body, signature);

          opts.log?.({
            service: 'engagement',
            module: 'support',
            event: 'webhook',
            route: '/webhooks/chatwoot',
            status: 202,
            conversation_id: link.conversationId,
          });
          // 202, not 200: it is accepted and deliberately acted on by nobody. See chatwoot.ts for the limit.
          send(res, 202, {
            accepted: true,
            conversation_id: link.conversationId,
            event: link.event,
            // The hash, never the address.
            email_hash: link.emailHash,
            persisted: false,
            note: 'Stub: the link is not stored and no customer lookup is made (no agent token here).',
          });
        } catch (err) {
          fail(res, err, opts.log, '/webhooks/chatwoot');
        }
        return;
      }

      send(res, 404, { code: 'not_found', message: 'No such route' });
    })();
  });
}
