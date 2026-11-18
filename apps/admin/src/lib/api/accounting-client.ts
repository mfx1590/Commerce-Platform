/**
 * The Accounting API's typed client (#851): `openapi/accounting.yaml`, served by apps/accounting.
 * Every type comes from `@platform/contracts/accounting` (generated); nothing here is hand-typed.
 * The transport is the Admin API's (`jsonRequest`): same bearer, same `{ code, message, details }`.
 *
 * Kept free of `next/*` and `server-only` like `admin-client.ts`, so unit tests can drive it.
 */
import type { components, operations } from '@platform/contracts/accounting';
import { jsonRequest, type AdminRequestOptions, type ApiResult } from './admin-client';

export type AccountingComponents = components['schemas'];
export type AccountingOperation = keyof operations;

/** An operation's 200 JSON body (every accounting operation is a GET answering 200). */
export type AccountingResponse<K extends AccountingOperation> = operations[K] extends {
  responses: { 200: { content: { 'application/json': infer T } } };
}
  ? T
  : never;

/** An operation's query parameters, as the contract declares them. */
export type AccountingQuery<K extends AccountingOperation> = operations[K] extends {
  parameters: { query?: infer Q };
}
  ? NonNullable<Q>
  : never;

export type LegalEntityBooks = AccountingComponents['LegalEntityBooks'];
export type TrialBalance = AccountingComponents['TrialBalance'];
export type JournalLine = AccountingComponents['JournalLine'];
export type JournalLinePage = AccountingComponents['JournalLinePage'];

export async function accountingRequest<K extends AccountingOperation>(
  options: AdminRequestOptions,
): Promise<ApiResult<AccountingResponse<K>>> {
  return jsonRequest<AccountingResponse<K>>(options);
}
