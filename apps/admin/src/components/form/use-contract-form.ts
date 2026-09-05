'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState, useTransition, type BaseSyntheticEvent } from 'react';
import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from 'react-hook-form';
import type { ZodType } from 'zod';
import type { ActionResult } from '@/lib/forms/action-result';

export interface ContractForm<TValues extends FieldValues, TData> {
  form: UseFormReturn<TValues>;
  submit: (event?: BaseSyntheticEvent) => Promise<void>;
  isSubmitting: boolean;
  /** The problem no single input owns. Render it above the fields. */
  formError: string | null;
  lastResult: ActionResult<TData> | null;
}

export interface ContractFormOptions<TValues extends FieldValues, TData> {
  /**
   * Output and input are the same type on purpose: these schemas validate, they do not transform.
   * It is also what lets `zodResolver` line up with `useForm<TValues>` under
   * `exactOptionalPropertyTypes`.
   */
  schema: ZodType<TValues, TValues>;
  /** A server action. It returns an `ActionResult` — it never throws a rejection at the form. */
  action: (values: TValues) => Promise<ActionResult<TData>>;
  defaultValues: DefaultValues<TValues>;
  onSuccess?: (data: TData) => void;
  /**
   * Opt-in only, and deliberately so: an admin form that shows a save as done before the server
   * agreed is a form that lies about whether a price changed. Pass this when the screen genuinely
   * benefits, never by default.
   */
  optimistic?: (values: TValues) => void;
}

/**
 * The one way this app builds a form.
 *
 * Client-side validation comes from the same Zod schema the server action re-validates, so the two
 * cannot disagree about what is valid. When the Admin API refuses anyway, the action hands back
 * `fieldErrors` keyed by contract field path and the hook attaches them with `setError`, so
 * `400 { details: { field: 'handle' } }` appears *under the handle input*. Anything the form does
 * not render is raised to `formError` instead of being attached to an invisible control.
 *
 * Server errors are cleared on the next submit: a stale "handle already exists" under a handle the
 * user has since changed is worse than no message.
 */
export function useContractForm<TValues extends FieldValues, TData>({
  schema,
  action,
  defaultValues,
  onSuccess,
  optimistic,
}: ContractFormOptions<TValues, TData>): ContractForm<TValues, TData> {
  const form = useForm<TValues>({
    resolver: zodResolver(schema),
    defaultValues,
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const [isPending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ActionResult<TData> | null>(null);

  const submit = form.handleSubmit((values) => {
    setFormError(null);
    form.clearErrors();
    optimistic?.(values);

    startTransition(async () => {
      const result = await action(values);
      setLastResult(result);

      if (result.status === 'success') {
        onSuccess?.(result.data);
        return;
      }

      const entries = Object.entries(result.fieldErrors);
      entries.forEach(([field, message], index) => {
        // Put the cursor on the first thing that needs fixing.
        form.setError(
          field as Path<TValues>,
          { type: 'server', message },
          { shouldFocus: index === 0 },
        );
      });
      setFormError(result.formError);
    });
  });

  return {
    form,
    submit,
    isSubmitting: isPending || form.formState.isSubmitting,
    formError,
    lastResult,
  };
}
