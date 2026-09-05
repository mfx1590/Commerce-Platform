'use server';

import { redirect } from 'next/navigation';
import { loadPrincipal } from '@/lib/principal';
import { canAccessStore } from '@/lib/nav/navigation';
import { rememberStoreId } from '@/lib/nav/selected-store';

/**
 * Store switcher submit handler.
 *
 * The chosen store is validated against the principal's own `stores[]` before it is remembered, so
 * a hand-edited form value cannot park a foreign store id in the cookie. Even if one slipped
 * through, the store layout re-validates on every request and the Admin API re-checks each
 * operation — this is the first of three gates, not the only one.
 */
export async function selectStore(formData: FormData): Promise<void> {
  const storeId = formData.get('storeId');
  const section = formData.get('section');
  if (typeof storeId !== 'string' || storeId === '') {
    redirect('/');
  }

  const result = await loadPrincipal();
  if (!result.ok || !canAccessStore(result.data, storeId)) {
    // Do not remember it, and do not pretend the switch worked: the store route renders the
    // 403 panel for this id.
    redirect(`/${encodeURIComponent(storeId)}`);
  }

  await rememberStoreId(storeId);
  const target = typeof section === 'string' && section !== '' ? section : 'catalog';
  redirect(`/${encodeURIComponent(storeId)}/${target}`);
}
