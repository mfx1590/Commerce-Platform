-- 0193 order.payment_status gains voided (CONTRACT CHANGE #466, window 1; manager decision 2026-10-15; Admin API
-- 0.4.15, Store API 0.5.5, events 0.3.4). cancelOrder releases an authorized, uncaptured payment; the order mirrors
-- it as `voided` (authorized → voided, terminal) instead of still reading `authorized`.
-- The one db statement of #466: widen the CHECK that 0006 declared inline on the column (auto-named
-- order_payment_status_check; the name verified in pg_constraint). No data update and no backfill (the decision on
-- #466): the core starts writing the value in a later PR.
ALTER TABLE "order" DROP CONSTRAINT order_payment_status_check;
ALTER TABLE "order" ADD CONSTRAINT order_payment_status_check
  CHECK (payment_status IN ('awaiting','authorized','captured','partially_refunded','refunded','failed','voided'));
