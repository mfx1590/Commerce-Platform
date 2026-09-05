'use client';

import { useId, useState } from 'react';
import { Field } from './fields';
import { currencyDigits, formatMoneyInput, moneyErrorMessage, parseMoney } from '@/lib/forms/money';
import { cn } from '@/lib/utils';

/**
 * A money input that edits **integer minor units**.
 *
 * The form value is never a float: what the user types is parsed by string manipulation
 * (`src/lib/forms/money.ts`), so 12.10 EUR becomes exactly 1210 rather than 1209.9999999999998.
 * The typed text is kept in local state while editing — otherwise "12." would be normalised out
 * from under the cursor the moment the decimal point is typed — and only the parsed integer is
 * reported upward.
 *
 * Use it with RHF's `Controller`:
 *
 * ```tsx
 * <Controller
 *   control={form.control}
 *   name="prices.0.amount_minor"
 *   render={({ field, fieldState }) => (
 *     <MoneyField
 *       label="Price"
 *       currency={currency}
 *       valueMinor={field.value}
 *       onChangeMinor={field.onChange}
 *       error={fieldState.error?.message}
 *     />
 *   )}
 * />
 * ```
 */
export function MoneyField({
  label,
  currency,
  valueMinor,
  onChangeMinor,
  error,
  hint,
  required,
  allowNegative = false,
  name,
}: {
  label: string;
  /** ISO code; decides how many decimal places are accepted (JPY 0, EUR 2, KWD 3). */
  currency: string;
  valueMinor: number | null;
  onChangeMinor: (amountMinor: number | null) => void;
  error?: string | undefined;
  hint?: string;
  required?: boolean;
  allowNegative?: boolean;
  name?: string;
}) {
  const id = useId();
  const [text, setText] = useState(() =>
    valueMinor === null ? '' : formatMoneyInput(valueMinor, currency),
  );
  const [parseError, setParseError] = useState<string | undefined>(undefined);

  // Re-render the same amount with the new number of decimals when the currency changes. Adjusting
  // state during render (React's documented pattern) rather than in an effect: an effect keyed on
  // the currency would still re-run on unrelated renders and fight the person typing.
  const [lastCurrency, setLastCurrency] = useState(currency);
  if (lastCurrency !== currency) {
    setLastCurrency(currency);
    setText(valueMinor === null ? '' : formatMoneyInput(valueMinor, currency));
  }

  const digits = currencyDigits(currency);
  const shown = error ?? parseError;

  return (
    <Field
      label={label}
      htmlFor={id}
      error={shown}
      hint={hint ?? `Amount in ${currency}${digits === 0 ? ', whole units' : ''}`}
      {...(required === true ? { required: true } : {})}
    >
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={name}
          type="text"
          inputMode="decimal"
          value={text}
          aria-invalid={shown !== undefined}
          aria-describedby={shown !== undefined ? `${id}-error` : `${id}-hint`}
          className={cn(
            'border-line bg-surface aria-[invalid=true]:border-danger h-9 w-40 rounded-md border px-3 text-right text-sm',
          )}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);

            if (next.trim() === '') {
              setParseError(undefined);
              onChangeMinor(null);
              return;
            }

            const result = parseMoney(next, currency, { allowNegative });
            if (result.ok) {
              setParseError(undefined);
              onChangeMinor(result.amountMinor);
            } else {
              setParseError(moneyErrorMessage(result.reason, currency));
              // Do not report a half-typed amount as a value; the field is simply not valid yet.
              onChangeMinor(null);
            }
          }}
          onBlur={() => {
            // Normalise on the way out, so 12.5 is stored and shown as 12.50.
            if (valueMinor !== null && parseError === undefined) {
              setText(formatMoneyInput(valueMinor, currency));
            }
          }}
        />
        <span className="text-muted text-sm">{currency}</span>
      </div>
    </Field>
  );
}
