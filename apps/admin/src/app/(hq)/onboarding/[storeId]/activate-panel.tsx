'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import { activateStoreAction } from '@/app/actions/stores';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { MISSING_LABELS } from '@/lib/onboarding';
import { TaxRateQuickCreate } from '@/components/tax-rates/tax-rate-forms';
import { ShippingOptionQuickCreate } from '@/components/shipping-options/shipping-option-forms';

/** A relation the reader lacks for one inline form, named rather than hidden (as on Settings). */
function Needs({ storeId, to }: { storeId: string; to: string }) {
  return (
    <p className="text-muted text-sm">
      {to} needs <span className="font-mono">store_admin</span> on{' '}
      <span className="font-mono">store:{storeId}</span>.
    </p>
  );
}

/**
 * The readiness panel's Activate (`activateStore`, owner on hq). What is missing is exactly what
 * the core says in the 409's `details.missing` — the panel lists that, no guess of its own; an
 * empty list is an activation. Missing `tax_rates` (#520) comes with the uncovered market countries
 * (`details.missing_tax_countries`), missing `shipping_options` (#809) with the countries that have
 * no active option in the store currency (`details.missing_shipping_countries`): each country gets
 * an inline create, ticked off once created; Activate is then pressed again and the core re-checks.
 * The inline creates are offered only with `store_admin` on the store (`canCreateTax` /
 * `canCreateShipping`, decided on the server); their actions refuse below it regardless.
 */
export function ActivatePanel({
  storeId,
  status,
  defaultCurrency,
  canCreateTax,
  canCreateShipping,
}: {
  storeId: string;
  status: string;
  defaultCurrency: string;
  canCreateTax: boolean;
  canCreateShipping: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [missing, setMissing] = useState<string[] | null>(null);
  const [taxCountries, setTaxCountries] = useState<string[]>([]);
  const [shippingCountries, setShippingCountries] = useState<string[]>([]);
  const [covered, setCovered] = useState<ReadonlySet<string>>(new Set());
  const [shipped, setShipped] = useState<ReadonlyMap<string, string>>(new Map());
  const [failure, setFailure] = useState<{
    message: string | null;
    refusal?: ActionRefusalInfo | undefined;
  } | null>(null);

  if (status === 'active') {
    return (
      <p role="status" className="text-success text-sm">
        Active — the store is live.
      </p>
    );
  }

  const label = (item: string) =>
    item === 'tax_rates' && taxCountries.length > 0
      ? `a tax rate for ${taxCountries.join(', ')}`
      : item === 'shipping_options' && shippingCountries.length > 0
        ? `a shipping option for ${shippingCountries.join(', ')}`
        : (MISSING_LABELS[item] ?? item);

  return (
    <div className="space-y-3">
      {missing !== null && missing.length > 0 && (
        <div
          role="alert"
          className="border-warning/30 bg-warning/5 rounded-md border px-3 py-2 text-sm"
        >
          <p className="font-medium">Not ready to activate. Missing:</p>
          <ul className="list-disc pl-5" aria-label="Missing prerequisites">
            {missing.map((item) => (
              <li key={item}>{label(item)}</li>
            ))}
          </ul>
        </div>
      )}
      {missing !== null && missing.includes('tax_rates') && taxCountries.length > 0 && (
        <section aria-label="Tax rates to create" className="space-y-3">
          <h3 className="text-sm font-semibold">Tax rates</h3>
          <p className="text-muted text-sm">
            Each country the store sells to needs a rate before the store can go live; without one,
            orders there would be taxed at 0%.
          </p>
          {!canCreateTax ? (
            <Needs storeId={storeId} to="Creating tax rates" />
          ) : (
            taxCountries.map((country) =>
              covered.has(country) ? (
                <p key={country} role="status" className="text-success text-sm">
                  {country}: rate created.
                </p>
              ) : (
                <TaxRateQuickCreate
                  key={country}
                  storeId={storeId}
                  country={country}
                  onCreated={(c) => setCovered((prev) => new Set([...prev, c]))}
                />
              ),
            )
          )}
          {canCreateTax && taxCountries.every((c) => covered.has(c)) && (
            <p className="text-sm">Every listed country has a rate now — activate again.</p>
          )}
        </section>
      )}
      {missing !== null && missing.includes('shipping_options') && shippingCountries.length > 0 && (
        <section aria-label="Shipping options to create" className="space-y-3">
          <h3 className="text-sm font-semibold">Shipping options</h3>
          <p className="text-muted text-sm">
            Each country the store sells to needs an active shipping option in {defaultCurrency}{' '}
            before the store can go live; without one, no cart there can check out. More options,
            and editing them, are on the store&apos;s{' '}
            <Link
              href={`/${storeId}/settings#shipping-options`}
              className="text-accent hover:underline"
            >
              Settings › Shipping options
            </Link>
            .
          </p>
          {!canCreateShipping ? (
            <Needs storeId={storeId} to="Creating shipping options" />
          ) : (
            shippingCountries.map((country) =>
              shipped.has(country) ? (
                <p key={country} role="status" className="text-success text-sm">
                  {shipped.get(country)}
                </p>
              ) : (
                <ShippingOptionQuickCreate
                  key={country}
                  storeId={storeId}
                  country={country}
                  currency={defaultCurrency}
                  onCreated={(c, done) => setShipped((prev) => new Map(prev).set(c, done))}
                />
              ),
            )
          )}
          {canCreateShipping && shippingCountries.every((c) => shipped.has(c)) && (
            <p className="text-sm">
              Every listed country has a shipping option now — activate again.
            </p>
          )}
        </section>
      )}
      <ActionRefusal
        refusal={failure?.refusal}
        message={missing === null ? (failure?.message ?? null) : null}
      />
      <Button
        disabled={pending}
        onClick={() => {
          setFailure(null);
          startTransition(async () => {
            const result = await activateStoreAction(storeId);
            if (result.status === 'success') {
              setMissing(null);
              router.refresh();
              return;
            }
            setMissing(result.missing ?? null);
            setTaxCountries(result.missingTaxCountries ?? []);
            setShippingCountries(result.missingShippingCountries ?? []);
            setCovered(new Set());
            setShipped(new Map());
            setFailure({ message: result.formError, refusal: result.refusal });
          });
        }}
      >
        {pending ? 'Activating…' : 'Activate'}
      </Button>
    </div>
  );
}
