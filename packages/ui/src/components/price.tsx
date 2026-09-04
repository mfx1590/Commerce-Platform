import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

/** Money as the Store API sends it: integer minor units plus an ISO-4217 code. Never a float. */
export interface Money {
  amount_minor: number;
  currency: string;
}

/** Locale used when a caller does not pass one. Pages should always pass the request locale. */
export const DEFAULT_LOCALE = 'en-US';

/**
 * How many minor units make one major unit for this currency, according to the runtime's CLDR
 * data (2 for EUR/GBP/USD, 0 for JPY, 3 for BHD). Falls back to 2 for an unknown code.
 */
export function minorUnitDigits(currency: string, locale: string = DEFAULT_LOCALE): number {
  try {
    return (
      new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
        .minimumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** `{ amount_minor: 1999, currency: 'EUR' }` in `de-DE` -> `19,99 €`. */
export function formatMoney(
  money: Money,
  locale: string = DEFAULT_LOCALE,
  options: Intl.NumberFormatOptions = {},
): string {
  const digits = minorUnitDigits(money.currency, locale);
  const amount = money.amount_minor / 10 ** digits;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: money.currency,
      ...options,
    }).format(amount);
  } catch {
    // Unknown currency code: still show a number rather than throwing in a product page.
    return `${new Intl.NumberFormat(locale, options).format(amount)} ${money.currency}`;
  }
}

export interface PriceProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  value: Money;
  /** Original price; rendered struck through next to `value` when it is higher. */
  compareAt?: Money | null;
  /** BCP-47 locale. Defaults to `en-US`; the storefront passes the request locale. */
  locale?: string;
  /** Accessible label for the struck-through original price. */
  compareAtLabel?: string;
}

/**
 * Renders a `Money` with `Intl.NumberFormat`. Pure and server-renderable — no context, no hooks —
 * so it can be used directly inside React Server Components on the PLP and PDP.
 */
export function Price({
  value,
  compareAt,
  locale = DEFAULT_LOCALE,
  compareAtLabel = 'Original price',
  className,
  ...props
}: PriceProps) {
  const showCompareAt =
    compareAt != null &&
    compareAt.currency === value.currency &&
    compareAt.amount_minor > value.amount_minor;

  return (
    <span className={cn('inline-flex items-baseline gap-2', className)} {...props}>
      <span data-testid="price-value" data-currency={value.currency}>
        {formatMoney(value, locale)}
      </span>
      {showCompareAt ? (
        <s
          data-testid="price-compare-at"
          aria-label={compareAtLabel}
          className="text-muted-foreground"
        >
          {formatMoney(compareAt, locale)}
        </s>
      ) : null}
    </span>
  );
}
