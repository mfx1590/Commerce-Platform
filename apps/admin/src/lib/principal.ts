/**
 * One fetch of `GET /admin/me` per request, shared by the layouts and pages that render below it.
 *
 * `cache()` deduplicates within a single render pass, so the HQ layout, the store layout and a page
 * can each ask for the principal without three round-trips to the Admin API.
 */

import 'server-only';

import { cache } from 'react';
import { getMe } from './api/admin';
import type { AdminResponse, ApiResult } from './api/admin-client';

export type PrincipalResult = ApiResult<AdminResponse<'getMe'>>;

export const loadPrincipal = cache(async (): Promise<PrincipalResult> => getMe());
