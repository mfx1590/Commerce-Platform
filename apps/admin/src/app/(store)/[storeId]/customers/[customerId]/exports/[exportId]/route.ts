import { fetchExportBundle } from '@/lib/customers/bundle';
import { mayAdministerCustomer } from '@/lib/customers/permissions';
import type { AdminError } from '@/lib/api/admin-client';
import { loadPrincipal } from '@/lib/principal';

export const dynamic = 'force-dynamic';

const json = (status: number, error: AdminError) =>
  new Response(JSON.stringify(error), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hands over one GDPR export bundle (#870 item 4; the manager's decision after #962 — a
 * subject-access request cannot be answered without it).
 *
 * **Gated here, before any API call.** A route handler is not a screen: the section guard that
 * keeps `support` out of the export panel does nothing for a URL typed into the address bar, and
 * this response is one person's entire record. So the principal is resolved and
 * `store_admin on store:{storeId}` is required — the same relation `exportCustomer` and
 * `eraseCustomer` need — before anything is fetched. No session is 401; a failed `/admin/me`
 * forwards its own status, so a fail-closed 503 stays a 503; a reader without the relation is 403.
 * This is the #896 review's finding on `/audit/export`, applied before a reviewer has to find it.
 *
 * **The bundle is streamed, never read.** `fetchExportBundle` returns text and this hands it on
 * with `content-disposition: attachment`: nothing parses it, renders it or logs it. The session
 * token is attached server-side, so no credential appears in a URL — the only thing in the path is
 * the export's own uuid, which is not one.
 *
 * **410 is a state, not a failure.** An expired bundle is the normal end of its life, so it is
 * forwarded with a machine-readable code the panel turns into "expired, request a new export"
 * rather than a red error.
 *
 * Every download is audited by the core: `apps/core/src/modules/customers/export-delivery.ts`
 * writes `customer_export.download` (ids and a byte count) on the single path behind both the
 * customer's own download and this one. Verified, not assumed.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ storeId: string; customerId: string; exportId: string }> },
): Promise<Response> {
  const { storeId, customerId, exportId } = await params;
  if (!UUID.test(storeId) || !UUID.test(customerId) || !UUID.test(exportId)) {
    return json(400, { code: 'validation_error', message: 'That export is not valid.' });
  }

  const principal = await loadPrincipal();
  if (!principal.ok) {
    return json(principal.status === 0 ? 502 : principal.status, principal.error);
  }
  if (!mayAdministerCustomer(principal.data, storeId)) {
    return json(403, {
      code: 'forbidden',
      message: 'You need store_admin on this store to download a customer export.',
      details: { relation: 'store_admin', object: `store:${storeId}` },
    });
  }

  const bundle = await fetchExportBundle(storeId, customerId, exportId);

  if (!bundle.ok) {
    if (bundle.status === 410) {
      return json(410, {
        code: 'export_expired',
        message: 'That bundle has expired and been purged. Request a new export.',
      });
    }
    return new Response(bundle.body, {
      status: bundle.status === 0 ? 502 : bundle.status,
      headers: { 'content-type': bundle.contentType, 'cache-control': 'no-store' },
    });
  }

  return new Response(bundle.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="customer-export-${exportId}.json"`,
      // Never cached anywhere: this is one person's whole record.
      'cache-control': 'no-store, no-cache, must-revalidate, private',
    },
  });
}
