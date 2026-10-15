import Link from 'next/link';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { RequestErrorPanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listCycleCounts, listStockItems, listStores, listWarehouses } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { loadPrincipal } from '@/lib/principal';
import {
  CYCLE_COUNT_STATUSES,
  formatDelta,
  mappingStores,
  olderOpenCounts,
  warehouseAccess,
} from '@/lib/warehouse';
import {
  ApproveButton,
  PoolVariantForm,
  ReconcileButton,
  RecordCountForm,
  type VariantChoice,
} from './warehouse-forms';

export const dynamic = 'force-dynamic';

type StockItem = AdminComponents['StockItem'];
type CycleCount = AdminComponents['CycleCount'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 25;

type Params = Record<string, string | string[] | undefined>;

function param(raw: Params, key: string): string {
  const value = raw[key];
  return typeof value === 'string' ? value : '';
}

function uuidParam(raw: Params, key: string): string {
  const value = param(raw, key);
  return UUID.test(value) ? value : '';
}

function pageParam(raw: Params): number {
  const page = Number.parseInt(param(raw, 'page'), 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function formatTime(value: string | null): string {
  return value === null ? '—' : value.replace('T', ' ').slice(0, 16);
}

function href(base: Record<string, string>, extra: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...base, ...extra })) {
    if (value !== '' && value !== undefined) query.set(key, String(value));
  }
  return `/warehouse?${query.toString()}`;
}

function Pager({
  page,
  total,
  base,
}: {
  page: number;
  total: number;
  base: Record<string, string>;
}) {
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex items-center gap-3 pt-3 text-sm">
      {page > 1 && <Link href={href(base, { page: page - 1 })}>Previous</Link>}
      <span className="text-muted">
        Page {page} of {pages}
      </span>
      {page < pages && <Link href={href(base, { page: page + 1 })}>Next</Link>}
    </nav>
  );
}

const STATUS_TONE = { recorded: 'neutral', flagged: 'warning', applied: 'success' } as const;

/**
 * HQ · Warehouse (#468): the shared stock pool (stock items, the variants per store that map each,
 * the pool numbers per warehouse, "pool this variant onto this item") and cycle counts (record,
 * reconcile, approve). Every mutation is re-checked server-side before the API
 * (`src/app/actions/warehouse.ts`); the section guard and the buttons are a convenience.
 * The movement ledger and the reservations of an item wait for CONTRACT CHANGE #469.
 */
export default async function WarehousePage({ searchParams }: { searchParams: Promise<Params> }) {
  const raw = await searchParams;
  const tab = param(raw, 'tab') === 'counts' ? 'counts' : 'items';

  const [principal, stores, warehouses] = await Promise.all([
    loadPrincipal(),
    listStores({ limit: 100 }),
    listWarehouses(),
  ]);
  const access = principal.ok
    ? warehouseAccess(principal.data)
    : { canReadStockItems: false, canOperate: false };
  const storeLabel = new Map(
    stores.ok ? stores.data.items.map((store) => [store.id, store.name] as const) : [],
  );
  const warehouseLabel = new Map(
    warehouses.ok
      ? warehouses.data.items.map(
          (w) => [w.id, `${w.name}${w.is_active ? '' : ' (inactive)'}`] as const,
        )
      : [],
  );
  const brand = (storeId: string) => storeLabel.get(storeId) ?? storeId;
  const warehouseName = (id: string) => warehouseLabel.get(id) ?? id;

  // Sections are awaited here, not nested as async components: one async boundary per page.
  const body =
    tab === 'items'
      ? await StockItems({
          raw,
          canOperate: access.canOperate,
          brand,
          warehouseName,
          storeOptions: stores.ok ? stores.data.items.map((s) => ({ id: s.id, name: s.name })) : [],
        })
      : await CycleCounts({
          raw,
          canOperate: access.canOperate,
          warehouseName,
          warehouseOptions: warehouses.ok
            ? warehouses.data.items
                .filter((w) => w.is_active)
                .map((w) => ({ value: w.id, label: w.name }))
            : [],
        });

  return (
    <HqSectionGuard id="warehouse">
      <div className="space-y-6">
        <nav aria-label="Warehouse sections" className="flex gap-4 text-sm">
          <Link
            href="/warehouse"
            aria-current={tab === 'items' ? 'page' : undefined}
            className={tab === 'items' ? 'font-semibold' : 'text-accent hover:underline'}
          >
            Stock items
          </Link>
          <Link
            href="/warehouse?tab=counts"
            aria-current={tab === 'counts' ? 'page' : undefined}
            className={tab === 'counts' ? 'font-semibold' : 'text-accent hover:underline'}
          >
            Cycle counts
          </Link>
        </nav>
        {body}
      </div>
    </HqSectionGuard>
  );
}

// ---------------------------------------------------------------------------- stock items

