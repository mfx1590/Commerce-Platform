// The guarded Claude gateway (D8, #605): the one way any app calls a model.
//
//   const ai = createAiGateway({ organizationId, storeId, purpose: 'drafting', actorId, transport, limiter, audit });
//   const draft = await ai.complete('product-copy-draft@1', { brandVoice, locale, productTitle, attributes, audience });
//
// Order of a call — every step before 6 refuses without sending anything, and every outcome writes one audit row:
//   1. the template exists and serves this gateway's purpose;
//   2. no denylisted customer field among the variables (any depth);
//   3. the variables are exactly the template's declared set; render; redact every rendered string; hash it;
//   4. the kill switch: AI_ENABLED must be exactly '1';
//   5. reserve the worst case (estimated input + maxTokens) against the store's month and minute;
//   6. call the model; settle the reservation to the real usage (all of it back after a failure);
//   7. audit; only then return the draft. AI drafts, a human publishes: nothing here publishes anything.
import { createHash } from 'node:crypto';
import type { AuditOutcome, AuditRecord, AuditSink } from './audit.js';
import { findDeniedFields, type NoDeniedFields } from './denylist.js';
import {
  AiAuditError,
  AiBudgetExceededError,
  AiConfigError,
  AiDisabledError,
  AiError,
  AiLimiterError,
  AiRateLimitedError,
  AiRefusedError,
  AiTransportError,
  DeniedFieldError,
  TemplateError,
} from './errors.js';
import { limitsFromEnv, type Limits, type ReserveResult, type UsageLimiter } from './limiter.js';
import {
  costMicroUsd,
  FALLBACKS,
  isPurpose,
  modelFor,
  type Purpose,
  type TokenUsage,
} from './models.js';
import { redact } from './redact.js';
import {
  getTemplate,
  renderTemplate,
  type Template,
  type TemplateKey,
  type TemplateValue,
  type TemplateVariables,
} from './templates.js';
import type { AiTransport } from './transport.js';

export interface AiGatewayOptions {
  organizationId: string;
  storeId: string;
  purpose: Purpose;
  /** staff_user.id of the person asking; omit for a job. */
  actorId?: string | null;
  transport: AiTransport;
  limiter: UsageLimiter;
  audit: AuditSink;
  /** Default: process.env (AI_ENABLED, AI_MODEL_*, AI_MONTHLY_TOKEN_BUDGET, AI_RATE_LIMIT_PER_MINUTE). */
  env?: NodeJS.ProcessEnv;
  /** Per-store limits; default from env. */
  limits?: Limits;
  now?: () => Date;
}

export interface AiDraft {
  text: string;
  /** `max_tokens` when the draft was cut off; `end_turn` normally. */
  stopReason: string | null;
  model: string;
  servedModel: string;
  usage: TokenUsage;
  costMicroUsd: number;
  latencyMs: number;
  redactions: number;
  auditId: string;
}

export interface AiGateway {
  readonly storeId: string;
  readonly purpose: Purpose;
  readonly model: string;
  complete<K extends TemplateKey>(
    key: K,
    variables: TemplateVariables<K> & NoDeniedFields,
  ): Promise<AiDraft>;
}

/** A rough upper estimate of input tokens before the call: ~3 characters per token (most text is ~4). */
export const estimateInputTokens = (system: string, user: string) =>
  Math.ceil((system.length + user.length) / 3);

/** The input hash of a call refused before rendering (nothing was rendered): the SHA-256 of the empty string. */
export const NO_INPUT_SHA256 = createHash('sha256').update('').digest('hex');

const TEMPLATE_ID = /^[a-z][a-z0-9-]*$/;

