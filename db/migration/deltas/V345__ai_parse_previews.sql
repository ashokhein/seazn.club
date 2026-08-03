-- V345 — W5 (#400): a compiled instruction the organiser has been SHOWN but has
-- not yet paid for.
--
-- The AI schedule run compiles the organiser's sentence into typed constraints
-- (W3, #398) and then immediately spends a credit running the architect against
-- them. The organiser never sees what was compiled until after the money is
-- gone. W5 splits that: a parse-only preview request compiles and returns, and
-- the run happens on a second request the organiser makes deliberately.
--
-- That split needs somewhere to put the compile in between, because recompiling
-- at confirm time would run the architect under rules nobody agreed to — the
-- model is not deterministic, so the second compile of the same sentence is not
-- guaranteed to be the first one. A row here IS the agreement: Task 2's run gate
-- looks it up, checks it still describes the instruction being run, and reuses
-- the stored parse instead of paying for a second round.
--
-- Greenfield (no prior previews exist): no backfill is owed.
create table if not exists ai_parse_previews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  -- Which endpoint compiled it. A division preview and a competition preview
  -- resolve DIFFERENT windows from the same sentence (the joint resolver sees
  -- every selected division's fixture count), so a preview is only ever valid
  -- for the scope it was taken in.
  scope text not null check (scope in ('division', 'competition')),
  -- Polymorphic by `scope` — divisions(id) or competitions(id). Deliberately no
  -- foreign key: one column cannot reference two tables, and splitting it into
  -- two nullable FK columns would buy referential integrity at the price of a
  -- lookup key that is no longer a single equality. `on delete cascade` from
  -- org_id above already sweeps the rows that matter, and a preview outlives its
  -- scope for at most 30 minutes.
  scope_id uuid not null,
  -- sha256 hex of the NORMALISED instruction (trimmed, inner whitespace
  -- collapsed). The run gate compares this, so a reworded sentence can never
  -- execute under a confirmation the organiser gave for the previous one.
  instruction_hash text not null,
  instruction text not null,
  -- ResolvedParse: hard[], soft[], unparsed[], assumptions[], windowMs. Stored
  -- RESOLVED, not raw: the symbolic date refs were resolved against the org
  -- clock at preview time, and re-resolving them at confirm time could land on a
  -- different day if the org's clock crossed midnight in between.
  resolved jsonb not null,
  -- RawParsed exactly as the model emitted it. Kept beside `resolved` so a
  -- disputed compile can be re-derived and diffed against what we showed.
  raw jsonb,
  failed boolean not null default false,
  output_tokens integer not null default 0,
  served_model text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Single-use. Set by the run that consumed it, so a double-submit cannot run
  -- twice off one confirmation.
  consumed_at timestamptz
);

-- The run gate's lookup: the newest unconsumed, unexpired preview for this exact
-- instruction in this exact scope. Leading columns are all equalities, the sort
-- column trails — the composite-index rule.
create index if not exists ai_parse_previews_lookup_idx
  on ai_parse_previews (org_id, scope, scope_id, instruction_hash, created_at desc);

-- Sweep support. Partial so it indexes only the rows a sweep can act on: a
-- consumed preview is already spent and is never expired again.
create index if not exists ai_parse_previews_expiry_idx
  on ai_parse_previews (expires_at)
  where consumed_at is null;

-- Tenant isolation (doc 03 §9, scripts/check-rls.ts). org_id is written
-- explicitly by the insert — there is no single parent table to derive it from,
-- since scope_id is polymorphic — so no set_org_from_parent trigger.
alter table ai_parse_previews enable row level security;
alter table ai_parse_previews force  row level security;
drop policy if exists ai_parse_previews_tenant on ai_parse_previews;
create policy ai_parse_previews_tenant on ai_parse_previews for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on ai_parse_previews to app_user;

comment on table ai_parse_previews is
  'W5 #400: a stage-1 compiled instruction shown to an organiser before any '
  'credit is spent. The run reuses it (single-use, 30 minute life) so the '
  'compile the organiser confirmed is the compile that executes.';
