'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import { MoneyField } from '@/components/form/money-field';
import { createVariantAction, updateVariantAction } from '@/app/actions/catalog';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  compareAtWarnings,
  COUNTRY,
  HS_CODE,
  missingVariantData,
  normalizeCountry,
  normalizeHsCode,
  parseWhole,
} from '@/lib/catalog/attributes';
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
 *
 * Each row says what shipping and customs data the variant still lacks (#870 item 5); "Edit" opens
 * every attribute the Admin API takes. A variant cannot be deleted: the API has no operation for it
 * (filed under #870).
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
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Shipping &amp; customs
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {product.variants.map((variant) =>
                editing === variant.id ? (
                  <VariantEditor
                    key={variant.id}
                    storeId={storeId}
                    variant={variant}
                    onDone={() => {
                      setEditing(null);
                      router.refresh();
                    }}
                  />
                ) : (
                  <tr key={variant.id} aria-label={`Variant ${variant.sku}`}>
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
                        <span className="text-muted">No price yet</span>
                      ) : (
                        variant.prices.map((price) => (
                          <span key={price.currency} className="block">
                            {formatMoney(price.amount_minor, price.currency)}
                            {price.compare_at_minor !== null && (
                              <span className="text-muted ml-1 line-through">
                                {formatMoney(price.compare_at_minor, price.currency)}
                              </span>
                            )}
                          </span>
                        ))
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {(() => {
                        const lacks = missingVariantData(variant);
                        return lacks.length === 0 ? (
                          <Badge tone="success">complete</Badge>
                        ) : (
                          <span className="text-warning text-xs">missing: {lacks.join(', ')}</span>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Edit ${variant.sku}`}
                        onClick={() => setEditing(variant.id)}
                      >
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
      {product.variants.length > 0 && (
        <p className="text-muted text-xs">
          A variant cannot be deleted here: the Admin API has no operation for it yet.
        </p>
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

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      {children}
      {hint !== undefined && <span className="text-muted text-xs">{hint}</span>}
      {error !== undefined && (
        <span role="alert" className="text-danger text-xs">
          {error}
        </span>
      )}
    </div>
  );
}

const input = 'border-line bg-surface h-9 rounded-md border px-2 text-sm';

/**
 * Every attribute of one variant the Admin API takes (#870 item 5): identity, barcode, inventory
 * behaviour, shipping (weight, dimensions) and customs (HS code, origin), and per currency the price
 * and its compare-at price. Formats are checked here and again on the server; a compare-at that
 * shows no saving is a warning, not a block.
 */
function VariantEditor({
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
  const [barcode, setBarcode] = useState(variant.barcode ?? '');
  const [manageInventory, setManageInventory] = useState(variant.manage_inventory);
  const [allowBackorder, setAllowBackorder] = useState(variant.allow_backorder);
  const [weight, setWeight] = useState(variant.weight_g === null ? '' : String(variant.weight_g));
  const [dims, setDims] = useState({
    l: variant.dimensions_mm?.l === undefined ? '' : String(variant.dimensions_mm.l),
    w: variant.dimensions_mm?.w === undefined ? '' : String(variant.dimensions_mm.w),
    h: variant.dimensions_mm?.h === undefined ? '' : String(variant.dimensions_mm.h),
  });
  const [hsCode, setHsCode] = useState(variant.hs_code ?? '');
  const [origin, setOrigin] = useState(variant.origin_country ?? '');
  const [prices, setPrices] = useState(
    variant.prices.map((price) => ({
      currency: price.currency,
      amount_minor: price.amount_minor as number | null,
      compare_at_minor: price.compare_at_minor,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);

  // Checked as the person types; the server action checks the same with the shared schema.
  const weightValue = parseWhole(weight);
  const dimValues = { l: parseWhole(dims.l), w: parseWhole(dims.w), h: parseWhole(dims.h) };
  const hs = normalizeHsCode(hsCode);
  const country = normalizeCountry(origin);
  const problems: Record<string, string> = {};
  if (!sku.trim()) problems['sku'] = 'Enter a SKU.';
  if (!title.trim()) problems['title'] = 'Enter a title.';
  if (weightValue === 'invalid') problems['weight'] = 'Whole grams, 0 or more.';
  for (const side of ['l', 'w', 'h'] as const) {
    if (dimValues[side] === 'invalid') problems[`dim-${side}`] = 'Whole millimetres, 0 or more.';
  }
  const setSides = (['l', 'w', 'h'] as const).filter((side) => dimValues[side] !== null).length;
  if (setSides > 0 && setSides < 3) problems['dims'] = 'Give all three sides, or none.';
  if (hs !== '' && !HS_CODE.test(hs)) problems['hs'] = 'An HS code is 6, 8 or 10 digits.';
  if (country !== '' && !COUNTRY.test(country)) {
    problems['origin'] = 'Use the two-letter ISO country code, e.g. JP.';
  }
  const warnings = compareAtWarnings(prices);

  const save = () => {
    if (isPending || Object.keys(problems).length > 0) return;
    setError(null);
    setRefusal(undefined);
    startTransition(async () => {
      const allDims = dimValues.l !== null && dimValues.w !== null && dimValues.h !== null;
      const result = await updateVariantAction(storeId, variant.id, {
        sku: sku.trim(),
        title: title.trim(),
        options: variant.options,
        barcode: barcode.trim() === '' ? null : barcode.trim(),
        manage_inventory: manageInventory,
        allow_backorder: allowBackorder,
        weight_g: weightValue === 'invalid' ? null : weightValue,
        dimensions_mm: allDims
          ? { l: dimValues.l as number, w: dimValues.w as number, h: dimValues.h as number }
          : null,
        hs_code: hs === '' ? null : hs,
        origin_country: country === '' ? null : country,
        // The compare-at price travels with its price: editing one no longer drops the other.
        prices: prices
          .filter(
            (
              price,
            ): price is {
              currency: string;
              amount_minor: number;
              compare_at_minor: number | null;
            } => price.amount_minor !== null,
          )
          .map((price) => ({
            currency: price.currency,
            amount_minor: price.amount_minor,
            compare_at_minor: price.compare_at_minor,
          })),
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

  const id = (name: string) => `${name}-${variant.id}`;
  return (
    <tr>
      <td colSpan={6} className="bg-canvas px-3 py-3">
        <form
          aria-label={`Edit variant ${variant.sku}`}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          className="space-y-4"
        >
          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="text-sm font-semibold">Identity</legend>
            <Field id={id('title')} label="Title" error={problems['title']}>
              <input
                id={id('title')}
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                className={input}
              />
            </Field>
            <Field id={id('sku')} label="SKU" error={problems['sku']}>
              <input
                id={id('sku')}
                value={sku}
                onChange={(e) => setSku(e.currentTarget.value)}
                className={`${input} font-mono`}
              />
            </Field>
            <Field id={id('barcode')} label="Barcode (EAN / UPC / GTIN)">
              <input
                id={id('barcode')}
                value={barcode}
                onChange={(e) => setBarcode(e.currentTarget.value)}
                className={`${input} font-mono`}
              />
            </Field>
          </fieldset>

          <fieldset className="flex flex-wrap gap-6 text-sm">
            <legend className="text-sm font-semibold">Inventory</legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={manageInventory}
                onChange={(e) => setManageInventory(e.currentTarget.checked)}
              />
              Track stock for this variant
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allowBackorder}
                onChange={(e) => setAllowBackorder(e.currentTarget.checked)}
              />
              Sell when out of stock (backorder)
            </label>
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-6">
            <legend className="text-sm font-semibold">Shipping &amp; customs</legend>
            <Field id={id('weight')} label="Weight (g)" error={problems['weight']}>
              <input
                id={id('weight')}
                inputMode="numeric"
                value={weight}
                onChange={(e) => setWeight(e.currentTarget.value)}
                className={input}
              />
            </Field>
            {(['l', 'w', 'h'] as const).map((side) => (
              <Field
                key={side}
                id={id(`dim-${side}`)}
                label={`${side === 'l' ? 'Length' : side === 'w' ? 'Width' : 'Height'} (mm)`}
                error={problems[`dim-${side}`]}
              >
                <input
                  id={id(`dim-${side}`)}
                  inputMode="numeric"
                  value={dims[side]}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setDims((current) => ({ ...current, [side]: value }));
                  }}
                  className={input}
                />
              </Field>
            ))}
            <Field
              id={id('hs')}
              label="HS code"
              hint="6, 8 or 10 digits; dots and spaces are ignored."
              error={problems['hs']}
            >
              <input
                id={id('hs')}
                value={hsCode}
                onChange={(e) => setHsCode(e.currentTarget.value)}
                className={`${input} font-mono`}
              />
            </Field>
            <Field
              id={id('origin')}
              label="Country of origin"
              hint="ISO code, e.g. JP."
              error={problems['origin']}
            >
              <input
                id={id('origin')}
                maxLength={2}
                value={origin}
                onChange={(e) => setOrigin(e.currentTarget.value)}
                className={`${input} w-20 uppercase`}
              />
            </Field>
            {problems['dims'] !== undefined && (
              <p role="alert" className="text-danger text-xs sm:col-span-6">
                {problems['dims']}
              </p>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Prices</legend>
            {prices.length === 0 && <p className="text-muted text-sm">No price list entry yet.</p>}
            {prices.map((price, index) => (
              <div key={price.currency} className="flex flex-wrap items-end gap-3">
                <MoneyField
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
                <MoneyField
                  label={`Compare-at (${price.currency})`}
                  currency={price.currency}
                  valueMinor={price.compare_at_minor}
                  onChangeMinor={(amountMinor) =>
                    setPrices((current) =>
                      current.map((entry, position) =>
                        position === index ? { ...entry, compare_at_minor: amountMinor } : entry,
                      ),
                    )
                  }
                />
              </div>
            ))}
            {warnings.length > 0 && (
              <p role="note" className="text-warning text-xs">
                The compare-at price in {warnings.join(', ')} is not above the price, so the store
                shows no saving. Saving is still allowed.
              </p>
            )}
          </fieldset>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={isPending || Object.keys(problems).length > 0}
            >
              {isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" type="button" variant="secondary" onClick={onDone}>
              Cancel
            </Button>
          </div>
          {(error !== null || refusal !== undefined) && (
            <ActionRefusal refusal={refusal} message={error} />
          )}
        </form>
      </td>
    </tr>
  );
}
