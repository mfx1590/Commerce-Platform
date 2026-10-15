// Cycle counts and reconciliation on the shared pool (#436, CONTRACT CHANGE #458).
//
// A count is written down; reconciliation turns its discrepancy into exactly ONE stock movement — through the
// inventory module, the only writer of `on_hand` — or flags it for an approval. A level is never edited here.
//
//   delta = counted − on-hand AS OF the count = counted − (on-hand now − PHYSICAL movements since counted_at)
//
// "Physical" is every movement except reason `cycle_count`. A cycle-count adjustment moves no goods: it corrects
// the books to what a count saw. Reading one as "a movement since" would undo it — count A approved after count B
// was taken would be subtracted from B's baseline and A's discrepancy applied a second time. (An adjustment from
// a count taken AFTER this one never gets here: that count is applied, so this one is refused as superseded.)
//
// Everything that decides is computed under the shelf's lock at apply time (at reconcile, and again at approval),
// never taken from an earlier read. Every function takes an ORGANIZATION-scoped client: counts are an HQ record
// (RLS kind `organization_only`), and a count's movement has no store.
import type { Queryable, ScopedClient } from '@platform/db';
import { writeAudit, type Actor } from '../../lib/audit';
import { AppError, notFound } from '../../lib/errors';
import { ensureLevel, moveStock } from '../inventory';

export type CycleCountStatus = 'recorded' | 'flagged' | 'applied';
export const CYCLE_COUNT_STATUSES: readonly CycleCountStatus[] = ['recorded', 'flagged', 'applied'];

/** The Admin API's `CycleCount`. */
export interface CycleCount {
  id: string;
  warehouse_id: string;
  stock_item_id: string;
  sku: string;
  counted_quantity: number;
  counted_by: string | null;
  counted_at: string;
  source: 'manual' | 'wms';
  note: string | null;
  status: CycleCountStatus;
  on_hand_as_of_count: number | null;
  delta: number | null;
  stock_movement_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  reconciled_at: string | null;
}

/**
 * The one thing reconciliation asks of the inventory module: its pool-addressed `moveStock` (#456), called with
 * reason `cycle_count`, no store, and the count as the reference. A port so that tests can stand in for it; the
 * default is the real one, so nothing has to be registered at boot. The module never writes a level or a movement
 * itself.
 */
export type StockMover = (
  tx: Queryable,
  input: {
    organizationId: string;
    stockItemId: string;
    warehouseId: string;
    delta: number;
    reason: 'cycle_count';
    referenceType: 'cycle_count';
    referenceId: string;
    note: string | null;
    actor: Actor;
  },
) => Promise<{ stockMovementId: string }>;

/** The inventory module's `moveStock`: one locked pool row, one ledger row, one `stock.moved`, no attribution. */
export const inventoryStockMover: StockMover = async (tx, input) => {
  const moved = await moveStock(tx, {
    organizationId: input.organizationId,
    stockItemId: input.stockItemId,
    warehouseId: input.warehouseId,
    delta: input.delta,
    reason: input.reason,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    note: input.note,
    actor: input.actor,
  });
  return { stockMovementId: moved.movementId };
};
let stockMover: StockMover = inventoryStockMover;

/** Replaces the stock mover (tests). Returns the previous one. */
export function setStockMover(next: StockMover): StockMover {
  const previous = stockMover;
  stockMover = next;
  return previous;
}
export function resetStockMover(): void {
  stockMover = inventoryStockMover;
}

