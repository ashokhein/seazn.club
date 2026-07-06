-- =============================================================================
-- Online registration (doc 16 §1.1, PROMPT-20a; delta shipped as migration
-- 018). registration_settings: per-division window/fee/capacity + bounded
-- custom form. registrations: public submissions that materialise into
-- entrants on confirm (entrant_id set exactly once — idempotent).
-- =============================================================================
create table if not exists registration_settings (
  division_id    uuid primary key references divisions(id) on delete cascade,
  org_id         uuid not null,
  enabled        boolean not null default false,
  entrant_kind   text not null default 'individual'
                 check (entrant_kind in ('team','individual','pair')),
  opens_at       timestamptz,
  closes_at      timestamptz,
  capacity       int check (capacity > 0),
  fee_cents      int not null default 0 check (fee_cents >= 0),
  currency       text not null default 'usd',
  refund_lock_at timestamptz,                  -- auto-refund before, discretion after
  form_fields    jsonb not null default '[]',  -- [{key,label,kind:text|select|checkbox,options?,required}]
  updated_at     timestamptz not null default now()
);

create table if not exists registrations (
  id                  uuid primary key default gen_random_uuid(),
  division_id         uuid not null references divisions(id) on delete cascade,
  org_id              uuid not null,
  status              text not null default 'pending'
                      check (status in ('pending','paid','confirmed','waitlisted','withdrawn')),
  display_name        text not null,
  contact_email       text not null,
  dob                 date,                    -- eligibility only; NEVER exposed publicly
  gender              text check (gender in ('m','f','x')),
  guardian_name       text,
  guardian_consent    boolean not null default false,
  answers             jsonb not null default '{}',
  amount_cents        int not null default 0,
  currency            text,
  checkout_session_id text,
  payment_intent_id   text,
  refunded_cents      int not null default 0,
  refunded_at         timestamptz,
  access_token_hash   text not null unique,    -- registrant self-service, shown once
  entrant_id          uuid references entrants(id) on delete set null,
  promoted_at         timestamptz,
  withdrawn_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists registrations_division_idx
  on registrations(division_id, status, created_at);
create index if not exists registrations_org_idx on registrations(org_id);
create index if not exists registrations_checkout_idx
  on registrations(checkout_session_id) where checkout_session_id is not null;
