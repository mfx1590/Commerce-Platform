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
export {
  createFeed,
  deleteFeed,
  getFeed,
  listFeedItems,
  listFeeds,
  normaliseFeedInput,
  publishFeed,
  toFeed,
  updateFeed,
} from './feeds';
export { buildFeedItems } from './feed-items';
export { formatPrice, renderFeed, renderGoogleFeed, renderMetaFeed } from './feed-render';
export {
  blocksPublication,
  messageFor,
  publishableItems,
  validateItem,
  validateItems,
} from './feed-validation';
export {
  assertFeedKey,
  feedKey,
  FilesystemFeedStorage,
  getFeedStorage,
  resetFeedStorage,
  setFeedStorage,
  sha256,
} from './storage';
export type { FeedStorage, FilesystemFeedStorageOptions, PutResult } from './storage';
export {
  FEED_CHANNELS,
  FEED_CONTENT_TYPE,
  FEED_EXTENSION,
  FEED_INPUT_STATUSES,
  FEED_STATUSES,
  RENDERABLE_CHANNELS,
} from './feed-types';
export type {
  Availability,
  FeedBuild,
  FeedChannel,
  FeedError,
  FeedFilters,
  FeedItem,
  FeedListQuery,
  FeedStatus,
  ProductFeed,
  ProductFeedInput,
  ProductFeedRow,
} from './feed-types';
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
