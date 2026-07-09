-- =============================================================================
-- Cookie / analytics consent audit (GDPR proof-of-consent)
-- =============================================================================
-- The banner opt-in is gated client-side (localStorage), but GDPR wants a
-- provable record of who consented, to what, and when. Each Accept/Reject
-- writes one append-only row here. user_id is null for logged-out visitors
-- (consent given before/without an account); it survives account deletion as a
-- null (on delete set null) so the audit trail isn't destroyed.
create table if not exists cookie_consents (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references users(id) on delete set null,
  choice         text not null check (choice in ('accepted', 'rejected')),
  policy_version text not null,
  user_agent     text,
  ip_address     inet,
  created_at     timestamptz not null default now()
);

create index if not exists cookie_consents_user_idx
  on cookie_consents (user_id, created_at desc);
