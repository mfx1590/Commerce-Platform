'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { SelectField, TextField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  createShippingOptionAction,
  updateShippingOptionAction,
} from '@/app/actions/shipping-options';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { currencyDigits, formatMoney, formatMoneyInput } from '@/lib/forms/money';

type ShippingOption = AdminComponents['ShippingOption'];

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

/** The price field's hint: the money field's wording, so JPY says "whole units" (#810). */
function priceHint(currency: string): string {
  return `Amount in ${currency}${currencyDigits(currency) === 0 ? ', whole units' : ''}`;
}

// ---------------------------------------------------------------------------- readiness panel

/**
 * The readiness panel's "Create a shipping option for XX": one active, flat-priced (`manual`)
 * option for a market country the activation 409 named, in the store's default currency — the one
 * activation checks. `onCreated` lets the panel tick the country off.
 */
export function ShippingOptionQuickCreate({
  storeId,
  country,
  currency,
  onCreated,
}: {
  storeId: string;
  country: string;
  currency: string;
  onCreated: (country: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('Standard');
  const [price, setPrice] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    startTransition(async () => {
      const result = await createShippingOptionAction(storeId, {
        code: `standard-${country.toLowerCase()}`,
        name,
        price,
        currency,
        countries: country,
        is_active: true,
      });
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
      aria-label={`Create a shipping option for ${country}`}
      className="flex flex-wrap items-end gap-3"
    >
      <span className="font-mono text-sm">{country}</span>
      <TextField
        label="Option name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        error={failure?.fieldErrors?.['name']}
      />
      <TextField
        label={`Price (${currency})`}
        inputMode="decimal"
        value={price}
        hint={priceHint(currency)}
        onChange={(event) => setPrice(event.currentTarget.value)}
        error={failure?.fieldErrors?.['price'] ?? failure?.fieldErrors?.['code']}
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? 'Creating…' : `Create a shipping option for ${country}`}
      </Button>
      <div className="basis-full">
        <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------- store settings

function OptionRow({
  storeId,
  option,
  canManage,
  locale,
}: {
  storeId: string;
  option: ShippingOption;
  canManage: boolean;
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const currency = option.price.currency;
  const [name, setName] = useState(option.name);
  const [price, setPrice] = useState(formatMoneyInput(option.price.amount_minor, currency));
  const [countries, setCountries] = useState(option.countries.join(', '));
  const [failure, setFailure] = useState<Failure | null>(null);
  const label = `${option.name} (${option.code})`;
  const current = {
    name: option.name,
    price: option.price,
    countries: option.countries,
    is_active: option.is_active,
  };

  const save = (values: { name: string; price: string; countries: string; is_active: boolean }) =>
    startTransition(async () => {
      setFailure(null);
      const result = await updateShippingOptionAction(storeId, option.id, current, values);
      if (result.status === 'success') {
        setEditing(false);
        router.refresh();
        return;
      }
      setFailure(failureOf(result));
    });

  const unchanged = {
    name: option.name,
    price: formatMoneyInput(option.price.amount_minor, currency),
    countries: option.countries.join(', '),
  };

  return (
    <tr aria-label={`Shipping option ${label}`}>
      <td className="py-2 font-mono">{option.code}</td>
      {editing ? (
        <td colSpan={3}>
          <form
            aria-label={`Edit ${label}`}
            noValidate
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              save({ name, price, countries, is_active: option.is_active });
            }}
          >
            <TextField
              label="Name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              error={failure?.fieldErrors?.['name']}
            />
            <TextField
              label={`Price (${currency})`}
              inputMode="decimal"
              value={price}
              hint={priceHint(currency)}
              onChange={(event) => setPrice(event.currentTarget.value)}
              error={failure?.fieldErrors?.['price']}
            />
            <TextField
              label="Countries"
              hint="Two-letter codes, e.g. JP, KR"
              value={countries}
              onChange={(event) => setCountries(event.currentTarget.value)}
              error={failure?.fieldErrors?.['countries']}
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
          <td>{option.name}</td>
          <td className="font-mono">{formatMoney(option.price.amount_minor, currency, locale)}</td>
          <td className="font-mono">{option.countries.join(', ')}</td>
        </>
      )}
      <td>
        <Badge tone={option.is_active ? 'success' : 'neutral'}>
          {option.is_active ? 'active' : 'inactive'}
        </Badge>
      </td>
      <td className="space-y-1 text-right">
        {canManage && !editing && (
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
              disabled={pending}
              aria-label={`${option.is_active ? 'Deactivate' : 'Reactivate'} ${label}`}
              onClick={() => save({ ...unchanged, is_active: !option.is_active })}
            >
              {option.is_active ? 'Deactivate' : 'Reactivate'}
            </Button>
          </div>
        )}
        <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
      </td>
    </tr>
  );
}

/** The store's options: code, name, price, countries, state; Edit and (De)activate for store admins. */
export function ShippingOptionsTable({
  storeId,
  options,
  canManage,
  locale,
}: {
  storeId: string;
  options: readonly ShippingOption[];
  canManage: boolean;
  locale: string;
}) {
  if (options.length === 0) {
    return (
      <p className="text-muted text-sm">
        No shipping options yet: no cart can check out, and the store cannot be activated.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label="Shipping options">
        <thead className="text-muted text-left text-xs">
          <tr>
            <th className="py-1">Code</th>
            <th>Name</th>
            <th>Price</th>
            <th>Countries</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {options.map((option) => (
            <OptionRow
              key={option.id}
              storeId={storeId}
              option={option}
              canManage={canManage}
              locale={locale}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Add an option: code, name, price in the chosen store currency, countries. Active on creation. */
export function CreateShippingOptionForm({
  storeId,
  currencies,
  defaultCurrency,
  defaultCountry,
}: {
  storeId: string;
  currencies: readonly string[];
  defaultCurrency: string;
  defaultCountry: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [price, setPrice] = useState('');
  const [countries, setCountries] = useState(defaultCountry);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <form
      aria-label="Add a shipping option"
      noValidate
      className="border-line grid gap-3 border-t pt-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        setFailure(null);
        setDone(null);
        startTransition(async () => {
          const result = await createShippingOptionAction(storeId, {
            code,
            name,
            price,
            currency,
            countries,
            is_active: true,
          });
          if (result.status === 'success') {
            setDone(
              `Added ${result.data.name}: ${formatMoney(result.data.price.amount_minor, result.data.price.currency)} to ${result.data.countries.join(', ')}.`,
            );
            setCode('');
            setName('');
            setPrice('');
            router.refresh();
            return;
          }
          setFailure(failureOf(result));
        });
      }}
    >
      <TextField
        label="Code"
        hint="Short and unique in the store, e.g. standard"
        value={code}
        onChange={(event) => setCode(event.currentTarget.value)}
        error={failure?.fieldErrors?.['code']}
      />
      <TextField
        label="Name"
        hint="What the customer sees, e.g. Standard (2–4 days)"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        error={failure?.fieldErrors?.['name']}
      />
      <SelectField
        label="Currency"
        value={currency}
        onChange={(event) => setCurrency(event.currentTarget.value)}
        options={currencies.map((c) => ({ value: c, label: c }))}
        error={failure?.fieldErrors?.['currency']}
      />
      <TextField
        label={`Price (${currency})`}
        inputMode="decimal"
        value={price}
        hint={priceHint(currency)}
        onChange={(event) => setPrice(event.currentTarget.value)}
        error={failure?.fieldErrors?.['price']}
      />
      <TextField
        label="Countries"
        hint="Two-letter codes, e.g. JP, KR"
        value={countries}
        onChange={(event) => setCountries(event.currentTarget.value)}
        error={failure?.fieldErrors?.['countries']}
      />
      <div className="flex items-end">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add shipping option'}
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
