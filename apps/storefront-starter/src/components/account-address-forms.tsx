'use client';

import { Button, Input } from '@platform/ui';
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  deleteAddressAction,
  updateAddressAction,
  type AccountActionState,
} from '@/app/[locale]/(account)/account/actions';
import type { CustomerAddress } from '@/lib/store-api';

const EMPTY: AccountActionState = {};

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
  id,
  name,
  label,
  errors,
  defaultValue,
  ...props
}: {
  id: string;
  name: string;
  label: string;
  errors?: Record<string, string> | undefined;
  defaultValue?: string | null | undefined;
} & Omit<React.ComponentProps<typeof Input>, 'name' | 'defaultValue' | 'id'>) {
  const error = errors?.[name];
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        name={name}
        defaultValue={defaultValue ?? ''}
        invalid={error !== undefined}
        {...props}
      />
      {error === undefined ? null : <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function Pending({ children, variant }: { children: React.ReactNode; variant?: 'destructive' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...(variant ? { variant } : {})}>
      {children}
    </Button>
  );
}

/**
 * Edit one saved address (#470, Store API 0.5.6 `updateMyAddress`). Collapsed to a button until the customer
 * opens it, so the address book stays a list. The form is pre-filled; the two default checkboxes are shown only
 * when the address does not hold that default yet (a default is moved by ticking it elsewhere, never given up).
 */
export function EditAddressForm({ address }: { address: CustomerAddress }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(updateAddressAction.bind(null, address.id), EMPTY);
  const errors = state.fieldErrors;
  const prefix = `address-${address.id}`;

  if (!open && state.ok !== true) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
    );
  }
  return (
    <form action={formAction} className="mt-3 flex flex-col gap-3" aria-label="Edit address">
      <Notice state={state} success="Address updated." />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id={`${prefix}-first_name`}
          name="first_name"
          label="First name"
          errors={errors}
          defaultValue={address.first_name}
          autoComplete="given-name"
        />
        <Field
          id={`${prefix}-last_name`}
          name="last_name"
          label="Last name"
          errors={errors}
          defaultValue={address.last_name}
          autoComplete="family-name"
        />
      </div>
      <Field
        id={`${prefix}-company`}
        name="company"
        label="Company (optional)"
        errors={errors}
        defaultValue={address.company}
        autoComplete="organization"
      />
      <Field
        id={`${prefix}-line1`}
        name="line1"
        label="Address"
        errors={errors}
        defaultValue={address.line1}
        autoComplete="address-line1"
      />
      <Field
        id={`${prefix}-line2`}
        name="line2"
        label="Apartment, suite (optional)"
        errors={errors}
        defaultValue={address.line2}
        autoComplete="address-line2"
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          id={`${prefix}-postal_code`}
          name="postal_code"
          label="Postal code"
          errors={errors}
          defaultValue={address.postal_code}
          autoComplete="postal-code"
        />
        <Field
          id={`${prefix}-city`}
          name="city"
          label="City"
          errors={errors}
          defaultValue={address.city}
          autoComplete="address-level2"
        />
        <Field
          id={`${prefix}-country`}
          name="country"
          label="Country code"
          errors={errors}
          defaultValue={address.country}
          maxLength={2}
        />
      </div>
      <Field
        id={`${prefix}-region`}
        name="region"
        label="Region (optional)"
        errors={errors}
        defaultValue={address.region}
        autoComplete="address-level1"
      />
      <Field
        id={`${prefix}-phone`}
        name="phone"
        label="Phone (optional)"
        type="tel"
        errors={errors}
        defaultValue={address.phone}
        autoComplete="tel"
      />
      {address.is_default_shipping ? null : (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="is_default_shipping" className="h-4 w-4" />
          Use as my delivery address
        </label>
      )}
      {address.is_default_billing ? null : (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="is_default_billing" className="h-4 w-4" />
          Use as my billing address
        </label>
      )}
      <div className="flex items-center gap-2">
        <Pending>Save address</Pending>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Remove one saved address (`deleteMyAddress`, 200 with the remaining addresses). One click asks, the second confirms — a deleted
 * address is gone; when it was a default, the oldest remaining address becomes the default (the API's rule).
 */
export function DeleteAddressButton({ addressId }: { addressId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction] = useActionState(deleteAddressAction.bind(null, addressId), EMPTY);

  if (!confirming) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        Remove
      </Button>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-2" aria-label="Remove address">
      <Notice state={state} success="Address removed." />
      <p className="text-sm text-muted-foreground">Remove this address?</p>
      <div className="flex items-center gap-2">
        <Pending variant="destructive">Yes, remove</Pending>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
    </form>
  );
}
