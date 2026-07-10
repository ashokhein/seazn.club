# 03 — Multi-Tenancy & Data Model (Greenfield Additions)

## 1. Goal

Make tenant isolation enterprise-trustworthy and add the **new** data shapes that
productization needs (subscriptions, entitlements, tenant lifecycle, leagues). This doc
covers **new** design only — not migrating existing tables.

## 2. Current state

- Hierarchy: `User → OrgMembership(role) → Organization → Season → Tournament → {Player, Round, Match}`.
- Isolation enforced **in application code** (`requireOrgRole`, `requireTournamentEditor`).
- Cross-cutting: `match_events` (undo snapshots), `audit_log`.
- No subscription/plan/limit tables; no RLS; no tenant lifecycle state.

## 3. Tenant model

The **Organization is the tenant boundary.** An account (User) may belong to multiple orgs;
billing and entitlements attach to the **org**, not the user.

```
Account (User)
  └── OrgMembership (role, status)
        └── Organization  ← TENANT, owns subscription + entitlements + data residency
              ├── Subscription (1:1, → plan)
              ├── Season / League
              │     └── Tournament → Player / Round / Match
              ├── Branding (logo, colors, custom domain)
              └── Audit / usage counters
```

## 4. Defense-in-depth isolation: Postgres RLS

App-layer checks stay, but we add **RLS** so a query bug can't leak across tenants.

### 4.1 Request-scoped tenant variable

Because we use the `postgres` package directly, set a transaction-local GUC inside every
tenant-scoped transaction:

```sql
-- at the start of a tenant-scoped transaction
SET LOCAL app.current_org = '<org_uuid>';
SET LOCAL app.user_id     = '<user_uuid>';
SET LOCAL app.role        = '<owner|admin|viewer|system>';
```

`src/lib/tenant.ts` provides a wrapper:

```
withTenant(orgId, userId, role, async (sql) => { ... })
  → sql.begin(async tx => {
       await tx`select set_config('app.current_org', ${orgId}, true)`;
       await tx`select set_config('app.user_id', ${userId}, true)`;
       await tx`select set_config('app.role', ${role}, true)`;
       return fn(tx);
     })
```

### 4.2 Policy pattern (per tenant-scoped table)

```sql
ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tournaments
  USING (org_id = current_setting('app.current_org', true)::uuid);

-- writes additionally require an editor role (belt-and-braces with app RBAC)
CREATE POLICY tenant_write ON tournaments
  FOR ALL
  USING (org_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org', true)::uuid);
```

- A dedicated **migration/admin role** bypasses RLS for ops tasks.
- Child tables (`players`, `rounds`, `matches`, `match_events`) either carry `org_id`
  (denormalized for direct policies) or are guarded via the tournament FK. **Recommendation:
  denormalize `org_id`** onto hot child tables so policies are simple and index-friendly.

### 4.3 Why both app checks and RLS
- App checks give friendly errors and run before queries.
- RLS guarantees the database refuses cross-tenant rows even if app logic regresses.

## 5. New tables (greenfield DDL)

> These are *designs* to implement when the owning feature is scheduled (billing in doc 05).
> Types in `src/lib/types.ts` first, then DDL.

### 5.1 Plans & subscriptions

```sql
CREATE TABLE plans (
  key             text PRIMARY KEY,           -- 'community' | 'pro' | 'business' | 'enterprise'
  name            text NOT NULL,
  stripe_price_id text,                        -- null for community/enterprise-custom
  is_public       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  org_id              uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_key            text NOT NULL REFERENCES plans(key),
  status              text NOT NULL,           -- trialing|active|past_due|canceled|suspended
  stripe_customer_id  text,
  stripe_subscription_id text,
  current_period_end  timestamptz,
  trial_end           timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

### 5.2 Entitlements & limits

Two layers: **plan defaults** (from doc 01 matrix) + **per-org overrides** (for enterprise
deals / grandfathering).

```sql
CREATE TABLE plan_entitlements (
  plan_key    text NOT NULL REFERENCES plans(key),
  feature_key text NOT NULL,                   -- 'realtime','exports','sso',...
  bool_value  boolean,                          -- for on/off features
  int_value   integer,                          -- for limits (null = unlimited)
  PRIMARY KEY (plan_key, feature_key)
);

