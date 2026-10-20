'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import { activateStoreAction } from '@/app/actions/stores';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { MISSING_LABELS } from '@/lib/onboarding';
import { TaxRateQuickCreate } from '@/components/tax-rates/tax-rate-forms';

/**
 * The readiness panel's Activate (`activateStore`, owner on hq). What is missing is exactly what
 * the core says in the 409's `details.missing` — the panel lists that, no guess of its own; an
 * empty list is an activation. Missing `tax_rates` (#520) comes with the uncovered market countries
 * (`details.missing_tax_countries`): each gets a "Create a rate for XX" form, ticked off once
 * created; Activate is then pressed again and the core re-checks.
 */
export function ActivatePanel({ storeId, status }: { storeId: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [missing, setMissing] = useState<string[] | null>(null);
  const [taxCountries, setTaxCountries] = useState<string[]>([]);
  const [covered, setCovered] = useState<ReadonlySet<string>>(new Set());
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
              <li key={item}>
                {item === 'tax_rates' && taxCountries.length > 0
                  ? `a tax rate for ${taxCountries.join(', ')}`
                  : (MISSING_LABELS[item] ?? item)}
              </li>
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
          {taxCountries.map((country) =>
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
          )}
          {taxCountries.every((c) => covered.has(c)) && (
            <p className="text-sm">Every listed country has a rate now — activate again.</p>
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
            setCovered(new Set());
            setFailure({ message: result.formError, refusal: result.refusal });
          });
        }}
      >
        {pending ? 'Activating…' : 'Activate'}
      </Button>
    </div>
  );
}
