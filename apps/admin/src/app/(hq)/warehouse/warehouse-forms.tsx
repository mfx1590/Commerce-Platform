'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { SelectField, TextField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import {
  mapVariantAction,
  reconcileCycleCountAction,
  recordCycleCountAction,
} from '@/app/actions/warehouse';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { formatDelta } from '@/lib/warehouse';

interface Failure {
  message: string | null;
  refusal?: ActionRefusalInfo | undefined;
  fieldErrors?: Readonly<Record<string, string>>;
}

export interface Option {
  value: string;
  label: string;
}

/** A variant another item maps, offered for pooling: its id, sku and brand. */
export interface VariantChoice {
  variantId: string;
  sku: string;
  storeLabel: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------- pool a variant

/**
 * "Pool this variant onto this item". Asks first, naming both brands: it changes which shelf the
 * variant's brand sells from. The 409 (the old item still holds stock) is said in words.
 */
export function PoolVariantForm({
  stockItemId,
  itemSku,
  itemBrands,
  choices,
}: {
  stockItemId: string;
  itemSku: string;
  /** Brands that map this item today. */
  itemBrands: readonly string[];
  /** Variants of other items on this page. */
  choices: readonly VariantChoice[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [variantId, setVariantId] = useState(choices[0]?.variantId ?? '');
  const [typed, setTyped] = useState('');
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const chosen = typed.trim() !== '' ? typed.trim() : variantId;
  const choice = choices.find((c) => c.variantId === chosen);
  const variantLabel =
    choice !== undefined ? `${choice.sku} of ${choice.storeLabel}` : `variant ${chosen}`;
  const brands = itemBrands.length === 0 ? 'no brand yet' : itemBrands.join(' and ');

  if (!open) {
    return (
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Pool a variant onto ${itemSku}`}
        onClick={() => setOpen(true)}
      >
        Pool a variant
      </Button>
    );
  }

  const ask = (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setDone(null);
    if (!UUID.test(chosen)) {
      setFailure({ message: null, fieldErrors: { variant_id: 'Enter a variant id (uuid).' } });
      return;
    }
    setAsking(true);
  };

  return (
    <form
      onSubmit={ask}
      aria-label={`Pool a variant onto ${itemSku}`}
      className="border-line space-y-2 rounded-md border px-3 py-2"
    >
      {choices.length > 0 && (
        <SelectField
          label="Variant"
          value={variantId}
          onChange={(event) => setVariantId(event.currentTarget.value)}
          options={choices.map((c) => ({
            value: c.variantId,
            label: `${c.sku} — ${c.storeLabel}`,
          }))}
        />
      )}
      <TextField
        label={choices.length > 0 ? 'Or a variant id' : 'Variant id'}
        value={typed}
        onChange={(event) => setTyped(event.currentTarget.value)}
        placeholder="uuid"
        error={failure?.fieldErrors?.['variant_id']}
      />
      {!asking ? (
        <div className="flex gap-2">
          <Button size="sm" type="submit">
            Pool…
          </Button>
          <Button size="sm" variant="secondary" type="button" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      ) : (
        <div
          role="alertdialog"
          aria-label={`Confirm pooling onto ${itemSku}`}
          className="border-warning/30 bg-warning/5 space-y-2 rounded-md border px-3 py-2"
        >
          <p className="text-sm">
            Pool <span className="font-medium">{variantLabel}</span> onto{' '}
            <span className="font-medium">{itemSku}</span> (mapped by {brands})? From now on{' '}
            {choice?.storeLabel ?? 'that variant’s brand'} sells from this item’s shelf, shared with{' '}
            {brands}.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await mapVariantAction(stockItemId, chosen);
                  setAsking(false);
                  if (result.status === 'success') {
                    setDone(`${variantLabel} now sells from ${itemSku}.`);
                    router.refresh();
                    return;
                  }
                  setFailure({
                    message: result.formError,
                    refusal: result.refusal,
                    fieldErrors: result.fieldErrors,
                  });
                })
              }
            >
              {pending ? 'Pooling…' : 'Yes, pool it'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              disabled={pending}
              onClick={() => setAsking(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {done !== null && (
        <p role="status" className="text-success text-sm">
          {done}
        </p>
      )}
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
    </form>
  );
}

// ---------------------------------------------------------------------------- record a count

export function RecordCountForm({
  warehouses,
  stockItems,
}: {
  warehouses: readonly Option[];
  stockItems: readonly Option[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const [stockItemId, setStockItemId] = useState(stockItems[0]?.value ?? '');
  const [quantity, setQuantity] = useState('');
  const [countedAt, setCountedAt] = useState('');
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setDone(null);
    if (quantity.trim() === '' || !/^\d+$/.test(quantity.trim())) {
      setFailure({
        message: null,
        fieldErrors: { counted_quantity: 'Enter the number counted (a whole number, 0 or more).' },
      });
      return;
    }
    startTransition(async () => {
      const result = await recordCycleCountAction({
        warehouse_id: warehouseId,
        stock_item_id: stockItemId,
        counted_quantity: quantity.trim(),
        counted_at: countedAt === '' ? undefined : new Date(countedAt).toISOString(),
        note,
      });
      if (result.status === 'success') {
        setDone(
          `Count recorded (${result.data.sku}: ${result.data.counted_quantity}). No stock changed yet — reconcile it below.`,
        );
        setQuantity('');
        setNote('');
        router.refresh();
        return;
      }
      setFailure({
        message: result.formError,
        refusal: result.refusal,
        fieldErrors: result.fieldErrors,
      });
    });
  };

  return (
    <form onSubmit={submit} aria-label="Record a count" className="grid gap-3 sm:grid-cols-2">
      <SelectField
        label="Warehouse"
        value={warehouseId}
        onChange={(event) => setWarehouseId(event.currentTarget.value)}
        options={warehouses}
        error={failure?.fieldErrors?.['warehouse_id']}
      />
      <SelectField
        label="Stock item"
        value={stockItemId}
        onChange={(event) => setStockItemId(event.currentTarget.value)}
        options={stockItems}
        error={failure?.fieldErrors?.['stock_item_id']}
      />
      <TextField
        label="Counted quantity"
        inputMode="numeric"
        value={quantity}
        onChange={(event) => setQuantity(event.currentTarget.value)}
        error={failure?.fieldErrors?.['counted_quantity']}
      />
      <TextField
        label="Counted at"
        hint="Leave empty for now. Never in the future."
        type="datetime-local"
        value={countedAt}
        onChange={(event) => setCountedAt(event.currentTarget.value)}
        error={failure?.fieldErrors?.['counted_at']}
      />
      <TextField
        label="Note"
        value={note}
        onChange={(event) => setNote(event.currentTarget.value)}
        error={failure?.fieldErrors?.['note']}
      />
      <div className="flex items-end">
        <Button
          type="submit"
          disabled={pending || warehouses.length === 0 || stockItems.length === 0}
        >
          {pending ? 'Recording…' : 'Record count'}
        </Button>
      </div>
      <div className="sm:col-span-2">
        {done !== null && (
          <p role="status" className="text-success text-sm">
            {done}
          </p>
        )}
        <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------- reconcile / approve

function outcome(status: string, delta: number | null): string {
  if (status === 'applied') {
    return delta === 0 || delta === null
      ? 'Applied — the shelf matched; no stock moved.'
      : `Applied — one movement of ${formatDelta(delta)}.`;
  }
  if (status === 'flagged') {
    return `Flagged — the discrepancy (${formatDelta(delta)}) is above the tolerance and needs approval.`;
  }
  return status;
}

export function ReconcileButton({ cycleCountId, sku }: { cycleCountId: string; sku: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        aria-label={`Reconcile the count of ${sku}`}
        onClick={() =>
          startTransition(async () => {
            setFailure(null);
            const result = await reconcileCycleCountAction(cycleCountId, false);
            if (result.status === 'success') {
              setDone(outcome(result.data.status, result.data.delta));
              router.refresh();
              return;
            }
            setFailure({ message: result.formError, refusal: result.refusal });
          })
        }
      >
        {pending ? 'Reconciling…' : 'Reconcile'}
      </Button>
      {done !== null && (
        <p role="status" className="text-sm">
          {done}
        </p>
      )}
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
    </div>
  );
}

/**
 * Approve a flagged count. The delta is recomputed at approval under the pool row's lock, so the
 * flag's number is shown with that warning, and the applied delta is said afterwards.
 */
export function ApproveButton({
  cycleCountId,
  sku,
  flaggedDelta,
  onHandNow,
}: {
  cycleCountId: string;
  sku: string;
  flaggedDelta: number | null;
  /** The pool row's on-hand now, when the page could read it. */
  onHandNow: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      {!asking ? (
        <Button
          size="sm"
          aria-label={`Approve the count of ${sku}`}
          onClick={() => setAsking(true)}
        >
          Approve…
        </Button>
      ) : (
        <div
          role="alertdialog"
          aria-label={`Confirm approving the count of ${sku}`}
          className="border-warning/30 bg-warning/5 space-y-2 rounded-md border px-3 py-2"
        >
          <p className="text-sm">
            Delta when flagged: <span className="font-medium">{formatDelta(flaggedDelta)}</span> —
            recomputed on approval; may differ.
            {onHandNow !== null && <> On hand now: {onHandNow}.</>}
          </p>
          <p className="text-sm">Approve and apply the delta as it is at approval?</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setFailure(null);
                  const result = await reconcileCycleCountAction(cycleCountId, true);
                  setAsking(false);
                  if (result.status === 'success') {
                    setDone(
                      `Approved — applied ${formatDelta(result.data.delta)}` +
                        (result.data.delta !== flaggedDelta ? ' (changed since the flag).' : '.'),
                    );
                    router.refresh();
                    return;
                  }
                  setFailure({ message: result.formError, refusal: result.refusal });
                })
              }
            >
              {pending ? 'Approving…' : 'Yes, approve'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => setAsking(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {done !== null && (
        <p role="status" className="text-sm">
          {done}
        </p>
      )}
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
    </div>
  );
}
