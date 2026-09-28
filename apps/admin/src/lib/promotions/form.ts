/**
 * The promotion form: its values, what they become on the wire, and how a promotion reads back.
 *
 * The contract's `value` is basis points for `percentage` and minor units for `fixed_amount`, and
 * means nothing for the other two types; `rules` carries the conditions and the buy-x-get-y
 * quantities; `code` and `type` are immutable after creation (`PromotionPatch` has neither). The
 * form keeps the fields people type (a percent, a money amount, comma-separated ids) and this
 * module maps them onto the contract shapes — pure, so the mapping is unit-tested per type and the
 * `MatchesContract` assertions fail the build if a field name drifts.
 */

import { z } from 'zod';
import type { AdminComponents } from '../api/admin-client';
import { formatMoney } from '../forms/money';
import type { MatchesContract } from '../forms/schemas';

type Promotion = AdminComponents['Promotion'];
type PromotionInput = AdminComponents['PromotionInput'];
type PromotionPatch = AdminComponents['PromotionPatch'];
type PromotionRules = AdminComponents['PromotionRules'];

export const PROMOTION_TYPES = [
  'percentage',
  'fixed_amount',
  'free_shipping',
  'buy_x_get_y',
] as const;
export const PROMOTION_STATUSES = ['active', 'draft', 'disabled'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/**
 * The generated `Promotion` type keeps `PromotionInput`'s optional fields (an `allOf` member's
 * `required` list does not narrow the other member), so a promotion read from the API types as
 * `value?`, `status?`, `starts_at?` … This is the one place those defaults are decided.
 */
export function readPromotion(promotion: Promotion): {
  value: number;
  currency: string | null;
  status: PromotionStatus;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  per_customer_limit: number | null;
  stackable: boolean;
  exclusive: boolean;
  rules: Partial<PromotionRules>;
} {
  return {
    value: promotion.value ?? 0,
    currency: promotion.currency ?? null,
    status: promotion.status ?? 'draft',
    starts_at: promotion.starts_at ?? null,
    ends_at: promotion.ends_at ?? null,
    usage_limit: promotion.usage_limit ?? null,
    per_customer_limit: promotion.per_customer_limit ?? null,
    stackable: promotion.stackable ?? false,
    exclusive: promotion.exclusive ?? false,
    rules: promotion.rules ?? {},
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "id, id, id" → ids; blanks dropped; every entry must be a uuid. */
const idList = z
  .string()
  .refine(
    (raw) => splitIds(raw).every((id) => UUID.test(id)),
    'Every id must be a uuid, separated by commas',
  );

export function splitIds(raw: string): string[] {
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

const optionalInt = (label: string) =>
  z.number().int(`${label}: whole numbers only`).min(0, `${label}: not negative`).nullable();

const optionalDateTime = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'Enter a date and time'),
  z.literal(''),
]);

/**
 * The form's values. `value_bp` and `value_minor` are the two faces of the contract's `value`;
 * only the one matching `type` is sent. Ids are typed as comma lists.
 */
export const promotionFormSchema = z
  .object({
    code: z
      .string()
      .max(40)
      .regex(/^[A-Z0-9_-]*$/, 'Upper-case letters, digits, - and _'),
    name: z.string().min(1, 'Enter a name'),
    type: z.enum(PROMOTION_TYPES),
    /** percentage: 0–100 with up to two decimals, kept as basis points. */
    value_bp: z.number().int().min(1).max(10000).nullable(),
    /** fixed_amount: minor units in `currency`. */
    value_minor: z.number().int().min(1).nullable(),
    currency: z.union([z.string().regex(/^[A-Z]{3}$/, 'Three-letter ISO code'), z.literal('')]),
    min_subtotal_minor: optionalInt('Minimum subtotal'),
    product_ids: idList,
    category_ids: idList,
    customer_group_ids: idList,
    sales_channel_ids: idList,
    first_order_only: z.boolean(),
    buy_quantity: z.number().int().min(1).nullable(),
    get_quantity: z.number().int().min(1).nullable(),
    get_discount_bp: z.number().int().min(1).max(10000).nullable(),
    usage_limit: optionalInt('Usage limit'),
    per_customer_limit: optionalInt('Per-customer limit'),
    starts_at: optionalDateTime,
    ends_at: optionalDateTime,
    status: z.enum(PROMOTION_STATUSES),
    stackable: z.boolean(),
    exclusive: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (values.type === 'percentage' && values.value_bp === null) {
      ctx.addIssue({ code: 'custom', path: ['value_bp'], message: 'Enter a percentage' });
    }
    if (values.type === 'fixed_amount') {
      if (values.value_minor === null) {
        ctx.addIssue({ code: 'custom', path: ['value_minor'], message: 'Enter an amount' });
      }
      if (values.currency === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['currency'],
          message: 'A fixed amount needs a currency',
        });
      }
    }
    if (values.type === 'buy_x_get_y') {
      if (values.buy_quantity === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['buy_quantity'],
          message: 'How many must be bought?',
        });
      }
      if (values.get_quantity === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['get_quantity'],
          message: 'How many are discounted?',
        });
      }
    }
    if (values.stackable && values.exclusive) {
      ctx.addIssue({
        code: 'custom',
        path: ['exclusive'],
        message: 'An exclusive promotion applies alone; it cannot also be stackable',
      });
    }
    if (values.starts_at !== '' && values.ends_at !== '' && values.ends_at <= values.starts_at) {
      ctx.addIssue({ code: 'custom', path: ['ends_at'], message: 'Ends before it starts' });
    }
  });

