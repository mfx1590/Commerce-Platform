import { Badge, Price } from '@platform/ui';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import type { ProductSummary } from '@/lib/store-api';

/** Grid sizes, so the browser downloads one image per breakpoint instead of the largest. */
const CARD_SIZES = '(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw';

export interface ProductCardProps {
  product: ProductSummary;
  locale: string;
  /** The first row is above the fold: give those images priority and skip lazy loading. */
  priority?: boolean;
}

export function ProductCard({ product, locale, priority = false }: ProductCardProps) {
  const t = useTranslations('common');
  const onSale =
    product.compare_at_price !== null &&
    product.compare_at_price.amount_minor > product.price.amount_minor;

  return (
    <article className="group flex flex-col gap-3">
      <Link
        href={`/products/${product.handle}`}
        className="relative block aspect-square overflow-hidden rounded-lg bg-muted"
      >
        {product.thumbnail_url === null ? (
          <span className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
            {t('noImage')}
          </span>
        ) : (
          <Image
            src={product.thumbnail_url}
            alt={product.title}
            fill
            sizes={CARD_SIZES}
            priority={priority}
            className="object-cover transition-transform duration-200 group-hover:scale-105"
          />
        )}
        {onSale ? (
          <Badge variant="destructive" className="absolute left-2 top-2">
            {t('sale')}
          </Badge>
        ) : null}
      </Link>

      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium leading-tight">
          <Link href={`/products/${product.handle}`} className="hover:underline">
            {product.title}
          </Link>
        </h3>
        <Price
          value={product.price}
          compareAt={product.compare_at_price}
          locale={locale}
          className="text-base"
        />
      </div>
    </article>
  );
}
