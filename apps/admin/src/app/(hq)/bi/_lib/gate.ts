/**
 * The BI route handlers' gate (#900): the principal and the section predicate, checked before any
 * Admin API call — the same pattern as the audit export (#896).
 *
 * A route handler is not a screen. The section guard that hides `/bi` from a principal without the
 * section's relation does nothing for a URL typed into the address bar or a crafted `fetch`, and the
 * BI operations themselves are only `viewer` on a store (scoped to the principal's stores). So each
 * BI route asks, first, the **same** `visibleHqSections` / `visibleStoreSections` predicate the
 * pages use, from the same catalogue entry: no principal is the failed `/admin/me` status (401, or
 * a fail-closed 503 stays a 503; no answer at all is 502), a principal without the section is 403,
 * and neither reaches the API — so HQ Ask cannot spend AI tokens for a principal who is not an
 * analyst.
 */
import 'server-only';

import type { AdminError } from '@/lib/api/admin-client';
import { visibleHqSections, visibleStoreSections } from '@/lib/nav/navigation';
import { HQ_SECTIONS, STORE_SECTIONS } from '@/lib/nav/sections';
import { loadPrincipal } from '@/lib/principal';

const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The relations the two `bi` catalogue entries ask for, so the gate and the pages cannot drift. */
const HQ_REQUIRED = HQ_SECTIONS.find((section) => section.id === 'bi')?.requires[0] ?? 'analyst';
const STORE_REQUIRED =
  STORE_SECTIONS.find((section) => section.id === 'bi')?.requires[0] ?? 'viewer';

const json = (status: number, error: AdminError) =>
  new Response(JSON.stringify(error), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function forbidden(relation: string, object: string): Response {
  return json(403, {
    code: 'forbidden',
    message: `You need the ${relation} relation on ${object} to use BI here.`,
    details: { relation, object },
  });
}

/**
 * Null when the principal may use BI — HQ BI when `storeId` is undefined, else the BI of that
 * store — otherwise the refusal to return, before any API call.
 */
export async function refuseUnlessBi(storeId?: string): Promise<Response | null> {
  if (storeId !== undefined && !STORE_ID.test(storeId)) {
    return json(404, { code: 'not_found', message: 'That store is not valid.' });
  }
  const principal = await loadPrincipal();
  if (!principal.ok) {
    return json(principal.status === 0 ? 502 : principal.status, principal.error);
  }
  if (storeId === undefined) {
    return visibleHqSections(principal.data).some((section) => section.id === 'bi')
      ? null
      : forbidden(HQ_REQUIRED, 'organization:hq');
  }
  return visibleStoreSections(principal.data, storeId).some((section) => section.id === 'bi')
    ? null
    : forbidden(STORE_REQUIRED, `store:${storeId}`);
}
