import { Badge, buttonVariants, Card, CardContent, CardHeader, CardTitle } from '@platform/ui';
import { getTranslations } from 'next-intl/server';
import { JsonLd } from '@/components/json-ld';
import { HOME_SLUG, HomeContent } from '@/lib/cms/components';
import { getContent } from '@/lib/cms/content';
import { Link } from '@/i18n/navigation';
import { organizationJsonLd } from '@/lib/seo';
import { getStoreOrNull } from '@/lib/store';

/**
 * Rendered per request: this page has no cacheable data of its own, but the layout above it calls
 * `GET /store` for the header. Prerendering it would bake one snapshot of the store into the build
 * — and CI builds with no API reachable at all. The catalog routes cache at the fetch layer instead.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const [store, t] = await Promise.all([getStoreOrNull(), getTranslations('home')]);

  if (!store) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('offline.title')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>{t('offline.body')}</p>
          <p className="mt-2">{t('offline.config')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      {/* The brand itself: what a search engine builds a knowledge panel from. Only on the home
          page — repeating it per page tells a crawler nothing new. */}
      <JsonLd data={organizationJsonLd()} />

      {/* Window 6's CMS home slots (REQUEST #178): hero and blocks from the `page` document with
          slug `home`, including campaign embeds. Renders nothing until a marketer publishes one, so
          the starter's own home page below is unchanged — and above it, because published content is
          the reason someone arrived. */}
      <CmsHome locale={locale} />
      <section className="flex flex-col items-start gap-4">
        <Badge variant="outline">{store.sales_channel.type}</Badge>
        <h1 className="text-4xl font-bold leading-tight">{store.name}</h1>
        <p className="max-w-prose text-muted-foreground">{t('intro')}</p>
        {/* A link that looks like a button: an <a> inside a <button> would be invalid HTML. */}
        <Link href="/products" className={buttonVariants({ size: 'lg' })}>
          {t('shopAll')}
        </Link>
      </section>

      <section aria-labelledby="store-facts">
        <h2 id="store-facts" className="mb-4 text-xl font-semibold">
          {t('thisStore')}
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label={t('code')} value={store.code} />
          <Fact label={t('shipsTo')} value={store.default_country} />
          <Fact
            label={t('currencies')}
            value={store.currencies.join(', ')}
            hint={t('default', { value: store.default_currency })}
          />
          <Fact
            label={t('locales')}
            value={store.locales.join(', ')}
            hint={t('default', { value: store.default_locale })}
          />
        </dl>
      </section>
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <dt className="text-sm text-muted-foreground">{label}</dt>
        <dd className="mt-1 text-lg font-medium">{value}</dd>
        {hint === undefined ? null : <dd className="text-sm text-muted-foreground">{hint}</dd>}
      </CardContent>
    </Card>
  );
}

/**
 * The CMS home content, isolated so an unreachable or unconfigured CMS cannot take the home page
 * with it. `getContent` already degrades to "no document" when Sanity is not configured; this guard
 * covers the rest — a network failure, a malformed document — because the home page is the one URL
 * that must always render.
 */
async function CmsHome({ locale }: { locale: string }) {
  try {
    const { cms, ctx } = await getContent(locale);
    return <HomeContent page={await cms.page(locale, HOME_SLUG)} ctx={ctx} />;
  } catch (error) {
    console.warn('[storefront] CMS home content could not be read:', error);
    return null;
  }
}
