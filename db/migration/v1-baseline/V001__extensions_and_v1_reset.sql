-- =============================================================================
-- Seazn Club Tournament Platform — Supabase / PostgreSQL schema (v3)
-- =============================================================================
-- How to use:
--   1. Open your Supabase project -> SQL Editor -> New query.
--   2. Paste this whole file and run it.
--   3. Copy the connection string into .env.local as DATABASE_URL.
--
-- Re-running is safe: it drops and recreates the schema objects.
-- v3 adds multi-tenant organizations ("boards"), memberships with roles
-- (owner | admin | viewer), shareable invite links, email/password +
-- Google OAuth users, and scopes seasons + tournaments to an organization.
-- =============================================================================

create extension if not exists "pgcrypto";

drop table if exists audit_log cascade;
drop table if exists match_events cascade;
drop table if exists matches cascade;
drop table if exists rounds cascade;
drop table if exists players cascade;
drop table if exists tournaments cascade;
drop table if exists seasons cascade;
drop table if exists org_sport_presets cascade;
drop table if exists org_invites cascade;
drop table if exists org_members cascade;
drop table if exists organizations cascade;
drop table if exists email_change_requests cascade;
drop table if exists password_resets cascade;
drop table if exists email_verifications cascade;
drop table if exists users cascade;
drop table if exists groups cascade; -- legacy name from v1
