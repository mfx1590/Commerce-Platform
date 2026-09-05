/**
 * Server-side entry point to the Admin API: binds the transport to the configured base URL and the
 * signed-in principal's access token.
 *
 * Adding a screen means adding a typed wrapper here, never calling `fetch` from a component.
 */

import 'server-only';

import type { operations } from '@platform/contracts/admin';
import { env } from '../env';
import { getSession } from '../auth/current-session';
import type { AdminRequestOptions, AdminResponse, ApiResult } from './admin-client';
import { adminRequest } from './admin-client';

type CallOptions = Omit<AdminRequestOptions, 'baseUrl' | 'accessToken'>;

/** Every Admin API call goes through here, so the token is attached in exactly one place. */
export async function adminCall<K extends keyof operations>(
  options: CallOptions,
): Promise<ApiResult<AdminResponse<K>>> {
  const session = await getSession();
  return adminRequest<K>({
    ...options,
    baseUrl: env.adminApiUrl,
    accessToken: session?.accessToken,
  });
}

/**
 * The principal behind the current session: user, organization, organization-level relations and
 * the stores it may act on. This drives the whole navigation (issue #25) and the store switcher.
 */
export async function getMe(): Promise<ApiResult<AdminResponse<'getMe'>>> {
  return adminCall<'getMe'>({ path: '/admin/me' });
}

/** The store registry (HQ). `sort`/`order` are withheld until CONTRACT CHANGE #56 lands. */
export async function listStores(
  query: Record<string, string | number>,
): Promise<ApiResult<AdminResponse<'listStores'>>> {
  return adminCall<'listStores'>({ path: '/admin/stores', query });
}
