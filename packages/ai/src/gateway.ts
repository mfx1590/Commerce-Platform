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
//   5. reserve the worst case (estimated input + maxTokens) against the month and minute of the store, or of the
//      organization for a call with storeId null (#669; its own budget, never a store's);
//   6. call the model; settle the reservation to the real usage (all of it back after a failure);
//   7. audit; only then return the draft. AI drafts, a human publishes: nothing here publishes anything.
//
// runTools (#669) is the same call in a loop: 1–3 once, then 4–7 for EVERY model step, one audit row per step (with
// the run's conversation id, the step and the tool names it asked for). Between steps the caller's `handle` runs the
// tool calls; each result passes the denylist and redaction before it is sent back.
import { createHash, randomUUID } from 'node:crypto';
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
  AiToolLoopError,
  AiTransportError,
  DeniedFieldError,
  TemplateError,
} from './errors.js';
import {
  limitsFromEnv,
  orgLimitsFromEnv,
  type LimitScope,
  type Limits,
  type ReserveResult,
  type UsageLimiter,
} from './limiter.js';
import {
  costMicroUsd,
  FALLBACKS,
  isPurpose,
  modelFor,
  type Purpose,
  type TokenUsage,
} from './models.js';
import { redact, redactJson } from './redact.js';
import {
  getTemplate,
  renderTemplate,
  type Template,
  type TemplateKey,
  type TemplateValue,
  type TemplateVariables,
} from './templates.js';
import type {
  AiResponse,
  AiTool,
  AiToolCall,
  AiToolResultBlock,
  AiTransport,
  AiTurn,
} from './transport.js';

