'use client';

import { Badge, Button, Price, cn } from '@platform/ui';
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { addToCartAction, type ActionState } from '@/lib/actions';
import type { Product } from '@/lib/store-api';
import {
  availability,
  defaultSelection,
  findVariant,
  isPurchasable,
  reachableValues,
  withOption,
  type Selection,
} from '@/lib/variant';

/**
 * The only client component on the PDP. The server already rendered the default variant's price and
 * availability, so this hydrates over correct markup rather than filling in a blank.
 *
 * Adding to the cart posts the resolved variant id to a server action — the browser never talks to
 * the Store API, so it cannot invent a price or a quantity the core did not agree to.
 */

const EMPTY: ActionState = {};

function AddToCartButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={disabled} loading={pending}>
      {disabled ? 'Unavailable' : 'Add to cart'}
    </Button>
  );
}
export function VariantPicker({ product, locale }: { product: Product; locale: string }) {
  const [selection, setSelection] = useState<Selection>(() => defaultSelection(product));
  const [state, formAction] = useActionState(addToCartAction, EMPTY);

  const variant = findVariant(product, selection);
  const stock = availability(variant);
  const price = variant?.price ?? product.variants[0]?.price;

  return (
    <div className="flex flex-col gap-6">
      {price === undefined ? null : (
        <Price
          value={price}
          compareAt={variant?.compare_at_price ?? null}
          locale={locale}
          className="text-2xl font-semibold"
        />
      )}

      {product.options.map((option) => {
        const reachable = reachableValues(product, selection, option.name);
        return (
          <fieldset key={option.name} className="flex flex-col gap-2">
            <legend className="text-sm font-medium">
              {option.name}
              {selection[option.name] === undefined ? null : (
                <span className="ml-2 font-normal text-muted-foreground">
                  {selection[option.name]}
                </span>
              )}
            </legend>
            <div className="flex flex-wrap gap-2">
              {option.values.map((value) => {
                const selected = selection[option.name] === value;
                const exists = reachable.has(value);
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={!exists}
                    aria-pressed={selected}
                    onClick={() => setSelection(withOption(product, selection, option.name, value))}
                    className={cn(
                      'rounded-md border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border hover:bg-muted',
                      !exists && 'cursor-not-allowed opacity-40 line-through',
                    )}
                  >
                    {value}
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <AvailabilityNote stock={stock} />

      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="variant_id" value={variant?.id ?? ''} />
        <input type="hidden" name="quantity" value="1" />
        <AddToCartButton disabled={!isPurchasable(variant)} />
        {state.error === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </form>
      {variant === undefined ? null : (
        <p className="text-sm text-muted-foreground">SKU {variant.sku}</p>
      )}
    </div>
  );
}

function AvailabilityNote({ stock }: { stock: ReturnType<typeof availability> }) {
  switch (stock.state) {
    // `self-start` matters: the picker is a flex column, which would otherwise stretch the badge.
    case 'in_stock':
      return (
        <Badge variant="success" className="self-start">
          In stock
        </Badge>
      );
    case 'low_stock':
      return (
        <Badge variant="destructive" className="self-start">
          Only {stock.quantity} left
        </Badge>
      );
    case 'backorder':
      return (
        <Badge variant="neutral" className="self-start">
          On backorder — ships when restocked
        </Badge>
      );
    case 'out_of_stock':
      return (
        <Badge variant="neutral" className="self-start">
          Out of stock
        </Badge>
      );
  }
}
