/**
 * Typed Admin API wrappers for the Marketing section (#149).
 *
 * `src/lib/api/admin.ts` is window 4's file, so these live here instead of being added to it — but they use
 * **their** transport (`adminCall`) and **their** convention: the type parameter is the contract `operationId`,
 * so `AdminResponse<'listCampaigns'>` is exactly the body `admin-api.yaml` documents and a contract rename
 * breaks the build rather than the screen.
 *
 * Nothing here throws on an HTTP error status: every call resolves to `ApiResult`, so a 401/403/404 renders as
 * a panel in place instead of taking down the route.
 */

import 'server-only';

import { adminCall } from '@/lib/api/admin';
import {
  buildPath,
  type AdminComponents,
  type AdminResponse,
  type ApiResult,
} from '@/lib/api/admin-client';

type Query = Record<string, string | number>;

const STORE = '/admin/stores/{storeId}/marketing';

// ---------------------------------------------------------------------------- campaigns

export async function listCampaigns(
  storeId: string,
  query: Query = {},
): Promise<ApiResult<AdminResponse<'listCampaigns'>>> {
  return adminCall<'listCampaigns'>({
    path: buildPath(`${STORE}/campaigns`, { storeId }),
    query,
  });
}

export async function getCampaign(
  storeId: string,
  campaignId: string,
): Promise<ApiResult<AdminResponse<'getCampaign'>>> {
  return adminCall<'getCampaign'>({
    path: buildPath(`${STORE}/campaigns/{campaignId}`, { storeId, campaignId }),
  });
}

export async function createCampaign(
  storeId: string,
  body: AdminComponents['CampaignInput'],
): Promise<ApiResult<AdminResponse<'createCampaign'>>> {
  return adminCall<'createCampaign'>({
    path: buildPath(`${STORE}/campaigns`, { storeId }),
    method: 'POST',
    body,
  });
}

export async function updateCampaign(
  storeId: string,
  campaignId: string,
  body: AdminComponents['CampaignInput'],
): Promise<ApiResult<AdminResponse<'updateCampaign'>>> {
  return adminCall<'updateCampaign'>({
    path: buildPath(`${STORE}/campaigns/{campaignId}`, { storeId, campaignId }),
    method: 'PATCH',
    body,
  });
}

export async function launchCampaign(
  storeId: string,
  campaignId: string,
): Promise<ApiResult<AdminResponse<'launchCampaign'>>> {
  return adminCall<'launchCampaign'>({
    path: buildPath(`${STORE}/campaigns/{campaignId}/launch`, { storeId, campaignId }),
    method: 'POST',
  });
}

export async function endCampaign(
  storeId: string,
  campaignId: string,
): Promise<ApiResult<AdminResponse<'endCampaign'>>> {
  return adminCall<'endCampaign'>({
    path: buildPath(`${STORE}/campaigns/{campaignId}/end`, { storeId, campaignId }),
    method: 'POST',
  });
}

