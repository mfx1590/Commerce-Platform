'use client';

import { Button, Input, Price, cn } from '@platform/ui';
import { useTranslations } from 'next-intl';
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

/**
 * The contract's payment provider id (`PaymentSession.provider`), not copy: an identifier is the
 * same in every language, so it is a constant rather than a catalogue entry.
 */

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

export function AddressForm({
  cart,
  defaultCountry,
  defaultEmail,
}: {
  cart: Cart;
  defaultCountry: string;
  /** The cart's email, or a signed-in customer's (#351); see `checkoutEmailDefault`. */
  defaultEmail: string;
}) {
  const [state, formAction] = useActionState(saveAddressAction, EMPTY);
  const t = useTranslations('checkout.address');
  const address: Partial<Address> = cart.shipping_address ?? {};
  const errors = state.fieldErrors;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <ErrorNote state={state} />
      <Field
        name="email"
        label={t('email')}
        type="email"
        autoComplete="email"
        errors={errors}
        defaultValue={defaultEmail}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="first_name"
          label={t('firstName')}
          autoComplete="given-name"
          errors={errors}
          defaultValue={address.first_name}
        />
        <Field
          name="last_name"
          label={t('lastName')}
          autoComplete="family-name"
          errors={errors}
          defaultValue={address.last_name}
        />
      </div>
      <Field
        name="company"
        label={t('company')}
        autoComplete="organization"
        errors={errors}
        defaultValue={address.company ?? ''}
      />
      <Field
        name="line1"
        label={t('line1')}
        autoComplete="address-line1"
        errors={errors}
        defaultValue={address.line1}
      />
      <Field
        name="line2"
        label={t('line2')}
        autoComplete="address-line2"
        errors={errors}
        defaultValue={address.line2 ?? ''}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          name="postal_code"
          label={t('postalCode')}
          autoComplete="postal-code"
          errors={errors}
          defaultValue={address.postal_code}
        />
        <Field
          name="city"
          label={t('city')}
          autoComplete="address-level2"
          errors={errors}
          defaultValue={address.city}
        />
        <Field
          name="region"
          label={t('region')}
          autoComplete="address-level1"
          errors={errors}
          defaultValue={address.region ?? ''}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="country"
          label={t('country')}
          autoComplete="country"
          maxLength={2}
          errors={errors}
          defaultValue={address.country ?? defaultCountry}
        />
        <Field
          name="phone"
          label={t('phone')}
          type="tel"
          autoComplete="tel"
          errors={errors}
          defaultValue={address.phone ?? ''}
        />
      </div>
      <SubmitButton>{t('submit')}</SubmitButton>
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
  const t = useTranslations('checkout.shipping');

  if (options.length === 0) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {t('none')}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <ErrorNote state={state} />
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">{t('legend')}</legend>
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
      <SubmitButton>{t('submit')}</SubmitButton>
    </form>
  );
}

/**
 * The payment method (#358): Card (Stripe Payment Element) when the store has a publishable key,
 * Pay on invoice when the store allows it — whatever the server says is on offer, re-checked on
 * submit. Choosing creates the payment session; the card itself is entered on the review step, where
 * "Place order" confirms it, so no authorisation is held before the customer has seen the total.
 */
export function PaymentForm({
  failed,
  methods,
  selected,
}: {
  failed: boolean;
  methods: { card: boolean; invoice: boolean };
  selected: 'stripe' | 'manual' | null;
}) {
  const [state, formAction] = useActionState(createPaymentSessionAction, EMPTY);
  const t = useTranslations('checkout.payment');
  const offered = [
    ...(methods.card ? [{ id: 'stripe', label: t('card'), body: t('cardBody') }] : []),
    ...(methods.invoice ? [{ id: 'manual', label: t('manual'), body: t('manualBody') }] : []),
  ];

  if (offered.length === 0) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {t('none')}
      </p>
    );
  }
  const preselected = offered.some((method) => method.id === selected) ? selected : offered[0]!.id;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {failed ? (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {t('failed')}
        </p>
      ) : null}
      <ErrorNote state={state} />

      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">{t('method')}</legend>
        {offered.map((method) => (
          <label
            key={method.id}
            className={cn(
              'flex cursor-pointer items-center gap-3 rounded-lg border border-border p-4',
              'has-[:checked]:border-primary',
            )}
          >
            <input
              type="radio"
              name="provider"
              value={method.id}
              defaultChecked={method.id === preselected}
              className="h-4 w-4"
            />
            <span className="flex flex-col">
              <span className="font-medium">{method.label}</span>
              <span className="text-sm text-muted-foreground">{method.body}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <SubmitButton>{t('submit')}</SubmitButton>
    </form>
  );
}

export function PlaceOrderForm() {
  const [state, formAction] = useActionState(placeOrderAction, EMPTY);
  const t = useTranslations('checkout.review');

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <ErrorNote state={state} />
      <SubmitButton>{t('placeOrder')}</SubmitButton>
      <p className="text-sm text-muted-foreground">{t('idempotencyNote')}</p>
    </form>
  );
}