export type PromotionFormValues = z.infer<typeof promotionFormSchema>;

export const EMPTY_PROMOTION: PromotionFormValues = {
  code: '',
  name: '',
  type: 'percentage',
  value_bp: null,
  value_minor: null,
  currency: '',
  min_subtotal_minor: null,
  product_ids: '',
  category_ids: '',
  customer_group_ids: '',
  sales_channel_ids: '',
  first_order_only: false,
  buy_quantity: null,
  get_quantity: null,
  get_discount_bp: null,
  usage_limit: null,
  per_customer_limit: null,
  starts_at: '',
  ends_at: '',
  status: 'draft',
  stackable: false,
  exclusive: false,
};

/** A `datetime-local` value → ISO date-time; '' → null. */
export function toIsoOrNull(local: string): string | null {
  if (local === '') return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** ISO date-time → the `datetime-local` value (minutes precision, local time); null → ''. */
export function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The generated `PromotionRules` type marks `get_discount_bp` required because the spec gives it
 * a `default` — but the core refuses it on anything except buy_x_get_y ("buy/get rules only apply
 * to buy_x_get_y", found in the 2.4 real-core run). So it is sent for that type only, and the
 * object is cast once, here, with this comment as the reason.
 */
const FULL_DISCOUNT_BP = 10000;

function toRules(values: PromotionFormValues): PromotionRules {
  const rules: Partial<PromotionRules> = {};
  if (values.min_subtotal_minor !== null) rules.min_subtotal_minor = values.min_subtotal_minor;
  const lists = {
    product_ids: splitIds(values.product_ids),
    category_ids: splitIds(values.category_ids),
    customer_group_ids: splitIds(values.customer_group_ids),
    sales_channel_ids: splitIds(values.sales_channel_ids),
  };
  for (const [key, ids] of Object.entries(lists) as [keyof typeof lists, string[]][]) {
    if (ids.length > 0) rules[key] = ids;
  }
  if (values.first_order_only) rules.first_order_only = true;
  if (values.type === 'buy_x_get_y') {
    if (values.buy_quantity !== null) rules.buy_quantity = values.buy_quantity;
    if (values.get_quantity !== null) rules.get_quantity = values.get_quantity;
  }
  if (values.type === 'buy_x_get_y') {
    rules.get_discount_bp = values.get_discount_bp ?? FULL_DISCOUNT_BP;
  }
  return rules as PromotionRules;
}

/** The contract's `value` for the chosen type; 0 where the type has no value. */
export function toContractValue(values: PromotionFormValues): number {
  if (values.type === 'percentage') return values.value_bp ?? 0;
  if (values.type === 'fixed_amount') return values.value_minor ?? 0;
  return 0;
}

/** Everything `PromotionPatch` accepts — shared by create and update. */
export function toPromotionPatch(values: PromotionFormValues): PromotionPatch {
  return {
    name: values.name,
    value: toContractValue(values),
    currency: values.type === 'fixed_amount' && values.currency !== '' ? values.currency : null,
    rules: toRules(values),
    usage_limit: values.usage_limit,
    per_customer_limit: values.per_customer_limit,
    starts_at: toIsoOrNull(values.starts_at),
    ends_at: toIsoOrNull(values.ends_at),
    status: values.status,
    stackable: values.stackable,
    exclusive: values.exclusive,
  };
}

/** `PromotionInput` for create: the patch plus the two immutable fields. */
export function toPromotionInput(values: PromotionFormValues): PromotionInput {
  const patch = toPromotionPatch(values);
  return {
    ...patch,
    name: values.name,
    stackable: values.stackable,
    exclusive: values.exclusive,
    code: values.code === '' ? null : values.code,
    type: values.type,
  };
}

const _inputMatches: MatchesContract<ReturnType<typeof toPromotionInput>, PromotionInput> = true;
const _patchMatches: MatchesContract<ReturnType<typeof toPromotionPatch>, PromotionPatch> = true;
void _inputMatches;
void _patchMatches;

/** A promotion as read from the API → the form's values (for the edit screen). */
export function fromPromotion(promotion: Promotion): PromotionFormValues {
  const read = readPromotion(promotion);
  const rules = read.rules;
  return {
    code: promotion.code ?? '',
    name: promotion.name,
    type: promotion.type,
    value_bp: promotion.type === 'percentage' ? read.value : null,
    value_minor: promotion.type === 'fixed_amount' ? read.value : null,
    currency: read.currency ?? '',
    min_subtotal_minor: rules.min_subtotal_minor ?? null,
    product_ids: (rules.product_ids ?? []).join(', '),
    category_ids: (rules.category_ids ?? []).join(', '),
    customer_group_ids: (rules.customer_group_ids ?? []).join(', '),
    sales_channel_ids: (rules.sales_channel_ids ?? []).join(', '),
    first_order_only: rules.first_order_only === true,
    buy_quantity: rules.buy_quantity ?? null,
    get_quantity: rules.get_quantity ?? null,
    get_discount_bp:
      promotion.type === 'buy_x_get_y' ? (rules.get_discount_bp ?? FULL_DISCOUNT_BP) : null,
    usage_limit: read.usage_limit,
    per_customer_limit: read.per_customer_limit,
    starts_at: toLocalInput(read.starts_at),
    ends_at: toLocalInput(read.ends_at),
    status: read.status,
    stackable: read.stackable,
    exclusive: read.exclusive,
  };
}

/** "10 %", "€5.00", "free shipping", "buy 2 get 1 free" / "buy 2 get 1 at 50 % off". */
export function describeValue(
  promotion: {
    type: Promotion['type'];
    value?: number | undefined;
    currency?: string | null | undefined;
    rules?: Partial<PromotionRules> | undefined;
  },
  locale = 'en-GB',
): string {
  const value = promotion.value ?? 0;
  const currency = promotion.currency ?? null;
  switch (promotion.type) {
    case 'percentage':
      return `${formatBp(value)} %`;
    case 'fixed_amount':
      return currency === null ? `${value} (no currency)` : formatMoney(value, currency, locale);
    case 'free_shipping':
      return 'free shipping';
    case 'buy_x_get_y': {
      const rules: Partial<PromotionRules> = promotion.rules ?? {};
      const buy = rules.buy_quantity ?? '?';
      const get = rules.get_quantity ?? '?';
      const bp = rules.get_discount_bp ?? 10000;
      return bp >= 10000
        ? `buy ${buy} get ${get} free`
        : `buy ${buy} get ${get} at ${formatBp(bp)} % off`;
    }
    default:
      return promotion.type;
  }
}

/** Basis points → a percentage string without float noise: 1000 → "10", 1250 → "12.5". */
export function formatBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const rest = Math.abs(bp % 100);
  if (rest === 0) return String(whole);
  return `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`;
}

/** "10" / "12.5" (a typed percentage) → basis points, or null when it is not a valid percentage. */
export function parsePercent(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return bp >= 1 && bp <= 10000 ? bp : null;
}
