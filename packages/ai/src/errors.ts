// Typed errors of the gateway. Every refusal before a network call has its own class, so callers (the admin's
// "draft with AI" button) can say why nothing happened; none of them carries content.

export class AiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Misconfiguration: no key, an unpriced model override, a bad limit. Never retried. */
export class AiConfigError extends AiError {}

/** `AI_ENABLED` is not exactly '1': AI features are switched off (the default, and always in CI). */
export class AiDisabledError extends AiError {}

/** Whose budget ran out: the store's month, the organization's month (a call with `storeId: null`), or one run's
 * `maxTokensTotal` ceiling (#669). */
export type BudgetScope = 'store' | 'organization' | 'run';

/** A monthly token budget (or a run's ceiling) would be exceeded by this call; nothing was sent. */
export class AiBudgetExceededError extends AiError {
  /** The contract's error details (#668 / #664): `resets_at` is the next UTC month's first instant, null for a run. */
  readonly details: {
    scope: BudgetScope;
    used_tokens: number;
    limit_tokens: number;
    resets_at: string | null;
  };

  constructor(
    readonly storeId: string | null,
    readonly usedTokens: number,
    readonly limitTokens: number,
    readonly scope: BudgetScope = 'store',
    resetsAt: Date | null = null,
  ) {
    super(
      scope === 'run'
        ? `AI token ceiling of this run reached (${usedTokens} of ${limitTokens} tokens)`
        : `AI token budget exhausted for this ${scope} this month (${usedTokens} of ${limitTokens} tokens)`,
    );
    this.details = {
      scope,
      used_tokens: usedTokens,
      limit_tokens: limitTokens,
      resets_at: resetsAt ? resetsAt.toISOString() : null,
    };
  }
}

/** Too many calls for this store (or organization) in the current minute; nothing was sent. */
export class AiRateLimitedError extends AiError {
  constructor(
    readonly storeId: string | null,
    readonly limitPerMinute: number,
    readonly scope: 'store' | 'organization' = 'store',
  ) {
    super(`AI rate limit reached for this ${scope} (${limitPerMinute} calls per minute)`);
  }
}

/** A tool-use run asked for more tool calls than `maxToolCalls`; the extra step's calls were not run (#669). */
export class AiToolLoopError extends AiError {
  readonly details: { max_tool_calls: number };

  constructor(readonly maxToolCalls: number) {
    super(`the model asked for more than ${maxToolCalls} tool calls; the run was stopped`);
    this.details = { max_tool_calls: maxToolCalls };
  }
}

/** A denylisted customer field was passed as a template variable; nothing was rendered or sent. */
export class DeniedFieldError extends AiError {
  constructor(readonly fields: string[]) {
    super(`customer fields may never be sent to the AI gateway: ${fields.join(', ')}`);
  }
}

/** Unknown template, a purpose mismatch, or variables that do not match the template's declaration. */
export class TemplateError extends AiError {}

/** The model declined (stop reason `refusal`); only the category travels, never the explanation text. */
export class AiRefusedError extends AiError {
  constructor(readonly category: string | null) {
    super(`the model declined to draft this${category ? ` (${category})` : ''}`);
  }
}

/** The provider call failed (network, 4xx/5xx); `errorClass` is the SDK class name, never a message. */
export class AiTransportError extends AiError {
  constructor(
    readonly errorClass: string,
    options?: { cause?: unknown },
  ) {
    super(`the AI provider call failed (${errorClass})`, options);
  }
}

/** The audit row could not be written; the call's output is withheld (no unaudited AI output). */
export class AiAuditError extends AiError {}

/** The usage limiter (Redis) could not reserve; nothing was sent. `errorClass` is the class name, never a message. */
export class AiLimiterError extends AiError {
  constructor(
    readonly errorClass: string,
    options?: { cause?: unknown },
  ) {
    super(`the AI usage limiter failed (${errorClass}); nothing was sent`, options);
  }
}
