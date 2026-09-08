// Public API of the search module (window 9). Nothing outside this folder may import from its other files.
export { AlgoliaIndexClient, AlgoliaError, type AlgoliaClientOptions } from './algolia-client';
export { FakeIndexClient, type FakeCall } from './fake-client';
export { algoliaCredentialsFor, envSuffix, type AlgoliaCredentials } from './config';
export {
  buildRecord,
  loadSearchRecords,
  storeCurrencies,
  type LoadRecordsOptions,
} from './records';
export {
  CURSOR_KEY,
  indexNameFor,
  primarySettings,
  REPLICA_SORTS,
  replicaNameFor,
  replicaSettings,
  sharedSettings,
  type ReplicaSort,
} from './settings';
export {
  ensureIndexSettings,
  fullReindex,
  readCursor,
  syncFromOutbox,
  syncUntilCaughtUp,
  type SyncOptions,
} from './sync';
export { DESCRIPTION_MAX_CHARS, SYNC_TOPICS } from './types';
// ---- merchandising (task 2.2, #135; contract change #162) ----
export {
  createRule,
  deleteRule,
  getRule,
  listRules,
  publishRules,
  searchRelevance,
  updateRule,
  type RelevanceQuery,
  type RelevanceResult,
} from './merchandising';
export {
  isRuleActive,
  normalizeQuery,
  parsePatch,
  parseRuleInput,
  MERCHANDISING_RULE_INPUT_SCHEMA,
  MERCHANDISING_RULE_PATCH_SCHEMA,
  type MerchandisingBoost,
  type MerchandisingRule,
  type MerchandisingRuleInput,
  type MerchandisingRulePatch,
  type MerchandisingScope,
  type PublishResult,
} from './merchandising-types';
export { categoryFilter, ruleObjectId, toAlgoliaRule } from './algolia-rules';
export {
  MemoryRulesRepository,
  PgRulesRepository,
  scopeKey,
  type NewRule,
  type RulesRepository,
} from './repository';
export { MERCHANDISING_BASE, merchandisingRouter, type MerchandisingRouterOptions } from './http';
export type { AlgoliaRule, SearchParams, SearchResponse } from './types';
export type {
  IndexClient,
  IndexSettings,
  ReindexResult,
  SearchRecord,
  SearchVariant,
  StoreIndexTarget,
  SyncResult,
} from './types';