/** `organization.settings.warehouse.count_tolerance`: a non-negative integer of units; anything else is 0. */
export function countTolerance(settings: unknown): number {
  if (settings === null || typeof settings !== 'object') return 0;
  const warehouse = (settings as Record<string, unknown>).warehouse;
  if (warehouse === null || typeof warehouse !== 'object') return 0;
  const value = (warehouse as Record<string, unknown>).count_tolerance;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export interface ReconciliationPlan {
  onHandAsOfCount: number;
  delta: number;
  /** `apply` writes the movement (none when the delta is 0); `flag` moves nothing and waits for an approval. */
  action: 'apply' | 'flag';
}

/** The decision, as a pure function of what was read under the lock. */
export function planReconciliation(input: {
  countedQuantity: number;
  onHandNow: number;
  /** Sum of the deltas of the PHYSICAL movements written since the count (never a `cycle_count` one). */
  movedSinceCount: number;
  tolerance: number;
  approve: boolean;
}): ReconciliationPlan {
  const onHandAsOfCount = input.onHandNow - input.movedSinceCount;
  const delta = input.countedQuantity - onHandAsOfCount;
  const action = input.approve || Math.abs(delta) <= input.tolerance ? 'apply' : 'flag';
  return { onHandAsOfCount, delta, action };
}

const COLUMNS = `c.id, c.warehouse_id, c.stock_item_id, si.sku, c.counted_quantity, c.counted_by, c.counted_at,
  c.source, c.note, c.status, c.on_hand_as_of_count, c.delta, c.stock_movement_id, c.approved_by, c.approved_at,
  c.reconciled_at`;
const FROM = `cycle_count c JOIN stock_item si ON si.id = c.stock_item_id`;

interface Row extends Omit<CycleCount, 'counted_at' | 'approved_at' | 'reconciled_at'> {
  counted_at: Date;
  approved_at: Date | null;
  reconciled_at: Date | null;
}

const toCount = (r: Row): CycleCount => ({
  ...r,
  counted_at: r.counted_at.toISOString(),
  approved_at: r.approved_at?.toISOString() ?? null,
  reconciled_at: r.reconciled_at?.toISOString() ?? null,
});

async function readCount(tx: Queryable, id: string): Promise<CycleCount | null> {
  const r = await tx.query<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE c.id = $1`, [id]);
  return r.rows[0] ? toCount(r.rows[0]) : null;
}

/** One shelf at a time: a transaction-scoped lock on (stock item, warehouse), held whether or not a level exists. */
async function lockShelf(tx: Queryable, stockItemId: string, warehouseId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `cycle_count:${stockItemId}:${warehouseId}`,
  ]);
}

/**
 * 409 `conflict` (`details.reason = 'superseded'`; the contract's error codes are a closed list) when this count
 * is no longer the books' latest truth for its shelf:
 *   * a count of the same shelf with the same or a later `counted_at` is already applied — its adjustment would be
 *     read as "a movement since this count" and this count's discrepancy applied a second time; or
 *   * a `cycle_count` movement was written on the shelf AFTER `counted_at` with no count behind it (entered by
 *     hand through `createStockMovement`). It corrected the books to something seen after this count, and since it
 *     is not a physical movement it would be ignored: the older count would then overwrite it.
 */
async function refuseSuperseded(
  tx: Queryable,
  shelf: { stockItemId: string; warehouseId: string; countedAt: Date; exceptId?: string },
): Promise<void> {
  const later = await tx.query<{ id: string }>(
    `SELECT id FROM cycle_count
     WHERE stock_item_id = $1 AND warehouse_id = $2 AND status = 'applied' AND counted_at >= $3
       AND id IS DISTINCT FROM $4
     ORDER BY counted_at DESC LIMIT 1`,
    [shelf.stockItemId, shelf.warehouseId, shelf.countedAt, shelf.exceptId ?? null],
  );
  if (later.rows[0]) {
    throw new AppError(
      'conflict',
      'a later count of this stock item and warehouse has already been applied',
      { reason: 'superseded', applied_cycle_count_id: later.rows[0].id },
    );
  }
  const byHand = await tx.query<{ id: string }>(
    `SELECT m.id FROM stock_movement m
     WHERE m.stock_item_id = $1 AND m.warehouse_id = $2 AND m.created_at > $3 AND ${UNLINKED_ADJUSTMENT}
     ORDER BY m.created_at DESC LIMIT 1`,
    [shelf.stockItemId, shelf.warehouseId, shelf.countedAt],
  );
  if (byHand.rows[0]) {
    throw new AppError('conflict', 'the stock was adjusted by hand after this count', {
      reason: 'superseded',
      stock_movement_id: byHand.rows[0].id,
    });
  }
}

export interface CreateCycleCountInput {
  organizationId: string;
  warehouseId: string;
  stockItemId: string;
  countedQuantity: number;
  /** Defaults to now; may not be in the future. */
  countedAt?: Date;
  note?: string | null;
  /** `wms` for a count pulled from a warehouse system: it has no counter. */
  source?: 'manual' | 'wms';
}

/** Writes a count down. Changes no stock. */
export async function createCycleCount(
  client: ScopedClient,
  input: CreateCycleCountInput,
  actor: Actor,
): Promise<CycleCount> {
  if (!Number.isSafeInteger(input.countedQuantity) || input.countedQuantity < 0) {
    throw new AppError('validation_error', 'counted_quantity must be a non-negative integer', {
      counted_quantity: 'integer >= 0',
    });
  }
  const source = input.source ?? 'manual';
  if (source === 'manual' && actor.id === null) {
    throw new AppError('validation_error', 'a manual count needs the staff user who counted');
  }
  return client.transaction(async (tx) => {
    const now = (await tx.query<{ now: Date }>(`SELECT now() AS now`)).rows[0]!.now;
    const countedAt = input.countedAt ?? now;
    if (countedAt.getTime() > now.getTime()) {
      throw new AppError(
        'validation_error',
        'counted_at may not be in the future',
        { field: 'counted_at' },
        422,
      );
    }
    const warehouse = await tx.query(`SELECT 1 FROM warehouse WHERE id = $1`, [input.warehouseId]);
    if (warehouse.rowCount === 0) throw notFound('warehouse', input.warehouseId);
    const item = await tx.query(`SELECT 1 FROM stock_item WHERE id = $1`, [input.stockItemId]);
    if (item.rowCount === 0) throw notFound('stock item', input.stockItemId);

    await lockShelf(tx, input.stockItemId, input.warehouseId);
    await refuseSuperseded(tx, {
      stockItemId: input.stockItemId,
      warehouseId: input.warehouseId,
      countedAt,
    });

    const made = await tx.query<{ id: string }>(
      `INSERT INTO cycle_count
         (organization_id, warehouse_id, stock_item_id, counted_quantity, counted_by, counted_at, source, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.organizationId,
        input.warehouseId,
        input.stockItemId,
        input.countedQuantity,
        source === 'manual' ? actor.id : null,
        countedAt,
        source,
        input.note ?? null,
      ],
    );
    const count = (await readCount(tx, made.rows[0]!.id))!;
    await writeAudit(tx, {
      organizationId: input.organizationId,
      storeId: null,
      actor,
      action: 'cycle_count.create',
      entityType: 'cycle_count',
      entityId: count.id,
      after: count,
    });
    return count;
  });
}

