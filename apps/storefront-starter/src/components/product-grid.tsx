import { useTranslations } from 'next-intl';
import type { ProductSummary } from '@/lib/store-api';
import { ProductCard } from './product-card';

/** Cards in the first grid row are above the fold on a phone; they load eagerly. */
const ABOVE_THE_FOLD = 2;

export function ProductGrid({ products, locale }: { products: ProductSummary[]; locale: string }) {
  const t = useTranslations('plp');

  if (products.length === 0) {
    return <p className="py-16 text-center text-muted-foreground">{t('empty')}</p>;
  }

  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((product, index) => (
        <li key={product.id}>
          <ProductCard product={product} locale={locale} priority={index < ABOVE_THE_FOLD} />
        </li>
      ))}
    </ul>
  );
}
