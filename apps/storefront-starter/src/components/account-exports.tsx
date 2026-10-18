'use client';

import { buttonVariants } from '@platform/ui';
import type { StoreComponents } from '@platform/contracts';
import { useLocale, useTranslations } from 'next-intl';

type CustomerExportSummary = StoreComponents['schemas']['CustomerExportSummary'];

/**
 * The customer's data exports (#472, Store API 0.5.8 `listMyExports`): one row per request with its state —
 * being prepared, ready until a date, or expired (purged after 30 days, or never built: the customer's data was
 * gone or the bundle was too large to deliver online). "Download" is a plain link to the route handler in the
 * account route group, which fetches the bundle with the session token (never in the browser) and streams it as
 * an attachment. Copy from the `account.exports` catalog.
 */
export function ExportsList({ items }: { items: CustomerExportSummary[] }) {
  const t = useTranslations('account.exports');
  const locale = useLocale();
  const date = (iso: string | null) =>
    iso === null ? '' : new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });

  if (items.length === 0) return null;
  return (
    <div className="flex max-w-lg flex-col gap-3">
      <h3 className="text-lg font-semibold">{t('title')}</h3>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
          >
            <div className="flex flex-col gap-0.5">
              <span>{t('requested', { date: date(item.requested_at) })}</span>
              <span className="text-xs text-muted-foreground">
                {item.status === 'ready'
                  ? t('until', { date: date(item.expires_at) })
                  : item.status === 'pending'
                    ? t('pending')
                    : item.reason === 'too_large'
                      ? t('tooLarge')
                      : t('expired')}
              </span>
            </div>
            {item.status === 'ready' ? (
              <a
                href={`/account/exports/${item.id}`}
                download={`customer-export-${item.id}.json`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('download')}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
