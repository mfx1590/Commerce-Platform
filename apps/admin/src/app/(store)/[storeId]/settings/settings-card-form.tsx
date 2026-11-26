'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { saveStoreSettingsAction } from '@/app/actions/store-settings';
import { Field, FormError, SelectField, TextField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import { Button } from '@/components/ui/button';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { formatMoney, formatMoneyInput, parseMoney } from '@/lib/forms/money';
import {
  SETTINGS_CARDS,
  changesOf,
  needsConfirmation,
  type CardId,
  type CardValues,
  type SettingChange,
  type SettingField,
} from '@/lib/settings/fields';

/** What was confirmed: the paths and the values the reader was shown and agreed to. */
type Confirmed = { path: string; to: unknown }[];

const NOT_SET = '';

/**
 * One `store.settings` card: every field with its current value, and a **diff before the save** for
 * the changes that matter (#870 item 7).
 *
 * **Only fields the reader actually touched are sent** (#968 review). An absent path is not "off"
 * or "empty": an absent `fraud.providers` means **both** fraud checks run, an absent
 * `support_refund_limit_minor` means no ceiling at all, and an absent `tax.shipping_taxable`
 * depends on the legal entity's country. The first version submitted every field on the card, so
 * saving an untouched Fraud card would have sent `providers: []` and switched fraud checking
 * **off**. Now the form compares the draft against the draft it rendered and sends only the
 * difference: an untouched field is not in the request at all, and an absent one reads "not set
 * (default: …)" rather than as a value.
 *
 * **The confirmation names what was confirmed.** The dialog snapshots the `{ path, to }` entries it
 * showed, the action recomputes them and requires an exact match, and any edit after the dialog
 * opens clears it — so a confirmation cannot authorise a change the reader never saw.
 *
 * Money is shown as an amount in the store's currency and sent as minor units: ¥1,980 is 1980, and
 * a store with a zero-decimal currency must never see "19.80".
 */
export function SettingsCardForm({
  storeId,
  cardId,
  current,
  updatedAt,
  currency,
  locale,
}: {
  storeId: string;
  cardId: CardId;
  current: CardValues;
  /** `updated_at` of the store this page rendered — the concurrency check. */
  updatedAt: string;
  currency: string;
  locale: string;
}) {
  const card = SETTINGS_CARDS.find((candidate) => candidate.id === cardId)!;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const initial = useMemo(
    () => initialDraft(card.fields, current, currency),
    [card.fields, current, currency],
  );
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [pending, setPending] = useState<{ changes: SettingChange[]; confirmed: Confirmed } | null>(
    null,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const money = (amountMinor: number) => formatMoney(amountMinor, currency, locale);

  /** Exactly the fields whose box differs from the one this page rendered. */
  const touched = card.fields.filter((field) => draft[field.path] !== initial[field.path]);

  /** The touched fields as the action wants them: typed values by path, or a per-field message. */
  function parseTouched(): { values: Record<string, unknown>; errors: Record<string, string> } {
    const values: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const field of touched) {
      const raw = draft[field.path] ?? NOT_SET;
      // "not set" on any kind clears the path: the core keeps its own default for an absent one.
      if (raw.trim() === NOT_SET) {
        values[field.path] = undefined;
        continue;
      }
      if (field.kind === 'boolean') {
        values[field.path] = raw === 'true';
      } else if (field.kind === 'integer' && field.money === true) {
        const parsed = parseMoney(raw, currency);
        if (!parsed.ok) errors[field.path] = 'That is not an amount in this currency.';
        else values[field.path] = parsed.amountMinor;
      } else if (field.kind === 'integer') {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < (field.min ?? 0)) {
          errors[field.path] = `A whole number, ${field.min ?? 0} or more.`;
        } else values[field.path] = parsed;
      } else if (field.kind === 'enumArray') {
        values[field.path] = raw.split(',').filter((item) => item !== '');
      } else {
        values[field.path] = raw;
      }
    }
    return { values, errors };
  }

  function submit(confirmed: Confirmed | null) {
    setFormError(null);
    setRefusal(undefined);
    const { values, errors } = parseTouched();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setPending(null);
      return;
    }
    if (Object.keys(values).length === 0) {
      setPending(null);
      setSaved(true);
      return;
    }

    const changes = changesOf(card.fields, unflatten(current), values, money);
    if (changes.length === 0) {
      setPending(null);
      setSaved(true);
      return;
    }
    if (confirmed === null && needsConfirmation(changes)) {
      setPending({
        changes,
        // Bound to the values being sent, not a boolean: this is what the reader agrees to.
        confirmed: changes
          .filter((change) => change.confirm)
          .map((change) => ({ path: change.path, to: values[change.path] })),
      });
      return;
    }

    startTransition(async () => {
      const result = await saveStoreSettingsAction(
        storeId,
        cardId,
        values,
        updatedAt,
        confirmed ?? [],
      );
      if (result.status === 'success') {
        setPending(null);
        setSaved(true);
        router.refresh();
        return;
      }
      setPending(null);
      if (result.refusal !== undefined) setRefusal(result.refusal);
      setFieldErrors(result.fieldErrors ?? {});
      setFormError(result.formError ?? 'The change could not be saved.');
    });
  }

  return (
    <form
      className="space-y-4"
      aria-label={`${card.title} settings`}
      onSubmit={(event) => {
        event.preventDefault();
        submit(null);
      }}
    >
      <ActionRefusal refusal={refusal} message={null} />
      <FormError message={formError} />

      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        {card.fields.map((field) => (
          <FieldInput
            key={field.path}
            field={field}
            value={draft[field.path] ?? NOT_SET}
            error={fieldErrors[field.path]}
            currency={currency}
            onChange={(value) => {
              setSaved(false);
              // Any edit invalidates a confirmation asked for the previous values.
              setPending(null);
              setDraft((previous) => ({ ...previous, [field.path]: value }));
            }}
          />
        ))}
      </div>

      {pending !== null ? (
        <div
          role="group"
          aria-label={`Confirm the ${card.title.toLowerCase()} change`}
          className="border-line space-y-3 rounded-md border px-3 py-3"
        >
          <p className="text-sm font-medium">Confirm this change</p>
          <ul className="space-y-1 text-sm">
            {pending.changes.map((change) => (
              <li key={change.path}>
                {change.label}: <span className="line-through">{change.from}</span>{' '}
                <span aria-hidden>→</span> <span className="font-medium">{change.to}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={isPending}
              onClick={() => submit(pending.confirmed)}
              type="button"
            >
              Yes, save it
            </Button>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              disabled={isPending}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={isPending}>
            Save {card.title.toLowerCase()}
          </Button>
          {touched.length > 0 && (
            <span className="text-muted text-xs">
              {touched.length} field{touched.length === 1 ? '' : 's'} changed; the rest are not
              sent.
            </span>
          )}
          {saved && (
            <span role="status" className="text-success text-sm">
              Saved.
            </span>
          )}
        </div>
      )}
    </form>
  );
}

function FieldInput({
  field,
  value,
  error,
  currency,
  onChange,
}: {
  field: SettingField;
  value: string;
  error: string | undefined;
  currency: string;
  onChange: (value: string) => void;
}) {
  const notSet = `not set (default: ${field.defaultLabel})`;
  const base = field.money === true ? `${field.hint ?? ''} In ${currency}.`.trim() : field.hint;
  // The default belongs on the field, not in a footnote: "off" and "not set" are different states.
  const hint = value === NOT_SET ? `${base ?? ''} ${notSet}.`.trim() : base;
  const id = `setting-${field.path.replaceAll('.', '-')}`;

  if (field.kind === 'boolean' || field.kind === 'enum') {
    const options = field.kind === 'boolean' ? ['true', 'false'] : [...(field.options ?? [])];
    return (
      <SelectField
        label={field.label}
        {...(hint === undefined ? {} : { hint })}
        error={error}
        options={[
          { value: NOT_SET, label: notSet },
          ...options.map((option) => ({
            value: option,
            label: field.kind === 'boolean' ? (option === 'true' ? 'on' : 'off') : option,
          })),
        ]}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }

  if (field.kind === 'enumArray') {
    const selected = value === NOT_SET ? [] : value.split(',');
    return (
      <Field
        label={field.label}
        htmlFor={id}
        {...(hint === undefined ? {} : { hint })}
        error={error}
      >
        <div role="group" aria-label={field.label} className="flex flex-wrap gap-3" id={id}>
          {(field.options ?? []).map((option) => (
            <label key={option} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={(event) =>
                  onChange(
                    (event.currentTarget.checked
                      ? [...selected, option]
                      : selected.filter((item) => item !== option)
                    ).join(','),
                  )
                }
              />
              {option}
            </label>
          ))}
        </div>
      </Field>
    );
  }

  return (
    <TextField
      label={field.label}
      {...(hint === undefined ? {} : { hint })}
      error={error}
      value={value}
      {...(field.maxLength === undefined ? {} : { maxLength: field.maxLength })}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

/**
 * The form's string state, from the values the page rendered.
 *
 * An absent path becomes `''` — "not set" — and stays that way unless the reader changes it, which
 * is what keeps an untouched absent field out of the request.
 */
function initialDraft(
  fields: readonly SettingField[],
  current: CardValues,
  currency: string,
): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const field of fields) {
    const value = current[field.path];
    if (value === undefined || value === null) draft[field.path] = NOT_SET;
    else if (field.kind === 'boolean') draft[field.path] = value === true ? 'true' : 'false';
    else if (field.kind === 'enumArray')
      draft[field.path] = Array.isArray(value) ? value.join(',') : NOT_SET;
    else if (field.money === true && typeof value === 'number')
      draft[field.path] = formatMoneyInput(value, currency);
    else draft[field.path] = String(value);
  }
  return draft;
}

/** The flat `{path: value}` the page passes, back into the nested shape `changesOf` compares. */
function unflatten(current: CardValues): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(current)) {
    const parts = path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = value;
  }
  return root;
}