export interface ListCycleCountsQuery {
  warehouseId?: string;
  stockItemId?: string;
  status?: CycleCountStatus;
  page: number;
  limit: number;
}

export async function listCycleCounts(
  client: ScopedClient,
  query: ListCycleCountsQuery,
): Promise<{ page: number; limit: number; total: number; items: CycleCount[] }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (query.warehouseId) add(`c.warehouse_id = ?`, query.warehouseId);
  if (query.stockItemId) add(`c.stock_item_id = ?`, query.stockItemId);
  if (query.status) add(`c.status = ?`, query.status);
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return client.transaction(async (tx) => {
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${FROM} ${clause}`,
      params,
    );
    const rows = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM ${FROM} ${clause}
       ORDER BY c.counted_at DESC, c.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, (query.page - 1) * query.limit],
    );
    return {
      page: query.page,
      limit: query.limit,
      total: Number(total.rows[0]!.n),
      items: rows.rows.map(toCount),
    };
  });
}

/** A `cycle_count` movement no count row links to: a correction entered by hand (as `m`). */
const UNLINKED_ADJUSTMENT = `m.reason = 'cycle_count'
  AND NOT EXISTS (SELECT 1 FROM cycle_count linked WHERE linked.stock_movement_id = m.id)`;

/** Movements that moved goods. A `cycle_count` movement corrects the books and is never one of them. */
const PHYSICAL = `reason <> 'cycle_count'`;

/**
 * What the shelf says right now, inside the caller's transaction. The pool row is taken through the inventory
 * module's `ensureLevel` — created at zero when the shelf has never held the item, THEN locked — so the row
 * exists before it is read and every other writer of the shelf (they all lock this row) queues behind us. One
 * pool row per reconciliation, so the module's lock order holds trivially.
 */
async function readShelf(
  tx: Queryable,
  shelf: { organizationId: string; stockItemId: string; warehouseId: string; countedAt: Date },
): Promise<{ onHandNow: number; movedSinceCount: number }> {
  const level = await ensureLevel(
    tx,
    {
      organizationId: shelf.organizationId,
      stockItemId: shelf.stockItemId,
      warehouseId: shelf.warehouseId,
    },
    true,
  );
  return { onHandNow: level.on_hand, movedSinceCount: await physicalMovedSince(tx, shelf) };
}

/** Sum of the PHYSICAL movements written on the shelf since the count. */
async function physicalMovedSince(
  tx: Queryable,
  shelf: { stockItemId: string; warehouseId: string; countedAt: Date },
): Promise<number> {
  const moved = await tx.query<{ n: string }>(
    `SELECT coalesce(sum(delta), 0)::text AS n FROM stock_movement
     WHERE stock_item_id = $1 AND warehouse_id = $2 AND created_at > $3 AND ${PHYSICAL}`,
    [shelf.stockItemId, shelf.warehouseId, shelf.countedAt],
  );
  return Number(moved.rows[0]!.n);
}

async function toleranceOf(tx: Queryable, organizationId: string): Promise<number> {
  const r = await tx.query<{ settings: unknown }>(
    `SELECT settings FROM organization WHERE id = $1`,
    [organizationId],
  );
  return countTolerance(r.rows[0]?.settings);
}

export interface ReconcileOptions {
  organizationId: string;
  /** Apply whatever the delta is (an approval by `operations` on organization:hq). */
  approve?: boolean;
}

/**
 * Reconciles one count. Idempotent by count id: an applied count is answered as it is. Within the tolerance (or
 * approved) → exactly one movement through the stock mover and status `applied`, none when the delta is 0;
 * above it → nothing moves, status `flagged`.
 */
export async function reconcileCycleCount(
  client: ScopedClient,
  cycleCountId: string,
  options: ReconcileOptions,
  actor: Actor,
): Promise<CycleCount> {
  const approve = options.approve === true;
  return client.transaction(async (tx) => {
    const found = await tx.query<{ stock_item_id: string; warehouse_id: string; counted_at: Date }>(
      `SELECT stock_item_id, warehouse_id, counted_at FROM cycle_count WHERE id = $1`,
      [cycleCountId],
    );
    const shelfOf = found.rows[0];
    if (!shelfOf) throw notFound('cycle count', cycleCountId);
    const shelf = {
      stockItemId: shelfOf.stock_item_id,
      warehouseId: shelfOf.warehouse_id,
      countedAt: shelfOf.counted_at,
    };
    // The shelf first, then the count: every reconciliation of this shelf queues here, so the status read
    // below is the committed one.
    await lockShelf(tx, shelf.stockItemId, shelf.warehouseId);
    const before = (
      await tx.query<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE c.id = $1 FOR UPDATE OF c`, [
        cycleCountId,
      ])
    ).rows[0]!;
    if (before.status === 'applied') return toCount(before);
    await refuseSuperseded(tx, { ...shelf, exceptId: cycleCountId });

    const plan = planReconciliation({
      countedQuantity: before.counted_quantity,
      ...(await readShelf(tx, { organizationId: options.organizationId, ...shelf })),
      tolerance: await toleranceOf(tx, options.organizationId),
      approve,
    });

    if (plan.action === 'flag') {
      await tx.query(
        `UPDATE cycle_count SET status = 'flagged', on_hand_as_of_count = $2, delta = $3, reconciled_at = now()
         WHERE id = $1`,
        [cycleCountId, plan.onHandAsOfCount, plan.delta],
      );
    } else {
      const movement =
        plan.delta === 0
          ? null
          : await stockMover(tx, {
              organizationId: options.organizationId,
              stockItemId: shelf.stockItemId,
              warehouseId: shelf.warehouseId,
              delta: plan.delta,
              reason: 'cycle_count',
              referenceType: 'cycle_count',
              referenceId: cycleCountId,
              note: before.note,
              actor,
            });
      await tx.query(
        `UPDATE cycle_count
         SET status = 'applied', on_hand_as_of_count = $2, delta = $3, reconciled_at = now(),
             stock_movement_id = $4, approved_by = $5, approved_at = CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END
         WHERE id = $1`,
        [
          cycleCountId,
          plan.onHandAsOfCount,
          plan.delta,
          movement?.stockMovementId ?? null,
          approve ? actor.id : null,
        ],
      );
    }

    const after = (await readCount(tx, cycleCountId))!;
    await writeAudit(tx, {
      organizationId: options.organizationId,
      storeId: null,
      actor,
      action:
        plan.action === 'flag'
          ? 'cycle_count.flag'
          : approve
            ? 'cycle_count.approve'
            : 'cycle_count.apply',
      entityType: 'cycle_count',
      entityId: cycleCountId,
      before: toCount(before),
      after,
    });
    return after;
  });
}

