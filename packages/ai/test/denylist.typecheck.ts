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

// product-copy-draft@2 (#608): the same guard, plus the new `fields` variable is required there and unknown in v1
const v2 = { ...ok, fields: 'description, bullets' };
void ai.complete('product-copy-draft@2', v2);

// @ts-expect-error a denylisted customer field in v2
void ai.complete('product-copy-draft@2', { ...v2, emailAddress: 'x' });

const v2WithName = { ...v2, firstName: 'x' };
// @ts-expect-error … built elsewhere
void ai.complete('product-copy-draft@2', v2WithName);

// @ts-expect-error v2 without fields
void ai.complete('product-copy-draft@2', ok);

// @ts-expect-error fields is not a v1 variable
void ai.complete('product-copy-draft@1', { ...ok, fields: 'title' });
