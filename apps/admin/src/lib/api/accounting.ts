/**
 * HQ › Finance's reads (#851): the Accounting API's operations, each behind the same server-side
 * check the service makes — `finance` on `organization:hq` (owner implies it). A principal without
 * it gets the contract's 403 here, before any request leaves the admin; the service checks again
 * (OpenFGA). The section guard in the nav is a convenience, this is the admin's gate.
 *
 * The bearer is the session's staff-realm access token, the same one the Admin API gets: the
 * accounting service verifies it with auth-sdk's default audience (`core-api`).
 */
import 'server-only';

import { getSession } from '../auth/current-session';
import { env } from '../env';
import { FINANCE_RULE } from '../finance';
import { holds } from '../permissions/rules';
import { loadPrincipal } from '../principal';
import { buildPath, type ApiResult, type QueryValue } from './admin-client';
import {
  accountingRequest,
  type AccountingOperation,
  type AccountingQuery,
  type AccountingResponse,
} from './accounting-client';

/** The refusal a principal without `finance` gets, in the contract's 403 shape. */
export const FINANCE_REFUSAL = {
  ok: false as const,
  status: 403,
  error: {
    code: 'forbidden',
    message: 'requires finance on organization:hq',
    details: { relation: 'finance', object: 'organization:hq' },
  },
};

/** No accounting URL in this environment (production without `ACCOUNTING_API_URL`). */
export const NOT_CONFIGURED = {
  ok: false as const,
  status: 503,
  error: {
    code: 'not_configured',
    message: 'The accounting service is not configured for this admin (ACCOUNTING_API_URL).',
  },
};

async function financeCall<K extends AccountingOperation>(
  path: string,
  query?: Record<string, QueryValue>,
): Promise<ApiResult<AccountingResponse<K>>> {
  const principal = await loadPrincipal();
  if (!principal.ok) return { ok: false, status: principal.status, error: principal.error };
  if (!holds(principal.data, FINANCE_RULE, '')) return FINANCE_REFUSAL;
  const baseUrl = env.accountingApiUrl;
  if (baseUrl === null) return NOT_CONFIGURED;
  const session = await getSession();
  return accountingRequest<K>({ baseUrl, path, query, accessToken: session?.accessToken });
}

/** Query values as the transport takes them (only what the contract declares is ever passed). */
function q<K extends AccountingOperation>(query: AccountingQuery<K>): Record<string, QueryValue> {
  return query as Record<string, QueryValue>;
}

export function listLegalEntityBooks() {
  return financeCall<'listLegalEntityBooks'>('/accounting/v1/legal-entities');
}

export function getTrialBalance(legalEntityId: string, query: AccountingQuery<'getTrialBalance'>) {
  return financeCall<'getTrialBalance'>(
    buildPath('/accounting/v1/legal-entities/{legalEntityId}/trial-balance', { legalEntityId }),
    q<'getTrialBalance'>(query),
  );
}

export function listJournalLines(
  legalEntityId: string,
  query: AccountingQuery<'listJournalLines'>,
) {
  return financeCall<'listJournalLines'>(
    buildPath('/accounting/v1/legal-entities/{legalEntityId}/journal-lines', { legalEntityId }),
    q<'listJournalLines'>(query),
  );
}