/** The Admin API's `CycleCountPreview` (0.4.16, CONTRACT CHANGE #469). */
export interface CycleCountPreview {
  cycle_count_id: string;
  on_hand_as_of_count: number;
  delta: number;
  count_tolerance: number;
  would_status: 'applied' | 'flagged';
  computed_at: string;
}

/**
 * What `reconcileCycleCount` would do now, WITHOUT doing it (`previewCycleCountReconcile`). The same computation —
 * `planReconciliation` over on-hand now and the physical movements since the count, the same superseded rule
 * (409) — but a pure read: no advisory lock, no row lock, and no pool row created (a shelf that has never held the
 * item reads on-hand 0). So it is a preview: a later reconcile or approval recomputes under the lock and may find
 * a different delta if stock moved in between. An applied count answers its stored values. A count in a
 * deactivated warehouse answers 404, like reconcile.
 */
export async function previewCycleCountReconcile(
  client: ScopedClient,
  cycleCountId: string,
  options: { organizationId: string },
): Promise<CycleCountPreview> {
  return client.transaction(async (tx) => {
    const found = await tx.query<Row & { warehouse_active: boolean; now: Date }>(
      `SELECT ${COLUMNS}, w.is_active AS warehouse_active, now() AS now
       FROM ${FROM} JOIN warehouse w ON w.id = c.warehouse_id WHERE c.id = $1`,
      [cycleCountId],
    );
    const count = found.rows[0];
    if (!count) throw notFound('cycle count', cycleCountId);
    const tolerance = await toleranceOf(tx, options.organizationId);
    const computedAt = count.now.toISOString();
    if (count.status === 'applied') {
      return {
        cycle_count_id: count.id,
        on_hand_as_of_count: count.on_hand_as_of_count!,
        delta: count.delta!,
        count_tolerance: tolerance,
        would_status: 'applied',
        computed_at: computedAt,
      };
    }
    if (!count.warehouse_active) throw notFound('warehouse', count.warehouse_id);
    const shelf = {
      stockItemId: count.stock_item_id,
      warehouseId: count.warehouse_id,
      countedAt: count.counted_at,
    };
    await refuseSuperseded(tx, { ...shelf, exceptId: count.id });
    const level = await tx.query<{ on_hand: number }>(
      `SELECT on_hand FROM inventory_level WHERE stock_item_id = $1 AND warehouse_id = $2`,
      [shelf.stockItemId, shelf.warehouseId],
    );
    const plan = planReconciliation({
      countedQuantity: count.counted_quantity,
      onHandNow: level.rows[0]?.on_hand ?? 0,
      movedSinceCount: await physicalMovedSince(tx, shelf),
      tolerance,
      approve: false,
    });
    return {
      cycle_count_id: count.id,
      on_hand_as_of_count: plan.onHandAsOfCount,
      delta: plan.delta,
      count_tolerance: tolerance,
      would_status: plan.action === 'apply' ? 'applied' : 'flagged',
      computed_at: computedAt,
    };
  });
}

