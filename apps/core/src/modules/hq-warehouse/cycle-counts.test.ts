// Cycle counts and reconciliation (#436) on a seeded throwaway database: count →
// reconcile → exactly one movement, the tolerance and the approval, the delta against on-hand AS OF the count and
// its three guards, idempotency, permissions through the router, the dry-run CLI and the WMS pull.
//
// Nothing is faked: every movement — a reconciliation's and the receipts and shipments the tests need — goes
// through the inventory module's real `moveStock`, the only writer of `on_hand` in application code.
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, SEED_IDS, type ScopedClient } from '@platform/db';
import type { TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier } from '../../http';
import { loadSpec } from '../../http/openapi';
import type { Actor } from '../../lib/audit';
import { closePool, initDb } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import { moveStock } from '../inventory';
import { runReconcile } from './cli/reconcile';
import {
  countTolerance,
  createCycleCount,
  createMemoryWmsAdapter,
  cycleCountsAdminRouter,
  listCycleCounts,
  planOpenCounts,
  planReconciliation,
  reconcileCycleCount,
  recordWmsCounts,
  resetStockMover,
} from './index';
import { createPoolDatabase } from './testing/pool-database';

const ORG = SEED_IDS.organization;
const EU = SEED_IDS.warehouses.eu;
const US = SEED_IDS.warehouses.us;

/**
 * Goods really move: a receipt (+) or a transfer out (−) through the inventory module, as HQ. `at` backdates the
 * ledger row (fixture, owner role) so a test can place a movement between two counts.
 */
async function move(
  item: string,
  delta: number,
  at?: Date,
  warehouse = EU,
  reason: 'receipt' | 'transfer_out' | 'cycle_count' = delta > 0 ? 'receipt' : 'transfer_out',
): Promise<void> {
  const moved = await hq.transaction((tx) =>
    moveStock(tx, {
      organizationId: ORG,
      stockItemId: item,
      warehouseId: warehouse,
      delta,
      reason,
      actor: operations,
    }),
  );
  if (at) {
    await db.owner.query(`UPDATE stock_movement SET created_at = $2 WHERE id = $1`, [
      moved.movementId,
      at,
    ]);
  }
}

let db: TestDatabase;
let hq: ScopedClient;
let operations: Actor;
let items: { id: string; sku: string }[];
let next = 0;

/** A stock item no earlier test has touched: every test gets its own shelf. */
const freshItem = () => items[next++]!;

/** Fixture (owner role): what is on the shelf, with no movement written. */
async function setOnHand(item: string, warehouse: string, onHand: number): Promise<void> {
  await db.owner.query(
    `UPDATE inventory_level SET on_hand = $3 WHERE stock_item_id = $1 AND warehouse_id = $2`,
    [item, warehouse, onHand],
  );
}

async function onHand(item: string, warehouse = EU): Promise<number> {
  const r = await db.owner.query<{ on_hand: number }>(
    `SELECT on_hand FROM inventory_level WHERE stock_item_id = $1 AND warehouse_id = $2`,
    [item, warehouse],
  );
  return r.rows[0]!.on_hand;
}

async function movementsOf(item: string, warehouse = EU) {
  const r = await db.owner.query<{
    id: string;
    delta: number;
    reason: string;
    reference_type: string | null;
    reference_id: string | null;
    store_id: string | null;
  }>(
    `SELECT id, delta, reason, reference_type, reference_id, store_id FROM stock_movement
     WHERE stock_item_id = $1 AND warehouse_id = $2 ORDER BY created_at, id`,
    [item, warehouse],
  );
  return r.rows;
}

async function setTolerance(value: unknown): Promise<void> {
  await db.owner.query(`UPDATE organization SET settings = $2::jsonb WHERE id = $1`, [
    ORG,
    JSON.stringify(value === undefined ? {} : { warehouse: { count_tolerance: value } }),
  ]);
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

const record = (item: string, countedQuantity: number, countedAt?: Date, warehouse = EU) =>
  createCycleCount(
    hq,
    {
      organizationId: ORG,
      warehouseId: warehouse,
      stockItemId: item,
      countedQuantity,
      ...(countedAt ? { countedAt } : {}),
    },
    operations,
  );

const reconcile = (id: string, approve = false) =>
  reconcileCycleCount(hq, id, { organizationId: ORG, approve }, operations);

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status?: number; code?: string; details?: Record<string, unknown> }) => ({
      status: e.status,
      code: e.code,
      details: e.details,
    }),
  );

