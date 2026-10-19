import type { ProductStoryBlock } from '@platform/cms';
import { Price } from '@platform/ui';
import { Link } from '@/i18n/navigation';
import { getProduct } from '@/lib/catalog';
import type { Product } from '@/lib/store-api';
import type { ContentContext } from '../content';
import { CtaLink } from './hero';
import { PortableText } from './portable-text';
import { SanityImage } from './sanity-image';

/**
 * CMS copy around a live product. The handle is the only thing the CMS knows; title, price and
 * availability come from the Store API at render time (ADR 0004), and an unknown handle or an API
 * outage degrades to the copy alone — a story about a product must not take the page down.
 */
async function loadProduct(
  handle: string,
  fetchProduct: typeof getProduct,
): Promise<Product | null> {
  try {
    return await fetchProduct(handle);
  } catch {
    return null;
  }
}

export interface ProductStoryProps {
  block: ProductStoryBlock;
  ctx: ContentContext;
  /** Injectable for tests. */
  fetchProduct?: typeof getProduct;
}

export async function ProductStory({ block, ctx, fetchProduct = getProduct }: ProductStoryProps) {
  const product = await loadProduct(block.productHandle, fetchProduct);
  const variant = product?.variants[0];

  return (
    <section className="grid items-start gap-8 md:grid-cols-2">
      <div className="flex flex-col items-start gap-4">
        <h2 className="text-2xl font-semibold">{block.headline}</h2>
        {block.body ? <PortableText value={block.body} ctx={ctx} /> : null}
        {product ? (
          <div className="flex flex-col gap-1 rounded-lg border border-border p-4">
            <Link href={`/products/${product.handle}`} className="font-medium hover:underline">
              {product.title}
            </Link>
            {variant ? (
              <Price
                value={variant.price}
                compareAt={variant.compare_at_price}
                locale={ctx.locale}
              />
            ) : null}
            <Link href={`/products/${product.handle}`} className="text-sm underline">
              {ctx.t('product.view')}
            </Link>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{ctx.t('product.unavailable')}</p>
        )}
        {block.cta ? <CtaLink cta={block.cta} /> : null}
      </div>
      {block.image ? (
        <SanityImage image={block.image} ctx={ctx} className="w-full rounded-lg" />
      ) : null}
    </section>
  );
}
