# Database migrations (Flyway)

All schema DDL lives here as Flyway versioned migrations — one table, function
or view per file (closely related SQL shares a file). Flyway applies pending
versions in order and records them in `flyway_schema_history`; applied files
are **immutable** (never edit one — add a new version).

## Layout

Flyway scans `db/migration/` recursively — folders are organization only;
**the `V###` filename prefix alone decides execution order**, so a version
number must stay unique across all folders.

| Folder | Range | Content |
|---|---|---|
| `v1-baseline/` | `V001`–`V028` | v1 baseline (was `supabase/schema.sql`): auth, orgs, v1 tournament tables, RLS, billing |
| `deltas/` | `V101`–`V118` | historical deltas (was `supabase/migrations/001–018`); `V113` is the v1→v2 cutover that drops the v1 tournament tables |
| `v2-engine/tables/` | `V202`–`V223` | engine v2 tables (was `schema_v2.sql`): catalog, people, competition→division→stage, ledgers, registration |
| `v2-engine/functions/` | `V201`, `V224`–`V229` | `current_org_id`, `set_org_from_parent`, hash chains, consent/entitlement helpers |
| `v2-engine/views/` | `V230`–`V238` | consent-filtered public read-model views |
| `v2-engine/rls-grants/` | `V225`, `V227`, `V239` | org_id triggers, RLS enable+policies, grants |
| `v2-engine/seeds/` | `V240` | entitlement seed rows |

New work continues from **V241** — put the file in whichever folder fits (or a
new one).

## Running

`scripts/flyway.sh` wraps the pinned Flyway CLI (auto-downloaded, no
Java/Docker prerequisite) and translates the app's `DATABASE_URL`
(`postgres://…`) into JDBC flags. `DATABASE_SSL=disable` for local Postgres.

```bash
npm run db:apply      # flyway migrate — applies pending versions only
npm run db:info       # migration history / pending
npm run db:validate   # checksum drift check
npm run db:baseline   # one-time on a pre-Flyway DB (marks V240 as applied)
```

Databases bootstrapped before the Flyway switch (e.g. the remote dev
Supabase) already contain everything through V240 — run `npm run db:baseline`
against them once, then `db:apply` works incrementally. Fresh databases just
run `db:apply` (then `npm run sync:sports`).

Conversion parity was verified by `pg_dump -s` diff: legacy
`scripts/apply-db.ts` output ≡ Flyway output (modulo `flyway_schema_history`).
