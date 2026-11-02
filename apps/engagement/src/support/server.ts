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
import { buildReplyDraft, draftErrorFor, type DraftGateway } from './reply-draft.js';
import type { ChatwootReceiver } from './chatwoot.js';
import type { SupportReader } from './admin-api.js';
import { SupportError } from './types.js';

export interface SupportLogLine {
  service: 'engagement';
  module: 'support';
  event: 'context' | 'draft' | 'webhook' | 'refused' | 'started' | 'stopped';
  route?: string;
  status?: number;
  code?: string;
  /** Ids only — never a name, an address or an e-mail. */
  customer_id?: string;
  store_code?: string;
  staff_user_id?: string;
  conversation_id?: string;
  orders?: number;
  /** The template a draft was asked for (#610). NEVER the question and never the draft text. */
  template?: string;
  /** The order the draft was about, as the customer sees it (`display_id`), never the uuid. */
  order_ref?: string;
  model?: string;
}

export interface SupportServerOptions {
  /** Organization-scoped client: the `staff_user` lookup and the store lookup only. */
  hq: ScopedClient;
  auth: AgentAuth;
  reader: SupportReader;
  chatwoot?: ChatwootReceiver;
  /**
   * AI reply drafts (#610). Both or neither: without a gateway factory the route cannot draft, and without
   * the switch it would not know which stores may. Absent = the feature is not mounted at all, which is how
   * a deployment that has no AI key behaves.
   */
  draft?: {
    /** `config.support.aiDraftsFor` — ON by default per store (owner 2026-11-01). */
    enabledFor(storeCode: string): boolean;
    /**
     * Whether drafting can actually WORK in this process (#674 review): `AI_ENABLED=1`, an API key present,
     * and the template published. The per-store switch says "this store may"; this says "and it would". The
     * capability flag on the context answer is the AND of the two, so a dashboard does not offer a button
     * that is certain to answer 503.
     */
    ready(): boolean;
    /**
     * One gateway per request, because the budget, the rate limit and the audit row are per STORE and the
     * audit's actor is the agent who asked.
     */
    gatewayFor(storeId: string, actorId: string): DraftGateway;
    brandVoice: string;
    defaultLocale: string;
  };
  /** Max bytes of a webhook body. A webhook is small; anything larger is not one. */
  maxBodyBytes?: number;
  log?: (line: SupportLogLine) => void;
}

interface StoreRow {
  id: string;
  code: string;
  default_currency: string;
}

