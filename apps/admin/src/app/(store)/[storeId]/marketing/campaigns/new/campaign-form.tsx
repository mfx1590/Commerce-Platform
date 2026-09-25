'use client';

import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { SelectField, TextField, FormError, errorMessage } from '@/components/form/fields';
import { useContractForm } from '@/components/form/use-contract-form';
import { ActionRefusal } from '@/components/states/action-refusal';
import { Button } from '@/components/ui/button';
import type { AdminComponents } from '@/lib/api/admin-client';
import { createCampaignAction } from '../../_actions';
import { CAMPAIGN_TYPES } from '../campaigns-table.config';

/**
 * Create a campaign. Always lands in `draft` — the contract says so, and launching is a separate, audited
 * step, so nothing goes live because someone pressed Save.
 *
 * `utm_campaign` is the field that actually matters and the form says why: it is what the attribution report
 * matches on, so a campaign without one can never be credited with an order.
 */
const schema = z.object({
  name: z.string().trim().min(1, 'A name is needed.').max(200),
  type: z.enum(CAMPAIGN_TYPES),
  utm_source: z.string().trim().optional(),
  utm_medium: z.string().trim().optional(),
  utm_campaign: z.string().trim().optional(),
  landing_path: z.string().trim().optional(),
});

type Values = z.infer<typeof schema>;

function orNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export function CampaignForm({ storeId }: { storeId: string }) {
  const router = useRouter();

  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    Values,
    AdminComponents['Campaign']
  >({
    schema,
    defaultValues: {
      name: '',
      type: 'email',
      utm_source: '',
      utm_medium: '',
      utm_campaign: '',
      landing_path: '',
    },
    action: (values) =>
      createCampaignAction(storeId, {
        name: values.name.trim(),
        type: values.type,
        utm_source: orNull(values.utm_source),
        utm_medium: orNull(values.utm_medium),
        utm_campaign: orNull(values.utm_campaign),
        landing_path: orNull(values.landing_path),
      }),
    onSuccess: (campaign) => {
      router.push(`/${storeId}/marketing/campaigns/${campaign.id}`);
    },
  });

  return (
    <form onSubmit={submit} className="max-w-xl space-y-4">
      <TextField
        label="Name"
        error={errorMessage(form.formState.errors.name)}
        {...form.register('name')}
        autoComplete="off"
      />

      <SelectField
        label="Type"
        error={errorMessage(form.formState.errors.type)}
        options={CAMPAIGN_TYPES.map((type) => ({ value: type, label: type.replace('_', ' ') }))}
        {...form.register('type')}
      />

      <fieldset className="border-line space-y-3 rounded border p-3">
        <legend className="text-muted px-1 text-xs uppercase">Attribution</legend>
        <p className="text-muted text-xs">
          Orders are credited to this campaign by matching <code>utm_campaign</code> at report time.
          Leave it empty and the campaign will never be credited with anything.
        </p>
        <TextField
          label="utm_source"
          hint="Where the visit came from — meta, google, newsletter."
          error={errorMessage(form.formState.errors.utm_source)}
          {...form.register('utm_source')}
        />
        <TextField
          label="utm_medium"
          hint="How — paid_social, email, cpc."
          error={errorMessage(form.formState.errors.utm_medium)}
          {...form.register('utm_medium')}
        />
        <TextField
          label="utm_campaign"
          hint="The campaign key the links carry."
          error={errorMessage(form.formState.errors.utm_campaign)}
          {...form.register('utm_campaign')}
        />
      </fieldset>

      <TextField
        label="Landing path"
        hint="Optional — where the links point, e.g. /collections/autumn."
        error={errorMessage(form.formState.errors.landing_path)}
        {...form.register('landing_path')}
      />

      <FormError message={formError} />
      <ActionRefusal refusal={refusal} message={null} />

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating…' : 'Create campaign'}
        </Button>
        <span className="text-muted text-xs">
          It starts as a draft; launching is a separate step.
        </span>
      </div>
    </form>
  );
}
