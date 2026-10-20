'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { SelectField, TextField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import { Button } from '@/components/ui/button';
import {
  createTaxRateAction,
  deleteTaxRateAction,
  updateTaxRateAction,
} from '@/app/actions/tax-rates';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { formatRate } from '@/lib/tax-rates';

type TaxRate = AdminComponents['TaxRate'];

interface Failure {
  message: string | null;
  refusal?: ActionRefusalInfo | undefined;
  fieldErrors?: Readonly<Record<string, string>>;
}

function failureOf(result: {
  formError: string | null;
  refusal?: ActionRefusalInfo | undefined;
  fieldErrors: Readonly<Record<string, string>>;
}): Failure {
  return { message: result.formError, refusal: result.refusal, fieldErrors: result.fieldErrors };
}

/** "2100 bp = 21%" under the rate field, as the reader types. */
function rateHint(value: string): string {
  return /^\d+$/.test(value.trim())
    ? `${value.trim()} bp = ${formatRate(Number(value))}`
    : 'Basis points: 2100 = 21%.';
}

// ---------------------------------------------------------------------------- readiness panel

/**
 * The readiness panel's "Create a rate for XX": one country-wide, all-categories rate for a market
 * country the activation 409 named. `onCreated` lets the panel tick the country off.
 */
