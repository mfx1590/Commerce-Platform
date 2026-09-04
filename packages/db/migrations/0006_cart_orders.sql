-- 0006 cart, order, payment, refund, shipment, return. NOTE: "order" and "return" are reserved words — always quote them.
CREATE TABLE cart (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  sales_channel_id   uuid NOT NULL REFERENCES sales_channel(id),
  customer_id        uuid REFERENCES customer(id),
  email              text,
  currency           char(3) NOT NULL,
  locale             text NOT NULL,
  country            char(2) NOT NULL,
  shipping_address   jsonb,
  billing_address    jsonb,
  shipping_option_id uuid REFERENCES shipping_option(id),
  promotion_codes    text[] NOT NULL DEFAULT '{}',
  payment_session    jsonb,
  subtotal_minor     bigint NOT NULL DEFAULT 0,
  discount_minor     bigint NOT NULL DEFAULT 0,
  shipping_minor     bigint NOT NULL DEFAULT 0,
  tax_minor          bigint NOT NULL DEFAULT 0,
  total_minor        bigint NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  order_id           uuid,                    -- FK added below after "order" exists
  completed_at       timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cart_customer_idx ON cart (customer_id);
CREATE INDEX cart_store_status_idx ON cart (store_id, status, updated_at);

CREATE TABLE cart_line_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  store_id         uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  cart_id          uuid NOT NULL REFERENCES cart(id) ON DELETE CASCADE,
  variant_id       uuid NOT NULL REFERENCES product_variant(id),
  sku              text NOT NULL,
  title            text NOT NULL,
  variant_title    text NOT NULL,
  thumbnail_url    text,
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor   bigint NOT NULL DEFAULT 0,
  tax_rate_bp      integer NOT NULL DEFAULT 0,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, variant_id)
);

CREATE TABLE "order" (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id),
  display_id         bigint NOT NULL,
  sales_channel_id   uuid NOT NULL REFERENCES sales_channel(id),
  cart_id            uuid REFERENCES cart(id),
  customer_id        uuid REFERENCES customer(id),
  email              text NOT NULL,
  currency           char(3) NOT NULL,
  locale             text NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','processing','completed','cancelled')),
  payment_status     text NOT NULL DEFAULT 'awaiting' CHECK (payment_status IN ('awaiting','authorized','captured','partially_refunded','refunded','failed')),
  fulfillment_status text NOT NULL DEFAULT 'unfulfilled' CHECK (fulfillment_status IN ('unfulfilled','partially_fulfilled','fulfilled','partially_returned','returned')),
  shipping_address   jsonb NOT NULL,
  billing_address    jsonb NOT NULL,
  shipping_option_id uuid REFERENCES shipping_option(id),
  shipping_method    jsonb NOT NULL DEFAULT '{}'::jsonb,
  promotion_codes    text[] NOT NULL DEFAULT '{}',
  subtotal_minor     bigint NOT NULL,
  discount_minor     bigint NOT NULL DEFAULT 0,
  shipping_minor     bigint NOT NULL DEFAULT 0,
  tax_minor          bigint NOT NULL DEFAULT 0,
  total_minor        bigint NOT NULL,
  placed_at          timestamptz NOT NULL DEFAULT now(),
  cancelled_at       timestamptz,
  completed_at       timestamptz,
  cancel_reason      text,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, display_id)
);
CREATE INDEX order_store_placed_idx ON "order" (store_id, placed_at DESC);
CREATE INDEX order_customer_idx ON "order" (customer_id);
ALTER TABLE cart ADD CONSTRAINT cart_order_fk FOREIGN KEY (order_id) REFERENCES "order"(id);