export function createAiGateway(opts: AiGatewayOptions): AiGateway {
  if (!isPurpose(opts.purpose)) throw new AiConfigError(`unknown purpose ${String(opts.purpose)}`);
  const env = opts.env ?? process.env;
  const model = modelFor(opts.purpose, env);
  const limits = opts.limits ?? limitsFromEnv(env);
  const now = opts.now ?? (() => new Date());

  async function audit(
    t: Pick<Template, 'id' | 'version'> | null,
    templateKey: string,
    fields: Partial<AuditRecord> & { outcome: AuditOutcome },
  ): Promise<string> {
    // an unknown key is caller input: keep it only when it fits the table's template_id/version checks
    const [idFromKey = '', versionFromKey] = templateKey.split('@');
    const keyVersion = Number(versionFromKey);
    const record: AuditRecord = {
      organizationId: opts.organizationId,
      storeId: opts.storeId,
      actorId: opts.actorId ?? null,
      purpose: opts.purpose,
      templateId: t?.id ?? (TEMPLATE_ID.test(idFromKey) ? idFromKey : 'unknown'),
      templateVersion:
        t?.version ?? (Number.isInteger(keyVersion) && keyVersion >= 1 ? keyVersion : 1),
      inputSha256: NO_INPUT_SHA256,
      redactions: 0,
      model,
      servedModel: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costMicroUsd: 0,
      latencyMs: null,
      errorClass: null,
      ...fields,
    };
    try {
      return await opts.audit.write(record);
    } catch (err) {
      throw new AiAuditError('the AI audit record could not be written; the output is withheld', {
        cause: err,
      });
    }
  }

  // A failed settle leaves the whole reservation counted — the safe side (it over-counts, never under-counts) — and
  // must not cost the audit row of a call that already happened.
  async function settle(deltaTokens: number, at: Date): Promise<void> {
    try {
      await opts.limiter.settle(opts.storeId, deltaTokens, at);
    } catch {
      /* the reservation stands */
    }
  }

  return {
    storeId: opts.storeId,
    purpose: opts.purpose,
    model,
    async complete(key, variables) {
      // 1. template
      let t: Template;
      try {
        t = getTemplate(key);
        if (t.purpose !== opts.purpose) {
          throw new TemplateError(
            `${key} is a ${t.purpose} template; this gateway is for ${opts.purpose}`,
          );
        }
      } catch (err) {
        await audit(null, key, { outcome: 'error', errorClass: (err as Error).name });
        throw err;
      }

      // 2. denylist (runtime half of the guard)
      const denied = findDeniedFields(variables);
      if (denied.length > 0) {
        await audit(t, key, { outcome: 'denied_field', errorClass: 'DeniedFieldError' });
        throw new DeniedFieldError(denied);
      }

      // 3. render, redact, hash
      let system: string;
      let user: string;
      try {
        ({ system, user } = renderTemplate(
          t,
          variables as unknown as Record<string, TemplateValue>,
        ));
      } catch (err) {
        await audit(t, key, { outcome: 'error', errorClass: (err as Error).name });
        throw err;
      }
      const rs = redact(system);
      const ru = redact(user);
      system = rs.text;
      user = ru.text;
      const redactions = rs.total + ru.total;
      const inputSha256 = createHash('sha256').update(`${system}\n\u0000\n${user}`).digest('hex');
      const base = { inputSha256, redactions };

      // 4. kill switch
      if (env.AI_ENABLED !== '1') {
        await audit(t, key, { ...base, outcome: 'disabled', errorClass: 'AiDisabledError' });
        throw new AiDisabledError('AI is switched off (AI_ENABLED is not 1)');
      }

      // 5. budget and rate
      const at = now();
      const reservation = estimateInputTokens(system, user) + t.maxTokens;
      let r: ReserveResult;
      try {
        r = await opts.limiter.reserve(opts.storeId, reservation, limits, at);
      } catch (err) {
        // Redis down: refuse (no call without a budget check), audited with the class only
        const errorClass = (err as Error)?.name || 'Error';
        await audit(t, key, { ...base, outcome: 'error', errorClass });
        throw new AiLimiterError(errorClass, { cause: err });
      }
      if (!r.ok) {
        if (r.reason === 'rate_limited') {
          await audit(t, key, {
            ...base,
            outcome: 'rate_limited',
            errorClass: 'AiRateLimitedError',
          });
          throw new AiRateLimitedError(opts.storeId, r.limitPerMinute);
        }
        await audit(t, key, {
          ...base,
          outcome: 'over_budget',
          errorClass: 'AiBudgetExceededError',
        });
        throw new AiBudgetExceededError(opts.storeId, r.usedTokens, r.limitTokens);
      }

      // 6. the call
      const started = performance.now();
      let res;
      try {
        res = await opts.transport.complete({
          model,
          system,
          user,
          maxTokens: t.maxTokens,
          effort: t.effort,
          fallbacks: FALLBACKS[opts.purpose],
        });
      } catch (err) {
        const latencyMs = Math.round(performance.now() - started);
        await settle(-reservation, at);
        const errorClass =
          err instanceof AiTransportError ? err.errorClass : (err as Error).name || 'Error';
        await audit(t, key, { ...base, outcome: 'error', errorClass, latencyMs });
        throw err instanceof AiError ? err : new AiTransportError(errorClass, { cause: err });
      }
      const latencyMs = Math.round(performance.now() - started);
      const used = res.usage.inputTokens + res.usage.outputTokens;
      await settle(used - reservation, at);
      const cost = costMicroUsd(res.servedModel, res.usage, model);
      const measured = {
        ...base,
        servedModel: res.servedModel,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        cacheReadTokens: res.usage.cacheReadTokens,
        costMicroUsd: cost,
        latencyMs,
      };

      // 7. audit, then return
      if (res.stopReason === 'refusal') {
        await audit(t, key, { ...measured, outcome: 'refused', errorClass: 'AiRefusedError' });
        throw new AiRefusedError(res.refusalCategory);
      }
      const auditId = await audit(t, key, {
        ...measured,
        outcome: res.stopReason === 'max_tokens' ? 'max_tokens' : 'ok',
      });
      return {
        text: res.text,
        stopReason: res.stopReason,
        model,
        servedModel: res.servedModel,
        usage: res.usage,
        costMicroUsd: cost,
        latencyMs,
        redactions,
        auditId,
      };
    },
  };
}
