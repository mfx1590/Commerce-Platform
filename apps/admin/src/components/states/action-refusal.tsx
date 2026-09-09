'use client';

import { FormError } from '@/components/form/fields';
import { ApiStatePanel } from '@/components/states/state-panel';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';

/**
 * What a mutation shows when it fails.
 *
 * A `400` names a field, so it belongs under that input and this renders nothing extra. A `401` or
 * `403` is different in kind: the save was refused because of *who you are*, and a one-line red
 * message under a Save button is the wrong shape for that — it reads as "try again" when nothing
 * about trying again will help. Those get the same `ApiStatePanel` the screen itself would show, so
 * "you need `store_staff` on `store:brand-a`" looks identical whether it came from opening the page
 * or from pressing Save.
 *
 * The alternative — leaving refusals as `formError` text — is how a mutation quietly becomes a
 * no-op: the button springs back, a grey line appears somewhere, and nothing says the account simply
 * may not do this.
 */
export function ActionRefusal({
  refusal,
  message,
}: {
  refusal?: ActionRefusalInfo | undefined;
  message: string | null;
}) {
  if (refusal !== undefined) {
    return <ApiStatePanel status={refusal.status} error={refusal.error} />;
  }
  return <FormError message={message} />;
}
