-- V303: save points gain a kind, so AI-created restore anchors stop consuming
-- the organiser's save-point quota (schedule.checkpoints.max: 1 free / 5 Pro /
-- unlimited Pro Plus).
--
-- Before this, the AI accept flow created a checkpoint labelled 'before-ai' and
-- then REUSED it forever, because a fresh one would 402 on the second AI apply.
-- Two consequences, both wrong:
--   1. Restore rolled back to the FIRST AI run, not the most recent one.
--   2. A community org that already held one ordinary save point could never
--      apply an AI schedule at all — the create 402'd, the apply aborted, and
--      with no DELETE endpoint there was no way to free the slot. The AI
--      generation had already been spent producing the plan.
--
-- An AI checkpoint is not a user save point; it is an undo anchor the feature
-- creates on the organiser's behalf. It should not be billed as one.
alter table division_checkpoints
  add column if not exists kind text not null default 'manual';

alter table division_checkpoints drop constraint if exists division_checkpoints_kind_check;
alter table division_checkpoints add constraint division_checkpoints_kind_check
  check (kind in ('manual', 'ai'));

-- The quota counts manual rows only, and the panel needs the newest AI anchor
-- per division to mark the older ones superseded.
create index if not exists division_checkpoints_kind_idx
  on division_checkpoints(division_id, kind, created_at desc);
