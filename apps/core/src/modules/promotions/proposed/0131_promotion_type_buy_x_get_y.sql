-- PROPOSED (CONTRACT CHANGE #189, window 9, task 2.5): the one db statement — widen the promotion.type CHECK
-- so `buy_x_get_y` inserts. Kept here verbatim until the main window applies it; promotions.test.ts runs this
-- file on its throwaway database. Everything else of #189 rides the existing `rules` jsonb column.
ALTER TABLE promotion DROP CONSTRAINT promotion_type_check;
ALTER TABLE promotion ADD CONSTRAINT promotion_type_check
  CHECK (type IN ('percentage','fixed_amount','free_shipping','buy_x_get_y'));
