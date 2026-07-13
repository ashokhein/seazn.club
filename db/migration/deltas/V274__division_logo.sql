-- V274: division identity for console cards (v8 spec 2026-07-13).
-- Uploaded logo renders on the division card tile; absent → monogram in the
-- division's accent hue. Mirrors organizations.logo_url/logo_storage_path.
alter table divisions
  add column logo_url text,
  add column logo_storage_path text;
