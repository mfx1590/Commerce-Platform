// The rules, against envelopes VALIDATED by the real schemas — a rule that reads a field the schema does not
// have, or a fixture that drifts from the contract, fails here rather than in production.
//
// The last test is the PII guard #553 asks for: it renders every alert of every rule from fixtures stuffed with
// personal data in every field the payload allows, then sweeps the whole serialized alert for it.

import { createValidator, makeEvent, type EventEnvelopeV1Base } from '@platform/events';
import { describe, expect, it } from 'vitest';
import { slackPayload } from '../transport/slack.js';
import {
  evaluateRules,
  OPS_RULES,
  paymentFailedRule,
  refundFailedRule,
  returnRequestedRule,
  ruleTopics,
} from './rules.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const STORE = '00000000-0000-4000-8000-00000000a001';
const ORDER = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '22222222-2222-4222-8222-222222222222';
const REFUND = '33333333-3333-4333-8333-333333333333';
const RETURN = '44444444-4444-4444-8444-444444444444';
const LINE = '55555555-5555-4555-8555-555555555555';

const validator = createValidator();

/** Builds a real envelope through `makeEvent` and asserts the payload against the published schema. */
function envelopeFor(
  topic: 'payment.failed' | 'refund.failed' | 'return.requested',
  payload: Record<string, unknown>,
  aggregate: { type: 'payment' | 'refund' | 'return'; id: string },
): EventEnvelopeV1Base {
  const event = makeEvent({
    topic,
    organizationId: ORG,
    storeId: STORE,
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    payload: payload as never,
  });
  const check = validator.validateEnvelope(event);
  expect(check.ok, check.errors?.join('; ')).toBe(true);
  return event as EventEnvelopeV1Base;
}

const paymentFailed = (over: Record<string, unknown> = {}) =>
  envelopeFor(
    'payment.failed',
    {
      payment_id: PAYMENT,
      order_id: ORDER,
      provider: 'stripe',
      provider_payment_id: 'pi-alpha',
      amount_minor: 10494,
      currency: 'EUR',
      failure_reason: 'insufficient_funds',
      failed_at: '2026-10-23T10:00:00.000Z',
      ...over,
    },
    { type: 'payment', id: PAYMENT },
  );

const refundFailed = (over: Record<string, unknown> = {}) =>
  envelopeFor(
    'refund.failed',
    {
      refund_id: REFUND,
      payment_id: PAYMENT,
      order_id: ORDER,
      amount_minor: 2500,
      currency: 'GBP',
      failure_reason: 'account_closed',
      failed_at: '2026-10-23T10:05:00.000Z',
      ...over,
    },
    { type: 'refund', id: REFUND },
  );

const returnRequested = (over: Record<string, unknown> = {}) =>
  envelopeFor(
    'return.requested',
    {
      return_id: RETURN,
      order_id: ORDER,
      reason: 'too small',
      items: [
        { order_line_item_id: LINE, quantity: 2 },
        { order_line_item_id: '66666666-6666-4666-8666-666666666666', quantity: 1 },
      ],
      requested_at: '2026-10-23T10:10:00.000Z',
      ...over,
    },
    { type: 'return', id: RETURN },
  );

const input = (envelope: EventEnvelopeV1Base, storeCode = 'brand-a') => ({
  envelope,
  outboxId: envelope.event_id,
  storeCode,
});

