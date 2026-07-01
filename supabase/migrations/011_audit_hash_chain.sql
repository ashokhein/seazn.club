-- 011 — Tamper-evident audit trail (hash chain)
-- =============================================================================
-- Doc 04 §6. Each row in audit_log and staff_audit_log stores row_hash =
-- sha256(prev_hash || canonical row fields). prev_hash links to the previous
-- row's row_hash, so deleting or editing any row breaks every hash after it and
-- is detectable by re-walking the chain (verify_*_chain).
--
-- Chain order is a dedicated `chain_seq` assigned from a sequence *inside* the
-- trigger while holding a per-table transaction advisory lock. The lock is held
-- until commit, so a concurrent inserter blocks until the previous row is
-- committed and visible — giving a single, deterministic, linear chain
-- independent of clock ties. Trigger is SECURITY DEFINER so it reads the whole
-- table for the tip regardless of the caller's RLS. Idempotent.
-- =============================================================================

create extension if not exists pgcrypto;

alter table audit_log        add column if not exists prev_hash text;
alter table audit_log        add column if not exists row_hash  text;
alter table audit_log        add column if not exists chain_seq bigint;
alter table staff_audit_log  add column if not exists prev_hash text;
alter table staff_audit_log  add column if not exists row_hash  text;
alter table staff_audit_log  add column if not exists chain_seq bigint;

create sequence if not exists audit_log_chain_seq;
create sequence if not exists staff_audit_log_chain_seq;

create index if not exists audit_log_chain_idx       on audit_log(chain_seq);
create index if not exists staff_audit_log_chain_idx on staff_audit_log(chain_seq);

-- Canonical hash input for a row.
create or replace function audit_row_hash(prev text, canonical text) returns text
  language sql immutable as $$
    select encode(digest(coalesce(prev, '') || '|' || canonical, 'sha256'), 'hex')
  $$;

-- audit_log chain
create or replace function audit_log_hash_chain() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prev text;
  canonical text;
begin
  perform pg_advisory_xact_lock(hashtext('audit_log_chain'));
  new.chain_seq := nextval('audit_log_chain_seq');
  select row_hash into prev from audit_log order by chain_seq desc limit 1;
  canonical := concat_ws('|',
    new.id::text, coalesce(new.tournament_id::text, ''), coalesce(new.actor, ''),
    new.action, new.summary, coalesce(new.detail::text, ''), new.created_at::text);
  new.prev_hash := prev;
  new.row_hash  := audit_row_hash(prev, canonical);
  return new;
end $$;

-- staff_audit_log chain
create or replace function staff_audit_log_hash_chain() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prev text;
  canonical text;
begin
  perform pg_advisory_xact_lock(hashtext('staff_audit_log_chain'));
  new.chain_seq := nextval('staff_audit_log_chain_seq');
  select row_hash into prev from staff_audit_log order by chain_seq desc limit 1;
  canonical := concat_ws('|',
    new.id::text, new.actor_id::text, new.action, new.target_type, new.target_id,
    coalesce(new.detail::text, ''), new.created_at::text);
  new.prev_hash := prev;
  new.row_hash  := audit_row_hash(prev, canonical);
  return new;
end $$;

-- trg_zhash fires after trg_set_org (alphabetical) so org_id is set first.
drop trigger if exists trg_zhash on audit_log;
create trigger trg_zhash before insert on audit_log
  for each row execute function audit_log_hash_chain();

drop trigger if exists trg_zhash on staff_audit_log;
create trigger trg_zhash before insert on staff_audit_log
  for each row execute function staff_audit_log_hash_chain();

-- Verifiers: return the id of the first row (in chain order) whose recomputed
-- hash or prev-link doesn't match; null = chain intact.
create or replace function verify_audit_log_chain() returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r audit_log%rowtype;
  expect_prev text := null;
  canonical text;
begin
  for r in select * from audit_log order by chain_seq loop
    if r.prev_hash is distinct from expect_prev then return r.id; end if;
    canonical := concat_ws('|',
      r.id::text, coalesce(r.tournament_id::text, ''), coalesce(r.actor, ''),
      r.action, r.summary, coalesce(r.detail::text, ''), r.created_at::text);
    if r.row_hash is distinct from audit_row_hash(r.prev_hash, canonical) then
      return r.id;
    end if;
    expect_prev := r.row_hash;
  end loop;
  return null;
end $$;

create or replace function verify_staff_audit_log_chain() returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r staff_audit_log%rowtype;
  expect_prev text := null;
  canonical text;
begin
  for r in select * from staff_audit_log order by chain_seq loop
    if r.prev_hash is distinct from expect_prev then return r.id; end if;
    canonical := concat_ws('|',
      r.id::text, r.actor_id::text, r.action, r.target_type, r.target_id,
      coalesce(r.detail::text, ''), r.created_at::text);
    if r.row_hash is distinct from audit_row_hash(r.prev_hash, canonical) then
      return r.id;
    end if;
    expect_prev := r.row_hash;
  end loop;
  return null;
end $$;
