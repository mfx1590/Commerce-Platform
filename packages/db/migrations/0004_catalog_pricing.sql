-- 0004 catalog + pricing + store-level configuration
CREATE TABLE product_category (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES product_category(id),
  handle          text NOT NULL,
  name            text NOT NULL,
  description     text,
  position        integer NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, handle)
);

CREATE TABLE product (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  handle          text NOT NULL,
  title           text NOT NULL,
  subtitle        text,
  description     text,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  category_id     uuid REFERENCES product_category(id),
  brand_name      text,
  tags            text[] NOT NULL DEFAULT '{}',
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  seo             jsonb NOT NULL DEFAULT '{}'::jsonb,
  thumbnail_url   text,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, handle)
);
CREATE INDEX product_store_status_idx ON product (store_id, status);
CREATE INDEX product_category_idx ON product (category_id);

CREATE TABLE product_option (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  name            text NOT NULL,
  "values"        text[] NOT NULL DEFAULT '{}',
  position        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, name)
);

CREATE TABLE product_variant (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  store_id         uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  sku              text NOT NULL,
  barcode          text,
  title            text NOT NULL,
  options          jsonb NOT NULL DEFAULT '{}'::jsonb,
  manage_inventory boolean NOT NULL DEFAULT true,
  allow_backorder  boolean NOT NULL DEFAULT false,
  weight_g         integer,
  dimensions_mm    jsonb,
  hs_code          text,
  origin_country   char(2),
  position         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, sku)
);
CREATE INDEX product_variant_product_idx ON product_variant (product_id);

CREATE TABLE product_media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  variant_id      uuid REFERENCES product_variant(id) ON DELETE SET NULL,
  url             text NOT NULL,
  alt             text,
  position        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_media_product_idx ON product_media (product_id, position);

CREATE TABLE customer_group (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, code)
);

CREATE TABLE price_list (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organization(id),
  store_id          uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  code              text NOT NULL,
  name              text NOT NULL,
  type              text NOT NULL CHECK (type IN ('default','sale','override')),
  currency          char(3) NOT NULL,
  customer_group_id uuid REFERENCES customer_group(id),
  sales_channel_id  uuid REFERENCES sales_channel(id),
  starts_at         timestamptz,
  ends_at           timestamptz,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','draft','expired')),
  priority          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, code)
);
CREATE UNIQUE INDEX price_list_one_default_per_currency ON price_list (store_id, currency) WHERE type = 'default';

CREATE TABLE price (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  store_id         uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  price_list_id    uuid NOT NULL REFERENCES price_list(id) ON DELETE CASCADE,
  variant_id       uuid NOT NULL REFERENCES product_variant(id) ON DELETE CASCADE,
  currency         char(3) NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor >= 0),
  compare_at_minor bigint CHECK (compare_at_minor >= 0),
  min_quantity     integer NOT NULL DEFAULT 1 CHECK (min_quantity >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (price_list_id, variant_id, min_quantity)
);
CREATE INDEX price_variant_idx ON price (variant_id);

CREATE TABLE promotion (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  code               text,
  name               text NOT NULL,
  type               text NOT NULL CHECK (type IN ('percentage','fixed_amount','free_shipping')),
  value              integer NOT NULL DEFAULT 0,
  currency           char(3),
  rules              jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage_limit        integer,
  usage_count        integer NOT NULL DEFAULT 0,
  per_customer_limit integer,
  starts_at          timestamptz,
  ends_at            timestamptz,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('active','draft','disabled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'fixed_amount' OR currency IS NOT NULL)
);
CREATE UNIQUE INDEX promotion_code_per_store ON promotion (store_id, code) WHERE code IS NOT NULL;

CREATE TABLE tax_rate (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organization(id),
  store_id            uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  country             char(2) NOT NULL,
  region              text,
  name                text NOT NULL,
  rate_bp             integer NOT NULL CHECK (rate_bp >= 0),
  product_category_id uuid REFERENCES product_category(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tax_rate_lookup_idx ON tax_rate (store_id, country, region);

CREATE TABLE shipping_option (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  store_id         uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  code             text NOT NULL,
  name             text NOT NULL,
  carrier          text NOT NULL DEFAULT 'manual',
  service          text,
  price_minor      bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency         char(3) NOT NULL,
  countries        char(2)[] NOT NULL DEFAULT '{}',
  sales_channel_id uuid REFERENCES sales_channel(id),
  rules            jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, code)
);
