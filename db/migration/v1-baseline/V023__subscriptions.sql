create table if not exists subscriptions (
  org_id                  uuid primary key references organizations(id) on delete cascade,
  plan_key                text not null references plans(key) default 'community',
  status                  text not null default 'active',
  stripe_customer_id      text,
  stripe_subscription_id  text,
  current_period_end      timestamptz,
  trial_end               timestamptz,
  cancel_at_period_end    boolean not null default false,
  updated_at              timestamptz not null default now()
);

insert into subscriptions (org_id, plan_key, status)
  select id, 'community', 'active' from organizations
on conflict (org_id) do nothing;
