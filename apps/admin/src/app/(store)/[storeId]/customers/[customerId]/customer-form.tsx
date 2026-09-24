'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { SelectField, TextField, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import { ActionRefusal } from '@/components/states/action-refusal';
import { updateCustomerAction } from '@/app/actions/customers';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  CUSTOMER_EDITABLE_STATUSES,
  customerUpdateSchema,
  type CustomerUpdateValues,
} from '@/lib/forms/schemas';

type Customer = AdminComponents['Customer'];

/**
 * Name, phone, group and status. The props are exactly the fields the form shows — no email, no
 * consent, no identity — which is the rule for customer PII in client components.
 */
export function CustomerForm({
  storeId,
  customerId,
  defaultValues,
  statusEditable,
}: {
  storeId: string;
  customerId: string;
  defaultValues: CustomerUpdateValues;
  /** A guest has no status to choose; the select is offered only for registered/disabled. */
  statusEditable: boolean;
}) {
  const router = useRouter();
  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    CustomerUpdateValues,
    Customer
  >({
    schema: customerUpdateSchema,
    action: (values) => updateCustomerAction(storeId, customerId, values),
    defaultValues,
    onSuccess: () => router.refresh(),
  });
  const errors = form.formState.errors;

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Edit customer">
      <ActionRefusal refusal={refusal} message={formError} />
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <TextField
          label="First name"
          error={errorMessage(errors.first_name)}
          {...form.register('first_name')}
        />
        <TextField
          label="Last name"
          error={errorMessage(errors.last_name)}
          {...form.register('last_name')}
        />
        <TextField label="Phone" error={errorMessage(errors.phone)} {...form.register('phone')} />
        <TextField
          label="Customer group id"
          hint="A uuid; empty clears the group. A picker arrives with the customer-groups operation."
          error={errorMessage(errors.customer_group_id)}
          {...form.register('customer_group_id')}
        />
        {statusEditable && (
          <SelectField
            label="Status"
            options={CUSTOMER_EDITABLE_STATUSES.map((value) => ({ value, label: value }))}
            error={errorMessage(errors.status)}
            {...form.register('status')}
          />
        )}
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Save changes'}
      </Button>
    </form>
  );
}