export async function deleteCampaign(
  storeId: string,
  campaignId: string,
): Promise<ApiResult<AdminResponse<'deleteCampaign'>>> {
  return adminCall<'deleteCampaign'>({
    path: buildPath(`${STORE}/campaigns/{campaignId}`, { storeId, campaignId }),
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------- segments

export async function listSegments(
  storeId: string,
  query: Query = {},
): Promise<ApiResult<AdminResponse<'listSegments'>>> {
  return adminCall<'listSegments'>({ path: buildPath(`${STORE}/segments`, { storeId }), query });
}

export async function getSegment(
  storeId: string,
  segmentId: string,
): Promise<ApiResult<AdminResponse<'getSegment'>>> {
  return adminCall<'getSegment'>({
    path: buildPath(`${STORE}/segments/{segmentId}`, { storeId, segmentId }),
  });
}

export async function createSegment(
  storeId: string,
  body: AdminComponents['SegmentInput'],
): Promise<ApiResult<AdminResponse<'createSegment'>>> {
  return adminCall<'createSegment'>({
    path: buildPath(`${STORE}/segments`, { storeId }),
    method: 'POST',
    body,
  });
}

export async function updateSegment(
  storeId: string,
  segmentId: string,
  body: AdminComponents['SegmentInput'],
): Promise<ApiResult<AdminResponse<'updateSegment'>>> {
  return adminCall<'updateSegment'>({
    path: buildPath(`${STORE}/segments/{segmentId}`, { storeId, segmentId }),
    method: 'PATCH',
    body,
  });
}

/**
 * Counts what the rules match right now. `rules` in the body overrides the saved ones, which is what lets the
 * rule builder show a live count before anything is saved.
 */
export async function previewSegment(
  storeId: string,
  segmentId: string,
  rules?: AdminComponents['SegmentRules'],
): Promise<ApiResult<AdminResponse<'previewSegment'>>> {
  return adminCall<'previewSegment'>({
    path: buildPath(`${STORE}/segments/{segmentId}/preview`, { storeId, segmentId }),
    method: 'POST',
    ...(rules === undefined ? {} : { body: { rules } }),
  });
}

/**
 * Refreshes `segment_member`. The contract answers **202** with a `Segment` body.
 *
 * The return type is written out rather than taken from `AdminResponse<'materializeSegment'>`: window 4's
 * `SuccessBody` helper maps 200 → body, else 201, else `null`, so any 202-with-body types as `null`. That is
 * their file, so REQUEST #251 asks for the 202 branch — it also silently affects window 13's `eraseCustomer`,
 * the only other 202 in the document. Until it lands, the cast below is the honest type: `Segment` is exactly
 * what `admin-api.yaml` documents for this response.
 */
export async function materializeSegment(
  storeId: string,
  segmentId: string,
): Promise<ApiResult<AdminComponents['Segment']>> {
  return adminCall<'materializeSegment'>({
    path: buildPath(`${STORE}/segments/{segmentId}/materialize`, { storeId, segmentId }),
    method: 'POST',
  }) as unknown as Promise<ApiResult<AdminComponents['Segment']>>;
}

export async function deleteSegment(
  storeId: string,
  segmentId: string,
): Promise<ApiResult<AdminResponse<'deleteSegment'>>> {
  return adminCall<'deleteSegment'>({
    path: buildPath(`${STORE}/segments/{segmentId}`, { storeId, segmentId }),
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------- feeds

export async function listFeeds(
  storeId: string,
  query: Query = {},
): Promise<ApiResult<AdminResponse<'listFeeds'>>> {
  return adminCall<'listFeeds'>({ path: buildPath(`${STORE}/feeds`, { storeId }), query });
}

export async function getFeed(
  storeId: string,
  feedId: string,
): Promise<ApiResult<AdminResponse<'getFeed'>>> {
  return adminCall<'getFeed'>({ path: buildPath(`${STORE}/feeds/{feedId}`, { storeId, feedId }) });
}

export async function createFeed(
  storeId: string,
  body: AdminComponents['ProductFeedInput'],
): Promise<ApiResult<AdminResponse<'createFeed'>>> {
  return adminCall<'createFeed'>({
    path: buildPath(`${STORE}/feeds`, { storeId }),
    method: 'POST',
    body,
  });
}

export async function updateFeed(
  storeId: string,
  feedId: string,
  body: AdminComponents['ProductFeedInput'],
): Promise<ApiResult<AdminResponse<'updateFeed'>>> {
  return adminCall<'updateFeed'>({
    path: buildPath(`${STORE}/feeds/{feedId}`, { storeId, feedId }),
    method: 'PATCH',
    body,
  });
}

export async function publishFeed(
  storeId: string,
  feedId: string,
): Promise<ApiResult<AdminResponse<'publishFeed'>>> {
  return adminCall<'publishFeed'>({
    path: buildPath(`${STORE}/feeds/{feedId}/publish`, { storeId, feedId }),
    method: 'POST',
  });
}

export async function listFeedItems(
  storeId: string,
  feedId: string,
  query: Query = {},
): Promise<ApiResult<AdminResponse<'listFeedItems'>>> {
  return adminCall<'listFeedItems'>({
    path: buildPath(`${STORE}/feeds/{feedId}/items`, { storeId, feedId }),
    query,
  });
}

export async function deleteFeed(
  storeId: string,
  feedId: string,
): Promise<ApiResult<AdminResponse<'deleteFeed'>>> {
  return adminCall<'deleteFeed'>({
    path: buildPath(`${STORE}/feeds/{feedId}`, { storeId, feedId }),
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------- reports

export async function getAttributionReport(
  storeId: string,
  query: { from: string; to: string; touch?: 'first' | 'last' },
): Promise<ApiResult<AdminResponse<'getAttributionReport'>>> {
  return adminCall<'getAttributionReport'>({
    path: buildPath(`${STORE}/reports/attribution`, { storeId }),
    query: { from: query.from, to: query.to, ...(query.touch ? { touch: query.touch } : {}) },
  });
}

export async function getPromotionReport(
  storeId: string,
  query: { from: string; to: string },
): Promise<ApiResult<AdminResponse<'getPromotionReport'>>> {
  return adminCall<'getPromotionReport'>({
    path: buildPath(`${STORE}/reports/promotions`, { storeId }),
    query: { from: query.from, to: query.to },
  });
}

// The abandoned-cart recovery report is deliberately absent: `getAbandonedCartReport` is CONTRACT CHANGE #245
// and is not in the frozen document yet, so there is no operationId to type against. It joins this file — and
// the Overview tile — in the contracts-v0.4.5 cleanup, rather than being faked with an untyped fetch now.
