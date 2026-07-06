-- =============================================================================
-- Hash chains (migration 011 pattern, re-keyed per aggregate).
-- score_events chains PER FIXTURE, division_events PER DIVISION. The append is
-- already serialised per aggregate by the adapter's advisory lock (doc 07 note
-- 2), and `seq` is gapless within the aggregate, so the chain simply links rows
-- in seq order — no separate chain_seq / advisory lock in the trigger.
-- =============================================================================
create or replace function v2_row_hash(prev text, canonical text) returns text
  language sql immutable as $$
    select encode(sha256(convert_to(coalesce(prev, '') || '|' || canonical, 'utf8')), 'hex')
  $$;

-- score_events chain (before insert; fires after trg_set_org — 'z' sorts last).
create or replace function score_events_hash_chain() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare prev text; canonical text;
begin
  select row_hash into prev from score_events
    where fixture_id = new.fixture_id order by seq desc limit 1;
  canonical := concat_ws('|',
    new.id::text, new.fixture_id::text, new.seq::text, new.type,
    new.payload::text, coalesce(new.voids_event_id::text, ''),
    coalesce(new.recorded_by::text, ''), new.recorded_at::text);
  new.prev_hash := prev;
  new.row_hash  := v2_row_hash(prev, canonical);
  return new;
end $$;

drop trigger if exists trg_zhash on score_events;
create trigger trg_zhash before insert on score_events
  for each row execute function score_events_hash_chain();

-- division_events chain
create or replace function division_events_hash_chain() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare prev text; canonical text;
begin
  select row_hash into prev from division_events
    where division_id = new.division_id order by seq desc limit 1;
  canonical := concat_ws('|',
    new.id::text, new.division_id::text, new.seq::text, new.type,
    new.payload::text, coalesce(new.actor_id::text, ''), new.created_at::text);
  new.prev_hash := prev;
  new.row_hash  := v2_row_hash(prev, canonical);
  return new;
end $$;

drop trigger if exists trg_zhash on division_events;
create trigger trg_zhash before insert on division_events
  for each row execute function division_events_hash_chain();

-- Verifiers: return the id of the first row (in seq order) whose recomputed
-- hash or prev-link doesn't match; null = chain intact.
create or replace function verify_score_events_chain(p_fixture uuid) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r score_events%rowtype; expect_prev text := null; canonical text;
begin
  for r in select * from score_events where fixture_id = p_fixture order by seq loop
    if r.prev_hash is distinct from expect_prev then return r.id; end if;
    canonical := concat_ws('|',
      r.id::text, r.fixture_id::text, r.seq::text, r.type,
      r.payload::text, coalesce(r.voids_event_id::text, ''),
      coalesce(r.recorded_by::text, ''), r.recorded_at::text);
    if r.row_hash is distinct from v2_row_hash(r.prev_hash, canonical) then return r.id; end if;
    expect_prev := r.row_hash;
  end loop;
  return null;
end $$;

create or replace function verify_division_events_chain(p_division uuid) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r division_events%rowtype; expect_prev text := null; canonical text;
begin
  for r in select * from division_events where division_id = p_division order by seq loop
    if r.prev_hash is distinct from expect_prev then return r.id; end if;
    canonical := concat_ws('|',
      r.id::text, r.division_id::text, r.seq::text, r.type,
      r.payload::text, coalesce(r.actor_id::text, ''), r.created_at::text);
    if r.row_hash is distinct from v2_row_hash(r.prev_hash, canonical) then return r.id; end if;
    expect_prev := r.row_hash;
  end loop;
  return null;
end $$;