CREATE TABLE org_entitlement_overrides (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  bool_value  boolean,
  int_value   integer,
  reason      text,                             -- audit: why overridden
  PRIMARY KEY (org_id, feature_key)
);
```

Resolution order at runtime: `org_entitlement_overrides` → `plan_entitlements` → deny.

### 5.3 Usage counters (for limit enforcement & metering)

```sql
CREATE TABLE usage_counters (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric      text NOT NULL,                    -- 'tournaments.active','players.total'
  value       integer NOT NULL DEFAULT 0,
  period_start date,                            -- null = lifetime/current snapshot
  PRIMARY KEY (org_id, metric, period_start)
);
```

### 5.4 Tenant lifecycle

```sql
ALTER TABLE organizations
  ADD COLUMN status        text NOT NULL DEFAULT 'active',  -- active|suspended|deleting
  ADD COLUMN residency     text NOT NULL DEFAULT 'us',      -- us|eu (Enterprise)
  ADD COLUMN deleted_at    timestamptz,
  ADD COLUMN purge_after   timestamptz;                     -- retention window
```

States: `active → suspended` (non-payment, read-only) `→ active` (recovered) or
`→ deleting` (requested) `→ purged` (worker hard-deletes after `purge_after`).

### 5.5 Leagues / seasons depth (Business+)

`seasons` exists. For leagues add cross-tournament aggregation:

```sql
CREATE TABLE leagues (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  sport_key  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tournaments ADD COLUMN league_id uuid REFERENCES leagues(id);
-- standings across a league = aggregate of member tournament results (computed/cached)
```

## 6. Entitlement enforcement contract

Single module `src/lib/entitlements.ts` (full design in doc 05):

```
hasFeature(orgId, 'realtime'): Promise<boolean>
withinLimit(orgId, 'tournaments.active', wouldBe): Promise<{ ok, limit, current }>
requireFeature(orgId, feature)  // throws 402-style error consumed by handler()
```

- Cached in Redis (`entitlements:{orgId}`), invalidated on subscription/override change.
- API routes call `requireFeature` / `withinLimit` after auth, before mutation.
- UI calls a read-only `/api/orgs/[id]/entitlements` to show/hide and explain upgrades.

## 7. Counter maintenance

- Increment/decrement `usage_counters` inside the same transaction as the action
  (create tournament → `tournaments.active +1`; complete/delete → `-1`).
- A nightly reconcile job recomputes counters from source tables to correct drift.

## 8. Data export & deletion (GDPR/CCPA)

- **Export:** worker assembles org/user data to JSON/CSV bundle in object storage; signed
  URL emailed; expires.
- **Delete:** set `deleting` + `purge_after`; worker cascades hard-delete after window;
  `audit_log` deletion event retained per policy.

## 9. Security & failure modes

- RLS policies must exist on **every** tenant table; add a test that fails CI if a table
  with `org_id` lacks a policy.
- `current_setting('app.current_org', true)` returns null outside a tenant tx → policies
  deny by default (no row leakage).
- Override table changes are audited (`reason` required).
- Counter underflow guarded (`GREATEST(value-1,0)`).

## 10. Acceptance criteria

- Tenant = org boundary documented; billing/entitlements attach to org.
- RLS pattern + `withTenant` wrapper specified; child-table `org_id` denormalization decided.
- Greenfield DDL for plans, subscriptions, entitlements, usage, lifecycle, leagues.
- Entitlement resolution order and enforcement contract defined.
- Export/delete flows specified.

## 11. Open questions / decisions

1. Denormalize `org_id` onto `players`/`rounds`/`matches` (recommended) vs FK-only policies?
2. Residency: logical (column + app routing) now, physical (separate DB per region) LATER?
3. Grandfathering: do we need per-org overrides at launch or only post first enterprise deal?
