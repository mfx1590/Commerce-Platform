import { Badge } from '@platform/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { notFound } from 'next/navigation';
import { VariantPicker } from '@/components/variant-picker';
import { JsonLd } from '@/components/json-ld';
import { brandConfig } from '@/brand/config';
import { getProduct } from '@/lib/catalog';
import { getCurrency } from '@/lib/i18n';
import { getStoreOrNull } from '@/lib/store';
import {
  absoluteUrl,
  alternatesFor,
  breadcrumbJsonLd,
  canonicalFor,
  localizedPath,
  productJsonLd,
} from '@/lib/seo';
import { isNotFound } from '@/lib/store-api';
import { defaultSelection, findVariant, mediaFor } from '@/lib/variant';

type Params = Promise<{ handle: string; locale: string }>;

/** The gallery is the largest element on the page; sizes keep the LCP image small on a phone. */
const GALLERY_SIZES = '(min-width: 1024px) 50vw, 100vw';

/**
 * `getProduct` is wrapped in `cache()`, so metadata and the page share one request — as long as both
 * pass the same currency, which they do because `getCurrency` is resolved from the same cookie and
 * `getStoreOrNull` is itself cached per render.
 */
async function loadProduct(handle: string, currency?: string | undefined) {
  try {
    return await getProduct(handle, currency ?? (await getCurrency(await getStoreOrNull())));
  } catch (error) {
    if (isNotFound(error)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { handle, locale } = await params;
  // Deliberately currency-less: nothing in the metadata is priced, so asking for a currency would
  // fragment the fetch cache per currency for no gain — and make this read depend on the cookie.
  const product = await loadProduct(handle, undefined);
  const description = product.seo?.description ?? product.subtitle ?? undefined;
  const title = product.seo?.title ?? product.title;

  // Every locale is an alternate; the canonical honours an API-pinned value but localises a
  // relative one (see `canonicalFor` — an un-prefixed path is a URL that does not exist).
  const productPath = `/products/${product.handle}`;
  const alternates = {
    ...alternatesFor(locale, productPath),
    canonical: canonicalFor(locale, product.seo?.canonical, productPath),
  };

  return {
    title,
    ...(description === undefined ? {} : { description }),
    alternates,
    openGraph: {
      type: 'website',
      siteName: brandConfig.name,
      title,
      ...(description === undefined ? {} : { description }),
      locale,
      url: localizedPath(locale, productPath),
    },
  };
}

export default async function ProductDetailPage({ params }: { params: Params }) {
  const { handle, locale: routeLocale } = await params;
  const [product, t, tCommon] = await Promise.all([
    loadProduct(handle),
    getTranslations('pdp'),
    getTranslations('common'),
  ]);

  const locale = await getLocale();
  // Render the same variant the picker will start on, so hydration replaces correct markup.
  const initialVariant = findVariant(product, defaultSelection(product));
  const media = mediaFor(product, initialVariant);
  const hero = media[0];

  const productPath = `/products/${product.handle}`;
  // The breadcrumb JSON-LD mirrors the <nav> below exactly — same labels, same links. A trail a
  // crawler is told about but a visitor cannot see is what Google calls a structured-data mismatch.
  const crumbs = [
    { name: t('products'), path: localizedPath(routeLocale, '/products') },
    ...(product.category === null
      ? []
      : [
          {
            name: product.category.name,
            path: localizedPath(routeLocale, `/categories/${product.category.handle}`),
          },
        ]),
    { name: product.title, path: localizedPath(routeLocale, productPath) },
  ];

  return (
    <article className="flex flex-col gap-10">
      <JsonLd
        data={productJsonLd(product, {
          url: absoluteUrl(localizedPath(routeLocale, productPath)),
          locale: routeLocale,
        })}
      />
      <JsonLd data={breadcrumbJsonLd(crumbs)} />
      <nav aria-label={t('breadcrumb')} className="text-sm text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-2">
          <li>
            <Link href="/products" className="hover:underline">
              {t('products')}
            </Link>
          </li>
          {product.category === null ? null : (
            <li className="flex items-center gap-2">
              <span aria-hidden="true">/</span>
              <Link href={`/categories/${product.category.handle}`} className="hover:underline">
                {product.category.name}
              </Link>
            </li>
          )}
          <li className="flex items-center gap-2">
            <span aria-hidden="true">/</span>
            <span aria-current="page">{product.title}</span>
          </li>
        </ol>
      </nav>

      <div className="grid gap-10 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div className="relative aspect-square overflow-hidden rounded-lg bg-muted">
            {hero === undefined ? (
              <span className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                {tCommon('noImage')}
              </span>
            ) : (
              <Image
                src={hero.url}
                alt={hero.alt ?? product.title}
                fill
                sizes={GALLERY_SIZES}
                priority
                className="object-cover"
              />
            )}
          </div>
          {media.length > 1 ? (
            <ul className="grid grid-cols-4 gap-3">
              {media.slice(1, 5).map((item) => (
                <li
                  key={item.url}
                  className="relative aspect-square overflow-hidden rounded-md bg-muted"
                >
                  <Image
                    src={item.url}
                    alt={item.alt ?? product.title}
                    fill
                    sizes="25vw"
                    className="object-cover"
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            {product.brand_name === null ? null : (
              <p className="text-sm text-muted-foreground">{product.brand_name}</p>
            )}
            <h1 className="text-3xl font-bold leading-tight">{product.title}</h1>
            {product.subtitle === null ? null : (
              <p className="text-lg text-muted-foreground">{product.subtitle}</p>
            )}
          </header>

          <VariantPicker product={product} locale={locale} />

          {product.tags.length === 0 ? null : (
            <ul className="flex flex-wrap gap-2">
              {product.tags.map((tag) => (
                <li key={tag}>
                  <Badge variant="outline">{tag}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {product.description === null ? null : (
        <section aria-labelledby="description" className="max-w-prose">
          <h2 id="description" className="mb-2 text-xl font-semibold">
            {t('description')}
          </h2>
          <p className="whitespace-pre-line text-muted-foreground">{product.description}</p>
        </section>
      )}
    </article>
  );
}
