create table if not exists plan_entitlements (
  plan_key    text not null references plans(key),
  feature_key text not null,
  bool_value  boolean,
  int_value   integer,
  primary key (plan_key, feature_key)
);

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'seasons.max',                null,  5),
  ('community', 'tournaments.per_season.max', null, 10),
  ('community', 'players.max',                null, 32),
  ('community', 'formats.all',                true,  null),
  ('community', 'branding',                   false, null),
  ('community', 'exports',                    false, null),
  ('community', 'realtime',                   false, null),
  ('pro', 'seasons.max',                      null, null),
  ('pro', 'tournaments.per_season.max',       null, null),
  ('pro', 'players.max',                      null, null),
  ('pro', 'formats.all',                      true,  null),
  ('pro', 'branding',                         true,  null),
  ('pro', 'exports',                          true,  null),
  ('pro', 'realtime',                         true,  null)
on conflict (plan_key, feature_key) do nothing;
