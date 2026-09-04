-- 0007 inventory: inventory_level (projection), stock_movement (append-only ledger), reservation
CREATE TABLE inventory_level (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  variant_id      uuid NOT NULL REFERENCES product_variant(id) ON DELETE CASCADE,
  warehouse_id    uuid NOT NULL REFERENCES warehouse(id),
  on_hand         integer NOT NULL DEFAULT 0,
  reserved        integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  incoming        integer NOT NULL DEFAULT 0 CHECK (incoming >= 0),
  available       integer GENERATED ALWAYS AS (on_hand - reserved) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, warehouse_id)
);
CREATE INDEX inventory_level_warehouse_idx ON inventory_level (warehouse_id);

CREATE TABLE stock_movement (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id),
  variant_id      uuid NOT NULL REFERENCES product_variant(id),
  warehouse_id    uuid NOT NULL REFERENCES warehouse(id),
  delta           integer NOT NULL CHECK (delta <> 0),
  reason          text NOT NULL CHECK (reason IN ('receipt','sale','return','adjustment','transfer_in','transfer_out','cycle_count')),
  reference_type  text,
  reference_id    uuid,
  actor_id        uuid,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movement_variant_idx ON stock_movement (variant_id, warehouse_id, created_at DESC);
CREATE INDEX stock_movement_reference_idx ON stock_movement (reference_type, reference_id);

CREATE TABLE reservation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  variant_id      uuid NOT NULL REFERENCES product_variant(id),
  warehouse_id    uuid NOT NULL REFERENCES warehouse(id),
  order_id        uuid REFERENCES "order"(id),
  cart_id         uuid REFERENCES cart(id),
  quantity        integer NOT NULL CHECK (quantity > 0),
  expires_at      timestamptz,
  released_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (order_id IS NOT NULL OR cart_id IS NOT NULL)
);
CREATE INDEX reservation_variant_idx ON reservation (variant_id, warehouse_id) WHERE released_at IS NULL;
CREATE INDEX reservation_order_idx ON reservation (order_id);
