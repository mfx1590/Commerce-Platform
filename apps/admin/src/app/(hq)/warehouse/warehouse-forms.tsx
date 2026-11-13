'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { SelectField, TextField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import {
  mapVariantAction,
  moveStockAction,
  previewCycleCountAction,
  reconcileCycleCountAction,
  recordCycleCountAction,
} from '@/app/actions/warehouse';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import {
  afterMove,
  EMPTY_POOL,
  formatDelta,
  MOVEMENT_KINDS,
  moveRefusal,
  type MovementKind,
  type PoolNumbers,
} from '@/lib/warehouse';

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

// ---------------------------------------------------------------------------- move stock

/** The item's pool row in one warehouse, as the page read it. */
export interface PoolRow extends PoolNumbers {
  warehouse_id: string;
}

const KIND_LABELS: Record<MovementKind, string> = {
  adjust: 'Adjust (correct up or down)',
  receive: 'Receive',
  transfer: 'Transfer to another warehouse',
};

function Numbers({ label, numbers }: { label: string; numbers: PoolNumbers }) {
  return (
    <span>
      <span className="text-muted">{label}:</span> on hand {numbers.on_hand} · reserved{' '}
      {numbers.reserved} · available {numbers.available}
    </span>
  );
}

/**
 * Adjust, receive or transfer one item's stock (#870 wave 1 item 1). Shows the shelf's numbers now
 * and after the move, and refuses a result below zero or below what open orders reserved before
 * the request — the server action checks the same again on a fresh read. A transfer is two
 * movements; the action says what happened if the second one fails. On success the item's ledger
 * opens on the warehouse that received the move.
 */
