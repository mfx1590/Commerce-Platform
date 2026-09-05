/**
 * The remembered store, kept in a cookie and re-validated against `stores[]` on every request.
 *
 * The cookie is a *hint*, never an authority: `resolveSelectedStoreId` drops it the moment the
 * principal no longer holds the store, so revoking someone's access takes effect on their next
 * request instead of at cookie expiry.
 */

import 'server-only';

import { cookies } from 'next/headers';
import { isProduction } from '../env';

export const SELECTED_STORE_COOKIE = 'admin_selected_store';

const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export async function readRememberedStoreId(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SELECTED_STORE_COOKIE)?.value;
}

/** Only callable from a server action or route handler — server components cannot write cookies. */
export async function rememberStoreId(storeId: string): Promise<void> {
  const store = await cookies();
  store.set(SELECTED_STORE_COOKIE, storeId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}
