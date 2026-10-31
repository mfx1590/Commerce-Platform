// The one live call (#605): a single drafting call through the real SDK and the full gateway, run BY HAND and only
// with the manager's OK. It prints the model, the tokens, the latency and the cost estimate — never the prompt, the
// draft, or the key. Nothing in CI runs this.
//
//   pnpm --filter @platform/ai live-smoke -- --live-ok
//
// The key is read from the repo-root .env as AI_ANTHROPIC_API_KEY (never ANTHROPIC_API_KEY) into a local env object;
// process.env is not touched, so nothing downstream can pick it up.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAiGateway,
  createAnthropicTransport,
  createMemoryAuditSink,
  createMemoryLimiter,
} from '../dist/index.js';

if (!process.argv.includes('--live-ok')) {
  console.error(
    "live-smoke: refusing without --live-ok (one billed call; needs the manager's OK first)",
  );
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = resolve(root, '.env');
if (!existsSync(envFile)) {
  console.error(`live-smoke: ${envFile} not found`);
  process.exit(2);
}

// only the AI_* lines; values are never echoed
const env = {};
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*(AI_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
env.AI_ENABLED = '1'; // this script is the deliberate exception to the kill switch

const audit = createMemoryAuditSink();
const ai = createAiGateway({
  organizationId: '00000000-0000-4000-8000-00000000a1a1',
  storeId: '00000000-0000-4000-8000-00000000a1a2',
  purpose: 'drafting',
  transport: createAnthropicTransport({ env, maxRetries: 0, timeoutMs: 60_000 }),
  limiter: createMemoryLimiter(),
  audit,
  env,
});

try {
  const d = await ai.complete('product-copy-draft@1', {
    brandVoice: 'warm and brief',
    locale: 'en-GB',
    audience: 'everyone',
    productTitle: 'Linen tea towel',
    attributes: ['100% linen', '50 x 70 cm'],
  });
  console.log(
    JSON.stringify(
      {
        model: d.model,
        servedModel: d.servedModel,
        stopReason: d.stopReason,
        inputTokens: d.usage.inputTokens,
        outputTokens: d.usage.outputTokens,
        cacheReadTokens: d.usage.cacheReadTokens,
        latencyMs: d.latencyMs,
        costMicroUsd: d.costMicroUsd,
        draftChars: d.text.length,
      },
      null,
      2,
    ),
  );
} catch (err) {
  const rec = audit.records.at(-1);
  console.error(
    `live-smoke: ${err?.name ?? 'Error'} (outcome ${rec?.outcome ?? 'n/a'}, class ${rec?.errorClass ?? 'n/a'})`,
  );
  process.exit(1);
}
