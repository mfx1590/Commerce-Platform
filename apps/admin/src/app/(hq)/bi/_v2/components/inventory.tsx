import Link from 'next/link';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listMetrics } from '../../_api';
import { getInventoryHealth } from '../api';
import {
  INVENTORY_BOUNDS,
  INVENTORY_LIMIT,
  INVENTORY_SORTS,
  INVENTORY_STATUSES,
  inventoryAnswer,
  inventoryQuery,
  parseInventory,
  parseState,
  perDay,
  STATUS_WORDS,
  stateHref,
  type BiState,
  type InventoryState,
  type InventoryStatus,
  type Raw,
} from '../model';
import { BiExport } from './bi-export';
import { BiNav, FilterChips, Notice } from './shell';

const STATUS_TONE: Record<
  InventoryStatus,
  'danger' | 'warning' | 'accent' | 'neutral' | 'success'
> = {
  stock_out: 'danger',
  low: 'danger',
  reorder: 'warning',
  dead: 'neutral',
  overstock: 'accent',
  ok: 'success',
};

const SORT_WORDS: Record<InventoryState['sort'], string> = {
  days_of_cover: 'days of cover',
  suggested_reorder_units: 'suggested reorder',
  available: 'available',
  units_sold_per_day_milli: 'sales per day',
  sku: 'SKU',
};

/** The URL extras of the inventory state (status, search, sort, page, overrides). */
function extrasOf(inventory: InventoryState, changes: Partial<Record<string, string>> = {}) {
  const values: Record<string, string> = {
    status: inventory.statuses.join(','),
    q: inventory.q,
    sort: inventory.sort === 'days_of_cover' ? '' : inventory.sort,
    dir: inventory.direction === 'asc' ? '' : inventory.direction,
    page: inventory.page > 1 ? String(inventory.page) : '',
    warehouse: inventory.warehouse,
    velocity: inventory.velocity === null ? '' : String(inventory.velocity),
    lead: inventory.lead === null ? '' : String(inventory.lead),
    cover: inventory.cover === null ? '' : String(inventory.cover),
    dead: inventory.dead === null ? '' : String(inventory.dead),
  };
  for (const [key, value] of Object.entries(changes)) values[key] = value ?? '';
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
}

/**
 * BI v2 · Inventory health (#871 view 3), the owner's question "how is our availability, do we
 * need to order anything?": one row per stock item (its warehouses as a breakdown) with on hand,
 * reserved and available, the sales rate, days of cover, the status and the suggested reorder.
 * The position is live; the rate comes from the analytics store — when that is down the page says
 * so and shows the positions alone. Incoming stock is not tracked yet (#878) and the page says it.
 */
