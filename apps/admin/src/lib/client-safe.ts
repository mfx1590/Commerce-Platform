/**
 * The one way a contract record reaches a `'use client'` component.
 *
 * Next.js serialises a client component's props wholesale into the Flight payload: a panel that
 * reads two fields of an `Order` still ships the customer's email and addresses to the browser
 * if it is handed the `Order`. So client components never take contract records — they take a
 * **projection**: an object built here with exactly the keys the component renders, stamped with
 * a nominal brand that nothing else can produce. A prop typed `ClientSafe<…>` therefore does not
 * accept the record itself, and the compiler enforces the rule at write time.
 *
 * `test/client-props-guard.test.ts` is the second guard: it fails the suite if any `'use client'`
 * file under `src/app/(store)` or `src/app/(hq)` names a PII-bearing contract record at all.
 *
 * Reviews #263 and #268 each found one instance of the leak; both are the reason this exists.
 */

import type { AdminComponents } from './api/admin-client';

declare const clientSafe: unique symbol;

/** A nominal marker: only `makeProjection` produces values of a `ClientSafe` type. */
export type ClientSafe<T> = T & { readonly [clientSafe]: true };

/**
 * Builds a projection by *explicit key picks* — the second argument lists the keys, so a projection
 * can only ever contain what was named, never what the record happened to carry.
 */
export function makeProjection<T extends object, K extends keyof T>(
  record: T,
  keys: readonly K[],
): ClientSafe<Pick<T, K>> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = record[key];
  return out as ClientSafe<Pick<T, K>>;
}

/** The contract records that carry PII — the same list `test/client-props-guard.test.ts` polices. */
type PiiRecord = AdminComponents['Customer' | 'Order' | 'OrderSummary' | 'StaffUser' | 'Address'];

type HoldsRecord<V> = V extends PiiRecord
  ? true
  : V extends readonly (infer Item)[]
    ? HoldsRecord<Item>
    : false;

/** `T` itself, or `never` when `T` is a PII record or has a field (or list) holding one. */
type RecordFree<T> =
  true extends HoldsRecord<T>
    ? never
    : true extends { [K in keyof T]-?: HoldsRecord<T[K]> }[keyof T]
      ? never
      : T;

/**
 * For projections whose fields are computed rather than picked (a consent summary, a label).
 *
 * The escape hatch is narrowed, not open: a PII record, or an object with a field or list holding
 * one, does not typecheck here (`test/client-safe.test.ts`). What remains — a hand-built object
 * of scalars — is audited at the call site: every caller lives in a `projection.ts` next to its
 * test that pins the key set and the wire JSON.
 */
export function markClientSafe<T extends object>(value: T & RecordFree<T>): ClientSafe<T> {
  return value as unknown as ClientSafe<T>;
}