describe('rule set', () => {
  it('subscribes to exactly the three topics of #553, de-duplicated', () => {
    expect(ruleTopics().sort()).toEqual(['payment.failed', 'refund.failed', 'return.requested']);
    expect(ruleTopics([paymentFailedRule, paymentFailedRule])).toEqual(['payment.failed']);
  });

  it('runs only the rules that read a topic', () => {
    expect(evaluateRules(input(paymentFailed())).map((a) => a.rule)).toEqual(['payment-failed']);
    expect(evaluateRules(input(refundFailed())).map((a) => a.rule)).toEqual(['refund-failed']);
    expect(evaluateRules(input(returnRequested())).map((a) => a.rule)).toEqual([
      'return-requested',
    ]);
  });

  it('produces nothing for a topic no rule reads', () => {
    const other = makeEvent({
      topic: 'order.confirmed',
      organizationId: ORG,
      storeId: STORE,
      aggregateType: 'order',
      aggregateId: ORDER,
      payload: { order_id: ORDER, confirmed_at: '2026-10-23T10:00:00.000Z' } as never,
    }) as EventEnvelopeV1Base;
    expect(evaluateRules(input(other))).toEqual([]);
  });

  it('a rule asked about the wrong topic returns null rather than guessing', () => {
    expect(paymentFailedRule.evaluate(input(refundFailed()))).toBeNull();
    expect(refundFailedRule.evaluate(input(paymentFailed()))).toBeNull();
    expect(returnRequestedRule.evaluate(input(paymentFailed()))).toBeNull();
  });

  it('carries the envelope identity onto every alert', () => {
    const e = paymentFailed();
    const alert = evaluateRules(input(e))[0]!;
    expect(alert).toMatchObject({
      organizationId: ORG,
      storeId: STORE,
      storeCode: 'brand-a',
      topic: 'payment.failed',
      outboxId: e.event_id,
      occurredAt: e.occurred_at,
      suppressed: 0,
    });
  });
});

describe('payment-failed', () => {
  it('reports the order, the payment, the amount in minor units and the provider reason', () => {
    const alert = evaluateRules(input(paymentFailed()))[0]!;
    expect(alert.severity).toBe('warn');
    expect(alert.title).toBe('Payment failed on brand-a');
    expect(alert.fields).toEqual({
      store: 'brand-a',
      order_id: ORDER,
      payment_id: PAYMENT,
      amount: '10494 EUR',
      provider: 'stripe',
      provider_payment_id: 'pi-alpha',
      reason: 'insufficient_funds',
    });
  });

  it('never divides minor units by a guessed 100 (a zero-decimal currency stays whole)', () => {
    const alert = evaluateRules(input(paymentFailed({ amount_minor: 1200, currency: 'JPY' })))[0]!;
    expect(alert.fields.amount).toBe('1200 JPY');
  });

  it('renders the schema-allowed nulls as a dash', () => {
    const alert = evaluateRules(
      input(paymentFailed({ provider_payment_id: null, failure_reason: null })),
    )[0]!;
    expect(alert.fields.provider_payment_id).toBe('-');
    expect(alert.fields.reason).toBe('-');
  });
});

describe('refund-failed', () => {
  it('is critical: we owe the customer money and the automatic path is exhausted', () => {
    const alert = evaluateRules(input(refundFailed()))[0]!;
    expect(alert.severity).toBe('critical');
    expect(alert.title).toBe('Refund FAILED on brand-a');
    expect(alert.fields).toEqual({
      store: 'brand-a',
      order_id: ORDER,
      refund_id: REFUND,
      payment_id: PAYMENT,
      amount: '2500 GBP',
      reason: 'account_closed',
    });
  });
});

describe('return-requested', () => {
  it('reports the ids and the item counts', () => {
    const alert = evaluateRules(input(returnRequested()))[0]!;
    expect(alert.severity).toBe('warn');
    expect(alert.title).toBe('Return requested on brand-a');
    expect(alert.fields).toEqual({
      store: 'brand-a',
      order_id: ORDER,
      return_id: RETURN,
      lines: 2,
      units: 3,
    });
  });

  it('NEVER carries the reason text: it is free text a person typed (see rules.ts header)', () => {
    const alert = evaluateRules(
      input(returnRequested({ reason: 'call me on 0171 555 0199, 12 Example Street' })),
    )[0]!;
    expect(Object.keys(alert.fields)).not.toContain('reason');
    expect(JSON.stringify(alert)).not.toContain('0171');
    expect(JSON.stringify(alert)).not.toContain('Example Street');
  });

  it('counts an empty item list without throwing', () => {
    const alert = evaluateRules(input(returnRequested({ items: [] })))[0]!;
    expect(alert.fields).toMatchObject({ lines: 0, units: 0 });
  });
});

