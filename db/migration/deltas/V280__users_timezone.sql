-- User timezone preference (spec 2026-07-14 user-timezone-design).
-- IANA zone name (e.g. 'Europe/London'); null = not set → resolveTimezone()
-- falls back to the seazn_tz cookie (browser-detected), then 'UTC'.
--
-- No CHECK against pg_timezone_names: that couples validity to the server's
-- tzdata build and rejects zones the app's Intl runtime accepts. Full IANA
-- validity is enforced app-side (lib/tz isValidIana). Only guard blank strings.
alter table users
  add column if not exists timezone text;

alter table users
  drop constraint if exists users_timezone_nonblank;
alter table users
  add constraint users_timezone_nonblank
  check (timezone is null or btrim(timezone) <> '');