-- Per-store human-readable order numbers: taken from store.next_order_number inside the insert transaction.
CREATE OR REPLACE FUNCTION app.assign_order_display_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.display_id IS NULL OR NEW.display_id = 0 THEN
    UPDATE store SET next_order_number = next_order_number + 1
      WHERE id = NEW.store_id
      RETURNING next_order_number - 1 INTO NEW.display_id;
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE "order" ALTER COLUMN display_id SET DEFAULT 0;
CREATE TRIGGER order_display_id BEFORE INSERT ON "order"
  FOR EACH ROW EXECUTE FUNCTION app.assign_order_display_id();

CREATE TABLE order_line_item (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id),
  order_id           uuid NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  variant_id         uuid REFERENCES product_variant(id) ON DELETE SET NULL,
  sku                text NOT NULL,
  title              text NOT NULL,
  variant_title      text NOT NULL,
  thumbnail_url      text,
  quantity           integer NOT NULL CHECK (quantity > 0),
  unit_price_minor   bigint NOT NULL,
  discount_minor     bigint NOT NULL DEFAULT 0,
  tax_rate_bp        integer NOT NULL DEFAULT 0,
  tax_minor          bigint NOT NULL DEFAULT 0,
  total_minor        bigint NOT NULL,
  fulfilled_quantity integer NOT NULL DEFAULT 0,
  returned_quantity  integer NOT NULL DEFAULT 0,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_line_item_order_idx ON order_line_item (order_id);

CREATE TABLE payment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organization(id),
  store_id            uuid NOT NULL REFERENCES store(id),
  order_id            uuid NOT NULL REFERENCES "order"(id),
  provider            text NOT NULL,
  provider_payment_id text,
  amount_minor        bigint NOT NULL CHECK (amount_minor >= 0),
  currency            char(3) NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','captured','failed','cancelled')),
  fee_minor           bigint,
  authorized_at       timestamptz,
  captured_at         timestamptz,
  failure_reason      text,
  idempotency_key     text NOT NULL UNIQUE,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX payment_order_idx ON payment (order_id);

CREATE TABLE "return" (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id),
  order_id        uuid NOT NULL REFERENCES "order"(id),
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','received','refunded','rejected')),
  reason          text,
  warehouse_id    uuid REFERENCES warehouse(id),
  refund_id       uuid,                      -- FK added below
  requested_at    timestamptz NOT NULL DEFAULT now(),
  received_at     timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX return_order_idx ON "return" (order_id);

CREATE TABLE refund (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id),
  order_id           uuid NOT NULL REFERENCES "order"(id),
  payment_id         uuid NOT NULL REFERENCES payment(id),
  return_id          uuid REFERENCES "return"(id),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  currency           char(3) NOT NULL,
  reason             text NOT NULL CHECK (reason IN ('return','cancellation','goodwill','chargeback')),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  provider_refund_id text,
  requested_by       uuid REFERENCES staff_user(id),
  idempotency_key    text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refund_order_idx ON refund (order_id);
ALTER TABLE "return" ADD CONSTRAINT return_refund_fk FOREIGN KEY (refund_id) REFERENCES refund(id);

CREATE TABLE return_item (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id),
  return_id          uuid NOT NULL REFERENCES "return"(id) ON DELETE CASCADE,
  order_line_item_id uuid NOT NULL REFERENCES order_line_item(id),
  quantity           integer NOT NULL CHECK (quantity > 0),
  condition          text CHECK (condition IN ('resellable','damaged')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id),
  order_id        uuid NOT NULL REFERENCES "order"(id),
  warehouse_id    uuid NOT NULL REFERENCES warehouse(id),
  carrier         text NOT NULL DEFAULT 'manual',
  service         text,
  tracking_number text,
  tracking_url    text,
  label_url       text,
  cost_minor      bigint,
  currency        char(3) NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','label_created','shipped','in_transit','delivered','failed','cancelled')),
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipment_order_idx ON shipment (order_id);

CREATE TABLE shipment_item (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id),
  shipment_id        uuid NOT NULL REFERENCES shipment(id) ON DELETE CASCADE,
  order_line_item_id uuid NOT NULL REFERENCES order_line_item(id),
  quantity           integer NOT NULL CHECK (quantity > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
