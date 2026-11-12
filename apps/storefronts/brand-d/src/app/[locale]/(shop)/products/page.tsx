import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ProductListView } from '@/components/product-list-view';
import { parseListParams } from '@/lib/catalog';
import { alternatesFor } from '@/lib/seo';

type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations('plp');
  return {
    title: t('allProducts'),
    description: t('metaDescription'),
    // Deliberately query-less: every sort and page of the listing canonicalises to the listing
    // itself rather than competing with it.
    alternates: alternatesFor(locale, '/products'),
    // Without this the root layout's Open Graph title (the brand name) is inherited, and every
    // shared listing link previews identically.
    openGraph: { title: t('allProducts'), description: t('metaDescription') },
  };
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
