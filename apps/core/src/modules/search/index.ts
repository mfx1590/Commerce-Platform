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
export type {
  IndexClient,
  IndexSettings,
  ReindexResult,
  SearchRecord,
  SearchVariant,
  StoreIndexTarget,
  SyncResult,
} from './types';
