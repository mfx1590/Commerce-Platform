'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SelectField, TextField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import {
  createShipmentAction,
  packShipmentAction,
  pickShipmentAction,
  receiveReturnAction,
  updateShipmentAction,
} from '@/app/actions/orders';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionRefusalInfo, ActionResult } from '@/lib/forms/action-result';
import { RETURN_CONDITIONS, SHIPMENT_UPDATE_STATUSES } from '@/lib/forms/schemas';
import type { OrderPermissions } from '@/lib/orders/permissions';
import { fulfillable, hasFulfillableLines } from '@/lib/orders/quantities';
import { statusLabel, toneFor } from '../orders-table.config';

type Order = AdminComponents['Order'];
type Warehouse = AdminComponents['Warehouse'];
type Condition = (typeof RETURN_CONDITIONS)[number];
type UpdateStatus = (typeof SHIPMENT_UPDATE_STATUSES)[number];

type Confirming =
  | { kind: 'fulfil' }
  | { kind: 'pick'; shipmentId: string }
  | { kind: 'pack'; shipmentId: string }
  | { kind: 'update'; shipmentId: string }
  | { kind: 'receive'; returnId: string }
  | null;

/**
 * Shipments and returns for one order, with the `operations` actions when the principal holds it:
 * plan a shipment (fulfil), pick, pack, advance status / attach tracking, receive a return. Each
 * asks first; the API re-checks `operations` on `organization:hq` and a refusal renders as the
 * panel. A principal without the relation sees the lists and no buttons.
 */
