-- GDPR consent capture (spec 2026-07-14): clickwrap acceptance on accounts,
-- explicit processing consent on public registrations. Null = pre-policy row.
alter table users
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version     text;

alter table registrations
  add column if not exists privacy_consent_at      timestamptz,
  add column if not exists privacy_consent_version text;
