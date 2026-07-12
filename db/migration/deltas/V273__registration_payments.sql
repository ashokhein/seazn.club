-- V273 — registration v3 dual payments (spec 2026-07-12).
-- Per-division payment method + instructions override, org default method,
-- payment lifecycle columns (pay window, offline mark-paid, disputes), the
-- 'expired' terminal status, and the admin-editable platform_settings table.

alter table registration_settings
  add column if not exists payment_method text not null default 'offline';
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conname = 'registration_settings_payment_method_check') then
    alter table registration_settings add constraint registration_settings_payment_method_check
      check (payment_method in ('offline','stripe'));
  end if;
end $$;
alter table registration_settings add column if not exists payment_instructions text;
-- Align the column default with the app default (code said gbp, schema said usd).
alter table registration_settings alter column currency set default 'gbp';

alter table organizations
  add column if not exists default_payment_method text not null default 'offline';
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conname = 'organizations_default_payment_method_check') then
    alter table organizations add constraint organizations_default_payment_method_check
      check (default_payment_method in ('offline','stripe'));
  end if;
end $$;

alter table registrations add column if not exists payment_method text;
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conname = 'registrations_payment_method_check') then
    alter table registrations add constraint registrations_payment_method_check
      check (payment_method in ('offline','stripe'));
  end if;
end $$;
alter table registrations add column if not exists expires_at timestamptz;
alter table registrations add column if not exists reminded_at timestamptz;
alter table registrations add column if not exists offline_marked_paid_at timestamptz;
alter table registrations add column if not exists offline_marked_paid_by uuid references users(id);
alter table registrations add column if not exists disputed_at timestamptz;
alter table registrations add column if not exists dispute_id text;

-- New terminal status: expired (unpaid card registration past its pay window).
alter table registrations drop constraint if exists registrations_status_check;
alter table registrations add constraint registrations_status_check
  check (status in ('pending','paid','confirmed','waitlisted','withdrawn','expired'));

-- Sweep index: only card pendings carry expires_at.
create index if not exists registrations_expiry_idx
  on registrations(expires_at) where status = 'pending' and expires_at is not null;

-- Platform-wide admin settings (superuser access only — no app_user grant, no RLS
-- needed: never exposed to tenant connections or the Data API).
create table if not exists platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id)
);
insert into platform_settings (key, value) values ('platform_fee_percent', '5'::jsonb)
on conflict (key) do nothing;
