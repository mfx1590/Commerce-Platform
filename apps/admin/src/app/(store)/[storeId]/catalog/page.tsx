import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectFilter } from '@/components/table/url-filters';
import { listCategories, listProducts } from '@/lib/api/admin';
import { CATALOG_PERMISSIONS } from '@/lib/catalog/permissions';
import { holds, type PermissionRule } from '@/lib/permissions/rules';
import { loadPrincipal } from '@/lib/principal';
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
  const [result, categories, principal] = await Promise.all([
    listProducts(storeId, toContractQuery(query, { sortable: true })),
    listCategories(storeId),
    loadPrincipal(),
  ]);
  const can = (rule: PermissionRule) => principal.ok && holds(principal.data, rule, storeId);

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
          <div className="flex flex-wrap items-center gap-4">
            <StatusFilter query={query} />
            {categories.ok && (
              <SelectFilter
                query={query}
                defaults={PRODUCTS_TABLE_DEFAULTS}
                filterKey="category_id"
                label="Category"
                anyLabel="Any category"
                options={categories.data.items.map((category) => ({
                  value: category.id,
                  label: category.name,
                }))}
              />
            )}
          </div>
          <ProductsTable
            storeId={storeId}
            rows={result.ok ? result.data.items : []}
            total={result.ok ? result.data.total : 0}
            query={query}
            emptyAction={
              <Link href={`/${storeId}/catalog/new`}>
                <Button>Create the first product</Button>
              </Link>
            }
            error={result.ok ? undefined : { status: result.status, error: result.error }}
            canPublish={can(CATALOG_PERMISSIONS.publishProduct)}
            canArchive={can(CATALOG_PERMISSIONS.archiveProduct)}
          />
        </CardBody>
      </Card>
    </StoreSectionGuard>
  );
}
