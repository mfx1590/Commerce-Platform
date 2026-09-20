import type { Queryable } from '@platform/db';
import type { StoreComponents } from '@platform/contracts';
import type { Actor } from '../../lib/audit';
import type { StoreOrder } from '../orders';

export type StoreShippingOption = StoreComponents['schemas']['ShippingOption'];
export type {
  PaymentProviderName,
  PaymentSessionStatus,
  StorePaymentSession,
} from '../../lib/payment-seam';
export type Address = StoreComponents['schemas']['Address'];
export type Money = StoreComponents['schemas']['Money'];

// The PaymentProvider seam (types, registry, manual provider) lives in src/lib/payment-seam.ts since 2.5 and is
// re-exported here unchanged: window 7 keeps importing it from '../checkout'.
export type {
  AuthorizeInput,
  AuthorizeResult,
  CreatePaymentSessionInput,
  PaymentCartRef,
  PaymentProvider,
  PaymentSessionResult,
  RefundInput,
  RefundResult,
  VoidInput,
  VoidResult,
} from '../../lib/payment-seam';

// ---- use-case inputs ----
// (the order read types moved to src/modules/orders in 2.3)

export interface CompleteCartInput {
  cartId: string;
  /** Contract header `Idempotency-Key` (min 8 chars, validated by the route). */
  idempotencyKey: string;
  actor: Actor;
  /** Test seams: run inside the placement transaction after the given step (a throw must roll everything back). */
  hooks?: {
    afterEvents?: ((tx: Queryable) => Promise<void>) | undefined;
  };
}

export interface CompleteCartResult {
  order: StoreOrder;
  /** True when the `Idempotency-Key` had already placed this cart: the stored order, no provider call. */
  replayed: boolean;
}
