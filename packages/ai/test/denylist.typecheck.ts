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

// support-reply-draft@1 (#667): window 16's projection must never carry a customer's name, e-mail or address
const reply = {
  question: 'where is my order?',
  storeCode: 'brand-a',
  brandVoice: 'warm and brief',
  locale: 'en-GB',
  orderRef: '1042',
  orderStatus: 'processing',
  paymentStatus: 'captured',
  fulfillmentStatus: 'shipped',
  placedAt: '2026-10-24',
  shippedAt: '',
  deliveredAt: '',
  carrier: '',
  total: '€24.95',
  refundStatus: '',
  refunded: '',
  returnStatus: '',
  returnRequestedAt: '',
};
void ai.complete('support-reply-draft@1', reply);

// @ts-expect-error a denylisted customer field in an object literal
void ai.complete('support-reply-draft@1', { ...reply, customerName: 'x' });

const replyWithAddress = { ...reply, street_address: 'x' };
// @ts-expect-error … and in an object built elsewhere
void ai.complete('support-reply-draft@1', replyWithAddress);

// bi-qa-answer@2: locale is required (v1 has none)
const qa = {
  question: 'refunds?',
  today: '2026-11-02',
  window: '2026-10-03..2026-11-03',
  stores: 'brand-a',
  currencyNote: 'per currency',
};
void ai.complete('bi-qa-answer@1', qa);
void ai.complete('bi-qa-answer@2', { ...qa, locale: 'en-GB' });
// @ts-expect-error v2 without locale
void ai.complete('bi-qa-answer@2', qa);
void ai.complete('bi-qa-answer@3', { ...qa, locale: 'en-GB' });
// @ts-expect-error v3 without locale
void ai.complete('bi-qa-answer@3', qa);
// @ts-expect-error locale is not a v1 variable
void ai.complete('bi-qa-answer@1', { ...qa, locale: 'en-GB' });

const { carrier: _carrier, ...replyWithoutCarrier } = reply;
// @ts-expect-error a declared variable is missing
void ai.complete('support-reply-draft@1', replyWithoutCarrier);