beforeAll(async () => {
  db = await createPoolDatabase();
  process.env.CORE_DEV_TOKENS = '1';
  await initDb({ connectionString: db.app.options.connectionString! });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  const user = await db.owner.query<{ id: string }>(
    `SELECT id FROM staff_user WHERE keycloak_subject = 'seed-operations'`,
  );
  operations = { id: user.rows[0]!.id, type: 'staff', requestId: 'req-cycle-count' };
  items = (
    await db.owner.query<{ id: string; sku: string }>(
      `SELECT si.id, si.sku FROM stock_item si
       JOIN inventory_level il ON il.stock_item_id = si.id AND il.warehouse_id = $1
       ORDER BY si.sku LIMIT 200`,
      [EU],
    )
  ).rows;
}, 240_000);

beforeEach(async () => {
  resetStockMover();
  await setTolerance(5);
});

afterAll(async () => {
  resetStockMover();
  await closePool();
  await db?.drop();
});

describe('pure parts', () => {
  it('reads the tolerance, and treats anything that is not a non-negative integer as 0', () => {
    expect(countTolerance({ warehouse: { count_tolerance: 3 } })).toBe(3);
    for (const settings of [
      null,
      {},
      { warehouse: null },
      { warehouse: { count_tolerance: -1 } },
      { warehouse: { count_tolerance: 2.5 } },
      { warehouse: { count_tolerance: '3' } },
      { warehouse: { count_tolerance: Number.NaN } },
    ]) {
      expect(countTolerance(settings)).toBe(0);
    }
  });

  it('plans against on-hand as of the count', () => {
    const base = { countedQuantity: 10, tolerance: 2, approve: false };
    expect(planReconciliation({ ...base, onHandNow: 12, movedSinceCount: 0 })).toEqual({
      onHandAsOfCount: 12,
      delta: -2,
      action: 'apply',
    });
    // 3 shipped since the count: the shelf held 12 when it was counted
    expect(planReconciliation({ ...base, onHandNow: 9, movedSinceCount: -3 })).toEqual({
      onHandAsOfCount: 12,
      delta: -2,
      action: 'apply',
    });
    expect(planReconciliation({ ...base, onHandNow: 13, movedSinceCount: 0 }).action).toBe('flag');
    expect(
      planReconciliation({ ...base, onHandNow: 13, movedSinceCount: 0, approve: true }).action,
    ).toBe('apply');
  });
});

describe('count → reconcile', () => {
  it('writes the count down and changes no stock', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 12);
    expect(count).toMatchObject({
      warehouse_id: EU,
      stock_item_id: item.id,
      sku: item.sku,
      counted_quantity: 12,
      counted_by: operations.id,
      source: 'manual',
      status: 'recorded',
      on_hand_as_of_count: null,
      delta: null,
      stock_movement_id: null,
    });
    expect(await onHand(item.id)).toBe(10);
    expect(await movementsOf(item.id)).toEqual([]);
  });

  it('turns the difference into exactly one movement, and on-hand equals the count when nothing moved since', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 12);
    const applied = await reconcile(count.id);
    expect(applied).toMatchObject({
      status: 'applied',
      on_hand_as_of_count: 10,
      delta: 2,
      approved_by: null,
    });
    const movements = await movementsOf(item.id);
    expect(movements).toEqual([
      {
        id: applied.stock_movement_id,
        delta: 2,
        reason: 'cycle_count',
        reference_type: 'cycle_count',
        reference_id: count.id,
        store_id: null,
      },
    ]);
    expect(await onHand(item.id)).toBe(12);
  });

  it('writes a negative delta as one negative movement', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const applied = await reconcile((await record(item.id, 7)).id);
    expect(applied.delta).toBe(-3);
    expect((await movementsOf(item.id)).map((m) => m.delta)).toEqual([-3]);
    expect(await onHand(item.id)).toBe(7);
  });

  it('is a no-op the second time: same answer, still one movement', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 12);
    const first = await reconcile(count.id);
    const second = await reconcile(count.id);
    const third = await reconcile(count.id, true);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await movementsOf(item.id)).toHaveLength(1);
    expect(await onHand(item.id)).toBe(12);
  });

  it('gives one movement to two reconciliations of one count issued at once', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 13);
    const [a, b] = await Promise.all([reconcile(count.id), reconcile(count.id)]);
    expect(a).toEqual(b);
    expect(await movementsOf(item.id)).toHaveLength(1);
    expect(await onHand(item.id)).toBe(13);
  });

  it('applies a count that matches with no movement at all', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const applied = await reconcile((await record(item.id, 10)).id);
    expect(applied).toMatchObject({ status: 'applied', delta: 0, stock_movement_id: null });
    expect(await movementsOf(item.id)).toEqual([]);
  });

  it('answers 404 for a count, a warehouse or a stock item that does not exist', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    const item = freshItem();
    expect(await failure(reconcile(missing))).toMatchObject({ status: 404, code: 'not_found' });
    expect(await failure(record(missing, 1))).toMatchObject({ status: 404 });
    expect(await failure(record(item.id, 1, undefined, missing))).toMatchObject({ status: 404 });
  });
});

