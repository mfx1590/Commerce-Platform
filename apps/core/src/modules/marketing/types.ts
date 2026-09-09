// Contract types of the marketing module, mirroring `packages/contracts/openapi/admin-api.yaml` (Admin API 0.3.0)
// and the tables of migration 0120. Two shapes never to confuse:
//   * the CONTRACT shape (`Campaign`) carries `budget` as a `Money` object;
//   * the TABLE shape (`CampaignRow`) carries `budget_minor` + `currency` as two columns.
// `toCampaign` in campaigns.ts is the only translation between them (manager decision 2026-09-08: map in the
// service, no contract change).
import type { AdminComponents } from '@platform/contracts';

export type Campaign = AdminComponents['schemas']['Campaign'];
export type CampaignInput = AdminComponents['schemas']['CampaignInput'];
export type AttributionReport = AdminComponents['schemas']['AttributionReport'];
export type Money = AdminComponents['schemas']['Money'];

export type CampaignType = NonNullable<CampaignInput['type']>;
export type CampaignStatus = NonNullable<Campaign['status']>;
export type CampaignSortField = 'name' | 'status' | 'starts_at' | 'created_at';
export type Touch = NonNullable<AttributionReport['touch']>;
export type SortOrder = 'asc' | 'desc';

export const CAMPAIGN_TYPES: readonly CampaignType[] = [
  'email',
  'sms',
  'paid_social',
  'paid_search',
  'affiliate',
  'referral',
  'landing',
];
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'ended',
];
/** The `sort` enum of `listCampaigns` in admin-api.yaml. */
export const CAMPAIGN_SORT_FIELDS: readonly CampaignSortField[] = [
  'name',
  'status',
  'starts_at',
  'created_at',
];
export const TOUCHES: readonly Touch[] = ['first', 'last'];

/** Statuses `launch` accepts, and the ones `end` accepts (admin-api.yaml summaries; 409 otherwise). */
export const LAUNCHABLE: readonly CampaignStatus[] = ['draft', 'scheduled', 'paused'];
export const ENDABLE: readonly CampaignStatus[] = ['active', 'paused'];

/** A row of the `campaign` table (migration 0120). bigint columns arrive as strings from node-postgres. */
export interface CampaignRow {
  id: string;
  organization_id: string;
  store_id: string;
  name: string;
  type: CampaignType;
  status: CampaignStatus;
  starts_at: Date | null;
  ends_at: Date | null;
  budget_minor: string | null;
  currency: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  promotion_id: string | null;
  segment_id: string | null;
  landing_path: string | null;
  external_ref: string | null;
  launched_at: Date | null;
  ended_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface PageQuery {
  page?: number;
  limit?: number;
}

export interface CampaignListQuery extends PageQuery {
  status?: CampaignStatus;
  type?: CampaignType;
  sort?: CampaignSortField;
  order?: SortOrder;
}

export interface Page<T> {
  page: number;
  limit: number;
  total: number;
  items: T[];
}

export interface AttributionReportQuery {
  from: string;
  to: string;
  touch?: Touch;
}
