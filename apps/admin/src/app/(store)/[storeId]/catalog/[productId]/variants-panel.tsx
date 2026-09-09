'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import { MoneyField } from '@/components/form/money-field';
import { createVariantAction, updateVariantAction } from '@/app/actions/catalog';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { formatMoney } from '@/lib/forms/money';
import {
  missingCombinations,
  suggestSku,
  variantTitle,
  type VariantCombination,
} from '@/lib/forms/variant-matrix';

type Product = AdminComponents['Product'];
type Variant = AdminComponents['Variant'];

/**
 * Variants: what exists, and what the options imply but does not exist yet.
 *
 * Saving options deliberately does **not** create variants. A variant is a sellable thing with its
 * own SKU, price and stock, so adding a colour to a live product must not silently POST several of
 * them — the same reason the data-table will not select a whole result set behind one checkbox.
 * Missing rows are offered here, one button each, plus an explicit "create all" that names the
 * count.
 */
export function VariantsPanel({ storeId, product }: { storeId: string; product: Product }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);
  const [editing, setEditing] = useState<string | null>(null);

  const drafts = product.options.map((option) => ({ name: option.name, values: option.values }));
  const missing = missingCombinations(drafts, product.variants);

  const create = (combinations: readonly VariantCombination[]) => {
    setError(null);
    setRefusal(undefined);
    startTransition(async () => {
      for (const combination of combinations) {
        const result = await createVariantAction(storeId, product.id, {
          sku: suggestSku(product.handle, combination),
          title: variantTitle(combination, drafts),
          options: combination,
        });
        if (result.status === 'error') {
          // Stop at the first refusal rather than pressing on: the rest would likely fail the same
          // way, and a half-created matrix is harder to reason about than a stated failure.
          setRefusal(result.refusal);
          setError(
            result.refusal === undefined
              ? (result.formError ?? 'Could not create this variant.')
              : null,
          );
          break;
        }
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <ActionRefusal refusal={refusal} message={error} />

      {product.variants.length === 0 ? (
        <p className="text-muted text-sm">No variants yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Variants">
            <thead className="border-line border-b">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Title
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  SKU
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Options
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Price
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {product.variants.map((variant) =>
                editing === variant.id ? (
                  <VariantEditRow
                    key={variant.id}
                    storeId={storeId}
                    variant={variant}
                    onDone={() => {
                      setEditing(null);
                      router.refresh();
                    }}
                  />
                ) : (
                  <tr key={variant.id}>
                    <td className="px-3 py-2">{variant.title}</td>
                    <td className="px-3 py-2 font-mono text-xs">{variant.sku}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(variant.options).map(([name, value]) => (
                          <Badge key={name}>{`${name}: ${value}`}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {variant.prices.length === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        variant.prices
                          .map((price) => formatMoney(price.amount_minor, price.currency))
                          .join(' · ')
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(variant.id)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {missing.length > 0 && (
        <div className="border-line space-y-3 border-t pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              The options describe{' '}
              <strong>
                {missing.length} variant{missing.length === 1 ? '' : 's'}
              </strong>{' '}
              that {missing.length === 1 ? 'does' : 'do'} not exist yet.
            </p>
            <Button size="sm" disabled={isPending} onClick={() => create(missing)}>
              {isPending ? 'Creating…' : `Create all ${missing.length}`}
            </Button>
          </div>
          <ul className="divide-line divide-y text-sm">
            {missing.map((combination) => {
              const title = variantTitle(combination, drafts);
              return (
                <li key={title} className="flex flex-wrap items-center gap-3 py-2">
                  <span>{title}</span>
                  <span className="text-muted font-mono text-xs">
                    {suggestSku(product.handle, combination)}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="ml-auto"
                    disabled={isPending}
                    onClick={() => create([combination])}
                  >
                    Create
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Inline edit of one variant: SKU, title and the price per currency it already carries. */
function VariantEditRow({
  storeId,
  variant,
  onDone,
}: {
  storeId: string;
  variant: Variant;
  onDone: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [sku, setSku] = useState(variant.sku);
  const [title, setTitle] = useState(variant.title);
  const [prices, setPrices] = useState(
    variant.prices.map((price) => ({
      currency: price.currency,
      amount_minor: price.amount_minor as number | null,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);

  const save = () => {
    setError(null);
    setRefusal(undefined);
    startTransition(async () => {
      const result = await updateVariantAction(storeId, variant.id, {
        sku,
        title,
        options: variant.options,
        prices: prices
          .filter(
            (price): price is { currency: string; amount_minor: number } =>
              price.amount_minor !== null,
          )
          .map((price) => ({ currency: price.currency, amount_minor: price.amount_minor })),
      });
      if (result.status === 'error') {
        setRefusal(result.refusal);
        setError(
          result.refusal === undefined
            ? (result.formError ?? 'Could not save this variant.')
            : null,
        );
        return;
      }
      onDone();
    });
  };

  return (
    <tr>
      <td className="px-3 py-2">
        <label className="sr-only" htmlFor={`title-${variant.id}`}>
          Title
        </label>
        <input
          id={`title-${variant.id}`}
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          className="border-line bg-surface h-9 w-32 rounded-md border px-2 text-sm"
        />
      </td>
      <td className="px-3 py-2">
        <label className="sr-only" htmlFor={`sku-${variant.id}`}>
          SKU
        </label>
        <input
          id={`sku-${variant.id}`}
          value={sku}
          onChange={(event) => setSku(event.currentTarget.value)}
          className="border-line bg-surface h-9 w-32 rounded-md border px-2 font-mono text-xs"
        />
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {Object.entries(variant.options).map(([name, value]) => (
            <Badge key={name}>{`${name}: ${value}`}</Badge>
          ))}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="space-y-2">
          {prices.map((price, index) => (
            <MoneyField
              key={price.currency}
              label={`Price (${price.currency})`}
              currency={price.currency}
              valueMinor={price.amount_minor}
              onChangeMinor={(amountMinor) =>
                setPrices((current) =>
                  current.map((entry, position) =>
                    position === index ? { ...entry, amount_minor: amountMinor } : entry,
                  ),
                )
              }
            />
          ))}
          {prices.length === 0 && <span className="text-muted text-sm">No price list entry</span>}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" disabled={isPending} onClick={save}>
            {isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
        {(error !== null || refusal !== undefined) && (
          <ActionRefusal refusal={refusal} message={error} />
        )}
      </td>
    </tr>
  );
}
