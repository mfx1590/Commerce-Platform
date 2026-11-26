import { fetchExportBundle } from '@/lib/customers/bundle';
import { mayAdministerCustomer } from '@/lib/customers/permissions';
import type { AdminError } from '@/lib/api/admin-client';
import { loadPrincipal } from '@/lib/principal';

export const dynamic = 'force-dynamic';

const json = (status: number, error: AdminError) =>
  new Response(JSON.stringify(error), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

/**
 * Every upstream failure becomes one of OUR messages (#965 review).
 *
 * The first version forwarded the Admin API's own body and `content-type` for any non-410 failure.
 * That hands a reader bytes this handler never looked at, on a route whose success case is one
 * person's whole record: an upstream proxy's HTML error page, or anything else that happened to
 * come back, would be echoed to the browser under its own content type. There is nothing in an
 * upstream error body a store admin needs, so none of it crosses.
 *
 * A 503 from `fetchExportBundle` (it could not reach the API at all) lands in the same `502
 * unavailable` as any other unexpected status: from here both mean "the API did not answer
 * usefully", and the distinction is in the server's logs, not something to tell a browser.
 */
function upstreamFailure(status: number): Response {
  if (status === 404) {
    return json(404, { code: 'not_found', message: 'That export does not exist.' });
  }
  if (status === 401 || status === 403) {
    return json(status, {
      code: 'forbidden',
      message: 'The Admin API refused that export.',
    });
  }
  return json(502, { code: 'unavailable', message: 'The Admin API did not answer usefully.' });
}

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
    // Never `bundle.body` or `bundle.contentType`: see `upstreamFailure`.
    return upstreamFailure(bundle.status);
  }

  return new Response(bundle.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="customer-export-${exportId}.json"`,
      // Never cached anywhere: this is one person's whole record.
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      // The body is whatever the core built; nothing may re-type it as HTML or a script.
      'x-content-type-options': 'nosniff',
    },
  });
}