export interface PlannedReconciliation extends ReconciliationPlan {
  cycleCountId: string;
  stockItemId: string;
  sku: string;
  countedQuantity: number;
  countedAt: string;
  status: CycleCountStatus;
  /** A later count of the shelf is already applied: reconciling this one would answer 409. */
  superseded: boolean;
  /**
   * A newer count of the same shelf is open too. Each line is computed as if it were reconciled alone, now:
   * once this one is applied the newer one's delta shrinks by it, and once the newer one is applied this one is
   * superseded — reconcile the newest.
   */
  newerOpenCount: boolean;
}

/**
 * What reconciling every open count of a warehouse would do, oldest count first. READS ONLY — no lock, no
 * write — so it is a preview: the real reconciliation recomputes under the lock.
 */
export async function planOpenCounts(
  client: ScopedClient,
  input: { organizationId: string; warehouseCode: string },
): Promise<{ warehouseId: string; tolerance: number; counts: PlannedReconciliation[] }> {
  return client.transaction(async (tx) => {
    const warehouse = await tx.query<{ id: string }>(`SELECT id FROM warehouse WHERE code = $1`, [
      input.warehouseCode,
    ]);
    const warehouseId = warehouse.rows[0]?.id;
    if (!warehouseId) throw notFound('warehouse', input.warehouseCode);
    const tolerance = await toleranceOf(tx, input.organizationId);
    const open = await tx.query<
      Row & { on_hand_now: number; moved_since: string; superseded: boolean; newer_open: boolean }
    >(
      `SELECT ${COLUMNS},
              coalesce((SELECT il.on_hand FROM inventory_level il
                        WHERE il.stock_item_id = c.stock_item_id AND il.warehouse_id = c.warehouse_id), 0) AS on_hand_now,
              (SELECT coalesce(sum(m.delta), 0)::text FROM stock_movement m
               WHERE m.stock_item_id = c.stock_item_id AND m.warehouse_id = c.warehouse_id
                 AND m.created_at > c.counted_at AND m.${PHYSICAL}) AS moved_since,
              EXISTS (SELECT 1 FROM cycle_count n
                      WHERE n.stock_item_id = c.stock_item_id AND n.warehouse_id = c.warehouse_id
                        AND n.status <> 'applied' AND n.counted_at > c.counted_at) AS newer_open,
              EXISTS (SELECT 1 FROM cycle_count l
                      WHERE l.stock_item_id = c.stock_item_id AND l.warehouse_id = c.warehouse_id
                        AND l.status = 'applied' AND l.counted_at >= c.counted_at AND l.id <> c.id)
              OR EXISTS (SELECT 1 FROM stock_movement m
                         WHERE m.stock_item_id = c.stock_item_id AND m.warehouse_id = c.warehouse_id
                           AND m.created_at > c.counted_at AND ${UNLINKED_ADJUSTMENT}) AS superseded
       FROM ${FROM} WHERE c.warehouse_id = $1 AND c.status <> 'applied'
       ORDER BY c.counted_at, c.id`,
      [warehouseId],
    );
    return {
      warehouseId,
      tolerance,
      counts: open.rows.map((r) => ({
        cycleCountId: r.id,
        stockItemId: r.stock_item_id,
        sku: r.sku,
        countedQuantity: r.counted_quantity,
        countedAt: r.counted_at.toISOString(),
        status: r.status,
        superseded: r.superseded,
        newerOpenCount: r.newer_open,
        ...planReconciliation({
          countedQuantity: r.counted_quantity,
          onHandNow: r.on_hand_now,
          movedSinceCount: Number(r.moved_since),
          tolerance,
          approve: false,
        }),
      })),
    };
  });
}
