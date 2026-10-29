// Read-only guard for service-account clients (#565 / #622, manager decision 2026-10-27).
//
// A service account's secret lives in ANOTHER app's environment (window 16's CRM sync, window 12's reconcile), so
// a leak must not be able to write anything — not even what its OpenFGA tuples would allow: `support` on a store
// also gates updateCustomer / createRefund / createReturn, and a future over-broad tuple must not open a write
// either. So the token verifier itself refuses every non-safe method (anything but GET / HEAD) for a token whose
// authorised party is one of these clients, BEFORE any x-permission check runs.
//
// The set is a CODE constant, never configuration: an empty or missing environment must not switch the guard
// off. The client is identified from the VERIFIED token (`azp`, the client Keycloak issued it to; `client_id` as
// a fallback), never from anything the caller sends. A caller that does not tell the verifier the request method
// is refused too (fail closed): it cannot be trusted with a service token.
import { ApiError } from '../types.js';

/** The guard reads this private list; the exported set is a copy, so mutating it cannot widen the guard. */
const CLIENTS: readonly string[] = Object.freeze(['crm-sync', 'analytics-sync']);

/** Service-account clients that may only READ. Adding a client here is a code change, reviewed like one. */
export const READ_ONLY_SERVICE_CLIENTS: ReadonlySet<string> = new Set(CLIENTS);

/** HTTP methods that never change state. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** What a verifier needs to know about the request to apply the guard. */
export interface StaffRequestContext {
  /** HTTP method of the request the token is presented with. */
  method: string;
  /** The contract operationId, when the caller knows it — for the refusal log line. */
  operationId?: string;
}

/** One refusal, as logged: client id, method and operation only — never a subject, an email or a token. */
export interface ServiceClientRefusal {
  event: 'service_client_write_refused';
  client_id: string;
  method: string | null;
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
 * Throws the 403 for a read-only service client presented with a non-safe method, or with no request context at
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
