-- 0160 shipment.status gains picking and packed (CONTRACT CHANGE #225, window 8 task 2.5; events 0.3.0,
-- Admin API 0.4.3). The one db statement: widen the CHECK that 0006 declared inline on the column
-- (auto-named shipment_status_check). No new column: the pick/pack lifecycle is shipment.status itself, so a
-- shipment has exactly one state, and `shipment.metadata.fulfillment` keeps only the 3PL reference.
ALTER TABLE shipment DROP CONSTRAINT shipment_status_check;
ALTER TABLE shipment ADD CONSTRAINT shipment_status_check
  CHECK (status IN ('pending','picking','packed','label_created','shipped','in_transit','delivered','failed','cancelled'));
