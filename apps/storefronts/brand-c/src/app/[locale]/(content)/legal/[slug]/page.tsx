import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PortableText } from '@/lib/cms/components';
import { getContent } from '@/lib/cms/content';
import { formatReviewDate } from '@/lib/cms/format';
import { documentMetadata } from '@/lib/cms/metadata';

/** `/[locale]/legal/[slug]` — a CMS `legal` document (terms, privacy, imprint, cookies, returns). */
type Params = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, slug } = await params;
  const { cms, ctx } = await getContent(locale);
  const document = await cms.legal(locale, slug);
  if (!document) return { title: ctx.t('page.notFound.title') };
  return documentMetadata(document, `/legal/${slug}`, ctx);
}

export default async function LegalPage({ params }: { params: Params }) {
  const { locale, slug } = await params;
  const { cms, ctx } = await getContent(locale);
  const document = await cms.legal(locale, slug);
  if (!document) notFound();

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {ctx.t(`legal.kind.${document.kind}`)}
        </p>
        <h1 className="text-4xl font-bold leading-tight">{document.title}</h1>
        <p className="text-sm text-muted-foreground">
          {ctx.t('legal.lastReviewed', { date: formatReviewDate(document.lastReviewed, locale) })}
        </p>
      </header>
      <PortableText value={document.body.content} ctx={ctx} />
    </article>
  );
}
