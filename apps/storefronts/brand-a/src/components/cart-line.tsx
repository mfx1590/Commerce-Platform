'use client';

import { Button, Price, cn } from '@platform/ui';
import { ProductImage } from '@/components/product-image';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { updateLineItemAction, type ActionState } from '@/lib/actions';
import type { LineItem } from '@/lib/store-api';

const EMPTY: ActionState = {};

/**
 * One cart line. The quantity form posts to a server action; when the API answers `409 out_of_stock`
 * the action returns how many are actually left, and the line offers that quantity instead of just
 * saying no.
 */
export function CartLine({ item, locale }: { item: LineItem; locale: string }) {
  const [state, formAction, pending] = useActionState(updateLineItemAction, EMPTY);
  const t = useTranslations('cart');

  return (
    <li className="flex gap-4 border-b border-border py-6">
      <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-md bg-muted">
        {item.thumbnail_url === null ? null : (
          <ProductImage
            src={item.thumbnail_url}
            alt={item.title}
            fill
            sizes="96px"
            className="object-cover"
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2">
        <div className="flex justify-between gap-4">
          <div>
            <h3 className="font-medium">{item.title}</h3>
            <p className="text-sm text-muted-foreground">{item.variant_title}</p>
            <p className="text-sm text-muted-foreground">SKU {item.sku}</p>
          </div>
          <Price value={item.total} locale={locale} className="font-medium" />
        </div>

        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="line_item_id" value={item.id} />
          <div className="flex flex-col gap-1">
            <label htmlFor={`quantity-${item.id}`} className="text-sm text-muted-foreground">
              {t('quantity')}
            </label>
            <input
              id={`quantity-${item.id}`}
              name="quantity"
              type="number"
              min={0}
              max={99}
              defaultValue={state.availableQuantity ?? item.quantity}
              className={cn(
                'h-10 w-20 rounded-md border border-input bg-background px-3 text-base',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                state.error !== undefined && 'border-destructive',
              )}
            />
          </div>
          <Button type="submit" variant="outline" loading={pending}>
            {t('update')}
          </Button>
          <Button
            type="submit"
            variant="ghost"
            name="quantity"
            value="0"
            className="text-muted-foreground"
          >
            {t('remove')}
          </Button>
        </form>

        {state.error === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
    </li>
  );
}

export function EmptyCart() {
  const t = useTranslations('cart.empty');

  return (
    <div className="flex flex-col items-start gap-4 py-16">
      <h2 className="text-xl font-semibold">{t('title')}</h2>
      <p className="text-muted-foreground">{t('body')}</p>
      <Link href="/products" className="underline">
        {t('action')}
      </Link>
    </div>
  );
}
