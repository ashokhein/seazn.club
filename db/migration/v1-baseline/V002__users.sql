-- ---------------------------------------------------------------------------
-- Users.
--   password_hash : bcrypt hash; null for accounts created via Google OAuth.
--   email         : optional; used to link a Google login to an account.
--   google_sub    : Google's stable subject id (set when linked via OAuth).
-- ---------------------------------------------------------------------------
create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  password_hash  text,
  display_name   text not null,
  email_verified boolean not null default false,
  google_sub     text unique,
  avatar_url     text,
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  purge_after    timestamptz,
  is_staff       boolean not null default false,
  staff_role     text   -- 'support' | 'superadmin'
);
