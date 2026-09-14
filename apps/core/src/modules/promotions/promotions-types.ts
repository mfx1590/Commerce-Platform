// Promotion types and body validation (task 2.5, #138). The shapes follow Admin API 0.4.1 `PromotionInput` /
// `PromotionPatch` / `Promotion` (CONTRACT CHANGE #189: `buy_x_get_y`, `stackable`, `exclusive`, buy-X-get-Y
// rule numbers); the local ajv schemas mirror the spec and add the cross-field rules. Storage:
// `stackable`/`exclusive` and the buy-X-get-Y numbers live inside the `promotion.rules` jsonb column (#189,
// "jsonb" decision; the type CHECK is packages/db migration 0150).
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validationError } from '../../lib/errors';

export type PromotionType = 'percentage' | 'fixed_amount' | 'free_shipping' | 'buy_x_get_y';
export type PromotionStatus = 'active' | 'draft' | 'disabled';

export interface PromotionRules {
  min_subtotal_minor?: number;
  product_ids?: string[];
  category_ids?: string[];
  customer_group_ids?: string[];
  sales_channel_ids?: string[];
  first_order_only?: boolean;
  /** buy_x_get_y only. */
  buy_quantity?: number;
  get_quantity?: number;
  /** Discount on the "get" units in basis points; 10000 = free. */
  get_discount_bp?: number;
}

export interface PromotionInput {
  code?: string | null;
  name: string;
  type: PromotionType;
  /** Basis points for percentage, minor units for fixed_amount; unused for free_shipping / buy_x_get_y. */
  value?: number;
  currency?: string | null;
  rules?: PromotionRules;
  usage_limit?: number | null;
  per_customer_limit?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
  status?: PromotionStatus;
  stackable?: boolean;
  exclusive?: boolean;
}

export interface PromotionPatch {
  name?: string;
  value?: number;
  currency?: string | null;
  rules?: PromotionRules;
  usage_limit?: number | null;
  per_customer_limit?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
  status?: PromotionStatus;
  stackable?: boolean;
  exclusive?: boolean;
}

/** Contract `Promotion` (with the #189 additions). */
export interface Promotion {
  id: string;
  code: string | null;
  name: string;
  type: PromotionType;
  value: number;
  currency: string | null;
  rules: PromotionRules;
  usage_limit: number | null;
  usage_count: number;
  per_customer_limit: number | null;
  starts_at: string | null;
  ends_at: string | null;
  status: PromotionStatus;
  stackable: boolean;
  exclusive: boolean;
}

// ---- ajv (mirrors admin-api.yaml 0.4.1 PromotionInput / PromotionPatch) -----------------------------------

const uuid = { type: 'string', format: 'uuid' } as const;
const uuidList = { type: 'array', maxItems: 200, items: uuid } as const;
const RULES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    min_subtotal_minor: { type: 'integer', minimum: 0 },
    product_ids: uuidList,
    category_ids: uuidList,
    customer_group_ids: uuidList,
    sales_channel_ids: uuidList,
    first_order_only: { type: 'boolean' },
    buy_quantity: { type: 'integer', minimum: 1 },
    get_quantity: { type: 'integer', minimum: 1 },
    get_discount_bp: { type: 'integer', minimum: 1, maximum: 10000 },
  },
} as const;

const COMMON = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  value: { type: 'integer', minimum: 0 },
  currency: { type: ['string', 'null'], minLength: 3, maxLength: 3 },
  rules: RULES_SCHEMA,
  usage_limit: { type: ['integer', 'null'], minimum: 1 },
  per_customer_limit: { type: ['integer', 'null'], minimum: 1 },
  starts_at: { type: ['string', 'null'], format: 'date-time' },
  ends_at: { type: ['string', 'null'], format: 'date-time' },
  status: { type: 'string', enum: ['active', 'draft', 'disabled'] },
  stackable: { type: 'boolean' },
  exclusive: { type: 'boolean' },
} as const;

export const PROMOTION_INPUT_SCHEMA = {
  type: 'object',
  required: ['name', 'type'],
  additionalProperties: false,
  properties: {
    code: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
    type: {
      type: 'string',
      enum: ['percentage', 'fixed_amount', 'free_shipping', 'buy_x_get_y'],
    },
    ...COMMON,
  },
} as const;

export const PROMOTION_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...COMMON },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vInput = ajv.compile(PROMOTION_INPUT_SCHEMA);
const vPatch = ajv.compile(PROMOTION_PATCH_SCHEMA);

function problems(errors: ErrorObject[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors ?? []) out[e.instancePath || '/'] = e.message ?? 'invalid';
  return out;
}

/** Coupon codes compare case-insensitively: stored and matched upper-case, trimmed. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function crossField(x: PromotionInput | (PromotionPatch & { type: PromotionType })): void {
  const details: Record<string, string> = {};
  const rules = x.rules ?? {};
  if (x.type === 'percentage') {
    if (x.value === undefined || x.value < 1 || x.value > 10000)
      details['/value'] = 'percentage value is basis points 1..10000';
  }
  if (x.type === 'fixed_amount') {
    if (x.value === undefined || x.value < 1)
      details['/value'] = 'fixed_amount value is minor units >= 1';
    if (!x.currency) details['/currency'] = 'fixed_amount needs a currency';
  }
  if (x.type === 'buy_x_get_y') {
    if (!rules.buy_quantity) details['/rules/buy_quantity'] = 'required for buy_x_get_y';
    if (!rules.get_quantity) details['/rules/get_quantity'] = 'required for buy_x_get_y';
  } else if (rules.buy_quantity || rules.get_quantity || rules.get_discount_bp) {
    details['/rules/buy_quantity'] = 'buy/get rules only apply to buy_x_get_y';
  }
  if (x.starts_at && x.ends_at && new Date(x.ends_at) <= new Date(x.starts_at))
    details['/ends_at'] = 'must be after starts_at';
  if (x.stackable && x.exclusive)
    details['/exclusive'] = 'a promotion cannot be stackable and exclusive';
  if (Object.keys(details).length > 0) throw validationError('invalid promotion', details);
}

export function parsePromotionInput(body: unknown): PromotionInput {
  if (!vInput(body)) throw validationError('invalid promotion', problems(vInput.errors));
  const input = body as PromotionInput;
  crossField(input);
  return input.code ? { ...input, code: normalizeCode(input.code) } : input;
}

/** Patch validation needs the current type for the cross-field rules (type itself is immutable). */
export function parsePromotionPatch(body: unknown, current: Promotion): PromotionPatch {
  if (!vPatch(body)) throw validationError('invalid promotion patch', problems(vPatch.errors));
  const patch = body as PromotionPatch;
  if (Object.keys(patch).length === 0)
    throw validationError('empty promotion patch', { '/': 'nothing to change' });
  crossField({
    ...current,
    ...patch,
    rules: patch.rules ?? current.rules,
    type: current.type,
  });
  return patch;
}
