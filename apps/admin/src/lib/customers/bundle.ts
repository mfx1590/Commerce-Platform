import 'server-only';

import { getSession } from '@/lib/auth/current-session';
import { env } from '@/lib/env';

/**
 * Fetching one GDPR export bundle, **without parsing it**.
 *
 * `getCustomerExport`'s 200 is the whole of one person's record (customer-export/v1), so it is read
 * as text and passed straight through to the browser as an attachment. It is never `JSON.parse`d,
 * never held as an object, never rendered and never logged — the admin is a conduit here, not a
 * reader. That is why this does not go through `adminCall`, which parses every payload; it follows
 * the same raw-fetch shape as `(hq)/bi/_api.ts`'s `queryMetricsCsv`.
 *
 * The caller's session token is attached **server-side**, so nothing authenticating is ever in a
 * URL, in browser history or in a referrer.
 */
export interface BundleFetch {
  ok: boolean;
  status: number;
  /** The bundle as it came, or the API's error payload. Never inspected here. */
  body: string;
  contentType: string;
}

export async function fetchExportBundle(
  storeId: string,
  customerId: string,
  exportId: string,
): Promise<BundleFetch> {
  const session = await getSession();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (session?.accessToken) headers['authorization'] = `Bearer ${session.accessToken}`;

  const url =
    `${env.adminApiUrl}/admin/stores/${encodeURIComponent(storeId)}` +
    `/customers/${encodeURIComponent(customerId)}/exports/${encodeURIComponent(exportId)}`;

  let response: Response;
  try {
    response = await fetch(url, { headers, cache: 'no-store' });
  } catch {
    return {
      ok: false,
      status: 503,
      body: JSON.stringify({ code: 'unavailable', message: 'The Admin API did not answer' }),
      contentType: 'application/json',
    };
  }

  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type') ?? 'application/json',
  };
}