describe('tolerance and approval', () => {
  it('flags a delta above the tolerance and moves nothing', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const flagged = await reconcile((await record(item.id, 16)).id);
    expect(flagged).toMatchObject({
      status: 'flagged',
      on_hand_as_of_count: 10,
      delta: 6,
      stock_movement_id: null,
      approved_by: null,
    });
    expect(await movementsOf(item.id)).toEqual([]);
    expect(await onHand(item.id)).toBe(10);
  });

  it('applies a delta exactly at the tolerance', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    expect((await reconcile((await record(item.id, 15)).id)).status).toBe('applied');
  });

  it('applies a flagged count on approval, with the approver on the row and in the audit row', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 16);
    await reconcile(count.id);
    const approved = await reconcile(count.id, true);
    expect(approved).toMatchObject({ status: 'applied', delta: 6, approved_by: operations.id });
    expect(approved.approved_at).not.toBeNull();
    expect((await movementsOf(item.id)).map((m) => m.delta)).toEqual([6]);
    expect(await onHand(item.id)).toBe(16);

    const audit = await db.owner.query<{ action: string; actor_id: string; request_id: string }>(
      `SELECT action, actor_id FROM audit_log WHERE entity_type = 'cycle_count' AND entity_id = $1
       ORDER BY created_at, action`,
      [count.id],
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual([
      'cycle_count.approve',
      'cycle_count.create',
      'cycle_count.flag',
    ]);
    expect(audit.rows.every((r) => r.actor_id === operations.id)).toBe(true);
  });

  it('recomputes under the lock at approval: what moved since the flag is in the final numbers', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 20, minutesAgo(60));
    const flagged = await reconcile(count.id);
    expect(flagged).toMatchObject({ status: 'flagged', on_hand_as_of_count: 10, delta: 10 });
    // 4 units are received after the flag (a movement, as the inventory module would write it): on-hand as of
    // the count is still 10 (14 now minus the 4 since), and the delta lands on top of the receipt
    await move(item.id, 4);
    // and the shelf's row itself changes by 1 with no ledger row (fixture): only a fresh read can know
    await setOnHand(item.id, EU, 15);
    const approved = await reconcile(count.id, true);
    expect(approved).toMatchObject({ status: 'applied', on_hand_as_of_count: 11, delta: 9 });
    expect(await onHand(item.id)).toBe(24);
  });

  it('flags every non-zero discrepancy when the tolerance is unset or malformed', async () => {
    for (const value of [undefined, 'five', -2]) {
      await setTolerance(value);
      const item = freshItem();
      await setOnHand(item.id, EU, 10);
      expect((await reconcile((await record(item.id, 11)).id)).status).toBe('flagged');
    }
  });
});

describe('the delta is against on-hand as of the count', () => {
  it('a count at T, a shipment after T, reconciled later: on-hand = counted − shipped', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 12);
    const count = await record(item.id, 10, minutesAgo(600)); // counted 10 where the system said 12
    // 3 units ship after the count
    await move(item.id, -3);
    expect(await onHand(item.id)).toBe(9);
    const applied = await reconcile(count.id);
    expect(applied).toMatchObject({ status: 'applied', on_hand_as_of_count: 12, delta: -2 });
    expect(await onHand(item.id)).toBe(7); // 10 counted − 3 shipped, not 10
  });

  it('refuses a count in the future (422)', async () => {
    const item = freshItem();
    expect(await failure(record(item.id, 5, new Date(Date.now() + 3_600_000)))).toEqual({
      status: 422,
      code: 'validation_error',
      details: { field: 'counted_at' },
    });
  });

  it('refuses an older count once a later one is applied: at reconcile (409 superseded)', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const older = await record(item.id, 8, minutesAgo(120));
    const later = await record(item.id, 12, minutesAgo(30));
    await reconcile(later.id);
    expect(await onHand(item.id)).toBe(12);

    expect(await failure(reconcile(older.id))).toEqual({
      status: 409,
      code: 'conflict',
      details: { reason: 'superseded', applied_cycle_count_id: later.id },
    });
    expect(await failure(reconcile(older.id, true))).toMatchObject({ status: 409 });
    expect(await onHand(item.id)).toBe(12);
    expect(await movementsOf(item.id)).toHaveLength(1);
  });

  it('refuses to record a count older than an applied one (409 superseded)', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const later = await record(item.id, 12, minutesAgo(30));
    await reconcile(later.id);
    expect(await failure(record(item.id, 8, minutesAgo(120)))).toMatchObject({
      status: 409,
      details: { reason: 'superseded' },
    });
    // a newer count is fine, and so is the same shelf in another warehouse
    expect((await record(item.id, 12)).status).toBe('recorded');
    expect((await record(item.id, 3, minutesAgo(120), US)).status).toBe('recorded');
  });
});

