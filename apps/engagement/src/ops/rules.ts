// The ops-alert rules. One file, as #553 asks.
//
// Every rule is a PURE function of (envelope, store code) -> Alert | null, so the whole rule set is tested
// against schema-validated fixtures with no broker, no database and no transport. The consumer does the
// plumbing; nothing here reads a clock, a socket or a file.
//
// What may go in an alert: ids, integer minor-unit amounts with their currency, counts, store code, provider
// names and provider reason codes. What may not: anything a human typed or that identifies a person. Two
// judgement calls worth knowing about:
//
//  * `payment.failed.failure_reason` and `refund.failed.failure_reason` ARE included. They are the PSP's reason
//    code (`insufficient_funds`, `card_declined`) and they are the first thing an operator needs. They come
//    from the provider, not from a person.
//  * `return.requested.reason` is NOT included, although the schema has it. It is free text that a customer or
//    an agent typed in a form, so it is the one field in these three topics that can contain a phone number or
//    an address. The alert carries the return id, the order id and the item counts; whoever opens the return in
//    the admin reads the reason there, behind a permission check.

import type { EventEnvelopeV1Base, EventTopic } from '@platform/events';
import type { Alert, AlertSeverity } from '../types.js';

/** What a rule is given: the decoded envelope, its outbox id, and the resolved store code. */
export interface RuleInput {
  envelope: EventEnvelopeV1Base;
  outboxId: string;
  storeCode: string;
}

export interface Rule {
  /** Stable name: the rate-limit key with the store, and what a log line reports. */
  readonly name: string;
  /** The event topics this rule reads. The consumer subscribes to the union of every rule's topics. */
  readonly topics: readonly EventTopic[];
  readonly severity: AlertSeverity;
  /** `null` = nothing to say about this event. */
  evaluate(input: RuleInput): Alert | null;
}

/** Shared envelope → alert skeleton, so no rule can forget a field or invent one. */
function base(
  input: RuleInput,
  rule: string,
  severity: AlertSeverity,
  title: string,
  fields: Record<string, string | number>,
): Alert {
  return {
    rule,
    severity,
    title,
    fields,
    organizationId: input.envelope.organization_id,
    storeId: input.envelope.store_id ?? null,
    storeCode: input.storeCode,
    topic: input.envelope.topic,
    outboxId: input.outboxId,
    occurredAt: input.envelope.occurred_at,
    suppressed: 0,
  };
}

/** `10494` + `EUR` → `10494 EUR`. Minor units stay integers: no locale, no division by a guessed 100. */
function money(amountMinor: number, currency: string): string {
  return `${amountMinor} ${currency}`;
}

/** A payload field that may be null in the schema; `-` reads better than `null` in a Slack line. */
function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '-' : value;
}

/**
 * A payment could not be authorized or captured: the order is stuck before money moved. Loud but not critical —
 * the customer sees the failure at checkout and usually retries.
 */
export const paymentFailedRule: Rule = {
  name: 'payment-failed',
  topics: ['payment.failed'],
  severity: 'warn',
  evaluate(input) {
    if (input.envelope.topic !== 'payment.failed') return null;
    const p = input.envelope.payload as {
      payment_id: string;
      order_id: string;
      provider: string;
      provider_payment_id: string | null;
      amount_minor: number;
      currency: string;
      failure_reason: string | null;
    };
    return base(input, this.name, this.severity, `Payment failed on ${input.storeCode}`, {
      store: input.storeCode,
      order_id: p.order_id,
      payment_id: p.payment_id,
      amount: money(p.amount_minor, p.currency),
      provider: p.provider,
      provider_payment_id: orDash(p.provider_payment_id),
      reason: orDash(p.failure_reason),
    });
  },
};

/**
 * A refund the PSP refused: we owe a customer money and the automatic path is exhausted. Critical — nobody
 * else finds out, because the customer is waiting for a bank entry, not for a page to load.
 */
export const refundFailedRule: Rule = {
  name: 'refund-failed',
  topics: ['refund.failed'],
  severity: 'critical',
  evaluate(input) {
    if (input.envelope.topic !== 'refund.failed') return null;
    const p = input.envelope.payload as {
      refund_id: string;
      payment_id: string;
      order_id: string;
      amount_minor: number;
      currency: string;
      failure_reason: string | null;
    };
    return base(input, this.name, this.severity, `Refund FAILED on ${input.storeCode}`, {
      store: input.storeCode,
      order_id: p.order_id,
      refund_id: p.refund_id,
      payment_id: p.payment_id,
      amount: money(p.amount_minor, p.currency),
      reason: orDash(p.failure_reason),
    });
  },
};

/**
 * A return was opened: the support queue has a new item. Deliberately NOT carrying the customer's reason text
 * (see the file header) — ids and quantities only.
 */
export const returnRequestedRule: Rule = {
  name: 'return-requested',
  topics: ['return.requested'],
  severity: 'warn',
  evaluate(input) {
    if (input.envelope.topic !== 'return.requested') return null;
    const p = input.envelope.payload as {
      return_id: string;
      order_id: string;
      items: { order_line_item_id: string; quantity: number }[];
    };
    const units = p.items.reduce((sum, i) => sum + i.quantity, 0);
    return base(input, this.name, this.severity, `Return requested on ${input.storeCode}`, {
      store: input.storeCode,
      order_id: p.order_id,
      return_id: p.return_id,
      lines: p.items.length,
      units,
    });
  },
};

/** The rule set the ops consumer runs. Order is the order alerts are emitted in for one event. */
export const OPS_RULES: readonly Rule[] = [
  paymentFailedRule,
  refundFailedRule,
  returnRequestedRule,
];

/** Every topic the rule set needs — what `createOpsConsumer` subscribes to. */
export function ruleTopics(rules: readonly Rule[] = OPS_RULES): EventTopic[] {
  return [...new Set(rules.flatMap((r) => [...r.topics]))];
}

/** Run every rule that reads this topic. Usually one alert; the shape allows a topic with two readers. */
export function evaluateRules(input: RuleInput, rules: readonly Rule[] = OPS_RULES): Alert[] {
  const out: Alert[] = [];
  for (const rule of rules) {
    if (!rule.topics.includes(input.envelope.topic)) continue;
    const alert = rule.evaluate(input);
    if (alert) out.push(alert);
  }
  return out;
}
