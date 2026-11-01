// Public API of @platform/ai — the guarded Claude gateway (D8, #605). Nothing outside this package imports src/*.
export {
  createAiGateway,
  estimateInputTokens,
  NO_INPUT_SHA256,
  nextUtcMonth,
  type AiDraft,
  type AiGateway,
  type AiGatewayOptions,
} from './gateway.js';
export {
  costMicroUsd,
  DEFAULT_MODELS,
  FALLBACKS,
  isPurpose,
  modelFor,
  PRICES,
  PURPOSES,
  type ModelPrice,
  type Purpose,
  type TokenUsage,
} from './models.js';
export {
  getTemplate,
  renderTemplate,
  TEMPLATES,
  type Template,
  type TemplateKey,
  type TemplateValue,
  type TemplateVariables,
} from './templates.js';
export { redact, type RedactionKind, type RedactionResult } from './redact.js';
export {
  DENIED_FIELDS,
  findDeniedFields,
  type DeniedField,
  type NoDeniedFields,
} from './denylist.js';
export {
  createMemoryLimiter,
  createRedisLimiter,
  DEFAULT_LIMITS,
  limitsFromEnv,
  minuteKey,
  monthKey,
  orgLimitsFromEnv,
  scopeKey,
  type LimitScope,
  type Limits,
  type RedisLimiter,
  type RedisLimiterOptions,
  type ReserveResult,
  type UsageLimiter,
} from './limiter.js';
export {
  createMemoryAuditSink,
  OUTCOMES,
  type AuditOutcome,
  type AuditRecord,
  type AuditSink,
  type MemoryAuditSink,
} from './audit.js';
export { createPgAuditSink } from './pg-audit.js';
export {
  createAnthropicTransport,
  ANTHROPIC_API_URL,
  createFakeTransport,
  errorClassOf,
  FALLBACK_BETA,
  type AiAssistantContent,
  type AiRequest,
  type AiResponse,
  type AiTool,
  type AiToolCall,
  type AiToolResultBlock,
  type AiTransport,
  type AiTurn,
  type AnthropicTransportOptions,
  type FakeScriptStep,
  type FakeStep,
  type FakeTransport,
  type FakeTransportOptions,
  type JsonSchemaObject,
} from './transport.js';
export {
  AiAuditError,
  AiBudgetExceededError,
  AiConfigError,
  AiDisabledError,
  AiError,
  AiLimiterError,
  AiRateLimitedError,
  AiRefusedError,
  AiToolLoopError,
  AiTransportError,
  DeniedFieldError,
  TemplateError,
  type BudgetScope,
} from './errors.js';
