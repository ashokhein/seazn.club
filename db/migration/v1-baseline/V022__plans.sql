create table if not exists plans (
  key                     text primary key,
  name                    text not null,
  stripe_price_id_monthly text,
  stripe_price_id_annual  text,
  is_public               boolean not null default true,
  created_at              timestamptz not null default now()
);

insert into plans (key, name) values
  ('community', 'Community'),
  ('pro',       'Pro')
on conflict (key) do nothing;