describe('several counts of one shelf', () => {
  const adjustments = async (item: string) =>
    (await movementsOf(item)).filter((m) => m.reason === 'cycle_count').map((m) => m.delta);

  beforeEach(async () => {
    await setTolerance(100);
  });

  it('A applied, then B: the adjustment for A is not "a movement since B"', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10); // the books say 10; 8 are on the shelf
    const countA = await record(item.id, 8, minutesAgo(120));
    const countB = await record(item.id, 8, minutesAgo(60));
    expect(await reconcile(countA.id)).toMatchObject({ status: 'applied', delta: -2 });
    expect(await onHand(item.id)).toBe(8);
    expect(await reconcile(countB.id)).toMatchObject({
      status: 'applied',
      on_hand_as_of_count: 8,
      delta: 0,
      stock_movement_id: null,
    });
    expect(await onHand(item.id)).toBe(8);
    expect(await adjustments(item.id)).toEqual([-2]);
  });

  it('A flagged, B taken, A approved, B reconciled: the discrepancy is applied once', async () => {
    await setTolerance(1);
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const countA = await record(item.id, 8, minutesAgo(120));
    expect((await reconcile(countA.id)).status).toBe('flagged');
    const countB = await record(item.id, 8, minutesAgo(60));
    expect(await reconcile(countA.id, true)).toMatchObject({ status: 'applied', delta: -2 });
    expect(await reconcile(countB.id)).toMatchObject({ status: 'applied', delta: 0 });
    expect(await onHand(item.id)).toBe(8);
    expect(await adjustments(item.id)).toEqual([-2]);
  });

  it('B applied, then A: the older count is superseded and nothing moves again', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const countA = await record(item.id, 8, minutesAgo(120));
    const countB = await record(item.id, 8, minutesAgo(60));
    expect(await reconcile(countB.id)).toMatchObject({ status: 'applied', delta: -2 });
    expect(await failure(reconcile(countA.id, true))).toMatchObject({
      status: 409,
      details: { reason: 'superseded', applied_cycle_count_id: countB.id },
    });
    expect(await onHand(item.id)).toBe(8);
    expect(await adjustments(item.id)).toEqual([-2]);
  });

  // The books say 10 where 8 lie. Count A = 8; 1 ships; count B = 7; 5 are received; count C = 12.
  // Whatever the order of reconciliation, the books must end at 12 — the newest count's truth — once.
  const threeCounts = async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const countA = await record(item.id, 8, minutesAgo(180));
    await move(item.id, -1, minutesAgo(150));
    const countB = await record(item.id, 7, minutesAgo(120));
    await move(item.id, 5, minutesAgo(90));
    const countC = await record(item.id, 12, minutesAgo(60));
    expect(await onHand(item.id)).toBe(14);
    return { item, countA, countB, countC };
  };

  it('three interleaved counts, oldest first: A, B, C', async () => {
    const { item, countA, countB, countC } = await threeCounts();
    expect(await reconcile(countA.id)).toMatchObject({ on_hand_as_of_count: 10, delta: -2 });
    expect(await reconcile(countB.id)).toMatchObject({ on_hand_as_of_count: 7, delta: 0 });
    expect(await reconcile(countC.id)).toMatchObject({ on_hand_as_of_count: 12, delta: 0 });
    expect(await onHand(item.id)).toBe(12);
    expect(await adjustments(item.id)).toEqual([-2]);
  });

  it('three interleaved counts, newest first: C, then A and B are superseded', async () => {
    const { item, countA, countB, countC } = await threeCounts();
    expect(await reconcile(countC.id)).toMatchObject({ on_hand_as_of_count: 14, delta: -2 });
    expect(await failure(reconcile(countA.id))).toMatchObject({ status: 409 });
    expect(await failure(reconcile(countB.id))).toMatchObject({ status: 409 });
    expect(await onHand(item.id)).toBe(12);
    expect(await adjustments(item.id)).toEqual([-2]);
  });

  it('three interleaved counts, middle first: B, C, then A is superseded', async () => {
    const { item, countA, countB, countC } = await threeCounts();
    expect(await reconcile(countB.id)).toMatchObject({ on_hand_as_of_count: 9, delta: -2 });
    expect(await reconcile(countC.id)).toMatchObject({ on_hand_as_of_count: 12, delta: 0 });
    expect(await failure(reconcile(countA.id))).toMatchObject({ status: 409 });
    expect(await onHand(item.id)).toBe(12);
    expect(await adjustments(item.id)).toEqual([-2]);
  });

  it('a newer count that finds a NEW discrepancy still applies its own delta on top', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const countA = await record(item.id, 8, minutesAgo(120));
    const countB = await record(item.id, 5, minutesAgo(60)); // three more went missing between the counts
    await reconcile(countA.id);
    expect(await reconcile(countB.id)).toMatchObject({ on_hand_as_of_count: 8, delta: -3 });
    expect(await onHand(item.id)).toBe(5);
    expect(await adjustments(item.id)).toEqual([-2, -3]);
  });

  it('a cycle_count movement entered by hand after the count supersedes it (409), at reconcile and at record', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 8, minutesAgo(120));
    // somebody corrects the books by hand later, with no count record behind it
    await move(item.id, -1, minutesAgo(60), EU, 'cycle_count');
    const refused = await failure(reconcile(count.id, true));
    expect(refused).toMatchObject({
      status: 409,
      code: 'conflict',
      details: { reason: 'superseded' },
    });
    expect(refused!.details).toHaveProperty('stock_movement_id');
    expect(await onHand(item.id)).toBe(9);
    expect(await failure(record(item.id, 8, minutesAgo(90)))).toMatchObject({
      status: 409,
      details: { reason: 'superseded' },
    });
    const plan = await planOpenCounts(hq, { organizationId: ORG, warehouseCode: 'wh-eu' });
    expect(plan.counts.find((c) => c.cycleCountId === count.id)?.superseded).toBe(true);
    // a count taken after the hand correction is not affected
    const later = await record(item.id, 9, minutesAgo(30));
    expect(await reconcile(later.id)).toMatchObject({ status: 'applied', delta: 0 });
  });

  it('a hand correction BEFORE the count does not supersede it', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    await move(item.id, -1, minutesAgo(120), EU, 'cycle_count');
    const count = await record(item.id, 7, minutesAgo(60));
    expect(await reconcile(count.id)).toMatchObject({ status: 'applied', delta: -2 });
    expect(await onHand(item.id)).toBe(7);
  });

  it('marks the older of two open counts in the plan', async () => {
    const item = freshItem();
    await setOnHand(item.id, US, 10);
    const older = await record(item.id, 8, minutesAgo(120), US);
    const newer = await record(item.id, 8, minutesAgo(60), US);
    const plan = await planOpenCounts(hq, { organizationId: ORG, warehouseCode: 'wh-us' });
    expect(plan.counts.find((c) => c.cycleCountId === older.id)?.newerOpenCount).toBe(true);
    expect(plan.counts.find((c) => c.cycleCountId === newer.id)?.newerOpenCount).toBe(false);
  });
});

