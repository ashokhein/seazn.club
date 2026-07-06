-- =============================================================================
-- Public read model (doc 06 §4.7, doc 07 note 4, doc 09). Views are owned by
-- the migration superuser, so they bypass RLS and can serve unauthenticated
-- public dashboard reads across all orgs — but they expose ONLY
-- visibility in ('public','unlisted') data (doc 09 §1: unlisted = link-only,
-- rendered with noindex; private = 404 — the views simply never return it),
-- and person data is consent-filtered: initials when name consent is absent,
-- no DOB ever, photos only when consented.
-- =============================================================================

-- Entitlement check usable inside the public views (doc 10 §2 rule 3: public
-- read features are enforced at the view layer, never client-side). Mirrors
-- lib/entitlements.ts resolution: org override → plan entitlement → deny.
create or replace function org_has_feature(p_org_id uuid, p_feature_key text)
  returns boolean language sql stable as $$
    select coalesce(
      (select bool_value from org_entitlement_overrides
        where org_id = p_org_id and feature_key = p_feature_key),
      (select pe.bool_value from plan_entitlements pe
        where pe.feature_key = p_feature_key
          and pe.plan_key = coalesce(
            (select s.plan_key from subscriptions s where s.org_id = p_org_id),
            'community')),
      false)
  $$;
