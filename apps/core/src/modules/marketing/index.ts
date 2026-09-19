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
export {
  createSegment,
  createSegmentTemplate,
  deleteSegment,
  deleteSegmentTemplate,
  getSegment,
  getSegmentTemplate,
  listSegments,
  listSegmentTemplates,
  materializeSegment,
  normaliseSegmentInput,
  previewSegment,
  toSegment,
  updateSegment,
  updateSegmentTemplate,
} from './segments';
// The frozen rule grammar (2.3): the parser, the closed field table, and the JSON Schema window 16's worker and
// the admin rule builder validate against without importing this module.
export {
  CONSENT_CHANNELS,
  EMPTY_RULES,
  parseSegmentRules,
  SEGMENT_FIELDS,
  SEGMENT_RULES_SCHEMA,
  SEGMENT_RULES_VERSION,
} from './segment-rules';
export type {
  ConsentChannel,
  SegmentAnyGroup,
  SegmentField,
  SegmentPredicate,
  SegmentRules,
} from './segment-rules';
export { compileSegmentRules, SEGMENT_FROM, segmentQuery } from './segment-sql';
export type { CompiledRules } from './segment-sql';
// The window 16 boundary: a typed payload and one function. No provider call ever happens in this module.
export { emailHash, segmentSyncPayload } from './segment-sync';
export type { SegmentSyncMember, SegmentSyncOptions, SegmentSyncPayload } from './segment-sync';
export { SEGMENT_SORT_FIELDS } from './segment-types';
export type {
  Segment,
  SegmentInput,
  SegmentListQuery,
  SegmentRow,
  SegmentSortField,
} from './segment-types';
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
