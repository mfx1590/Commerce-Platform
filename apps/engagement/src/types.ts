// What an ops alert is, and what a transport may know about it.
//
// PII rule (ADR 0003 item 5, #553): an alert is built from an event envelope, which carries no personal data,
// and from the store CODE, which is looked up by id. `fields` therefore holds ids, integer minor-unit amounts,
// currency codes, counts and provider reason codes only — never a name, address, phone number, e-mail or
// `email_hash`. `rules.ts` decides what goes in; `ops/rules.test.ts` sweeps every rendered alert for the
// shapes that must never appear.

/** How loud an alert is. `critical` = money or a customer is stuck; `warn` = a human should look today. */
export type AlertSeverity = 'warn' | 'critical';

export interface Alert {
  /** The rule that produced it, e.g. `payment-failed` — also the rate-limit key with the store. */
  rule: string;
  severity: AlertSeverity;
  /** One line, no payload dump: what happened and to which store. */
  title: string;
  /** Ids, amounts in minor units, currency, counts, provider reason codes. Never PII. */
  fields: Record<string, string | number>;
  organizationId: string;
  /** Null for an organization-scope event (no store). */
  storeId: string | null;
  /** The store's `code` when it resolves, else the uuid, else `organization`. */
  storeCode: string;
  /** The event this came from — `dlq-depth` alerts carry the poller's own pseudo-topic. */
  topic: string;
  /** The outbox id (= `event_id`), the idempotency key everything dedupes on. Empty for poll alerts. */
  outboxId: string;
  occurredAt: string;
  /**
   * How many alerts of this (rule, store) the rate limit dropped since the last one that went out. 0 normally;
   * a burst therefore reports its own size instead of hiding it.
   */
  suppressed: number;
}

/** A log line this service may write: ids and classes only, never an alert's `fields` or a webhook URL. */
export interface EngagementLogLine {
  service: 'engagement';
  module: 'ops';
  event:
    | 'alert_sent'
    | 'alert_suppressed'
    | 'alert_failed'
    | 'duplicate'
    | 'dlq_poll'
    | 'started'
    | 'stopped';
  rule?: string;
  severity?: AlertSeverity;
  store_code?: string;
  topic?: string;
  outbox_id?: string;
  group_id?: string;
  depth?: number;
  /** True when the queue could not be READ: `depth` is then unknown, not zero (#646). */
  unreadable?: boolean;
  threshold?: number;
  suppressed?: number;
  transport?: string;
  error_class?: string;
}
