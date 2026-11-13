import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductListView } from '@/components/product-list-view';
import { listCategories, parseListParams } from '@/lib/catalog';
import { alternatesFor, metaDescription } from '@/lib/seo';
import { categoryName } from '@/lib/text';

type SearchParams = Record<string, string | string[] | undefined>;
type Params = Promise<{ handle: string; locale: string }>;

async function findCategory(handle: string) {
  const categories = await listCategories();
  return categories.find((category) => category.handle === handle);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { handle, locale } = await params;
  const category = await findCategory(handle);
  if (!category) return { title: 'Category' };
  // The category name is the store's own copy and is not translated here. The contract has no
  // category description, so the name is it; an empty one emits no description (#837).
  const description = metaDescription(category.name);
  return {
    title: categoryName(category),
    ...(description === undefined ? {} : { description }),
    // Canonical without the filter/sort query: /categories/x?sort=price_asc is the same set of
    // products in a different order, and letting each permutation be its own URL splits the ranking
    // of one page across dozens of near-duplicates.
    alternates: alternatesFor(locale, `/categories/${category.handle}`),
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<SearchParams>;
}) {
  const { handle } = await params;
  const category = await findCategory(handle);
  if (!category) notFound();

  // The category comes from the path, so a `category` query parameter must not override it.
  const listParams = { ...parseListParams(await searchParams), category: category.handle };

  return (
    <ProductListView
      title={categoryName(category)}
      basePath={`/categories/${category.handle}`}
      params={listParams}
      activeCategoryHandle={category.handle}
    />
  );
}
