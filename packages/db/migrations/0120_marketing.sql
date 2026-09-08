-- 0120 marketing: campaign, segment, segment_member, product_feed, attribution, referral_program, referral, review.
-- Spec: docs/marketing-scope.md ("Entities"). Module owner: window 17 (marketing); `attribution` rows are written by
-- window 1 (core) at order placement from cart.metadata.attribution. Every table is store-level except `segment`,
-- which is organization-level with a nullable store_id (NULL = template reusable by every brand, visible only in
-- organization scope). Money is *_minor bigint + currency char(3); ids are uuid (docs/domain.md conventions).
--
-- Grants: 0009 declared ALTER DEFAULT PRIVILEGES for platform_app on tables and sequences created by the owner
-- role, which is the role that runs migrations, so the new tables are covered without explicit GRANTs. There are no
-- sequences here (uuid keys). The updated_at trigger loop in 0009 ran before these tables existed, so the triggers
-- are created explicitly below.

-- ---------------------------------------------------------------- segment (org-level, store_id NULL = template)
CREATE TABLE segment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organization(id),
  store_id             uuid REFERENCES store(id) ON DELETE CASCADE,   -- NULL = organization-level template
  template_id          uuid REFERENCES segment(id) ON DELETE SET NULL, -- the template a store segment was created from
  name                 text NOT NULL,
  description          text,
  rules                jsonb NOT NULL DEFAULT '{}'::jsonb,            -- {orders_count, last_order_at, total_spent_minor, tags, consent, country, ...}
  materialised_count   integer NOT NULL DEFAULT 0 CHECK (materialised_count >= 0),
  last_materialised_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (store_id IS NOT NULL OR template_id IS NULL)                 -- a template is never derived from a template
);
CREATE UNIQUE INDEX segment_name_per_store ON segment (store_id, name) WHERE store_id IS NOT NULL;
CREATE UNIQUE INDEX segment_template_name_per_org ON segment (organization_id, name) WHERE store_id IS NULL;
CREATE INDEX segment_store_idx ON segment (store_id, updated_at DESC);

CREATE TABLE segment_member (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  segment_id      uuid NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  materialised_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (segment_id, customer_id)
);
CREATE INDEX segment_member_store_customer_idx ON segment_member (store_id, customer_id);

-- ---------------------------------------------------------------- campaign
CREATE TABLE campaign (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('email','sms','paid_social','paid_search','affiliate','referral','landing')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','paused','ended')),
  starts_at       timestamptz,
  ends_at         timestamptz,
  budget_minor    bigint CHECK (budget_minor >= 0),
  currency        char(3),
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  promotion_id    uuid REFERENCES promotion(id) ON DELETE SET NULL,
  segment_id      uuid REFERENCES segment(id) ON DELETE SET NULL,
  landing_path    text,
  external_ref    text,                                                -- Klaviyo flow id, Meta campaign id, ...
  launched_at     timestamptz,
  ended_at        timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (budget_minor IS NULL OR currency IS NOT NULL),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX campaign_store_status_idx ON campaign (store_id, status, starts_at DESC);
CREATE INDEX campaign_store_utm_idx ON campaign (store_id, utm_campaign) WHERE utm_campaign IS NOT NULL;

-- ---------------------------------------------------------------- product_feed
CREATE TABLE product_feed (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organization(id),
  store_id          uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  name              text NOT NULL,
  channel           text NOT NULL CHECK (channel IN ('google_merchant','meta','tiktok','pinterest')),
  locale            text NOT NULL,
  currency          char(3) NOT NULL,
  filters           jsonb NOT NULL DEFAULT '{}'::jsonb,               -- {category_ids, tags, in_stock_only, ...}
  mapping           jsonb NOT NULL DEFAULT '{}'::jsonb,               -- channel attribute -> product field overrides
  url               text,                                             -- public feed URL once published
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','error')),
  last_published_at timestamptz,
  item_count        integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  errors            jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_feed_store_channel_idx ON product_feed (store_id, channel, status);

-- ---------------------------------------------------------------- attribution (written once at placement)
CREATE TABLE attribution (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id),
  order_id        uuid NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  cart_id         uuid REFERENCES cart(id) ON DELETE SET NULL,
  touch           text NOT NULL CHECK (touch IN ('first','last')),
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_term        text,
  utm_content     text,
  referrer        text,                                                -- origin only (scheme + host), never the full URL
  landing_path    text,
  campaign_id     uuid REFERENCES campaign(id) ON DELETE SET NULL,
  captured_at     timestamptz NOT NULL,                                -- when the storefront captured the touch
  created_at      timestamptz NOT NULL DEFAULT now(),                  -- when the core recorded it (order placement)
  UNIQUE (order_id, touch)
);
CREATE INDEX attribution_store_campaign_idx ON attribution (store_id, campaign_id, created_at DESC);
CREATE INDEX attribution_store_source_idx ON attribution (store_id, touch, utm_source, utm_medium, utm_campaign);

-- ---------------------------------------------------------------- referral_program / referral
CREATE TABLE referral_program (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id              uuid NOT NULL REFERENCES organization(id),
  store_id                     uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  name                         text NOT NULL,
  status                       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','ended')),
  referrer_reward_promotion_id uuid REFERENCES promotion(id) ON DELETE SET NULL,
  referee_reward_promotion_id  uuid REFERENCES promotion(id) ON DELETE SET NULL,
  rules                        jsonb NOT NULL DEFAULT '{}'::jsonb,    -- {min_order_minor, reward_after, max_rewards_per_referrer, ...}
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_program_store_status_idx ON referral_program (store_id, status);

CREATE TABLE referral (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organization(id),
  store_id             uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  program_id           uuid NOT NULL REFERENCES referral_program(id) ON DELETE CASCADE,
  referrer_customer_id uuid NOT NULL REFERENCES customer(id),
  code                 text NOT NULL,
  referee_customer_id  uuid REFERENCES customer(id),
  order_id             uuid REFERENCES "order"(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'created' CHECK (status IN ('created','clicked','converted','rewarded')),
  clicked_at           timestamptz,
  converted_at         timestamptz,
  rewarded_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, code)
);
CREATE INDEX referral_store_program_status_idx ON referral (store_id, program_id, status);
CREATE INDEX referral_referrer_idx ON referral (referrer_customer_id);

-- ---------------------------------------------------------------- review
CREATE TABLE review (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  product_id         uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  order_line_item_id uuid REFERENCES order_line_item(id) ON DELETE SET NULL,
  customer_id        uuid REFERENCES customer(id),
  rating             integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title              text,
  body               text,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected')),
  moderated_by       uuid REFERENCES staff_user(id),
  moderated_at       timestamptz,
  moderation_reason  text,
  published_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX review_one_per_line_item ON review (order_line_item_id) WHERE order_line_item_id IS NOT NULL;
CREATE INDEX review_store_product_status_idx ON review (store_id, product_id, status);
CREATE INDEX review_store_status_created_idx ON review (store_id, status, created_at DESC);

-- ---------------------------------------------------------------- RLS (ADR 0001) + updated_at triggers
SELECT app.apply_rls(t, 'store') FROM unnest(ARRAY[
  'campaign','segment_member','product_feed','attribution','referral_program','referral','review'
]) AS t;
SELECT app.apply_rls('segment', 'store_nullable');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['segment','campaign','product_feed','referral_program','referral','review'] LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', t);
  END LOOP;
END $$;
