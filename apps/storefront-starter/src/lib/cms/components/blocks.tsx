import type { CampaignBlock } from '@platform/cms';
import type { ContentContext } from '../content';
import { CtaLink, Hero } from './hero';
import { Embed } from './embed';
import { PortableText } from './portable-text';
import { ProductStory } from './product-story';
import { SanityImage } from './sanity-image';

/**
 * The block list of a page or a campaign landing, in document order. A block type this renderer
 * does not know (a schema added before the storefront caught up) renders nothing instead of
 * breaking the page.
 */
export function Blocks({
  blocks,
  ctx,
}: {
  blocks: CampaignBlock[] | undefined;
  ctx: ContentContext;
}) {
  if (!blocks || blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-12">
      {blocks.map((block, index) => {
        const key = block._key ?? String(index);
        switch (block._type) {
          case 'hero':
            return <Hero key={key} hero={block} ctx={ctx} as="h2" />;
          case 'richText':
            return <PortableText key={key} value={block.content} ctx={ctx} />;
          case 'imageBlock':
            return (
              <figure key={key} className={block.width === 'wide' ? 'md:-mx-8' : undefined}>
                <SanityImage image={block.image} ctx={ctx} className="w-full rounded-lg" />
                {block.caption ? (
                  <figcaption className="mt-2 text-sm text-muted-foreground">
                    {block.caption}
                  </figcaption>
                ) : null}
              </figure>
            );
          case 'productStory':
            return <ProductStory key={key} block={block} ctx={ctx} />;
          case 'cta':
            return (
              <div key={key}>
                <CtaLink cta={block} size="lg" />
              </div>
            );
          case 'embed':
            return <Embed key={key} block={block} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