/**
 * Every id that reaches a path is validated as a uuid BEFORE any call is made (#573 review). Two reasons, and
 * the second is the important one:
 *   * a non-uuid cannot be one of our customers, so 404 is the honest answer and a round trip to the core is
 *     wasted work;
 *   * a path segment is not a place for unvalidated caller input. `%2F..%2F` decodes to `/../`, and an id that
 *     reached the reader unvalidated could climb out of the resource and hit another Admin API route WITH THE
 *     AGENT'S OWN TOKEN. The reader also encodes every segment, so this is the first of two lines rather than
 *     the only one.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, what: string): string {
  // 404, not 400: "that is not a customer of this store" is the same answer whether the id is malformed or
  // simply not here, and the two must not be distinguishable.
  if (!UUID.test(value)) throw new SupportError(404, 'not_found', `No such ${what}`);
  return value;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    // A support answer is personal data: never cached by a proxy or a browser.
    'cache-control': 'no-store',
    ...extraHeaders,
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
    err instanceof SupportError ? err : new SupportError(500, 'internal', 'Something went wrong');
  log?.({
    service: 'engagement',
    module: 'support',
    event: 'refused',
    route,
    status: e.status,
    code: e.code,
  });
  // The message is ours, never an upstream body and never the error's stack. `details` is ours too — a
  // refusal category, a reason class — and `Retry-After` is the contract's shape for a rate limit (#610).
  const headers =
    e.retryAfterSeconds === undefined ? {} : { 'retry-after': String(e.retryAfterSeconds) };
  send(
    res,
    e.status,
    { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
    headers,
  );
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
    req.on('error', () =>
      reject(new SupportError(400, 'validation_error', 'Body could not be read')),
    );
  });
}

export function createSupportServer(opts: SupportServerOptions): Server {
  const maxBody = opts.maxBodyBytes ?? 64 * 1024;

  async function storeOf(ref: string): Promise<StoreRow> {
    // By id or by code, because a Chatwoot dashboard app is configured with a code and an admin link has an id.
    // The value only ever reaches a parameterised query, never a path or a string-built SQL fragment.
    //
    // KNOWN LIMIT (#573 review): this lookup runs BEFORE the permission check, so an authenticated staff user
    // who is not support for any store can still learn which store codes exist, by the difference between 404
    // (no such store) and 403 (not yours). Narrowing that would mean checking a permission against a store we
    // have not resolved yet, or answering 403 for an unknown store and so lying to an operator debugging a
    // typo. It is recorded rather than fixed: the caller is already an active staff user of this
    // organization, for whom the store list is not a secret.
    const byId = UUID.test(ref);
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
            throw new SupportError(400, 'validation_error', 'The `store` parameter is required');
          const store = await storeOf(storeRef);

          // 2. WHAT — `support` on this store, server-side, before a single read.
          await opts.auth.requireSupport(principal, store.id);

          // Decode once, then validate: the pattern below is what reaches the reader.
          const customerId = requireUuid(decodeURIComponent(context[1] as string), 'customer');
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
          // The capability: the store's switch AND whether drafting could work at all (#674 review) — a
          // flag that is true while every draft would answer 503 is worse than no flag.
          const canDraft =
            opts.draft !== undefined && opts.draft.enabledFor(store.code) && opts.draft.ready();
          send(res, 200, { ...built, ai_drafts: canDraft });
        } catch (err) {
          fail(res, err, opts.log, '/support/customers/:customerId/context');
        }
        return;
      }

      const draftRoute = /^\/support\/customers\/([^/]+)\/reply-draft$/.exec(path);
      if (draftRoute) {
        try {
          if (req.method !== 'POST') throw new SupportError(405, 'method_not_allowed', 'Use POST');
          // The SAME gates, in the same order, as the context route: who, then the store, then `support` on
          // that store, then anything else. A draft is the same data by another name.
          const principal = await opts.auth.authenticate(req.headers.authorization);
          const storeRef = url.searchParams.get('store');
          if (!storeRef)
            throw new SupportError(400, 'validation_error', 'The `store` parameter is required');
          const store = await storeOf(storeRef);
          await opts.auth.requireSupport(principal, store.id);

          // THE SWITCH, BEFORE ANY SUPPORT DATA IS READ (#610): while a store is off, nothing about a
          // customer is fetched, let alone sent to the gateway. 404 rather than 403 — whether a store has the
          // feature is not an agent's business, and a dashboard reads `ai_drafts` on the context instead.
          if (!opts.draft || !opts.draft.enabledFor(store.code)) {
            throw new SupportError(404, 'not_found', 'No such route for this store');
          }

          const customerId = requireUuid(decodeURIComponent(draftRoute[1] as string), 'customer');

          // THE GATEWAY FIRST, inside the mapped path (#674 review). It used to be resolved as an argument
          // to `buildReplyDraft`, which meant a missing API key read the customer's whole order history and
          // THEN answered 500 with no audit row. Nothing about a customer is touched until the thing that
          // would send it is known to exist.
          let gateway: DraftGateway;
          try {
            gateway = opts.draft.gatewayFor(store.id, principal.staffUserId);
          } catch (err) {
            throw draftErrorFor(err);
          }

          const raw = await readBody(req, maxBody);
          let body: { question?: unknown; orderId?: unknown; locale?: unknown };
          try {
            body = JSON.parse(raw || '{}') as typeof body;
          } catch {
            throw new SupportError(400, 'validation_error', 'The body must be JSON');
          }
          if (typeof body.question !== 'string') {
            throw new SupportError(400, 'validation_error', '`question` must be a string');
          }
          const orderId =
            typeof body.orderId === 'string' ? requireUuid(body.orderId, 'order') : undefined;
          // A BCP-47 SHAPE, and short (#674 review). It reaches the model as a tag value and `Intl` as a
          // currency locale, so a long or odd string is either a prompt nobody meant to write or an `Intl`
          // throw. The shape is checked, not the registry: `xx-YY` that nobody speaks is the agent's
          // business, 400 characters of prose is ours.
          const locale = ((): string => {
            if (typeof body.locale !== 'string' || !body.locale.trim()) {
              return opts.draft!.defaultLocale;
            }
            const value = body.locale.trim();
            if (value.length > 35 || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(value)) {
              throw new SupportError(
                400,
                'validation_error',
                '`locale` must be a BCP-47 language tag of at most 35 characters',
              );
            }
            return value;
          })();

          const context = await buildContext({
            reader: opts.reader,
            storeId: store.id,
            storeCode: store.code,
            defaultCurrency: store.default_currency,
            customerId,
            authorization: principal.authorization,
          });

          const draft = await buildReplyDraft({
            gateway,
            context,
            question: body.question,
            orderId,
            locale,
            brandVoice: opts.draft.brandVoice,
          });

          opts.log?.({
            service: 'engagement',
            module: 'support',
            event: 'draft',
            route: '/support/customers/:customerId/reply-draft',
            status: 200,
            customer_id: customerId,
            store_code: store.code,
            staff_user_id: principal.staffUserId,
            template: draft.template,
            order_ref: draft.orderRef,
            model: draft.model,
          });
          // No `accepted`, no id: there is nothing to follow up, because nothing was sent anywhere.
          send(res, 200, draft);
        } catch (err) {
          fail(res, err, opts.log, '/support/customers/:customerId/reply-draft');
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

      // Through `fail()` like every other refusal (#695 review): it was the one answer with no log line,
      // and a typed code. `route: 'unknown'` rather than the requested path — a path is caller input and
      // could carry an address or an e-mail into a log line, which is the one thing these lines never do.
      fail(res, new SupportError(404, 'not_found', 'No such route'), opts.log, 'unknown');
    })();
  });
}
