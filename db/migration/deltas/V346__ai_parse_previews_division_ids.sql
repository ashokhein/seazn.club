-- V346 — W5 (#400) Task 2b/H1: a preview's identity includes WHICH divisions it
-- was compiled for.
--
-- V345 keyed a preview on (org_id, scope, scope_id, instruction_hash). For a
-- joint run `scope_id` is the COMPETITION, so the division set was neither
-- stored nor checked, and a preview taken for {A,B} would happily authorise a
-- run over {A,B,D}. That is not a technicality: `resolveParsed` extends an
-- infeasible window from the SUMMED movable-fixture count of the divisions in
-- scope, and the stage-1 prompt lists them by name so a scoped instruction can
-- resolve to a real id. Both answers are wrong for a set the compile never saw,
-- and the run would then place D's fixtures under a window resolved without
-- them — silently, behind a confirmation the organiser gave for two divisions.
--
-- Stored SORTED so the check is on the SET: reordering the multi-select must not
-- invalidate a confirmation, while adding or dropping a division must.
--
-- Written on the single-division path too (a one-element array holding the same
-- id as `scope_id`). Uniform beats conditional here: the run gate's predicate is
-- then one unconditional array equality on both paths, rather than an
-- `is not distinct from` that has to keep a NULL and an empty array meaning the
-- same thing.
--
-- NOT NULL with a default, so this is a catalogue-only change on PG11+ (no table
-- rewrite). Rows written before this migration keep '{}' and can therefore never
-- match a lookup again — correct, and costless: a preview lives 30 minutes.
alter table ai_parse_previews
  add column if not exists division_ids uuid[] not null default '{}'::uuid[];

comment on column ai_parse_previews.division_ids is
  'W5 #400: the sorted division ids this instruction was compiled against — the '
  'joint window resolves from their summed movable-fixture count, so a run over '
  'a different set may not execute on this confirmation.';