describe('a shelf that has never held the item', () => {
  /** Fixture (owner role): the item has no pool row in the US warehouse at all. */
  const emptyShelf = async () => {
    const item = freshItem();
    await db.owner.query(
      `DELETE FROM inventory_level WHERE stock_item_id = $1 AND warehouse_id = $2`,
      [item.id, US],
    );
    return item;
  };

  beforeEach(async () => {
    await setTolerance(100);
  });

  it('creates the pool row before reading it, then applies the count', async () => {
    const item = await emptyShelf();
    const count = await record(item.id, 5, minutesAgo(30), US);
    expect(await reconcile(count.id)).toMatchObject({
      status: 'applied',
      on_hand_as_of_count: 0,
      delta: 5,
    });
    expect(await onHand(item.id, US)).toBe(5);
  });

  // What this proves is the NUMBERS: whichever transaction gets the shelf first, the receipt is counted once.
  // That the reconciliation takes the pool row (created, then FOR UPDATE through the inventory module's
  // ensureLevel) before it reads it is verified statically in cycle-counts.ts (readShelf); a test cannot force
  // the interleaving that would expose a missing lock, it can only fail to observe one.
  it('counts a first receipt racing the reconciliation exactly once', async () => {
    for (let round = 0; round < 5; round++) {
      const item = await emptyShelf();
      const count = await record(item.id, 5, minutesAgo(30), US);
      await Promise.all([reconcile(count.id), move(item.id, 7, undefined, US)]);
      // 5 counted, then 7 received: 12 whichever of the two got the shelf first
      expect(await onHand(item.id, US)).toBe(12);
      expect((await movementsOf(item.id, US)).map((m) => m.delta).sort()).toEqual([5, 7]);
    }
  });
});

describe('listing', () => {
  it('filters by stock item and status, newest count first', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const first = await record(item.id, 10, minutesAgo(90));
    const second = await record(item.id, 30, minutesAgo(10));
    await reconcile(second.id); // flagged
    const all = await listCycleCounts(hq, { stockItemId: item.id, page: 1, limit: 20 });
    expect(all.total).toBe(2);
    expect(all.items.map((c) => c.id)).toEqual([second.id, first.id]);
    const flagged = await listCycleCounts(hq, {
      stockItemId: item.id,
      status: 'flagged',
      page: 1,
      limit: 20,
    });
    expect(flagged.items.map((c) => c.id)).toEqual([second.id]);
  });
});

