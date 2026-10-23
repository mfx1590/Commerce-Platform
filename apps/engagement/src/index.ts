// Public API of @platform/engagement. Nothing imports this package yet (the manager wires the service into
// the images on the 16.1 head); the surface exists so a test, a script and the later modules (#554 cdp,
// #555 crm, #556 support) import through one door, never `src/*`.

export { resolveConfig } from './config.js';
export type { EngagementConfig, ResolveOptions, TransportName } from './config.js';

export { buildTransport, main } from './main.js';

// ops alerts (#553)
export {
  createOpsConsumer,
  handleEvent,
  errorClassOf,
  OPS_GROUP_ID,
  PROCESSED_TABLE,
} from './ops/consumer.js';
export type { Kafka, OpsConsumer, OpsConsumerOptions } from './ops/consumer.js';

export {
  evaluateRules,
  ruleTopics,
  OPS_RULES,
  paymentFailedRule,
  refundFailedRule,
  returnRequestedRule,
} from './ops/rules.js';
export type { Rule, RuleInput } from './ops/rules.js';

export { createRateLimiter, rateLimitKey } from './ops/rate-limit.js';
export type { RateLimiter, RateLimitDecision, RateLimitOptions } from './ops/rate-limit.js';

export { createStoreCodes } from './ops/store-codes.js';
export type { StoreCodes } from './ops/store-codes.js';

export { pollDeadLetters, runDlqWatch, DLQ_RULE, DLQ_PSEUDO_TOPIC } from './ops/dlq-watch.js';
export type { DeadLetterReader, DlqWatchOptions } from './ops/dlq-watch.js';

// cdp (#554)
export { createCdpConsumer, handleCdpEvent, CDP_GROUP_ID } from './cdp/consumer.js';
export type {
  AppPool,
  CdpConsumer,
  CdpConsumerOptions,
  CdpHandlerDeps,
  CdpLogLine,
} from './cdp/consumer.js';

export {
  mapEvent,
  cdpTopics,
  isMapped,
  isConsentGated,
  CDP_CALL_FOR,
  CDP_EVENT_NAME,
} from './cdp/mapper.js';
export type { MapContext } from './cdp/mapper.js';

export { gate, readCustomerFacts, readOrderCustomerFacts, CONSENT_PURPOSE } from './cdp/consent.js';
export type { ConsentState, CustomerFacts, DropReason, GateDecision } from './cdp/consent.js';

export { MemoryCdpAdapter } from './cdp/adapter/memory.js';
export { RudderStackCdpAdapter, identityOf } from './cdp/adapter/rudderstack.js';
export type { RudderStackOptions } from './cdp/adapter/rudderstack.js';
export { sendCall, CdpError } from './cdp/types.js';
export type {
  CdpAdapter,
  CdpCall,
  CdpCallKind,
  CdpIdentifyCall,
  CdpIdentity,
  CdpSuppressCall,
  CdpTrackCall,
} from './cdp/types.js';

// transports
export { DevSinkAlertTransport } from './transport/dev-sink.js';
export { SlackAlertTransport, slackPayload, escapeMrkdwn } from './transport/slack.js';
export type { FetchLike, SlackTransportOptions } from './transport/slack.js';
export { TransportError } from './transport/types.js';
export type { AlertTransport } from './transport/types.js';

export type { Alert, AlertSeverity, EngagementLogLine } from './types.js';