export function FulfilmentPanel({
  storeId,
  order,
  locale: _locale,
  permissions,
  warehouses,
}: {
  storeId: string;
  order: Order;
  locale: string;
  permissions: OrderPermissions;
  warehouses: readonly Warehouse[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);

  // fulfil form
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [carrier, setCarrier] = useState('manual');
  const [service, setService] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(order.items.map((line) => [line.id, fulfillable(line)])),
  );
  // pack / update forms
  const [parcelCount, setParcelCount] = useState(1);
  const [status, setStatus] = useState<UpdateStatus | ''>('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  // receive form
  const [receiveWarehouseId, setReceiveWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [conditions, setConditions] = useState<Record<string, Condition>>({});

  const run = <T,>(work: () => Promise<ActionResult<T>>) => {
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

  const canPlan = permissions.canFulfil && hasFulfillableLines(order) && warehouses.length > 0;
  const lineTitle = (lineId: string) => {
    const line = order.items.find((item) => item.id === lineId);
    return line === undefined ? lineId : `${line.title} · ${line.variant_title}`;
  };

  return (
    <div className="space-y-5">
      <ActionRefusal refusal={refusal} message={error} />

      <section className="space-y-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">Shipments</h3>
          {canPlan && confirming === null && (
            <Button
              size="sm"
              disabled={isPending}
              onClick={() => setConfirming({ kind: 'fulfil' })}
            >
              Fulfil
            </Button>
          )}
        </div>

        {confirming?.kind === 'fulfil' && (
          <form
            className="border-line space-y-3 rounded-md border p-3"
            aria-label="Plan shipment"
            onSubmit={(event) => {
              event.preventDefault();
              const items = Object.entries(quantities)
                .filter(([, quantity]) => quantity > 0)
                .map(([order_line_item_id, quantity]) => ({ order_line_item_id, quantity }));
              run(() =>
                createShipmentAction(storeId, order.id, {
                  warehouse_id: warehouseId,
                  carrier,
                  ...(service.trim() === '' ? {} : { service: service.trim() }),
                  items,
                }),
              );
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField
                label="Warehouse"
                required
                value={warehouseId}
                onChange={(event) => setWarehouseId(event.currentTarget.value)}
                options={warehouses.map((warehouse) => ({
                  value: warehouse.id,
                  label: `${warehouse.code} — ${warehouse.name}`,
                }))}
              />
              <TextField
                label="Carrier"
                value={carrier}
                onChange={(event) => setCarrier(event.currentTarget.value)}
              />
              <TextField
                label="Service"
                value={service}
                onChange={(event) => setService(event.currentTarget.value)}
              />
            </div>
            <ul className="space-y-2">
              {order.items
                .filter((line) => fulfillable(line) > 0)
                .map((line) => (
                  <li key={line.id} className="flex items-center gap-3 text-sm">
                    <label htmlFor={`ship-${line.id}`} className="flex-1">
                      {line.title} · {line.variant_title}{' '}
                      <span className="text-muted text-xs">(up to {fulfillable(line)})</span>
                    </label>
                    <input
                      id={`ship-${line.id}`}
                      type="number"
                      min={0}
                      max={fulfillable(line)}
                      value={quantities[line.id] ?? 0}
                      onChange={(event) => {
                        const typed = Number(event.currentTarget.value);
                        setQuantities((current) => ({
                          ...current,
                          [line.id]: Math.min(fulfillable(line), Math.max(0, typed)),
                        }));
                      }}
                      className="border-line bg-surface h-8 w-16 rounded-md border px-2 font-mono text-xs"
                    />
                  </li>
                ))}
            </ul>
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={
                  isPending ||
                  warehouseId === '' ||
                  !Object.values(quantities).some((quantity) => quantity > 0)
                }
              >
                Yes, plan the shipment
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setConfirming(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {order.shipments.length === 0 ? (
          <p className="text-muted text-sm">No shipments yet.</p>
        ) : (
          <ul className="divide-line divide-y">
            {order.shipments.map((shipment) => (
              <li key={shipment.id} className="space-y-2 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone={toneFor(shipment.status)}>{statusLabel(shipment.status)}</Badge>
                  <span>
                    {shipment.items.reduce((sum, item) => sum + item.quantity, 0)} unit(s) ·{' '}
                    {shipment.carrier}
                    {shipment.service !== null ? ` ${shipment.service}` : ''}
                  </span>
                  {shipment.tracking_number !== null && (
                    <span className="font-mono text-xs">
                      {shipment.tracking_url !== null ? (
                        <a href={shipment.tracking_url} className="text-accent hover:underline">
                          {shipment.tracking_number}
                        </a>
                      ) : (
                        shipment.tracking_number
                      )}
                    </span>
                  )}
                  {permissions.canFulfil && confirming === null && (
                    <span className="ml-auto inline-flex gap-2">
                      {shipment.status === 'pending' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={isPending}
                          onClick={() => setConfirming({ kind: 'pick', shipmentId: shipment.id })}
                        >
                          Pick
                        </Button>
                      )}
                      {shipment.status === 'picking' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={isPending}
                          onClick={() => setConfirming({ kind: 'pack', shipmentId: shipment.id })}
                        >
                          Pack
                        </Button>
                      )}
                      {shipment.status !== 'delivered' && shipment.status !== 'cancelled' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={isPending}
                          onClick={() => {
                            setStatus('');
                            setTrackingNumber(shipment.tracking_number ?? '');
                            setTrackingUrl(shipment.tracking_url ?? '');
                            setConfirming({ kind: 'update', shipmentId: shipment.id });
                          }}
                        >
                          Update
                        </Button>
                      )}
                    </span>
                  )}
                </div>

                {confirming?.kind === 'pick' && confirming.shipmentId === shipment.id && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span>Start picking this shipment?</span>
                    <Button
                      size="sm"
                      disabled={isPending}
                      onClick={() => run(() => pickShipmentAction(storeId, order.id, shipment.id))}
                    >
                      Yes, start picking
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </div>
                )}

                {confirming?.kind === 'pack' && confirming.shipmentId === shipment.id && (
                  <form
                    className="flex flex-wrap items-end gap-2"
                    aria-label="Pack shipment"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(() =>
                        packShipmentAction(storeId, order.id, shipment.id, {
                          parcel_count: parcelCount,
                        }),
                      );
                    }}
                  >
                    <div className="w-28">
                      <TextField
                        label="Parcels"
                        type="number"
                        min={1}
                        value={parcelCount}
                        onChange={(event) =>
                          setParcelCount(Math.max(1, Number(event.currentTarget.value)))
                        }
                      />
                    </div>
                    <Button type="submit" size="sm" disabled={isPending}>
                      Yes, mark packed
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                )}

                {confirming?.kind === 'update' && confirming.shipmentId === shipment.id && (
                  <form
                    className="space-y-2"
                    aria-label="Update shipment"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(() =>
                        updateShipmentAction(storeId, order.id, shipment.id, {
                          ...(status === '' ? {} : { status }),
                          ...(trackingNumber.trim() === ''
                            ? {}
                            : { tracking_number: trackingNumber.trim() }),
                          ...(trackingUrl.trim() === ''
                            ? {}
                            : { tracking_url: trackingUrl.trim() }),
                        }),
                      );
                    }}
                  >
                    <div className="grid gap-3 sm:grid-cols-3">
                      <SelectField
                        label="New status"
                        value={status}
                        onChange={(event) =>
                          setStatus(event.currentTarget.value as UpdateStatus | '')
                        }
                        options={[
                          { value: '', label: '— unchanged —' },
                          ...SHIPMENT_UPDATE_STATUSES.map((value) => ({
                            value,
                            label: statusLabel(value),
                          })),
                        ]}
                      />
                      <TextField
                        label="Tracking number"
                        value={trackingNumber}
                        onChange={(event) => setTrackingNumber(event.currentTarget.value)}
                      />
                      <TextField
                        label="Tracking URL"
                        value={trackingUrl}
                        onChange={(event) => setTrackingUrl(event.currentTarget.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={isPending}>
                        Yes, update the shipment
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Returns</h3>
        {order.returns.length === 0 ? (
          <p className="text-muted text-sm">No returns.</p>
        ) : (
          <ul className="divide-line divide-y">
            {order.returns.map((ret) => (
              <li key={ret.id} className="space-y-2 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone={toneFor(ret.status)}>{statusLabel(ret.status)}</Badge>
                  <span>
                    {ret.items.reduce((sum, item) => sum + item.quantity, 0)} unit(s)
                    {ret.reason !== null ? ` · ${ret.reason}` : ''}
                  </span>
                  {permissions.canReceiveReturn &&
                    confirming === null &&
                    (ret.status === 'requested' || ret.status === 'approved') &&
                    warehouses.length > 0 && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="ml-auto"
                        disabled={isPending}
                        onClick={() => {
                          setConditions(
                            Object.fromEntries(
                              ret.items.map((item) => [item.order_line_item_id, 'resellable']),
                            ),
                          );
                          setConfirming({ kind: 'receive', returnId: ret.id });
                        }}
                      >
                        Receive
                      </Button>
                    )}
                </div>

                {confirming?.kind === 'receive' && confirming.returnId === ret.id && (
                  <form
                    className="space-y-2"
                    aria-label="Receive return"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(() =>
                        receiveReturnAction(storeId, order.id, ret.id, {
                          warehouse_id: receiveWarehouseId,
                          items: ret.items.map((item) => ({
                            order_line_item_id: item.order_line_item_id,
                            quantity: item.quantity,
                            condition: conditions[item.order_line_item_id] ?? 'resellable',
                          })),
                        }),
                      );
                    }}
                  >
                    <SelectField
                      label="Warehouse"
                      required
                      value={receiveWarehouseId}
                      onChange={(event) => setReceiveWarehouseId(event.currentTarget.value)}
                      options={warehouses.map((warehouse) => ({
                        value: warehouse.id,
                        label: `${warehouse.code} — ${warehouse.name}`,
                      }))}
                    />
                    <ul className="space-y-2">
                      {ret.items.map((item) => (
                        <li key={item.order_line_item_id} className="flex items-center gap-3">
                          <span className="flex-1">
                            {item.quantity} × {lineTitle(item.order_line_item_id)}
                          </span>
                          <div className="w-40">
                            <SelectField
                              label="Condition"
                              value={conditions[item.order_line_item_id] ?? 'resellable'}
                              onChange={(event) => {
                                const chosen = event.currentTarget.value as Condition;
                                setConditions((current) => ({
                                  ...current,
                                  [item.order_line_item_id]: chosen,
                                }));
                              }}
                              options={RETURN_CONDITIONS.map((value) => ({ value, label: value }))}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={isPending || receiveWarehouseId === ''}
                      >
                        Yes, mark received
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
