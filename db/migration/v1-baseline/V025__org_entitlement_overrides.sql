create table if not exists org_entitlement_overrides (
  org_id      uuid not null references organizations(id) on delete cascade,
  feature_key text not null,
  bool_value  boolean,
  int_value   integer,
  reason      text,
  primary key (org_id, feature_key)
);
