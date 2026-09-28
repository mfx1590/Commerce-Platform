'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useWatch } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Field, SelectField, TextField, errorMessage } from '@/components/form/fields';
import { MoneyField } from '@/components/form/money-field';
import { useContractForm } from '@/components/form/use-contract-form';
import { ActionRefusal } from '@/components/states/action-refusal';
import type { ActionResult } from '@/lib/forms/action-result';
import {
  PROMOTION_STATUSES,
  PROMOTION_TYPES,
  formatBp,
  parsePercent,
  promotionFormSchema,
  type PromotionFormValues,
} from '@/lib/promotions/form';

/**
 * Create and edit share this form. The two immutable fields (`code`, `type`) are inputs on
 * create and read-only text on edit — the contract's `PromotionPatch` has neither, so the update
 * action never sends them. The value input follows the type: a percentage (kept as basis points),
 * a money amount (minor units, `MoneyField`), nothing for free shipping, quantities for
 * buy-x-get-y. Stackable and exclusive are mutually exclusive in the UI, as they are in the
 * contract's semantics ("exclusive applies alone").
 */
export function PromotionForm({
  action,
  defaultValues,
  mode,
  submitLabel,
  redirectBase,
  storeCurrency,
}: {
  action: (values: PromotionFormValues) => Promise<ActionResult<{ id: string }>>;
  defaultValues: PromotionFormValues;
  mode: 'create' | 'edit';
  submitLabel: string;
  /** Create: the new promotion's id is appended and the browser navigates there. */
  redirectBase?: string;
  storeCurrency: string;
}) {
  const router = useRouter();
  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    PromotionFormValues,
    { id: string }
  >({
    schema: promotionFormSchema,
    action,
    defaultValues,
    onSuccess: (created) => {
      if (redirectBase !== undefined) router.push(`${redirectBase}/${created.id}`);
      else router.refresh();
    },
  });
  const errors = form.formState.errors;
  const type = useWatch({ control: form.control, name: 'type' });
  const currency = useWatch({ control: form.control, name: 'currency' }) || storeCurrency;
  const stackable = useWatch({ control: form.control, name: 'stackable' });
  const exclusive = useWatch({ control: form.control, name: 'exclusive' });
  const valueBp = useWatch({ control: form.control, name: 'value_bp' });
  const [percentText, setPercentText] = useState(valueBp === null ? '' : formatBp(valueBp));

  const numberField = (
    name: 'buy_quantity' | 'get_quantity' | 'usage_limit' | 'per_customer_limit',
    label: string,
    min = 0,
    hint?: string,
  ) => (
    <TextField
      label={label}
      type="number"
      min={min}
      {...(hint === undefined ? {} : { hint })}
      error={errorMessage(errors[name])}
      value={form.watch(name) ?? ''}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        form.setValue(name, raw === '' ? null : Number(raw), {
          shouldValidate: form.formState.isSubmitted,
        });
      }}
    />
  );

  return (
    <form
      onSubmit={submit}
      noValidate
      className="space-y-6"
      aria-label={mode === 'create' ? 'New promotion' : 'Edit promotion'}
    >
      <ActionRefusal refusal={refusal} message={formError} />

      <section className="grid max-w-3xl gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          required
          error={errorMessage(errors.name)}
          {...form.register('name')}
        />
        {mode === 'create' ? (
          <TextField
            label="Code"
            hint="Upper-case; leave empty for an automatic promotion. Cannot be changed later."
            error={errorMessage(errors.code)}
            {...form.register('code', {
              setValueAs: (value: string) => value.trim().toUpperCase(),
            })}
          />
        ) : (
          <div>
            <p className="text-sm font-medium">Code</p>
            <p className="font-mono text-sm">
              {defaultValues.code === '' ? 'automatic' : defaultValues.code}
            </p>
            <p className="text-muted text-xs">Immutable — create a new promotion to change it.</p>
          </div>
        )}
        {mode === 'create' ? (
          <SelectField
            label="Type"
            required
            options={PROMOTION_TYPES.map((value) => ({ value, label: value.replaceAll('_', ' ') }))}
            error={errorMessage(errors.type)}
            {...form.register('type')}
          />
        ) : (
          <div>
            <p className="text-sm font-medium">Type</p>
            <p className="text-sm">{defaultValues.type.replaceAll('_', ' ')}</p>
            <p className="text-muted text-xs">Immutable.</p>
          </div>
        )}
        <SelectField
          label="Status"
          options={PROMOTION_STATUSES.map((value) => ({ value, label: value }))}
          error={errorMessage(errors.status)}
          {...form.register('status')}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Value</h2>
        {type === 'percentage' && (
          <div className="max-w-xs">
            <TextField
              label="Percentage"
              required
              hint="Up to two decimals, e.g. 12.5 — stored as basis points."
              inputMode="decimal"
              value={percentText}
              error={errorMessage(errors.value_bp)}
              onChange={(event) => {
                const text = event.currentTarget.value;
                setPercentText(text);
                form.setValue('value_bp', parsePercent(text), {
                  shouldValidate: form.formState.isSubmitted,
                });
              }}
            />
          </div>
        )}
        {type === 'fixed_amount' && (
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <TextField
              label="Currency"
              required
              hint="Three-letter ISO code."
              error={errorMessage(errors.currency)}
              {...form.register('currency', {
                setValueAs: (value: string) => value.trim().toUpperCase(),
              })}
            />
            <MoneyField
              label="Amount"
              required
              currency={currency}
              valueMinor={form.watch('value_minor')}
              onChangeMinor={(amountMinor) =>
                form.setValue('value_minor', amountMinor, {
                  shouldValidate: form.formState.isSubmitted,
                })
              }
              error={errorMessage(errors.value_minor)}
            />
          </div>
        )}
        {type === 'free_shipping' && (
          <p className="text-muted text-sm">
            Free shipping has no value of its own; the conditions below decide when it applies.
          </p>
        )}
        {type === 'buy_x_get_y' && (
          <div className="grid max-w-2xl gap-4 sm:grid-cols-3">
            {numberField('buy_quantity', 'Buy', 1, 'Units that must be bought')}
            {numberField('get_quantity', 'Get', 1, 'Units discounted per bundle')}
            <TextField
              label="Discount on the free units"
              hint="Percent; 100 = free."
              inputMode="decimal"
              value={percentText}
              error={errorMessage(errors.get_discount_bp)}
              onChange={(event) => {
                const text = event.currentTarget.value;
                setPercentText(text);
                form.setValue('get_discount_bp', parsePercent(text), {
                  shouldValidate: form.formState.isSubmitted,
                });
              }}
            />
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Conditions</h2>
        <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
          <MoneyField
            label="Minimum subtotal"
            currency={currency}
            valueMinor={form.watch('min_subtotal_minor')}
            onChangeMinor={(amountMinor) =>
              form.setValue('min_subtotal_minor', amountMinor, {
                shouldValidate: form.formState.isSubmitted,
              })
            }
            error={errorMessage(errors.min_subtotal_minor)}
          />
          <Field label="First order only" htmlFor="first-order-only">
            <input id="first-order-only" type="checkbox" {...form.register('first_order_only')} />
          </Field>
          <TextField
            label="Product ids"
            hint="Comma-separated uuids."
            error={errorMessage(errors.product_ids)}
            {...form.register('product_ids')}
          />
          <TextField
            label="Category ids"
            hint="Comma-separated uuids."
            error={errorMessage(errors.category_ids)}
            {...form.register('category_ids')}
          />
          <TextField
            label="Customer group ids"
            hint="Comma-separated uuids."
            error={errorMessage(errors.customer_group_ids)}
            {...form.register('customer_group_ids')}
          />
          <TextField
            label="Sales channel ids"
            hint="Comma-separated uuids."
            error={errorMessage(errors.sales_channel_ids)}
            {...form.register('sales_channel_ids')}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Limits, schedule and combining</h2>
        <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
          {numberField('usage_limit', 'Usage limit', 0, 'Empty = unlimited')}
          {numberField('per_customer_limit', 'Per-customer limit', 0, 'Empty = unlimited')}
          <TextField
            label="Starts"
            type="datetime-local"
            error={errorMessage(errors.starts_at)}
            {...form.register('starts_at')}
          />
          <TextField
            label="Ends"
            type="datetime-local"
            error={errorMessage(errors.ends_at)}
            {...form.register('ends_at')}
          />
          <Field
            label="Stackable"
            htmlFor="stackable"
            hint="May combine with other stackable promotions."
            error={errorMessage(errors.stackable)}
          >
            <input
              id="stackable"
              type="checkbox"
              disabled={exclusive}
              {...form.register('stackable')}
            />
          </Field>
          <Field
            label="Exclusive"
            htmlFor="exclusive"
            hint="Applies alone; the best exclusive wins over everything else."
            error={errorMessage(errors.exclusive)}
          >
            <input
              id="exclusive"
              type="checkbox"
              disabled={stackable}
              {...form.register('exclusive')}
            />
          </Field>
        </div>
      </section>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
