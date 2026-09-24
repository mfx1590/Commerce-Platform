'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import { cancelLineItemAction, lowerLineItemAction } from '@/app/actions/orders';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { formatMoney } from '@/lib/forms/money';
import { canLowerTo, editable, isLastLine } from '@/lib/orders/quantities';

type Order = AdminComponents['Order'];

/**
 * The lines, with the contract's two pre-fulfilment edits when the principal may make them:
 * lower a quantity (strictly lower, at least one) and cancel a line (never the last one — the
 * contract says cancel the order, so the button is not offered rather than refused). Each asks
 * first; the server re-checks `store_admin` and a refusal renders as the panel.
 */
export function LineItemsPanel({
  storeId,
  order,
  locale,
  canEdit,
}: {
  storeId: string;
  order: Order;
  locale: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ lineId: string; mode: 'lower' | 'cancel' } | null>(null);
  const [quantity, setQuantity] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);
  const money = (amountMinor: number, currency: string) =>
    formatMoney(amountMinor, currency, locale);

  const run = (
    work: () => Promise<{ status: string; formError?: string | null; refusal?: ActionRefusalInfo }>,
  ) => {
    setError(null);
    setRefusal(undefined);
    startTransition(async () => {
      const result = await work();
      setEditing(null);
      if (result.status === 'success') {
        router.refresh();
        return;
      }
      setRefusal(result.refusal);
      setError(
        result.refusal === undefined ? (result.formError ?? 'Could not change this line.') : null,
      );
    });
  };

  const lastLine = isLastLine(order);

  return (
    <div className="space-y-3">
      <ActionRefusal refusal={refusal} message={error} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-label="Order lines">
          <thead className="border-line border-b">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Item
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Unit
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Discount
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Tax
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Total
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Shipped / returned
              </th>
              {canEdit && (
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Edit</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {order.items.map((line) => {
              const isEditing = editing?.lineId === line.id;
              return (
                <tr key={line.id}>
                  <td className="px-3 py-2">
                    <div>{line.title}</div>
                    <div className="text-muted text-xs">
                      {line.variant_title} · <span className="font-mono">{line.sku}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{line.quantity}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {money(line.unit_price.amount_minor, line.unit_price.currency)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {money(line.discount.amount_minor, line.discount.currency)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {money(line.tax.amount_minor, line.tax.currency)}
                    <span className="text-muted text-xs"> ({line.tax_rate_bp / 100}%)</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {money(line.total.amount_minor, line.total.currency)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {line.fulfilled_quantity} / {line.returned_quantity}
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2 text-right">
                      {!editable(line) ? (
                        <span className="text-muted text-xs">shipped</span>
                      ) : isEditing && editing.mode === 'lower' ? (
                        <span className="inline-flex items-center gap-2">
                          <label className="sr-only" htmlFor={`qty-${line.id}`}>
                            New quantity
                          </label>
                          <input
                            id={`qty-${line.id}`}
                            type="number"
                            min={1}
                            max={line.quantity - 1}
                            value={quantity}
                            onChange={(event) => setQuantity(Number(event.currentTarget.value))}
                            className="border-line bg-surface h-8 w-16 rounded-md border px-2 font-mono text-xs"
                          />
                          <Button
                            size="sm"
                            disabled={isPending || !canLowerTo(line, quantity)}
                            onClick={() =>
                              run(() =>
                                lowerLineItemAction(storeId, order.id, line.id, { quantity }),
                              )
                            }
                          >
                            Lower to {quantity}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </span>
                      ) : isEditing && editing.mode === 'cancel' ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-xs">Cancel this line?</span>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={isPending}
                            onClick={() =>
                              run(() => cancelLineItemAction(storeId, order.id, line.id))
                            }
                          >
                            Yes, cancel line
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                            Keep
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={isPending || line.quantity <= 1}
                            onClick={() => {
                              setQuantity(line.quantity - 1);
                              setEditing({ lineId: line.id, mode: 'lower' });
                            }}
                          >
                            Lower
                          </Button>
                          {!lastLine && (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={isPending}
                              onClick={() => setEditing({ lineId: line.id, mode: 'cancel' })}
                            >
                              Cancel line
                            </Button>
                          )}
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canEdit && lastLine && (
        <p className="text-muted text-xs">
          One line left: it cannot be cancelled on its own — cancel the order instead.
        </p>
      )}
    </div>
  );
}
