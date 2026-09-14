// Public API of @platform/feeds.
export { createFeedHandler, createFeedServer, resolveConfig } from './server.js';
export type { FeedServerConfig, FeedServerOptions } from './server.js';
export { CONTENT_TYPE, FeedReader, parseFeedPath } from './storage.js';
export type { FeedRef, FeedReaderOptions } from './storage.js';
