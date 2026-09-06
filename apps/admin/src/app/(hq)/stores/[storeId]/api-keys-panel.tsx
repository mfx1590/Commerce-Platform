'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormError, SelectField, TextField, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import { createApiKeyAction } from '@/app/actions/stores';
import type { AdminComponents } from '@/lib/api/admin-client';
import { API_KEY_TYPES, apiKeyCreateSchema, type ApiKeyCreateValues } from '@/lib/forms/schemas';

type ApiKey = AdminComponents['ApiKey'];
type SalesChannel = AdminComponents['SalesChannel'];
type CreatedKey = ApiKey & { key: string };

/**
 * API keys, including the one-time reveal.
 *
 * `createApiKey` is documented as "Returns the plain key exactly once": the value exists in this
 * component's state and nowhere else. It is never written to the URL, to storage, or back to the
 * server, and no later read can recover it — the list only ever has `key_prefix`. When the panel is
 * dismissed the value is gone for good, which is exactly what the contract promises, so the copy
 * button and the warning are the whole affordance.
 */
export function ApiKeysPanel({
  storeId,
  keys,
  salesChannels,
}: {
  storeId: string;
  keys: readonly ApiKey[];
  salesChannels: readonly SalesChannel[];
}) {
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);

  const { form, submit, formError, isSubmitting } = useContractForm<ApiKeyCreateValues, CreatedKey>(
    {
      schema: apiKeyCreateSchema,
      action: (values) => createApiKeyAction(storeId, values),
      defaultValues: { name: '', type: 'publishable', sales_channel_id: '' },
      onSuccess: (key) => {
        setCreated(key);
        setCopied(false);
        form.reset({ name: '', type: 'publishable', sales_channel_id: '' });
      },
    },
  );

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

      {keys.length === 0 ? (
        <p className="text-muted text-sm">No API keys yet.</p>
      ) : (
        <ul className="divide-line divide-y text-sm">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="font-medium">{key.name}</span>
              <Badge tone={key.type === 'secret' ? 'warning' : 'neutral'}>{key.type}</Badge>
              <span className="text-muted font-mono text-xs">{key.key_prefix}…</span>
              {key.revoked_at !== null && <Badge tone="danger">revoked</Badge>}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} noValidate className="border-line space-y-3 border-t pt-4">
        <FormError message={formError} />
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Name"
            required
            error={errorMessage(errors.name)}
            {...form.register('name')}
          />
          <SelectField
            label="Type"
            required
            options={API_KEY_TYPES.map((type) => ({ value: type, label: type }))}
            error={errorMessage(errors.type)}
            {...form.register('type')}
          />
          <SelectField
            label="Sales channel"
            hint="Optional; publishable keys are usually scoped to one."
            options={[
              { value: '', label: '— none —' },
              ...salesChannels.map((channel) => ({ value: channel.id, label: channel.name })),
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
