import type { Metadata } from 'next';
import { ProductListView } from '@/components/product-list-view';
import { parseListParams } from '@/lib/catalog';

export const metadata: Metadata = {
  title: 'Products',
  description:
    'Browse the full catalogue: filter by category, search, and sort by price or newest.',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProductListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = parseListParams(await searchParams);

  return (
    <ProductListView
      title="All products"
      basePath="/products"
      params={params}
      {...(params.category === undefined ? {} : { activeCategoryHandle: params.category })}
    />
  );
}
