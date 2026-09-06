import { CategoryFilter, SearchForm, SortLinks } from '@/components/catalog-filters';
import { Pagination } from '@/components/pagination';
import { ProductGrid } from '@/components/product-grid';
import {
  buildCategoryTree,
  listCategories,
  listProducts,
  totalPages,
  type ListParams,
} from '@/lib/catalog';
import { getStoreOrNull } from '@/lib/store';

/**
 * The listing itself, shared by `/products` and `/categories/[handle]`.
 *
 * Both requests are issued together and awaited once, so the page renders in a single pass with no
 * client-side fetching: the browser gets finished HTML and images, nothing else.
 */
export async function ProductListView({
  title,
  description,
  basePath,
  params,
  activeCategoryHandle,
}: {
  title: string;
  description?: string | undefined;
  basePath: string;
  params: ListParams;
  activeCategoryHandle?: string | undefined;
}) {
  const [store, page, categories] = await Promise.all([
    getStoreOrNull(),
    listProducts(params),
    listCategories(),
  ]);

  const locale = store?.default_locale ?? 'en-US';
  const pages = totalPages(page);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold leading-tight">{title}</h1>
        {description === undefined ? null : (
          <p className="max-w-prose text-muted-foreground">{description}</p>
        )}
        <p className="text-sm text-muted-foreground">
          {page.total} {page.total === 1 ? 'product' : 'products'}
          {params.q === undefined ? null : <> matching “{params.q}”</>}
        </p>
      </header>

      <div className="flex flex-col gap-8 lg:flex-row">
        <aside className="flex flex-col gap-6 lg:w-56 lg:shrink-0">
          <SearchForm basePath={basePath} params={params} />
          <CategoryFilter
            basePath="/products"
            params={params}
            categories={buildCategoryTree(categories)}
            activeHandle={activeCategoryHandle}
          />
        </aside>

        <div className="flex-1">
          <SortLinks basePath={basePath} params={params} />
          <div className="mt-6">
            <ProductGrid products={page.items} locale={locale} />
          </div>
          <Pagination basePath={basePath} params={params} total={pages} />
        </div>
      </div>
    </div>
  );
}
