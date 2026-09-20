import { HqSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { formatMoney } from '@/lib/forms/money';
import { getMarketingDashboard, listSegmentTemplates } from './_api';

export const dynamic = 'force-dynamic';

/** The last 30 days, ending now — the same window the store Overview uses. */
function reportWindow(days = 30, now: Date = new Date()): { from: string; to: string } {
  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - days * 24 * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * HQ Marketing (#149): the cross-brand comparison and the shared segment templates.
 *
 * This is the **analyst's** marketing screen. The store section is gated on `store_staff` — authoring work an
 * analyst has no relation for — so an analyst's Overview is here, which is also where
 * docs/marketing-scope.md puts the cross-brand dashboard and the shared templates (manager decision
 * 2026-09-20, reading (a)).
 *
 * Each store is shown **in its own currency and never summed**: adding EUR to GBP would produce a number that
 * is wrong in every currency. The contract says the same thing — "one row per store, each in its own
 * currency (no FX in v0.3)".
 */
export default async function HqMarketingPage() {
  const window = reportWindow(30);
  const [dashboard, templates] = await Promise.all([
    getMarketingDashboard(window),
    listSegmentTemplates({ limit: 20 }),
  ]);

  return (
    <HqSectionGuard id="marketing">
      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Marketing by brand"
            description="Orders and revenue per store over the last 30 days, each in its own currency."
          />
          <CardBody>
            {!dashboard.ok ? (
              <ApiStatePanel
                status={dashboard.status}
                error={dashboard.error}
                what="marketing dashboard"
                hint="The cross-brand dashboard needs the analyst relation on the organization."
              />
            ) : dashboard.data.items.length === 0 ? (
              <p className="text-muted text-sm">No store reported any marketing activity yet.</p>
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">Marketing by store</caption>
                <thead className="text-muted text-xs uppercase">
                  <tr className="border-line border-b">
                    <th className="py-2 text-left font-medium">Store</th>
                    <th className="py-2 text-right font-medium">Orders</th>
                    <th className="py-2 text-right font-medium">Revenue</th>
                    <th className="py-2 text-left font-medium">Top campaign</th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {dashboard.data.items.map((row) => (
                    <tr key={row.store_id}>
                      <td className="py-2 font-mono text-xs">{row.store_code}</td>
                      <td className="py-2 text-right font-mono tabular-nums">{row.orders_count}</td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {formatMoney(row.revenue.amount_minor, row.revenue.currency)}
                      </td>
                      <td className="py-2 font-mono text-xs">
                        {row.top_campaign_id ?? <span className="text-muted">none</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-muted mt-3 text-xs">
              Every figure comes from attribution rows and orders in the core — never from a pixel
              or an ad platform&apos;s own count. Totals are deliberately absent: the stores do not
              share a currency.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Segment templates"
            description="Organization-level rule sets any brand can copy. Editing a template never changes a segment already created from it."
          />
          <CardBody>
            {!templates.ok ? (
              <ApiStatePanel
                status={templates.status}
                error={templates.error}
                what="segment templates"
              />
            ) : templates.data.items.length === 0 ? (
              <p className="text-muted text-sm">
                No templates yet. Creating one needs the owner relation on the organization.
              </p>
            ) : (
              <ul className="divide-line divide-y text-sm">
                {templates.data.items.map((template) => (
                  <li key={template.id} className="py-2">
                    <p className="font-medium">{template.name}</p>
                    <p className="text-muted text-xs">
                      {template.description ?? 'No description.'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </HqSectionGuard>
  );
}
