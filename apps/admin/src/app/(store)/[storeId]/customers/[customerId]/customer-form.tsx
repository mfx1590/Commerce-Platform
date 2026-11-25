'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { SelectField, TextField, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import { ActionRefusal } from '@/components/states/action-refusal';
import { updateCustomerAction } from '@/app/actions/customers';
import {
  CUSTOMER_EDITABLE_STATUSES,
  customerUpdateSchema,
  type CustomerUpdateValues,
} from '@/lib/forms/schemas';

/**
 * Name, phone, group and status. The props are exactly the fields the form shows — no email, no
 * consent, no identity — which is the rule for customer PII in client components.
 */
export function CustomerForm({
  storeId,
  customerId,
  defaultValues,
  statusEditable,
  groupOptions = [],
}: {
  storeId: string;
  customerId: string;
  defaultValues: CustomerUpdateValues;
  /** A guest has no status to choose; the select is offered only for registered/disabled. */
  statusEditable: boolean;
  /**
   * The store's groups, resolved on the server (#870 item 4). Names, not personal data. Empty when
   * the groups read failed — the field then falls back to the id box rather than offering nothing.
   */
  groupOptions?: readonly { value: string; label: string }[];
}) {
  const router = useRouter();
  // The action answers with no record: a server action's result is client-side data too, and the
  // form only needs to know the save happened before it refreshes.
  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    CustomerUpdateValues,
    null
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
        {/*
          A specialist assigns a group by name, not by pasting a uuid (#870: "the most advanced
          features a specialist can use"). The schema is unchanged — a uuid or '' — so the server
          action and its `refuseUnlessPermitted('updateCustomer', storeId)` check are untouched, and
          '' still means "clear the group". If the groups could not be read the id box comes back,
          because a select with no options would make an existing group unchangeable.
        */}
        {groupOptions.length > 0 ? (
          <SelectField
            label="Customer group"
            hint="Assigning a group is an update to the customer, checked against support on this store."
            options={[{ value: '', label: 'No group' }, ...groupOptions]}
            error={errorMessage(errors.customer_group_id)}
            {...form.register('customer_group_id')}
          />
        ) : (
          <TextField
            label="Customer group id"
            hint="The group list could not be read, so this takes the group's id (a uuid); empty clears the group."
            error={errorMessage(errors.customer_group_id)}
            {...form.register('customer_group_id')}
          />
        )}
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
