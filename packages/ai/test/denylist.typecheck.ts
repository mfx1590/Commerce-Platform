// Compile-time half of the denylist guard (D8, #605). Not a vitest file: `pnpm --filter @platform/ai typecheck`
// compiles it (tsconfig.test.json) and each `@ts-expect-error` FAILS the typecheck if the line becomes valid.
import type { AiGateway } from '../src/index.js';

declare const ai: AiGateway;

const ok = {
  brandVoice: 'warm and plain',
  locale: 'nl-NL',
  productTitle: 'Linen shirt',
  attributes: ['linen', 'size M'],
  audience: 'adults',
};
void ai.complete('product-copy-draft@1', ok);

// @ts-expect-error a denylisted customer field in an object literal
void ai.complete('product-copy-draft@1', { ...ok, email: 'x' });

const withPhone = { ...ok, phone_number: 'x' };
// @ts-expect-error … and in an object built elsewhere (no excess-property check applies there)
void ai.complete('product-copy-draft@1', withPhone);

const withAddress: typeof ok & { postalCode: string } = { ...ok, postalCode: 'x' };
// @ts-expect-error … and through a declared type
void ai.complete('product-copy-draft@1', withAddress);

// @ts-expect-error a declared variable is missing
void ai.complete('product-copy-draft@1', { locale: 'nl-NL' });

// @ts-expect-error an unknown template
void ai.complete('no-such-template@1', ok);
