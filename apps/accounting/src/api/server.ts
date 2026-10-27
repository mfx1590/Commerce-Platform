// The Finance read API handler (#551): routes come from the contract (spec.ts), every request is authenticated and
// its operation's `x-permission` authorised before any query runs, query parameters are validated against the
// operation's declared list, and answers are the contract's shapes with `{ code, message, details }` errors. Mounted
// next to /health by src/main.ts. Logs carry ids, status codes and operation ids — never a response body.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ScopedClient } from '@platform/db';
import { consoleLogger, errorClassOf, type Logger } from '../log.js';
import { ApiError, type FinanceAuth } from './auth.js';
import * as q from './queries.js';
import { loadApiSpec, matchRoute, type ApiSpec } from './spec.js';

export interface AccountingApiOptions {
  client: ScopedClient;
  auth: FinanceAuth;
  spec?: ApiSpec;
  log?: Logger;
}

export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const JOURNALS = ['sales', 'psp_fees', 'refunds', 'cogs', 'tax', 'shipping', 'bank'];
const REFERENCE_TYPES = ['order', 'payment', 'refund', 'shipment', 'payout'];
const PAYOUT_STATUS = ['imported', 'reconciled', 'discrepant'];

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Validates and types the query of an operation; unknown names and malformed values are a 400 naming the parameter. */
function readQuery(url: URL, allowed: string[]): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {};
  const details: Record<string, string> = {};
  for (const [name, raw] of url.searchParams) {
    if (!allowed.includes(name)) {
      details[name] = 'unknown parameter';
      continue;
    }
    const value = raw.trim();
    switch (name) {
      case 'page':
      case 'limit': {
        const nmb = Number(value);
        if (!Number.isInteger(nmb) || nmb < 1 || (name === 'limit' && nmb > 100))
          details[name] = 'must be an integer in range';
        else out[name] = nmb;
        break;
      }
      case 'from':
      case 'to':
        if (!DATE.test(value)) details[name] = 'must be YYYY-MM-DD';
        else out[name] = value;
        break;
      case 'currency':
        if (!CURRENCY.test(value)) details[name] = 'must be an ISO-4217 code';
        else out[name] = value;
        break;
      case 'journal':
        if (!JOURNALS.includes(value)) details[name] = `must be one of ${JOURNALS.join(', ')}`;
        else out[name] = value;
        break;
      case 'reference_type':
        if (!REFERENCE_TYPES.includes(value))
          details[name] = `must be one of ${REFERENCE_TYPES.join(', ')}`;
        else out[name] = value;
        break;
      case 'status':
        if (!PAYOUT_STATUS.includes(value))
          details[name] = `must be one of ${PAYOUT_STATUS.join(', ')}`;
        else out[name] = value;
        break;
      case 'erp':
        if (value !== 'posted' && value !== 'unposted')
          details[name] = 'must be posted or unposted';
        else out[name] = value;
        break;
      case 'reference_id':
      case 'source_event_id':
        if (!UUID.test(value)) details[name] = 'must be a uuid';
        else out[name] = value.toLowerCase();
        break;
      default:
        out[name] = value;
    }
  }
  if (Object.keys(details).length > 0)
    throw new ApiError(400, 'validation_error', 'Invalid query', details);
  return out;
}

export function createAccountingApi(options: AccountingApiOptions): ApiHandler {
  const spec = options.spec ?? loadApiSpec();
  const log = options.log ?? consoleLogger;

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://accounting.local');
    if (!url.pathname.startsWith('/accounting/')) return false;
    const started = Date.now();
    const match = matchRoute(spec, req.method ?? 'GET', url.pathname);
    let operationId = match?.operation.operationId ?? null;
    try {
      if (!match) throw new ApiError(404, 'not_found', 'No such operation');
      const principal = await options.auth.authenticate(req.headers.authorization, {
        // As is: a missing method fails closed in auth-sdk's service-client guards (#632).
        method: req.method,
        api: 'finance',
        operationId: match.operation.operationId,
      });
      await options.auth.authorize(principal, match.operation.permission);
      const query = readQuery(url, match.operation.queryParams);
      const page = {
        page: (query.page as number | undefined) ?? 1,
        limit: (query.limit as number | undefined) ?? 20,
      };
      const period = {
        ...(query.from ? { from: query.from as string } : {}),
        ...(query.to ? { to: query.to as string } : {}),
      };
      const legalEntityId = match.params.legalEntityId;
      const body = await options.client.transaction(async (tx) => {
        if (legalEntityId && !(await q.legalEntityExists(tx, legalEntityId)))
          throw new ApiError(404, 'not_found', 'Legal entity not found');
        switch (match.operation.operationId) {
          case 'listLegalEntityBooks':
            return { items: await q.listLegalEntityBooks(tx) };
          case 'getTrialBalance':
            return q.trialBalance(tx, legalEntityId!, {
              ...period,
              ...(query.currency ? { currency: query.currency as string } : {}),
            });
          case 'listJournalLines':
            return q.listJournalLines(tx, legalEntityId!, {
              ...period,
              ...page,
              ...(query.currency ? { currency: query.currency as string } : {}),
              ...(query.journal ? { journal: query.journal as string } : {}),
              ...(query.account_code ? { account_code: query.account_code as string } : {}),
              ...(query.reference_type ? { reference_type: query.reference_type as string } : {}),
              ...(query.reference_id ? { reference_id: query.reference_id as string } : {}),
              ...(query.source_event_id
                ? { source_event_id: query.source_event_id as string }
                : {}),
              ...(query.erp ? { erp: query.erp as 'posted' | 'unposted' } : {}),
            });
          case 'listParkedEvents':
            return q.listParkedEvents(tx, legalEntityId!, page);
          case 'listPayouts':
            return q.listPayouts(tx, legalEntityId!, {
              ...period,
              ...page,
              ...(query.status ? { status: query.status as string } : {}),
              ...(query.provider ? { provider: query.provider as string } : {}),
            });
          case 'getPayout': {
            const payout = await q.getPayout(tx, legalEntityId!, match.params.payoutId!, page);
            if (!payout) throw new ApiError(404, 'not_found', 'Payout not found');
            return payout;
          }
          case 'getErpSyncStatus': {
            const status = await q.erpSyncStatus(tx, legalEntityId!);
            if (!status) throw new ApiError(404, 'not_found', 'Legal entity not found');
            return status;
          }
          default:
            throw new ApiError(404, 'not_found', 'No such operation');
        }
      });
      send(res, 200, body);
      log.info({ event: 'api', operation: operationId, status: 200, ms: Date.now() - started });
    } catch (err) {
      operationId ??= 'none';
      if (err instanceof ApiError) {
        send(res, err.status, { code: err.code, message: err.message, details: err.details });
        log.info({
          event: 'api',
          operation: operationId,
          status: err.status,
          code: err.code,
          ms: Date.now() - started,
        });
      } else {
        send(res, 500, { code: 'internal', message: 'Internal error', details: {} });
        log.error({
          event: 'api_failed',
          operation: operationId,
          error_class: errorClassOf(err),
          ms: Date.now() - started,
        });
      }
    }
    return true;
  };
}
