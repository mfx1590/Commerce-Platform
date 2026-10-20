'use client';

import { Button } from '@platform/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  updateConsentsAction,
  type AccountActionState,
} from '@/app/[locale]/(account)/account/actions';
import type { StoreComponents } from '@platform/contracts';

type CustomerConsent = StoreComponents['schemas']['CustomerConsent'];

const EMPTY: AccountActionState = {};

function Notice({ state, success }: { state: AccountActionState; success: string }) {
  if (state.error !== undefined) {
    return (
      <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
        {state.error}
      </p>
    );
  }
  if (state.ok === true) {
    return (
      <p role="status" className="rounded-md border border-success p-3 text-sm text-success">
        {success}
      </p>
    );
  }
  return null;
}

function Pending({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending}>
      {children}
    </Button>
  );
}

/**
 * "Your consents" (#471, Store API 0.5.7 `getMyConsents` / `putMyConsents`): one row per purpose of the closed
 * set with its current state — never asked, granted on a date, declined on a date — and a checkbox to answer. The
 * form carries the privacy-policy version the page displays (`policyVersion`, a hidden field): the API records
 * the version the customer SAW, not the store's current one. Copy from the `account.consents` catalog.
 */
export function ConsentsForm({
  items,
  policyVersion,
}: {
  items: CustomerConsent[];
  policyVersion: string;
}) {
  const t = useTranslations('account.consents');
  const locale = useLocale();
  const [state, formAction] = useActionState(updateConsentsAction, EMPTY);
  const date = (iso: string | null) =>
    iso === null ? '' : new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-3" aria-label={t('title')}>
      <h3 className="text-lg font-semibold">{t('title')}</h3>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <Notice state={state} success={t('saved')} />
      <input type="hidden" name="policy_version" value={policyVersion} />
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.purpose} className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={item.purpose}
                defaultChecked={item.granted === true}
                className="h-4 w-4"
              />
              {t(`purpose.${item.purpose}`)}
            </label>
            <p className="text-xs text-muted-foreground">
              {item.granted === null
                ? t('neverAsked')
                : item.granted
                  ? t('granted', { date: date(item.recorded_at) })
                  : t('declined', { date: date(item.recorded_at) })}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('policy', { version: policyVersion })}</p>
      <div>
        <Pending>{t('save')}</Pending>
      </div>
    </form>
  );
}
