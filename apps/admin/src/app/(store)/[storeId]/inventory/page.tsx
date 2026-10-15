import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { RequestErrorPanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listInventoryLevels, listStockItems, listWarehouses } from '@/lib/api/admin';
import { loadPrincipal } from '@/lib/principal';
import { warehouseAccess } from '@/lib/warehouse';
import { InventoryTable } from './inventory-table';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 50;
const SORTS = ['sku', 'available', 'on_hand'] as const;

type Params = Record<string, string | string[] | undefined>;

function param(raw: Params, key: string): string {
  const value = raw[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Store · Inventory (#468): one row per (variant, warehouse), carrying the POOL row's numbers. Two
 * variants that share a stock item show the same numbers — never summed. The "shared with N brands"
 * badge needs `listStockItems` (viewer on organization:hq), so only HQ principals see it; a store
 * admin sees the stock item id. Stock is corrected in HQ · Warehouse (cycle counts), not here.
 */
export default async function InventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<Params>;
}) {
  const { storeId } = await params;
  const raw = await searchParams;
  const sku = param(raw, 'sku');
  const warehouseId = UUID.test(param(raw, 'warehouse_id')) ? param(raw, 'warehouse_id') : '';
  const below = /^\d+$/.test(param(raw, 'below_available')) ? param(raw, 'below_available') : '';
  const sortParam = param(raw, 'sort');
  const sort = (SORTS as readonly string[]).includes(sortParam) ? sortParam : 'sku';
  const page = Math.max(1, Number.parseInt(param(raw, 'page'), 10) || 1);

  const principal = await loadPrincipal();
  const hq = principal.ok && warehouseAccess(principal.data).canReadStockItems;

  const [levels, warehouses, shared] = await Promise.all([
    listInventoryLevels({
      store_id: storeId,
      ...(sku === '' ? {} : { sku }),
      ...(warehouseId === '' ? {} : { warehouse_id: warehouseId }),
      ...(below === '' ? {} : { below_available: below }),
      sort,
      page,
      limit: LIMIT,
    }),
    listWarehouses(),
    hq ? listStockItems({ store_id: storeId, shared: 'true', limit: 100 }) : Promise.resolve(null),
  ]);

  const warehouseNames: Record<string, string> = Object.fromEntries(
    warehouses.ok ? warehouses.data.items.map((w) => [w.id, w.name]) : [],
  );
  // Stock item id → number of brands mapping it; only shared items are listed (shared=true).
  const sharedBrands: Record<string, number> | null =
    shared === null || !shared.ok
      ? null
      : Object.fromEntries(
          shared.data.items.map((item) => [
            item.id,
            new Set(item.variants.map((v) => v.store_id)).size,
          ]),
        );
  const total = levels.ok ? levels.data.total : 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const pageHref = (to: number) => {
    const query = new URLSearchParams({
      sku,
      warehouse_id: warehouseId,
      below_available: below,
      sort,
    });
    for (const [key, value] of [...query.entries()]) if (value === '') query.delete(key);
    query.set('page', String(to));
    return `?${query.toString()}`;
  };

  return (
    <StoreSectionGuard storeId={storeId} id="inventory">
      <Card>
        <CardHeader
          title="Inventory"
          description="Stock per variant and warehouse. A variant that shares a stock item with another brand shows the shared shelf's numbers."
        />
        <CardBody className="space-y-4">
          <form
            method="get"
            className="flex flex-wrap items-end gap-3 text-sm"
            aria-label="Filter inventory"
          >
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">SKU</span>
              <input
                name="sku"
                defaultValue={sku}
                className="border-line rounded-md border px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">Warehouse</span>
              <select
                name="warehouse_id"
                defaultValue={warehouseId}
                className="border-line rounded-md border px-2 py-1"
              >
                <option value="">Any warehouse</option>
                {Object.entries(warehouseNames).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">Available below</span>
              <input
                name="below_available"
                inputMode="numeric"
                defaultValue={below}
                className="border-line w-24 rounded-md border px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">Sort by</span>
              <select
                name="sort"
                defaultValue={sort}
                className="border-line rounded-md border px-2 py-1"
              >
                <option value="sku">SKU</option>
                <option value="available">Available</option>
                <option value="on_hand">On hand</option>
              </select>
            </label>
            <button type="submit" className="text-accent hover:underline">
              Apply
            </button>
          </form>
          {!levels.ok ? (
            <RequestErrorPanel status={levels.status} error={levels.error} />
          ) : (
            <InventoryTable
              rows={levels.data.items}
              warehouseNames={warehouseNames}
              sharedBrands={sharedBrands}
            />
          )}
          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center gap-3 text-sm">
              {page > 1 && <Link href={pageHref(page - 1)}>Previous</Link>}
              <span className="text-muted">
                Page {page} of {pages}
              </span>
              {page < pages && <Link href={pageHref(page + 1)}>Next</Link>}
            </nav>
          )}
        </CardBody>
      </Card>
    </StoreSectionGuard>
  );
}
