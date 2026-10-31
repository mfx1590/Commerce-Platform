// Model registry and price table (D8, #605). One model per purpose, overridable by env, but only to a model whose
// price is known here: every call's cost is estimated and audited, so an unpriced model is a configuration error.
import { AiConfigError } from './errors.js';

export const PURPOSES = ['drafting', 'classification'] as const;
export type Purpose = (typeof PURPOSES)[number];

export const DEFAULT_MODELS: Readonly<Record<Purpose, string>> = {
  drafting: 'claude-sonnet-5-5',
  classification: 'claude-haiku-5-5',
};

const MODEL_ENV: Readonly<Record<Purpose, string>> = {
  drafting: 'AI_MODEL_DRAFTING',
  classification: 'AI_MODEL_CLASSIFICATION',
};

/**
 * Prices in nano-USD per token (USD per million tokens × 1000), so Haiku's $0.10 / MTok is an integer.
 * Source: Anthropic's published first-party rates (cached 2026-10-06). Haiku 5.5's rates apply to prompts up to
 * 100K tokens; the gateway's templates stay far below that. The cache-read rate for Haiku 5.5 is not published in
 * the table we use; 10 % of the input rate is assumed (the ratio of the other models).
 */
export interface ModelPrice {
  inputNanoUsd: number;
  outputNanoUsd: number;
  cacheReadNanoUsd: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-5-5': { inputNanoUsd: 2_000, outputNanoUsd: 10_000, cacheReadNanoUsd: 200 },
  'claude-haiku-5-5': { inputNanoUsd: 100, outputNanoUsd: 500, cacheReadNanoUsd: 10 },
  'claude-opus-5-5': { inputNanoUsd: 4_000, outputNanoUsd: 20_000, cacheReadNanoUsd: 200 },
};

/**
 * Whether the API's server-side refusal fallback is requested for this purpose. OFF for both in Phase 5 (manager,
 * 2026-10-31): a refusal returns AiRefusedError to the human, who rewords and retries — no beta header, no second
 * model the template was not written for, no unpredictable spend on gift credit. The transport still supports it and
 * the served model is audited either way, so turning it on later is this table only.
 */
export const FALLBACKS: Readonly<Record<Purpose, boolean>> = {
  drafting: false,
  classification: false,
};

export function isPurpose(value: unknown): value is Purpose {
  return typeof value === 'string' && (PURPOSES as readonly string[]).includes(value);
}

/** The model for a purpose: the env override if set (and priced), else the default. */
export function modelFor(purpose: Purpose, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[MODEL_ENV[purpose]]?.trim();
  const model = override || DEFAULT_MODELS[purpose];
  if (!PRICES[model]) {
    throw new AiConfigError(
      `${MODEL_ENV[purpose]}=${model} has no price in packages/ai (cost could not be estimated); priced: ${Object.keys(PRICES).join(', ')}`,
    );
  }
  return model;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** Cost in integer micro-USD, rounded up (money is never a float). Unknown model → the requested model's price. */
export function costMicroUsd(model: string, usage: TokenUsage, fallbackModel?: string): number {
  const price = PRICES[model] ?? (fallbackModel ? PRICES[fallbackModel] : undefined);
  if (!price) return 0;
  const nano =
    usage.inputTokens * price.inputNanoUsd +
    usage.outputTokens * price.outputNanoUsd +
    usage.cacheReadTokens * price.cacheReadNanoUsd;
  return Math.ceil(nano / 1000);
}
