import { NextResponse } from 'next/server';
import { getAccessToken } from '@/lib/auth/session';
import { isStoreApiError, storeApi } from '@/lib/store-api';

/**
 * Download of one data export (#472): `GET /account/exports/{exportId}` fetches the bundle from the Store API
 * (`getMyExport`) with the customer's session token — which never reaches the browser — and streams it back as a
 * JSON attachment. Signed-out → 401 (the account page is where the link lives, behind `requireCustomerToken`);
 * the Store API's 404 / 410 pass through with a short plain-text body. Never cached.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ exportId: string }> },
): Promise<Response> {
  const { exportId } = await params;
  if (!UUID.test(exportId)) return new NextResponse('Not found', { status: 404 });
  const token = await getAccessToken();
  if (token === null) return new NextResponse('Sign in to download your data', { status: 401 });
  try {
    const bundle = await storeApi().request<Record<string, unknown>>(
      'GET',
      `/store/customers/me/exports/${exportId}`,
      { options: { token, cache: 'no-store' } },
    );
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="customer-export-${exportId}.json"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    if (isStoreApiError(error) && (error.status === 404 || error.status === 410)) {
      return new NextResponse(error.status === 410 ? 'This export has expired' : 'Not found', {
        status: error.status,
      });
    }
    throw error;
  }
}
