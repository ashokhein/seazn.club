-- Invite-by-email (team settings): the recipient address an invite was
-- emailed to; null for shareable invite links.
alter table org_invites add column if not exists email text;
