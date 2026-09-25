/**
 * Promotions and price lists carry no personal data, but the rule is the rule (`client-safe.ts`):
 * a client component takes a projection with exactly the keys it renders. These are the rows of
 * the promotions table and the shape the promotion form edits.
 */

import type { AdminComponents } from '../api/admin-client';
import { makeProjection, markClientSafe, type ClientSafe } from '../client-safe';
import { describeValue, readPromotion, type PromotionStatus } from './form';

type Promotion = AdminComponents['Promotion'];
type PriceList = AdminComponents['PriceList'];

export type PromotionRow = ClientSafe<{
  id: string;
  code: string | null;
  name: string;
  type: Promotion['type'];
  /** Precomputed: "10 %", "€5.00", "free shipping", "buy 2 get 1 free". */
  value_label: string;
  status: PromotionStatus;
  starts_at: string | null;
  ends_at: string | null;
  usage_count: number;
  usage_limit: number | null;
  stackable: boolean;
  exclusive: boolean;
}>;

export function forPromotionRow(promotion: Promotion, locale: string): PromotionRow {
  const read = readPromotion(promotion);
  return markClientSafe({
    id: promotion.id,
    code: promotion.code ?? null,
    name: promotion.name,
    type: promotion.type,
    value_label: describeValue(promotion, locale),
    status: read.status,
    starts_at: read.starts_at,
    ends_at: read.ends_at,
    usage_count: promotion.usage_count,
    usage_limit: read.usage_limit,
    stackable: read.stackable,
    exclusive: read.exclusive,
  });
}

export const forPromotionRows = (
  promotions: readonly Promotion[],
  locale: string,
): PromotionRow[] => promotions.map((promotion) => forPromotionRow(promotion, locale));

/** A price list as the list and the editor header show it. */
export type PriceListRow = ClientSafe<
  Pick<
    PriceList,
    | 'id'
    | 'code'
    | 'name'
    | 'type'
    | 'currency'
    | 'status'
    | 'priority'
    | 'starts_at'
    | 'ends_at'
    | 'customer_group_id'
    | 'sales_channel_id'
  >
>;

export const forPriceListRow = (list: PriceList): PriceListRow =>
  makeProjection(list, [
    'id',
    'code',
    'name',
    'type',
    'currency',
    'status',
    'priority',
    'starts_at',
    'ends_at',
    'customer_group_id',
    'sales_channel_id',
  ]);

export const forPriceListRows = (lists: readonly PriceList[]): PriceListRow[] =>
  lists.map(forPriceListRow);
