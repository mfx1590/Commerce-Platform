// What the CDP side of this service deals in (#554).
//
// The three calls are RudderStack's (and Segment's) vocabulary, because that is the first adapter: `identify`
// sets traits on a person, `track` records something they did, `suppress` is the regulation that deletes and
// suppresses them. The mapper produces these; an adapter sends them.
//
// PII rule, as in the ops alerts: events carry none (ADR 0003 item 5), and nothing here adds any. Properties
// and traits hold ids, integer minor-unit amounts with their currency, countries, counts, carrier names and
// `email_hash`. `data/cdp/tracking-plan.json` is the written record of exactly which, and a test walks every
// mapped call for e-mail, name, address and phone shapes.

/** How a person is addressed in the CDP. `userId` is our `customer_id`; `anonymousId` is an `email_hash`. */
export interface CdpIdentity {
  /** Our customer id, when the event or the order row gives one. */
  userId: string | null;
  /** `email_hash` — never reversible, never the upsert key for a known customer. */
  anonymousId: string | null;
}

export type CdpCallKind = 'identify' | 'track' | 'suppress';

export interface CdpIdentifyCall {
  kind: 'identify';
  identity: CdpIdentity;
  traits: Record<string, string | number | boolean>;
  /** The event's `occurred_at`: a CDP orders traits by when the fact happened, not when we sent it. */
  timestamp: string;
  /** The outbox id, so a send is traceable to the event and an adapter can make it idempotent. */
  messageId: string;
}

export interface CdpTrackCall {
  kind: 'track';
  /** The plan's event name, e.g. `Order Completed`. */
  event: string;
  identity: CdpIdentity;
  properties: Record<string, string | number | boolean | string[]>;
  timestamp: string;
  messageId: string;
}

/** A deletion/suppression regulation: the identity and nothing else. */
export interface CdpSuppressCall {
  kind: 'suppress';
  identity: CdpIdentity;
  timestamp: string;
  messageId: string;
}

export type CdpCall = CdpIdentifyCall | CdpTrackCall | CdpSuppressCall;

/**
 * Where CDP calls go. One method per call kind so an adapter cannot silently drop one, and so the in-memory
 * mock is a complete implementation rather than a partial stub.
 */
export interface CdpAdapter {
  readonly name: string;
  identify(call: CdpIdentifyCall): Promise<void>;
  track(call: CdpTrackCall): Promise<void>;
  suppress(call: CdpSuppressCall): Promise<void>;
}

/** Send any call through its method — so the consumer never switches on the kind itself. */
export async function sendCall(adapter: CdpAdapter, call: CdpCall): Promise<void> {
  switch (call.kind) {
    case 'identify':
      return adapter.identify(call);
    case 'track':
      return adapter.track(call);
    case 'suppress':
      return adapter.suppress(call);
  }
}

/** A CDP refused a call. Carries the provider, the status and its error name — never the body, never traits. */
export class CdpError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'CdpError';
    this.retryable = opts.retryable ?? false;
  }
}