async function StockItems({
  raw,
  canOperate,
  brand,
  warehouseName,
  storeOptions,
}: {
  raw: Params;
  canOperate: boolean;
  brand: (storeId: string) => string;
  warehouseName: (id: string) => string;
  storeOptions: { id: string; name: string }[];
}) {
  const sku = param(raw, 'sku');
  const storeId = uuidParam(raw, 'store_id');
  const shared = param(raw, 'shared') === 'true';
  const page = pageParam(raw);
  const result = await listStockItems({
    ...(sku === '' ? {} : { sku }),
    ...(storeId === '' ? {} : { store_id: storeId }),
    ...(shared ? { shared: 'true' } : {}),
    page,
    limit: LIMIT,
  });
  const items: StockItem[] = result.ok ? result.data.items : [];
  const choicesFor = (item: StockItem): VariantChoice[] =>
    items
      .filter((other) => other.id !== item.id)
      .flatMap((other) =>
        other.variants.map((v) => ({
          variantId: v.variant_id,
          sku: v.sku,
          storeLabel: brand(v.store_id),
        })),
      );

  return (
    <Card>
      <CardHeader
        title="Stock items"
        description="One shelf per item and warehouse. Variants of several brands can sell from the same item; the numbers are the pool's, never a sum per brand."
      />
      <CardBody className="space-y-4">
        <form
          method="get"
          action="/warehouse"
          className="flex flex-wrap items-end gap-3 text-sm"
          aria-label="Filter stock items"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">SKU contains</span>
            <input
              name="sku"
              defaultValue={sku}
              className="border-line rounded-md border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">Mapped by store</span>
            <select
              name="store_id"
              defaultValue={storeId}
              className="border-line rounded-md border px-2 py-1"
            >
              <option value="">Any store</option>
              {storeOptions.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="shared" value="true" defaultChecked={shared} />
            <span>Shared by more than one store</span>
          </label>
          <button type="submit" className="text-accent hover:underline">
            Apply
          </button>
        </form>

        {!result.ok ? (
          <RequestErrorPanel status={result.status} error={result.error} />
        ) : items.length === 0 ? (
          <p className="text-muted text-sm">No stock items match.</p>
        ) : (
          <ul className="divide-line divide-y" aria-label="Stock items">
            {items.map((item) => {
              const brands = mappingStores(item).map(brand);
              return (
                <li key={item.id} className="space-y-2 py-3" aria-label={`Stock item ${item.sku}`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-sm font-medium">{item.sku}</span>
                    <span>{item.name}</span>
                    {brands.length > 1 && (
                      <Badge tone="accent">Shared with {brands.length} brands</Badge>
                    )}
                    {item.barcode !== null && (
                      <span className="text-muted text-xs">barcode {item.barcode}</span>
                    )}
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <table className="text-sm" aria-label={`Variants mapping ${item.sku}`}>
                      <thead className="text-muted text-left text-xs">
                        <tr>
                          <th className="py-1">Brand</th>
                          <th>Variant SKU</th>
                        </tr>
                      </thead>
                      <tbody>
                        {item.variants.length === 0 ? (
                          <tr>
                            <td colSpan={2} className="text-muted py-1">
                              No variant maps this item.
                            </td>
                          </tr>
                        ) : (
                          item.variants.map((v) => (
                            <tr key={v.variant_id}>
                              <td className="py-0.5">{brand(v.store_id)}</td>
                              <td className="font-mono text-xs">{v.sku}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                    <table className="text-sm" aria-label={`Pool levels of ${item.sku}`}>
                      <thead className="text-muted text-left text-xs">
                        <tr>
                          <th className="py-1">Warehouse</th>
                          <th>On hand</th>
                          <th>Reserved (all brands)</th>
                          <th>Incoming</th>
                          <th>Available</th>
                        </tr>
                      </thead>
                      <tbody>
                        {item.levels.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="text-muted py-1">
                              Not stocked in any warehouse.
                            </td>
                          </tr>
                        ) : (
                          item.levels.map((level) => (
                            <tr key={level.warehouse_id}>
                              <td className="py-0.5">{warehouseName(level.warehouse_id)}</td>
                              <td>{level.on_hand}</td>
                              <td>{level.reserved}</td>
                              <td>{level.incoming}</td>
                              <td>{level.available}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  {canOperate && (
                    <PoolVariantForm
                      stockItemId={item.id}
                      itemSku={item.sku}
                      itemBrands={brands}
                      choices={choicesFor(item)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {result.ok && (
          <Pager
            page={page}
            total={result.data.total}
            base={{ sku, store_id: storeId, shared: shared ? 'true' : '' }}
          />
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------- cycle counts

async function CycleCounts({
  raw,
  canOperate,
  warehouseName,
  warehouseOptions,
}: {
  raw: Params;
  canOperate: boolean;
  warehouseName: (id: string) => string;
  warehouseOptions: { value: string; label: string }[];
}) {
  const warehouseId = uuidParam(raw, 'warehouse_id');
  const stockItemId = uuidParam(raw, 'stock_item_id');
  const statusParam = param(raw, 'status');
  const status = (CYCLE_COUNT_STATUSES as readonly string[]).includes(statusParam)
    ? statusParam
    : '';
  const page = pageParam(raw);

  const [result, items] = await Promise.all([
    listCycleCounts({
      ...(warehouseId === '' ? {} : { warehouse_id: warehouseId }),
      ...(stockItemId === '' ? {} : { stock_item_id: stockItemId }),
      ...(status === '' ? {} : { status }),
      page,
      limit: LIMIT,
    }),
    listStockItems({ limit: 100 }),
  ]);
  const stockItems: StockItem[] = items.ok ? items.data.items : [];
  const stockOptions = stockItems.map((item) => ({
    value: item.id,
    label: `${item.sku} — ${item.name}`,
  }));
  const onHandNow = (count: CycleCount): number | null =>
    stockItems
      .find((item) => item.id === count.stock_item_id)
      ?.levels.find((level) => level.warehouse_id === count.warehouse_id)?.on_hand ?? null;
  const counts: CycleCount[] = result.ok ? result.data.items : [];
  const older = olderOpenCounts(counts);

  return (
    <div className="space-y-6">
      {canOperate && (
        <Card>
          <CardHeader
            title="Record a count"
            description="Writes the count down; stock changes only when it is reconciled."
          />
          <CardBody>
            <RecordCountForm warehouses={warehouseOptions} stockItems={stockOptions} />
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader
          title="Cycle counts"
          description="Newest first. The delta is measured against on-hand as of the count, so a count reconciled the next morning is still right."
        />
        <CardBody className="space-y-4">
          <p className="text-sm" role="note">
            When a shelf has several open counts, reconcile the <strong>newest</strong>: the older
            ones then answer “superseded” and stay as records.
          </p>
          <form
            method="get"
            action="/warehouse"
            className="flex flex-wrap items-end gap-3 text-sm"
            aria-label="Filter cycle counts"
          >
            <input type="hidden" name="tab" value="counts" />
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">Warehouse</span>
              <select
                name="warehouse_id"
                defaultValue={warehouseId}
                className="border-line rounded-md border px-2 py-1"
              >
                <option value="">Any warehouse</option>
                {warehouseOptions.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">Stock item</span>
              <select
                name="stock_item_id"
                defaultValue={stockItemId}
                className="border-line rounded-md border px-2 py-1"
              >
                <option value="">Any item</option>
                {stockOptions.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">Status</span>
              <select
                name="status"
                defaultValue={status}
                className="border-line rounded-md border px-2 py-1"
              >
                <option value="">Any status</option>
                {CYCLE_COUNT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="text-accent hover:underline">
              Apply
            </button>
          </form>

          {!result.ok ? (
            <RequestErrorPanel status={result.status} error={result.error} />
          ) : counts.length === 0 ? (
            <p className="text-muted text-sm">No counts match.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Cycle counts">
                <thead className="text-muted text-left text-xs">
                  <tr>
                    <th className="py-1">SKU</th>
                    <th>Warehouse</th>
                    <th>Counted</th>
                    <th>Counted by</th>
                    <th>Counted at</th>
                    <th>Status</th>
                    <th>On hand as of count</th>
                    <th>Delta</th>
                    <th>Approved</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {counts.map((count) => (
                    <tr
                      key={count.id}
                      aria-label={`Count of ${count.sku} at ${formatTime(count.counted_at)}`}
                    >
                      <td className="py-2 font-mono text-xs">{count.sku}</td>
                      <td>{warehouseName(count.warehouse_id)}</td>
                      <td>{count.counted_quantity}</td>
                      <td className="text-xs">
                        {count.counted_by === null ? (
                          'WMS'
                        ) : (
                          <span className="font-mono">{count.counted_by.slice(0, 8)}</span>
                        )}
                      </td>
                      <td className="text-muted text-xs">{formatTime(count.counted_at)}</td>
                      <td className="space-x-1">
                        <Badge tone={STATUS_TONE[count.status]}>{count.status}</Badge>
                        {older.has(count.id) && <Badge tone="neutral">older count</Badge>}
                      </td>
                      <td>{count.on_hand_as_of_count ?? '—'}</td>
                      <td>{formatDelta(count.delta)}</td>
                      <td className="text-muted text-xs">
                        {count.approved_at === null ? '—' : formatTime(count.approved_at)}
                      </td>
                      <td className="text-right">
                        {canOperate && count.status === 'recorded' && (
                          <ReconcileButton cycleCountId={count.id} sku={count.sku} />
                        )}
                        {canOperate && count.status === 'flagged' && (
                          <ApproveButton
                            cycleCountId={count.id}
                            sku={count.sku}
                            flaggedDelta={count.delta}
                            onHandNow={onHandNow(count)}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.ok && (
            <Pager
              page={page}
              total={result.data.total}
              base={{
                tab: 'counts',
                warehouse_id: warehouseId,
                stock_item_id: stockItemId,
                status,
              }}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
