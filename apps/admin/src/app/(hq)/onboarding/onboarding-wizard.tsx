'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { FormError, SelectField, TextField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import { onboardStoreAction } from '@/app/actions/stores';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import {
  STEPS,
  STEP_TITLES,
  conflictSteps,
  stepOfField,
  stepProblems,
  type OnboardingValues,
  type Step,
} from '@/lib/onboarding';

export interface LegalEntityOption {
  id: string;
  label: string;
}

const EMPTY: OnboardingValues = {
  legal_entity_mode: 'inline',
  legal_entity_id: '',
  legal_entity: { code: '', name: '', country: 'NL', currency: 'EUR', vat_number: '' },
  code: '',
  name: '',
  default_currency: 'EUR',
  default_locale: 'en-GB',
  default_country: 'NL',
  timezone: 'Europe/Amsterdam',
  currencies: [],
  locales: [],
  hostname: '',
  settings_json: '',
};

/** A server field name → the wizard's field name (`domain.hostname` is the hostname box). */
function wizardField(field: string): string {
  return field === 'domain.hostname' || field === 'hostname' ? 'hostname' : field;
}

const splitList = (text: string, upper: boolean) =>
  text
    .split(/[\s,]+/)
    .map((entry) => (upper ? entry.trim().toUpperCase() : entry.trim()))
    .filter((entry) => entry !== '');

interface Created {
  storeId: string;
  storeCode: string;
  key: string | null;
  keyPrefix: string | null;
  repeat: boolean;
}

/**
 * Brand onboarding (#428 B): legal entity → store basics → primary domain → review → `onboardStore`
 * in one transaction. Each step checks its own fields before Next; the server re-validates all of
 * it, and its 400/409/422 details are put back on the step that owns the field.
 *
 * The publishable key arrives once, on the 201. It lives in this component's state and nowhere
 * else — not the URL, not storage, not a log — and "Done" drops it on the way to the readiness
 * panel; no later render can recover it, which is the contract's promise. A 200 is the identical
 * repeat: the store already exists and there is no key to show.
 */
