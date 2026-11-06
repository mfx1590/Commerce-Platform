import { useTranslations } from 'next-intl';
import { ProductCard } from '@/components/product-card';
import { RecommendationTracker } from '@/components/recommendation-tracker';
import type { RecommendationSurface, Recommendations } from '@/lib/recommendations';

const HEADING_KEY = { pdp: 'boughtTogether', cart: 'youMayAlsoLike' } as const;

export interface RecommendationRailProps {
  surface: RecommendationSurface;
  recommendations: Recommendations;
  locale: string;
  /** False in the `strict` consent mode: the rail renders, nothing is tracked. */
  tracking: boolean;
}

/**
 * The recommendation rail (#609). Rendered on the server from data the page already awaited, so it
 * is in the first HTML or not at all — nothing is inserted after paint, and an empty or failed
 * call renders NOTHING (no heading, no reserved box). The cards are the PLP's `ProductCard`,
 * unchanged: the contract returns the same `ProductSummary` shape on purpose.
 */
export function RecommendationRail({
  surface,
  recommendations,
  locale,
  tracking,
}: RecommendationRailProps) {
  const t = useTranslations('recommendations');
  const { kind, items } = recommendations;
  if (kind === null || items.length === 0) return null;

  const headingId = `recommendations-${surface}`;
  const rail = (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4"
      data-testid="recommendation-rail"
      data-surface={surface}
      data-kind={kind}
    >
      <h2 id={headingId} className="text-xl font-semibold">
        {t(HEADING_KEY[surface])}
      </h2>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-4">
        {items.map((product, index) => (
          <li key={product.id} data-rail-position={index + 1}>
            <ProductCard product={product} locale={locale} />
          </li>
        ))}
      </ul>
    </section>
  );

  if (!tracking) return rail;
  return (
    <RecommendationTracker rail={{ kind, surface, productIds: items.map((product) => product.id) }}>
      {rail}
    </RecommendationTracker>
  );
}
