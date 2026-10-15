import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Blocks, Hero } from '@/lib/cms/components';
import { getContent } from '@/lib/cms/content';
import { documentMetadata } from '@/lib/cms/metadata';
import { campaignIsLive } from '@/lib/cms/schedule';

/**
 * `/[locale]/campaign/[slug]` — a `campaignLanding`. 404 when unpublished, before `startsAt` or
 * after `endsAt`: an expired campaign link must not keep selling last season's promise. The
 * marketing UTM parameters on the shared link are captured by the middleware into the attribution
 * cookie exactly as on every other page; nothing here needs to touch them.
 */
type Params = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, slug } = await params;
  const { cms, ctx } = await getContent(locale);
  const landing = await cms.campaignLanding(locale, slug);
  if (!landing || !campaignIsLive(landing)) return { title: ctx.t('page.notFound.title') };
  return documentMetadata(landing, `/campaign/${slug}`, ctx);
}

export default async function CampaignPage({ params }: { params: Params }) {
  const { locale, slug } = await params;
  const { cms, ctx } = await getContent(locale);
  const landing = await cms.campaignLanding(locale, slug);
  if (!landing || !campaignIsLive(landing)) notFound();

  return (
    <article className="flex flex-col gap-12" data-campaign-id={landing.campaignId ?? undefined}>
      <Hero hero={landing.hero} ctx={ctx} as="h1" />
      <Blocks blocks={landing.blocks} ctx={ctx} />
    </article>
  );
}
