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

/** The store's monthly token budget would be exceeded by this call; nothing was sent. */
export class AiBudgetExceededError extends AiError {
  constructor(
    readonly storeId: string,
    readonly usedTokens: number,
    readonly limitTokens: number,
  ) {
    super(
      `AI token budget exhausted for this store this month (${usedTokens} of ${limitTokens} tokens)`,
    );
  }
}

/** Too many calls for this store in the current minute; nothing was sent. */
export class AiRateLimitedError extends AiError {
  constructor(
    readonly storeId: string,
    readonly limitPerMinute: number,
  ) {
    super(`AI rate limit reached for this store (${limitPerMinute} calls per minute)`);
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
