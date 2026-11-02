// What a reply draft is allowed to know, and what happens when the gateway says no (#610).
//
// No network and no real gateway: the gateway arrives as a port, so these tests assert WHAT WOULD BE SENT,
// which is the question a privacy review asks. The denylist check is the real one, imported from
// `@platform/ai` — the projection's type is the first guard, and this is the second.

import { findDeniedFields, getTemplate } from '@platform/ai';
import { describe, expect, it } from 'vitest';
import { formatMoney, pickOrder, toDraftVariables, type DraftVariables } from './draft-context.js';
import { TEMPLATE_KEY } from './draft-template.js';
import { buildReplyDraft, draftErrorFor, MAX_QUESTION_CHARS } from './reply-draft.js';
import type { SupportContext, SupportOrder } from './types.js';
import { SupportError } from './types.js';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const OLDER_ID = '22222222-2222-4222-8222-222222222222';
const TRACKING = 'JD0002342341234';

const order = (over: Partial<SupportOrder> = {}): SupportOrder => ({
  id: ORDER_ID,
  display_id: 1042,
  status: 'confirmed',
  payment_status: 'authorized',
  fulfillment_status: 'shipped',
  total_minor: 4976,
  currency: 'EUR',
  placed_at: '2026-10-28T09:15:00.000Z',
  payments: [
    { id: 'p1', provider: 'stripe', status: 'authorized', amount_minor: 4976, currency: 'EUR' },
  ],
  refunds: [],
  shipments: [
    {
      id: 's1',
      status: 'shipped',
      carrier: 'DHL',
      tracking_number: TRACKING,
      shipped_at: '2026-10-29T08:00:00.000Z',
      delivered_at: null,
    },
  ],
  returns: [],
  ...over,
});

const context = (over: Partial<SupportContext> = {}): SupportContext => ({
  store_code: 'brand-a',
  customer: {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'ada.lovelace@example.com',
    first_name: 'Ada',
    last_name: 'Lovelace',
    status: 'registered',
    created_at: '2026-01-02T00:00:00.000Z',
  },
  orders: [order()],
  summary: {
    orders_count: 1,
    open_orders: 1,
    cancelled_orders: 0,
    currency: 'EUR',
    gross_minor: 4976,
    refunded_minor: 0,
    last_order_at: '2026-10-28T09:15:00.000Z',
    mixed_currency: false,
  },
  notes: [],
  ...over,
});

const vars = (over: Partial<Parameters<typeof toDraftVariables>[0]> = {}) =>
  toDraftVariables({
    context: context(),
    question: 'Where is my parcel?',
    locale: 'en-GB',
    brandVoice: 'warm and brief',
    ...over,
  });

/** A gateway that records what it was asked and answers a fixed draft. */
function recordingGateway(answer = 'Thanks for writing — your order shipped on 29 October.') {
  const calls: { key: string; variables: DraftVariables }[] = [];
  return {
    calls,
    gateway: {
      model: 'claude-sonnet-5-5',
      async complete(key: string, variables: DraftVariables) {
        calls.push({ key, variables });
        return { text: answer, stopReason: 'end_turn', servedModel: 'claude-sonnet-5-5' };
      },
    },
  };
}

