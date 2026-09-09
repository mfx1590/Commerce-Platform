import type { PageDocument } from '@platform/cms';
import type { ContentContext } from '../content';
import { Blocks } from './blocks';
import { Hero } from './hero';

/** The CMS `page` that fills the home page's slots. */
export const HOME_SLUG = 'home';

/**
 * Hero and blocks for the home page, from the `page` document with slug `home` in the locale.
 * Renders nothing when there is no such document, so the starter's home page is unchanged until a
 * marketer publishes one. Window 3 mounts it in `src/app/[locale]/(shop)/page.tsx` (REQUEST #178);
 * a brand app can do the same in its own home route.
 */
export function HomeContent({ page, ctx }: { page: PageDocument | null; ctx: ContentContext }) {
  if (!page) return null;
  return (
    <div className="flex flex-col gap-12">
      {page.hero ? <Hero hero={page.hero} ctx={ctx} as="h2" /> : null}
      <Blocks blocks={page.blocks} ctx={ctx} />
    </div>
  );
}
