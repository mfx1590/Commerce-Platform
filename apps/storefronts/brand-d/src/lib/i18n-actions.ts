'use server';

import { revalidatePath } from 'next/cache';
import { getStoreOrNull } from './store';
import { resolveCurrency, writeCurrencyCookie } from './i18n';

/**
 * Currency choice. Validated against `store.currencies` before it is stored, so a hand-set cookie
 * can never reach `POST /store/carts` as an unsupported currency.
 */
export async function setCurrencyAction(formData: FormData): Promise<void> {
  const requested = formData.get('currency');
  const store = await getStoreOrNull();
  const currency = resolveCurrency(store, typeof requested === 'string' ? requested : undefined);

  await writeCurrencyCookie(currency);
  revalidatePath('/', 'layout');
}
