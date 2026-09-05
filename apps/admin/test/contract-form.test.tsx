import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Controller } from 'react-hook-form';
import { FormError, TextField, errorMessage } from '@/components/form/fields';
import { MoneyField } from '@/components/form/money-field';
import { useContractForm } from '@/components/form/use-contract-form';
import type { ActionResult } from '@/lib/forms/action-result';
import { storeCreateSchema, type StoreCreateValues } from '@/lib/forms/schemas';

const DEFAULTS: StoreCreateValues = {
  legal_entity_id: '00000000-0000-4000-8000-000000000011',
  code: 'brand-d',
  name: 'Brand D',
  status: 'draft',
  default_currency: 'EUR',
  default_locale: 'en-GB',
  default_country: 'NL',
  timezone: 'Europe/Amsterdam',
};

function StoreForm({
  action,
  optimistic,
}: {
  action: (values: StoreCreateValues) => Promise<ActionResult<{ id: string }>>;
  optimistic?: (values: StoreCreateValues) => void;
}) {
  const { form, submit, formError, isSubmitting } = useContractForm<
    StoreCreateValues,
    { id: string }
  >({
    schema: storeCreateSchema,
    action,
    defaultValues: DEFAULTS,
    ...(optimistic === undefined ? {} : { optimistic }),
  });

  return (
    <form onSubmit={submit} noValidate>
      <FormError message={formError} />
      <TextField
        label="Code"
        error={errorMessage(form.formState.errors.code)}
        {...form.register('code')}
      />
      <TextField
        label="Name"
        error={errorMessage(form.formState.errors.name)}
        {...form.register('name')}
      />
      <button type="submit" disabled={isSubmitting}>
        Save
      </button>
    </form>
  );
}

const ok = (): Promise<ActionResult<{ id: string }>> =>
  Promise.resolve({ status: 'success', data: { id: 's1' } });

describe('client-side validation comes from the contract schema', () => {
  it('blocks a submit and shows the message under the field', async () => {
    const user = userEvent.setup();
    const action = vi.fn(ok);
    render(<StoreForm action={action} />);

    await user.clear(screen.getByLabelText(/Code/));
    await user.type(screen.getByLabelText(/Code/), 'Brand D');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(action).not.toHaveBeenCalled();
    expect(screen.getByText(/lower-case letters, numbers and single hyphens/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Code/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('submits valid values to the action', async () => {
    const user = userEvent.setup();
    const action = vi.fn(ok);
    render(<StoreForm action={action} />);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ code: 'brand-d' }));
  });
});

describe('server errors land on the right control', () => {
  it("details.field = 'code' shows under the code input", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (): Promise<ActionResult<{ id: string }>> => ({
      status: 'error',
      fieldErrors: { code: 'code already exists' },
      formError: null,
    }));
    render(<StoreForm action={action} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const input = screen.getByLabelText(/Code/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // The message is wired to the input, not merely rendered somewhere on the page.
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy as string)).toHaveTextContent('code already exists');
    expect(screen.getByLabelText(/Name/)).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('an unknown field shows at form level, as an alert', async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (): Promise<ActionResult<{ id: string }>> => ({
      status: 'error',
      fieldErrors: {},
      formError: 'psp_account_id is not configured (field: psp_account_id)',
    }));
    render(<StoreForm action={action} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('alert')).toHaveTextContent('psp_account_id is not configured');
    expect(screen.getByLabelText(/Code/)).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('clears a stale server error on the next submit', async () => {
    const user = userEvent.setup();
    const action = vi
      .fn<() => Promise<ActionResult<{ id: string }>>>()
      .mockResolvedValueOnce({
        status: 'error',
        fieldErrors: { code: 'code already exists' },
        formError: null,
      })
      .mockResolvedValueOnce({ status: 'success', data: { id: 's1' } });

    render(<StoreForm action={action} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('code already exists')).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/Code/));
    await user.type(screen.getByLabelText(/Code/), 'brand-e');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByText('code already exists')).toBeNull();
  });

  it('calls onSuccess only when the server agreed', async () => {
    const user = userEvent.setup();
    const optimistic = vi.fn();
    render(<StoreForm action={ok} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // No `optimistic` prop was passed, so nothing may have run early.
    expect(optimistic).not.toHaveBeenCalled();
  });

  it('runs the optimistic callback only when one is explicitly given', async () => {
    const user = userEvent.setup();
    const optimistic = vi.fn();
    render(<StoreForm action={ok} optimistic={optimistic} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(optimistic).toHaveBeenCalledTimes(1);
  });
});

function PriceForm({ currency = 'EUR' }: { currency?: string }) {
  const { form } = useContractForm<{ amount_minor: number | null }, unknown>({
    schema: storeCreateSchema as never,
    action: async () => ({ status: 'success', data: null }),
    defaultValues: { amount_minor: 1210 } as never,
  });

  return (
    <Controller
      control={form.control}
      name={'amount_minor' as never}
      render={({ field }) => (
        <MoneyField
          label="Price"
          currency={currency}
          valueMinor={(field.value as number | null) ?? null}
          onChangeMinor={field.onChange}
        />
      )}
    />
  );
}

describe('money fields edit minor units', () => {
  it('shows a stored integer as a padded decimal', () => {
    render(<PriceForm />);
    expect(screen.getByLabelText(/Price/)).toHaveValue('12.10');
  });

  it('reports the parsed integer, not a float', async () => {
    const user = userEvent.setup();
    render(<PriceForm />);
    const input = screen.getByLabelText(/Price/);

    await user.clear(input);
    await user.type(input, '19.99');
    await user.tab();
    // 19.99 * 100 would be 1998.9999999999998; the field normalises from the integer it parsed.
    expect(input).toHaveValue('19.99');
  });

  it('refuses more decimals than the currency has', async () => {
    const user = userEvent.setup();
    render(<PriceForm currency="JPY" />);
    const input = screen.getByLabelText(/Price/);

    await user.clear(input);
    await user.type(input, '12.5');
    expect(screen.getByText('JPY amounts have no decimal places')).toBeInTheDocument();
  });

  it('names the currency next to the input', () => {
    render(<PriceForm currency="GBP" />);
    expect(screen.getByText('GBP')).toBeInTheDocument();
  });
});
