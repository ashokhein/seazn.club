-- v5 i18n cycle 47 (spec 2026-07-15 console-batch1 §Deliverable B): per-registrant
-- email locale. Registrant-facing mail (confirmation, payment reminder, promotion,
-- refund, dispute) sends in the language the registrant filled the form in — their
-- explicit switcher pick, else the organiser's public default. Captured at signup
-- and frozen on the row; senders read it instead of defaulting to English.
-- Cycle-1 locale set en/fr/es/nl (hi/ta deferred) — widen the CHECK with them.
-- Nullable: pre-migration rows stay null and fall back to English at send time.
alter table registrations
  add column if not exists locale text;

alter table registrations
  drop constraint if exists registrations_locale_valid;
alter table registrations
  add constraint registrations_locale_valid
  check (locale is null or locale in ('en', 'fr', 'es', 'nl'));
