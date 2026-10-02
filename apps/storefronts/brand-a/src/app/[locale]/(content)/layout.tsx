import type { ReactNode } from 'react';
import { CmsFooter, CmsHeader, PreviewBanner } from '@/lib/cms/components';
import { getContent } from '@/lib/cms/content';
import { assertStoreOffersLocale } from '@/lib/i18n';
import { getStoreOrNull } from '@/lib/store';

/**
 * Content routes: header and footer come from the CMS `navigation` and `footer` documents for the
 * locale, with the starter's static links as fallback when there is nothing published (or no CMS
 * at all). The shop chrome adopts the same components in wave C (window 3, REQUEST #178).
 */
export default async function ContentLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const store = await getStoreOrNull();
  assertStoreOffersLocale(store, locale);
  const { cms, ctx } = await getContent(locale);
  const [navigation, footer] = await Promise.all([cms.navigation(locale), cms.footer(locale)]);

  return (
    <div className="flex min-h-screen flex-col">
      <PreviewBanner ctx={ctx} returnTo={`/${locale}`} />
      <CmsHeader store={store} navigation={navigation} ctx={ctx} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">{children}</main>
      <CmsFooter store={store} footer={footer} ctx={ctx} />
    </div>
  );
}
