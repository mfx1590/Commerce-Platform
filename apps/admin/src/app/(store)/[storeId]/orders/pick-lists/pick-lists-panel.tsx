'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import { packShipmentAction, pickShipmentAction } from '@/app/actions/orders';
import type { AdminComponents, AdminResponse } from '@/lib/api/admin-client';
import type { ActionRefusalInfo, ActionResult } from '@/lib/forms/action-result';
import { statusLabel, toneFor } from '../orders-table.config';

type Group = AdminResponse<'listPickLists'>['items'][number];
type Warehouse = AdminComponents['Warehouse'];

const STATUSES = ['pending', 'picking', 'packed'] as const;

/** One block per warehouse; Pick / Pack straight from the row, each behind a confirmation. */
export function PickListsPanel({
  storeId,
  groups,
  warehouses,
  filters,
}: {
  storeId: string;
  groups: readonly Group[];
  warehouses: readonly Warehouse[];
  filters: { warehouse_id: string; status: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<{
    kind: 'pick' | 'pack';
    shipmentId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);

  const applyFilter = (key: 'warehouse_id' | 'status', value: string) => {
    const search = new URLSearchParams();
    const next = { ...filters, [key]: value };
    if (next.warehouse_id !== '') search.set('warehouse_id', next.warehouse_id);
    if (next.status !== '') search.set('status', next.status);
    const query = search.toString();
    startTransition(() => router.push(query === '' ? pathname : `${pathname}?${query}`));
  };

  const run = (work: () => Promise<ActionResult<unknown>>) => {
    setError(null);
    setRefusal(undefined);
    startTransition(async () => {
      const result = await work();
      setConfirming(null);
      if (result.status === 'success') {
        router.refresh();
        return;
      }
      setRefusal(result.refusal);
      setError(result.refusal === undefined ? (result.formError ?? 'Could not do that.') : null);
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid max-w-lg gap-3 sm:grid-cols-2">
        <SelectField
          label="Warehouse"
          value={filters.warehouse_id}
          onChange={(event) => applyFilter('warehouse_id', event.currentTarget.value)}
          options={[
            { value: '', label: 'All warehouses' },
            ...warehouses.map((warehouse) => ({ value: warehouse.id, label: warehouse.code })),
          ]}
        />
        <SelectField
          label="Status"
          value={filters.status}
          onChange={(event) => applyFilter('status', event.currentTarget.value)}
          options={[
            { value: '', label: 'Pending, picking and packed' },
            ...STATUSES.map((value) => ({ value, label: statusLabel(value) })),
          ]}
        />
      </div>

      <ActionRefusal refusal={refusal} message={error} />

      {groups.map((group) => (
        <section key={group.warehouse_id} className="space-y-2">
          <h3 className="text-sm font-semibold">
            {group.warehouse_code}{' '}
            <span className="text-muted font-normal">
              · {group.shipments.length} shipment{group.shipments.length === 1 ? '' : 's'}
            </span>
          </h3>
          <table className="w-full text-sm" aria-label={`Pick list ${group.warehouse_code}`}>
            <thead className="border-line border-b">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Order
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Units
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {group.shipments.map((shipment) => (
                <tr key={shipment.id}>
                  <td className="px-3 py-2">
                    <Link
                      href={`/${storeId}/orders/${shipment.order_id}`}
                      className="text-accent font-mono text-xs hover:underline"
                    >
                      {shipment.order_id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={toneFor(shipment.status)}>{statusLabel(shipment.status)}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {shipment.items.reduce((sum, item) => sum + item.quantity, 0)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {confirming?.shipmentId === shipment.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs">
                          {confirming.kind === 'pick' ? 'Start picking?' : 'Mark packed?'}
                        </span>
                        <Button
                          size="sm"
                          disabled={isPending}
                          onClick={() =>
                            run(() =>
                              confirming.kind === 'pick'
                                ? pickShipmentAction(storeId, shipment.order_id, shipment.id)
                                : packShipmentAction(storeId, shipment.order_id, shipment.id, {}),
                            )
                          }
                        >
                          Yes
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>
                          No
                        </Button>
                      </span>
                    ) : shipment.status === 'pending' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={isPending}
                        onClick={() => setConfirming({ kind: 'pick', shipmentId: shipment.id })}
                      >
                        Pick
                      </Button>
                    ) : shipment.status === 'picking' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={isPending}
                        onClick={() => setConfirming({ kind: 'pack', shipmentId: shipment.id })}
                      >
                        Pack
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
