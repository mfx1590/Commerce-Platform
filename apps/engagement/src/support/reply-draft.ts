// A reply DRAFT for a support agent (#610). The agent edits it and sends it; this module has no outbound
// channel of any kind, which is how "nothing is ever sent automatically" is a property of the design rather
// than a promise in a comment.
//
// The gateway arrives as a narrow PORT rather than as `@platform/ai`'s `AiGateway`, for two reasons:
//   * `complete<K extends TemplateKey>` only accepts a key that exists in the template registry, and
//     `support-reply-draft@1` is window 14's to publish (REQUEST #667). The port lets everything here — the
//     projection, the switch, the error mapping, the tests — be built and reviewed now;
//   * tests then use a recording fake and never construct the real gateway, so no test can reach a network
//     or a budget, and a test can assert WHAT WAS SENT, which is the thing a privacy review cares about.
// `main.ts` builds the one real implementation.

import { TEMPLATE_KEY } from './draft-template.js';
import { toDraftVariables, type DraftVariables } from './draft-context.js';
import type { SupportContext } from './types.js';
import { SupportError } from './types.js';

/**
 * What this route needs from the AI gateway, and nothing more.
 *
 * The key is the LITERAL rather than `string` (#674 item 1): with `support-reply-draft@1` published, the one
 * implementation in `main.ts` passes this straight to `complete<K extends TemplateKey>`, so the typechecker
 * now proves that the projection's keys are the template's declared variables. While the template was
 * unpublished a cast stood here instead — and that cast was exactly what hid the `totalMinor` mismatch until
 * someone read the other side's PR.
 */
export interface DraftGateway {
  readonly model: string;
  complete(
    templateKey: typeof TEMPLATE_KEY,
    variables: DraftVariables,
  ): Promise<{ text: string; stopReason: string | null; servedModel: string }>;
}

export interface ReplyDraft {
  draft: string;
  template: string;
  model: string;
  /** `max_tokens` when the model ran out of room: the agent sees a cut-off draft and should ask for less. */
  stopReason: string | null;
  storeCode: string;
  orderRef: string;
}

export interface ReplyDraftOptions {
  gateway: DraftGateway;
  context: SupportContext;
  question: string;
  orderId?: string | undefined;
  locale: string;
  brandVoice: string;
}

/** The longest customer message we will send. Longer than any real one, short enough to bound a prompt. */
export const MAX_QUESTION_CHARS = 4000;

/**
 * The shared error codes (`@platform/contracts` `ERROR_CODES`), mapped from the gateway's error CLASSES the
 * way #664 does it — by class name, because the gateway's errors cross a package boundary and `instanceof`
 * across two copies of a package is a trap we do not need to walk into.
 *
 * The ones worth explaining:
 *   * a transport failure is 502 `ai_unavailable` — the provider failed, not us;
 *   * the limiter or the audit failing is 503 `unavailable`: the gateway withholds the draft when it cannot
 *     be audited, and so do we. An unaudited draft is worse than no draft;
 *   * a denied field is 500 `internal`, because it means the projection in `draft-context.ts` is wrong —
 *     the agent did nothing to cause it and can do nothing about it;
 *   * an unknown template is 503 `unavailable` too: the feature is configured but not ready (REQUEST #667).
 */
const BY_CLASS: Record<string, { status: number; code: string }> = {
  AiDisabledError: { status: 503, code: 'ai_disabled' },
  AiBudgetExceededError: { status: 429, code: 'ai_budget_exceeded' },
  AiRateLimitedError: { status: 429, code: 'ai_rate_limited' },
  AiRefusedError: { status: 422, code: 'ai_refused' },
  AiTransportError: { status: 502, code: 'ai_unavailable' },
  AiLimiterError: { status: 503, code: 'unavailable' },
  AiAuditError: { status: 503, code: 'unavailable' },
  TemplateError: { status: 503, code: 'unavailable' },
  DeniedFieldError: { status: 500, code: 'internal' },
  // Not 500: a missing `AI_ANTHROPIC_API_KEY` or a bad model override is an operator's problem and an agent
  // can only wait, exactly like an unpublished template. 500 would tell them our code is broken. (The
  // manager's table did not cover this class; flagged with the PR.)
  AiConfigError: { status: 503, code: 'unavailable' },
};

/** The gateway's error turned into one of ours. Never carries the gateway's message onward. */
export function draftErrorFor(err: unknown): SupportError {
  const name = err instanceof Error ? err.name : 'Error';
  const mapped = BY_CLASS[name];
  if (!mapped) return new SupportError(500, 'internal', 'The draft could not be prepared');
  const details: Record<string, unknown> = { reason: name };
  // The one field worth passing on: a refusal has a category the agent can act on by rewording.
  const category = (err as { category?: unknown }).category;
  if (typeof category === 'string') details.category = category;
  const retryAfter = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  const out = new SupportError(mapped.status, mapped.code, messageFor(mapped.code));
  out.details = details;
  if (mapped.code === 'ai_rate_limited' && typeof retryAfter === 'number') {
    out.retryAfterSeconds = retryAfter;
  }
  return out;
}

function messageFor(code: string): string {
  switch (code) {
    case 'ai_disabled':
      return 'Drafting is switched off';
    case 'ai_budget_exceeded':
      return 'This store has used its drafting budget for the month';
    case 'ai_rate_limited':
      return 'Too many drafts just now — try again shortly';
    case 'ai_refused':
      return 'The model declined to draft this; reword the question and try again';
    case 'ai_unavailable':
      return 'The drafting service could not be reached';
    case 'unavailable':
      return 'Drafting is unavailable';
    default:
      return 'The draft could not be prepared';
  }
}

/**
 * Build one draft. Throws a `SupportError` the route can render; never returns a partial draft, and never
 * sends anything anywhere.
 */
export async function buildReplyDraft(opts: ReplyDraftOptions): Promise<ReplyDraft> {
  const question = opts.question.trim();
  if (!question) {
    throw new SupportError(400, 'validation_error', 'A question is required');
  }
  if (question.length > MAX_QUESTION_CHARS) {
    throw new SupportError(
      400,
      'validation_error',
      `A question must be at most ${MAX_QUESTION_CHARS} characters`,
    );
  }

  const variables = toDraftVariables({ ...opts, question });
  if (!variables) {
    // No order to speak about. A draft built on nothing would be the model inventing a status.
    throw new SupportError(404, 'not_found', 'No such order for this customer');
  }

  let draft: Awaited<ReturnType<DraftGateway['complete']>>;
  try {
    draft = await opts.gateway.complete(TEMPLATE_KEY, variables);
  } catch (err) {
    throw draftErrorFor(err);
  }

  return {
    draft: draft.text,
    template: TEMPLATE_KEY,
    model: draft.servedModel || opts.gateway.model,
    stopReason: draft.stopReason,
    storeCode: variables.storeCode,
    orderRef: variables.orderRef,
  };
}
