'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { FormError, SelectField, TextField, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionResult } from '@/lib/forms/action-result';
import { STORE_STATUSES, storeCreateSchema, type StoreCreateValues } from '@/lib/forms/schemas';

type Store = AdminComponents['Store'];
type LegalEntity = AdminComponents['LegalEntity'];

const STATUS_OPTIONS = STORE_STATUSES.map((status) => ({ value: status, label: status }));

/**
 * One form for creating and editing a store. Both hit the same fields, so splitting them would only
 * duplicate the validation; what differs is the action and where success goes.
 *
 * `legalEntities` may be empty: `listLegalEntities` needs `finance` on `organization:hq`, and a
 * principal who may create a store need not have it. Rather than showing an empty select that
 * cannot be satisfied, the field falls back to accepting the id directly.
 */
export function StoreForm({
  action,
  defaultValues,
  legalEntities,
  submitLabel,
  redirectBase,
}: {
  action: (values: StoreCreateValues) => Promise<ActionResult<Store>>;
  defaultValues: StoreCreateValues;
  legalEntities: readonly LegalEntity[];
  submitLabel: string;
  /**
   * Where to go after a create, as a path prefix — the new id is appended here. A callback would be
   * a plain function crossing the server/client boundary, which React refuses; only a server action
   * may cross it, and only as a bound reference.
   */
  redirectBase?: string;
}) {
  const router = useRouter();
  const { form, submit, formError, isSubmitting } = useContractForm<StoreCreateValues, Store>({
    schema: storeCreateSchema,
    action,
    defaultValues,
    onSuccess: (store) => {
      if (redirectBase !== undefined) router.push(`${redirectBase}/${store.id}`);
      else router.refresh();
    },
  });

  const errors = form.formState.errors;

  return (
    <form onSubmit={submit} noValidate className="max-w-2xl space-y-4">
      <FormError message={formError} />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          required
          hint="How the brand is referred to in HQ."
          error={errorMessage(errors.name)}
          {...form.register('name')}
        />
        <TextField
          label="Code"
          required
          hint="Lower-case and hyphenated, e.g. brand-a. Used in URLs and index names."
          error={errorMessage(errors.code)}
          {...form.register('code')}
        />

        {legalEntities.length > 0 ? (
          <SelectField
            label="Legal entity"
            required
            error={errorMessage(errors.legal_entity_id)}
            options={legalEntities.map((entity) => ({
              value: entity.id,
              label: `${entity.name} (${entity.country})`,
            }))}
            {...form.register('legal_entity_id')}
          />
        ) : (
          <TextField
            label="Legal entity id"
            required
            hint="Listing entities needs finance on organization:hq; paste the id instead."
            error={errorMessage(errors.legal_entity_id)}
            {...form.register('legal_entity_id')}
          />
        )}

        <SelectField
          label="Status"
          required
          options={STATUS_OPTIONS}
          error={errorMessage(errors.status)}
          {...form.register('status')}
        />

        <TextField
          label="Default currency"
          required
          hint="Three-letter ISO code, e.g. EUR."
          error={errorMessage(errors.default_currency)}
          {...form.register('default_currency')}
        />
        <TextField
          label="Default country"
          required
          hint="Two-letter ISO code, e.g. NL."
          error={errorMessage(errors.default_country)}
          {...form.register('default_country')}
        />
        <TextField
          label="Default locale"
          required
          hint="e.g. en-GB"
          error={errorMessage(errors.default_locale)}
          {...form.register('default_locale')}
        />
        <TextField
          label="Timezone"
          required
          hint="e.g. Europe/Amsterdam"
          error={errorMessage(errors.timezone)}
          {...form.register('timezone')}
        />
      </div>

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
