-- v5 i18n (spec 2026-07-14 v5-i18n-modernized §6): per-user + per-org locale.
-- Cycle-1 set is en/fr/es/nl; hi/ta are deferred (Noto fonts + native review),
-- so the CHECK omits them for now — widen it in the hi/ta cycle. Public league
-- pages read organizations.default_locale; users.locale is the signed-in pick.
alter table users
  add column if not exists locale text;

alter table users
  drop constraint if exists users_locale_valid;
alter table users
  add constraint users_locale_valid
  check (locale is null or locale in ('en', 'fr', 'es', 'nl'));

alter table organizations
  add column if not exists default_locale text not null default 'en';

alter table organizations
  drop constraint if exists organizations_default_locale_valid;
alter table organizations
  add constraint organizations_default_locale_valid
  check (default_locale in ('en', 'fr', 'es', 'nl'));
