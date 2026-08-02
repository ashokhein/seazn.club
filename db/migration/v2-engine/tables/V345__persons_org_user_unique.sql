-- =============================================================================
-- V345 — one person per (organisation, claimed user)
-- =============================================================================
-- Gap 8 of the verified-schedule programme (#395/#396): the same human ends up
-- with two person_ids, so `entrant_members` shows two distinct people and every
-- cross-entrant person rule goes quiet on exactly the fixtures that need it.
--
-- `persons.user_id` (V204, nullable, `on delete set null`) is the ONE key
-- deterministic enough to enforce in the database. It is filled by the V276
-- claim flow; the public registration path is anonymous and has no user to
-- link (deferred: #402). Name, dob and contact_email are NOT enforceable here —
-- a guardian registering two children shares one email address, and merging
-- siblings is worse than the bug. Over-constrain the schedule, never the
-- database.
--
-- Partial: unclaimed persons (user_id null) are unconstrained and stay many,
-- which also keeps the index small — it covers only claimed rows. Cross-org is
-- still allowed: one human may hold a person row in every organisation they
-- play in, so the key is (org_id, user_id), org_id first (the leading column
-- every persons lookup already filters on).
--
-- Prod note: on a populated database create this CONCURRENTLY out of band
-- first; Flyway runs statements in a transaction, where CONCURRENTLY is
-- illegal. `if not exists` then makes this migration a no-op.
-- Pre-deploy check (must return zero rows):
--   select org_id, user_id, count(*) from persons
--    where user_id is not null group by 1, 2 having count(*) > 1;
create unique index if not exists persons_org_user_uq
  on persons (org_id, user_id)
  where user_id is not null;