describe('the dry-run CLI', () => {
  it('prints the plan and writes nothing', async () => {
    const snapshot = async () =>
      (
        await db.owner.query<{ counts: string; movements: string; on_hand: string }>(
          `SELECT (SELECT md5(string_agg(c::text, '|' ORDER BY id)) FROM cycle_count c) AS counts,
                  (SELECT count(*)::text FROM stock_movement) AS movements,
                  (SELECT sum(on_hand)::text FROM inventory_level) AS on_hand`,
        )
      ).rows[0];
    const apply = freshItem();
    const flag = freshItem();
    await setOnHand(apply.id, US, 10);
    await setOnHand(flag.id, US, 10);
    await record(apply.id, 12, undefined, US);
    await record(flag.id, 40, undefined, US);

    const before = await snapshot();
    const lines: string[] = [];
    const code = await runReconcile(['--warehouse', 'wh-us', '--dry-run'], {
      client: hq,
      organizationId: ORG,
      out: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines[0]).toContain('nothing is written');
    expect(lines.find((l) => l.startsWith(apply.sku))).toContain('APPLY one movement of +2');
    expect(lines.find((l) => l.startsWith(flag.sku))).toContain('FLAG for approval');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to run without --dry-run, and without a warehouse', async () => {
    const run = (argv: string[]) =>
      runReconcile(argv, { client: hq, organizationId: ORG, out: () => {} });
    expect(await run(['--warehouse', 'wh-us'])).toBe(2);
    expect(await run(['--dry-run'])).toBe(2);
    expect(await run(['--nonsense'])).toBe(2);
  });

  it('marks a superseded count in the plan', async () => {
    const item = freshItem();
    await setOnHand(item.id, US, 10);
    const older = await record(item.id, 8, minutesAgo(120), US);
    await reconcile((await record(item.id, 10, minutesAgo(30), US)).id);
    const plan = await planOpenCounts(hq, { organizationId: ORG, warehouseCode: 'wh-us' });
    expect(plan.counts.find((c) => c.cycleCountId === older.id)?.superseded).toBe(true);
  });
});

describe('WMS pull (in-memory adapter)', () => {
  it('answers not_found for a warehouse that does not exist', async () => {
    expect(
      await failure(
        recordWmsCounts(
          hq,
          { organizationId: ORG, warehouseCode: 'wh-nowhere' },
          createMemoryWmsAdapter(),
        ),
      ),
    ).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('records what the WMS counted as wms counts with no counter, and reports unknown skus', async () => {
    const item = freshItem();
    const wms = createMemoryWmsAdapter();
    wms.setCounts('wh-eu', [
      { sku: item.sku, countedQuantity: 9, countedAt: minutesAgo(5) },
      { sku: 'no-such-sku-anywhere', countedQuantity: 1, countedAt: minutesAgo(5) },
    ]);
    const pulled = await recordWmsCounts(hq, { organizationId: ORG, warehouseCode: 'wh-eu' }, wms);
    expect(pulled.unknownSkus).toEqual(['no-such-sku-anywhere']);
    expect(pulled.recorded).toHaveLength(1);
    expect(pulled.recorded[0]).toMatchObject({
      stock_item_id: item.id,
      counted_quantity: 9,
      counted_by: null,
      source: 'wms',
      status: 'recorded',
    });
    expect(await wms.pullCounts('wh-us')).toEqual([]);
  });
});

describe('the router: permissions and the wire shape', () => {
  let app: express.Express;
  const as = (subject: string) => ({
    get: (path: string) => request(app).get(path).set('Authorization', `Bearer dev:${subject}`),
    post: (path: string, body?: object) =>
      request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  });

  beforeAll(() => {
    app = express();
    mountCoreMiddleware(app, new DevTokenVerifier());
    app.use(cycleCountsAdminRouter());
    app.use(coreErrorHandler);
  });

  it('lets operations on HQ count, reconcile, approve and list', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const created = await as('seed-operations').post('/admin/cycle-counts', {
      warehouse_id: EU,
      stock_item_id: item.id,
      counted_quantity: 30,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'recorded', counted_by: operations.id });

    const flagged = await as('seed-operations').post(
      `/admin/cycle-counts/${created.body.id}/reconcile`,
    );
    expect(flagged.status).toBe(200);
    expect(flagged.body.status).toBe('flagged');

    const approved = await as('seed-operations').post(
      `/admin/cycle-counts/${created.body.id}/reconcile`,
      { approve: true },
    );
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'applied',
      delta: 20,
      approved_by: operations.id,
    });

    const listed = await as('seed-operations').get(
      `/admin/cycle-counts?stock_item_id=${item.id}&status=applied`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ page: 1, total: 1 });
    expect(Object.keys(listed.body.items[0]).sort()).toEqual(
      [
        'approved_at',
        'approved_by',
        'counted_at',
        'counted_by',
        'counted_quantity',
        'delta',
        'id',
        'note',
        'on_hand_as_of_count',
        'reconciled_at',
        'sku',
        'source',
        'status',
        'stock_item_id',
        'stock_movement_id',
        'warehouse_id',
      ].sort(),
    );
  });

  it('answers 403 to a store admin on every operation', async () => {
    const item = freshItem();
    const count = await record(item.id, 1);
    const storeAdmin = as('seed-store-admin');
    expect((await storeAdmin.get('/admin/cycle-counts')).status).toBe(403);
    expect(
      (
        await storeAdmin.post('/admin/cycle-counts', {
          warehouse_id: EU,
          stock_item_id: item.id,
          counted_quantity: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (await storeAdmin.post(`/admin/cycle-counts/${count.id}/reconcile`, { approve: true }))
        .status,
    ).toBe(403);
    expect((await reconcile(count.id)).approved_by).toBeNull();
  });

  it('answers 401 without a token', async () => {
    expect((await request(app).get('/admin/cycle-counts')).status).toBe(401);
  });

  it('answers 400 to a malformed body, id or query', async () => {
    const ops = as('seed-operations');
    const item = freshItem();
    const bad = await ops.post('/admin/cycle-counts', {
      warehouse_id: 'nope',
      stock_item_id: item.id,
      counted_quantity: -1,
      extra: true,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('validation_error');
    expect((await ops.post('/admin/cycle-counts/not-a-uuid/reconcile')).status).toBe(400);
    expect((await ops.get('/admin/cycle-counts?status=open')).status).toBe(400);
    const count = await record(item.id, 1);
    expect(
      (await ops.post(`/admin/cycle-counts/${count.id}/reconcile`, { approve: 'yes' })).status,
    ).toBe(400);
  });

  it("passes the inventory module's refusal through: on-hand would go negative → 409 conflict", async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 1, minutesAgo(60)); // 1 counted …
    await move(item.id, -3); // … then 3 shipped: the books cannot say −2
    const refused = await as('seed-operations').post(`/admin/cycle-counts/${count.id}/reconcile`, {
      approve: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('conflict');
    expect(await onHand(item.id)).toBe(7);
    const after = await listCycleCounts(hq, { stockItemId: item.id, page: 1, limit: 5 });
    expect(after.items[0]).toMatchObject({ status: 'recorded', stock_movement_id: null });
  });

  it('answers 422 to a count in the future and 409 superseded over the wire', async () => {
    const ops = as('seed-operations');
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const future = await ops.post('/admin/cycle-counts', {
      warehouse_id: EU,
      stock_item_id: item.id,
      counted_quantity: 1,
      counted_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(future.status).toBe(422);
    expect(future.body).toMatchObject({
      code: 'validation_error',
      details: { field: 'counted_at' },
    });

    const older = await record(item.id, 8, minutesAgo(120));
    await reconcile((await record(item.id, 10, minutesAgo(30))).id);
    const superseded = await ops.post(`/admin/cycle-counts/${older.id}/reconcile`);
    expect(superseded.status).toBe(409);
    expect(superseded.body).toMatchObject({ code: 'conflict', details: { reason: 'superseded' } });
  });
});

describe('the movement and its event', () => {
  it('writes one store-less movement and one stock.moved v2', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 13);
    const applied = await reconcile(count.id);
    expect(applied).toMatchObject({ status: 'applied', delta: 3 });
    expect(await onHand(item.id)).toBe(13);
    expect(await movementsOf(item.id)).toEqual([
      {
        id: applied.stock_movement_id,
        delta: 3,
        reason: 'cycle_count',
        reference_type: 'cycle_count',
        reference_id: count.id,
        store_id: null,
      },
    ]);
    const events = await db.owner.query<{
      version: number;
      store_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT version, store_id, payload FROM outbox WHERE topic = 'stock.moved' AND aggregate_id = $1`,
      [applied.stock_movement_id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ version: 2, store_id: null });
    expect(events.rows[0]!.payload).toMatchObject({
      stock_movement_id: applied.stock_movement_id,
      stock_item_id: item.id,
      sku: item.sku,
      warehouse_id: EU,
      delta: 3,
      reason: 'cycle_count',
      on_hand_after: 13,
    });
    expect(events.rows[0]!.payload).not.toHaveProperty('variant_id');
    expect(events.rows[0]!.payload).not.toHaveProperty('store_id');
  });

  it('is a no-op the second time: still one movement, one event', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 12);
    const first = await reconcile(count.id);
    expect(await reconcile(count.id)).toEqual(first);
    expect(await movementsOf(item.id)).toHaveLength(1);
    expect(
      (
        await db.owner.query(
          `SELECT 1 FROM outbox WHERE topic = 'stock.moved' AND aggregate_id = $1`,
          [first.stock_movement_id],
        )
      ).rowCount,
    ).toBe(1);
  });
});

describe('the reconcile preview (previewCycleCountReconcile, GET …/reconcile-preview)', () => {
  let app: express.Express;
  const get = (path: string, subject = 'seed-operations') =>
    request(app).get(path).set('Authorization', `Bearer dev:${subject}`);
  const preview = (id: string, subject?: string) =>
    get(`/admin/cycle-counts/${id}/reconcile-preview`, subject);
  const matchesSchema = loadSpec('admin-api.yaml').schema('CycleCountPreview');

  /** Everything a preview could possibly write to. */
  const snapshot = async () =>
    (
      await db.owner.query(
        `SELECT (SELECT md5(coalesce(string_agg(c::text, '|' ORDER BY id), '')) FROM cycle_count c) AS counts,
                (SELECT count(*)::text FROM stock_movement) AS movements,
                (SELECT count(*)::text FROM outbox) AS events,
                (SELECT count(*)::text FROM audit_log) AS audit,
                (SELECT md5(string_agg(il::text, '|' ORDER BY id)) FROM inventory_level il) AS levels`,
      )
    ).rows[0];

  beforeAll(() => {
    app = express();
    mountCoreMiddleware(app, new DevTokenVerifier());
    app.use(cycleCountsAdminRouter());
    app.use(coreErrorHandler);
  });

  it('previews a flagged count and writes nothing at all', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 16);
    const before = await snapshot();
    const res = await preview(count.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      cycle_count_id: count.id,
      on_hand_as_of_count: 10,
      delta: 6,
      count_tolerance: 5,
      would_status: 'flagged',
    });
    expect(matchesSchema(res.body)).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('shows the delta reconcile then applies, when nothing moved in between', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 13, minutesAgo(60));
    await move(item.id, -2); // shipped after the count: a physical movement since
    const previewed = await preview(count.id);
    expect(previewed.body).toMatchObject({
      on_hand_as_of_count: 10,
      delta: 3,
      would_status: 'applied',
    });
    const applied = await reconcile(count.id);
    expect(applied).toMatchObject({
      status: 'applied',
      on_hand_as_of_count: previewed.body.on_hand_as_of_count,
      delta: previewed.body.delta,
    });
  });

  it('answers an applied count with its stored values', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const count = await record(item.id, 12);
    await reconcile(count.id);
    await setOnHand(item.id, EU, 30); // the shelf moves on; the applied count does not
    expect((await preview(count.id)).body).toMatchObject({
      on_hand_as_of_count: 10,
      delta: 2,
      would_status: 'applied',
    });
  });

  it('answers 409 superseded like reconcile', async () => {
    const item = freshItem();
    await setOnHand(item.id, EU, 10);
    const older = await record(item.id, 8, minutesAgo(120));
    const later = await record(item.id, 9, minutesAgo(30));
    await reconcile(later.id);
    const res = await preview(older.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'conflict',
      details: { reason: 'superseded', applied_cycle_count_id: later.id },
    });
  });

  it('reads a shelf that has never held the item as 0 and does not create its pool row', async () => {
    const item = freshItem();
    await db.owner.query(
      `DELETE FROM inventory_level WHERE stock_item_id = $1 AND warehouse_id = $2`,
      [item.id, US],
    );
    const count = await record(item.id, 4, undefined, US);
    expect((await preview(count.id)).body).toMatchObject({
      on_hand_as_of_count: 0,
      delta: 4,
      would_status: 'applied',
    });
    const rows = await db.owner.query(
      `SELECT 1 FROM inventory_level WHERE stock_item_id = $1 AND warehouse_id = $2`,
      [item.id, US],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('answers 404 for a count in a deactivated warehouse, an unknown count; 400 for a malformed id', async () => {
    const item = freshItem();
    const count = await record(item.id, 1, undefined, US);
    await db.owner.query(`UPDATE warehouse SET is_active = false WHERE id = $1`, [US]);
    try {
      expect((await preview(count.id)).status).toBe(404);
    } finally {
      await db.owner.query(`UPDATE warehouse SET is_active = true WHERE id = $1`, [US]);
    }
    expect((await preview('99999999-9999-4999-8999-999999999999')).status).toBe(404);
    expect((await get('/admin/cycle-counts/not-a-uuid/reconcile-preview')).status).toBe(400);
  });

  it('answers 403 to a store admin and 401 without a token', async () => {
    const item = freshItem();
    const count = await record(item.id, 1);
    expect((await preview(count.id, 'seed-store-admin')).status).toBe(403);
    expect(
      (await request(app).get(`/admin/cycle-counts/${count.id}/reconcile-preview`)).status,
    ).toBe(401);
  });
});
