'use client';

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import type { FieldError } from 'react-hook-form';
import { cn } from '@/lib/utils';

/**
 * Field chrome shared by every control: a real `<label>` bound to the input, hint and error text
 * wired through `aria-describedby`, and `aria-invalid` on the control itself — so a screen reader
 * announces the problem when focus lands, rather than only showing red text.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | undefined;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
        {required === true && (
          <span className="text-danger ml-0.5" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {hint !== undefined && error === undefined && (
        <p id={`${htmlFor}-hint`} className="text-muted text-xs">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={`${htmlFor}-error`} className="text-danger text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export function errorMessage(error: FieldError | undefined): string | undefined {
  return typeof error?.message === 'string' && error.message !== '' ? error.message : undefined;
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  if (error !== undefined) return `${id}-error`;
  if (hint !== undefined) return `${id}-hint`;
  return undefined;
}

const CONTROL =
  'border-line bg-surface h-9 w-full rounded-md border px-3 text-sm aria-[invalid=true]:border-danger';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string | undefined;
}

export function TextField({ label, hint, error, className, ...props }: TextFieldProps) {
  const id = useId();
  return (
    <Field
      label={label}
      htmlFor={id}
      error={error}
      {...(hint === undefined ? {} : { hint })}
      {...(props.required === true ? { required: true } : {})}
    >
      <input
        id={id}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(CONTROL, className)}
        {...props}
      />
    </Field>
  );
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string | undefined;
  options: readonly { value: string; label: string }[];
}

export function SelectField({
  label,
  hint,
  error,
  options,
  className,
  ...props
}: SelectFieldProps) {
  const id = useId();
  return (
    <Field
      label={label}
      htmlFor={id}
      error={error}
      {...(hint === undefined ? {} : { hint })}
      {...(props.required === true ? { required: true } : {})}
    >
      <select
        id={id}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(CONTROL, className)}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The banner for a problem no single input owns (403, 5xx, an unknown field from the server). */
export function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p
      role="alert"
      className="border-danger/20 bg-danger/5 text-danger rounded-md border px-3 py-2 text-sm"
    >
      {message}
    </p>
  );
}