export async function InventoryView({
  raw,
  base,
  storeId,
  canOpenLedger,
}: {
  raw: Raw;
  base: string;
  storeId?: string;
  /** HQ · Warehouse admits this principal (operations on hq): rows link to the item's ledger. */
  canOpenLedger: boolean;
}) {
  const state: BiState = parseState(raw);
  const inventory = parseInventory(raw);
  const [catalogue, health] = await Promise.all([
    listMetrics(),
    getInventoryHealth(inventoryQuery(state, inventory, storeId)),
  ]);
  const view = `${base}/inventory`;
  const params: Record<string, string> = Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : [],
    ),
  );
  const defaults = catalogue.ok ? catalogue.data.inventory_defaults : undefined;
  const names = (kind: string, id: string) =>
    kind === 'store' && catalogue.ok
      ? (catalogue.data.stores.find((s) => s.id === id)?.code ?? id)
      : `${id.slice(0, 8)}…`;

  if (!health.ok) {
    return (
      <div className="space-y-6">
        <BiNav base={base} current="inventory" state={state} />
        <ApiStatePanel status={health.status} error={health.error} what="inventory health" />
      </div>
    );
  }
  const data = health.data;
  const pages = Math.max(1, Math.ceil(data.total / INVENTORY_LIMIT));
  const summary = data.summary as Record<string, number>;
  const toggle = (status: InventoryStatus) => {
    const set = new Set(inventory.statuses);
    if (set.has(status)) set.delete(status);
    else set.add(status);
    return stateHref(
      view,
      state,
      {},
      extrasOf(inventory, { status: [...set].join(','), page: '' }),
    );
  };

  return (
    <div className="space-y-6">
      <BiNav base={base} current="inventory" state={state} />
      <Card>
        <CardHeader
          title="Inventory health"
          description={`Do we need to order anything? Positions as of ${data.position_as_of.replace('T', ' ').slice(0, 16)} UTC (live).${data.data_as_of ? ` Sales rates up to ${data.data_as_of.replace('T', ' ').slice(0, 16)} UTC.` : ''}`}
          action={
            <BiExport
              block="inventory"
              params={params}
              storeId={storeId ?? null}
              what="bi-inventory"
              cap={500}
            />
          }
        />
        <CardBody className="space-y-4">
          <p role="status" aria-label="The answer" className="text-base font-medium">
            {inventoryAnswer(data, inventory.statuses.length > 0)}
          </p>
          {!data.rate_available && (
            <Notice tone="warning">
              Sales rates are unavailable right now (the analytics store did not answer). The stock
              positions below are live, but days of cover, statuses and reorder suggestions cannot
              be computed until it is back.
            </Notice>
          )}
          {!data.incoming_tracked && (
            <Notice>
              Incoming stock is not tracked yet: there are no purchase orders (#878), so
              &quot;incoming&quot; is 0 everywhere and the suggestions do not subtract anything
              already on its way.
            </Notice>
          )}
          <ul aria-label="Items per status" className="flex flex-wrap gap-2 text-sm">
            {INVENTORY_STATUSES.map((status) => (
              <li key={status}>
                <Link
                  href={toggle(status)}
                  aria-pressed={inventory.statuses.includes(status)}
                  className={`border-line inline-flex items-center gap-2 rounded-full border px-3 py-1 ${inventory.statuses.includes(status) ? 'bg-accent/10 border-accent/40' : ''}`}
                >
                  <Badge tone={STATUS_TONE[status]}>{STATUS_WORDS[status]}</Badge>
                  <span className="tabular-nums">{summary[status] ?? 0}</span>
                </Link>
              </li>
            ))}
          </ul>
          <form
            method="get"
            action={view}
            aria-label="Search and parameters"
            className="flex flex-wrap items-end gap-3 text-sm"
          >
            {Object.entries(
              extrasOf(inventory, { q: '', velocity: '', lead: '', cover: '', dead: '', page: '' }),
            ).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            {state.store && <input type="hidden" name="store" value={state.store} />}
            {state.category && <input type="hidden" name="category" value={state.category} />}
            {state.product && <input type="hidden" name="product" value={state.product} />}
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">SKU or name</span>
              <input
                name="q"
                defaultValue={inventory.q}
                maxLength={100}
                className="border-line bg-surface h-9 w-48 rounded-md border px-2"
              />
            </label>
            {!storeId && catalogue.ok && catalogue.data.stores.length > 1 && (
              <label className="flex flex-col gap-1">
                <span className="text-muted text-xs">Store</span>
                <select
                  name="store"
                  defaultValue={state.store}
                  className="border-line bg-surface h-9 rounded-md border px-2"
                >
                  <option value="">All my stores</option>
                  {catalogue.data.stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(
              [
                ['velocity', 'Sales rate over (days)', defaults?.velocity_days],
                ['lead', 'Lead time (days)', defaults?.lead_time_days],
                ['cover', 'Cover wanted (days)', defaults?.cover_days],
                ['dead', 'No sales for (days)', defaults?.dead_days],
              ] as const
            ).map(([name, label, fallback]) => (
              <label key={name} className="flex flex-col gap-1">
                <span className="text-muted text-xs">
                  {label} ({INVENTORY_BOUNDS[name][0]}–{INVENTORY_BOUNDS[name][1]})
                </span>
                <input
                  name={name}
                  inputMode="numeric"
                  defaultValue={inventory[name] ?? ''}
                  placeholder={fallback === undefined ? 'store default' : `default ${fallback}`}
                  className="border-line bg-surface h-9 w-28 rounded-md border px-2"
                />
              </label>
            ))}
            <button type="submit" className="bg-accent text-accent-ink h-9 rounded-md px-3">
              Apply
            </button>
          </form>
          <FilterChips base={view} state={state} names={names} extra={extrasOf(inventory)} />
          <nav aria-label="Sort by" className="flex flex-wrap gap-3 text-sm">
            <span className="text-muted">Sort by:</span>
            {INVENTORY_SORTS.map((sort) => {
              const active = sort === inventory.sort;
              const direction = active && inventory.direction === 'asc' ? 'desc' : 'asc';
              return (
                <Link
                  key={sort}
                  href={stateHref(
                    view,
                    state,
                    {},
                    extrasOf(inventory, { sort, dir: direction === 'asc' ? '' : 'desc', page: '' }),
                  )}
                  aria-current={active ? 'true' : undefined}
                  className={active ? 'font-semibold' : 'text-accent hover:underline'}
                >
                  {SORT_WORDS[sort]}
                  {active ? (inventory.direction === 'asc' ? ' ↑' : ' ↓') : ''}
                </Link>
              );
            })}
          </nav>

          {data.rows.length === 0 ? (
            <p className="text-muted text-sm">No item matches these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Inventory health">
                <thead className="text-muted text-left text-xs">
                  <tr>
                    <th className="py-1">Item</th>
                    <th>Status</th>
                    <th>Available</th>
                    <th>Reserved</th>
                    <th>On hand</th>
                    <th>Sold per day</th>
                    <th>Days of cover</th>
                    <th>Suggested reorder</th>
                    <th>Last sale</th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y align-top">
                  {data.rows.map((row) => (
                    <tr key={row.stock_item_id}>
                      <td className="py-2">
                        <div className="font-medium">{row.name}</div>
                        <div className="text-muted font-mono text-xs">{row.sku}</div>
                        {row.shared && (
                          <Badge tone="accent" title="Several stores sell from this stock">
                            shared pool
                          </Badge>
                        )}
                        <details className="mt-1 text-xs">
                          <summary className="text-muted cursor-pointer">
                            {row.warehouses.length} warehouse
                            {row.warehouses.length === 1 ? '' : 's'}
                          </summary>
                          <ul className="mt-1 space-y-0.5">
                            {row.warehouses.map((w) => (
                              <li key={w.warehouse_id} className="tabular-nums">
                                <span className="font-mono">{w.warehouse_code}</span>: available{' '}
                                {w.available}, reserved {w.reserved}, on hand {w.on_hand}
                                {canOpenLedger && (
                                  <Link
                                    href={`/warehouse?item=${row.stock_item_id}&view=movements&warehouse_id=${w.warehouse_id}`}
                                    className="text-accent ml-2 hover:underline"
                                    aria-label={`Ledger of ${row.sku} in ${w.warehouse_code}`}
                                  >
                                    ledger
                                  </Link>
                                )}
                              </li>
                            ))}
                          </ul>
                        </details>
                      </td>
                      <td>
                        {row.status === null ? (
                          <span className="text-muted text-xs">not computed</span>
                        ) : (
                          <Badge tone={STATUS_TONE[row.status]}>{STATUS_WORDS[row.status]}</Badge>
                        )}
                      </td>
                      <td className="tabular-nums">{row.available}</td>
                      <td className="tabular-nums">{row.reserved}</td>
                      <td className="tabular-nums">{row.on_hand}</td>
                      <td className="tabular-nums">
                        {perDay(row.units_sold_per_day_milli)}
                        {row.rate_understated && (
                          <span
                            className="text-muted block text-xs"
                            title="The item was out of stock part of the window, so it may have sold more"
                          >
                            may be understated
                          </span>
                        )}
                      </td>
                      <td className="tabular-nums">{row.days_of_cover ?? '—'}</td>
                      <td className="tabular-nums">
                        {row.suggested_reorder_units ?? '—'}
                        {row.suggestion_partial && (
                          <span className="text-muted block text-xs">
                            this store&apos;s sales only — HQ&apos;s view is authoritative for a
                            shared pool
                          </span>
                        )}
                        <span className="text-muted block text-xs">
                          lead {row.parameters.lead_time_days} d, cover {row.parameters.cover_days}{' '}
                          d ({row.parameters_source})
                        </span>
                      </td>
                      <td className="text-muted text-xs">
                        {row.last_sale_at ? row.last_sale_at.slice(0, 10) : 'never'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center gap-3 text-sm">
              {inventory.page > 1 && (
                <Link
                  href={stateHref(
                    view,
                    state,
                    {},
                    extrasOf(inventory, { page: String(inventory.page - 1) }),
                  )}
                >
                  Previous
                </Link>
              )}
              <span className="text-muted">
                Page {inventory.page} of {pages} ({data.total} items)
              </span>
              {inventory.page < pages && (
                <Link
                  href={stateHref(
                    view,
                    state,
                    {},
                    extrasOf(inventory, { page: String(inventory.page + 1) }),
                  )}
                >
                  Next
                </Link>
              )}
            </nav>
          )}
          {!canOpenLedger && (
            <p className="text-muted text-xs">
              The movement ledger behind each figure is in HQ · Warehouse, which needs operations on
              HQ.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