export function OnboardingWizard({
  legalEntities,
}: {
  legalEntities: readonly LegalEntityOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<OnboardingValues>({
    ...EMPTY,
    legal_entity_mode: legalEntities.length > 0 ? 'existing' : 'inline',
    legal_entity_id: legalEntities[0]?.id ?? '',
  });
  const [currenciesText, setCurrenciesText] = useState('EUR');
  const [localesText, setLocalesText] = useState('en-GB');
  const [step, setStep] = useState<Step>('legal_entity');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stepNotes, setStepNotes] = useState<Partial<Record<Step, string>>>({});
  const [failure, setFailure] = useState<{
    message: string | null;
    refusal?: ActionRefusalInfo;
  } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  const set = <K extends keyof OnboardingValues>(key: K, value: OnboardingValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const setEntity = (key: keyof OnboardingValues['legal_entity'], value: string) =>
    setValues((current) => ({
      ...current,
      legal_entity: { ...current.legal_entity, [key]: value },
    }));
  const index = STEPS.indexOf(step);
  const go = (next: Step) => {
    setFailure(null);
    setStep(next);
  };

  const next = () => {
    const problems = stepProblems(values, step);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    const following = STEPS[index + 1];
    if (following !== undefined) go(following);
  };

  const submit = () => {
    for (const each of STEPS) {
      const problems = stepProblems(values, each);
      if (Object.keys(problems).length > 0) {
        setErrors(problems);
        go(each);
        return;
      }
    }
    setFailure(null);
    setStepNotes({});
    startTransition(async () => {
      const result = await onboardStoreAction(values);
      if (result.status === 'success') {
        setCreated(result.data);
        setCopied(false);
        return;
      }
      if (result.refusal !== undefined) {
        setFailure({ message: null, refusal: result.refusal });
        return;
      }
      const details = result.details;
      const fieldErrors: Record<string, string> = {};
      const notes: Partial<Record<Step, string>> = {};
      const settings = details?.['settings'];
      if (settings !== null && typeof settings === 'object') {
        // 422 InvalidSettings: each offending key and what was expected.
        fieldErrors['settings_json'] = Object.entries(settings as Record<string, unknown>)
          .map(([key, expected]) => `${key}: ${String(expected)}`)
          .join('; ');
        notes.store = 'The settings have the wrong shape.';
      } else if (details !== undefined && ('differs' in details || 'field' in details)) {
        // 409: a different definition for the same code, or a hostname another store has.
        for (const owner of conflictSteps(details)) notes[owner] = result.formError ?? 'Conflict.';
        if (details['field'] === 'domain.hostname')
          fieldErrors['hostname'] = result.formError ?? 'In use.';
      } else if (details !== undefined) {
        // 400: problems keyed by field.
        for (const [field, message] of Object.entries(details)) {
          if (typeof message !== 'string') continue;
          fieldErrors[wizardField(field)] = message;
          notes[stepOfField(field)] ??= 'Some fields here were refused.';
        }
      }
      setErrors(fieldErrors);
      setStepNotes(notes);
      const first = STEPS.find((each) => notes[each] !== undefined);
      if (first !== undefined) setStep(first);
      setFailure({ message: result.formError });
    });
  };

  if (created !== null) {
    return (
      <div className="space-y-4" aria-label="Onboarding result">
        {created.repeat ? (
          <p role="status" className="text-sm">
            <span className="font-medium">{created.storeCode}</span> already exists with exactly
            this definition — nothing was created again, and its publishable key is not shown a
            second time.
          </p>
        ) : (
          <div
            role="alert"
            className="border-warning/30 bg-warning/5 space-y-2 rounded-md border px-4 py-3"
          >
            <p className="text-sm font-medium">
              {created.storeCode} is onboarded as a draft. Copy its publishable key now — it is
              shown once and cannot be retrieved again.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code
                data-testid="onboarding-key"
                className="border-line bg-surface rounded border px-2 py-1 font-mono text-xs break-all"
              >
                {created.key}
              </code>
              <Button
                size="sm"
                onClick={() => {
                  if (created.key === null) return;
                  void navigator.clipboard?.writeText(created.key).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        )}
        <Button
          onClick={() => {
            const storeId = created.storeId;
            setCreated(null);
            router.push(`/onboarding/${storeId}`);
          }}
        >
          {created.repeat ? 'Continue to readiness' : 'Done — continue to readiness'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {STEPS.map((each, position) => (
          <li key={each}>
            <button
              type="button"
              aria-current={each === step ? 'step' : undefined}
              disabled={position > index}
              onClick={() => go(each)}
              className={
                each === step
                  ? 'bg-accent/10 text-accent rounded px-2 py-1 font-medium'
                  : 'text-muted rounded px-2 py-1 disabled:opacity-50'
              }
            >
              {position + 1}. {STEP_TITLES[each]}
              {stepNotes[each] !== undefined && <span className="text-danger"> •</span>}
            </button>
          </li>
        ))}
      </ol>

      {failure?.refusal !== undefined ? (
        <ActionRefusal refusal={failure.refusal} message={null} />
      ) : (
        <FormError
          message={stepNotes[step] ?? (step === 'review' ? (failure?.message ?? null) : null)}
        />
      )}

      <section aria-label={STEP_TITLES[step]} className="max-w-3xl space-y-3">
        {step === 'legal_entity' && (
          <>
            <SelectField
              label="Legal entity"
              value={values.legal_entity_mode}
              onChange={(event) =>
                set('legal_entity_mode', event.currentTarget.value as 'existing' | 'inline')
              }
              options={[
                ...(legalEntities.length > 0
                  ? [{ value: 'existing', label: 'An existing legal entity' }]
                  : []),
                { value: 'inline', label: 'A new legal entity' },
              ]}
            />
            {values.legal_entity_mode === 'existing' ? (
              <SelectField
                label="Which one"
                value={values.legal_entity_id}
                onChange={(event) => set('legal_entity_id', event.currentTarget.value)}
                options={legalEntities.map((entity) => ({ value: entity.id, label: entity.label }))}
                error={errors['legal_entity_id'] ?? errors['legal_entity']}
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Entity code"
                  value={values.legal_entity.code}
                  onChange={(e) => setEntity('code', e.currentTarget.value)}
                  error={errors['legal_entity.code']}
                  hint="e.g. brand-c-bv"
                />
                <TextField
                  label="Registered name"
                  value={values.legal_entity.name}
                  onChange={(e) => setEntity('name', e.currentTarget.value)}
                  error={errors['legal_entity.name']}
                />
                <TextField
                  label="Entity country"
                  value={values.legal_entity.country}
                  onChange={(e) => setEntity('country', e.currentTarget.value.toUpperCase())}
                  error={errors['legal_entity.country']}
                />
                <TextField
                  label="Entity currency"
                  value={values.legal_entity.currency}
                  onChange={(e) => setEntity('currency', e.currentTarget.value.toUpperCase())}
                  error={errors['legal_entity.currency']}
                />
                <TextField
                  label="VAT number"
                  value={values.legal_entity.vat_number}
                  onChange={(e) => setEntity('vat_number', e.currentTarget.value)}
                  hint="Optional."
                />
              </div>
            )}
          </>
        )}

        {step === 'store' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Store code"
              value={values.code}
              onChange={(e) => set('code', e.currentTarget.value)}
              error={errors['code']}
              hint="e.g. brand-c — also the content space and search index"
            />
            <TextField
              label="Store name"
              value={values.name}
              onChange={(e) => set('name', e.currentTarget.value)}
              error={errors['name']}
            />
            <TextField
              label="Default currency"
              value={values.default_currency}
              onChange={(e) => set('default_currency', e.currentTarget.value.toUpperCase())}
              error={errors['default_currency']}
            />
            <TextField
              label="Default locale"
              value={values.default_locale}
              onChange={(e) => set('default_locale', e.currentTarget.value)}
              error={errors['default_locale']}
            />
            <TextField
              label="Default country"
              value={values.default_country}
              onChange={(e) => set('default_country', e.currentTarget.value.toUpperCase())}
              error={errors['default_country']}
            />
            <TextField
              label="Timezone"
              value={values.timezone}
              onChange={(e) => set('timezone', e.currentTarget.value)}
              error={errors['timezone']}
            />
            <TextField
              label="Enabled currencies"
              value={currenciesText}
              onChange={(e) => {
                setCurrenciesText(e.currentTarget.value);
                set('currencies', splitList(e.currentTarget.value, true));
              }}
              error={errors['currencies']}
              hint="Comma-separated; the default is always first."
            />
            <TextField
              label="Enabled locales"
              value={localesText}
              onChange={(e) => {
                setLocalesText(e.currentTarget.value);
                set('locales', splitList(e.currentTarget.value, false));
              }}
              error={errors['locales']}
              hint="Comma-separated; the default is always first."
            />
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium" htmlFor="onboarding-settings">
                Settings (JSON, optional)
              </label>
              <textarea
                id="onboarding-settings"
                rows={3}
                className="border-line bg-surface w-full rounded-md border px-3 py-2 font-mono text-xs"
                value={values.settings_json}
                aria-invalid={errors['settings_json'] !== undefined}
                onChange={(e) => set('settings_json', e.currentTarget.value)}
              />
              {errors['settings_json'] !== undefined && (
                <p className="text-danger text-xs">{errors['settings_json']}</p>
              )}
            </div>
          </div>
        )}

        {step === 'domain' && (
          <TextField
            label="Primary domain"
            value={values.hostname}
            onChange={(e) => set('hostname', e.currentTarget.value)}
            error={errors['hostname']}
            hint="No scheme and no path, e.g. shop.brand-c.com. It starts unverified."
          />
        )}

        {step === 'review' && (
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]" aria-label="Review">
            <dt className="text-muted">Legal entity</dt>
            <dd>
              {values.legal_entity_mode === 'existing'
                ? (legalEntities.find((entity) => entity.id === values.legal_entity_id)?.label ??
                  values.legal_entity_id)
                : `${values.legal_entity.name} (${values.legal_entity.code}, new)`}
            </dd>
            <dt className="text-muted">Store</dt>
            <dd>
              {values.name} ({values.code})
            </dd>
            <dt className="text-muted">Defaults</dt>
            <dd className="font-mono">
              {values.default_currency} · {values.default_locale} · {values.default_country} ·{' '}
              {values.timezone}
            </dd>
            <dt className="text-muted">Primary domain</dt>
            <dd className="font-mono">{values.hostname.trim().toLowerCase()}</dd>
            <dt className="text-muted">Then</dt>
            <dd>
              A draft store, a web channel and one publishable key — activation is the next screen.
            </dd>
          </dl>
        )}
      </section>

      <div className="flex gap-2">
        {index > 0 && (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => go(STEPS[index - 1] ?? 'legal_entity')}
          >
            Back
          </Button>
        )}
        {step === 'review' ? (
          <Button disabled={pending} onClick={submit}>
            {pending ? 'Onboarding…' : 'Onboard the brand'}
          </Button>
        ) : (
          <Button onClick={next}>Next</Button>
        )}
      </div>
    </div>
  );
}
