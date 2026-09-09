// The orders module's payment-status wrappers (window 1, core 2.3, #174 — on main since merge round 8).
// This file was a local mirror of their signatures while #174 was in review; it is now the re-export the
// mirror's header promised, so `capture.ts` and the webhook receiver (2.2) keep one import path and the
// module boundary (ADR 0005: only `../orders`, never its internals) stays explicit in one place.
//
// Semantics we rely on (window 1 owns them): scoped client + ids, own transaction, idempotent on the target
// state, exactly one `order.updated` event, illegal transition → 409 with `{ field, from, to }`.
export { markPaymentCaptured, markPaymentFailed } from '../orders';
