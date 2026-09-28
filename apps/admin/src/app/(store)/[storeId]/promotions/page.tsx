import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel, EmptyPanel } from '@/components/states/state-panel';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getPromotionReport, getStore, listPromotions } from '@/lib/api/admin';
import { formatMoney } from '@/lib/forms/money';
import { findStore, type Principal } from '@/lib/nav/navigation';
import type { Relation } from '@/lib/nav/relations';
import { expandStoreRelations } from '@/lib/nav/relations';
import { loadPrincipal } from '@/lib/principal';
import { forPromotionRows } from '@/lib/promotions/projection';
import { parseTableQuery, toContractQuery } from '@/lib/table/query-state';
import { PromotionsTable } from './promotions-table';
import {
  PROMOTIONS_TABLE_DEFAULTS,
  PROMOTION_FILTER_KEYS,
  last30Days,
} from './promotions-table.config';

export const dynamic = 'force-dynamic';

/** `createPromotion` / `createPriceList` / `upsertPrices` are `store_admin`; the buttons follow. */
export function canManagePromotions(principal: Principal, storeId: string): boolean {
  const store = findStore(principal, storeId);
  return expandStoreRelations(
    (store?.relations ?? []) as Relation[],
    principal.organization_relations as Relation[],
  ).has('store_admin');
}

export default async function PromotionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { storeId } = await params;
  const raw = await searchParams;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') search.set(key, value);
  }
  const query = parseTableQuery(search, PROMOTION_FILTER_KEYS, PROMOTIONS_TABLE_DEFAULTS);
  const range = last30Days();

  // Four reads in parallel, each failing alone: the report is window 17's route and the core may
  // not serve it yet; the store only supplies the locale.
  const [promotions, report, store, principal] = await Promise.all([
    listPromotions(storeId, toContractQuery(query, { sortable: true })),
    getPromotionReport(storeId, range),
    getStore(storeId),
    loadPrincipal(),
  ]);
  const locale = store.ok ? store.data.default_locale : 'en-GB';
  const manage = principal.ok && canManagePromotions(principal.data, storeId);

  return (
    <StoreSectionGuard storeId={storeId} id="promotions">
      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Promotions"
            description="Codes and automatic discounts. Creating and editing needs store_admin; every change is re-checked on the server."
            action={
              <div className="flex items-center gap-2">
                <Link href={`/${storeId}/promotions/price-lists`}>
                  <Button size="sm" variant="secondary">
                    Price lists
                  </Button>
                </Link>
                {manage && (
                  <Link href={`/${storeId}/promotions/new`}>
                    <Button size="sm">New promotion</Button>
                  </Link>
                )}
              </div>
            }
          />
          <CardBody>
            <PromotionsTable
              storeId={storeId}
              rows={promotions.ok ? forPromotionRows(promotions.data.items, locale) : []}
              total={promotions.ok ? promotions.data.total : 0}
              query={query}
              emptyState={
                <EmptyPanel
                  title="No promotions yet"
                  description="A promotion is a code or an automatic discount with conditions and a schedule."
                  {...(manage
                    ? {
                        action: (
                          <Link href={`/${storeId}/promotions/new`}>
                            <Button>Create the first promotion</Button>
                          </Link>
                        ),
                      }
                    : {})}
                />
              }
              error={
                promotions.ok ? undefined : { status: promotions.status, error: promotions.error }
              }
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Usage, last 30 days"
            description="Per code: uses, discount given and the revenue of the orders that used it (marketing report)."
          />
          <CardBody>
            {!report.ok ? (
              <ApiStatePanel
                status={report.status}
                error={report.error}
                what="The usage report"
                storeId={storeId}
              />
            ) : report.data.items.length === 0 ? (
              <p className="text-muted text-sm">No promotion was used in this window.</p>
            ) : (
              <table className="w-full text-sm" aria-label="Promotion usage">
                <thead className="border-line border-b">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Code
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Uses
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Discount given
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Revenue
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {report.data.items.map((item) => (
                    <tr key={item.promotion_id}>
                      <td className="px-3 py-2">
                        <Link
                          href={`/${storeId}/promotions/${item.promotion_id}`}
                          className="text-accent font-mono text-xs hover:underline"
                        >
                          {item.code ?? 'automatic'}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{item.uses}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatMoney(
                          item.discount_given.amount_minor,
                          item.discount_given.currency,
                          locale,
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatMoney(item.revenue.amount_minor, item.revenue.currency, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