describe('the draft context carries no personal data (#610)', () => {
  it('has exactly the keys the template declares, and no others', () => {
    // A new field here is a new thing sent to a third party, so the key set is pinned rather than sampled.
    expect(Object.keys(vars()!).sort()).toEqual(
      [
        'brandVoice',
        'carrier',
        'deliveredAt',
        'fulfillmentStatus',
        'locale',
        'orderRef',
        'orderStatus',
        'paymentStatus',
        'placedAt',
        'question',
        'refundStatus',
        'refunded',
        'returnRequestedAt',
        'returnStatus',
        'shippedAt',
        'storeCode',
        'total',
      ].sort(),
    );
  });

  it('IS the template declared variable set, both ways (#674 item 1)', () => {
    // The cross-window contract, asserted rather than assumed. `main.ts` compiling without a cast already
    // proves the projection satisfies `TemplateVariables<'support-reply-draft@1'>`; this proves the reverse
    // too — no declared variable is left unset, which would render as a missing fact instead of failing.
    //
    // It is also the test that would have caught #671's `totalMinor` / `currency` / `refundedMinor` against
    // my `total` / `refunded`, which nothing caught until someone read the other side's PR.
    const declared = [...getTemplate(TEMPLATE_KEY).variableNames].sort();
    expect(Object.keys(vars()!).sort()).toEqual(declared);
    expect(declared).toContain('total');
    expect(declared).not.toContain('totalMinor');
  });

  it('passes the gateway denylist, checked with the gateway own check', () => {
    // The projection's TYPE cannot carry `email` or `first_name`; this is the runtime guard from
    // `@platform/ai`, so the two agree. If someone widens the projection, this fails before a review does.
    expect(findDeniedFields(vars())).toEqual([]);
  });

  it('carries no e-mail, no name, no tracking number and no uuid — the whole context is full of them', () => {
    const text = JSON.stringify(vars());
    expect(text).not.toContain('ada.lovelace@example.com');
    expect(text).not.toContain('Ada');
    expect(text).not.toContain('Lovelace');
    // The tracking number is the one an agent may legitimately see but a model does not need: "shipped with
    // DHL on the 29th" is the useful part (the same rule the CDP follows).
    expect(text).not.toContain(TRACKING);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // And the carrier IS there, because a reply needs it.
    expect(vars()!.carrier).toBe('DHL');
  });

  it('sends dates as days, not timestamps', () => {
    const v = vars()!;
    expect(v.placedAt).toBe('2026-10-28');
    expect(v.shippedAt).toBe('2026-10-29');
    expect(v.deliveredAt).toBe('');
  });

  it('leaves an unknown fact EMPTY rather than null, so a missing fact drops the claim', () => {
    const v = toDraftVariables({
      context: context({
        orders: [order({ placed_at: null, shipments: [], refunds: [], returns: [] })],
      }),
      question: 'Any news?',
      locale: 'en-GB',
      brandVoice: 'warm',
    })!;
    expect(v.placedAt).toBe('');
    expect(v.carrier).toBe('');
    expect(v.refundStatus).toBe('');
    expect(v.returnStatus).toBe('');
    expect(JSON.stringify(v)).not.toContain('null');
  });
});

describe('money is formatted here, not by the model', () => {
  it('uses the currency own number of decimals', () => {
    // A model handed `4976` and `EUR` has to divide by a hundred to write a sentence, and nothing tells it
    // that JPY does not work that way. `Intl` knows.
    expect(formatMoney(4976, 'EUR', 'en-GB')).toMatch(/49\.76/);
    expect(formatMoney(4976, 'JPY', 'en-GB')).toMatch(/4,?976/);
    expect(formatMoney(4976, 'JPY', 'en-GB')).not.toMatch(/49\.76/);
  });

  it('falls back to a true statement rather than breaking a draft', () => {
    expect(formatMoney(100, 'NOTACURRENCY', 'en-GB')).toContain('minor units');
    expect(formatMoney(Number.NaN, 'EUR', 'en-GB')).toBe('');
  });
});

describe('which order the draft is about', () => {
  const older = order({
    id: OLDER_ID,
    display_id: 900,
    placed_at: '2026-09-01T00:00:00.000Z',
    shipments: [],
  });

  it('is the one the agent named', () => {
    expect(pickOrder([older, order()], OLDER_ID)?.display_id).toBe(900);
  });

  it('is the most recent when none is named', () => {
    expect(pickOrder([older, order()])?.display_id).toBe(1042);
  });

  it('is nothing when the named order is not this customer', () => {
    expect(pickOrder([order()], OLDER_ID)).toBeNull();
    expect(pickOrder([])).toBeNull();
  });
});

