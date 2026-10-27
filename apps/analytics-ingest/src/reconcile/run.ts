// `reconcile`: pulls the ledger, runs every identity, renders one table per identity with the first 20 differences,
// and says whether the books agree. `ok` only when every difference of every identity is 0.
import type { ChClient } from '../clickhouse.js';
import type { AdminReportsClient, FinanceClient } from './clients.js';
import type { IdentityResult } from './diff.js';
import {
  assertWindow,
  checkBookings,
  checkCashLedger,
  checkCashReport,
  checkCopyIntegrity,
  checkLifetime,
  checkLineage,
  pullLedger,
  type ReconcileWindow,
} from './identities.js';

export interface ReconcileResult {
  window: ReconcileWindow;
  ok: boolean;
  ledger_lines: number;
  identities: IdentityResult[];
}

export async function reconcile(deps: {
  ch: ChClient;
  finance: FinanceClient;
  admin: AdminReportsClient;
  window: ReconcileWindow;
}): Promise<ReconcileResult> {
  const { ch, finance, admin, window: w } = deps;
  assertWindow(w);
  const pulled = await pullLedger(finance, ch, w);
  const identities = [
    await checkBookings(ch, admin, w),
    ...(await checkCopyIntegrity(ch, finance, pulled, w)),
    await checkLineage(ch, finance, pulled, w),
    await checkLifetime(ch, w),
    await checkCashReport(ch, admin, w),
    ...(await checkCashLedger(ch, finance, pulled, w)),
  ];
  return {
    window: w,
    ok: identities.every((i) => i.differences.length === 0),
    ledger_lines: pulled.lines.length,
    identities,
  };
}

export const SHOWN_DIFFERENCES = 20;

/** Plain text, one block per identity: what was compared, how many keys, the first 20 differences. */
export function renderReport(r: ReconcileResult): string {
  const out: string[] = [
    `reconcile ${r.window.from} … ${r.window.to} (to exclusive)${r.window.storeId ? ` store ${r.window.storeId}` : ''}: ${r.ok ? 'OK, every identity 0' : 'DIFFERENCES'}`,
    `ledger lines pulled: ${r.ledger_lines}`,
    '',
  ];
  for (const i of r.identities) {
    out.push(
      `${i.differences.length === 0 ? 'ok  ' : 'FAIL'} ${i.identity}: ${i.left} vs ${i.right}; ${i.keys} keys, ${i.differences.length} differences`,
    );
    for (const d of i.differences.slice(0, SHOWN_DIFFERENCES))
      out.push(`       ${d.key}  ${d.field}: ${d.left} vs ${d.right} (diff ${d.diff})`);
    if (i.differences.length > SHOWN_DIFFERENCES)
      out.push(`       … ${i.differences.length - SHOWN_DIFFERENCES} more`);
  }
  return out.join('\n');
}