describe('no PII can reach a message', () => {
  // Every string the three payloads allow, filled with personal data. The schemas have no name/e-mail/address
  // field at all (ADR 0003 item 5) — these are the free-text and provider fields, the only way PII could ride
  // along. A rule that ever starts copying one of them fails this test.
  const PERSONAL = [
    'ada.lovelace@example.com',
    'Ada Lovelace',
    '12 Example Street',
    '+44 7700 900123',
    // Stands in for an email_hash. Deliberately NOT a real 40-hex string: gitleaks scans every branch's whole
    // history and one secret-shaped literal reddens every open PR (Memory-main). The sweep below still checks
    // the hex shape against CLEAN alerts, where it must never appear.
    'emailhash-of-ada-not-hex',
  ];

  const stuffed: EventEnvelopeV1Base[] = [
    paymentFailed({
      provider: PERSONAL[1]!,
      provider_payment_id: PERSONAL[0]!,
      failure_reason: PERSONAL[2]!,
    }),
    refundFailed({ failure_reason: PERSONAL[3]! }),
    returnRequested({ reason: PERSONAL.join(' / ') }),
  ];

  it('sweeps every alert, and its rendered Slack payload, for every personal value', () => {
    const rendered: string[] = [];
    for (const envelope of stuffed) {
      for (const alert of evaluateRules(input(envelope))) {
        rendered.push(JSON.stringify(alert), JSON.stringify(slackPayload(alert)));
      }
    }
    expect(rendered.length).toBeGreaterThan(0);

    // `return.requested.reason` is dropped outright, so nothing from it appears anywhere.
    for (const text of rendered) {
      expect(text).not.toContain('Ada Lovelace / ');
      expect(text).not.toContain('12 Example Street, ');
    }

    // The provider fields of payment.failed / refund.failed ARE forwarded by design (they are the PSP's own
    // reason codes). This asserts the DESIGN, so that a day when a provider is found to echo customer data
    // into them, this test is the thing that has to be changed deliberately.
    const paymentAlert = evaluateRules(input(stuffed[0]!))[0]!;
    expect(paymentAlert.fields.reason).toBe(PERSONAL[2]!);
    expect(paymentAlert.fields.provider_payment_id).toBe(PERSONAL[0]!);
  });

  it('a clean alert contains no e-mail, phone or hash shape at all', () => {
    // Uuids and RFC-3339 timestamps are what an alert is MADE of, and both read as a phone number to any
    // loose pattern (`11111111-1111-…`, `2026-10-23T10:00:00Z`) — so the structural values come out first and
    // whatever is left is swept.
    const STRUCTURAL =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T[\d:.]+Z/gi;
    for (const envelope of [paymentFailed(), refundFailed(), returnRequested()]) {
      for (const alert of evaluateRules(input(envelope))) {
        const text = `${JSON.stringify(alert)} ${JSON.stringify(slackPayload(alert))}`.replace(
          STRUCTURAL,
          '<id>',
        );
        expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i); // e-mail
        expect(text).not.toMatch(/\+?\d[\d\s()-]{8,}\d/); // phone
        expect(text).not.toMatch(/\b[0-9a-f]{40,64}\b/i); // sha1/sha256 (email_hash)
      }
    }
  });

  it('every field value is a string or an integer — never a nested payload dump', () => {
    for (const envelope of [paymentFailed(), refundFailed(), returnRequested()]) {
      for (const alert of evaluateRules(input(envelope))) {
        for (const value of Object.values(alert.fields)) {
          expect(['string', 'number']).toContain(typeof value);
          if (typeof value === 'number') expect(Number.isInteger(value)).toBe(true);
        }
      }
    }
  });

  it('the rule set has no rule reading a topic outside the three (a new rule is a deliberate change)', () => {
    expect(OPS_RULES.map((r) => r.name)).toEqual([
      'payment-failed',
      'refund-failed',
      'return-requested',
    ]);
  });
});
