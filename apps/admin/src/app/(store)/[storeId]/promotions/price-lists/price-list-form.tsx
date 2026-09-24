'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { SelectField, TextField, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import { ActionRefusal } from '@/components/states/action-refusal';
import { createPriceListAction } from '@/app/actions/pricing';
import {
  PRICE_LIST_STATUSES,
  PRICE_LIST_TYPES,
  priceListCreateSchema,
  type PriceListCreateValues,
} from '@/lib/forms/schemas';

/** `createPriceList`, then straight to the new list's prices editor. */
export function PriceListForm({
  storeId,
  defaultCurrency,
}: {
  storeId: string;
  defaultCurrency: string;
}) {
  const router = useRouter();
  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    PriceListCreateValues,
    { id: string }
  >({
    schema: priceListCreateSchema,
    action: (values) => createPriceListAction(storeId, values),
    defaultValues: {
      code: '',
      name: '',
      type: 'sale',
      currency: defaultCurrency,
      customer_group_id: '',
      sales_channel_id: '',
      starts_at: '',
      ends_at: '',
      status: 'draft',
      priority: 10,
    },
    onSuccess: (created) => router.push(`/${storeId}/promotions/price-lists/${created.id}`),
  });
  const errors = form.formState.errors;

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="New price list">
      <ActionRefusal refusal={refusal} message={formError} />
      <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          required
          error={errorMessage(errors.name)}
          {...form.register('name')}
        />
        <TextField
          label="Code"
          required
          hint="Lower-case and hyphenated."
          error={errorMessage(errors.code)}
          {...form.register('code')}
        />
        <SelectField
          label="Type"
          options={PRICE_LIST_TYPES.map((value) => ({ value, label: value }))}
          error={errorMessage(errors.type)}
          {...form.register('type')}
        />
        <TextField
          label="Currency"
          required
          hint="Three-letter ISO code."
          error={errorMessage(errors.currency)}
          {...form.register('currency', {
            setValueAs: (value: string) => value.trim().toUpperCase(),
          })}
        />
        <TextField
          label="Customer group id"
          hint="Optional uuid."
          error={errorMessage(errors.customer_group_id)}
          {...form.register('customer_group_id')}
        />
        <TextField
          label="Sales channel id"
          hint="Optional uuid."
          error={errorMessage(errors.sales_channel_id)}
          {...form.register('sales_channel_id')}
        />
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
        <SelectField
          label="Status"
          options={PRICE_LIST_STATUSES.map((value) => ({ value, label: value }))}
          error={errorMessage(errors.status)}
          {...form.register('status')}
        />
        <TextField
          label="Priority"
          type="number"
          min={0}
          hint="Higher wins when lists overlap."
          error={errorMessage(errors.priority)}
          {...form.register('priority', { valueAsNumber: true })}
        />
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Creating…' : 'Create price list'}
      </Button>
    </form>
  );
}
