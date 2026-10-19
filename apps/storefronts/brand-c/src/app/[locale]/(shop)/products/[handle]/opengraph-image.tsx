import { ImageResponse } from 'next/og';
import { brandConfig } from '@/brand/config';
import { getProduct } from '@/lib/catalog';
import { isNotFound } from '@/lib/store-api';

/**
 * The share card for a product.
 *
 * Rendered from text rather than from the product photo on purpose: the photo lives on a CDN behind
 * `remotePatterns`, `ImageResponse` would have to fetch it on every miss, and a share card that
 * sometimes times out is worse than one that always renders. The title is the product's, so the card
 * is still specific.
 *
 * Deliberately no price: a card is cached by every social platform that sees it, and a stale price
 * on a shared link is a promise we would have to honour.
 */
export const alt = 'Product';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage({
  params,
}: {
  params: { handle: string };
}): Promise<ImageResponse> {
  const title = await productTitle(params.handle);

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#0b0b0c',
        color: '#fafafa',
        padding: 80,
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ fontSize: 30, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.7 }}>
        {brandConfig.name}
      </div>
      <div style={{ fontSize: 76, lineHeight: 1.1, fontWeight: 700, display: 'flex' }}>{title}</div>
    </div>,
    size,
  );
}

/** A card must always render: an unreachable API falls back to the brand name, never to an error. */
async function productTitle(handle: string): Promise<string> {
  try {
    const product = await getProduct(handle);
    return product.seo?.title ?? product.title;
  } catch (error) {
    if (!isNotFound(error)) {
      console.warn('[storefront] og image: product could not be read:', error);
    }
    return brandConfig.name;
  }
}
