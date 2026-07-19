-- V301: AI Schedule Architect (v4/03 §4) — fixtures placed by the AI accept
-- flow carry schedule_source='ai' so the ledger and analytics can tell AI
-- applies from auto/manual ones.
alter table fixtures drop constraint if exists fixtures_schedule_source_check;
alter table fixtures add constraint fixtures_schedule_source_check
  check (schedule_source in ('none', 'auto', 'manual', 'ai'));
