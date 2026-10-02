'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SelectField, TextField, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import { ActionRefusal } from '@/components/states/action-refusal';
import { createApiKeyAction } from '@/app/actions/stores';
import type { AdminComponents } from '@/lib/api/admin-client';
import { apiKeyCreateSchema, type ApiKeyCreateValues } from '@/lib/forms/schemas';
import type { ChannelOption } from '@/lib/settings';

type ApiKeyType = AdminComponents['ApiKey']['type'];
type Created = Pick<AdminComponents['ApiKey'], 'name' | 'type' | 'key_prefix'> & { key: string };

/**
 * `createApiKey` and the one-time reveal.
 *
 * The contract returns the plain key "exactly once". It lives in this component's state and
 * nowhere else: not in the URL, not in storage, not in a prop, not in a log, and not in the list
 * beside this form (which is rendered on the server from `key_prefix`). "Done" drops it for good —
 * no later read can recover it, which is exactly what the contract promises.
 */
export function CreateApiKey({
  storeId,
  channels,
  types,
}: {
  storeId: string;
  channels: readonly ChannelOption[];
  /** The Store view offers publishable keys only; HQ offers both. */
  types: readonly ApiKeyType[];
}) {
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const empty: ApiKeyCreateValues = {
    name: '',
    type: types[0] ?? 'publishable',
    sales_channel_id: '',
  };

  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    ApiKeyCreateValues,
    AdminComponents['ApiKey'] & { key: string }
  >({
    schema: apiKeyCreateSchema,
    action: (values) => createApiKeyAction(storeId, values),
    defaultValues: empty,
    onSuccess: ({ name, type, key_prefix: keyPrefix, key }) => {
      setCreated({ name, type, key_prefix: keyPrefix, key });
      setCopied(false);
      form.reset(empty);
    },
  });
  const errors = form.formState.errors;

  return (
    <div className="space-y-4">
      {created !== null && (
        <div
          role="alert"
          className="border-warning/30 bg-warning/5 space-y-2 rounded-md border px-4 py-3"
        >
          <p className="text-sm font-medium">
            Copy this key now — it is shown once and cannot be retrieved again.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code
              data-testid="revealed-api-key"
              className="border-line bg-surface rounded border px-2 py-1 font-mono text-xs break-all"
            >
              {created.key}
            </code>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(created.key).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
          <p className="text-muted text-xs">
            {created.name} · {created.type} · prefix {created.key_prefix}
          </p>
        </div>
      )}

      <form
        onSubmit={submit}
        noValidate
        className="border-line space-y-3 border-t pt-4"
        aria-label="New API key"
      >
        <ActionRefusal refusal={refusal} message={formError} />
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Name"
            required
            error={errorMessage(errors.name)}
            {...form.register('name')}
          />
          {types.length > 1 ? (
            <SelectField
              label="Type"
              required
              options={types.map((type) => ({ value: type, label: type }))}
              error={errorMessage(errors.type)}
              {...form.register('type')}
            />
          ) : (
            <p className="text-muted self-end pb-2 text-sm">Type: {types[0] ?? 'publishable'}</p>
          )}
          <SelectField
            label="Sales channel"
            hint="Optional; publishable keys are usually scoped to one."
            options={[
              { value: '', label: '— none —' },
              ...channels.map((channel) => ({ value: channel.id, label: channel.name })),
            ]}
            error={errorMessage(errors.sales_channel_id)}
            {...form.register('sales_channel_id')}
          />
        </div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating…' : 'Create key'}
        </Button>
      </form>
    </div>
  );
}
