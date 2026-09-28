import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getStore, listPriceLists } from '@/lib/api/admin';
import { loadPrincipal } from '@/lib/principal';
import { forPriceListRows } from '@/lib/promotions/projection';
import { canManagePromotions } from '../page';
import { PRICE_LIST_TYPE_TONES, promotionTone } from '../promotions-table.config';
import { PriceListForm } from './price-list-form';

export const dynamic = 'force-dynamic';

function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

/**
 * Price lists (no paging in the contract). Creating one and editing prices need `store_admin`;
 * the contract has no update or delete of a list, so none is offered.
 */
export default async function PriceListsPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const [lists, store, principal] = await Promise.all([
    listPriceLists(storeId),
    getStore(storeId),
    loadPrincipal(),
  ]);
  const manage = principal.ok && canManagePromotions(principal.data, storeId);
  const rows = lists.ok ? forPriceListRows(lists.data.items) : [];

  return (
    <StoreSectionGuard storeId={storeId} id="promotions">
      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Price lists"
            description="Default, sale and override prices per currency, group, channel and period. Prices are edited per list."
            action={
              <Link href={`/${storeId}/promotions`} className="text-accent text-sm hover:underline">
                Promotions
              </Link>
            }
          />
          <CardBody>
            {!lists.ok ? (
              <ApiStatePanel
                status={lists.status}
                error={lists.error}
                what="Price lists"
                storeId={storeId}
              />
            ) : rows.length === 0 ? (
              <p className="text-muted text-sm">No price lists yet.</p>
            ) : (
              <table className="w-full text-sm" aria-label="Price lists">
                <thead className="border-line border-b">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Name
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Type
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Currency
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Period
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Priority
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {rows.map((list) => (
                    <tr key={list.id}>
                      <td className="px-3 py-2">
                        <Link
                          href={`/${storeId}/promotions/price-lists/${list.id}`}
                          className="text-accent hover:underline"
                        >
                          {list.name}
                        </Link>
                        <span className="text-muted ml-2 font-mono text-xs">{list.code}</span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={PRICE_LIST_TYPE_TONES[list.type] ?? 'neutral'}>
                          {list.type}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 font-mono">{list.currency}</td>
                      <td className="px-3 py-2">
                        <Badge tone={promotionTone(list.status ?? 'draft')}>
                          {list.status ?? 'draft'}
                        </Badge>
                      </td>
                      <td className="text-muted px-3 py-2 font-mono text-xs">
                        {formatDate(list.starts_at)} → {formatDate(list.ends_at)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{list.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>

        {manage && (
          <Card>
            <CardHeader
              title="New price list"
              description="Needs store_admin. A list's settings cannot be changed afterwards in this contract version."
            />
            <CardBody>
              <PriceListForm
                storeId={storeId}
                defaultCurrency={store.ok ? store.data.default_currency : 'EUR'}
              />
            </CardBody>
          </Card>
        )}
      </div>
    </StoreSectionGuard>
  );
}
