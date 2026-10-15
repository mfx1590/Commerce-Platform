import { Badge } from '@/components/ui/badge';
import type { AdminComponents } from '@/lib/api/admin-client';
import { inventoryRowKey } from '@/lib/warehouse';

type InventoryLevel = AdminComponents['InventoryLevel'];

/**
 * Inventory rows keyed by (variant_id, warehouse_id): `id` is the pool row's and repeats when two
 * variants share a stock item. Each row shows its pool's numbers as they are — no totals, because
 * summing across variants would count one shelf twice.
 */
export function InventoryTable({
  rows,
  warehouseNames,
  sharedBrands,
}: {
  rows: readonly InventoryLevel[];
  warehouseNames: Readonly<Record<string, string>>;
  /** Stock item id → brands mapping it (shared items only); null when the principal cannot read it. */
  sharedBrands: Readonly<Record<string, number>> | null;
}) {
  if (rows.length === 0) return <p className="text-muted text-sm">No inventory rows match.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label="Inventory levels">
        <thead className="text-muted text-left text-xs">
          <tr>
            <th className="py-1">SKU</th>
            <th>Warehouse</th>
            <th>Stock item</th>
            <th>On hand</th>
            <th>Reserved</th>
            <th>Incoming</th>
            <th>Available</th>
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {rows.map((row) => {
            const brands = sharedBrands?.[row.stock_item_id] ?? 0;
            return (
              <tr key={inventoryRowKey(row)} data-row-key={inventoryRowKey(row)}>
                <td className="py-2 font-mono text-xs">{row.sku}</td>
                <td>{warehouseNames[row.warehouse_id] ?? row.warehouse_id}</td>
                <td className="space-x-2">
                  <span className="text-muted font-mono text-xs" title={row.stock_item_id}>
                    {row.stock_item_id.slice(0, 8)}
                  </span>
                  {brands > 1 && <Badge tone="accent">Shared with {brands} brands</Badge>}
                </td>
                <td>{row.on_hand}</td>
                <td>{row.reserved}</td>
                <td>{row.incoming}</td>
                <td>{row.available}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
