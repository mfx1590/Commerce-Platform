-- 0002 organization level: organization, legal_entity, warehouse, staff_user, role_assignment, audit_log, customer_identity
CREATE TABLE organization (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL,
  default_currency char(3) NOT NULL DEFAULT 'EUR',
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_entity (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  country         char(2) NOT NULL,
  currency        char(3) NOT NULL,
  vat_number      text,
  odoo_company_id integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE warehouse (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  address         jsonb NOT NULL DEFAULT '{}'::jsonb,
  country         char(2) NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  priority        integer NOT NULL DEFAULT 100,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE staff_user (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  keycloak_subject text NOT NULL UNIQUE,
  email            text NOT NULL,
  display_name     text NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE role_assignment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  staff_user_id   uuid NOT NULL REFERENCES staff_user(id) ON DELETE CASCADE,
  relation        text NOT NULL CHECK (relation IN ('owner','finance','operations','store_admin','store_staff','support','analyst')),
  object_type     text NOT NULL CHECK (object_type IN ('organization', 'store')),
  object_id       uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_user_id, relation, object_type, object_id)
);
CREATE INDEX role_assignment_object_idx ON role_assignment (organization_id, object_type, object_id);

CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid,                       -- FK added in 0003 after store exists
  actor_id        uuid,
  actor_type      text NOT NULL CHECK (actor_type IN ('staff', 'customer', 'system')),
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  before          jsonb,
  after           jsonb,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (organization_id, entity_type, entity_id, created_at DESC);
CREATE INDEX audit_log_store_idx ON audit_log (store_id, created_at DESC);

CREATE TABLE customer_identity (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  email_hash       text NOT NULL,
  keycloak_subject text,
  merged_into_id   uuid REFERENCES customer_identity(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email_hash)
);
