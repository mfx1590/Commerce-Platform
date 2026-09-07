'use client';

import { Badge, Button, Input, Price, Select, cn } from '@platform/ui';
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
const PAYMENT_PROVIDER = 'manual';

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
        defaultValue={cart.email ?? ''}
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

export function PaymentForm({ failed }: { failed: boolean }) {
  const [state, formAction] = useActionState(createPaymentSessionAction, EMPTY);
  const t = useTranslations('checkout.payment');

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

      <div className="flex items-center justify-between rounded-lg border border-border p-4">
        <span className="flex flex-col">
          <span className="font-medium">{t('manual')}</span>
          <span className="text-sm text-muted-foreground">{t('manualBody')}</span>
        </span>
        <Badge variant="neutral">{PAYMENT_PROVIDER}</Badge>
      </div>

      {/* Present so the payment method is an explicit choice, as it will be with real providers. */}
      <Select name="provider" aria-label={t('method')} defaultValue={PAYMENT_PROVIDER} disabled>
        <option value={PAYMENT_PROVIDER}>{t('manual')}</option>
      </Select>

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
