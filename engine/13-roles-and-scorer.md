# 13 — Roles & the Scorer Role

Adds a fourth, scoring-only role to the org model, and pins the member/scorer quotas per
plan.

## 1. Naming

Role key: **`scorer`**. "Umpire" is cricket-specific; "referee" is football; "arbiter" is
chess. `scorer` is sport-neutral and describes exactly what the role can do — record
results. The **display label is sport-aware**, supplied by the sport module:

```ts
SportModule.officialLabel: { scorer: string }
// cricket: 'Umpire' · football: 'Referee' · chess: 'Arbiter' · volleyball: 'Referee'
// carrom: 'Umpire' · setbased default: 'Umpire' · generic: 'Scorer'
```

UI/invites/dashboards render the sport's label ("Invite an Umpire"); code, DB, API and
entitlement keys always say `scorer`.

## 2. Role matrix (v2)

`org_members.role`: `owner | admin | viewer | scorer` (extends existing enum).

| Capability | owner | admin | viewer | **scorer** |
|---|---|---|---|---|
| Org/billing/members | ✓ | partial | ✗ | ✗ |
| Create/edit competitions, divisions, entrants, schedules | ✓ | ✓ | ✗ | ✗ |
| View org dashboards | ✓ | ✓ | ✓ | assigned scope only |
| **Append score events** (winner/loser/draw, balls, rallies…) | ✓ | ✓ | ✗ | ✓ (assigned scope) |
| Void events (undo) | ✓ | ✓ | ✗ | ✓ own-fixture, pre-finalize |
| Finalize fixture | ✓ | ✓ | ✗ | config: `scorerCanFinalize` per division (default true) |
| Reopen finalized / edit schedule / lineups | ✓ | ✓ | ✗ | ✗ (lineups: config `scorerCanEnterLineups`, default true — courtside reality) |

## 3. Scoped assignment

A scorer sees and scores **only what they're assigned**:

```sql
create table scorer_assignments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  scope_type text not null check (scope_type in ('competition','division','fixture')),
  scope_id   uuid not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, user_id, scope_type, scope_id)
);
```

- Resolution: fixture is scorable if any assignment covers it (fixture ⊂ division ⊂
  competition). Typical use: assign per **division** ("you run the U16 court today");
  per-fixture for big events with many officials.
- Enforcement server-side in the use-case layer: `requireScorable(fixtureId)` — role
  `scorer` + covering assignment, or editor role. Never UI-only.
- Fixture console for scorers = a stripped "my matches" view: today's assigned fixtures,
  big scoring pad, nothing else. This is the killer courtside UX — a parent volunteer
  gets a link, taps winners, done.

## 4. Login / invite flow

- Standard org invite (`org_invites`) extended: `role: 'scorer'` + optional
  `default_scope {type, id}` — accepting the invite creates membership + assignment in
  one step. Share link or QR (existing invite mechanics).
- Scorers are full `users` (password/Google) — audit trail (`score_events.recorded_by`)
  stays real. No anonymous scoring.
- Post-login landing for scorer-only members: straight to "My matches", not the org
  dashboard.
- Day-of shortcut (later, flagged): pre-authorized device link — signed URL scoped to
  one fixture, expires end-of-day. Reserved, not v2.0.

## 5. Plan quotas (normative — supersedes doc 10 `seats.scorekeepers` row)

| feature_key | Community | Pro | Business |
|---|---|---|---|
| `orgs.max_owned` (orgs a user may own) | **1** | **5** | ∞ |
| `members.max` (owner+admin+viewer seats per org) | **3** | **10** | ∞ |
| `scorers.max` (scorer seats per org) | **1** | **1** | ∞ |

Notes:
- **Scorer seats do not consume member seats** — they're a separate, cheaper pool. The
  1-scorer cap on both tiers keeps the role as a taste of delegation; more officials =
  Business (or a per-seat add-on, pricing decision later).
- `members.max` counts active `org_members` rows with role ≠ scorer; enforcement at
  invite-accept and role-change (`withinLimit`), with the doc 10 §2.4 freeze rule on
  downgrade (over-quota members become read-only viewers, owner picks who stays active).
- **`orgs.max_owned` is a user-level quota** — the first user-scoped entitlement.
  Enforced at org creation against the creating user's best owned-org plan.
  ⚠ **Billing model decision required at implementation:** today each org has its own
  subscription. "Pro = 5 orgs" implies one Pro subscription entitles its owner to create
  up to 5 orgs. Options: (a) subscription stays per-org, `orgs.max_owned` just lifts the
  creation cap and each extra org needs its own plan; (b) one Pro subscription covers all
  ≤5 owned orgs (multi-org billing — Stripe quantity or flat). **(b) matches the stated
  intent; requires subscription→user pivot for that check. Confirm before PROMPT-18.**

## 6. Interactions with the rest of the design

- **API (doc 08):** scorer sessions hit the same `POST /fixtures/{id}/events`; scope
  check in `requireScorable`. API keys are org-level and unaffected. New:
  `GET /api/v1/me/assigned-fixtures?date=`.
- **Audit:** every event already carries `recorded_by`; scorer actions need no extra
  logging beyond the hash-chained ledger.
- **Realtime:** scorers get realtime on assigned fixtures regardless of org plan (they're
  producing the data; polling a match you're scoring is absurd).
- **Public dashboard:** unaffected — scorers are an input role, officials optionally
  displayed on fixtures from `fixtures.officials` (which can reference the assignment).
- **RLS:** scorer uses the same `withTenant` path; scope enforcement is app-layer
  (use-case), RLS still bounds to org.
