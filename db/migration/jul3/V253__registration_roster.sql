-- Team registrations can carry a squad roster entered (or imported) by the
-- registrant. Stored on the registration and materialised into persons +
-- entrant_members when the entry is confirmed.
alter table registrations
  add column if not exists roster jsonb not null default '[]'::jsonb;

comment on column registrations.roster is
  'Array of { name, dob?, squad_number? } — players supplied at team registration.';
