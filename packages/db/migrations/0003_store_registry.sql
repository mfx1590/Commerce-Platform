-- 0003 store registry: store, store_domain, store_locale, store_currency, sales_channel, store_api_key
CREATE TABLE store (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organization(id),
  legal_entity_id   uuid NOT NULL REFERENCES legal_entity(id),
  code              text NOT NULL,
  name              text NOT NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  default_currency  char(3) NOT NULL,
  default_locale    text NOT NULL,
  default_country   char(2) NOT NULL,
  timezone          text NOT NULL DEFAULT 'UTC',
  content_space_id  text,
  search_index      text,
  psp_account_id    text,
  theme             jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_order_number bigint NOT NULL DEFAULT 1000,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

ALTER TABLE audit_log ADD CONSTRAINT audit_log_store_fk FOREIGN KEY (store_id) REFERENCES store(id);

CREATE TABLE store_domain (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  hostname        text NOT NULL UNIQUE,
  is_primary      boolean NOT NULL DEFAULT false,
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX store_domain_one_primary ON store_domain (store_id) WHERE is_primary;

CREATE TABLE store_locale (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  locale          text NOT NULL,
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, locale)
);

CREATE TABLE store_currency (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  currency        char(3) NOT NULL,
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, currency)
);

CREATE TABLE sales_channel (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('web','app','marketplace','pos')),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, code)
);

CREATE TABLE store_api_key (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  store_id         uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  name             text NOT NULL,
  type             text NOT NULL CHECK (type IN ('publishable', 'secret')),
  key_prefix       text NOT NULL,
  key_hash         text NOT NULL UNIQUE,
  sales_channel_id uuid REFERENCES sales_channel(id),
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
