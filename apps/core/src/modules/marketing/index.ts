// Public API of the marketing module (window 17). Nothing outside this folder may import from its other files.
// Phase 2.1: campaigns + the attribution report. Feeds live in apps/feeds; segments, abandoned-cart recovery and
// the rest follow in 2.2–2.4.
export {
  createCampaign,
  deleteCampaign,
  endCampaign,
  getCampaign,
  launchCampaign,
  listCampaigns,
  normaliseCampaignInput,
  toCampaign,
  updateCampaign,
} from './campaigns';
export { attributionReport } from './reports';
export { marketingAdminRouter } from './routes';
export {
  CAMPAIGN_SORT_FIELDS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  ENDABLE,
  LAUNCHABLE,
  TOUCHES,
} from './types';
export type {
  AttributionReport,
  AttributionReportQuery,
  Campaign,
  CampaignInput,
  CampaignListQuery,
  CampaignRow,
  CampaignSortField,
  CampaignStatus,
  CampaignType,
  Money,
  Page,
  PageQuery,
  SortOrder,
  Touch,
} from './types';
