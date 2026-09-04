-- 0005 customers (store-scoped) linked to organization-level customer_identity
CREATE TABLE customer (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organization(id),
  store_id          uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  identity_id       uuid REFERENCES customer_identity(id),
  keycloak_subject  text,
  email             text NOT NULL,
  first_name        text,
  last_name         text,
  phone             text,
  customer_group_id uuid REFERENCES customer_group(id),
  status            text NOT NULL DEFAULT 'guest' CHECK (status IN ('guest','registered','disabled','erased')),
  consent           jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, email)
);
CREATE INDEX customer_identity_idx ON customer (identity_id);
CREATE UNIQUE INDEX customer_keycloak_per_store ON customer (store_id, keycloak_subject) WHERE keycloak_subject IS NOT NULL;

CREATE TABLE customer_address (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organization(id),
  store_id            uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  company             text,
  line1               text NOT NULL,
  line2               text,
  city                text NOT NULL,
  region              text,
  postal_code         text NOT NULL,
  country             char(2) NOT NULL,
  phone               text,
  is_default_shipping boolean NOT NULL DEFAULT false,
  is_default_billing  boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_address_customer_idx ON customer_address (customer_id);
