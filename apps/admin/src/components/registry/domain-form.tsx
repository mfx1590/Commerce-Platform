'use client';

import { Button } from '@/components/ui/button';
import { TextField, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import { ActionRefusal } from '@/components/states/action-refusal';
import { addDomainAction } from '@/app/actions/stores';
import type { AdminComponents } from '@/lib/api/admin-client';
import { domainCreateSchema, type DomainCreateValues } from '@/lib/forms/schemas';

type Domain = AdminComponents['Domain'];

/**
 * `addDomain` — owner on organization:hq. Offered only to an owner; the list beside it is rendered
 * on the server and refreshes when the action revalidates.
 */
export function AddDomainForm({ storeId }: { storeId: string }) {
  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    DomainCreateValues,
    Domain
  >({
    schema: domainCreateSchema,
    action: (values) => addDomainAction(storeId, values),
    defaultValues: { hostname: '', is_primary: false },
    onSuccess: () => form.reset({ hostname: '', is_primary: false }),
  });

  return (
    <form
      onSubmit={submit}
      noValidate
      className="border-line space-y-3 border-t pt-4"
      aria-label="Add domain"
    >
      <ActionRefusal refusal={refusal} message={formError} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64">
          <TextField
            label="Hostname"
            required
            hint="No scheme and no path, e.g. shop.brand-a.com"
            error={errorMessage(form.formState.errors.hostname)}
            {...form.register('hostname')}
          />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" {...form.register('is_primary')} />
          Make primary
        </label>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Adding…' : 'Add domain'}
        </Button>
      </div>
    </form>
  );
}
