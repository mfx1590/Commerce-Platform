'use client';

import { Button } from '@/components/ui/button';
import { SelectField, TextField, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import { ActionRefusal } from '@/components/states/action-refusal';
import { createSalesChannelAction } from '@/app/actions/stores';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  SALES_CHANNEL_TYPES,
  salesChannelCreateSchema,
  type SalesChannelCreateValues,
} from '@/lib/forms/schemas';

type SalesChannel = AdminComponents['SalesChannel'];

const EMPTY: SalesChannelCreateValues = { code: '', name: '', type: 'web' };

/** `createSalesChannel` — store_admin on the store. */
export function CreateSalesChannelForm({ storeId }: { storeId: string }) {
  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    SalesChannelCreateValues,
    SalesChannel
  >({
    schema: salesChannelCreateSchema,
    action: (values) => createSalesChannelAction(storeId, values),
    defaultValues: EMPTY,
    onSuccess: () => form.reset(EMPTY),
  });
  const errors = form.formState.errors;

  return (
    <form
      onSubmit={submit}
      noValidate
      className="border-line space-y-3 border-t pt-4"
      aria-label="New sales channel"
    >
      <ActionRefusal refusal={refusal} message={formError} />
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          label="Name"
          required
          error={errorMessage(errors.name)}
          {...form.register('name')}
        />
        <TextField
          label="Code"
          required
          hint="e.g. web-eu"
          error={errorMessage(errors.code)}
          {...form.register('code')}
        />
        <SelectField
          label="Type"
          required
          options={SALES_CHANNEL_TYPES.map((type) => ({ value: type, label: type }))}
          error={errorMessage(errors.type)}
          {...form.register('type')}
        />
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Creating…' : 'Create channel'}
      </Button>
    </form>
  );
}
