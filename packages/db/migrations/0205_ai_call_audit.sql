-- Landed from CONTRACT CHANGE #605 (window 14, D8), manager landing on integration/phase5-ai.
-- 0205 ai_call_audit (D8, #605): one row per packages/ai gateway call, NEVER the content (no prompt, no variables,
-- no output). input_sha256 is the hash of the REDACTED, rendered input, so it can confirm "same input" but never
-- a raw value. Written by packages/ai through the tenant client in store scope; append-only for the app role.
-- `outcome` covers the network outcomes (ok, refused = the model's refusal stop reason, max_tokens, error) and the
-- gateway's own refusals before any call (disabled = AI_ENABLED off, over_budget, rate_limited, denied_field), so an
-- over-budget store shows up in reporting instead of failing silently.
CREATE TABLE ai_call_audit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organization(id),
  store_id            uuid NOT NULL REFERENCES store(id),
  -- staff_user.id of the person who asked for the draft; NULL for a job
  actor_id            uuid,
  purpose             text NOT NULL CHECK (purpose IN ('drafting', 'classification')),
  -- versioned prompt template in packages/ai/templates, e.g. 'product-copy-draft' + 1
  template_id         text NOT NULL CHECK (template_id ~ '^[a-z][a-z0-9-]*$'),
  template_version    integer NOT NULL CHECK (template_version >= 1),
  input_sha256        char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  -- masked spans in the input (e-mail, phone, address, payment-like); counts only
  redactions          integer NOT NULL DEFAULT 0 CHECK (redactions >= 0),
  -- the model asked for, and the model that answered (they differ after a server-side refusal fallback)
  model               text NOT NULL,
  served_model        text,
  input_tokens        integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens   integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  -- integer micro-USD, rounded up (money is never a float); the price table lives in packages/ai
  cost_estimate_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_estimate_micro_usd >= 0),
  latency_ms          integer CHECK (latency_ms >= 0),
  outcome             text NOT NULL CHECK (outcome IN (
                        'ok', 'refused', 'max_tokens', 'error',
                        'disabled', 'over_budget', 'rate_limited', 'denied_field')),
  -- the error CLASS only (e.g. 'RateLimitError', 'APIConnectionError'), never a message
  error_class         text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_call_audit_store_created_idx ON ai_call_audit (store_id, created_at);
CREATE INDEX ai_call_audit_org_created_idx ON ai_call_audit (organization_id, created_at);

-- RLS (ADR 0001): every call is for one store; a store-scoped session sees its own store's rows, HQ (organization
-- scope with access) sees them all. No organization-scope rows: the gateway always runs for a store; HQ-level calls
-- would be a `store_nullable` change then, not now.
SELECT app.apply_rls('ai_call_audit', 'store');

-- Append-only for the application role: an audit row is never changed or deleted by the app. SELECT and INSERT come
-- from 0009's default privileges (0199's precedent); only the removal is spelled out.
REVOKE UPDATE, DELETE ON ai_call_audit FROM platform_app;
