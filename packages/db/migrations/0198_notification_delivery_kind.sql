-- Landed from CONTRACT CHANGE #511 (window 17, #499), manager decision 2026-10-19: form (b).
-- 0198 notification_delivery.kind: the closed list gains `export_ready` (customer.export_ready v1, #499). 0180
-- declared the CHECK inline with the two kinds of that day; the database keeps refusing an unknown kind, so every
-- new email kind lands with its event's contract change. No data change; RLS untouched.
ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_kind_check;
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_kind_check
  CHECK (kind IN ('order_confirmation', 'shipment_shipped', 'export_ready'));
