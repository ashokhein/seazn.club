-- ---------------------------------------------------------------------------
-- Enable RLS + FORCE on every tenant table.
-- FORCE means even the table owner is subject to policies when acting as
-- app_user (superuser sessions still bypass — that is intentional for migrations).
-- ---------------------------------------------------------------------------
alter table organizations      enable row level security;
alter table organizations      force row level security;
alter table org_members        enable row level security;
alter table org_members        force row level security;
alter table org_invites        enable row level security;
alter table org_invites        force row level security;
alter table org_sport_presets  enable row level security;
alter table org_sport_presets  force row level security;
alter table seasons            enable row level security;
alter table seasons            force row level security;
alter table tournaments        enable row level security;
alter table tournaments        force row level security;
alter table players            enable row level security;
alter table players            force row level security;
alter table rounds             enable row level security;
alter table rounds             force row level security;
alter table matches            enable row level security;
alter table matches            force row level security;
alter table match_events       enable row level security;
alter table match_events       force row level security;
alter table audit_log          enable row level security;
alter table audit_log          force row level security;
