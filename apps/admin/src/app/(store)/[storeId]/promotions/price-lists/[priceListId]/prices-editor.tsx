'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/form/fields';
import { MoneyField } from '@/components/form/money-field';
import { ActionRefusal } from '@/components/states/action-refusal';
import { upsertPricesAction } from '@/app/actions/pricing';
import type { ActionRefusalInfo, ActionResult } from '@/lib/forms/action-result';
import { formatMoney } from '@/lib/forms/money';
import { acceptedPrices, csvSummary, parsePriceCsv, type CsvRow } from '@/lib/pricing/csv';
import {
  changedPrices,
  csvResolution,
  type EditedPrice,
  type EditorRow,
} from '@/lib/pricing/editor';
import type { PriceListRow } from '@/lib/promotions/projection';

/**
 * Per-variant prices for one list, two ways in: edit the rows and save the changed ones, or paste
 * a CSV, preview it row by row, and import only the rows the preview accepted. Both go through
 * `upsertPricesAction`, which re-validates the whole batch on the server — a row rejected here
 * cannot be smuggled past by editing the request.
 *
 * Props are projections and variant rows (SKUs, titles, money) — no personal data exists here.
 */
export function PricesEditor({
  storeId,
  list,
  locale,
  rows,
  query,
  total,
  pageSize,
  canEdit,
}: {
  storeId: string;
  list: PriceListRow;
  locale: string;
  rows: readonly EditorRow[];
  query: string;
  total: number;
  pageSize: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(query);
  const [edits, setEdits] = useState<Record<string, EditedPrice>>({});
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<CsvRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);
  const [done, setDone] = useState<string | null>(null);

  const resolution = useMemo(() => csvResolution(rows, list.currency), [rows, list.currency]);
  const money = (amountMinor: number) => formatMoney(amountMinor, list.currency, locale);
  const editOf = (row: EditorRow): EditedPrice =>
    edits[row.variantId] ??
    (row.current === null
      ? { amount_minor: null, compare_at_minor: null, min_quantity: 1 }
      : { ...row.current });
  const changed = changedPrices(rows, edits);

  const run = (work: () => Promise<ActionResult<{ upserted: number }>>, after: () => void) => {
    setError(null);
    setRefusal(undefined);
    setDone(null);
    startTransition(async () => {
      const result = await work();
      if (result.status === 'success') {
        after();
        setDone(`Saved ${result.data.upserted} price${result.data.upserted === 1 ? '' : 's'}.`);
        router.refresh();
        return;
      }
      setRefusal(result.refusal);
      setError(result.refusal === undefined ? (result.formError ?? 'Could not save.') : null);
    });
  };

  return (
    <div className="space-y-6">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          router.push(
            search.trim() === '' ? pathname : `${pathname}?q=${encodeURIComponent(search.trim())}`,
          );
        }}
      >
        <div className="w-72">
          <TextField
            label="Find products"
            placeholder="Title or handle"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        <Button type="submit" variant="secondary" size="sm">
          Search
        </Button>
        <span className="text-muted text-sm">
          {rows.length} variant{rows.length === 1 ? '' : 's'} from the first{' '}
          {Math.min(total, pageSize)} of {total} product{total === 1 ? '' : 's'}
        </span>
      </form>

      <ActionRefusal refusal={refusal} message={error} />
      {done !== null && (
        <p role="status" className="text-success text-sm">
          {done}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-muted text-sm">
          No products match. Search for the products whose prices belong in this list.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={`Prices in ${list.name}`}>
            <thead className="border-line border-b">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Variant
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Current
                </th>
                {canEdit && (
                  <>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Amount
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Compare at
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Min qty
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {rows.map((row) => {
                const edit = editOf(row);
                return (
                  <tr key={row.variantId}>
                    <td className="px-3 py-2">
                      <div>{row.label}</div>
                      <div className="text-muted font-mono text-xs">{row.sku}</div>
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {row.current === null ? (
                        <span className="text-muted">not in this list</span>
                      ) : (
                        money(row.current.amount_minor)
                      )}
                    </td>
                    {canEdit && (
                      <>
                        <td className="px-3 py-2">
                          <MoneyField
                            label={`Amount for ${row.sku}`}
                            currency={list.currency}
                            valueMinor={edit.amount_minor}
                            onChangeMinor={(amountMinor) =>
                              setEdits((current) => ({
                                ...current,
                                [row.variantId]: { ...edit, amount_minor: amountMinor },
                              }))
                            }
                          />
                        </td>
                        <td className="px-3 py-2">
                          <MoneyField
                            label={`Compare-at for ${row.sku}`}
                            currency={list.currency}
                            valueMinor={edit.compare_at_minor}
                            onChangeMinor={(amountMinor) =>
                              setEdits((current) => ({
                                ...current,
                                [row.variantId]: { ...edit, compare_at_minor: amountMinor },
                              }))
                            }
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            aria-label={`Minimum quantity for ${row.sku}`}
                            type="number"
                            min={1}
                            value={edit.min_quantity}
                            onChange={(event) => {
                              const typed = Math.max(1, Number(event.currentTarget.value) || 1);
                              setEdits((current) => ({
                                ...current,
                                [row.variantId]: { ...edit, min_quantity: typed },
                              }));
                            }}
                            className="border-line bg-surface h-9 w-20 rounded-md border px-2 font-mono text-xs"
                          />
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && rows.length > 0 && (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={isPending || changed.length === 0}
            onClick={() =>
              run(
                () => upsertPricesAction(storeId, list.id, changed),
                () => setEdits({}),
              )
            }
          >
            {changed.length === 0
              ? 'No changes'
              : `Save ${changed.length} changed price${changed.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}

      {canEdit && (
        <section className="border-line space-y-3 border-t pt-4">
          <h2 className="text-base font-semibold">Import CSV</h2>
          <p className="text-muted text-sm">
            Columns: <code className="text-xs">sku</code> (or{' '}
            <code className="text-xs">variant_id</code>), <code className="text-xs">amount</code>,
            optional <code className="text-xs">compare_at</code> and{' '}
            <code className="text-xs">min_quantity</code>. Amounts in {list.currency} with the
            currency&apos;s decimals; SKUs must be among the variants shown above. Nothing is sent
            until the preview is confirmed.
          </p>
          <label className="block">
            <span className="sr-only">CSV</span>
            <textarea
              aria-label="CSV"
              value={csvText}
              onChange={(event) => {
                setCsvText(event.currentTarget.value);
                setPreview(null);
              }}
              rows={6}
              placeholder={'sku,amount,compare_at,min_quantity\nTEE-M-RED,19.99,24.99,1'}
              className="border-line bg-surface w-full rounded-md border px-3 py-2 font-mono text-xs"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={csvText.trim() === ''}
              onClick={() => setPreview(parsePriceCsv(csvText, resolution))}
            >
              Preview
            </Button>
            {preview !== null && (
              <span className="text-sm">
                {csvSummary(preview).ok} accepted · {csvSummary(preview).errors} rejected
              </span>
            )}
          </div>

          {preview !== null && (
            <>
              <table className="w-full text-sm" aria-label="CSV preview">
                <thead className="border-line border-b">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Line
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Verdict
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Row
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {preview.map((row) => (
                    <tr key={row.line}>
                      <td className="px-3 py-2 font-mono text-xs">{row.line}</td>
                      <td className="px-3 py-2">
                        {row.verdict === 'ok' ? (
                          <Badge tone="success">ok</Badge>
                        ) : (
                          <Badge tone="danger">rejected</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.verdict === 'ok' ? (
                          <span>
                            {row.label} → {money(row.price.amount_minor)}
                            {row.price.compare_at_minor === null
                              ? ''
                              : ` (was ${money(row.price.compare_at_minor)})`}
                            {row.price.min_quantity > 1 ? ` · min ${row.price.min_quantity}` : ''}
                          </span>
                        ) : (
                          <span>
                            <span className="text-danger">{row.message}</span>{' '}
                            <code className="text-muted text-xs">{row.raw}</code>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button
                size="sm"
                disabled={isPending || acceptedPrices(preview).length === 0}
                onClick={() =>
                  run(
                    () => upsertPricesAction(storeId, list.id, acceptedPrices(preview)),
                    () => {
                      setPreview(null);
                      setCsvText('');
                    },
                  )
                }
              >
                Import {acceptedPrices(preview).length} accepted row
                {acceptedPrices(preview).length === 1 ? '' : 's'}
              </Button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
