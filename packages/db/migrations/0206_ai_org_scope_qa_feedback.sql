-- Manager landing for #606 (P5.7 BI Q&A; CONTRACT CHANGE #668, REQUEST #669 to packages/ai), on
-- integration/phase5-606-contract.
-- 0206: organization-scope AI calls and the BI Q&A feedback.
--   1. ai_call_audit: `store_id` NULL = an organization-scope call (an HQ question over several stores, charged to
--      the organization's budget, #669 §2); the tool-use loop's per-step columns `conversation_id`, `step` (0-based;
--      both NULL or both set) and `tool_names` (the tool calls that step asked for, names only; '{}' = none);
--      purpose `analysis`; outcome `tool_loop_cap` (the run asked for more tool calls than `maxToolCalls`). Still
--      never the content.
--   2. ai_qa_feedback: a thumbs up/down per (conversation, asker); append-only, the newest row is the rating. No free
--      text column: a comment could carry personal data.
-- RLS for both: kind `store_nullable` (0190/0192's apply_rls): a store row is visible to a session that can access
-- the store (a store-scoped client for that store, or organization scope); a NULL-store row ONLY to an
-- organization-scope session (createOrganizationClient, opened after an organization-level permission check) of that
-- organization. The same predicate is the WITH CHECK, so only organization scope can insert a NULL-store row.

-- 1. ai_call_audit -------------------------------------------------------------------------------------------------
ALTER TABLE ai_call_audit ALTER COLUMN store_id DROP NOT NULL;

-- Existing rows get NULL / NULL / '{}' (a single-call row: no conversation, no step, no tool calls).
ALTER TABLE ai_call_audit
  ADD COLUMN conversation_id uuid,
  ADD COLUMN step            integer CHECK (step >= 0),
  ADD COLUMN tool_names      text[] NOT NULL DEFAULT '{}';
-- A step belongs to a conversation and a conversation row always has its step.
ALTER TABLE ai_call_audit ADD CONSTRAINT ai_call_audit_step_conversation_check
  CHECK ((conversation_id IS NULL) = (step IS NULL));

ALTER TABLE ai_call_audit DROP CONSTRAINT ai_call_audit_purpose_check;
ALTER TABLE ai_call_audit ADD CONSTRAINT ai_call_audit_purpose_check
  CHECK (purpose IN ('drafting', 'classification', 'analysis'));

ALTER TABLE ai_call_audit DROP CONSTRAINT ai_call_audit_outcome_check;
ALTER TABLE ai_call_audit ADD CONSTRAINT ai_call_audit_outcome_check
  CHECK (outcome IN (
    'ok', 'refused', 'max_tokens', 'error',
    'disabled', 'over_budget', 'rate_limited', 'denied_field', 'tool_loop_cap'));

CREATE INDEX ai_call_audit_org_conversation_idx ON ai_call_audit (organization_id, conversation_id)
  WHERE conversation_id IS NOT NULL;
-- Not unique: a retried step may audit again under the same (conversation, step).
CREATE INDEX ai_call_audit_conversation_step_idx ON ai_call_audit (conversation_id, step)
  WHERE conversation_id IS NOT NULL;

-- Replaces 0205's `store` policy (tenant_isolation) with `store_nullable`: identical for store rows
-- (app.can_access_store(store_id)), plus NULL-store rows for organization scope only.
SELECT app.apply_rls('ai_call_audit', 'store_nullable');
-- 0205's REVOKE UPDATE, DELETE stands (a policy change does not touch grants).

-- 2. ai_qa_feedback ------------------------------------------------------------------------------------------------
CREATE TABLE ai_qa_feedback (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  -- the store of a store question; NULL for an organization-scope (HQ) question, as its ai_call_audit rows
  store_id         uuid REFERENCES store(id),
  -- ai_call_audit.conversation_id of the answer rated (no foreign key: the audit has one row per step)
  conversation_id  uuid NOT NULL,
  -- staff_user.id of the asker; the core accepts feedback from the asker only
  actor_id         uuid NOT NULL,
  rating           text NOT NULL CHECK (rating IN ('up', 'down')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- The latest rating of (conversation, asker) wins: read with ORDER BY created_at DESC LIMIT 1.
CREATE INDEX ai_qa_feedback_latest_idx
  ON ai_qa_feedback (organization_id, conversation_id, actor_id, created_at DESC);

SELECT app.apply_rls('ai_qa_feedback', 'store_nullable');

-- Append-only for the application role (SELECT and INSERT from 0009's default privileges).
REVOKE UPDATE, DELETE ON ai_qa_feedback FROM platform_app;