describe('buildReplyDraft', () => {
  it('asks the gateway for the specified template, with the projection', async () => {
    const { calls, gateway } = recordingGateway();
    const draft = await buildReplyDraft({
      gateway,
      context: context(),
      question: 'Where is my parcel?',
      locale: 'en-GB',
      brandVoice: 'warm and brief',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(TEMPLATE_KEY);
    expect(calls[0]!.variables.question).toBe('Where is my parcel?');
    expect(draft.draft).toContain('shipped');
    expect(draft.template).toBe(TEMPLATE_KEY);
    expect(draft.orderRef).toBe('1042');
  });

  it('passes the question through UNCHANGED: redaction is the gateway own step', async () => {
    // Deliberately not sanitised here. A second, half-done redaction in this service would give a false
    // sense of safety and could differ from the gateway's — `packages/ai` redacts e-mail, IBAN, card,
    // address and phone in step 3 of every call, over the text it then hashes for the audit.
    const { calls, gateway } = recordingGateway();
    const question = 'My card 4242 4242 4242 4242 was charged, write to ada@example.com';
    await buildReplyDraft({
      gateway,
      context: context(),
      question,
      locale: 'en-GB',
      brandVoice: 'warm',
    });
    expect(calls[0]!.variables.question).toBe(question);
  });

  it('refuses an empty or oversized question before anything is sent', async () => {
    const { calls, gateway } = recordingGateway();
    const base = { gateway, context: context(), locale: 'en-GB', brandVoice: 'warm' };
    await expect(buildReplyDraft({ ...base, question: '   ' })).rejects.toMatchObject({
      status: 400,
      code: 'validation_error',
    });
    await expect(
      buildReplyDraft({ ...base, question: 'x'.repeat(MAX_QUESTION_CHARS + 1) }),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it('answers 404 when there is no order to speak about, instead of letting the model invent one', async () => {
    const { calls, gateway } = recordingGateway();
    await expect(
      buildReplyDraft({
        gateway,
        context: context({ orders: [] }),
        question: 'Where is my parcel?',
        locale: 'en-GB',
        brandVoice: 'warm',
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(calls).toHaveLength(0);
  });
});

describe('the gateway errors map to the shared codes (#610)', () => {
  // By CLASS NAME rather than `instanceof`: these errors cross a package boundary, and two copies of a
  // package would break `instanceof` silently.
  const named = (name: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error('upstream detail that must not travel'), { name }, extra);

  it.each([
    ['AiDisabledError', 503, 'ai_disabled'],
    ['AiBudgetExceededError', 429, 'ai_budget_exceeded'],
    ['AiRateLimitedError', 429, 'ai_rate_limited'],
    ['AiRefusedError', 422, 'ai_refused'],
    ['AiTransportError', 502, 'ai_unavailable'],
    ['AiLimiterError', 503, 'unavailable'],
    ['AiAuditError', 503, 'unavailable'],
    ['TemplateError', 503, 'unavailable'],
    ['AiConfigError', 503, 'unavailable'],
    ['DeniedFieldError', 500, 'internal'],
  ])('%s → %i %s', (name, status, code) => {
    const err = draftErrorFor(named(name));
    expect(err).toBeInstanceOf(SupportError);
    expect([err.status, err.code]).toEqual([status, code]);
    // The upstream message never travels: ours is the only one a caller sees.
    expect(err.message).not.toContain('upstream detail');
    expect(err.details).toMatchObject({ reason: name });
  });

  it('carries a refusal CATEGORY, which is the one thing an agent can act on', () => {
    const err = draftErrorFor(named('AiRefusedError', { category: 'self_harm' }));
    expect(err.details).toMatchObject({ category: 'self_harm' });
  });

  it('carries Retry-After for a rate limit only', () => {
    expect(
      draftErrorFor(named('AiRateLimitedError', { retryAfterSeconds: 7 })).retryAfterSeconds,
    ).toBe(7);
    expect(
      draftErrorFor(named('AiBudgetExceededError', { retryAfterSeconds: 7 })).retryAfterSeconds,
    ).toBeUndefined();
  });

  it('turns anything unrecognised into a 500 that says nothing', () => {
    const err = draftErrorFor(new Error('kaboom with a token in it'));
    expect([err.status, err.code]).toEqual([500, 'internal']);
    expect(err.message).not.toContain('token');
  });
});
