import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Blocks, Hero } from '@/lib/cms/components';
import { getContent } from '@/lib/cms/content';
import { documentMetadata } from '@/lib/cms/metadata';

/**
 * `/[locale]/pages/[slug]` — a CMS `page`. Unpublished or unknown → 404. No `generateStaticParams`
 * on purpose: `next build` runs with no CMS reachable (CI), so pages render on demand and cache at
 * the fetch layer by tag, exactly like the PLP and PDP; a publish drops one page via the webhook.
 */
type Params = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, slug } = await params;
  const { cms, ctx } = await getContent(locale);
  const page = await cms.page(locale, slug);
  if (!page) return { title: ctx.t('page.notFound.title') };
  return documentMetadata(page, `/pages/${slug}`, ctx);
}

export default async function ContentPage({ params }: { params: Params }) {
  const { locale, slug } = await params;
  const { cms, ctx } = await getContent(locale);
  const page = await cms.page(locale, slug);
  if (!page) notFound();

  return (
    <article className="flex flex-col gap-12">
      {page.hero ? (
        <Hero hero={page.hero} ctx={ctx} as="h1" />
      ) : (
        <h1 className="text-4xl font-bold leading-tight">{page.title}</h1>
      )}
      <Blocks blocks={page.blocks} ctx={ctx} />
    </article>
  );
}
