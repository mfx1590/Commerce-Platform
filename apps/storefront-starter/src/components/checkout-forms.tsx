'use client';

import { Badge, Button, Input, Price, Select, cn } from '@platform/ui';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  createPaymentSessionAction,
  placeOrderAction,
  saveAddressAction,
  saveShippingAction,
  type ActionState,
} from '@/lib/actions';
import type { Address, Cart, ShippingOption } from '@/lib/store-api';

/**
 * The checkout forms. Each one posts to a server action — the browser never calls the Store API,
 * so the publishable key, prices and totals stay server-side. Client components only because they
 * render validation messages that come back from the action.
 */

const EMPTY: ActionState = {};

function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" loading={pending}>
      {children}
    </Button>
  );
}

function ErrorNote({ state }: { state: ActionState }) {
  if (state.error === undefined) return null;
  return (
    <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
      {state.error}
    </p>
  );
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
  errors: Record<string, string> | undefined;
  defaultValue?: string | undefined;
} & Omit<React.ComponentProps<typeof Input>, 'name' | 'defaultValue'>) {
  const error = errors?.[name];
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={name}
        name={name}
        defaultValue={defaultValue ?? ''}
        invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : `${name}-error`}
        {...props}
      />
      {error === undefined ? null : (
        <p id={`${name}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function AddressForm({ cart, defaultCountry }: { cart: Cart; defaultCountry: string }) {
  const [state, formAction] = useActionState(saveAddressAction, EMPTY);
  const address: Partial<Address> = cart.shipping_address ?? {};
  const errors = state.fieldErrors;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <ErrorNote state={state} />
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        errors={errors}
        defaultValue={cart.email ?? ''}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="first_name"
          label="First name"
          autoComplete="given-name"
          errors={errors}
          defaultValue={address.first_name}
        />
        <Field
          name="last_name"
          label="Last name"
          autoComplete="family-name"
          errors={errors}
          defaultValue={address.last_name}
        />
      </div>
      <Field
        name="company"
        label="Company (optional)"
        autoComplete="organization"
        errors={errors}
        defaultValue={address.company ?? ''}
      />
      <Field
        name="line1"
        label="Address"
        autoComplete="address-line1"
        errors={errors}
        defaultValue={address.line1}
      />
      <Field
        name="line2"
        label="Apartment, suite (optional)"
        autoComplete="address-line2"
        errors={errors}
        defaultValue={address.line2 ?? ''}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          name="postal_code"
          label="Postal code"
          autoComplete="postal-code"
          errors={errors}
          defaultValue={address.postal_code}
        />
        <Field
          name="city"
          label="City"
          autoComplete="address-level2"
          errors={errors}
          defaultValue={address.city}
        />
        <Field
          name="region"
          label="Region (optional)"
          autoComplete="address-level1"
          errors={errors}
          defaultValue={address.region ?? ''}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="country"
          label="Country code"
          autoComplete="country"
          maxLength={2}
          errors={errors}
          defaultValue={address.country ?? defaultCountry}
        />
        <Field
          name="phone"
          label="Phone (optional)"
          type="tel"
          autoComplete="tel"
          errors={errors}
          defaultValue={address.phone ?? ''}
        />
      </div>
      <SubmitButton>Continue to delivery</SubmitButton>
    </form>
  );
}

export function ShippingForm({
  options,
  selectedId,
  locale,
}: {
  options: ShippingOption[];
  selectedId: string | null;
  locale: string;
}) {
  const [state, formAction] = useActionState(saveShippingAction, EMPTY);

  if (options.length === 0) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        No delivery options are available for this address. Go back and check the address.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <ErrorNote state={state} />
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">Delivery option</legend>
        {options.map((option, index) => (
          <label
            key={option.id}
            className={cn(
              'flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border p-4',
              'has-[:checked]:border-primary',
            )}
          >
            <span className="flex items-center gap-3">
              <input
                type="radio"
                name="shipping_option_id"
                value={option.id}
                defaultChecked={selectedId === null ? index === 0 : selectedId === option.id}
                className="h-4 w-4"
              />
              <span className="flex flex-col">
                <span className="font-medium">{option.name}</span>
                <span className="text-sm text-muted-foreground">{option.carrier}</span>
              </span>
            </span>
            <Price value={option.price} locale={locale} />
          </label>
        ))}
      </fieldset>
      <SubmitButton>Continue to payment</SubmitButton>
    </form>
  );
}

export function PaymentForm({ failed }: { failed: boolean }) {
  const [state, formAction] = useActionState(createPaymentSessionAction, EMPTY);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {failed ? (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          Payment was not authorised. Choose a payment method and try again.
        </p>
      ) : null}
      <ErrorNote state={state} />

      <div className="flex items-center justify-between rounded-lg border border-border p-4">
        <span className="flex flex-col">
          <span className="font-medium">Pay on invoice</span>
          <span className="text-sm text-muted-foreground">
            Phase 1 placeholder — the <code>manual</code> provider. Card payment arrives with hosted
            fields, so card data never reaches this app.
          </span>
        </span>
        <Badge variant="neutral">manual</Badge>
      </div>

      {/* Present so the payment method is an explicit choice, as it will be with real providers. */}
      <Select name="provider" aria-label="Payment method" defaultValue="manual" disabled>
        <option value="manual">Pay on invoice</option>
      </Select>

      <SubmitButton>Continue to review</SubmitButton>
    </form>
  );
}

export function PlaceOrderForm() {
  const [state, formAction] = useActionState(placeOrderAction, EMPTY);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <ErrorNote state={state} />
      <SubmitButton>Place order</SubmitButton>
      <p className="text-sm text-muted-foreground">
        Placing the order sends an idempotency key, so a retry after a network error cannot create a
        second order.
      </p>
    </form>
  );
}
