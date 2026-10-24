// The support-context API (#556): "who is this customer and what happened to their orders", for an agent.
//
// THE RULE THAT SHAPES EVERYTHING HERE (manager decision on #556): the data is read from the core Admin API
// with the AGENT'S OWN TOKEN. Not a service principal — unlike CRM sync (#555), which has no human in the
// request and therefore needs one. An agent sees exactly what their `support` role may see, the core decides
// that as it always does, and **no copy of any of it is kept**: nothing is cached, nothing is written, and the
// response is assembled per request and forgotten.
//
// This is a read-only projection of what the core already answers. It exists because a Chatwoot dashboard
// cannot make six Admin API calls and join them, not because we hold anything the core does not.

/** What the agent is told about the customer. The same fields the Admin API returns, nothing added. */
export interface SupportCustomer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: 'guest' | 'registered' | 'disabled' | 'erased';
  created_at: string | null;
}

/** One payment on an order, as the agent needs to see it. Money is integer minor units. */
export interface SupportPayment {
  id: string;
  provider: string;
  status: string;
  amount_minor: number;
  currency: string;
}

export interface SupportRefund {
  id: string;
  status: string;
  amount_minor: number;
  currency: string;
  reason: string | null;
}

export interface SupportShipment {
  id: string;
  status: string;
  carrier: string | null;
  /** The agent is the one person who legitimately needs this: it is what the customer is asking about. */
  tracking_number: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
}

export interface SupportReturn {
  id: string;
  status: string;
  requested_at: string | null;
}

/** One order and everything that happened to it. */
export interface SupportOrder {
  id: string;
  display_id: number;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  total_minor: number;
  currency: string;
  placed_at: string | null;
  payments: SupportPayment[];
  refunds: SupportRefund[];
  shipments: SupportShipment[];
  returns: SupportReturn[];
}

/** The whole answer: the customer, their orders, and a summary an agent can read in one glance. */
export interface SupportContext {
  store_code: string;
  customer: SupportCustomer;
  orders: SupportOrder[];
  summary: {
    orders_count: number;
    /** Open = not completed and not cancelled: what an agent is usually being asked about. */
    open_orders: number;
    cancelled_orders: number;
    currency: string;
    /** Gross of the counting orders in the store's currency, minor units. */
    gross_minor: number;
    refunded_minor: number;
    last_order_at: string | null;
    /** True when the customer has orders in a currency other than the store's: the totals are then partial. */
    mixed_currency: boolean;
  };
  /**
   * What this answer did NOT include and why, so an agent is never silently shown a partial history: e.g. an
   * order whose detail could not be read. Empty in the ordinary case.
   */
  notes: string[];
}

/** The agent's principal, as the server resolved it. Carries no token onward except where a read needs it. */
export interface AgentPrincipal {
  /** `staff_user.id` — the OpenFGA subject. */
  staffUserId: string;
  /** The Keycloak subject. */
  subject: string;
  /** The raw Authorization header value, forwarded to the Admin API so the core checks the agent too. */
  authorization: string;
}

export class SupportError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SupportError';
    this.status = status;
    this.code = code;
  }
}
