import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductListView } from '@/components/product-list-view';
import { listCategories, parseListParams } from '@/lib/catalog';

type SearchParams = Record<string, string | string[] | undefined>;
type Params = Promise<{ handle: string }>;

async function findCategory(handle: string) {
  const categories = await listCategories();
  return categories.find((category) => category.handle === handle);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { handle } = await params;
  const category = await findCategory(handle);
  if (!category) return { title: 'Category' };
  // The category name is the store's own copy and is not translated here.
  return { title: category.name, description: category.name };
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
      title={category.name}
      basePath={`/categories/${category.handle}`}
      params={listParams}
      activeCategoryHandle={category.handle}
    />
  );
}