export function TaxRateQuickCreate({
  storeId,
  country,
  onCreated,
}: {
  storeId: string;
  country: string;
  onCreated: (country: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('VAT');
  const [rate, setRate] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    startTransition(async () => {
      const result = await createTaxRateAction(storeId, { country, name, rate_bp: rate });
      if (result.status === 'success') {
        onCreated(country);
        return;
      }
      setFailure(failureOf(result));
    });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Create a rate for ${country}`}
      className="flex flex-wrap items-end gap-3"
    >
      <span className="font-mono text-sm">{country}</span>
      <TextField
        label="Rate name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        error={failure?.fieldErrors?.['name']}
      />
      <TextField
        label="Rate (basis points)"
        inputMode="numeric"
        value={rate}
        hint={rateHint(rate)}
        onChange={(event) => setRate(event.currentTarget.value)}
        error={failure?.fieldErrors?.['rate_bp']}
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? 'Creating…' : `Create a rate for ${country}`}
      </Button>
      <div className="basis-full">
        <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------- store settings

function RateRow({
  storeId,
  rate,
  canManage,
  categoryName,
}: {
  storeId: string;
  rate: TaxRate;
  canManage: boolean;
  categoryName: (id: string) => string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState(rate.name);
  const [bp, setBp] = useState(String(rate.rate_bp));
  const [failure, setFailure] = useState<Failure | null>(null);
  const label = `${rate.name} (${rate.country}${rate.region === null ? '' : `-${rate.region}`})`;

  return (
    <tr aria-label={`Tax rate ${label}`}>
      <td className="py-2 font-mono">{rate.country}</td>
      <td>{rate.region ?? <span className="text-muted">country-wide</span>}</td>
      <td>
        {rate.product_category_id === null ? (
          <span className="text-muted">all</span>
        ) : (
          categoryName(rate.product_category_id)
        )}
      </td>
      {editing ? (
        <td colSpan={2}>
          <form
            aria-label={`Edit ${label}`}
            noValidate
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setFailure(null);
              startTransition(async () => {
                const result = await updateTaxRateAction(storeId, rate.id, { name, rate_bp: bp });
                if (result.status === 'success') {
                  setEditing(false);
                  router.refresh();
                  return;
                }
                setFailure(failureOf(result));
              });
            }}
          >
            <TextField
              label="Name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              error={failure?.fieldErrors?.['name']}
            />
            <TextField
              label="Rate (basis points)"
              inputMode="numeric"
              value={bp}
              hint={rateHint(bp)}
              onChange={(event) => setBp(event.currentTarget.value)}
              error={failure?.fieldErrors?.['rate_bp']}
            />
            <Button type="submit" size="sm" disabled={pending}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </form>
        </td>
      ) : (
        <>
          <td>{rate.name}</td>
          <td className="font-mono">
            {rate.rate_bp} bp <span className="text-muted">({formatRate(rate.rate_bp)})</span>
          </td>
        </>
      )}
      <td className="space-y-1 text-right">
        {canManage && !editing && !asking && (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Edit ${label}`}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Delete ${label}`}
              onClick={() => setAsking(true)}
            >
              Delete
            </Button>
          </div>
        )}
        {asking && (
          <div
            role="alertdialog"
            aria-label={`Confirm deleting ${label}`}
            className="border-warning/30 bg-warning/5 space-y-2 rounded-md border px-3 py-2 text-left"
          >
            <p className="text-sm">
              Delete <span className="font-medium">{label}</span>? Orders shipping to {rate.country}{' '}
              then use the next matching rate, or 0% if none is left.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    setFailure(null);
                    const result = await deleteTaxRateAction(storeId, rate.id);
                    setAsking(false);
                    if (result.status === 'success') {
                      router.refresh();
                      return;
                    }
                    setFailure(failureOf(result));
                  })
                }
              >
                {pending ? 'Deleting…' : 'Yes, delete'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => setAsking(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
      </td>
    </tr>
  );
}

export interface CategoryOption {
  id: string;
  name: string;
}

/** The store's rates: country, region, category, name, rate; Edit and Delete for store admins. */
export function TaxRatesTable({
  storeId,
  rates,
  canManage,
  categories,
}: {
  storeId: string;
  rates: readonly TaxRate[];
  canManage: boolean;
  categories: readonly CategoryOption[];
}) {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const categoryName = (id: string) => names.get(id) ?? id.slice(0, 8);
  if (rates.length === 0) {
    return (
      <p className="text-muted text-sm">
        No tax rates yet: every order is taxed at 0%, and the store cannot be activated.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label="Tax rates">
        <thead className="text-muted text-left text-xs">
          <tr>
            <th className="py-1">Country</th>
            <th>Region</th>
            <th>Category</th>
            <th>Name</th>
            <th>Rate</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {rates.map((rate) => (
            <RateRow
              key={rate.id}
              storeId={storeId}
              rate={rate}
              canManage={canManage}
              categoryName={categoryName}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Add a rate: country, optional region, optional category, name, basis points. */
export function CreateTaxRateForm({
  storeId,
  defaultCountry,
  categories,
}: {
  storeId: string;
  defaultCountry: string;
  categories: readonly CategoryOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [country, setCountry] = useState(defaultCountry);
  const [region, setRegion] = useState('');
  const [category, setCategory] = useState('');
  const [name, setName] = useState('VAT');
  const [rate, setRate] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <form
      aria-label="Add a tax rate"
      noValidate
      className="border-line grid gap-3 border-t pt-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        setFailure(null);
        setDone(null);
        startTransition(async () => {
          const result = await createTaxRateAction(storeId, {
            country,
            region,
            product_category_id: category,
            name,
            rate_bp: rate,
          });
          if (result.status === 'success') {
            setDone(
              `Added ${result.data.name} for ${result.data.country} (${formatRate(result.data.rate_bp)}).`,
            );
            setRate('');
            router.refresh();
            return;
          }
          setFailure(failureOf(result));
        });
      }}
    >
      <TextField
        label="Country"
        value={country}
        maxLength={2}
        onChange={(event) => setCountry(event.currentTarget.value)}
        error={failure?.fieldErrors?.['country']}
      />
      <TextField
        label="Region (optional)"
        hint="e.g. a US state code; empty = the whole country"
        value={region}
        onChange={(event) => setRegion(event.currentTarget.value)}
        error={failure?.fieldErrors?.['region']}
      />
      <SelectField
        label="Category (optional)"
        value={category}
        onChange={(event) => setCategory(event.currentTarget.value)}
        options={[
          { value: '', label: 'All products' },
          ...categories.map((c) => ({ value: c.id, label: c.name })),
        ]}
        error={failure?.fieldErrors?.['product_category_id']}
      />
      <TextField
        label="Name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        error={failure?.fieldErrors?.['name']}
      />
      <TextField
        label="Rate (basis points)"
        inputMode="numeric"
        value={rate}
        hint={rateHint(rate)}
        onChange={(event) => setRate(event.currentTarget.value)}
        error={failure?.fieldErrors?.['rate_bp']}
      />
      <div className="flex items-end">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add rate'}
        </Button>
      </div>
      <div className="sm:col-span-3">
        {done !== null && (
          <p role="status" className="text-success text-sm">
            {done}
          </p>
        )}
        <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
      </div>
    </form>
  );
}
