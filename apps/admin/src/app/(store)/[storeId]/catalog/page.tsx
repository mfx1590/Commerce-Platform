import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listProducts } from '@/lib/api/admin';
import { parseTableQuery, toContractQuery } from '@/lib/table/query-state';
import { ProductsTable } from './products-table';
import { PRODUCTS_TABLE_DEFAULTS, PRODUCT_FILTER_KEYS } from './products-table.config';
import { StatusFilter } from './status-filter';

export const dynamic = 'force-dynamic';

/** The catalog list: `listProducts` with the contract's own filters and sort. */
export default async function CatalogPage({
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

  const query = parseTableQuery(search, PRODUCT_FILTER_KEYS, PRODUCTS_TABLE_DEFAULTS);
  const result = await listProducts(storeId, toContractQuery(query, { sortable: true }));

  return (
    <StoreSectionGuard storeId={storeId} id="catalog">
      <Card>
        <CardHeader
          title="Catalog"
          description="Products in this store. Editing needs store_staff."
          action={
            <div className="flex items-center gap-2">
              <Link href={`/${storeId}/catalog/categories`}>
                <Button size="sm" variant="secondary">
                  Categories
                </Button>
              </Link>
              <Link href={`/${storeId}/catalog/new`}>
                <Button size="sm">New product</Button>
              </Link>
            </div>
          }
        />
        <CardBody className="space-y-3">
          <StatusFilter query={query} />
          <ProductsTable
            storeId={storeId}
            rows={result.ok ? result.data.items : []}
            total={result.ok ? result.data.total : 0}
            query={query}
            error={result.ok ? undefined : { status: result.status, error: result.error }}
          />
        </CardBody>
      </Card>
    </StoreSectionGuard>
  );
}