export function StockMovementForm({
  stockItemId,
  sku,
  levels,
  warehouses,
  listQuery,
}: {
  stockItemId: string;
  sku: string;
  levels: readonly PoolRow[];
  /** Active warehouses. */
  warehouses: readonly Option[];
  /** The list's own query (filters, page), kept when the ledger opens. */
  listQuery: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<MovementKind>('adjust');
  const first = warehouses[0]?.value ?? '';
  const [warehouseId, setWarehouseId] = useState(levels[0]?.warehouse_id ?? first);
  const [toWarehouseId, setToWarehouseId] = useState(
    warehouses.find((w) => w.value !== (levels[0]?.warehouse_id ?? first))?.value ?? '',
  );
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!open) {
    return (
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Move stock of ${sku}`}
        onClick={() => setOpen(true)}
        disabled={warehouses.length === 0}
      >
        Move stock
      </Button>
    );
  }

  const pool = (id: string): PoolNumbers => {
    const row = levels.find((level) => level.warehouse_id === id);
    return row === undefined ? EMPTY_POOL : row;
  };
  const trimmed = amount.trim();
  const valid = kind === 'adjust' ? /^[+-]?\d+$/.test(trimmed) : /^\d+$/.test(trimmed);
  const parsed = valid ? Number.parseInt(trimmed, 10) : NaN;
  const delta = Number.isNaN(parsed) ? null : kind === 'transfer' ? -parsed : parsed;
  const source = pool(warehouseId);
  const sameWarehouse = kind === 'transfer' && toWarehouseId === warehouseId;
  const refusal =
    delta === null || delta === 0
      ? null
      : moveRefusal(source, delta, kind === 'transfer' ? 'the source warehouse' : 'this warehouse');
  const name = (id: string) => warehouses.find((w) => w.value === id)?.label ?? id;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setDone(null);
    if (delta === null || delta === 0 || (kind !== 'adjust' && parsed < 1)) {
      setFailure({
        message: null,
        fieldErrors: {
          [kind === 'adjust' ? 'delta' : 'quantity']:
            kind === 'adjust'
              ? 'Enter the change as a whole number, e.g. -3 or 5 (not 0).'
              : 'Enter a whole number of 1 or more.',
        },
      });
      return;
    }
    if (refusal !== null || sameWarehouse) return;
    startTransition(async () => {
      const common = { stock_item_id: stockItemId, sku, note };
      const result = await moveStockAction(
        kind === 'adjust'
          ? { kind, ...common, warehouse_id: warehouseId, delta: trimmed }
          : kind === 'receive'
            ? { kind, ...common, warehouse_id: warehouseId, quantity: trimmed }
            : {
                kind,
                ...common,
                from_warehouse_id: warehouseId,
                to_warehouse_id: toWarehouseId,
                quantity: trimmed,
              },
      );
      if (result.status === 'success') {
        const { after, message, warehouseId: ledgerWarehouse } = result.data;
        setDone(
          `${message} ${name(ledgerWarehouse)} now: on hand ${after.on_hand}, reserved ${after.reserved}, available ${after.available}.`,
        );
        setAmount('');
        setNote('');
        const query = new URLSearchParams(listQuery);
        query.set('item', stockItemId);
        query.set('view', 'movements');
        query.set('warehouse_id', ledgerWarehouse);
        query.delete('dpage');
        router.push(`/warehouse?${query.toString()}`);
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
    <form
      onSubmit={submit}
      aria-label={`Move stock of ${sku}`}
      className="border-line space-y-3 rounded-md border px-3 py-2"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Movement"
          value={kind}
          onChange={(event) => {
            setKind(event.currentTarget.value as MovementKind);
            setFailure(null);
          }}
          options={MOVEMENT_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
        />
        <SelectField
          label={kind === 'transfer' ? 'From warehouse' : 'Warehouse'}
          value={warehouseId}
          onChange={(event) => setWarehouseId(event.currentTarget.value)}
          options={warehouses}
          error={
            failure?.fieldErrors?.['warehouse_id'] ?? failure?.fieldErrors?.['from_warehouse_id']
          }
        />
        {kind === 'transfer' && (
          <SelectField
            label="To warehouse"
            value={toWarehouseId}
            onChange={(event) => setToWarehouseId(event.currentTarget.value)}
            options={warehouses}
            error={
              sameWarehouse
                ? 'Choose a different warehouse to move to.'
                : failure?.fieldErrors?.['to_warehouse_id']
            }
          />
        )}
        <TextField
          label={kind === 'adjust' ? 'Change (e.g. -3 or 5)' : 'Quantity'}
          inputMode="numeric"
          value={amount}
          onChange={(event) => setAmount(event.currentTarget.value)}
          error={failure?.fieldErrors?.[kind === 'adjust' ? 'delta' : 'quantity']}
        />
        <TextField
          label="Note"
          hint="Why — kept on the ledger row."
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
          error={failure?.fieldErrors?.['note']}
        />
      </div>
      <div className="space-y-1 text-sm" aria-live="polite" aria-label="Stock before and after">
        <p>
          <Numbers
            label={kind === 'transfer' ? `${name(warehouseId)} now` : 'Now'}
            numbers={source}
          />
        </p>
        {delta !== null && delta !== 0 && (
          <p>
            <Numbers
              label={kind === 'transfer' ? `${name(warehouseId)} after` : 'After'}
              numbers={afterMove(source, delta)}
            />
          </p>
        )}
        {kind === 'transfer' && !sameWarehouse && toWarehouseId !== '' && (
          <>
            <p>
              <Numbers label={`${name(toWarehouseId)} now`} numbers={pool(toWarehouseId)} />
            </p>
            {delta !== null && delta !== 0 && (
              <p>
                <Numbers
                  label={`${name(toWarehouseId)} after`}
                  numbers={afterMove(pool(toWarehouseId), -delta)}
                />
              </p>
            )}
            <p className="text-muted text-xs">
              Two movements: out of the source first, then into the destination. If the second is
              refused, the units are put back and you are told.
            </p>
          </>
        )}
        {refusal !== null && (
          <p role="alert" className="text-danger">
            {refusal}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={pending || refusal !== null || sameWarehouse || warehouseId === ''}
        >
          {pending
            ? 'Moving…'
            : kind === 'receive'
              ? 'Receive'
              : kind === 'transfer'
                ? 'Transfer'
                : 'Adjust'}
        </Button>
        <Button size="sm" variant="secondary" type="button" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
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
  defaultStockItemId = '',
}: {
  warehouses: readonly Option[];
  stockItems: readonly Option[];
  /** Preselected when it is among `stockItems` (an item row's "Record a count", #823). */
  defaultStockItemId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const [stockItemId, setStockItemId] = useState(
    stockItems.some((option) => option.value === defaultStockItemId)
      ? defaultStockItemId
      : (stockItems[0]?.value ?? ''),
  );
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

type Preview =
  | { state: 'loading' }
  | { state: 'ready'; delta: number; wouldStatus: string; tolerance: number; computedAt: string }
  | { state: 'superseded'; message: string | null }
  | { state: 'unavailable'; message: string | null };

/**
 * Approve a flagged count. Opening the dialog asks `previewCycleCountReconcile` what approving
 * would apply now; the preview holds no lock, so the approval recomputes and may still differ, and
 * the applied delta is said afterwards. A superseded count is said and Approve is not offered; any
 * other preview failure falls back to the flag's delta with the same warning.
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
  const [previewing, startPreview] = useTransition();
  const [approving, startApproval] = useTransition();
  const [asking, setAsking] = useState(false);
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const open = () => {
    setAsking(true);
    setFailure(null);
    setPreview({ state: 'loading' });
    startPreview(async () => {
      const result = await previewCycleCountAction(cycleCountId);
      if (result.status === 'success') {
        setPreview({
          state: 'ready',
          delta: result.data.delta,
          wouldStatus: result.data.would_status,
          tolerance: result.data.count_tolerance,
          computedAt: result.data.computed_at,
        });
        return;
      }
      if (result.refusal !== undefined) {
        setAsking(false);
        setFailure({ message: result.formError, refusal: result.refusal });
        return;
      }
      setPreview(
        'superseded' in result && result.superseded === true
          ? { state: 'superseded', message: result.formError }
          : { state: 'unavailable', message: result.formError },
      );
    });
  };
  const expected = preview.state === 'ready' ? preview.delta : flaggedDelta;

  return (
    <div className="space-y-1">
      {!asking ? (
        <Button size="sm" aria-label={`Approve the count of ${sku}`} onClick={open}>
          Approve…
        </Button>
      ) : (
        <div
          role="alertdialog"
          aria-label={`Confirm approving the count of ${sku}`}
          className="border-warning/30 bg-warning/5 space-y-2 rounded-md border px-3 py-2"
        >
          {preview.state === 'loading' && (
            <p className="text-muted text-sm" role="status">
              Recomputing the delta…
            </p>
          )}
          {preview.state === 'ready' && (
            <p className="text-sm">
              Delta now: <span className="font-medium">{formatDelta(preview.delta)}</span> (
              {preview.wouldStatus === 'flagged'
                ? `above the tolerance of ${preview.tolerance}`
                : `within the tolerance of ${preview.tolerance}`}
              ; when flagged: {formatDelta(flaggedDelta)}). Computed at{' '}
              {preview.computedAt.replace('T', ' ').slice(0, 16)}; recomputed again on approval —
              may differ (the preview holds no lock).
            </p>
          )}
          {preview.state === 'unavailable' && (
            <p className="text-sm">
              Delta when flagged: <span className="font-medium">{formatDelta(flaggedDelta)}</span> —
              recomputed on approval; may differ.
              {onHandNow !== null && <> On hand now: {onHandNow}.</>}
              {preview.message !== null && (
                <span className="text-muted"> (No preview: {preview.message})</span>
              )}
            </p>
          )}
          {preview.state === 'superseded' ? (
            <>
              <p className="text-sm" role="alert">
                {preview.message}
              </p>
              <Button size="sm" variant="secondary" onClick={() => setAsking(false)}>
                Close
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm">Approve and apply the delta as it is at approval?</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={previewing || approving}
                  onClick={() =>
                    startApproval(async () => {
                      setFailure(null);
                      const result = await reconcileCycleCountAction(cycleCountId, true);
                      setAsking(false);
                      if (result.status === 'success') {
                        setDone(
                          `Approved — applied ${formatDelta(result.data.delta)}` +
                            (result.data.delta !== expected
                              ? ' (changed since the preview).'
                              : '.'),
                        );
                        router.refresh();
                        return;
                      }
                      setFailure({ message: result.formError, refusal: result.refusal });
                    })
                  }
                >
                  {approving ? 'Approving…' : 'Yes, approve'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={approving}
                  onClick={() => setAsking(false)}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
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
