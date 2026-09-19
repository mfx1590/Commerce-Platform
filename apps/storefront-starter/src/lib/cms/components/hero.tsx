import type { Cta, Hero as HeroValue } from '@platform/cms';
import { buttonVariants } from '@platform/ui';
import type { ContentContext } from '../content';
import { SafeLink } from './safe-link';
import { SanityImage } from './sanity-image';

/**
 * A link that looks like a button: an `<a>` inside a `<button>` would be invalid HTML. Rendered
 * through `SafeLink`, so an unsafe stored href degrades to a label without a destination.
 */
export function CtaLink({ cta, size = 'md' }: { cta: Cta; size?: 'md' | 'lg' }) {
  const variant = cta.variant === 'secondary' ? 'outline' : 'primary';
  return (
    <SafeLink href={cta.href} className={buttonVariants({ variant, size })}>
      {cta.label}
    </SafeLink>
  );
}

export interface HeroProps {
  hero: HeroValue;
  ctx: ContentContext;
  /** The page's own `<h1>` when the hero opens the page; `h2` inside a block list. */
  as?: 'h1' | 'h2';
}

export function Hero({ hero, ctx, as: Heading = 'h1' }: HeroProps) {
  const imageLeft = hero.layout === 'image-left';
  const fullBleed = hero.layout === 'full-bleed';
  return (
    <section
      className={
        fullBleed
          ? 'relative flex flex-col gap-6 overflow-hidden rounded-xl bg-muted p-8'
          : `grid items-center gap-8 md:grid-cols-2 ${imageLeft ? 'md:[&>*:first-child]:order-2' : ''}`
      }
    >
      <div className="flex flex-col items-start gap-4">
        {hero.eyebrow ? (
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {hero.eyebrow}
          </p>
        ) : null}
        <Heading className="text-4xl font-bold leading-tight">{hero.headline}</Heading>
        {hero.subheadline ? (
          <p className="max-w-prose text-lg text-muted-foreground">{hero.subheadline}</p>
        ) : null}
        {hero.ctas && hero.ctas.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {hero.ctas.map((cta, index) => (
              <CtaLink key={cta._key ?? index} cta={cta} size="lg" />
            ))}
          </div>
        ) : null}
      </div>
      {hero.image ? (
        <SanityImage image={hero.image} ctx={ctx} priority className="w-full rounded-lg" />
      ) : null}
    </section>
  );
}
