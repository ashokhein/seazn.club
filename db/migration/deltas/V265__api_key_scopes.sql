-- =============================================================================
-- Scoped API keys (v3/08 §2)
-- =============================================================================
-- Scopes become read | score | manage. Existing keys migrate write → manage
-- (no breakage — write was the full surface; the UI nudges owners to narrow).
-- Optional competition pin: a pinned key only works inside that competition.
alter table api_keys
  add column if not exists competition_id uuid references competitions(id) on delete cascade;

update api_keys
set scopes = (
  select coalesce(
    jsonb_agg(distinct case t.s when 'write' then 'manage' else t.s end),
    '["read"]'::jsonb
  )
  from jsonb_array_elements_text(scopes) as t(s)
)
where scopes @> '["write"]'::jsonb;

create index if not exists api_keys_competition_idx
  on api_keys (competition_id) where competition_id is not null;

-- The Business plan was scrubbed in v3 (PROMPT-32); api.write was its ladder
-- rung and would otherwise dead-end score/manage keys for every Pro org.
-- Keys stay Pro-gated by api.access; scope choice is the org's.
update plan_entitlements set bool_value = true
where plan_key = 'pro' and feature_key = 'api.write';
