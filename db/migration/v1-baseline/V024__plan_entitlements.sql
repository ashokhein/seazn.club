create table if not exists plan_entitlements (
  plan_key    text not null references plans(key),
  feature_key text not null,
  bool_value  boolean,
  int_value   integer,
  primary key (plan_key, feature_key)
);

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'branding',                   false, null),
  ('community', 'exports',                    false, null),
  ('community', 'realtime',                   false, null),
  ('pro', 'branding',                         true,  null),
  ('pro', 'exports',                          true,  null),
  ('pro', 'realtime',                         true,  null)
on conflict (plan_key, feature_key) do nothing;
