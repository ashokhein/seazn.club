-- Org-level scheduling timezone — the VENUE lane, inherited by divisions.
--
-- Timezone belongs to the venue, not the person: a London-based organiser can
-- run an event in Malaga, so this must NOT come from users.timezone (that is
-- the personal display lane from the 2026-07-14 two-lane design and stays
-- untouched here).
--
-- Resolution order after this migration:
--   schedule_settings.tz  ->  organizations.timezone  ->  'UTC'
--
-- No CHECK against pg_timezone_names, for the same reason as V280: that couples
-- validity to the server's tzdata build and rejects zones the app's Intl
-- runtime accepts. IANA validity is enforced app-side (lib/tz isValidIana).
alter table organizations
  add column if not exists timezone text;

alter table organizations
  drop constraint if exists organizations_timezone_nonblank;
alter table organizations
  add constraint organizations_timezone_nonblank
  check (timezone is null or btrim(timezone) <> '');

-- schedule_settings.tz becomes NULLABLE: null is now the only way to say
-- "inherit from the org". Existing rows keep their explicit value and keep
-- winning — this is additive, nothing loses its current timezone.
alter table schedule_settings
  alter column tz drop not null;
alter table schedule_settings
  alter column tz drop default;

alter table schedule_settings
  drop constraint if exists schedule_settings_tz_nonblank;
alter table schedule_settings
  add constraint schedule_settings_tz_nonblank
  check (tz is null or btrim(tz) <> '');

-- Backfill: per org, the most common tz its divisions actually chose.
--
-- 'UTC' is excluded from the vote deliberately. It was the column DEFAULT, so
-- nearly every division carries it whether or not anyone picked it; counting it
-- would hand almost every org 'UTC' and make inheritance a no-op. Excluding it
-- is loss-free because 'UTC' is also the final fallback: an org that genuinely
-- runs in UTC resolves to 'UTC' either way. Ties break alphabetically so the
-- backfill is deterministic. Orgs with no non-UTC division stay null.
with votes as (
  select d.org_id,
         ss.tz,
         row_number() over (
           partition by d.org_id
           order by count(*) desc, ss.tz
         ) as rk
    from schedule_settings ss
    join divisions d on d.id = ss.division_id
   where ss.tz is not null
     and btrim(ss.tz) <> ''
     and ss.tz <> 'UTC'
   group by d.org_id, ss.tz
)
update organizations o
   set timezone = votes.tz
  from votes
 where votes.org_id = o.id
   and votes.rk = 1
   and o.timezone is null;
