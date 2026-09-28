import { describe, expect, it } from 'vitest';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  EMPTY_PROMOTION,
  describeValue,
  formatBp,
  fromPromotion,
  parsePercent,
  promotionFormSchema,
  toPromotionInput,
  toPromotionPatch,
  type PromotionFormValues,
} from '@/lib/promotions/form';
import { forPromotionRows } from '@/lib/promotions/projection';

type Promotion = AdminComponents['Promotion'];

const CATEGORY = '00000000-0000-4000-8000-000000000201';
const PRODUCT = '30000000-0000-4000-8000-000000000201';

const values = (overrides: Partial<PromotionFormValues>): PromotionFormValues => ({
  ...EMPTY_PROMOTION,
  name: 'Welcome',
  ...overrides,
});

describe('promotion form → contract body, per type', () => {
  it('percentage: the value is basis points, currency null, code upper-case or null', () => {
    const body = toPromotionInput(
      values({ code: 'WELCOME10', type: 'percentage', value_bp: 1000 }),
    );
    expect(body).toMatchObject({
      code: 'WELCOME10',
      type: 'percentage',
      value: 1000,
      currency: null,
    });
    expect(body.rules).toEqual({});
    expect(
      toPromotionInput(values({ code: '', type: 'percentage', value_bp: 1250 })).code,
    ).toBeNull();
  });

  it('fixed amount: the value is minor units in the given currency', () => {
    const body = toPromotionInput(
      values({ type: 'fixed_amount', value_minor: 500, currency: 'EUR' }),
    );
    expect(body).toMatchObject({ type: 'fixed_amount', value: 500, currency: 'EUR' });
  });

  it('free shipping: value 0, no currency; conditions still travel', () => {
    const body = toPromotionInput(
      values({ type: 'free_shipping', min_subtotal_minor: 5000, first_order_only: true }),
    );
    expect(body).toMatchObject({ type: 'free_shipping', value: 0, currency: null });
    expect(body.rules).toEqual({ min_subtotal_minor: 5000, first_order_only: true });
  });

  it('buy x get y: the quantities and the discount live in the rules', () => {
    const body = toPromotionInput(
      values({
        type: 'buy_x_get_y',
        buy_quantity: 2,
        get_quantity: 1,
        get_discount_bp: 5000,
        category_ids: `${CATEGORY}, ${CATEGORY}`,
        exclusive: true,
      }),
    );
    expect(body.value).toBe(0);
    expect(body.rules).toEqual({
      category_ids: [CATEGORY, CATEGORY],
      buy_quantity: 2,
      get_quantity: 1,
      get_discount_bp: 5000,
    });
    expect(body.exclusive).toBe(true);
    expect(body.stackable).toBe(false);
  });

  it('the patch never carries code or type (immutable in the contract)', () => {
    const patch = toPromotionPatch(values({ code: 'X', type: 'percentage', value_bp: 100 }));
    expect(patch).not.toHaveProperty('code');
    expect(patch).not.toHaveProperty('type');
    expect(patch.value).toBe(100);
  });

  it('dates: a datetime-local value becomes ISO, empty becomes null', () => {
    const patch = toPromotionPatch(
      values({ type: 'percentage', value_bp: 100, starts_at: '2026-10-01T09:00', ends_at: '' }),
    );
    expect(patch.starts_at).toMatch(/^2026-10-01T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(patch.ends_at).toBeNull();
  });
});

describe('promotion form validation (the type-dependent rules)', () => {
  const check = (overrides: Partial<PromotionFormValues>) =>
    promotionFormSchema.safeParse(values(overrides));

  it('demands the value that matches the type', () => {
    expect(check({ type: 'percentage', value_bp: null }).success).toBe(false);
    expect(check({ type: 'percentage', value_bp: 1000 }).success).toBe(true);
    expect(check({ type: 'fixed_amount', value_minor: 500, currency: '' }).success).toBe(false);
    expect(check({ type: 'fixed_amount', value_minor: 500, currency: 'EUR' }).success).toBe(true);
    expect(check({ type: 'buy_x_get_y', buy_quantity: 2, get_quantity: null }).success).toBe(false);
    expect(check({ type: 'free_shipping' }).success).toBe(true);
  });

  it('stackable and exclusive cannot both be set', () => {
    const result = check({ type: 'free_shipping', stackable: true, exclusive: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['exclusive']);
  });

  it('ids must be uuids, comma separated; the end must be after the start', () => {
    expect(check({ type: 'free_shipping', product_ids: `${PRODUCT}, nope` }).success).toBe(false);
    expect(check({ type: 'free_shipping', product_ids: ` ${PRODUCT} , ${PRODUCT}` }).success).toBe(
      true,
    );
    expect(
      check({ type: 'free_shipping', starts_at: '2026-10-02T00:00', ends_at: '2026-10-01T00:00' })
        .success,
    ).toBe(false);
  });

  it('codes are upper-case letters, digits, dash and underscore', () => {
    expect(check({ type: 'free_shipping', code: 'welcome' }).success).toBe(false);
    expect(check({ type: 'free_shipping', code: 'WELCOME_10-X' }).success).toBe(true);
  });
});

describe('reading a promotion back', () => {
  const promotion: Promotion = {
    id: '50000000-0000-4000-8000-000000000102',
    code: null,
    name: 'Buy 2 tees get 1 free',
    type: 'buy_x_get_y',
    value: 0,
    currency: null,
    rules: { category_ids: [CATEGORY], buy_quantity: 2, get_quantity: 1, get_discount_bp: 10000 },
    usage_limit: null,
    usage_count: 3,
    per_customer_limit: null,
    starts_at: null,
    ends_at: null,
    status: 'active',
    stackable: false,
    exclusive: true,
  };

  it('fromPromotion round-trips through the form values into the same patch', () => {
    const form = fromPromotion(promotion);
    expect(form).toMatchObject({
      code: '',
      type: 'buy_x_get_y',
      buy_quantity: 2,
      get_quantity: 1,
      category_ids: CATEGORY,
      exclusive: true,
    });
    expect(toPromotionPatch(form).rules).toEqual(promotion.rules);
  });

  it('describes the value per type without float noise', () => {
    expect(describeValue({ type: 'percentage', value: 1000, currency: null, rules: {} })).toBe(
      '10 %',
    );
    expect(describeValue({ type: 'percentage', value: 1250, currency: null, rules: {} })).toBe(
      '12.5 %',
    );
    expect(describeValue({ type: 'fixed_amount', value: 500, currency: 'EUR', rules: {} })).toBe(
      '€5.00',
    );
    expect(describeValue({ type: 'free_shipping', value: 0, currency: null, rules: {} })).toBe(
      'free shipping',
    );
    expect(describeValue(promotion)).toBe('buy 2 get 1 free');
    expect(
      describeValue({ ...promotion, rules: { ...promotion.rules, get_discount_bp: 5000 } }),
    ).toBe('buy 2 get 1 at 50 % off');
    expect(formatBp(1)).toBe('0.01');
    expect(formatBp(10000)).toBe('100');
  });

  it('parses a typed percentage into basis points, refusing anything else', () => {
    expect(parsePercent('10')).toBe(1000);
    expect(parsePercent('12.5')).toBe(1250);
    expect(parsePercent('0.01')).toBe(1);
    expect(parsePercent('100')).toBe(10000);
    expect(parsePercent('100.01')).toBeNull();
    expect(parsePercent('0')).toBeNull();
    expect(parsePercent('ten')).toBeNull();
    expect(parsePercent('12.345')).toBeNull();
  });

  it('the list row projection carries the described value and nothing it does not show', () => {
    const [row] = forPromotionRows([promotion], 'en-GB');
    expect(row).toMatchObject({ value_label: 'buy 2 get 1 free', status: 'active', code: null });
    expect(row).not.toHaveProperty('rules');
    expect(row).not.toHaveProperty('value');
  });
});
