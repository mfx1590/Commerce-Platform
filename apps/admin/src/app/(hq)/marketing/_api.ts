/**
 * Organization-level marketing wrappers (#149).
 *
 * Separate from the store section's `_api.ts` because these are a different scope, not a different screen:
 * `/admin/marketing/**` is `organization:hq`, read by `analyst` and written by `owner`. Window 4's
 * `src/lib/api/admin.ts` stays untouched; this uses their `adminCall` transport and their operationId
 * convention.
 */

import 'server-only';

import { adminCall } from '@/lib/api/admin';
import {
  buildPath,
  type AdminComponents,
  type AdminResponse,
  type ApiResult,
} from '@/lib/api/admin-client';

export async function getMarketingDashboard(query: {
  from: string;
  to: string;
}): Promise<ApiResult<AdminResponse<'getMarketingDashboard'>>> {
  return adminCall<'getMarketingDashboard'>({
    path: '/admin/marketing/dashboard',
    query: { from: query.from, to: query.to },
  });
}

export async function listSegmentTemplates(
  query: Record<string, string | number> = {},
): Promise<ApiResult<AdminResponse<'listSegmentTemplates'>>> {
  return adminCall<'listSegmentTemplates'>({ path: '/admin/marketing/segment-templates', query });
}

export async function getSegmentTemplate(
  templateId: string,
): Promise<ApiResult<AdminResponse<'getSegmentTemplate'>>> {
  return adminCall<'getSegmentTemplate'>({
    path: buildPath('/admin/marketing/segment-templates/{templateId}', { templateId }),
  });
}

export async function createSegmentTemplate(
  body: AdminComponents['SegmentInput'],
): Promise<ApiResult<AdminResponse<'createSegmentTemplate'>>> {
  return adminCall<'createSegmentTemplate'>({
    path: '/admin/marketing/segment-templates',
    method: 'POST',
    body,
  });
}
