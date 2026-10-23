// Posting failures. The consumer SDK records `err.name` as the dead letter's error class, so every failure has a
// stable name; the message carries ids and amounts only (never PII — the events carry none anyway).
export class PostingError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** A later event arrived before the order.placed that builds the projection (cross-topic lag). Retryable. */
export class OrderProjectionMissingError extends PostingError {
  constructor(orderId: string, topic: string) {
    super('OrderProjectionMissing', `${topic}: no projection for order ${orderId} yet`);
  }
}

export class ShipmentExceedsOrderError extends PostingError {
  constructor(lineId: string, shipped: number, quantity: number) {
    super(
      'ShipmentExceedsOrder',
      `line ${lineId}: ${shipped} shipped in total, ${quantity} ordered`,
    );
  }
}

export class UnknownOrderLineError extends PostingError {
  constructor(orderId: string, lineId: string) {
    super('UnknownOrderLine', `order ${orderId} has no line ${lineId}`);
  }
}

export class ShipmentOfCancelledOrderError extends PostingError {
  constructor(orderId: string, shipmentId: string) {
    super('ShipmentOfCancelledOrder', `shipment ${shipmentId} of cancelled order ${orderId}`);
  }
}

export class DuplicateOrderPlacedError extends PostingError {
  constructor(orderId: string, first: string, second: string) {
    super(
      'DuplicateOrderPlaced',
      `order ${orderId} was placed by event ${first} and again by event ${second}`,
    );
  }
}

export class UnbalancedEntryError extends PostingError {
  constructor(sourceEventId: string, currency: string, debit: number, credit: number) {
    super(
      'UnbalancedEntry',
      `event ${sourceEventId}: ${currency} debits ${debit} ≠ credits ${credit}`,
    );
  }
}

export class AccountCollisionError extends PostingError {
  constructor(sourceEventId: string, account: string) {
    super(
      'AccountCollision',
      `event ${sourceEventId} posts account ${account} in two entries (UNIQUE source_event_id, account_code)`,
    );
  }
}

export class InvalidEventError extends PostingError {
  constructor(eventId: string, errors: string[]) {
    super('InvalidEvent', `event ${eventId}: ${errors.join('; ')}`);
  }
}

export class ForeignOrganizationError extends PostingError {
  constructor(eventId: string) {
    super('ForeignOrganization', `event ${eventId} belongs to another organization`);
  }
}

export class UnsupportedTopicError extends PostingError {
  constructor(topic: string) {
    super('UnsupportedTopic', `${topic} is not a ledger topic`);
  }
}
