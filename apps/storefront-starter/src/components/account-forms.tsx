'use client';

import { Button, Input } from '@platform/ui';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  addAddressAction,
  updateProfileAction,
  type AccountActionState,
} from '@/lib/account-actions';
import type { Customer } from '@/lib/store-api';

const EMPTY: AccountActionState = {};

function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending}>
      {children}
    </Button>
  );
}

function Notice({ state, success }: { state: AccountActionState; success: string }) {
  if (state.error !== undefined) {
    return (
      <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
        {state.error}
      </p>
    );
  }
  if (state.ok === true) {
    return (
      <p role="status" className="rounded-md border border-success p-3 text-sm text-success">
        {success}
      </p>
    );
  }
  return null;
}

function Field({
  name,
  label,
  errors,
  defaultValue,
  ...props
}: {
  name: string;
  label: string;
  errors?: Record<string, string> | undefined;
  defaultValue?: string | undefined;
} & Omit<React.ComponentProps<typeof Input>, 'name' | 'defaultValue'>) {
  const error = errors?.[name];
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`account-${name}`} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={`account-${name}`}
        name={name}
        defaultValue={defaultValue ?? ''}
        invalid={error !== undefined}
        {...props}
      />
      {error === undefined ? null : <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function ProfileForm({ customer }: { customer: Customer }) {
  const [state, formAction] = useActionState(updateProfileAction, EMPTY);

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-4">
      <Notice state={state} success="Profile updated." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="first_name"
          label="First name"
          autoComplete="given-name"
          defaultValue={customer.first_name ?? ''}
        />
        <Field
          name="last_name"
          label="Last name"
          autoComplete="family-name"
          defaultValue={customer.last_name ?? ''}
        />
      </div>
      <Field
        name="phone"
        label="Phone"
        type="tel"
        autoComplete="tel"
        defaultValue={customer.phone ?? ''}
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="marketing_consent"
          defaultChecked={customer.marketing_consent}
          className="h-4 w-4"
        />
        Send me offers and news
      </label>
      <SubmitButton>Save profile</SubmitButton>
    </form>
  );
}

export function AddAddressForm() {
  const [state, formAction] = useActionState(addAddressAction, EMPTY);
  const errors = state.fieldErrors;

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-4">
      <Notice state={state} success="Address added." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="first_name" label="First name" errors={errors} autoComplete="given-name" />
        <Field name="last_name" label="Last name" errors={errors} autoComplete="family-name" />
      </div>
      <Field name="line1" label="Address" errors={errors} autoComplete="address-line1" />
      <Field
        name="line2"
        label="Apartment, suite (optional)"
        errors={errors}
        autoComplete="address-line2"
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field name="postal_code" label="Postal code" errors={errors} autoComplete="postal-code" />
        <Field name="city" label="City" errors={errors} autoComplete="address-level2" />
        <Field name="country" label="Country code" errors={errors} maxLength={2} />
      </div>
      <SubmitButton>Add address</SubmitButton>
    </form>
  );
}

export function SignOutButton() {
  return (
    <form action="/account/sign-out" method="post">
      <Button type="submit" variant="outline">
        Sign out
      </Button>
    </form>
  );
}
