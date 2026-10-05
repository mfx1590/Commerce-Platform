'use client';

import { useId, useState } from 'react';
import { Field } from './fields';

/** Splits what was typed into entries: commas or whitespace separate, blanks are dropped. */
export function parseCodeList(text: string, normalise: (entry: string) => string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => normalise(entry.trim()))
    .filter((entry) => entry !== '');
}

/**
 * RHF reports an array field's error either on the array (a `refine`) or per entry (a regex on one
 * code); either way the field shows one message, the entry's prefixed with what was typed.
 */
export function codeListError(
  error:
    { message?: string | undefined } | readonly ({ message?: string } | undefined)[] | undefined,
  value: readonly string[],
): string | undefined {
  if (error === undefined) return undefined;
  if (!Array.isArray(error)) {
    const message = (error as { message?: string }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  const entries = error as readonly ({ message?: string } | undefined)[];
  for (let index = 0; index < value.length; index += 1) {
    const message = entries[index]?.message;
    if (typeof message === 'string' && message !== '') return `${value[index]}: ${message}`;
  }
  return undefined;
}

/**
 * A set of short codes (ISO currencies, BCP-47 locales) typed as one line, `EUR, USD, GBP`.
 *
 * Like `MoneyField`, the typed text is kept in local state while editing — otherwise a trailing
 * comma would be normalised away under the cursor — and only the parsed array is reported upward.
 * Use it with RHF's `Controller`. `locked` is the entry that is always kept (the store's default):
 * it is shown, and the hint says so, but removing it from the text does not remove it from the set.
 */
export function CodeListField({
  label,
  value,
  onChange,
  locked,
  normalise = (entry) => entry,
  error,
  hint,
}: {
  label: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  locked: string;
  normalise?: (entry: string) => string;
  error?: string | undefined;
  hint?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value.join(', '));
  const always = `${locked} is the default and is always enabled.`;
  const hintText = hint === undefined ? always : `${hint} ${always}`;

  return (
    <Field label={label} htmlFor={id} error={error} hint={hintText}>
      <input
        id={id}
        value={text}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? `${id}-hint` : `${id}-error`}
        className="border-line bg-surface aria-[invalid=true]:border-danger h-9 w-full rounded-md border px-3 font-mono text-sm"
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseCodeList(event.target.value, normalise));
        }}
        onBlur={() => setText(parseCodeList(text, normalise).join(', '))}
      />
    </Field>
  );
}
