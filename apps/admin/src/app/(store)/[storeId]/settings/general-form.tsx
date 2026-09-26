'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { SelectField, TextField, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import { ActionRefusal } from '@/components/states/action-refusal';
import { updateStoreSettingsAction } from '@/app/actions/stores';
import type { AdminComponents } from '@/lib/api/admin-client';
import { STORE_STATUSES, storeSettingsSchema, type StoreSettingsValues } from '@/lib/forms/schemas';
import { statusChangeQuestion, type StoreSettingsDefaults } from '@/lib/settings';

/**
 * `updateStore` for the store's own name, status and defaults (store_admin). A move to `paused`
 * or `archived` takes the storefront offline, so Save asks first and only the confirmation sends.
 */
export function GeneralSettingsForm({
  storeId,
  current,
}: {
  storeId: string;
  current: StoreSettingsDefaults;
}) {
  const defaults: StoreSettingsValues = {
    name: current.name,
    status: current.status,
    default_currency: current.default_currency,
    default_locale: current.default_locale,
    default_country: current.default_country,
    timezone: current.timezone,
  };
  const [question, setQuestion] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    StoreSettingsValues,
    AdminComponents['Store']
  >({
    schema: storeSettingsSchema,
    action: (values) => updateStoreSettingsAction(storeId, values),
    defaultValues: defaults,
    onSuccess: () => setSaved(true),
  });
  const errors = form.formState.errors;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    const ask = statusChangeQuestion(current.status, form.getValues('status'));
    if (ask !== null) {
      setQuestion(ask);
      return;
    }
    void submit();
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label="General settings">
      <ActionRefusal refusal={refusal} message={formError} />
      <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          required
          error={errorMessage(errors.name)}
          {...form.register('name')}
        />
        <SelectField
          label="Status"
          options={STORE_STATUSES.map((value) => ({ value, label: value }))}
          error={errorMessage(errors.status)}
          {...form.register('status', { onChange: () => setQuestion(null) })}
        />
        <TextField
          label="Default currency"
          required
          hint="Three-letter ISO code."
          error={errorMessage(errors.default_currency)}
          {...form.register('default_currency', {
            setValueAs: (value: string) => value.trim().toUpperCase(),
          })}
        />
        <TextField
          label="Default locale"
          required
          hint="e.g. en-GB"
          error={errorMessage(errors.default_locale)}
          {...form.register('default_locale')}
        />
        <TextField
          label="Default country"
          required
          hint="Two-letter ISO code."
          error={errorMessage(errors.default_country)}
          {...form.register('default_country', {
            setValueAs: (value: string) => value.trim().toUpperCase(),
          })}
        />
        <TextField
          label="Timezone"
          required
          hint="e.g. Europe/Amsterdam"
          error={errorMessage(errors.timezone)}
          {...form.register('timezone')}
        />
      </div>

      {question !== null ? (
        <div
          role="alertdialog"
          aria-label="Confirm status change"
          className="border-warning/30 bg-warning/5 max-w-3xl space-y-3 rounded-md border px-4 py-3"
        >
          <p className="text-sm">{question}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={isSubmitting}
              onClick={() => {
                setQuestion(null);
                void submit();
              }}
            >
              Confirm and save
            </Button>
            <Button type="button" variant="secondary" onClick={() => setQuestion(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Save changes'}
          </Button>
          {saved && (
            <span role="status" className="text-muted text-sm">
              Saved.
            </span>
          )}
        </div>
      )}
    </form>
  );
}