export interface AiGatewayOptions {
  organizationId: string;
  /** null: an organization-scope call (an HQ question over several stores, #669), with the organization's own budget. */
  storeId: string | null;
  purpose: Purpose;
  /** staff_user.id of the person asking; omit for a job. */
  actorId?: string | null;
  transport: AiTransport;
  limiter: UsageLimiter;
  audit: AuditSink;
  /**
   * Default: process.env (AI_ENABLED, AI_MODEL_*, AI_MONTHLY_TOKEN_BUDGET, AI_ORG_MONTHLY_TOKEN_BUDGET,
   * AI_RATE_LIMIT_PER_MINUTE).
   */
  env?: NodeJS.ProcessEnv;
  /** Per-store limits; default from env. */
  limits?: Limits;
  /** The organization's limits, for storeId null; default from env (orgLimitsFromEnv). */
  orgLimits?: Limits;
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

/** What the caller's tool handler returns: JSON text it made (checked against the denylist, then redacted). */
export interface AiToolResult {
  content: string;
  isError?: boolean;
}

export interface AiToolRunOptions {
  tools: readonly AiTool[];
  /** Runs one tool call (the caller validates `call.input`); a throw ends the run, audited as `error`. */
  handle: (call: AiToolCall) => Promise<AiToolResult>;
  /** Tool calls allowed in the whole run; default 5, at most 8. */
  maxToolCalls?: number;
  /** A ceiling on input + output tokens across all steps of this run. */
  maxTokensTotal?: number;
  /** A uuid on every audit row of this run; default a new one. */
  conversationId?: string;
}

export interface AiToolRun {
  /** The final answer (the last step's text). */
  text: string;
  /** Every tool call, in order. */
  toolCalls: { id: string; name: string; input: unknown; isError: boolean }[];
  /** Model calls made. */
  steps: number;
  /** Of the last step: `end_turn` normally, `max_tokens` when it was cut off (no tool of that step was run). */
  stopReason: string | null;
  /** Summed over the steps. */
  usage: TokenUsage;
  costMicroUsd: number;
  conversationId: string;
  model: string;
  /** Of the last step. */
  servedModel: string;
  template: { id: string; version: number };
  /** One per model step, in order. */
  auditIds: string[];
}

export interface AiGateway {
  readonly storeId: string | null;
  readonly purpose: Purpose;
  readonly model: string;
  complete<K extends TemplateKey>(
    key: K,
    variables: TemplateVariables<K> & NoDeniedFields,
  ): Promise<AiDraft>;
  runTools<K extends TemplateKey>(
    key: K,
    variables: TemplateVariables<K> & NoDeniedFields,
    opts: AiToolRunOptions,
  ): Promise<AiToolRun>;
}

/** A rough upper estimate of input tokens before the call: ~3 characters per token (most text is ~4). */
export const estimateInputTokens = (system: string, user: string) =>
  Math.ceil((system.length + user.length) / 3);

/** The first instant of the next UTC month: when a monthly budget resets. */
export const nextUtcMonth = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

/** The input hash of a call refused before rendering (nothing was rendered): the SHA-256 of the empty string. */
export const NO_INPUT_SHA256 = createHash('sha256').update('').digest('hex');

/** Tool calls a run may make: the default and the hard cap (#669). */
export const DEFAULT_MAX_TOOL_CALLS = 5;
export const MAX_TOOL_CALLS_CAP = 8;

const TEMPLATE_ID = /^[a-z][a-z0-9-]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How an asked-for tool the caller did not offer is audited: never the model's own string. */
const UNKNOWN_TOOL = 'unknown';

/** Per-row fields of a tool-use run's audit rows. */
type RunFields = Pick<AuditRecord, 'conversationId' | 'step' | 'toolNames'>;
const NO_RUN: RunFields = { conversationId: null, step: null, toolNames: [] };

export function createAiGateway(opts: AiGatewayOptions): AiGateway {
  if (!isPurpose(opts.purpose)) throw new AiConfigError(`unknown purpose ${String(opts.purpose)}`);
  const env = opts.env ?? process.env;
  const model = modelFor(opts.purpose, env);
  const orgScope = opts.storeId === null;
  const scope: LimitScope = orgScope
    ? { kind: 'organization', id: opts.organizationId }
    : { kind: 'store', id: opts.storeId as string };
  const limits = orgScope
    ? (opts.orgLimits ?? orgLimitsFromEnv(env))
    : (opts.limits ?? limitsFromEnv(env));
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
      ...NO_RUN,
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
      await opts.limiter.settle(scope, deltaTokens, at);
    } catch {
      /* the reservation stands */
    }
  }

  /** Steps 1–3: the template, the denylist, render + redact. Every refusal is audited (with `run` fields). */
  async function prepare(
    key: string,
    variables: unknown,
    run: RunFields,
  ): Promise<{ t: Template; system: string; user: string; redactions: number }> {
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
      await audit(null, key, { ...run, outcome: 'error', errorClass: (err as Error).name });
      throw err;
    }

    // 2. denylist (runtime half of the guard)
    const denied = findDeniedFields(variables);
    if (denied.length > 0) {
      await audit(t, key, { ...run, outcome: 'denied_field', errorClass: 'DeniedFieldError' });
      throw new DeniedFieldError(denied);
    }

    // 3. render, redact
    let system: string;
    let user: string;
    try {
      ({ system, user } = renderTemplate(t, variables as Record<string, TemplateValue>));
    } catch (err) {
      await audit(t, key, { ...run, outcome: 'error', errorClass: (err as Error).name });
      throw err;
    }
    const rs = redact(system);
    const ru = redact(user);
    return { t, system: rs.text, user: ru.text, redactions: rs.total + ru.total };
  }

  /** Steps 4–5: the kill switch, then reserve against the scope. Every refusal is audited; nothing is sent. */
  async function guard(
    t: Template,
    key: string,
    fields: Partial<AuditRecord>,
    reservation: number,
    at: Date,
  ): Promise<void> {
    // 4. kill switch
    if (env.AI_ENABLED !== '1') {
      await audit(t, key, { ...fields, outcome: 'disabled', errorClass: 'AiDisabledError' });
      throw new AiDisabledError('AI is switched off (AI_ENABLED is not 1)');
    }

    // 5. budget and rate
    let r: ReserveResult;
    try {
      r = await opts.limiter.reserve(scope, reservation, limits, at);
    } catch (err) {
      // Redis down: refuse (no call without a budget check), audited with the class only
      const errorClass = (err as Error)?.name || 'Error';
      await audit(t, key, { ...fields, outcome: 'error', errorClass });
      throw new AiLimiterError(errorClass, { cause: err });
    }
    if (!r.ok) {
      if (r.reason === 'rate_limited') {
        await audit(t, key, {
          ...fields,
          outcome: 'rate_limited',
          errorClass: 'AiRateLimitedError',
        });
        throw new AiRateLimitedError(opts.storeId, r.limitPerMinute, scope.kind);
      }
      await audit(t, key, {
        ...fields,
        outcome: 'over_budget',
        errorClass: 'AiBudgetExceededError',
      });
      throw new AiBudgetExceededError(
        opts.storeId,
        r.usedTokens,
        r.limitTokens,
        scope.kind,
        nextUtcMonth(at),
      );
    }
  }

  /** Step 6: the call; the reservation settles to the real usage (all of it back after a failure, audited). */
  async function call(
    t: Template,
    key: string,
    fields: Partial<AuditRecord>,
    req: { system: string; user: string; turns?: readonly AiTurn[]; tools?: readonly AiTool[] },
    reservation: number,
    at: Date,
  ): Promise<{ res: AiResponse; latencyMs: number; cost: number; measured: Partial<AuditRecord> }> {
    const started = performance.now();
    let res: AiResponse;
    try {
      res = await opts.transport.complete({
        model,
        ...req,
        maxTokens: t.maxTokens,
        effort: t.effort,
        fallbacks: FALLBACKS[opts.purpose],
      });
    } catch (err) {
      const latencyMs = Math.round(performance.now() - started);
      await settle(-reservation, at);
      const errorClass =
        err instanceof AiTransportError ? err.errorClass : (err as Error).name || 'Error';
      await audit(t, key, { ...fields, outcome: 'error', errorClass, latencyMs });
      throw err instanceof AiError ? err : new AiTransportError(errorClass, { cause: err });
    }
    const latencyMs = Math.round(performance.now() - started);
    await settle(res.usage.inputTokens + res.usage.outputTokens - reservation, at);
    const cost = costMicroUsd(res.servedModel, res.usage, model);
    return {
      res,
      latencyMs,
      cost,
      measured: {
        ...fields,
        servedModel: res.servedModel,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        cacheReadTokens: res.usage.cacheReadTokens,
        costMicroUsd: cost,
        latencyMs,
      },
    };
  }

  return {
    storeId: opts.storeId,
    purpose: opts.purpose,
    model,
    async complete(key, variables) {
      const { t, system, user, redactions } = await prepare(key, variables, NO_RUN);
      const inputSha256 = createHash('sha256').update(`${system}\n\u0000\n${user}`).digest('hex');
      const base = { inputSha256, redactions };
      const at = now();
      const reservation = estimateInputTokens(system, user) + t.maxTokens;
      await guard(t, key, base, reservation, at);
      const { res, latencyMs, cost, measured } = await call(
        t,
        key,
        base,
        { system, user },
        reservation,
        at,
      );

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

    async runTools(key, variables, runOpts) {
      // 0. the run's own options; a bad one is the caller's bug (audited as step 0, nothing rendered or sent)
      const given = runOpts.conversationId;
      const conversationId = given && UUID.test(given) ? given : randomUUID();
      const maxToolCalls = runOpts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
      const names = new Set<string>();
      let invalid: string | null = null;
      if (given !== undefined && !UUID.test(given)) invalid = 'conversationId must be a uuid';
      else if (
        !Number.isInteger(maxToolCalls) ||
        maxToolCalls < 1 ||
        maxToolCalls > MAX_TOOL_CALLS_CAP
      )
        invalid = `maxToolCalls must be an integer from 1 to ${MAX_TOOL_CALLS_CAP}`;
      else if (
        runOpts.maxTokensTotal !== undefined &&
        (!Number.isInteger(runOpts.maxTokensTotal) || runOpts.maxTokensTotal < 1)
      )
        invalid = 'maxTokensTotal must be a positive integer';
      else if (runOpts.tools.length === 0) invalid = 'a tool-use run needs at least one tool';
      for (const tool of runOpts.tools) {
        if (invalid) break;
        if (!TOOL_NAME.test(tool.name) || tool.name === UNKNOWN_TOOL)
          invalid = `tool name ${JSON.stringify(tool.name)} must match ${TOOL_NAME} and not be "${UNKNOWN_TOOL}"`;
        else if (names.has(tool.name)) invalid = `tool ${tool.name} is offered twice`;
        else if (tool.inputSchema?.type !== 'object')
          invalid = `tool ${tool.name}: inputSchema.type must be "object"`;
        names.add(tool.name);
      }
      const first: RunFields = { conversationId, step: 0, toolNames: [] };
      if (invalid) {
        await audit(null, key, { ...first, outcome: 'error', errorClass: 'AiConfigError' });
        throw new AiConfigError(invalid);
      }

      // 1–3 once
      const { t, system, user, redactions: rendered } = await prepare(key, variables, first);
      const tools = runOpts.tools;
      // the tool definitions are sent with every step, so they count toward its input estimate
      const toolsText = JSON.stringify(tools);
      const turns: AiTurn[] = [];
      // what the turns contribute to the hash: the assistant's text and tool calls, and the redacted results — never
      // the transport's opaque blocks, so the hash does not depend on the transport
      const hashed: unknown[] = [];
      let redactions = rendered;
      const toolCalls: AiToolRun['toolCalls'] = [];
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      let cost = 0;
      const auditIds: string[] = [];

      for (let step = 0; ; step++) {
        const inputSha256 = createHash('sha256')
          .update(
            hashed.length
              ? `${system}\n\u0000\n${user}\n\u0000\n${JSON.stringify(hashed)}`
              : `${system}\n\u0000\n${user}`,
          )
          .digest('hex');
        const base: Partial<AuditRecord> = {
          conversationId,
          step,
          toolNames: [],
          inputSha256,
          redactions,
        };

        // 4–5 for every step: the run's ceiling first, then the kill switch and the scope's budget and minute
        const at = now();
        const turnsText = turns.length ? JSON.stringify(turns) : '';
        const reservation = estimateInputTokens(system, user + turnsText + toolsText) + t.maxTokens;
        const usedSoFar = usage.inputTokens + usage.outputTokens;
        if (
          runOpts.maxTokensTotal !== undefined &&
          usedSoFar + reservation > runOpts.maxTokensTotal
        ) {
          await audit(t, key, {
            ...base,
            outcome: 'over_budget',
            errorClass: 'AiBudgetExceededError',
          });
          throw new AiBudgetExceededError(
            opts.storeId,
            usedSoFar,
            runOpts.maxTokensTotal,
            'run',
            null,
          );
        }
        await guard(t, key, base, reservation, at);

        // 6. the call
        const {
          res,
          cost: stepCost,
          measured,
        } = await call(t, key, base, { system, user, turns: [...turns], tools }, reservation, at);
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;
        usage.cacheReadTokens += res.usage.cacheReadTokens;
        cost += stepCost;
        const asked = res.toolUse.map((c) => (names.has(c.name) ? c.name : UNKNOWN_TOOL));
        const stepFields = { ...measured, toolNames: asked };

        const finish = (auditId: string): AiToolRun => ({
          text: res.text,
          toolCalls,
          steps: step + 1,
          stopReason: res.stopReason,
          usage,
          costMicroUsd: cost,
          conversationId,
          model,
          servedModel: res.servedModel,
          template: { id: t.id, version: t.version },
          auditIds: [...auditIds, auditId],
        });

        // 7. per step: refusal, truncation, a final answer, or tool calls
        if (res.stopReason === 'refusal') {
          await audit(t, key, { ...stepFields, outcome: 'refused', errorClass: 'AiRefusedError' });
          throw new AiRefusedError(res.refusalCategory);
        }
        if (res.stopReason === 'max_tokens') {
          // cut off: a tool call in it may be incomplete, so none is run (manager, 2026-11-01)
          return finish(await audit(t, key, { ...stepFields, outcome: 'max_tokens' }));
        }
        if (res.toolUse.length === 0) {
          return finish(await audit(t, key, { ...stepFields, outcome: 'ok' }));
        }
        if (toolCalls.length + res.toolUse.length > maxToolCalls) {
          await audit(t, key, {
            ...stepFields,
            outcome: 'tool_loop_cap',
            errorClass: 'AiToolLoopError',
          });
          throw new AiToolLoopError(maxToolCalls);
        }

        // the tool calls, in order; every result is checked and redacted before it can be sent
        const results: AiToolResultBlock[] = [];
        for (const c of res.toolUse) {
          if (!names.has(c.name)) {
            results.push({ toolUseId: c.id, content: 'unknown tool', isError: true });
            toolCalls.push({ id: c.id, name: c.name, input: c.input, isError: true });
            continue;
          }
          let out: AiToolResult;
          try {
            out = await runOpts.handle(c);
            if (typeof out?.content !== 'string')
              throw new TypeError('a tool result content must be a string');
          } catch (err) {
            await audit(t, key, {
              ...stepFields,
              outcome: 'error',
              errorClass: (err as Error)?.name || 'Error',
            });
            throw err;
          }
          let parsed: unknown;
          let isJson = true;
          try {
            parsed = JSON.parse(out.content);
          } catch {
            parsed = undefined; // plain text: no keys to check; still redacted below
            isJson = false;
          }
          const denied = findDeniedFields(parsed);
          if (denied.length > 0) {
            await audit(t, key, {
              ...stepFields,
              outcome: 'denied_field',
              errorClass: 'DeniedFieldError',
            });
            throw new DeniedFieldError(denied);
          }
          // JSON: only its strings are redacted, so figures and the JSON itself survive; plain text as a whole
          const r = isJson ? redactJson(out.content) : redact(out.content);
          redactions += r.total;
          const isError = out.isError === true;
          results.push({ toolUseId: c.id, content: r.text, isError });
          toolCalls.push({ id: c.id, name: c.name, input: c.input, isError });
        }

        auditIds.push(await audit(t, key, { ...stepFields, outcome: 'ok' }));
        turns.push(
          { role: 'assistant', content: res.assistantContent },
          { role: 'user', toolResults: results },
        );
        hashed.push(
          { text: res.text, toolUse: res.toolUse.map((c) => ({ name: c.name, input: c.input })) },
          results.map((r) => ({ content: r.content, isError: r.isError })),
        );
      }
    },
  };
}
