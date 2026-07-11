-- v3/07 §6 (PROMPT-36) — Start-a-competition funnel drafts. Pre-auth rows
-- (visitor has no user yet), so like login_links there is no org column and
-- no tenant policy; the claim endpoint consumes the single-use token, which
-- doubles as email-ownership proof. Drafts expire after 7 days; one reminder
-- goes out at +24h (reminded_at marks it sent).
create table funnel_drafts (
  id          uuid primary key default gen_random_uuid(),
  token       text not null unique,
  email       text not null,
  payload     jsonb not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  reminded_at timestamptz,
  created_at  timestamptz not null default now()
);

-- The +24h reminder sweep scans only never-reminded, unclaimed drafts.
create index funnel_drafts_reminder_idx
  on funnel_drafts(created_at)
  where used_at is null and reminded_at is null;

-- v3/07 §4 — remember which currency the org checked out in so renewals,
-- the billing page and future checkouts stay consistent. NULL = pre-v3 (usd).
alter table subscriptions add column if not exists currency text;
