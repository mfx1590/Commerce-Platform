/**
 * Store readiness (#830, #839; Admin API 0.4.29 `getStoreReadiness`): what activation would refuse now, and
 * whether the store can sell. The same check `activateStore` runs, without changing anything, plus the payment
 * methods the checkout can offer and the core's count of purchasable products.
 *
 * The type is the generated `StoreReadiness`. The body is still parsed (against that same shape, `satisfies`
 * keeps the two in step): a core that answers something else is a retry panel, never a wrong "ready".
 */
import { z } from 'zod';
import type { AdminComponents } from '../api/admin-client';

export const PAYMENT_METHODS = ['card', 'invoice'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const READINESS_WARNINGS = ['no_purchasable_product'] as const;

export type StoreReadiness = AdminComponents['StoreReadiness'];

const storeReadinessSchema = z.object({
  status: z.enum(['draft', 'active', 'paused', 'archived']),
  missing: z.array(z.string()),
  missing_tax_countries: z.array(z.string()),
  missing_shipping_countries: z.array(z.string()),
  payment_methods: z.array(z.enum(PAYMENT_METHODS)),
  purchasable_products: z.number().int().min(0),
  // The contract's enum: a warning it does not declare is a malformed answer (502), not a guess.
  warnings: z.array(z.enum(READINESS_WARNINGS)),
}) satisfies z.ZodType<StoreReadiness>;

/** The response body as a `StoreReadiness`, or null when it is not one. */
export function parseReadiness(body: unknown): StoreReadiness | null {
  const parsed = storeReadinessSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  card: 'Card',
  invoice: 'Pay on invoice',
};

export const WARNING_LABELS: Record<string, string> = {
  no_purchasable_product:
    "No product can be bought yet: none is published with a price in the store's currency and stock to sell.",
};

/** Whether a customer could complete an order right now. */
export function canSell(readiness: StoreReadiness): boolean {
  return (
    readiness.status === 'active' &&
    readiness.payment_methods.length > 0 &&
    readiness.purchasable_products > 0
  );
}

/** "1 product" / "3 products". */
export function productCount(count: number): string {
  return `${count} ${count === 1 ? 'product' : 'products'}`;
}
