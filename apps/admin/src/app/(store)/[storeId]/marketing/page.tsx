import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { formatMoney } from '@/lib/forms/money';
import { getAttributionReport, getPromotionReport } from './_api';
import { MarketingNav } from './section-nav';
import { reportWindow } from './_sections';

export const dynamic = 'force-dynamic';

/**
 * Marketing Overview (#149): revenue by channel and campaign, and the promotions behind it, over the last 30
 * days.
 *
 * **Every number here comes from `attribution` rows and orders** — the reports are computed server-side in
 * `apps/core/src/modules/marketing`, never from a pixel or an ad platform's own figure. That is the point of
 * the section, so the screen says it rather than leaving the reader to assume.
 *
 * Both reports are `viewer` on the store (the spec's "any relation" convention), so an HQ analyst reading
 * through sees the same numbers store staff do.
 */
export default async function MarketingOverviewPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const window = reportWindow(30);

  const [attribution, promotions] = await Promise.all([
    getAttributionReport(storeId, { ...window, touch: 'last' }),
    getPromotionReport(storeId, window),
  ]);

  return (
    <StoreSectionGuard storeId={storeId} id="marketing">
      <div className="space-y-4">
        <MarketingNav storeId={storeId} active="" />

        <Card>
          <CardHeader
            title="Revenue by channel"
            description="Last-touch attribution over the last 30 days, from orders — not from a pixel."
            action={<Badge tone="neutral">last touch</Badge>}
          />
          <CardBody>
            {!attribution.ok ? (
              <ApiStatePanel
                status={attribution.status}
                error={attribution.error}
                what="attribution report"
                storeId={storeId}
                hint="Reports need any relation on this store (viewer)."
              />
            ) : attribution.data.items.length === 0 ? (
              <p className="text-muted text-sm">
                No orders in the last 30 days, so there is nothing to attribute yet.
              </p>
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">Revenue by source, medium and campaign</caption>
                <thead className="text-muted text-xs uppercase">
                  <tr className="border-line border-b">
                    <th className="py-2 text-left font-medium">Source</th>
                    <th className="py-2 text-left font-medium">Medium</th>
                    <th className="py-2 text-left font-medium">Campaign</th>
                    <th className="py-2 text-right font-medium">Orders</th>
                    <th className="py-2 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {attribution.data.items.map((item, index) => (
                    <tr key={`${item.utm_source ?? 'none'}-${item.utm_medium ?? 'none'}-${index}`}>
                      <td className="py-2">{item.utm_source ?? '—'}</td>
                      <td className="py-2">{item.utm_medium ?? '—'}</td>
                      <td className="py-2">{item.utm_campaign ?? '—'}</td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {item.orders_count}
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {formatMoney(item.revenue.amount_minor, item.revenue.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-line border-t font-medium">
                    <td className="py-2" colSpan={3}>
                      Total
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {attribution.data.totals.orders_count}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {formatMoney(
                        attribution.data.totals.revenue.amount_minor,
                        attribution.data.totals.revenue.currency,
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Top promotions"
            description="Uses, discount given and the revenue of the orders that used each code."
          />
          <CardBody>
            {!promotions.ok ? (
              <ApiStatePanel
                status={promotions.status}
                error={promotions.error}
                what="promotion report"
                storeId={storeId}
              />
            ) : promotions.data.items.length === 0 ? (
              <p className="text-muted text-sm">No promotion was used in the last 30 days.</p>
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">Promotions by use</caption>
                <thead className="text-muted text-xs uppercase">
                  <tr className="border-line border-b">
                    <th className="py-2 text-left font-medium">Code</th>
                    <th className="py-2 text-right font-medium">Uses</th>
                    <th className="py-2 text-right font-medium">Discount given</th>
                    <th className="py-2 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {promotions.data.items.map((item) => (
                    <tr key={item.promotion_id}>
                      <td className="py-2 font-mono text-xs">{item.code ?? 'automatic'}</td>
                      <td className="py-2 text-right font-mono tabular-nums">{item.uses}</td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {formatMoney(
                          item.discount_given.amount_minor,
                          item.discount_given.currency,
                        )}
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {formatMoney(item.revenue.amount_minor, item.revenue.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>

        {/*
          The abandoned-cart recovery rate belongs on this page (#149) and is deliberately not here yet:
          `getAbandonedCartReport` is CONTRACT CHANGE #245 and is not in the frozen document, so there is no
          operationId to type against. It arrives with the contracts-v0.4.5 cleanup rather than being faked
          from an untyped fetch — a tile that might be wrong is worse than a tile that is missing.
        */}
      </div>
    </StoreSectionGuard>
  );
}
