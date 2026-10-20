// The warehouse-management-system boundary (#436): what the pool asks of a WMS, and the only implementation
// there is until an Odoo Inventory instance exists (owner item) — an in-memory one. It lives inside hq-warehouse
// on purpose (manager, 2026-10-12): `apps/wms-adapter` becomes a package the day something real consumes it.
import type { ScopedClient } from '@platform/db';
import { SYSTEM_ACTOR } from '../../../lib/audit';
import { notFound } from '../../../lib/errors';
import { createCycleCount, type CycleCount } from '../cycle-counts';

/** One shelf as the WMS counted it. `sku` is the stock item's sku (unique per organization). */
export interface WmsCount {
  sku: string;
  countedQuantity: number;
  countedAt: Date;
}

export interface WmsAdapter {
  /** Shown in logs and in the count's note; never a credential. */
  readonly name: string;
  /** The latest counts the WMS holds for a warehouse, by our warehouse code. */
  pullCounts(warehouseCode: string): Promise<WmsCount[]>;
}

export interface MemoryWmsAdapter extends WmsAdapter {
  setCounts(warehouseCode: string, counts: WmsCount[]): void;
}

/** Forgets everything on restart — which is why it is called `memory` and nothing production-sounding. */
export function createMemoryWmsAdapter(): MemoryWmsAdapter {
  const byWarehouse = new Map<string, WmsCount[]>();
  return {
    name: 'memory',
    setCounts(warehouseCode, counts) {
      byWarehouse.set(
        warehouseCode,
        counts.map((c) => ({ ...c })),
      );
    },
    pullCounts(warehouseCode) {
      return Promise.resolve((byWarehouse.get(warehouseCode) ?? []).map((c) => ({ ...c })));
    },
  };
}

export interface WmsPullResult {
  recorded: CycleCount[];
  /** Skus the WMS reported that name no stock item of the organization: written nowhere, returned for a human. */
  unknownSkus: string[];
}

/**
 * Pulls a warehouse's counts and writes each down as a `wms` cycle count (status `recorded`, no counter).
 * Records only: reconciling is a separate, deliberate step, with the same tolerance and approval as a manual
 * count. A count the pool has already superseded is refused by `createCycleCount` and the error propagates.
 */
export async function recordWmsCounts(
  client: ScopedClient,
  input: { organizationId: string; warehouseCode: string },
  adapter: WmsAdapter,
): Promise<WmsPullResult> {
  const warehouse = await client.query<{ id: string }>(`SELECT id FROM warehouse WHERE code = $1`, [
    input.warehouseCode,
  ]);
  const warehouseId = warehouse.rows[0]?.id;
  if (!warehouseId) throw notFound('warehouse', input.warehouseCode);

  const counts = await adapter.pullCounts(input.warehouseCode);
  const items = await client.query<{ id: string; sku: string }>(
    `SELECT id, sku FROM stock_item WHERE sku = ANY ($1::text[])`,
    [counts.map((c) => c.sku)],
  );
  const itemBySku = new Map(items.rows.map((i) => [i.sku, i.id]));

  const result: WmsPullResult = { recorded: [], unknownSkus: [] };
  for (const count of counts) {
    const stockItemId = itemBySku.get(count.sku);
    if (!stockItemId) {
      result.unknownSkus.push(count.sku);
      continue;
    }
    result.recorded.push(
      await createCycleCount(
        client,
        {
          organizationId: input.organizationId,
          warehouseId,
          stockItemId,
          countedQuantity: count.countedQuantity,
          countedAt: count.countedAt,
          source: 'wms',
          note: `pulled from ${adapter.name}`,
        },
        SYSTEM_ACTOR,
      ),
    );
  }
  return result;
}
