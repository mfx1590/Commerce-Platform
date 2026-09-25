// The promotions report (`getPromotionReport`) — the route marketing owns over window 9's
// data provider. The numbers are theirs: `promotionReportData` reads coupon codes off `"order"` (non-cancelled,
// placed in [from, to)), through the promotions module's public API. This file only validates the window the same
// way the other two marketing reports do, so all three answer a bad window with the same 400.
import type { ScopedClient } from '@platform/db';
import type { AdminComponents } from '@platform/contracts';
import { validationError } from '../../lib/errors';
import { promotionReportData } from '../promotions';

export type PromotionReport = AdminComponents['schemas']['PromotionReport'];

export interface PromotionReportQuery {
  from?: string;
  to?: string;
}

function parseWindow(query: PromotionReportQuery): { from: Date; to: Date } {
  const problems: Record<string, string> = {};
  const from = Date.parse(query.from ?? '');
  const to = Date.parse(query.to ?? '');
  if (Number.isNaN(from)) problems.from = 'date-time (required)';
  if (Number.isNaN(to)) problems.to = 'date-time (required)';
  if (!Number.isNaN(from) && !Number.isNaN(to) && to <= from) problems.to = 'must be after from';
  if (Object.keys(problems).length) throw validationError('invalid report window', problems);
  return { from: new Date(from), to: new Date(to) };
}

/** Uses, discount given and revenue per promotion code in `[from, to)` — window 9's figures, marketing's route. */
export async function promotionReport(
  client: ScopedClient,
  storeId: string,
  query: PromotionReportQuery,
): Promise<PromotionReport> {
  const { from, to } = parseWindow(query);
  return promotionReportData(client, storeId, from, to);
}
