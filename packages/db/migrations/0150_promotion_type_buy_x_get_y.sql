-- 0150 promotion.type gains buy_x_get_y (CONTRACT CHANGE #189, window 9 task 2.5; Admin API 0.4.1).
-- The one db statement of #189: widen the CHECK that 0004 declared inline on the column (auto-named
-- promotion_type_check). Everything else — stackable / exclusive and the buy-X-get-Y numbers — rides the
-- existing `rules` jsonb column (manager decision 2026-09-08: jsonb, no new columns).
ALTER TABLE promotion DROP CONSTRAINT promotion_type_check;
ALTER TABLE promotion ADD CONSTRAINT promotion_type_check
  CHECK (type IN ('percentage','fixed_amount','free_shipping','buy_x_get_y'));
