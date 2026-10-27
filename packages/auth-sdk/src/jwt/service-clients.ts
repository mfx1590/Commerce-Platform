// Guards for service-account clients (#565 / #622 read-only, #632 operation allowlist; manager decisions
// 2026-10-27).
//
// A service account's secret lives in ANOTHER app's environment (window 16's CRM sync, window 12's reconcile), so
// a leak must reach exactly the operations its job uses and nothing else:
//
// 1. READ-ONLY: every non-safe method (anything but GET / HEAD) is refused, whatever the OpenFGA tuples would
//    allow (`support` on a store also gates updateCustomer / createRefund / createReturn).
// 2. OPERATION ALLOWLIST (#632): org-level analyst / finance imply `viewer` on every store, so analytics-sync could
//    otherwise READ every store's orders, audit log and abandoned carts; crm-sync's `support` reaches more GETs
//    than the sync needs. Each client may call only the operations listed for it, per API.
//
// Both run in the token verifier, BEFORE any x-permission check. The lists are CODE constants, never configuration
// (an empty environment must not switch a guard off; the guards read private frozen copies, so mutating an
// exported value changes nothing). The client is identified from the VERIFIED token (`azp`; `client_id` as a
// fallback), never from anything the caller sends. Fail closed: a caller that does not say which method, which
// API and which operation the token is presented for is refused.
import { ApiError } from '../types.js';

/** The APIs whose operations service clients may be allowed: the core's Admin API and the Finance API. */
export type ServiceApi = 'admin' | 'finance';

const OPERATIONS: Readonly<Record<string, Readonly<Record<ServiceApi, readonly string[]>>>> =
  Object.freeze({
    'crm-sync': Object.freeze({
      admin: Object.freeze(['listCustomers', 'getCustomer']),
      finance: Object.freeze([] as string[]),
    }),
    'analytics-sync': Object.freeze({
      admin: Object.freeze(['getHqSalesReport', 'getHqFinanceReport']),
      finance: Object.freeze([
        'listJournalLines',
        'getTrialBalance',
        'listPayouts',
        'listParkedEvents',
      ]),
    }),
  });
const CLIENTS: readonly string[] = Object.freeze(Object.keys(OPERATIONS));

/** Service-account clients that may only READ. Adding a client here is a code change, reviewed like one. */
export const READ_ONLY_SERVICE_CLIENTS: ReadonlySet<string> = new Set(CLIENTS);

/** The operations each service client may call, per API (#632). A copy: the guard reads its own frozen list. */
export const SERVICE_CLIENT_OPERATIONS: Readonly<Record<string, Record<ServiceApi, string[]>>> =
  Object.fromEntries(
    Object.entries(OPERATIONS).map(([c, apis]) => [
      c,
      { admin: [...apis.admin], finance: [...apis.finance] },
    ]),
  );

/** HTTP methods that never change state. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** What a verifier needs to know about the request to apply the service-client guards. */
export interface StaffRequestContext {
  /** HTTP method of the request the token is presented with (undefined = unknown → refused for a service client). */
  method: string | undefined;
  /** The contract operationId the request addresses (resolved before routing in the core, #632). */
  operationId?: string | undefined;
  /** Which API the operationId belongs to. */
  api?: ServiceApi | undefined;
}

/** One refusal, as logged: client id, method, API and operation only — never a subject, an email or a token. */
export interface ServiceClientRefusal {
  event: 'service_client_write_refused' | 'service_client_operation_refused';
  client_id: string;
  method: string | null;
  api?: string | null;
  operation_id: string | null;
}

/** The read-only service client a verified token belongs to, or undefined for anyone else. */
export function readOnlyServiceClientOf(payload: Record<string, unknown>): string | undefined {
  for (const claim of ['azp', 'client_id']) {
    const v = payload[claim];
    if (typeof v === 'string' && CLIENTS.includes(v)) return v;
  }
  return undefined;
}

const defaultLog = (r: ServiceClientRefusal): void => {
  console.warn(JSON.stringify(r));
};

/**
 * Throws the 403 for a read-only service client presented with a non-safe method, or with no request method at
 * all. `details.reason = 'read_only_service_client'` tells this refusal apart from an x-permission 403
 * (`details: { relation, object }`).
 */
export function assertServiceClientMayCall(
  clientId: string,
  request: StaffRequestContext | undefined,
  log: (r: ServiceClientRefusal) => void = defaultLog,
): void {
  const method = request?.method?.toUpperCase() ?? null;
  if (method !== null && SAFE_METHODS.has(method)) return;
  const refusal: ServiceClientRefusal = {
    event: 'service_client_write_refused',
    client_id: clientId,
    method,
    operation_id: request?.operationId ?? null,
  };
  log(refusal);
  throw new ApiError(
    403,
    'forbidden',
    method === null
      ? 'service client token presented without a request method'
      : `service client ${clientId} is read-only`,
    {
      reason: 'read_only_service_client',
      client_id: clientId,
      method,
      operation_id: refusal.operation_id,
    },
  );
}

/** True when `clientId` may call `operationId` of `api` (#632). False for anything unknown. */
export function serviceClientMayCallOperation(
  clientId: string,
  api: string | undefined,
  operationId: string | undefined,
): boolean {
  if (!api || !operationId) return false;
  const apis = OPERATIONS[clientId];
  if (!apis || !Object.prototype.hasOwnProperty.call(apis, api)) return false;
  return apis[api as ServiceApi].includes(operationId);
}

/**
 * Throws the 403 for a service client whose request is not one of its allowed operations — including a request
 * whose API or operationId the caller did not resolve (fail closed). `details.reason =
 * 'service_client_operation_not_allowed'`.
 */
export function assertServiceClientOperation(
  clientId: string,
  request: StaffRequestContext | undefined,
  log: (r: ServiceClientRefusal) => void = defaultLog,
): void {
  if (serviceClientMayCallOperation(clientId, request?.api, request?.operationId)) return;
  const refusal: ServiceClientRefusal = {
    event: 'service_client_operation_refused',
    client_id: clientId,
    method: request?.method?.toUpperCase() ?? null,
    api: request?.api ?? null,
    operation_id: request?.operationId ?? null,
  };
  log(refusal);
  throw new ApiError(
    403,
    'forbidden',
    `service client ${clientId} may not call ${refusal.operation_id ?? 'an unresolved operation'}`,
    {
      reason: 'service_client_operation_not_allowed',
      client_id: clientId,
      api: refusal.api,
      operation_id: refusal.operation_id,
    },
  );
}
