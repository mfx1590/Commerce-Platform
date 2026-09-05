'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormError, SelectField, TextField, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import { addDomainAction, createSalesChannelAction } from '@/app/actions/stores';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  SALES_CHANNEL_TYPES,
  domainCreateSchema,
  salesChannelCreateSchema,
  type DomainCreateValues,
  type SalesChannelCreateValues,
} from '@/lib/forms/schemas';

type Domain = AdminComponents['Domain'];
type SalesChannel = AdminComponents['SalesChannel'];

/** `addDomain` needs `owner` on `organization:hq` — a store admin will get the 403 panel here. */
export function DomainsPanel({
  storeId,
  domains,
}: {
  storeId: string;
  domains: readonly Domain[];
}) {
  const { form, submit, formError, isSubmitting } = useContractForm<DomainCreateValues, Domain>({
    schema: domainCreateSchema,
    action: (values) => addDomainAction(storeId, values),
    defaultValues: { hostname: '', is_primary: false },
    onSuccess: () => form.reset({ hostname: '', is_primary: false }),
  });

  return (
    <div className="space-y-4">
      {domains.length === 0 ? (
        <p className="text-muted text-sm">
          No domains yet. The storefront is not reachable until one is added and verified.
        </p>
      ) : (
        <ul className="divide-line divide-y text-sm">
          {domains.map((domain) => (
            <li key={domain.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="font-mono text-xs">{domain.hostname}</span>
              {domain.is_primary && <Badge tone="accent">primary</Badge>}
              {domain.verified_at === null ? (
                <Badge tone="warning">unverified</Badge>
              ) : (
                <Badge tone="success">verified</Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} noValidate className="border-line space-y-3 border-t pt-4">
        <FormError message={formError} />
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
            Primary
          </label>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Adding…' : 'Add domain'}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function SalesChannelsPanel({
  storeId,
  channels,
}: {
  storeId: string;
  channels: readonly SalesChannel[];
}) {
  const { form, submit, formError, isSubmitting } = useContractForm<
    SalesChannelCreateValues,
    SalesChannel
  >({
    schema: salesChannelCreateSchema,
    action: (values) => createSalesChannelAction(storeId, values),
    defaultValues: { code: '', name: '', type: 'web' },
    onSuccess: () => form.reset({ code: '', name: '', type: 'web' }),
  });

  const errors = form.formState.errors;

  return (
    <div className="space-y-4">
      {channels.length === 0 ? (
        <p className="text-muted text-sm">No sales channels yet.</p>
      ) : (
        <ul className="divide-line divide-y text-sm">
          {channels.map((channel) => (
            <li key={channel.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="font-medium">{channel.name}</span>
              <span className="text-muted font-mono text-xs">{channel.code}</span>
              <Badge>{channel.type}</Badge>
              {!channel.is_active && <Badge tone="warning">inactive</Badge>}
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
    </div>
  );
}
