-- =============================================================================
-- V294 — Org news, auto-drafted posts (SPEC-2 / PROMPT-82).
-- An org news feed: manual composer posts (free on every plan — the PLG ad
-- network working as designed) plus system-auto-drafted result/round_recap
-- posts on the decided-write seam (Pro `news.auto`). Server side only; the
-- console tab + public pages + OG cards land in PROMPT-83.
--
-- Drafted as V292 in the spec; renumbered to V294 at build — V291 is
-- payments-hardening (main), V292 discipline, V293 marks/reports (same lesson
-- as V286→V290). Table + RLS mirror V284/V292/V293 (explicit org_id, enable/
-- force RLS, tenant policy, app_user CRUD grants). Public reads go through the
-- superuser sql connection filtered status='published' + competition
-- visibility — the publicDivisionStats guard chain, no extra policy.
-- Idempotent entitlement seed at the tail.
-- =============================================================================

create table org_posts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  competition_id  uuid references competitions(id) on delete set null,
  division_id     uuid references divisions(id) on delete set null,
  author_user_id  uuid,             -- console user; null for auto-drafts
  kind            text not null default 'news'
                    check (kind in ('news','result','round_recap','announcement')),
  status          text not null default 'draft'
                    check (status in ('draft','published','archived')),
  slug            text not null,    -- unique per org, from title (slugify util)
  title           text not null,
  body_md         text not null default '',
  hero_image_path text,             -- supabase public storage (logo upload rail)
  -- {"trigger":"fixture_decided","fixture_id":...,"division_id":...,
  --  "round_no":N,"stale":false} — null for human posts.
  auto_source     jsonb,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, slug)
);
create index org_posts_public_idx on org_posts(org_id, status, published_at desc);

-- Auto-draft idempotency (SPEC-2): at most one auto post per trigger per
-- fixture (result) or per round+division (round_recap). Enforced by a partial
-- unique index — the insert is on-conflict-do-nothing, never an app pre-check
-- (same discipline lesson as suspensions_auto_once). Human posts (auto_source
-- null) are exempt.
create unique index org_posts_auto_once on org_posts (
  org_id,
  (auto_source->>'trigger'),
  coalesce(auto_source->>'fixture_id', ''),
  coalesce(auto_source->>'division_id', ''),
  coalesce(auto_source->>'round_no', '')
) where auto_source is not null;

-- Division-level opt-in: draft a news post when results land in this division
-- (Console toggle in the Settings tab; gated by news.auto on write). Plain
-- column, not a rules table — presentation, not rules (SPEC-2).
alter table divisions add column auto_posts boolean not null default false;

-- RLS — org_posts is written on the tenant rail (organiser console), so the
-- app_user gets the full CRUD set. Public reads bypass via the superuser sql
-- connection (publicDivisionStats pattern), no extra policy.
alter table org_posts enable row level security;
alter table org_posts force  row level security;
create policy org_posts_tenant on org_posts for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on org_posts to app_user;

-- Entitlement news.auto (SPEC-2): auto-drafting is Pro; MANUAL posts stay free
-- on every plan (a missing row DENIES in lib/entitlements, so every plan gets a
-- row). Mirrors V292's discipline.enforced seed. Idempotent.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community',  'news.auto', false, null),
  ('event_pass', 'news.auto', false, null),
  ('pro',        'news.auto', true,  null),
  ('pro_plus',   'news.auto', true,  null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
