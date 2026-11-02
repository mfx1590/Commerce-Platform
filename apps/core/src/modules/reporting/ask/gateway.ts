// The slice of the AI gateway BI Q&A uses: `runTools`, exactly as REQUEST #669 asks window 14 to add to
// `@platform/ai`. Until it lands, the core builds and tests against this interface with the scripted fake
// (./testing/fake-gateway.ts); afterwards `createAiGateway(…)` satisfies it with no change at the call sites.
import { AppError } from '../../../lib/errors';

/** A JSON Schema with type: 'object' (sent as the tool's input_schema). */
export type JsonSchemaObject = { type: 'object' } & Record<string, unknown>;

export interface AiTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}
export interface AiToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface AiToolResult {
  /** JSON text the caller made */
  content: string;
  isError?: boolean;
}

export interface AiToolRun {
  text: string;
  toolCalls: { id: string; name: string; input: unknown; isError: boolean }[];
  steps: number;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  conversationId: string;
  model: string;
  servedModel: string;
  template: { id: string; version: number };
}

export interface RunToolsOptions {
  tools: readonly AiTool[];
  handle: (call: AiToolCall) => Promise<AiToolResult>;
  maxToolCalls?: number;
  maxTokensTotal?: number;
  conversationId?: string;
}

/** The variables of template `bi-qa-answer@3` (#684; as @2: @1 plus `locale`). */
export interface BiQaVariables {
  question: string;
  /** BCP 47, canonical (ask.ts canonicalLocale) */
  locale: string;
  today: string;
  window: string;
  stores: string;
  currencyNote: string;
}

export interface GatewayLike {
  runTools(
    key: 'bi-qa-answer@3',
    variables: BiQaVariables,
    opts: RunToolsOptions,
  ): Promise<AiToolRun>;
}

/**
 * One gateway per call: a single-store question is charged and audited to that store, a question over several
 * stores (HQ) to the organization (`storeId: null`, decision (a) on #606).
 */
export type GatewayFactory = (scope: {
  organizationId: string;
  storeId: string | null;
  actorId: string;
}) => GatewayLike;

/**
 * The gateway's errors → the contract's (#668, the #664 table plus `ai_tool_limit`). Matched by class NAME, so the
 * stand-in and the real @platform/ai classes map the same; an unknown error is rethrown (a 500, never swallowed).
 */
export function aiErrorToAppError(err: unknown): AppError | undefined {
  if (!(err instanceof Error)) return undefined;
  const details = (err as { details?: Record<string, unknown> }).details ?? {};
  switch (err.name) {
    case 'AiDisabledError':
      return new AppError('ai_disabled', 'AI is switched off');
    case 'AiBudgetExceededError':
      return new AppError(
        'ai_budget_exceeded',
        'The AI token budget for this month is used up',
        details,
      );
    case 'AiRateLimitedError':
      return new AppError('ai_rate_limited', 'Too many AI calls this minute', details);
    case 'AiRefusedError':
      return new AppError('ai_refused', 'The model refused the question; reword it', {
        category: details.category ?? null,
      });
    case 'AiToolLoopError':
      return new AppError(
        'ai_tool_limit',
        'The question needed more queries than allowed; narrow it',
        {
          max_tool_calls: details.max_tool_calls ?? null,
        },
      );
    case 'AiTransportError':
      return new AppError('ai_unavailable', 'The AI provider did not answer', {
        error_class: err.name,
      });
    case 'AiLimiterError':
    case 'AiAuditError':
      return new AppError('unavailable', 'AI is unavailable right now');
    // a configuration or template fault, or a denied field reaching the gateway: ours to fix, never the caller's —
    // a plain 500 with no detail (as catalog/copy-draft.ts does), so the raw error and its message are not dumped
    case 'AiConfigError':
    case 'TemplateError':
    case 'DeniedFieldError':
      return new AppError('internal', 'BI Q&A is misconfigured');
    default:
      return undefined;
  }
}
