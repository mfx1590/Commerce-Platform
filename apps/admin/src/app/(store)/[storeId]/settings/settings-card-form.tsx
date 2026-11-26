'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
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
  valueAt,
  type CardId,
  type SettingChange,
  type SettingField,
} from '@/lib/settings/fields';

/** The card's current values, by dotted path. Settings are configuration, never personal data. */
export type CardValues = Readonly<Record<string, unknown>>;

/**
 * One `store.settings` card: every field with its current value, and a **diff before the save** for
 * the changes that matter (#870 item 7).
 *
 * The diff is shown for money (`support_refund_limit_minor`, `tax.prices_include_tax`) and — the
 * manager's decision — for the fraud rules and the carrier accounts, because loosening a fraud rule
 * is as consequential as a number with a currency on it. It is computed here from the values the
 * page rendered, so there is no round trip to find out what would change; the **action refuses an
 * unconfirmed consequential change anyway**, so this dialog is the courtesy and that is the rule.
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
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    initialDraft(card.fields, current, currency),
  );
  const [pending, setPending] = useState<SettingChange[] | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const money = (amountMinor: number) => formatMoney(amountMinor, currency, locale);

  /** The draft as the action wants it: typed values by path, or a per-field message. */
  function parseDraft(): { values: Record<string, unknown>; errors: Record<string, string> } {
    const values: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const field of card.fields) {
      const raw = draft[field.path] ?? '';
      if (field.kind === 'boolean') {
        values[field.path] = raw === 'true';
      } else if (field.kind === 'integer' && raw.trim() === '') {
        // Empty means "not set", not zero and not invalid: the core keeps its own default for an
        // absent path. For the refund ceiling that is the only way to say "no limit at all", and
        // because the path is confirmed the diff spells it out as "→ not set" first.
        values[field.path] = undefined;
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
        values[field.path] = raw === '' ? [] : raw.split(',');
      } else if (field.kind === 'textList') {
        values[field.path] = lines(raw);
      } else if (field.kind === 'countryMap') {
        const map: Record<string, string> = {};
        for (const line of lines(raw)) {
          // `NL = wh-eu`, and `NL: wh-eu` because somebody will type a colon.
          const match = /^([A-Za-z]{2})\s*[=:]\s*(.+)$/.exec(line);
          if (match === null) {
            errors[field.path] =
              `Each line is a country and a warehouse code, like "NL = wh-eu". "${line}" is not.`;
            break;
          }
          map[match[1]!.toUpperCase()] = match[2]!.trim();
        }
        if (errors[field.path] === undefined) values[field.path] = map;
      } else {
        values[field.path] = raw;
      }
    }
    return { values, errors };
  }

  function submit(confirmed: boolean) {
    setFormError(null);
    setRefusal(undefined);
    const { values, errors } = parseDraft();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const changes = changesOf(card.fields, unflatten(current), values, money);
    if (changes.length === 0) {
      setPending(null);
      setSaved(true);
      return;
    }
    if (!confirmed && needsConfirmation(changes)) {
      setPending(changes);
      return;
    }

    startTransition(async () => {
      const result = await saveStoreSettingsAction(storeId, cardId, values, updatedAt, confirmed);
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
        submit(false);
      }}
    >
      <ActionRefusal refusal={refusal} message={null} />
      <FormError message={formError} />

      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        {card.fields.map((field) => (
          <FieldInput
            key={field.path}
            field={field}
            value={draft[field.path] ?? ''}
            error={fieldErrors[field.path]}
            currency={currency}
            onChange={(value) => {
              setSaved(false);
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
            {pending.map((change) => (
              <li key={change.path}>
                {change.label}: <span className="line-through">{change.from}</span>{' '}
                <span aria-hidden>→</span> <span className="font-medium">{change.to}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={isPending} onClick={() => submit(true)} type="button">
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
  const hint = field.money === true ? `${field.hint ?? ''} In ${currency}.`.trim() : field.hint;

  const id = `setting-${field.path.replaceAll('.', '-')}`;

  if (field.kind === 'boolean') {
    return (
      <Field
        label={field.label}
        htmlFor={id}
        {...(hint === undefined ? {} : { hint })}
        error={error}
      >
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="border-line bg-surface h-9 rounded-md border px-2"
        >
          <option value="false">off</option>
          <option value="true">on</option>
        </select>
      </Field>
    );
  }

  if (field.kind === 'enum') {
    return (
      <SelectField
        label={field.label}
        {...(hint === undefined ? {} : { hint })}
        error={error}
        options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }

  if (field.kind === 'enumArray') {
    const selected = value === '' ? [] : value.split(',');
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

  if (field.kind === 'textList' || field.kind === 'countryMap') {
    return (
      <Field
        label={field.label}
        htmlFor={id}
        {...(hint === undefined ? {} : { hint })}
        error={error}
      >
        <textarea
          id={id}
          rows={4}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="border-line bg-surface rounded-md border px-2 py-1 font-mono text-xs"
        />
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

/** Non-empty trimmed lines of a textarea. */
const lines = (raw: string): string[] =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** The form's string state, from the values the page rendered. */
function initialDraft(
  fields: readonly SettingField[],
  current: CardValues,
  currency: string,
): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const field of fields) {
    const value = current[field.path];
    if (field.kind === 'boolean') draft[field.path] = value === true ? 'true' : 'false';
    else if (field.kind === 'enumArray')
      draft[field.path] = Array.isArray(value) ? value.join(',') : '';
    else if (field.kind === 'textList')
      draft[field.path] = Array.isArray(value) ? value.join('\n') : '';
    else if (field.kind === 'countryMap')
      draft[field.path] =
        typeof value === 'object' && value !== null
          ? Object.entries(value as Record<string, unknown>)
              .map(([country, code]) => `${country} = ${String(code)}`)
              .sort()
              .join('\n')
          : '';
    else if (field.money === true && typeof value === 'number')
      draft[field.path] = formatMoneyInput(value, currency);
    else if (value === undefined || value === null) draft[field.path] = '';
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

/** Only this card's paths, read off the store — what the form is given. */
export function cardValues(cardId: CardId, settings: unknown): CardValues {
  const card = SETTINGS_CARDS.find((candidate) => candidate.id === cardId)!;
  return Object.fromEntries(
    card.fields.map((field) => [field.path, valueAt(settings, field.path)]),
  );
}
