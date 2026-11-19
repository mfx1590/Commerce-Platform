/**
 * Store readiness (#830, #839; Admin API 0.4.29 `getStoreReadiness`): what activation would refuse now, and
 * whether the store can sell. The same check `activateStore` runs, without changing anything, plus the payment
 * methods the checkout can offer and the core's count of purchasable products.
 *
 * The type is the generated `StoreReadiness`. The body is still parsed (against that same shape, `satisfies`
 * keeps the two in step): a core that answers something else is a retry panel, never a wrong "ready".
 *
 * #910: one exception. A warning the contract does not declare yet is not a malformed answer. Before, it was a
 * 502 that hid the whole box, including what is missing. Now it is kept aside in `other_warnings` and shown
 * generically.
 */
import { z } from 'zod';
import type { AdminComponents } from '../api/admin-client';
import { MISSING_LABELS } from '../onboarding';

export const PAYMENT_METHODS = ['card', 'invoice'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const READINESS_WARNINGS = ['no_purchasable_product'] as const;

/**
 * The generated shape, plus the warnings the contract does not declare yet (#910). Present only when
 * there are some, so a contract-shaped answer parses to itself.
 */
export type StoreReadiness = AdminComponents['StoreReadiness'] & { other_warnings?: string[] };

const KNOWN_WARNINGS: ReadonlySet<string> = new Set(READINESS_WARNINGS);
const isKnownWarning = (w: string): w is (typeof READINESS_WARNINGS)[number] =>
  KNOWN_WARNINGS.has(w);

/** The contract's shape, pinned to the generated type. */
const contractSchema = z.object({
  status: z.enum(['draft', 'active', 'paused', 'archived']),
  missing: z.array(z.string()),
  missing_tax_countries: z.array(z.string()),
  missing_shipping_countries: z.array(z.string()),
  payment_methods: z.array(z.enum(PAYMENT_METHODS)),
  purchasable_products: z.number().int().min(0),
  warnings: z.array(z.enum(READINESS_WARNINGS)),
}) satisfies z.ZodType<AdminComponents['StoreReadiness']>;

/** What is parsed: the same, except that `warnings` takes any string and splits known from unknown. */
const storeReadinessSchema = contractSchema
  .extend({ warnings: z.array(z.string()) })
  .transform(({ warnings, ...rest }): StoreReadiness => {
    const other = warnings.filter((w) => !isKnownWarning(w));
    return {
      ...rest,
      warnings: warnings.filter(isKnownWarning),
      ...(other.length > 0 ? { other_warnings: other } : {}),
    };
  });

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

/**
 * Whether a customer could complete an order right now. #910: `missing` counts too. An ACTIVE store that
 * later lost its tax rate, shipping option or payment method cannot sell, whatever its status says.
 */
export function canSell(readiness: StoreReadiness): boolean {
  return (
    readiness.status === 'active' &&
    readiness.missing.length === 0 &&
    readiness.payment_methods.length > 0 &&
    readiness.purchasable_products > 0
  );
}

/**
 * The missing prerequisites in words, with the countries when the core named them:
 * "a tax rate for DE, AT". An item this admin does not know is kept as it came.
 */
export function missingLabels(readiness: StoreReadiness): string[] {
  return readiness.missing.map((item) =>
    item === 'tax_rates' && readiness.missing_tax_countries.length > 0
      ? `a tax rate for ${readiness.missing_tax_countries.join(', ')}`
      : item === 'shipping_options' && readiness.missing_shipping_countries.length > 0
        ? `a shipping option for ${readiness.missing_shipping_countries.join(', ')}`
        : (MISSING_LABELS[item] ?? item),
  );
}

/** "1 product" / "3 products". */
export function productCount(count: number): string {
  return `${count} ${count === 1 ? 'product' : 'products'}`;
}
