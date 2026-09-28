import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel, NotFoundPanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getStore, listPriceLists, listProducts } from '@/lib/api/admin';
import { editorRows } from '@/lib/pricing/editor';
import { loadPrincipal } from '@/lib/principal';
import { forPriceListRow } from '@/lib/promotions/projection';
import { canManagePromotions } from '../../page';
import { PRICE_LIST_TYPE_TONES, promotionTone } from '../../promotions-table.config';
import { PricesEditor } from './prices-editor';

export const dynamic = 'force-dynamic';

const PRODUCT_PAGE = 50;

/**
 * The prices editor for one list. The contract has no read of a list's prices and no single-list
 * read, so the list comes from `listPriceLists` and the current prices from the products'
 * variants (`variant.prices` by `price_list_id`). Products are searched with the catalog's `q`.
 */
export default async function PriceListEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string; priceListId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { storeId, priceListId } = await params;
  const raw = await searchParams;
  const q = typeof raw['q'] === 'string' ? raw['q'] : '';

  const [lists, products, store, principal] = await Promise.all([
    listPriceLists(storeId),
    listProducts(storeId, { page: 1, limit: PRODUCT_PAGE, ...(q === '' ? {} : { q }) }),
    getStore(storeId),
    loadPrincipal(),
  ]);

  if (!lists.ok) {
    return (
      <StoreSectionGuard storeId={storeId} id="promotions">
        <ApiStatePanel
          status={lists.status}
          error={lists.error}
          what="Price lists"
          storeId={storeId}
        />
      </StoreSectionGuard>
    );
  }
  const list = lists.data.items.find((item) => item.id === priceListId);
  if (list === undefined) {
    return (
      <StoreSectionGuard storeId={storeId} id="promotions">
        <NotFoundPanel
          what="This price list"
          storeId={storeId}
          backHref={`/${storeId}/promotions/price-lists`}
          backLabel="All price lists"
        />
      </StoreSectionGuard>
    );
  }

  const manage = principal.ok && canManagePromotions(principal.data, storeId);
  const locale = store.ok ? store.data.default_locale : 'en-GB';
  const rows = products.ok ? editorRows(products.data.items, priceListId) : [];

  return (
    <StoreSectionGuard storeId={storeId} id="promotions">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{list.name}</h1>
          <Badge tone={PRICE_LIST_TYPE_TONES[list.type] ?? 'neutral'}>{list.type}</Badge>
          <Badge tone={promotionTone(list.status ?? 'draft')}>{list.status ?? 'draft'}</Badge>
          <span className="text-muted font-mono text-xs">
            {list.code} · {list.currency}
          </span>
          <Link
            href={`/${storeId}/promotions/price-lists`}
            className="text-accent ml-auto text-sm hover:underline"
          >
            All price lists
          </Link>
        </div>

        <Card>
          <CardHeader
            title="Prices"
            description={
              manage
                ? 'One row per variant of the products found. Edit amounts and save; or paste a CSV, check the preview, and import the accepted rows. Whole minor units only.'
                : 'The prices this list holds for the products found. Editing needs store_admin.'
            }
          />
          <CardBody>
            {!products.ok ? (
              <ApiStatePanel
                status={products.status}
                error={products.error}
                what="Products"
                storeId={storeId}
              />
            ) : (
              <PricesEditor
                storeId={storeId}
                list={forPriceListRow(list)}
                locale={locale}
                rows={rows}
                query={q}
                total={products.data.total}
                pageSize={PRODUCT_PAGE}
                canEdit={manage}
              />
            )}
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
