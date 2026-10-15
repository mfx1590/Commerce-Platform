import Link from 'next/link';
import { RequestErrorPanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listStockItemMovements, listStockItemReservations } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  RESERVATION_STATUSES,
  allocationRuleLabel,
  formatDelta,
  movementReasonLabel,
} from '@/lib/warehouse';

type StockItem = AdminComponents['StockItem'];

export type DetailView = 'movements' | 'reservations';
export const DETAIL_LIMIT = 25;

function formatTime(value: string | null): string {
  return value === null ? '—' : value.replace('T', ' ').slice(0, 16);
}

function short(id: string): string {
  return id.slice(0, 8);
}

/**
 * One stock item's ledger (`listStockItemMovements`) or its reservations
 * (`listStockItemReservations`, with `allocation_rule`), under the stock items list. Both are HQ
 * reads (viewer on organization:hq) behind the warehouse section's `operations` gate. Awaited by
 * the page (one async boundary), not rendered as a nested async component.
 */
export async function StockItemDetail({
  stockItemId,
  item,
  view,
  warehouseId,
  status,
  page,
  brand,
  warehouseName,
  hrefFor,
}: {
  stockItemId: string;
  /** The item when it is on the current page of the list (for its sku and variants). */
  item: StockItem | undefined;
  view: DetailView;
  warehouseId: string;
  status: (typeof RESERVATION_STATUSES)[number];
  /** The detail's own page (`dpage`), separate from the list's. */
  page: number;
  brand: (storeId: string) => string;
  warehouseName: (id: string) => string;
  hrefFor: (extra: Record<string, string | number>) => string;
}) {
  const label = item?.sku ?? short(stockItemId);
  const variantSku = new Map((item?.variants ?? []).map((v) => [v.variant_id, v.sku]));
  const query = {
    ...(warehouseId === '' ? {} : { warehouse_id: warehouseId }),
    page,
    limit: DETAIL_LIMIT,
  };

  const tabs = (
    <nav aria-label={`Details of ${label}`} className="flex gap-4 text-sm">
      {(['movements', 'reservations'] as const).map((v) => (
        <Link
          key={v}
          href={hrefFor({ view: v, dpage: 1 })}
          aria-current={v === view ? 'page' : undefined}
          className={v === view ? 'font-semibold' : 'text-accent hover:underline'}
        >
          {v === 'movements' ? 'Movements' : 'Reservations'}
        </Link>
      ))}
      <Link href={hrefFor({ item: '', view: '', dpage: '' })} className="text-muted ml-auto">
        Close
      </Link>
    </nav>
  );

  const warehouseFilter = (
    <form method="get" action="/warehouse" className="flex flex-wrap items-end gap-3 text-sm">
      <input type="hidden" name="item" value={stockItemId} />
      <input type="hidden" name="view" value={view} />
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">Warehouse</span>
        <select
          name="warehouse_id"
          defaultValue={warehouseId}
          className="border-line rounded-md border px-2 py-1"
        >
          <option value="">Any warehouse</option>
          {(item?.levels ?? []).map((level) => (
            <option key={level.warehouse_id} value={level.warehouse_id}>
              {warehouseName(level.warehouse_id)}
            </option>
          ))}
        </select>
      </label>
      {view === 'reservations' && (
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Status</span>
          <select
            name="status"
            defaultValue={status}
            className="border-line rounded-md border px-2 py-1"
          >
            {RESERVATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className="text-accent hover:underline">
        Apply
      </button>
    </form>
  );

  const pager = (total: number) => {
    const pages = Math.max(1, Math.ceil(total / DETAIL_LIMIT));
    if (pages <= 1) return null;
    return (
      <nav aria-label="Detail pages" className="flex items-center gap-3 text-sm">
        {page > 1 && <Link href={hrefFor({ dpage: page - 1 })}>Previous</Link>}
        <span className="text-muted">
          Page {page} of {pages}
        </span>
        {page < pages && <Link href={hrefFor({ dpage: page + 1 })}>Next</Link>}
      </nav>
    );
  };

  if (view === 'movements') {
    const result = await listStockItemMovements(stockItemId, query);
    return (
      <Card>
        <CardHeader
          title={`Movements of ${label}`}
          description="The pool row's ledger, newest first: every brand's sales and returns, and the pool's own receipts, transfers and counts."
        />
        <CardBody className="space-y-4">
          {tabs}
          {warehouseFilter}
          {!result.ok ? (
            result.status === 404 ? (
              <p className="text-sm">That stock item was not found.</p>
            ) : (
              <RequestErrorPanel status={result.status} error={result.error} />
            )
          ) : result.data.items.length === 0 ? (
            <p className="text-muted text-sm">No movements.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label={`Movements of ${label}`}>
                <thead className="text-muted text-left text-xs">
                  <tr>
                    <th className="py-1">When</th>
                    <th>Warehouse</th>
                    <th>Delta</th>
                    <th>Reason</th>
                    <th>Caused by</th>
                    <th>Reference</th>
                    <th>Actor</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {result.data.items.map((m) => (
                    <tr key={m.id}>
                      <td className="text-muted py-2 font-mono text-xs">
                        {formatTime(m.created_at)}
                      </td>
                      <td>{warehouseName(m.warehouse_id)}</td>
                      <td className="font-mono">{formatDelta(m.delta)}</td>
                      <td>{movementReasonLabel(m.reason)}</td>
                      <td>
                        {m.store_id === null ? (
                          <Badge>pool</Badge>
                        ) : (
                          <>
                            {brand(m.store_id)}
                            {m.variant_id !== null && variantSku.has(m.variant_id) && (
                              <span className="text-muted font-mono text-xs">
                                {' '}
                                {variantSku.get(m.variant_id)}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="text-xs">
                        {m.reference_type === null
                          ? '—'
                          : `${m.reference_type}${m.reference_id === null ? '' : ` ${short(m.reference_id)}`}`}
                      </td>
                      <td className="text-xs">
                        {m.actor_id === null ? (
                          'system'
                        ) : (
                          <span className="font-mono">{short(m.actor_id)}</span>
                        )}
                      </td>
                      <td className="text-muted text-xs">{m.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.ok && pager(result.data.total)}
        </CardBody>
      </Card>
    );
  }

  const result = await listStockItemReservations(stockItemId, { ...query, status });
  return (
    <Card>
      <CardHeader
        title={`Reservations of ${label}`}
        description="Every brand's reservations on this item's shelves, and the rule that chose each warehouse."
      />
      <CardBody className="space-y-4">
        {tabs}
        {warehouseFilter}
        {!result.ok ? (
          result.status === 404 ? (
            <p className="text-sm">That stock item was not found.</p>
          ) : (
            <RequestErrorPanel status={result.status} error={result.error} />
          )
        ) : result.data.items.length === 0 ? (
          <p className="text-muted text-sm">
            No {status === 'all' ? '' : `${status} `}reservations.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={`Reservations of ${label}`}>
              <thead className="text-muted text-left text-xs">
                <tr>
                  <th className="py-1">Created</th>
                  <th>Warehouse</th>
                  <th>Brand</th>
                  <th>Variant SKU</th>
                  <th>Order</th>
                  <th>Quantity</th>
                  <th>Why this warehouse</th>
                  <th>Expires / released</th>
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {result.data.items.map((r) => (
                  <tr key={r.id}>
                    <td className="text-muted py-2 font-mono text-xs">
                      {formatTime(r.created_at)}
                    </td>
                    <td>{warehouseName(r.warehouse_id)}</td>
                    <td>{brand(r.store_id)}</td>
                    <td className="font-mono text-xs">
                      {variantSku.get(r.variant_id) ?? short(r.variant_id)}
                    </td>
                    <td className="text-xs">
                      {r.order_id === null ? (
                        'cart hold'
                      ) : (
                        <span className="font-mono">{short(r.order_id)}</span>
                      )}
                    </td>
                    <td>{r.quantity}</td>
                    <td>{allocationRuleLabel(r.allocation_rule)}</td>
                    <td className="text-muted text-xs">
                      {r.released_at !== null
                        ? `released ${formatTime(r.released_at)}`
                        : r.expires_at !== null
                          ? `expires ${formatTime(r.expires_at)}`
                          : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.ok && pager(result.data.total)}
      </CardBody>
    </Card>
  );
}
