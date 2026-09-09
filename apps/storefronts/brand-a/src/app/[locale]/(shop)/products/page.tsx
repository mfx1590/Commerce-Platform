import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ProductListView } from '@/components/product-list-view';
import { parseListParams } from '@/lib/catalog';

type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('plp');
  return { title: t('allProducts'), description: t('metaDescription') };
}

export default async function ProductListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = parseListParams(await searchParams);
  const t = await getTranslations('plp');

  return (
    <ProductListView
      title={t('allProducts')}
      basePath="/products"
      params={params}
      {...(params.category === undefined ? {} : { activeCategoryHandle: params.category })}
    />
  );
}
