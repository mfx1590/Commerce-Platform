import { Price } from '@platform/ui';
import { useTranslations } from 'next-intl';
import type { Totals } from '@/lib/store-api';

/** The money table shown in the cart, at review, and on the confirmation page. */
export function TotalsTable({ totals, locale }: { totals: Totals; locale: string }) {
  const t = useTranslations('totals');
  const rows: [string, Totals[keyof Totals]][] = [
    ['subtotal', totals.subtotal],
    ['discount', totals.discount],
    ['shipping', totals.shipping],
    ['tax', totals.tax],
  ];

  return (
    <dl className="flex flex-col gap-2 text-sm">
      {rows.map(([key, money]) => (
        <div key={key} className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{t(key)}</dt>
          <dd>
            <Price value={money} locale={locale} />
          </dd>
        </div>
      ))}
      <div className="mt-2 flex justify-between gap-4 border-t border-border pt-3 text-base font-semibold">
        <dt>{t('total')}</dt>
        <dd>
          <Price value={totals.total} locale={locale} />
        </dd>
      </div>
    </dl>
  );
}

export function AddressCard({
  title,
  address,
}: {
  title: string;
  address: {
    first_name: string;
    last_name: string;
    company?: string | null;
    line1: string;
    line2?: string | null;
    postal_code: string;
    city: string;
    region?: string | null;
    country: string;
  };
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <h3 className="font-medium">{title}</h3>
      <address className="not-italic text-muted-foreground">
        {address.first_name} {address.last_name}
        <br />
        {address.company ? (
          <>
            {address.company}
            <br />
          </>
        ) : null}
        {address.line1}
        <br />
        {address.line2 ? (
          <>
            {address.line2}
            <br />
          </>
        ) : null}
        {address.postal_code} {address.city}
        {address.region ? `, ${address.region}` : ''}
        <br />
        {address.country}
      </address>
    </div>
  );
}
